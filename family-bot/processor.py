"""
Процессор отзывов и вопросов — логика автоответов, обработка правил, планировщик.
Поддержка нескольких кабинетов WB.
"""
import re
import logging
import asyncio
from datetime import datetime

from config import load_settings
from database import (
    save_review, save_question, get_keyword_rules,
    update_review_reply, update_question_answer,
    mark_review_sent, mark_question_sent,
    log_activity, get_pending_reviews, get_pending_questions,
    get_review, get_question, get_cabinets, get_cabinet,
    mark_review_skipped,
)
from wb_api import get_wb_client
from ai_engine import ai_engine

logger = logging.getLogger(__name__)


class ReviewProcessor:
    def __init__(self):
        self.running = False
        self._task = None
        self._notify_callback = None

    def set_notify_callback(self, callback):
        self._notify_callback = callback

    async def notify(self, text: str):
        if self._notify_callback:
            await self._notify_callback(text)

    # === Получение и обработка ===

    async def fetch_and_process(self) -> dict:
        """Основной цикл: обработать все активные кабинеты"""
        cabinets = get_cabinets(active_only=True)
        total_stats = {"new_reviews": 0, "new_questions": 0, "auto_replied": 0, "errors": 0}

        for cabinet in cabinets:
            try:
                stats = await self._process_cabinet(cabinet)
                total_stats["new_reviews"] += stats["new_reviews"]
                total_stats["new_questions"] += stats["new_questions"]
                total_stats["auto_replied"] += stats["auto_replied"]
                total_stats["errors"] += stats["errors"]
            except Exception as e:
                logger.error(f"Error processing cabinet {cabinet['name']}: {e}")
                total_stats["errors"] += 1

        return total_stats

    async def _process_cabinet(self, cabinet: dict) -> dict:
        """Обработать один кабинет"""
        settings = load_settings()
        client = get_wb_client(cabinet["id"], cabinet["api_key"])
        cab_id = cabinet["id"]
        cab_name = cabinet["name"]
        stats = {"new_reviews": 0, "new_questions": 0, "auto_replied": 0, "errors": 0}

        # --- Отзывы ---
        try:
            feedbacks = await client.get_unanswered_feedbacks()
            for fb in feedbacks:
                is_new = save_review(fb, cabinet_id=cab_id)
                review_id = f"{cab_id}_{fb['id']}"
                if is_new:
                    stats["new_reviews"] += 1

                    if fb.get("text"):
                        sentiment = await ai_engine.analyze_sentiment(fb["text"])
                        from database import get_db
                        conn = get_db()
                        conn.execute("UPDATE reviews SET sentiment = ? WHERE id = ?", (sentiment, review_id))
                        conn.commit()
                        conn.close()

                    if settings.get("notify_new_reviews"):
                        stars = "⭐" * fb.get("rating", 0)
                        await self.notify(
                            f"📝 Новый отзыв!\n"
                            f"🏪 {cab_name}\n"
                            f"Товар: {fb.get('product_name', '?')}\n"
                            f"Оценка: {stars}\n"
                            f"Автор: {fb.get('user_name', '?')}\n"
                            f"Текст: {fb.get('text', '(без текста)')[:300]}\n"
                            f"ID: `{review_id}`"
                        )

                    if settings.get("auto_reply_enabled"):
                        fb["id"] = review_id  # use composite id
                        await self._try_auto_reply_review(fb, settings, cab_id, cab_name)
                        stats["auto_replied"] += 1

        except Exception as e:
            logger.error(f"Error processing feedbacks for [{cab_name}]: {e}")
            stats["errors"] += 1

        # --- Вопросы ---
        try:
            questions = await client.get_unanswered_questions()
            for q in questions:
                is_new = save_question(q, cabinet_id=cab_id)
                question_id = f"{cab_id}_{q['id']}"
                if is_new:
                    stats["new_questions"] += 1

                    if settings.get("notify_new_questions"):
                        await self.notify(
                            f"❓ Новый вопрос!\n"
                            f"🏪 {cab_name}\n"
                            f"Товар: {q.get('product_name', '?')}\n"
                            f"Вопрос: {q.get('question_text', '?')[:300]}\n"
                            f"ID: `{question_id}`"
                        )

                    if settings.get("auto_reply_questions") and settings.get("auto_reply_enabled"):
                        q["id"] = question_id
                        await self._try_auto_reply_question(q, settings, cab_id, cab_name)

        except Exception as e:
            logger.error(f"Error processing questions for [{cab_name}]: {e}")
            stats["errors"] += 1

        log_activity("fetch", f"Новых отзывов: {stats['new_reviews']}, вопросов: {stats['new_questions']}", cabinet_id=cab_id)

        return stats

    async def _try_auto_reply_review(self, review: dict, settings: dict, cab_id: int, cab_name: str):
        rating = review.get("rating", 0)

        if rating >= 4 and not settings.get("auto_reply_positive"):
            return
        if rating <= 3 and not settings.get("auto_reply_negative"):
            return

        rule_reply = self._match_keyword_rule(review, cab_id)
        if rule_reply:
            if rule_reply == "__skip__":
                mark_review_skipped(review["id"])
                return
            reply_text = rule_reply
            ai_flag = False
        else:
            reply_text = await ai_engine.generate_review_reply(review)
            ai_flag = True

        if not reply_text:
            return

        # Check stop words
        from database import flag_review_for_check, check_stop_words
        stop_word = check_stop_words(review.get("text", ""))
        if stop_word:
            flag_review_for_check(review["id"], f'Стоп-слово: "{stop_word}"')
            update_review_reply(review["id"], reply_text, status="pending", ai=ai_flag)
            await self.notify(
                f"🚫 Стоп-слово в отзыве!\n"
                f"Слово: {stop_word}\n\n"
                f"🏪 {cab_name}\n"
                f"Оценка: {'⭐' * rating}\n"
                f"Текст: {review.get('text', '')[:200]}"
            )
            return

        # Check for rating/sentiment mismatch
        mismatch = await ai_engine.check_rating_mismatch(review)
        if mismatch.get("mismatch"):
            flag_review_for_check(review["id"], mismatch["reason"])
            update_review_reply(review["id"], reply_text, status="pending", ai=ai_flag)
            await self.notify(
                f"⚠️ Отзыв отправлен на проверку!\n"
                f"Причина: {mismatch['reason']}\n\n"
                f"🏪 {cab_name}\n"
                f"Оценка: {'⭐' * rating}\n"
                f"Текст: {review.get('text', '')[:200]}\n\n"
                f"Ответ: {reply_text[:200]}"
            )
            return

        if settings.get("require_approval"):
            update_review_reply(review["id"], reply_text, status="pending", ai=ai_flag)
            await self.notify(
                f"🤖 Подготовлен ответ на отзыв:\n"
                f"🏪 {cab_name}\n\n"
                f"Отзыв ({review.get('rating', '?')}⭐): {review.get('text', '')[:200]}\n\n"
                f"Ответ: {reply_text}\n\n"
                f"Одобрить: /approve\\_{review['id']}\n"
                f"Отклонить: /skip\\_{review['id']}\n"
                f"Редактировать: /edit\\_{review['id']}"
            )
        else:
            # Отправляем через клиент нужного кабинета
            wb_id = review.get("wb_id", review["id"].split("_", 1)[-1])
            client = get_wb_client(cab_id, "")  # already cached
            success = await client.send_feedback_reply(wb_id, reply_text)
            if success:
                update_review_reply(review["id"], reply_text, status="sent", ai=ai_flag)
                mark_review_sent(review["id"])
                log_activity("auto_reply", f"Отзыв {review['id']}: {reply_text[:100]}", cabinet_id=cab_id)
            else:
                update_review_reply(review["id"], reply_text, status="failed", ai=ai_flag)

    async def _try_auto_reply_question(self, question: dict, settings: dict, cab_id: int, cab_name: str):
        reply_text = await ai_engine.generate_question_reply(question)
        if not reply_text:
            return

        if settings.get("require_approval"):
            update_question_answer(question["id"], reply_text, status="pending", ai=True)
            await self.notify(
                f"🤖 Подготовлен ответ на вопрос:\n"
                f"🏪 {cab_name}\n\n"
                f"Вопрос: {question.get('question_text', '')[:200]}\n\n"
                f"Ответ: {reply_text}\n\n"
                f"Одобрить: /approve\\_q\\_{question['id']}\n"
                f"Отклонить: /skip\\_q\\_{question['id']}\n"
                f"Редактировать: /edit\\_q\\_{question['id']}"
            )
        else:
            wb_id = question.get("wb_id", question["id"].split("_", 1)[-1])
            client = get_wb_client(cab_id, "")
            success = await client.send_question_reply(wb_id, reply_text)
            if success:
                update_question_answer(question["id"], reply_text, status="sent", ai=True)
                mark_question_sent(question["id"])
                log_activity("auto_answer", f"Вопрос {question['id']}: {reply_text[:100]}", cabinet_id=cab_id)

    def _match_keyword_rule(self, review: dict, cab_id: int) -> str | None:
        rules = get_keyword_rules(enabled_only=True, cabinet_id=cab_id)
        text = (review.get("text", "") or "").lower()
        rating = review.get("rating", 0)

        for rule in rules:
            rf = rule["rating_filter"]
            if rf != "any":
                if rf == "positive" and rating < 4:
                    continue
                if rf == "negative" and rating > 3:
                    continue
                if rf.isdigit() and rating != int(rf):
                    continue

            keyword = rule["keyword"].lower()
            match_type = rule["match_type"]

            matched = False
            if match_type == "contains":
                matched = keyword in text
            elif match_type == "exact":
                matched = keyword == text
            elif match_type == "regex":
                try:
                    matched = bool(re.search(keyword, text, re.IGNORECASE))
                except re.error:
                    pass

            if matched:
                action = rule["action"]
                if action == "skip":
                    return "__skip__"
                elif action == "template" and rule.get("response_template"):
                    return rule["response_template"].format(
                        name=review.get("user_name", "Покупатель"),
                        product=review.get("product_name", "товар"),
                        rating=rating,
                    )
                elif action == "notify":
                    asyncio.create_task(self.notify(
                        f"⚠️ Сработало правило '{rule['keyword']}' на отзыв:\n{text[:300]}"
                    ))
                    return None
                elif action == "ai":
                    return None

        return None

    # === Планировщик ===

    async def start_scheduler(self):
        if self.running:
            return
        self.running = True
        self._task = asyncio.create_task(self._scheduler_loop())
        log_activity("scheduler", "Планировщик запущен")
        logger.info("Scheduler started")

    async def stop_scheduler(self):
        self.running = False
        if self._task:
            self._task.cancel()
            self._task = None
        log_activity("scheduler", "Планировщик остановлен")
        logger.info("Scheduler stopped")

    async def _scheduler_loop(self):
        while self.running:
            try:
                stats = await self.fetch_and_process()
                logger.info(f"Fetch cycle: {stats}")
            except Exception as e:
                logger.error(f"Scheduler error: {e}")

            try:
                settings = load_settings()
                interval = settings.get("check_interval_minutes", 15) * 60
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break

    # === Ручные действия ===

    async def approve_and_send_review(self, review_id: str) -> bool:
        review = get_review(review_id)
        if not review or not review.get("reply_text"):
            return False

        cabinet = get_cabinet(review["cabinet_id"])
        if not cabinet:
            return False

        wb_id = review.get("wb_id", review_id.split("_", 1)[-1])
        client = get_wb_client(cabinet["id"], cabinet["api_key"])
        success = await client.send_feedback_reply(wb_id, review["reply_text"])
        if success:
            update_review_reply(review_id, review["reply_text"], status="sent", ai=bool(review.get("ai_generated")))
            mark_review_sent(review_id)
            log_activity("approve_send", f"Отзыв {review_id}", cabinet_id=cabinet["id"])
            return True
        return False

    async def approve_and_send_question(self, question_id: str) -> bool:
        q = get_question(question_id)
        if not q or not q.get("answer_text"):
            return False

        cabinet = get_cabinet(q["cabinet_id"])
        if not cabinet:
            return False

        wb_id = q.get("wb_id", question_id.split("_", 1)[-1])
        client = get_wb_client(cabinet["id"], cabinet["api_key"])
        success = await client.send_question_reply(wb_id, q["answer_text"])
        if success:
            update_question_answer(question_id, q["answer_text"], status="sent", ai=bool(q["ai_generated"]))
            mark_question_sent(question_id)
            log_activity("approve_send_q", f"Вопрос {question_id}", cabinet_id=cabinet["id"])
            return True
        return False


processor = ReviewProcessor()
