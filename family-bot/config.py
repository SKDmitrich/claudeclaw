"""
Конфигурация WB Review Bot
"""
import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# === Telegram ===
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

# === Wildberries API ===
WB_API_KEY = os.getenv("WB_API_KEY", "")
WB_API_BASE = "https://feedbacks-api.wildberries.ru"

# === AI (OpenAI-compatible) ===
AI_API_KEY = os.getenv("AI_API_KEY", "")
AI_API_BASE = os.getenv("AI_API_BASE", "https://api.openai.com/v1")
AI_MODEL = os.getenv("AI_MODEL", "gpt-4o-mini")

# === Пути ===
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "bot.db"
TEMPLATES_PATH = DATA_DIR / "templates.json"
SETTINGS_PATH = DATA_DIR / "settings.json"
TRAINING_PATH = DATA_DIR / "training_examples.json"

# === Дефолтные настройки ===
DEFAULT_SETTINGS = {
    "auto_reply_enabled": False,
    "auto_reply_positive": True,       # автоответ на 4-5 звёзд
    "auto_reply_negative": False,      # автоответ на 1-3 звёзды (осторожно)
    "auto_reply_questions": True,      # автоответ на вопросы
    "check_interval_minutes": 15,      # интервал проверки
    "ai_enabled": True,                # использовать AI для генерации
    "ai_tone": "friendly",             # тон: friendly, formal, casual, custom
    "ai_custom_prompt": "",            # кастомная инструкция для AI (при tone=custom)
    "ai_max_length": 500,              # макс длина ответа
    "notify_new_reviews": True,        # уведомления о новых отзывах
    "notify_new_questions": True,      # уведомления о новых вопросах
    "require_approval": True,          # требовать одобрение перед отправкой
    "keyword_rules": [],               # правила по ключевым словам
    "product_knowledge": {},           # база знаний по товарам
}

# === Шаблоны по умолчанию ===
DEFAULT_TEMPLATES = {
    "positive_5": [
        "Спасибо за отличный отзыв, {name}! Мы рады, что вам понравился {product}! 🌟",
        "Благодарим за оценку! Очень приятно, что {product} оправдал ваши ожидания! ❤️",
        "{name}, спасибо за 5 звёзд! Будем рады видеть вас снова! 🙏",
    ],
    "positive_4": [
        "Спасибо за отзыв, {name}! Рады, что {product} вам понравился!",
        "Благодарим за хорошую оценку! Если есть пожелания — мы всегда открыты! 😊",
    ],
    "negative_3": [
        "{name}, благодарим за обратную связь! Подскажите, что мы могли бы улучшить?",
        "Спасибо за отзыв! Нам важно ваше мнение — постараемся стать лучше! 🙏",
    ],
    "negative_2": [
        "{name}, нам очень жаль, что {product} не оправдал ожиданий. Расскажите подробнее — мы разберёмся!",
        "Приносим извинения за неудобства! Мы обязательно учтём ваш отзыв. 🙏",
    ],
    "negative_1": [
        "{name}, очень сожалеем! Пожалуйста, опишите проблему — мы постараемся помочь!",
        "Нам очень жаль. Мы ценим вашу обратную связь и примем меры! 🙏",
    ],
    "question": [
        "Здравствуйте! Спасибо за вопрос. {ai_answer}",
        "Добрый день! {ai_answer} Если остались вопросы — пишите! 😊",
    ],
}


def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
            return {**DEFAULT_SETTINGS, **saved}
    return DEFAULT_SETTINGS.copy()


def save_settings(settings: dict):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)


def load_templates() -> dict:
    if TEMPLATES_PATH.exists():
        with open(TEMPLATES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_TEMPLATES.copy()


def save_templates(templates: dict):
    with open(TEMPLATES_PATH, "w", encoding="utf-8") as f:
        json.dump(templates, f, ensure_ascii=False, indent=2)


def load_training_examples() -> list:
    if TRAINING_PATH.exists():
        with open(TRAINING_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_training_examples(examples: list):
    with open(TRAINING_PATH, "w", encoding="utf-8") as f:
        json.dump(examples, f, ensure_ascii=False, indent=2)
