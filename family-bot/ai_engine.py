"""
AI-модуль — генерация ответов, анализ тональности, обучение на примерах
"""
import aiohttp
import random
import logging
from config import (
    AI_API_KEY, AI_API_BASE, AI_MODEL,
    load_settings, load_templates, load_training_examples
)

logger = logging.getLogger(__name__)


class AIEngine:
    def __init__(self):
        self.api_key = AI_API_KEY
        self.api_base = AI_API_BASE
        self.model = AI_MODEL
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def _chat(self, messages: list, temperature: float = 0.7, max_tokens: int = 600) -> str | None:
        url = f"{self.api_base}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        try:
            session = await self._get_session()
            async with session.post(url, headers=headers, json=payload) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data["choices"][0]["message"]["content"].strip()
                else:
                    text = await resp.text()
                    logger.error(f"AI API {resp.status}: {text[:500]}")
                    return None
        except Exception as e:
            logger.error(f"AI API error: {e}")
            return None

    def _build_system_prompt(self, settings: dict) -> str:
        tone_map = {
            "friendly": "Отвечай дружелюбно, тепло и с эмодзи. Используй обращение на 'вы'.",
            "formal": "Отвечай вежливо и формально. Без эмодзи, деловой стиль.",
            "casual": "Отвечай неформально, как общение с другом, но вежливо. Можно использовать эмодзи.",
        }
        ai_tone = settings.get("ai_tone", "friendly")
        if ai_tone == "custom":
            tone = settings.get("ai_custom_prompt", "") or tone_map["friendly"]
        else:
            tone = tone_map.get(ai_tone, tone_map["friendly"])

        examples_text = ""
        # 1. Manual training examples from file
        examples = load_training_examples()
        # 2. Auto-learn from sent reviews in DB
        try:
            from database import get_sent_review_examples
            db_examples = get_sent_review_examples(limit=20)
            examples = db_examples + examples  # DB examples first, manual override on top
        except Exception:
            pass

        if examples:
            examples_text = "\n\nПримеры хороших ответов (учись на них, копируй стиль и тон):\n"
            for ex in examples[-15:]:
                examples_text += f"\nОтзыв ({ex.get('rating', '?')}⭐): {ex.get('review_text', '')[:200]}\n"
                examples_text += f"Ответ: {ex.get('reply_text', '')[:300]}\n"

        knowledge_text = ""
        product_knowledge = settings.get("product_knowledge", {})
        if product_knowledge:
            knowledge_text = "\n\nИнформация о товарах:\n"
            for pid, info in product_knowledge.items():
                knowledge_text += f"- {info.get('name', pid)}: {info.get('description', '')[:200]}\n"

        max_chars = settings.get("ai_max_length", 500)

        return f"""Ты — менеджер по работе с клиентами на маркетплейсе Wildberries.
Твоя задача — отвечать на отзывы и вопросы покупателей.

Правила:
1. {tone}
2. Ответ должен быть не длиннее {max_chars} символов.
3. Не используй шаблонные фразы типа "Нам очень жаль это слышать".
4. Если отзыв негативный — предложи конкретное решение, а не отписку.
5. Если отзыв положительный — поблагодари и пригласи вернуться.
6. Упомяни название товара, если оно известно.
7. Не спорь с покупателем, даже если он неправ.
8. Отвечай только текст ответа, без кавычек и префиксов.
{examples_text}
{knowledge_text}"""

    async def generate_review_reply(self, review: dict) -> str | None:
        settings = load_settings()

        if not settings.get("ai_enabled"):
            return self._template_reply(review, settings)

        system_prompt = self._build_system_prompt(settings)

        rating = review.get("rating", 0)
        stars = "⭐" * rating if rating else "без оценки"
        user_msg = f"""Отзыв на товар "{review.get('product_name', 'товар')}":
Оценка: {stars}
Имя покупателя: {review.get('user_name', 'Покупатель')}
Текст отзыва: {review.get('text', '(без текста)')}

Напиши ответ на этот отзыв."""

        # max_tokens ~= max_chars / 2 (русский текст ~2 символа на токен)
        max_chars = settings.get("ai_max_length", 500)
        max_tokens = max(100, max_chars)

        return await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.7,
            max_tokens=max_tokens,
        )

    async def generate_question_reply(self, question: dict) -> str | None:
        settings = load_settings()

        if not settings.get("ai_enabled"):
            return None

        system_prompt = self._build_system_prompt(settings)
        user_msg = f"""Вопрос покупателя о товаре "{question.get('product_name', 'товар')}":
"{question.get('question_text', '')}"

Дай чёткий и полезный ответ."""

        max_chars = settings.get("ai_max_length", 500)
        max_tokens = max(100, max_chars)

        return await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.5,
            max_tokens=max_tokens,
        )

    async def check_rating_mismatch(self, review: dict) -> dict:
        """Check if rating contradicts the review text sentiment.
        Returns {"mismatch": bool, "reason": str}"""
        text = (review.get("text") or "").strip()
        rating = review.get("rating", 0)

        if not text or len(text) < 15:
            return {"mismatch": False, "reason": ""}

        result = await self._chat(
            [
                {"role": "system", "content": """Проанализируй отзыв и оценку покупателя. Определи, совпадает ли тон текста с поставленной оценкой.

Ответь строго в формате:
MATCH — если тон текста соответствует оценке
MISMATCH: причина — если есть расхождение

Примеры расхождений:
- Высокая оценка (4-5★), но текст содержит жалобы, недовольство, описание дефектов
- Низкая оценка (1-2★), но текст хвалит товар
- Текст неоднозначный, сложно определить реальное отношение покупателя"""},
                {"role": "user", "content": f"Оценка: {rating}★\nТекст отзыва: {text[:400]}"},
            ],
            temperature=0.1,
            max_tokens=100,
        )

        if result and "MISMATCH" in result.upper():
            reason = result.split(":", 1)[-1].strip() if ":" in result else "Тон текста не соответствует оценке"
            return {"mismatch": True, "reason": reason}

        return {"mismatch": False, "reason": ""}

    async def analyze_sentiment(self, text: str) -> str:
        if not text.strip():
            return "neutral"

        result = await self._chat(
            [
                {"role": "system", "content": "Определи тональность отзыва. Ответь одним словом: positive, negative, neutral или mixed."},
                {"role": "user", "content": text[:500]},
            ],
            temperature=0.1,
            max_tokens=10,
        )

        if result:
            result = result.lower().strip()
            if result in ("positive", "negative", "neutral", "mixed"):
                return result

        return "neutral"

    def _template_reply(self, review: dict, settings: dict) -> str | None:
        templates = load_templates()
        rating = review.get("rating", 0)

        if rating >= 5:
            key = "positive_5"
        elif rating >= 4:
            key = "positive_4"
        elif rating >= 3:
            key = "negative_3"
        elif rating >= 2:
            key = "negative_2"
        else:
            key = "negative_1"

        options = templates.get(key, [])
        if not options:
            return None

        template = random.choice(options)
        return template.format(
            name=review.get("user_name", "Покупатель"),
            product=review.get("product_name", "товар"),
            rating=rating,
        )

    async def improve_reply(self, original_reply: str, instruction: str) -> str | None:
        return await self._chat(
            [
                {"role": "system", "content": "Ты помощник. Перепиши ответ на отзыв по указанной инструкции. Выдай только текст ответа."},
                {"role": "user", "content": f"Оригинальный ответ:\n{original_reply}\n\nИнструкция: {instruction}"},
            ],
            temperature=0.7,
        )

    async def analyze_product_reviews(self, product_name: str, reviews: list) -> str | None:
        """Глубокий анализ отзывов по одному артикулу"""
        # Собираем отзывы в текст, ограничивая объём
        reviews_text = ""
        for r in reviews[:50]:  # макс 50 отзывов
            stars = r.get("rating", 0)
            text = (r.get("text") or "").strip()
            if text:
                reviews_text += f"[{stars}⭐] {text[:300]}\n\n"

        if not reviews_text.strip():
            return None

        total = len(reviews)
        avg = sum(r.get("rating", 0) for r in reviews) / total if total else 0
        neg = sum(1 for r in reviews if r.get("rating", 0) <= 3)
        pos = sum(1 for r in reviews if r.get("rating", 0) >= 4)

        system_prompt = """Ты аналитик отзывов на маркетплейсе Wildberries.
Проанализируй отзывы покупателей на товар и составь подробный отчёт.

Формат отчёта:

📊 ОБЩАЯ КАРТИНА
Краткое резюме в 2-3 предложения.

👍 ЧТО НРАВИТСЯ ПОКУПАТЕЛЯМ
Перечисли конкретные плюсы, которые упоминают чаще всего (с примерами из отзывов).

👎 НА ЧТО ЖАЛУЮТСЯ
Перечисли конкретные проблемы и жалобы (с примерами). Укажи насколько часто встречается каждая проблема.

⚠️ ПОВТОРЯЮЩИЕСЯ ПРОБЛЕМЫ
Выдели проблемы, которые упоминаются 3+ раз — это системные вопросы.

💡 РЕКОМЕНДАЦИИ ПО УЛУЧШЕНИЮ
Конкретные предложения что можно улучшить в товаре, упаковке, описании или сервисе. Приоритизируй по влиянию на рейтинг.

Пиши конкретно, без воды. Ссылайся на реальные цитаты из отзывов."""

        user_msg = f"""Товар: "{product_name}"
Всего отзывов: {total} (положительных: {pos}, негативных: {neg})
Средний рейтинг: {avg:.1f}

Отзывы:
{reviews_text}"""

        return await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=2000,
        )


ai_engine = AIEngine()
