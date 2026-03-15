"""
WB Review Bot — Telegram-интерфейс управления (мультикабинет)
"""
import logging
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton,
)
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, ConversationHandler, filters, ContextTypes,
)

from config import (
    TELEGRAM_BOT_TOKEN, ADMIN_IDS,
    load_settings, save_settings, load_templates, save_templates,
    load_training_examples, save_training_examples,
)
from database import (
    init_db, get_stats, get_pending_reviews, get_pending_questions,
    get_review, update_review_reply, mark_review_skipped,
    update_question_answer, get_keyword_rules, add_keyword_rule,
    delete_keyword_rule, toggle_keyword_rule, get_recent_activity,
    log_activity, get_question,
    add_cabinet, get_cabinets, get_cabinet, update_cabinet,
    delete_cabinet, get_cabinet_stats_summary,
    get_products_with_reviews, get_reviews_for_product,
)
from processor import processor
from ai_engine import ai_engine
from wb_api import WBClient, invalidate_client

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# === Состояния диалогов ===
(
    STATE_EDIT_REPLY, STATE_EDIT_QUESTION_REPLY,
    STATE_ADD_RULE_KEYWORD, STATE_ADD_RULE_RATING, STATE_ADD_RULE_ACTION, STATE_ADD_RULE_TEMPLATE,
    STATE_SET_TONE, STATE_SET_INTERVAL, STATE_SET_MAX_LENGTH,
    STATE_ADD_TRAINING, STATE_ADD_TRAINING_REPLY,
    STATE_ADD_KNOWLEDGE_ID, STATE_ADD_KNOWLEDGE_DESC,
    STATE_MANUAL_REPLY,
    STATE_CABINET_NAME, STATE_CABINET_KEY,
    STATE_CABINET_EDIT_NAME, STATE_CABINET_EDIT_KEY,
    STATE_CUSTOM_TONE,
) = range(19)


def admin_only(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id
        if ADMIN_IDS and user_id not in ADMIN_IDS:
            await update.message.reply_text("⛔ Доступ запрещён")
            return
        return await func(update, context)
    return wrapper


# =============================================
# ГЛАВНОЕ МЕНЮ
# =============================================

MAIN_KEYBOARD = ReplyKeyboardMarkup(
    [
        [KeyboardButton("📊 Статистика"), KeyboardButton("📝 Отзывы")],
        [KeyboardButton("❓ Вопросы"), KeyboardButton("⚙️ Настройки")],
        [KeyboardButton("📋 Правила"), KeyboardButton("🔄 Проверить сейчас")],
        [KeyboardButton("🏪 Кабинеты"), KeyboardButton("🔍 Анализ товаров")],
        [KeyboardButton("🎓 Обучение"), KeyboardButton("📜 Лог")],
    ],
    resize_keyboard=True,
)


@admin_only
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    settings = load_settings()
    status = "🟢 ВКЛ" if processor.running else "🔴 ВЫКЛ"
    cabinets = get_cabinets(active_only=True)

    await update.message.reply_text(
        f"🤖 *WB Review Bot*\n\n"
        f"Планировщик: {status}\n"
        f"Автоответы: {'✅' if settings['auto_reply_enabled'] else '❌'}\n"
        f"AI: {'✅' if settings['ai_enabled'] else '❌'}\n"
        f"Интервал: {settings['check_interval_minutes']} мин\n"
        f"Кабинетов: {len(cabinets)}\n\n"
        f"Используйте меню для управления.",
        parse_mode="Markdown",
        reply_markup=MAIN_KEYBOARD,
    )


# =============================================
# КАБИНЕТЫ
# =============================================

@admin_only
async def cmd_cabinets(update: Update, context: ContextTypes.DEFAULT_TYPE):
    summary = get_cabinet_stats_summary()
    if not summary:
        text = "🏪 Кабинетов нет.\n\nДобавьте кабинет WB, чтобы начать работу."
    else:
        lines = []
        for c in summary:
            status = "🟢" if c["is_active"] else "🔴"
            lines.append(
                f"{status} *{c['name']}* (#{c['id']})\n"
                f"   Ожидают: {c['pending_reviews']} отзывов, {c['pending_questions']} вопросов\n"
                f"   Отправлено: {c['sent_reviews']} ответов"
            )
        text = "🏪 *Кабинеты WB:*\n\n" + "\n\n".join(lines)

    buttons = [
        [InlineKeyboardButton("➕ Добавить кабинет", callback_data="cab_add")],
    ]
    if summary:
        for c in summary:
            row = []
            if c["is_active"]:
                row.append(InlineKeyboardButton(f"⏸ {c['name']}", callback_data=f"cab_disable_{c['id']}"))
            else:
                row.append(InlineKeyboardButton(f"▶️ {c['name']}", callback_data=f"cab_enable_{c['id']}"))
            row.append(InlineKeyboardButton(f"✏️", callback_data=f"cab_editname_{c['id']}"))
            row.append(InlineKeyboardButton(f"🔑", callback_data=f"cab_editkey_{c['id']}"))
            buttons.append(row)

    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_cab_add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(
        "🏪 *Добавление кабинета WB*\n\n"
        "Введите название кабинета (например: ИП Иванов, Магазин 2):",
        parse_mode="Markdown",
    )
    return STATE_CABINET_NAME


async def state_cabinet_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["new_cab_name"] = update.message.text.strip()
    await update.message.reply_text(
        f"Название: *{context.user_data['new_cab_name']}*\n\n"
        f"Теперь отправьте API-ключ WB.\n"
        f"(Кабинет продавца → Настройки → Доступ к API → токен с правами 'Вопросы и отзывы')",
        parse_mode="Markdown",
    )
    return STATE_CABINET_KEY


async def state_cabinet_key(update: Update, context: ContextTypes.DEFAULT_TYPE):
    api_key = update.message.text.strip()
    cab_name = context.user_data.get("new_cab_name", "Кабинет")

    # Удалим сообщение с ключом для безопасности
    try:
        await update.message.delete()
    except Exception:
        pass

    await update.message.reply_text("🔄 Проверяю ключ...")

    # Валидация ключа
    test_client = WBClient(api_key)
    try:
        result = await test_client.get_feedbacks_count()
        if result is not None:
            cab_id = add_cabinet(cab_name, api_key, added_by=update.effective_user.id)
            log_activity("cabinet_add", f"Добавлен кабинет '{cab_name}' (#{cab_id})")
            await update.effective_chat.send_message(
                f"✅ Кабинет *{cab_name}* (#{cab_id}) добавлен!\n\n"
                f"Ключ проверен, API работает.",
                parse_mode="Markdown",
            )
        else:
            await update.effective_chat.send_message(
                "❌ Ключ не прошёл проверку. WB API вернул ошибку.\n"
                "Проверьте, что у ключа есть права на 'Вопросы и отзывы'."
            )
    except Exception as e:
        await update.effective_chat.send_message(f"❌ Ошибка проверки: {e}")
    finally:
        await test_client.close()

    return ConversationHandler.END


async def cb_cab_toggle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    action, cab_id = data.rsplit("_", 1)
    cab_id = int(cab_id)

    if "enable" in action:
        update_cabinet(cab_id, is_active=1)
        invalidate_client(cab_id)
        await query.edit_message_text(f"▶️ Кабинет #{cab_id} активирован")
    else:
        update_cabinet(cab_id, is_active=0)
        invalidate_client(cab_id)
        await query.edit_message_text(f"⏸ Кабинет #{cab_id} деактивирован")


async def cb_cab_edit_name_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    cab_id = int(query.data.split("_")[-1])
    context.user_data["edit_cab_id"] = cab_id
    cabinet = get_cabinet(cab_id)
    await query.edit_message_text(
        f"✏️ Текущее название: *{cabinet['name']}*\n\nВведите новое название:",
        parse_mode="Markdown",
    )
    return STATE_CABINET_EDIT_NAME


async def state_cabinet_edit_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cab_id = context.user_data.get("edit_cab_id")
    new_name = update.message.text.strip()
    update_cabinet(cab_id, name=new_name)
    await update.message.reply_text(f"✅ Кабинет #{cab_id} переименован в *{new_name}*", parse_mode="Markdown")
    return ConversationHandler.END


async def cb_cab_edit_key_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    cab_id = int(query.data.split("_")[-1])
    context.user_data["edit_cab_id"] = cab_id
    await query.edit_message_text("🔑 Отправьте новый API-ключ WB:")
    return STATE_CABINET_EDIT_KEY


async def state_cabinet_edit_key(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cab_id = context.user_data.get("edit_cab_id")
    api_key = update.message.text.strip()

    try:
        await update.message.delete()
    except Exception:
        pass

    test_client = WBClient(api_key)
    try:
        result = await test_client.get_feedbacks_count()
        if result is not None:
            update_cabinet(cab_id, api_key=api_key)
            invalidate_client(cab_id)
            await update.effective_chat.send_message(f"✅ Ключ кабинета #{cab_id} обновлён и проверен!")
        else:
            await update.effective_chat.send_message("❌ Ключ не прошёл проверку.")
    except Exception as e:
        await update.effective_chat.send_message(f"❌ Ошибка: {e}")
    finally:
        await test_client.close()

    return ConversationHandler.END


# =============================================
# СТАТИСТИКА
# =============================================

@admin_only
async def cmd_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    kb = InlineKeyboardMarkup([
        [
            InlineKeyboardButton("1 день", callback_data="stats_1"),
            InlineKeyboardButton("7 дней", callback_data="stats_7"),
            InlineKeyboardButton("30 дней", callback_data="stats_30"),
        ],
    ])
    await update.message.reply_text("📊 За какой период?", reply_markup=kb)


async def cb_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    days = int(query.data.split("_")[1])
    stats = get_stats(days)

    rating_lines = []
    for r in range(5, 0, -1):
        count = stats["by_rating"].get(r, 0)
        bar = "█" * min(count, 20)
        rating_lines.append(f"{'⭐' * r} {count} {bar}")

    sent_lines = []
    for s, label in [("positive", "😊 Позитив"), ("negative", "😞 Негатив"),
                      ("neutral", "😐 Нейтрал"), ("mixed", "🤔 Смешан")]:
        count = stats["by_sentiment"].get(s, 0)
        if count:
            sent_lines.append(f"  {label}: {count}")

    text = (
        f"📊 *Статистика за {days} дн. (все кабинеты)*\n\n"
        f"📝 Отзывов: {stats['total_reviews']}\n"
        f"⭐ Средний рейтинг: {stats['avg_rating']}\n"
        f"✅ Ответов отправлено: {stats['replies_sent']}\n"
        f"🤖 Из них автоответов: {stats['auto_replies']}\n"
        f"❓ Вопросов: {stats['total_questions']}\n"
        f"💬 Отвечено: {stats['questions_answered']}\n\n"
        f"*Рейтинги:*\n" + "\n".join(rating_lines) + "\n\n"
        f"*Тональность:*\n" + ("\n".join(sent_lines) if sent_lines else "  Нет данных") + "\n\n"
        f"⏳ Ожидают ответа: {stats['pending_reviews']} отзывов, {stats['pending_questions']} вопросов"
    )
    await query.edit_message_text(text, parse_mode="Markdown")


# =============================================
# ОТЗЫВЫ
# =============================================

@admin_only
async def cmd_reviews(update: Update, context: ContextTypes.DEFAULT_TYPE):
    reviews = get_pending_reviews(10)
    if not reviews:
        await update.message.reply_text("✅ Нет отзывов, ожидающих ответа!")
        return

    for r in reviews:
        stars = "⭐" * r["rating"] if r["rating"] else "—"
        sentiment = {"positive": "😊", "negative": "😞", "neutral": "😐", "mixed": "🤔"}.get(r.get("sentiment", ""), "")
        cab_name = r.get("cabinet_name", "?")

        text = (
            f"{'─' * 30}\n"
            f"🏪 {cab_name}\n"
            f"📦 {r['product_name']}\n"
            f"Оценка: {stars} {sentiment}\n"
            f"👤 {r['user_name']}\n"
            f"💬 {r['text'][:400] if r['text'] else '(без текста)'}\n"
        )

        if r.get("reply_text"):
            text += f"\n🤖 Подготовленный ответ:\n_{r['reply_text'][:300]}_\n"

        buttons = []
        if r.get("reply_text"):
            buttons.append([
                InlineKeyboardButton("✅ Отправить", callback_data=f"send_{r['id']}"),
                InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_{r['id']}"),
            ])
        else:
            buttons.append([
                InlineKeyboardButton("🤖 Сгенерировать ответ", callback_data=f"gen_{r['id']}"),
                InlineKeyboardButton("✍️ Написать вручную", callback_data=f"manual_{r['id']}"),
            ])
        buttons.append([
            InlineKeyboardButton("⏭ Пропустить", callback_data=f"skip_{r['id']}"),
            InlineKeyboardButton("🔄 Перегенерить", callback_data=f"regen_{r['id']}"),
        ])

        await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_review_action(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    action, review_id = data.split("_", 1)

    if action == "send":
        success = await processor.approve_and_send_review(review_id)
        if success:
            await query.edit_message_text(f"✅ Ответ на отзыв `{review_id}` отправлен!", parse_mode="Markdown")
        else:
            await query.edit_message_text("❌ Ошибка отправки. Проверьте API ключ WB.")

    elif action == "skip":
        mark_review_skipped(review_id)
        await query.edit_message_text(f"⏭ Отзыв `{review_id}` пропущен", parse_mode="Markdown")

    elif action in ("gen", "regen"):
        review = get_review(review_id)
        if not review:
            await query.edit_message_text("❌ Отзыв не найден")
            return
        await query.edit_message_text("⏳ Генерирую ответ...")
        reply = await ai_engine.generate_review_reply(review)
        if reply:
            update_review_reply(review_id, reply, status="pending", ai=True)
            buttons = [[
                InlineKeyboardButton("✅ Отправить", callback_data=f"send_{review_id}"),
                InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_{review_id}"),
                InlineKeyboardButton("🔄 Ещё", callback_data=f"regen_{review_id}"),
            ]]
            await query.edit_message_text(
                f"🤖 Сгенерированный ответ:\n\n_{reply}_",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(buttons),
            )
        else:
            await query.edit_message_text("❌ Не удалось сгенерировать ответ")

    elif action == "edit":
        context.user_data["edit_review_id"] = review_id
        await query.edit_message_text(
            f"✏️ Отправьте новый текст ответа для отзыва `{review_id}`:",
            parse_mode="Markdown",
        )
        return STATE_EDIT_REPLY

    elif action == "manual":
        context.user_data["edit_review_id"] = review_id
        await query.edit_message_text(
            f"✍️ Напишите ответ на отзыв `{review_id}`:",
            parse_mode="Markdown",
        )
        return STATE_MANUAL_REPLY


async def state_edit_reply(update: Update, context: ContextTypes.DEFAULT_TYPE):
    review_id = context.user_data.get("edit_review_id")
    new_text = update.message.text.strip()
    update_review_reply(review_id, new_text, status="pending", ai=False)

    buttons = [[
        InlineKeyboardButton("✅ Отправить", callback_data=f"send_{review_id}"),
        InlineKeyboardButton("✏️ Изменить", callback_data=f"edit_{review_id}"),
    ]]
    await update.message.reply_text(
        f"✏️ Ответ обновлён:\n\n_{new_text}_\n",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )
    return ConversationHandler.END


# =============================================
# ВОПРОСЫ
# =============================================

@admin_only
async def cmd_questions(update: Update, context: ContextTypes.DEFAULT_TYPE):
    questions = get_pending_questions(10)
    if not questions:
        await update.message.reply_text("✅ Нет вопросов, ожидающих ответа!")
        return

    for q in questions:
        cab_name = q.get("cabinet_name", "?")
        text = (
            f"{'─' * 30}\n"
            f"🏪 {cab_name}\n"
            f"📦 {q['product_name']}\n"
            f"❓ {q['question_text'][:400]}\n"
        )
        if q.get("answer_text"):
            text += f"\n🤖 Подготовленный ответ:\n_{q['answer_text'][:300]}_\n"

        buttons = []
        if q.get("answer_text"):
            buttons.append([
                InlineKeyboardButton("✅ Отправить", callback_data=f"sendq_{q['id']}"),
                InlineKeyboardButton("✏️ Редактировать", callback_data=f"editq_{q['id']}"),
            ])
        else:
            buttons.append([
                InlineKeyboardButton("🤖 Сгенерировать", callback_data=f"genq_{q['id']}"),
            ])

        await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_question_action(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    action = data[:data.index("_")]
    q_id = data[data.index("_") + 1:]

    if action == "sendq":
        success = await processor.approve_and_send_question(q_id)
        if success:
            await query.edit_message_text("✅ Ответ на вопрос отправлен!")
        else:
            await query.edit_message_text("❌ Ошибка отправки")

    elif action == "genq":
        q = get_question(q_id)
        if not q:
            await query.edit_message_text("❌ Вопрос не найден")
            return
        await query.edit_message_text("⏳ Генерирую ответ...")
        reply = await ai_engine.generate_question_reply(dict(q))
        if reply:
            update_question_answer(q_id, reply, status="pending", ai=True)
            buttons = [[
                InlineKeyboardButton("✅ Отправить", callback_data=f"sendq_{q_id}"),
                InlineKeyboardButton("✏️ Редактировать", callback_data=f"editq_{q_id}"),
            ]]
            await query.edit_message_text(
                f"🤖 Ответ:\n\n_{reply}_",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(buttons),
            )

    elif action == "editq":
        context.user_data["edit_question_id"] = q_id
        await query.edit_message_text("✏️ Отправьте текст ответа на вопрос:")
        return STATE_EDIT_QUESTION_REPLY


async def state_edit_question_reply(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q_id = context.user_data.get("edit_question_id")
    new_text = update.message.text.strip()
    update_question_answer(q_id, new_text, status="pending", ai=False)
    buttons = [[InlineKeyboardButton("✅ Отправить", callback_data=f"sendq_{q_id}")]]
    await update.message.reply_text(
        f"✏️ Ответ обновлён:\n\n_{new_text}_",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )
    return ConversationHandler.END


# =============================================
# НАСТРОЙКИ
# =============================================

@admin_only
async def cmd_settings(update: Update, context: ContextTypes.DEFAULT_TYPE):
    settings = load_settings()

    def yn(v):
        return "✅" if v else "❌"

    text = (
        f"⚙️ *Настройки*\n\n"
        f"🔄 Автоответы: {yn(settings['auto_reply_enabled'])}\n"
        f"  📗 На позитивные (4-5⭐): {yn(settings['auto_reply_positive'])}\n"
        f"  📕 На негативные (1-3⭐): {yn(settings['auto_reply_negative'])}\n"
        f"  ❓ На вопросы: {yn(settings['auto_reply_questions'])}\n"
        f"  ✋ Требовать одобрение: {yn(settings['require_approval'])}\n\n"
        f"🤖 AI: {yn(settings['ai_enabled'])}\n"
        f"  🎭 Тон: {settings['ai_tone']}"
        f"{' — ' + settings['ai_custom_prompt'][:80] if settings['ai_tone'] == 'custom' and settings.get('ai_custom_prompt') else ''}\n"
        f"  📏 Макс длина: {settings['ai_max_length']}\n\n"
        f"🔔 Уведомления:\n"
        f"  📝 Новые отзывы: {yn(settings['notify_new_reviews'])}\n"
        f"  ❓ Новые вопросы: {yn(settings['notify_new_questions'])}\n\n"
        f"⏱ Интервал проверки: {settings['check_interval_minutes']} мин"
    )

    buttons = [
        [
            InlineKeyboardButton(
                f"{'🔴' if settings['auto_reply_enabled'] else '🟢'} Автоответы",
                callback_data="toggle_auto_reply_enabled"
            ),
            InlineKeyboardButton(
                f"{'🔴' if settings['ai_enabled'] else '🟢'} AI",
                callback_data="toggle_ai_enabled"
            ),
        ],
        [
            InlineKeyboardButton(
                f"Позитив {'❌' if settings['auto_reply_positive'] else '✅'}",
                callback_data="toggle_auto_reply_positive"
            ),
            InlineKeyboardButton(
                f"Негатив {'❌' if settings['auto_reply_negative'] else '✅'}",
                callback_data="toggle_auto_reply_negative"
            ),
        ],
        [
            InlineKeyboardButton(
                f"Вопросы {'❌' if settings['auto_reply_questions'] else '✅'}",
                callback_data="toggle_auto_reply_questions"
            ),
            InlineKeyboardButton(
                f"Одобрение {'❌' if settings['require_approval'] else '✅'}",
                callback_data="toggle_require_approval"
            ),
        ],
        [
            InlineKeyboardButton(
                f"Увед.отзывы {'❌' if settings['notify_new_reviews'] else '✅'}",
                callback_data="toggle_notify_new_reviews"
            ),
            InlineKeyboardButton(
                f"Увед.вопросы {'❌' if settings['notify_new_questions'] else '✅'}",
                callback_data="toggle_notify_new_questions"
            ),
        ],
        [
            InlineKeyboardButton("🎭 Тон", callback_data="set_tone"),
            InlineKeyboardButton("⏱ Интервал", callback_data="set_interval"),
            InlineKeyboardButton("📏 Длина", callback_data="set_max_length"),
        ],
        [
            InlineKeyboardButton(
                f"{'⏹ Стоп' if processor.running else '▶️ Старт'} планировщик",
                callback_data="toggle_scheduler"
            ),
        ],
    ]

    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_toggle_setting(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    key = query.data.replace("toggle_", "")

    if key == "scheduler":
        if processor.running:
            await processor.stop_scheduler()
            await query.edit_message_text("⏹ Планировщик остановлен")
        else:
            await processor.start_scheduler()
            await query.edit_message_text("▶️ Планировщик запущен!")
        return

    settings = load_settings()
    if key in settings and isinstance(settings[key], bool):
        settings[key] = not settings[key]
        save_settings(settings)
        status = "✅ ВКЛ" if settings[key] else "❌ ВЫКЛ"
        log_activity("settings", f"{key} → {status}")
        await query.edit_message_text(f"Настройка `{key}`: {status}", parse_mode="Markdown")


async def cb_set_tone(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    settings = load_settings()
    current = settings.get("ai_tone", "friendly")

    buttons = [
        [InlineKeyboardButton("😊 Дружелюбный", callback_data="tone_friendly")],
        [InlineKeyboardButton("🏢 Формальный", callback_data="tone_formal")],
        [InlineKeyboardButton("😎 Неформальный", callback_data="tone_casual")],
        [InlineKeyboardButton("✍️ Свой стиль", callback_data="tone_custom_start")],
    ]

    text = "🎭 Выберите тон ответов:"
    if current == "custom" and settings.get("ai_custom_prompt"):
        text += f"\n\nТекущий свой стиль:\n_{settings['ai_custom_prompt'][:300]}_"

    await query.edit_message_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_apply_tone(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    tone = query.data.replace("tone_", "")
    settings = load_settings()
    settings["ai_tone"] = tone
    save_settings(settings)
    labels = {"friendly": "😊 Дружелюбный", "formal": "🏢 Формальный", "casual": "😎 Неформальный"}
    await query.edit_message_text(f"🎭 Тон установлен: {labels.get(tone, tone)}")


async def cb_custom_tone_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(
        "✍️ *Свой стиль ответов*\n\n"
        "Напишите инструкцию для AI, как он должен отвечать на отзывы.\n\n"
        "Примеры:\n"
        "• _Отвечай на все отзывы стихами в четверостишиях_\n"
        "• _Отвечай коротко, максимум 2 предложения, без эмодзи_\n"
        "• _Обращайся на ты, используй молодежный сленг_\n"
        "• _Всегда упоминай что у нас бесплатная доставка и скидка 10% на следующий заказ_\n\n"
        "Отправьте текст инструкции:",
        parse_mode="Markdown",
    )
    return STATE_CUSTOM_TONE


async def state_custom_tone(update: Update, context: ContextTypes.DEFAULT_TYPE):
    custom_prompt = update.message.text.strip()
    settings = load_settings()
    settings["ai_tone"] = "custom"
    settings["ai_custom_prompt"] = custom_prompt
    save_settings(settings)
    log_activity("settings", f"Установлен свой стиль: {custom_prompt[:100]}")
    await update.message.reply_text(
        f"✅ Свой стиль установлен!\n\n"
        f"Инструкция:\n_{custom_prompt}_\n\n"
        f"AI будет следовать этим правилам при генерации ответов.",
        parse_mode="Markdown",
    )
    return ConversationHandler.END


async def cb_set_interval(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    buttons = [
        [
            InlineKeyboardButton("5 мин", callback_data="interval_5"),
            InlineKeyboardButton("15 мин", callback_data="interval_15"),
            InlineKeyboardButton("30 мин", callback_data="interval_30"),
            InlineKeyboardButton("60 мин", callback_data="interval_60"),
        ],
    ]
    await query.edit_message_text("⏱ Интервал проверки:", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_apply_interval(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    minutes = int(query.data.replace("interval_", ""))
    settings = load_settings()
    settings["check_interval_minutes"] = minutes
    save_settings(settings)
    await query.edit_message_text(f"⏱ Интервал: {minutes} мин")


async def cb_set_max_length(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    buttons = [
        [
            InlineKeyboardButton("200", callback_data="maxlen_200"),
            InlineKeyboardButton("300", callback_data="maxlen_300"),
            InlineKeyboardButton("500", callback_data="maxlen_500"),
            InlineKeyboardButton("800", callback_data="maxlen_800"),
        ],
    ]
    await query.edit_message_text("📏 Макс длина ответа (символов):", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_apply_max_length(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    length = int(query.data.replace("maxlen_", ""))
    settings = load_settings()
    settings["ai_max_length"] = length
    save_settings(settings)
    await query.edit_message_text(f"📏 Макс длина ответа: {length}")


# =============================================
# ПРАВИЛА ПО КЛЮЧЕВЫМ СЛОВАМ
# =============================================

@admin_only
async def cmd_rules(update: Update, context: ContextTypes.DEFAULT_TYPE):
    rules = get_keyword_rules(enabled_only=False)
    if not rules:
        text = "📋 Правил пока нет.\n\nДобавьте правило, чтобы бот реагировал на конкретные слова в отзывах."
    else:
        lines = []
        for r in rules:
            status = "✅" if r["enabled"] else "❌"
            lines.append(
                f"{status} #{r['id']} `{r['keyword']}` "
                f"[{r['match_type']}] рейтинг:{r['rating_filter']} → {r['action']}"
            )
        text = "📋 *Правила по ключевым словам:*\n\n" + "\n".join(lines)

    buttons = [
        [InlineKeyboardButton("➕ Добавить правило", callback_data="add_rule")],
    ]
    if rules:
        buttons.append([InlineKeyboardButton("🗑 Удалить правило", callback_data="del_rule_menu")])

    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_add_rule_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("📝 Введите ключевое слово или фразу для правила:")
    return STATE_ADD_RULE_KEYWORD


async def state_add_rule_keyword(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["new_rule_keyword"] = update.message.text.strip()
    buttons = [
        [
            InlineKeyboardButton("Любой", callback_data="rulerating_any"),
            InlineKeyboardButton("1⭐", callback_data="rulerating_1"),
            InlineKeyboardButton("2⭐", callback_data="rulerating_2"),
        ],
        [
            InlineKeyboardButton("3⭐", callback_data="rulerating_3"),
            InlineKeyboardButton("4⭐", callback_data="rulerating_4"),
            InlineKeyboardButton("5⭐", callback_data="rulerating_5"),
        ],
        [
            InlineKeyboardButton("Позитив (4-5)", callback_data="rulerating_positive"),
            InlineKeyboardButton("Негатив (1-3)", callback_data="rulerating_negative"),
        ],
    ]
    await update.message.reply_text("🎯 Фильтр по рейтингу:", reply_markup=InlineKeyboardMarkup(buttons))
    return STATE_ADD_RULE_RATING


async def cb_add_rule_rating(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    context.user_data["new_rule_rating"] = query.data.replace("rulerating_", "")

    buttons = [
        [InlineKeyboardButton("📝 Ответить шаблоном", callback_data="ruleaction_template")],
        [InlineKeyboardButton("🤖 Ответить через AI", callback_data="ruleaction_ai")],
        [InlineKeyboardButton("⏭ Пропустить", callback_data="ruleaction_skip")],
        [InlineKeyboardButton("🔔 Только уведомить", callback_data="ruleaction_notify")],
    ]
    await query.edit_message_text("⚡ Действие при совпадении:", reply_markup=InlineKeyboardMarkup(buttons))
    return STATE_ADD_RULE_ACTION


async def cb_add_rule_action(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    action = query.data.replace("ruleaction_", "")
    context.user_data["new_rule_action"] = action

    if action == "template":
        await query.edit_message_text(
            "📝 Введите шаблон ответа.\n"
            "Переменные: {name}, {product}, {rating}\n\n"
            "Пример: Спасибо за отзыв, {name}! Мы уже работаем над этим!"
        )
        return STATE_ADD_RULE_TEMPLATE
    else:
        rule_id = add_keyword_rule(
            keyword=context.user_data["new_rule_keyword"],
            rating_filter=context.user_data["new_rule_rating"],
            action=action,
        )
        await query.edit_message_text(f"✅ Правило #{rule_id} добавлено!")
        return ConversationHandler.END


async def state_add_rule_template(update: Update, context: ContextTypes.DEFAULT_TYPE):
    template = update.message.text.strip()
    rule_id = add_keyword_rule(
        keyword=context.user_data["new_rule_keyword"],
        rating_filter=context.user_data["new_rule_rating"],
        action="template",
        response_template=template,
    )
    await update.message.reply_text(f"✅ Правило #{rule_id} с шаблоном добавлено!")
    return ConversationHandler.END


async def cb_del_rule_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    rules = get_keyword_rules(enabled_only=False)
    buttons = []
    for r in rules:
        buttons.append([InlineKeyboardButton(
            f"🗑 #{r['id']} {r['keyword'][:20]}", callback_data=f"delrule_{r['id']}"
        )])
    await query.edit_message_text("Выберите правило для удаления:", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_del_rule(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    rule_id = int(query.data.replace("delrule_", ""))
    delete_keyword_rule(rule_id)
    await query.edit_message_text(f"🗑 Правило #{rule_id} удалено")


# =============================================
# ОБУЧЕНИЕ
# =============================================

@admin_only
async def cmd_training(update: Update, context: ContextTypes.DEFAULT_TYPE):
    examples = load_training_examples()
    text = (
        f"🎓 *Обучение на примерах*\n\n"
        f"Примеров в базе: {len(examples)}\n\n"
        f"Добавляйте хорошие пары «отзыв → ответ», "
        f"чтобы AI учился вашему стилю.\n"
    )

    if examples:
        text += "\nПоследние 3:\n"
        for ex in examples[-3:]:
            text += f"\n⭐{ex.get('rating', '?')} _{ex.get('review_text', '')[:100]}_\n→ {ex.get('reply_text', '')[:100]}\n"

    buttons = [
        [InlineKeyboardButton("➕ Добавить пример", callback_data="add_training")],
    ]
    if examples:
        buttons.append([InlineKeyboardButton("🗑 Очистить все", callback_data="clear_training")])

    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(buttons))


async def cb_add_training(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text(
        "📝 Отправьте текст отзыва (пример).\n"
        "Формат: `рейтинг | текст отзыва`\n"
        "Пример: `5 | Отличные кроссовки, удобные и красивые!`",
        parse_mode="Markdown",
    )
    return STATE_ADD_TRAINING


async def state_add_training_review(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    parts = text.split("|", 1)
    if len(parts) == 2:
        context.user_data["training_rating"] = int(parts[0].strip()) if parts[0].strip().isdigit() else 0
        context.user_data["training_review"] = parts[1].strip()
    else:
        context.user_data["training_rating"] = 0
        context.user_data["training_review"] = text

    await update.message.reply_text("✏️ Теперь отправьте идеальный ответ на этот отзыв:")
    return STATE_ADD_TRAINING_REPLY


async def state_add_training_reply(update: Update, context: ContextTypes.DEFAULT_TYPE):
    reply_text = update.message.text.strip()
    examples = load_training_examples()
    examples.append({
        "rating": context.user_data.get("training_rating", 0),
        "review_text": context.user_data.get("training_review", ""),
        "reply_text": reply_text,
    })
    save_training_examples(examples)
    await update.message.reply_text(f"✅ Пример добавлен! Всего примеров: {len(examples)}")
    return ConversationHandler.END


async def cb_clear_training(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    save_training_examples([])
    await query.edit_message_text("🗑 Все обучающие примеры удалены")


# =============================================
# ПРОВЕРКА СЕЙЧАС / ЛОГ
# =============================================

@admin_only
async def cmd_check_now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cabinets = get_cabinets(active_only=True)
    if not cabinets:
        await update.message.reply_text("❌ Нет активных кабинетов. Добавьте через 🏪 Кабинеты.")
        return
    await update.message.reply_text(f"🔄 Проверяю {len(cabinets)} кабинет(ов)...")
    stats = await processor.fetch_and_process()
    await update.message.reply_text(
        f"✅ Проверка завершена!\n\n"
        f"📝 Новых отзывов: {stats['new_reviews']}\n"
        f"❓ Новых вопросов: {stats['new_questions']}\n"
        f"🤖 Автоответов: {stats['auto_replied']}\n"
        f"❌ Ошибок: {stats['errors']}"
    )


@admin_only
async def cmd_log(update: Update, context: ContextTypes.DEFAULT_TYPE):
    activities = get_recent_activity(15)
    if not activities:
        await update.message.reply_text("📜 Лог пуст")
        return

    lines = []
    for a in activities:
        ts = a["created_at"][:16] if a.get("created_at") else "?"
        cab = f"[{a['cabinet_name']}] " if a.get("cabinet_name") else ""
        lines.append(f"`{ts}` {cab}{a['action']}: {a.get('details', '')[:80]}")

    await update.message.reply_text(
        "📜 *Последние действия:*\n\n" + "\n".join(lines),
        parse_mode="Markdown",
    )


# =============================================
# АНАЛИЗ ТОВАРОВ
# =============================================

@admin_only
async def cmd_product_analysis(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cabinets = get_cabinets(active_only=True)
    if not cabinets:
        await update.message.reply_text("❌ Нет активных кабинетов.")
        return

    if len(cabinets) == 1:
        # Один кабинет -- сразу выбор периода
        context.user_data["analysis_cab_id"] = cabinets[0]["id"]
        buttons = [
            [
                InlineKeyboardButton("7 дней", callback_data="anperiod_7"),
                InlineKeyboardButton("30 дней", callback_data="anperiod_30"),
                InlineKeyboardButton("90 дней", callback_data="anperiod_90"),
            ],
        ]
        await update.message.reply_text(
            f"🔍 *Анализ товаров — {cabinets[0]['name']}*\n\nВыберите период:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(buttons),
        )
    else:
        # Несколько кабинетов -- сначала выбор кабинета
        buttons = []
        for c in cabinets:
            buttons.append([InlineKeyboardButton(f"🏪 {c['name']}", callback_data=f"ancab_{c['id']}")])
        await update.message.reply_text(
            "🔍 *Анализ товаров*\n\nВыберите кабинет:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(buttons),
        )


async def cb_analysis_select_cabinet(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    cab_id = int(query.data.replace("ancab_", ""))
    context.user_data["analysis_cab_id"] = cab_id
    cabinet = get_cabinet(cab_id)
    buttons = [
        [
            InlineKeyboardButton("7 дней", callback_data="anperiod_7"),
            InlineKeyboardButton("30 дней", callback_data="anperiod_30"),
            InlineKeyboardButton("90 дней", callback_data="anperiod_90"),
        ],
    ]
    await query.edit_message_text(
        f"🔍 *Анализ товаров — {cabinet['name']}*\n\nВыберите период:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def cb_analysis_select_period(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    days = int(query.data.replace("anperiod_", ""))
    cab_id = context.user_data.get("analysis_cab_id")
    if not cab_id:
        await query.edit_message_text("❌ Кабинет не выбран. Начните заново.")
        return

    context.user_data["analysis_days"] = days
    products = get_products_with_reviews(cab_id, days)

    if not products:
        await query.edit_message_text(f"📭 Нет отзывов за последние {days} дней в этом кабинете.")
        return

    # Показываем список товаров с кнопками
    lines = []
    buttons = []
    for p in products[:20]:  # макс 20 товаров
        avg = round(p["avg_rating"], 1) if p["avg_rating"] else 0
        lines.append(
            f"• *{p['product_name'][:40]}*\n"
            f"  Артикул: `{p['product_id']}` | {p['review_count']} отзывов | ⭐{avg} | "
            f"👍{p['positive_count']} 👎{p['negative_count']}"
        )
        buttons.append([InlineKeyboardButton(
            f"📊 {p['product_name'][:30]} ({p['review_count']})",
            callback_data=f"anprod_{cab_id}_{days}_{p['product_id']}"
        )])

    buttons.append([InlineKeyboardButton(
        "📊 Анализ ВСЕХ товаров",
        callback_data=f"anall_{cab_id}_{days}"
    )])

    await query.edit_message_text(
        f"🔍 *Товары за {days} дней:*\n\n" + "\n".join(lines) +
        "\n\nВыберите товар для анализа:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


async def cb_analysis_product(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    parts = query.data.replace("anprod_", "").split("_", 2)
    cab_id = int(parts[0])
    days = int(parts[1])
    product_id = parts[2]

    await query.edit_message_text("⏳ Анализирую отзывы... Это может занять до минуты.")

    reviews = get_reviews_for_product(cab_id, product_id, days)
    if not reviews:
        await query.edit_message_text("📭 Нет отзывов по этому товару.")
        return

    product_name = reviews[0].get("product_name", product_id) if reviews else product_id
    # Ищем имя товара из БД
    from database import get_db
    conn = get_db()
    row = conn.execute(
        "SELECT product_name FROM reviews WHERE cabinet_id = ? AND product_id = ? LIMIT 1",
        (cab_id, product_id)
    ).fetchone()
    conn.close()
    product_name = row["product_name"] if row else product_id

    report = await ai_engine.analyze_product_reviews(product_name, reviews)
    if not report:
        await query.edit_message_text("❌ Не удалось сгенерировать отчёт.")
        return

    total = len(reviews)
    avg = sum(r.get("rating", 0) for r in reviews) / total if total else 0

    header = (
        f"🔍 *Анализ: {product_name}*\n"
        f"Артикул: `{product_id}`\n"
        f"Период: {days} дней | Отзывов: {total} | ⭐{avg:.1f}\n"
        f"{'─' * 30}\n\n"
    )

    # Telegram лимит 4096 символов, разбиваем если надо
    full_text = header + report
    if len(full_text) <= 4096:
        await query.edit_message_text(full_text, parse_mode="Markdown")
    else:
        await query.edit_message_text(header + report[:3800] + "\n\n_(продолжение ниже)_", parse_mode="Markdown")
        remaining = report[3800:]
        while remaining:
            chunk = remaining[:4096]
            remaining = remaining[4096:]
            await query.message.reply_text(chunk, parse_mode="Markdown")


async def cb_analysis_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    parts = query.data.replace("anall_", "").split("_", 1)
    cab_id = int(parts[0])
    days = int(parts[1])

    products = get_products_with_reviews(cab_id, days)
    if not products:
        await query.edit_message_text("📭 Нет товаров с отзывами.")
        return

    cabinet = get_cabinet(cab_id)
    await query.edit_message_text(
        f"⏳ Анализирую {len(products)} товаров для кабинета *{cabinet['name']}*...\n"
        f"Это может занять несколько минут.",
        parse_mode="Markdown",
    )

    for p in products[:10]:  # макс 10 товаров за раз
        reviews = get_reviews_for_product(cab_id, p["product_id"], days)
        if not reviews or not any(r.get("text") for r in reviews):
            continue

        report = await ai_engine.analyze_product_reviews(p["product_name"], reviews)
        if not report:
            continue

        total = len(reviews)
        avg = round(p["avg_rating"], 1) if p["avg_rating"] else 0

        header = (
            f"🔍 *{p['product_name']}*\n"
            f"Артикул: `{p['product_id']}` | {total} отзывов | ⭐{avg}\n"
            f"{'─' * 30}\n\n"
        )

        full_text = header + report
        if len(full_text) <= 4096:
            await query.message.reply_text(full_text, parse_mode="Markdown")
        else:
            await query.message.reply_text(header + report[:3800], parse_mode="Markdown")

    await query.message.reply_text(
        f"✅ Анализ завершён! Проанализировано товаров: {min(len(products), 10)}"
    )


# =============================================
# ОБРАБОТКА ТЕКСТОВЫХ КНОПОК МЕНЮ
# =============================================

@admin_only
async def handle_menu_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    handlers = {
        "📊 Статистика": cmd_stats,
        "📝 Отзывы": cmd_reviews,
        "❓ Вопросы": cmd_questions,
        "⚙️ Настройки": cmd_settings,
        "📋 Правила": cmd_rules,
        "🔄 Проверить сейчас": cmd_check_now,
        "🏪 Кабинеты": cmd_cabinets,
        "🔍 Анализ товаров": cmd_product_analysis,
        "🎓 Обучение": cmd_training,
        "📜 Лог": cmd_log,
    }
    handler = handlers.get(text)
    if handler:
        await handler(update, context)


# =============================================
# MAIN
# =============================================

def main():
    init_db()

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    # Уведомления через Telegram
    async def notify_admins(text: str):
        for admin_id in ADMIN_IDS:
            try:
                await app.bot.send_message(admin_id, text, parse_mode="Markdown")
            except Exception as e:
                logger.error(f"Notify error: {e}")

    processor.set_notify_callback(notify_admins)

    # === ConversationHandlers ===

    cabinet_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_cab_add_start, pattern=r"^cab_add$")],
        states={
            STATE_CABINET_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_cabinet_name)],
            STATE_CABINET_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_cabinet_key)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    cabinet_edit_name_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_cab_edit_name_start, pattern=r"^cab_editname_\d+$")],
        states={
            STATE_CABINET_EDIT_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_cabinet_edit_name)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    cabinet_edit_key_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_cab_edit_key_start, pattern=r"^cab_editkey_\d+$")],
        states={
            STATE_CABINET_EDIT_KEY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_cabinet_edit_key)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    custom_tone_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_custom_tone_start, pattern=r"^tone_custom_start$")],
        states={
            STATE_CUSTOM_TONE: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_custom_tone)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    rule_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_add_rule_start, pattern=r"^add_rule$")],
        states={
            STATE_ADD_RULE_KEYWORD: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_add_rule_keyword)],
            STATE_ADD_RULE_RATING: [CallbackQueryHandler(cb_add_rule_rating, pattern=r"^rulerating_")],
            STATE_ADD_RULE_ACTION: [CallbackQueryHandler(cb_add_rule_action, pattern=r"^ruleaction_")],
            STATE_ADD_RULE_TEMPLATE: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_add_rule_template)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    training_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_add_training, pattern=r"^add_training$")],
        states={
            STATE_ADD_TRAINING: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_add_training_review)],
            STATE_ADD_TRAINING_REPLY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_add_training_reply)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    edit_conv = ConversationHandler(
        entry_points=[
            CallbackQueryHandler(cb_review_action, pattern=r"^(edit|manual)_"),
        ],
        states={
            STATE_EDIT_REPLY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_edit_reply)],
            STATE_MANUAL_REPLY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_edit_reply)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    edit_q_conv = ConversationHandler(
        entry_points=[CallbackQueryHandler(cb_question_action, pattern=r"^editq_")],
        states={
            STATE_EDIT_QUESTION_REPLY: [MessageHandler(filters.TEXT & ~filters.COMMAND, state_edit_question_reply)],
        },
        fallbacks=[CommandHandler("cancel", cmd_start)],
        per_message=False,
    )

    # === Команды ===
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("stats", cmd_stats))
    app.add_handler(CommandHandler("reviews", cmd_reviews))
    app.add_handler(CommandHandler("questions", cmd_questions))
    app.add_handler(CommandHandler("settings", cmd_settings))
    app.add_handler(CommandHandler("rules", cmd_rules))
    app.add_handler(CommandHandler("check", cmd_check_now))
    app.add_handler(CommandHandler("training", cmd_training))
    app.add_handler(CommandHandler("log", cmd_log))
    app.add_handler(CommandHandler("cabinets", cmd_cabinets))
    app.add_handler(CommandHandler("analysis", cmd_product_analysis))

    # ConversationHandlers
    app.add_handler(cabinet_conv)
    app.add_handler(cabinet_edit_name_conv)
    app.add_handler(cabinet_edit_key_conv)
    app.add_handler(custom_tone_conv)
    app.add_handler(rule_conv)
    app.add_handler(training_conv)
    app.add_handler(edit_conv)
    app.add_handler(edit_q_conv)

    # Inline callbacks
    app.add_handler(CallbackQueryHandler(cb_stats, pattern=r"^stats_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_toggle_setting, pattern=r"^toggle_"))
    app.add_handler(CallbackQueryHandler(cb_set_tone, pattern=r"^set_tone$"))
    app.add_handler(CallbackQueryHandler(cb_apply_tone, pattern=r"^tone_"))
    app.add_handler(CallbackQueryHandler(cb_set_interval, pattern=r"^set_interval$"))
    app.add_handler(CallbackQueryHandler(cb_apply_interval, pattern=r"^interval_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_set_max_length, pattern=r"^set_max_length$"))
    app.add_handler(CallbackQueryHandler(cb_apply_max_length, pattern=r"^maxlen_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_review_action, pattern=r"^(send|skip|gen|regen)_"))
    app.add_handler(CallbackQueryHandler(cb_question_action, pattern=r"^(sendq|genq)_"))
    app.add_handler(CallbackQueryHandler(cb_cab_toggle, pattern=r"^cab_(enable|disable)_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_analysis_select_cabinet, pattern=r"^ancab_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_analysis_select_period, pattern=r"^anperiod_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_analysis_product, pattern=r"^anprod_"))
    app.add_handler(CallbackQueryHandler(cb_analysis_all, pattern=r"^anall_"))
    app.add_handler(CallbackQueryHandler(cb_del_rule_menu, pattern=r"^del_rule_menu$"))
    app.add_handler(CallbackQueryHandler(cb_del_rule, pattern=r"^delrule_\d+$"))
    app.add_handler(CallbackQueryHandler(cb_clear_training, pattern=r"^clear_training$"))

    # Текстовые кнопки меню
    app.add_handler(MessageHandler(
        filters.TEXT & filters.Regex(r"^(📊|📝|❓|⚙️|📋|🔄|🏪|🔍|🎓|📜)"),
        handle_menu_button,
    ))

    # Lifecycle
    async def post_init(application):
        # Always start scheduler for sync, auto-reply is controlled by settings
        await processor.start_scheduler()

    async def post_shutdown(application):
        from wb_api import close_all_clients
        await close_all_clients()
        await ai_engine.close()
        logger.info("Sessions closed")

    app.post_init = post_init
    app.post_shutdown = post_shutdown

    logger.info("Bot starting...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
