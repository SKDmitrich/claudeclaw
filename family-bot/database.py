"""
База данных — SQLite для хранения кабинетов, отзывов, ответов, статистики
"""
import sqlite3
import json
import hashlib
from datetime import datetime, timedelta
from config import DB_PATH, WB_API_KEY


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS cabinets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            api_key TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            added_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            wb_id TEXT,
            cabinet_id INTEGER REFERENCES cabinets(id),
            product_name TEXT,
            product_id TEXT,
            user_name TEXT,
            rating INTEGER,
            text TEXT,
            photos TEXT DEFAULT '[]',
            created_at TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            reply_text TEXT,
            reply_status TEXT DEFAULT 'pending',
            reply_sent_at TEXT,
            ai_generated INTEGER DEFAULT 0,
            sentiment TEXT,
            keywords TEXT DEFAULT '[]',
            category TEXT DEFAULT '',
            needs_review INTEGER DEFAULT 0,
            review_flag_reason TEXT DEFAULT '',
            UNIQUE(wb_id, cabinet_id)
        );

        CREATE TABLE IF NOT EXISTS questions (
            id TEXT PRIMARY KEY,
            wb_id TEXT,
            cabinet_id INTEGER REFERENCES cabinets(id),
            product_name TEXT,
            product_id TEXT,
            question_text TEXT,
            created_at TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            answer_text TEXT,
            answer_status TEXT DEFAULT 'pending',
            answer_sent_at TEXT,
            ai_generated INTEGER DEFAULT 0,
            UNIQUE(wb_id, cabinet_id)
        );

        CREATE TABLE IF NOT EXISTS keyword_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cabinet_id INTEGER REFERENCES cabinets(id),
            keyword TEXT NOT NULL,
            match_type TEXT DEFAULT 'contains',
            rating_filter TEXT DEFAULT 'any',
            action TEXT DEFAULT 'template',
            response_template TEXT,
            priority INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            role TEXT DEFAULT 'viewer',
            permissions TEXT DEFAULT '{}',
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cabinet_id INTEGER,
            action TEXT,
            details TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(reply_status);
        CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
        CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);
        CREATE INDEX IF NOT EXISTS idx_reviews_cabinet ON reviews(cabinet_id);
        CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(answer_status);
        CREATE INDEX IF NOT EXISTS idx_questions_cabinet ON questions(cabinet_id);
    """)
    conn.commit()
    conn.close()

    _ensure_default_cabinet()


def _ensure_default_cabinet():
    """Если есть WB_API_KEY в .env и нет кабинетов -- создать дефолтный"""
    if not WB_API_KEY:
        return
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM cabinets").fetchone()[0]
    if count == 0:
        conn.execute(
            "INSERT INTO cabinets (name, api_key, added_by) VALUES (?, ?, ?)",
            ("Default", WB_API_KEY, 0)
        )
        conn.commit()
    conn.close()


# === Cabinets ===

def add_cabinet(name: str, api_key: str, added_by: int = 0) -> int:
    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO cabinets (name, api_key, added_by) VALUES (?, ?, ?)",
        (name, api_key, added_by)
    )
    conn.commit()
    cab_id = cursor.lastrowid
    conn.close()
    return cab_id


def get_cabinets(active_only: bool = True) -> list:
    conn = get_db()
    query = "SELECT * FROM cabinets"
    if active_only:
        query += " WHERE is_active = 1"
    query += " ORDER BY id"
    rows = conn.execute(query).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_cabinet(cabinet_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM cabinets WHERE id = ?", (cabinet_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_cabinet(cabinet_id: int, **kwargs):
    conn = get_db()
    for key, value in kwargs.items():
        if key in ("name", "api_key", "is_active"):
            conn.execute(f"UPDATE cabinets SET {key} = ? WHERE id = ?", (value, cabinet_id))
    conn.commit()
    conn.close()


def delete_cabinet(cabinet_id: int):
    conn = get_db()
    conn.execute("DELETE FROM keyword_rules WHERE cabinet_id = ?", (cabinet_id,))
    conn.execute("DELETE FROM questions WHERE cabinet_id = ?", (cabinet_id,))
    conn.execute("DELETE FROM reviews WHERE cabinet_id = ?", (cabinet_id,))
    conn.execute("DELETE FROM activity_log WHERE cabinet_id = ?", (cabinet_id,))
    conn.execute("DELETE FROM cabinets WHERE id = ?", (cabinet_id,))
    conn.commit()
    conn.close()


def get_cabinet_stats_summary() -> list:
    """Краткая статистика по каждому кабинету"""
    conn = get_db()
    rows = conn.execute("""
        SELECT c.id, c.name, c.is_active,
            (SELECT COUNT(*) FROM reviews WHERE cabinet_id = c.id AND reply_status = 'pending') as pending_reviews,
            (SELECT COUNT(*) FROM questions WHERE cabinet_id = c.id AND answer_status = 'pending') as pending_questions,
            (SELECT COUNT(*) FROM reviews WHERE cabinet_id = c.id AND reply_status = 'sent') as sent_reviews
        FROM cabinets c ORDER BY c.id
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# === Reviews ===

def save_review(review: dict, cabinet_id: int) -> bool:
    conn = get_db()
    product_name = review.get("product_name", "")
    category = detect_category(product_name)
    try:
        cursor = conn.execute("""
            INSERT OR IGNORE INTO reviews
            (id, wb_id, cabinet_id, product_name, product_id, user_name, rating, text, photos, created_at, sentiment, keywords, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            f"{cabinet_id}_{review['id']}", review.get("wb_id", review["id"]),
            cabinet_id,
            product_name, review.get("product_id", ""),
            review.get("user_name", "Покупатель"), review.get("rating", 0),
            review.get("text", ""), json.dumps(review.get("photos", [])),
            review.get("created_at", ""), review.get("sentiment", ""),
            json.dumps(review.get("keywords", [])), category
        ))
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def get_pending_reviews(limit=20, cabinet_id: int | None = None) -> list:
    conn = get_db()
    query = """
        SELECT r.*, c.name as cabinet_name
        FROM reviews r
        LEFT JOIN cabinets c ON r.cabinet_id = c.id
        WHERE r.reply_status = 'pending'
    """
    params = []
    if cabinet_id is not None:
        query += " AND r.cabinet_id = ?"
        params.append(cabinet_id)
    query += " ORDER BY r.created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_review(review_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("""
        SELECT r.*, c.name as cabinet_name
        FROM reviews r
        LEFT JOIN cabinets c ON r.cabinet_id = c.id
        WHERE r.id = ?
    """, (review_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_review_reply(review_id: str, reply_text: str, status: str = "approved", ai: bool = False):
    conn = get_db()
    conn.execute("""
        UPDATE reviews SET reply_text = ?, reply_status = ?, ai_generated = ?
        WHERE id = ?
    """, (reply_text, status, int(ai), review_id))
    conn.commit()
    conn.close()


def mark_review_sent(review_id: str):
    conn = get_db()
    conn.execute("""
        UPDATE reviews SET reply_status = 'sent', reply_sent_at = ? WHERE id = ?
    """, (datetime.now().isoformat(), review_id))
    conn.commit()
    conn.close()


def mark_review_skipped(review_id: str):
    conn = get_db()
    conn.execute("UPDATE reviews SET reply_status = 'skipped' WHERE id = ?", (review_id,))
    conn.commit()
    conn.close()


def flag_review_for_check(review_id: str, reason: str):
    conn = get_db()
    conn.execute("UPDATE reviews SET needs_review = 1, review_flag_reason = ? WHERE id = ?", (reason, review_id))
    conn.commit()
    conn.close()


def check_stop_words(text: str) -> str | None:
    """Check if text contains any stop words. Returns matched word or None."""
    from config import load_settings
    settings = load_settings()
    stop_words = settings.get("stop_words", [])
    if not stop_words or not text:
        return None
    text_lower = text.lower()
    for word in stop_words:
        if word.lower() in text_lower:
            return word
    return None


def clear_review_flag(review_id: str):
    conn = get_db()
    conn.execute("UPDATE reviews SET needs_review = 0, review_flag_reason = '' WHERE id = ?", (review_id,))
    conn.commit()
    conn.close()


# === Questions ===

def save_question(question: dict, cabinet_id: int) -> bool:
    conn = get_db()
    try:
        cursor = conn.execute("""
            INSERT OR IGNORE INTO questions
            (id, wb_id, cabinet_id, product_name, product_id, question_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            f"{cabinet_id}_{question['id']}", question.get("wb_id", question["id"]),
            cabinet_id,
            question.get("product_name", ""), question.get("product_id", ""),
            question.get("question_text", ""), question.get("created_at", "")
        ))
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def get_pending_questions(limit=20, cabinet_id: int | None = None) -> list:
    conn = get_db()
    query = """
        SELECT q.*, c.name as cabinet_name
        FROM questions q
        LEFT JOIN cabinets c ON q.cabinet_id = c.id
        WHERE q.answer_status = 'pending'
    """
    params = []
    if cabinet_id is not None:
        query += " AND q.cabinet_id = ?"
        params.append(cabinet_id)
    query += " ORDER BY q.created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_question(q_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("""
        SELECT q.*, c.name as cabinet_name
        FROM questions q
        LEFT JOIN cabinets c ON q.cabinet_id = c.id
        WHERE q.id = ?
    """, (q_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_question_answer(q_id: str, answer: str, status: str = "approved", ai: bool = False):
    conn = get_db()
    conn.execute("""
        UPDATE questions SET answer_text = ?, answer_status = ?, ai_generated = ?
        WHERE id = ?
    """, (answer, status, int(ai), q_id))
    conn.commit()
    conn.close()


def mark_question_sent(q_id: str):
    conn = get_db()
    conn.execute("""
        UPDATE questions SET answer_status = 'sent', answer_sent_at = ? WHERE id = ?
    """, (datetime.now().isoformat(), q_id))
    conn.commit()
    conn.close()


# === Keyword Rules ===

def get_keyword_rules(enabled_only=True, cabinet_id: int | None = None) -> list:
    conn = get_db()
    conditions = []
    params = []
    if enabled_only:
        conditions.append("enabled = 1")
    if cabinet_id is not None:
        conditions.append("(cabinet_id = ? OR cabinet_id IS NULL)")
        params.append(cabinet_id)
    query = "SELECT * FROM keyword_rules"
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY priority DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_keyword_rule(keyword: str, match_type: str = "contains",
                     rating_filter: str = "any", action: str = "template",
                     response_template: str = "", priority: int = 0,
                     cabinet_id: int | None = None) -> int:
    conn = get_db()
    cursor = conn.execute("""
        INSERT INTO keyword_rules (keyword, match_type, rating_filter, action, response_template, priority, cabinet_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (keyword, match_type, rating_filter, action, response_template, priority, cabinet_id))
    conn.commit()
    rule_id = cursor.lastrowid
    conn.close()
    return rule_id


def delete_keyword_rule(rule_id: int):
    conn = get_db()
    conn.execute("DELETE FROM keyword_rules WHERE id = ?", (rule_id,))
    conn.commit()
    conn.close()


def toggle_keyword_rule(rule_id: int, enabled: bool):
    conn = get_db()
    conn.execute("UPDATE keyword_rules SET enabled = ? WHERE id = ?", (int(enabled), rule_id))
    conn.commit()
    conn.close()


# === Analytics ===

def get_stats(days: int = 7, cabinet_id: int | None = None, category: str | None = None,
              date_from: str | None = None, date_to: str | None = None) -> dict:
    conn = get_db()
    if date_from:
        since = date_from
    else:
        since = (datetime.now() - timedelta(days=days)).isoformat()

    # Filters for reviews (supports category)
    rev_filter = ""
    rev_params = []
    # Filters for questions (no category column)
    q_filter = ""
    q_params = []
    if cabinet_id is not None:
        rev_filter += " AND cabinet_id = ?"
        rev_params.append(cabinet_id)
        q_filter += " AND cabinet_id = ?"
        q_params.append(cabinet_id)
    if category:
        rev_filter += " AND category = ?"
        rev_params.append(category)
    if date_to:
        rev_filter += " AND created_at <= ?"
        rev_params.append(date_to + "T23:59:59")
        q_filter += " AND created_at <= ?"
        q_params.append(date_to + "T23:59:59")

    total = conn.execute(
        f"SELECT COUNT(*) FROM reviews WHERE created_at >= ?{rev_filter}",
        [since] + rev_params
    ).fetchone()[0]

    by_rating = {}
    for row in conn.execute(
        f"SELECT rating, COUNT(*) as cnt FROM reviews WHERE created_at >= ?{rev_filter} GROUP BY rating",
        [since] + rev_params
    ).fetchall():
        by_rating[row["rating"]] = row["cnt"]

    avg_rating = conn.execute(
        f"SELECT AVG(rating) FROM reviews WHERE created_at >= ? AND rating > 0{rev_filter}",
        [since] + rev_params
    ).fetchone()[0] or 0

    sent = conn.execute(
        f"SELECT COUNT(*) FROM reviews WHERE reply_status = 'sent' AND reply_sent_at >= ?{rev_filter}",
        [since] + rev_params
    ).fetchone()[0]

    auto = conn.execute(
        f"SELECT COUNT(*) FROM reviews WHERE ai_generated = 1 AND reply_sent_at >= ?{rev_filter}",
        [since] + rev_params
    ).fetchone()[0]

    questions = conn.execute(
        f"SELECT COUNT(*) FROM questions WHERE created_at >= ?{q_filter}",
        [since] + q_params
    ).fetchone()[0]

    questions_answered = conn.execute(
        f"SELECT COUNT(*) FROM questions WHERE answer_status = 'sent' AND answer_sent_at >= ?{q_filter}",
        [since] + q_params
    ).fetchone()[0]

    by_sentiment = {}
    for row in conn.execute(
        f"SELECT sentiment, COUNT(*) as cnt FROM reviews WHERE created_at >= ? AND sentiment != ''{rev_filter} GROUP BY sentiment",
        [since] + rev_params
    ).fetchall():
        by_sentiment[row["sentiment"]] = row["cnt"]

    pending_reviews = conn.execute(
        f"SELECT COUNT(*) FROM reviews WHERE reply_status = 'pending'{rev_filter}",
        rev_params
    ).fetchone()[0]

    pending_questions = conn.execute(
        f"SELECT COUNT(*) FROM questions WHERE answer_status = 'pending'{q_filter}",
        q_params
    ).fetchone()[0]

    conn.close()
    return {
        "period_days": days,
        "total_reviews": total,
        "by_rating": by_rating,
        "avg_rating": round(avg_rating, 2),
        "replies_sent": sent,
        "auto_replies": auto,
        "total_questions": questions,
        "questions_answered": questions_answered,
        "by_sentiment": by_sentiment,
        "pending_reviews": pending_reviews,
        "pending_questions": pending_questions,
    }


# === Product Analytics ===

def get_products_with_reviews(cabinet_id: int, days: int, category: str | None = None) -> list:
    """Список артикулов с количеством отзывов за период"""
    conn = get_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    flt = ""
    params = [cabinet_id, since]
    if category:
        flt = " AND category = ?"
        params.append(category)
    rows = conn.execute(f"""
        SELECT product_id, product_name,
            COUNT(*) as review_count,
            AVG(rating) as avg_rating,
            SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) as negative_count,
            SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive_count
        FROM reviews
        WHERE cabinet_id = ? AND created_at >= ? AND product_id != ''{flt}
        GROUP BY product_id
        ORDER BY review_count DESC
    """, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


CATEGORY_RULES = [
    ("Жилет", ["жилет", "жилетка"]),
    ("Куртка", ["куртка"]),
    ("Юбка", ["юбка"]),
    ("Шорты", ["шорты"]),
]


def detect_category(product_name: str) -> str:
    lower = product_name.lower()
    for category, keywords in CATEGORY_RULES:
        if any(kw in lower for kw in keywords):
            return category
    return "Другое"


def get_categories(days: int = 90, cabinet_id: int | None = None) -> list[str]:
    """Distinct product categories"""
    conn = get_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    flt = ""
    params = [since]
    if cabinet_id is not None:
        flt += " AND cabinet_id = ?"
        params.append(cabinet_id)
    rows = conn.execute(
        f"SELECT DISTINCT category FROM reviews WHERE created_at >= ? AND category != ''{flt} ORDER BY category",
        params
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def get_top_products_by_reviews(days: int = 7, limit: int = 5, cabinet_id: int | None = None, category: str | None = None) -> dict:
    """Top products by positive and negative reviews"""
    conn = get_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    flt = ""
    params_base = [since]
    if cabinet_id is not None:
        flt += " AND cabinet_id = ?"
        params_base.append(cabinet_id)
    if category:
        flt += " AND category = ?"
        params_base.append(category)
    positive = conn.execute(f"""
        SELECT product_id, product_name,
            SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as count,
            AVG(rating) as avg_rating
        FROM reviews
        WHERE created_at >= ? AND product_id != '' AND rating >= 4{flt}
        GROUP BY product_id
        ORDER BY count DESC
        LIMIT ?
    """, params_base + [limit]).fetchall()
    negative = conn.execute(f"""
        SELECT product_id, product_name,
            SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) as count,
            AVG(rating) as avg_rating
        FROM reviews
        WHERE created_at >= ? AND product_id != '' AND rating <= 3{flt}
        GROUP BY product_id
        ORDER BY count DESC
        LIMIT ?
    """, params_base + [limit]).fetchall()
    conn.close()
    return {
        "positive": [dict(r) for r in positive],
        "negative": [dict(r) for r in negative],
    }


def get_sent_review_examples(limit: int = 20) -> list:
    """Get sent reviews with text as training examples for AI, diverse by rating"""
    conn = get_db()
    examples = []
    # Get examples across different ratings for diversity
    for rating in [5, 4, 3, 2, 1]:
        rows = conn.execute("""
            SELECT rating, text, reply_text
            FROM reviews
            WHERE reply_status = 'sent' AND text != '' AND reply_text != ''
                AND rating = ?
            ORDER BY reply_sent_at DESC
            LIMIT ?
        """, (rating, max(1, limit // 5))).fetchall()
        for r in rows:
            examples.append({
                "rating": r["rating"],
                "review_text": r["text"],
                "reply_text": r["reply_text"],
            })
    conn.close()
    return examples


def get_reviews_for_product(cabinet_id: int, product_id: str, days: int) -> list:
    """Все отзывы по конкретному артикулу за период"""
    conn = get_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute("""
        SELECT rating, text, user_name, sentiment, created_at
        FROM reviews
        WHERE cabinet_id = ? AND product_id = ? AND created_at >= ?
        ORDER BY created_at DESC
    """, (cabinet_id, product_id, since)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# === Activity Log ===

def log_activity(action: str, details: str = "", cabinet_id: int | None = None):
    conn = get_db()
    conn.execute(
        "INSERT INTO activity_log (action, details, cabinet_id) VALUES (?, ?, ?)",
        (action, details, cabinet_id)
    )
    conn.commit()
    conn.close()


def get_recent_activity(limit: int = 20) -> list:
    conn = get_db()
    rows = conn.execute("""
        SELECT a.*, c.name as cabinet_name
        FROM activity_log a
        LEFT JOIN cabinets c ON a.cabinet_id = c.id
        ORDER BY a.created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# === Users ===

def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def add_user(username: str, password: str, display_name: str = "", role: str = "viewer",
             email: str = "", permissions: str = "{}") -> int:
    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO users (username, password_hash, display_name, role, email, permissions) VALUES (?, ?, ?, ?, ?, ?)",
        (username, _hash_password(password), display_name or username, role, email, permissions)
    )
    conn.commit()
    uid = cursor.lastrowid
    conn.close()
    return uid


def get_users() -> list:
    conn = get_db()
    rows = conn.execute("SELECT id, username, email, display_name, role, permissions, is_active, created_at FROM users ORDER BY id").fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["permissions"] = json.loads(d.get("permissions") or "{}")
        except Exception:
            d["permissions"] = {}
        result.append(d)
    return result


def get_user(user_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def verify_user(username: str, password: str) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE username = ? AND password_hash = ? AND is_active = 1",
        (username, _hash_password(password))
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def update_user(user_id: int, **kwargs):
    conn = get_db()
    for key, value in kwargs.items():
        if key == "password":
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hash_password(value), user_id))
        elif key in ("username", "display_name", "role", "is_active", "email", "permissions"):
            conn.execute(f"UPDATE users SET {key} = ? WHERE id = ?", (value, user_id))
    conn.commit()
    conn.close()


def delete_user(user_id: int):
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
