"""
WB Review Bot — Web Dashboard (FastAPI)
Работает параллельно с Telegram ботом на той же БД.
"""
import os
import secrets
import asyncio
import logging
import uvicorn

logger = logging.getLogger(__name__)
from pathlib import Path
from fastapi import FastAPI, Request, Form, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from config import load_settings, save_settings
from database import (
    init_db, get_stats, get_pending_reviews, get_pending_questions,
    get_review, get_question, update_review_reply, update_question_answer,
    mark_review_sent, mark_review_skipped, mark_question_sent,
    get_cabinets, get_cabinet, add_cabinet, update_cabinet, delete_cabinet,
    get_cabinet_stats_summary, get_recent_activity, log_activity,
    get_products_with_reviews, get_reviews_for_product, get_top_products_by_reviews, get_categories,
    get_users, get_user, add_user, update_user, delete_user, verify_user,
    get_rating_decline_products,
)
from wb_api import WBClient, get_wb_client
from ai_engine import ai_engine
from processor import processor

BASE_DIR = Path(__file__).parent

# === Auth ===
security = HTTPBasic()
WEB_USER = os.getenv("WEB_USER", "admin")
WEB_PASS = os.getenv("WEB_PASS", "")


def verify_auth(credentials: HTTPBasicCredentials = Depends(security)):
    if not WEB_PASS:
        return credentials
    # Try database users first
    db_user = verify_user(credentials.username, credentials.password)
    if db_user:
        return credentials
    # Fallback to env vars
    user_ok = secrets.compare_digest(credentials.username.encode(), WEB_USER.encode())
    pass_ok = secrets.compare_digest(credentials.password.encode(), WEB_PASS.encode())
    if not (user_ok and pass_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials


app = FastAPI(title="WB Review Bot", dependencies=[Depends(verify_auth)])
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


# =============================================
# PAGES
# =============================================

@app.get("/", response_class=HTMLResponse)
async def page_dashboard(request: Request, days: int = 14, cab: int | None = None, category: str | None = None,
                         date_from: str | None = None, date_to: str | None = None):
    from urllib.parse import urlencode
    if not date_from and days not in (7, 14, 30, 90, 180, 365):
        days = 14
    cab_id = cab if cab else None
    cat = category if category else None
    stats = get_stats(days, cabinet_id=cab_id, category=cat, date_from=date_from, date_to=date_to)
    cabinets = get_cabinets(active_only=False)
    cabinet_stats = get_cabinet_stats_summary()
    activity = get_recent_activity(10)

    # Last sync time
    from database import get_db as _get_db
    _conn = _get_db()
    _row = _conn.execute("SELECT created_at FROM activity_log WHERE action = 'fetch' ORDER BY id DESC LIMIT 1").fetchone()
    last_sync = _row["created_at"][:16].replace("T", " ") if _row else None
    if not last_sync:
        _row2 = _conn.execute("SELECT MAX(fetched_at) as ft FROM reviews").fetchone()
        last_sync = _row2["ft"][:16].replace("T", " ") if _row2 and _row2["ft"] else None
    _conn.close()
    top_products = get_top_products_by_reviews(days, cabinet_id=cab_id, category=cat)
    categories = get_categories(days=max(days, 90), cabinet_id=cab_id)
    rating_decline = get_rating_decline_products(cabinet_id=cab_id)

    # Helper to build URLs preserving current filters
    current_params = {"days": days}
    if cab_id:
        current_params["cab"] = cab_id
    if cat:
        current_params["category"] = cat
    if date_from:
        current_params["date_from"] = date_from
        current_params["date_to"] = date_to

    def build_url(**overrides):
        params = dict(current_params)
        for k, v in overrides.items():
            if v is None:
                params.pop(k, None)
            else:
                params[k] = v
        # If switching to preset days, remove custom dates
        if "days" in overrides:
            params.pop("date_from", None)
            params.pop("date_to", None)
        qs = urlencode(params)
        return f"/?{qs}" if qs else "/"

    return templates.TemplateResponse("dashboard.html", {
        "request": request, "active": "dashboard",
        "stats": stats, "cabinets": cabinets,
        "cabinet_stats": cabinet_stats, "activity": activity,
        "top_products": top_products, "days": days,
        "categories": categories, "current_cab": cab_id, "current_category": cat,
        "buildUrl": build_url, "date_from": date_from, "date_to": date_to,
        "last_sync": last_sync, "rating_decline": rating_decline,
    })


@app.get("/ai-analyst", response_class=HTMLResponse)
async def page_ai_analyst(request: Request):
    stats = get_stats(14)
    cabinets = get_cabinets(active_only=False)
    categories = get_categories(days=90)
    return templates.TemplateResponse("ai_analyst.html", {
        "request": request, "active": "ai-analyst",
        "stats": stats, "cabinets": cabinets, "categories": categories,
    })


@app.get("/reviews", response_class=HTMLResponse)
async def page_reviews(request: Request, status: str = "pending", rating: str | None = None):
    from database import get_db
    conn = get_db()
    rating_filter = ""
    params = []
    rating_list = []
    if rating:
        rating_list = [int(r) for r in rating.split(",") if r.isdigit() and 1 <= int(r) <= 5]
    if rating_list:
        placeholders = ",".join("?" * len(rating_list))
        rating_filter = f" AND r.rating IN ({placeholders})"
        params = rating_list

    if status == "pending":
        rows = conn.execute(f"""
            SELECT r.*, c.name as cabinet_name FROM reviews r
            LEFT JOIN cabinets c ON r.cabinet_id = c.id
            WHERE r.reply_status = 'pending'{rating_filter}
            ORDER BY r.needs_review DESC, r.created_at DESC LIMIT 50
        """, params).fetchall()
    elif status == "flagged":
        rows = conn.execute(f"""
            SELECT r.*, c.name as cabinet_name FROM reviews r
            LEFT JOIN cabinets c ON r.cabinet_id = c.id
            WHERE r.needs_review = 1 AND r.reply_status = 'pending'{rating_filter}
            ORDER BY r.created_at DESC LIMIT 50
        """, params).fetchall()
    elif status == "sent":
        rows = conn.execute(f"""
            SELECT r.*, c.name as cabinet_name FROM reviews r
            LEFT JOIN cabinets c ON r.cabinet_id = c.id
            WHERE r.reply_status = 'sent'{rating_filter}
            ORDER BY r.reply_sent_at DESC LIMIT 50
        """, params).fetchall()
    else:
        rows = conn.execute(f"""
            SELECT r.*, c.name as cabinet_name FROM reviews r
            LEFT JOIN cabinets c ON r.cabinet_id = c.id
            WHERE 1=1{rating_filter}
            ORDER BY r.created_at DESC LIMIT 50
        """, params).fetchall()

    flagged_count = conn.execute(
        "SELECT COUNT(*) FROM reviews WHERE needs_review = 1 AND reply_status = 'pending'"
    ).fetchone()[0]

    conn.close()
    reviews = [dict(r) for r in rows]
    return templates.TemplateResponse("reviews.html", {
        "request": request, "active": "reviews",
        "reviews": reviews, "status": status, "current_ratings": rating_list,
        "flagged_count": flagged_count,
    })


@app.get("/questions", response_class=HTMLResponse)
async def page_questions(request: Request):
    questions = get_pending_questions(50)
    return templates.TemplateResponse("questions.html", {
        "request": request, "active": "questions",
        "questions": questions,
    })


@app.get("/cabinets", response_class=HTMLResponse)
async def page_cabinets(request: Request):
    cabinets = get_cabinet_stats_summary()
    return templates.TemplateResponse("cabinets.html", {
        "request": request, "active": "cabinets",
        "cabinets": cabinets,
    })


@app.get("/settings", response_class=HTMLResponse)
async def page_settings(request: Request):
    settings = load_settings()
    return templates.TemplateResponse("settings.html", {
        "request": request, "active": "settings",
        "settings": settings,
    })


@app.get("/help", response_class=HTMLResponse)
async def page_help(request: Request):
    return templates.TemplateResponse("help.html", {"request": request, "active": "help"})


@app.get("/users", response_class=HTMLResponse)
async def page_users(request: Request):
    users = get_users()
    return templates.TemplateResponse("users.html", {
        "request": request, "active": "users",
        "users": users, "all_permissions": ALL_PERMISSIONS,
    })


@app.get("/analysis", response_class=HTMLResponse)
async def page_analysis(request: Request, cabinet_id: int = 0, days: int = 30, category: str | None = None,
                        date_from: str | None = None, date_to: str | None = None):
    cabinets = get_cabinets(active_only=True)
    products = []
    selected_cabinet = cabinet_id or (cabinets[0]["id"] if cabinets else 0)
    if selected_cabinet:
        products = get_products_with_reviews(selected_cabinet, days, category=category)
    categories_list = get_categories(days=max(days, 90), cabinet_id=selected_cabinet or None)
    return templates.TemplateResponse("analysis.html", {
        "request": request, "active": "analysis",
        "cabinets": cabinets, "products": products,
        "selected_cabinet": selected_cabinet, "selected_days": days,
        "categories": categories_list, "selected_category": category,
        "date_from": date_from, "date_to": date_to,
    })


# =============================================
# API ENDPOINTS
# =============================================

@app.post("/api/check-now")
async def api_check_now(request: Request):
    accept = request.headers.get("accept", "")
    stats = await processor.fetch_and_process()
    if "application/json" in accept:
        return JSONResponse(stats)
    return RedirectResponse("/?flash=checked", status_code=303)


@app.post("/api/settings")
async def api_save_settings(request: Request):
    form = await request.form()
    settings = load_settings()

    bool_fields = [
        "auto_reply_enabled", "auto_reply_questions", "require_approval", "ai_enabled",
        "notify_new_reviews", "notify_new_questions",
        "auto_reply_only_with_text", "auto_reply_skip_with_photos",
    ]
    for f in bool_fields:
        settings[f] = f in form

    # Per-rating auto-reply settings
    active_ratings = []
    for r in range(1, 6):
        if f"auto_reply_rating_{r}" in form:
            active_ratings.append(r)
    settings["auto_reply_ratings"] = active_ratings
    # Keep legacy fields in sync for backward compatibility
    settings["auto_reply_positive"] = any(r >= 4 for r in active_ratings)
    settings["auto_reply_negative"] = any(r <= 3 for r in active_ratings)

    settings["auto_reply_min_text_length"] = int(form.get("auto_reply_min_text_length", 0))
    settings["ai_tone"] = form.get("ai_tone", "friendly")
    settings["ai_custom_prompt"] = form.get("ai_custom_prompt", "")
    settings["ai_max_length"] = int(form.get("ai_max_length", 500))
    settings["check_interval_minutes"] = int(form.get("check_interval_minutes", 15))

    stop_words_raw = form.get("stop_words", "")
    settings["stop_words"] = [w.strip().lower() for w in stop_words_raw.split(",") if w.strip()]

    save_settings(settings)
    log_activity("settings", "Настройки обновлены через веб")
    return RedirectResponse("/settings?flash=saved", status_code=303)


# --- Reviews (bulk routes MUST come before {review_id} routes) ---

@app.post("/api/reviews/bulk/generate")
async def api_bulk_generate(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    results = {"ok": 0, "errors": 0}
    for rid in ids:
        review = get_review(rid)
        if not review:
            results["errors"] += 1
            continue
        try:
            reply = await ai_engine.generate_review_reply(review)
            if reply:
                update_review_reply(rid, reply, status="pending", ai=True)
                results["ok"] += 1
            else:
                results["errors"] += 1
        except Exception:
            results["errors"] += 1
    return JSONResponse(results)


@app.post("/api/reviews/bulk/send")
async def api_bulk_send(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    results = {"ok": 0, "errors": 0}
    for rid in ids:
        try:
            success = await processor.approve_and_send_review(rid)
            if success:
                results["ok"] += 1
            else:
                results["errors"] += 1
        except Exception:
            results["errors"] += 1
    return JSONResponse(results)


@app.post("/api/reviews/{review_id}/approve-flag")
async def api_approve_flag(review_id: str):
    from database import clear_review_flag
    clear_review_flag(review_id)
    return RedirectResponse("/reviews?status=flagged", status_code=303)


@app.post("/api/reviews/{review_id}/send")
async def api_send_review(review_id: str):
    from database import clear_review_flag
    clear_review_flag(review_id)
    success = await processor.approve_and_send_review(review_id)
    return RedirectResponse("/reviews", status_code=303)


@app.post("/api/reviews/{review_id}/skip")
async def api_skip_review(review_id: str):
    mark_review_skipped(review_id)
    return RedirectResponse("/reviews", status_code=303)


@app.post("/api/reviews/{review_id}/reply")
async def api_reply_review(review_id: str, reply_text: str = Form(...)):
    update_review_reply(review_id, reply_text.strip(), status="pending", ai=False)
    return RedirectResponse("/reviews", status_code=303)


@app.post("/api/reviews/{review_id}/generate")
async def api_generate_review(review_id: str):
    from database import flag_review_for_check, check_stop_words
    review = get_review(review_id)
    if not review:
        return JSONResponse({"error": "not found"}, 404)

    flagged = False
    # Check stop words first
    stop_word = check_stop_words(review.get("text", ""))
    if stop_word:
        flag_review_for_check(review_id, f'Стоп-слово: "{stop_word}"')
        flagged = True

    reply = await ai_engine.generate_review_reply(review)
    if reply:
        update_review_reply(review_id, reply, status="pending", ai=True)

    # Check for rating/sentiment mismatch (only if not already flagged)
    if not flagged:
        mismatch = await ai_engine.check_rating_mismatch(review)
        if mismatch.get("mismatch"):
            flag_review_for_check(review_id, mismatch["reason"])
            flagged = True

    return JSONResponse({"ok": True, "reply": reply, "flagged": flagged})


# --- Questions ---

@app.post("/api/questions/bulk/generate")
async def api_bulk_generate_questions(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    results = {"ok": 0, "errors": 0}
    for qid in ids:
        q = get_question(qid)
        if not q:
            results["errors"] += 1
            continue
        try:
            reply = await ai_engine.generate_question_reply(q)
            if reply:
                update_question_answer(qid, reply, status="pending", ai=True)
                results["ok"] += 1
            else:
                results["errors"] += 1
        except Exception:
            results["errors"] += 1
    return JSONResponse(results)


@app.post("/api/questions/bulk/send")
async def api_bulk_send_questions(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    results = {"ok": 0, "errors": 0}
    for qid in ids:
        try:
            success = await processor.approve_and_send_question(qid)
            if success:
                results["ok"] += 1
            else:
                results["errors"] += 1
        except Exception:
            results["errors"] += 1
    return JSONResponse(results)


@app.post("/api/questions/{q_id}/send")
async def api_send_question(q_id: str):
    await processor.approve_and_send_question(q_id)
    return RedirectResponse("/questions", status_code=303)


@app.post("/api/questions/{q_id}/reply")
async def api_reply_question(q_id: str, answer_text: str = Form(...)):
    update_question_answer(q_id, answer_text.strip(), status="pending", ai=False)
    return RedirectResponse("/questions", status_code=303)


@app.post("/api/questions/{q_id}/generate")
async def api_generate_question(q_id: str):
    q = get_question(q_id)
    if not q:
        return JSONResponse({"error": "not found"}, 404)
    reply = await ai_engine.generate_question_reply(q)
    if reply:
        update_question_answer(q_id, reply, status="pending", ai=True)
    return JSONResponse({"ok": True, "reply": reply})


# --- Cabinets ---

@app.post("/api/cabinets/add")
async def api_add_cabinet(name: str = Form(...), api_key: str = Form(...)):
    # Validate key
    client = WBClient(api_key)
    try:
        result = await client.get_feedbacks_count()
        if result is None:
            return RedirectResponse("/cabinets?flash=invalid_key", status_code=303)
        cab_id = add_cabinet(name, api_key)
        log_activity("cabinet_add", f"Добавлен '{name}' (#{cab_id})")
    finally:
        await client.close()
    return RedirectResponse("/cabinets?flash=added", status_code=303)


@app.post("/api/cabinets/{cab_id}/toggle")
async def api_toggle_cabinet(cab_id: int):
    cab = get_cabinet(cab_id)
    if cab:
        update_cabinet(cab_id, is_active=0 if cab["is_active"] else 1)
    return RedirectResponse("/cabinets", status_code=303)


@app.post("/api/cabinets/{cab_id}/delete")
async def api_delete_cabinet(cab_id: int):
    cab = get_cabinet(cab_id)
    if cab:
        delete_cabinet(cab_id)
        log_activity("cabinet_delete", f"Удалён '{cab['name']}' (#{cab_id})")
    return RedirectResponse("/cabinets", status_code=303)


# --- Users ---

ALL_PERMISSIONS = [
    ("view_dashboard", "Дашборд"),
    ("view_reviews", "Просмотр отзывов"),
    ("reply_reviews", "Ответы на отзывы"),
    ("send_reviews", "Отправка ответов"),
    ("view_questions", "Просмотр вопросов"),
    ("reply_questions", "Ответы на вопросы"),
    ("view_analysis", "Анализ товаров"),
    ("manage_cabinets", "Управление кабинетами"),
    ("manage_users", "Управление пользователями"),
    ("manage_settings", "Настройки"),
]


def _generate_password(length: int = 12) -> str:
    import string, random
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(length))


async def _send_credentials_email(email: str, username: str, password: str, display_name: str):
    """Send login credentials via SMTP"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_host = os.getenv("SMTP_HOST", "")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    smtp_from = os.getenv("SMTP_FROM", smtp_user)

    if not all([smtp_host, smtp_user, smtp_pass]):
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Доступ к Ответто - ваши данные для входа"
    msg["From"] = smtp_from
    msg["To"] = email

    url = os.getenv("WEB_URL", "https://bot.sofiny-pro.ru")
    text = f"""Здравствуйте, {display_name}!

Вам предоставлен доступ к системе управления отзывами Ответто.

Ссылка: {url}
Логин: {username}
Пароль: {password}

Рекомендуем сменить пароль после первого входа.
"""
    html = f"""
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
    <h2 style="color:#333;">Доступ к Ответто</h2>
    <p>Здравствуйте, {display_name}!</p>
    <p>Вам предоставлен доступ к системе управления отзывами.</p>
    <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0;">
        <p style="margin:4px 0;"><strong>Ссылка:</strong> <a href="{url}">{url}</a></p>
        <p style="margin:4px 0;"><strong>Логин:</strong> {username}</p>
        <p style="margin:4px 0;"><strong>Пароль:</strong> <code style="background:#e5e5e5;padding:2px 6px;border-radius:4px;">{password}</code></p>
    </div>
    <p style="color:#888;font-size:13px;">Рекомендуем сменить пароль после первого входа.</p>
</div>
"""
    msg.attach(MIMEText(text, "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        return True
    except Exception as e:
        logger.error(f"Failed to send email to {email}: {e}")
        return False


@app.post("/api/users/add")
async def api_add_user(request: Request):
    form = await request.form()
    email = form.get("email", "").strip()
    username = form.get("username", "").strip() or (email.split("@")[0] if email else "")
    password = form.get("password", "").strip() or _generate_password()
    display_name = form.get("display_name", "").strip()
    role = form.get("role", "viewer")

    # Build permissions from form checkboxes
    perms = {}
    for perm_key, _ in ALL_PERMISSIONS:
        perms[perm_key] = perm_key in form.keys()
    # Admin gets all permissions
    if role == "admin":
        perms = {k: True for k, _ in ALL_PERMISSIONS}

    import json as json_mod
    try:
        uid = add_user(username, password, display_name, role, email, json_mod.dumps(perms))
        log_activity("user_add", f"Добавлен пользователь '{username}' ({email})")
    except Exception:
        return RedirectResponse("/users?flash=exists", status_code=303)

    # Send email with credentials
    if email:
        sent = await _send_credentials_email(email, username, password, display_name or username)
        if sent:
            return RedirectResponse("/users?flash=email_sent", status_code=303)
        else:
            return RedirectResponse("/users?flash=added_no_email", status_code=303)

    return RedirectResponse("/users?flash=added", status_code=303)


@app.post("/api/users/{user_id}/delete")
async def api_delete_user(user_id: int):
    user = get_user(user_id)
    if user:
        delete_user(user_id)
        log_activity("user_delete", f"Удалён пользователь '{user['username']}'")
    return RedirectResponse("/users", status_code=303)


@app.post("/api/users/{user_id}/update")
async def api_update_user(user_id: int, request: Request):
    form = await request.form()
    display_name = form.get("display_name", "")
    role = form.get("role", "viewer")
    password = form.get("password", "").strip()
    email = form.get("email", "").strip()

    # Build permissions
    perms = {}
    for perm_key, _ in ALL_PERMISSIONS:
        perms[perm_key] = perm_key in form.keys()
    if role == "admin":
        perms = {k: True for k, _ in ALL_PERMISSIONS}

    import json as json_mod
    kwargs = {"display_name": display_name, "role": role, "email": email,
              "permissions": json_mod.dumps(perms)}
    if password:
        kwargs["password"] = password
    update_user(user_id, **kwargs)
    return RedirectResponse("/users", status_code=303)


# --- AI Analyst ---

@app.get("/api/ai-analyst/stats")
async def api_ai_stats(days: int = 14, cabinet_id: int | None = None, category: str | None = None,
                       date_from: str | None = None, date_to: str | None = None):
    s = get_stats(days, cabinet_id=cabinet_id, category=category, date_from=date_from, date_to=date_to)
    return JSONResponse({
        "total": s["total_reviews"],
        "avg_rating": round(s["avg_rating"], 1),
        "positive": s["by_rating"].get(4, 0) + s["by_rating"].get(5, 0),
        "negative": s["by_rating"].get(1, 0) + s["by_rating"].get(2, 0) + s["by_rating"].get(3, 0),
    })


@app.get("/api/ai-analyst/articles")
async def api_ai_articles(days: int = 90, cabinet_id: int | None = None, category: str | None = None):
    from database import get_db
    from datetime import datetime, timedelta
    conn = get_db()
    since = (datetime.now() - timedelta(days=days)).isoformat()
    flt = ""
    params = [since]
    if cabinet_id:
        flt += " AND cabinet_id = ?"
        params.append(cabinet_id)
    if category:
        flt += " AND category = ?"
        params.append(category)
    rows = conn.execute(f"""
        SELECT product_id, product_name, COUNT(*) as cnt
        FROM reviews
        WHERE created_at >= ? AND product_id != ''{flt}
        GROUP BY product_id
        ORDER BY cnt DESC
        LIMIT 100
    """, params).fetchall()
    conn.close()
    return JSONResponse([{"id": r["product_id"], "name": r["product_name"], "count": r["cnt"]} for r in rows])


@app.post("/api/ai-analyst")
async def api_ai_analyst(request: Request):
    from database import get_db
    body = await request.json()
    query = body.get("query", "").strip()
    days = body.get("days", 14)
    cabinet_id = body.get("cabinet_id")
    category = body.get("category")
    product_id = body.get("product_id")

    if not query:
        return JSONResponse({"error": "Введите запрос"})

    # Build filter and fetch reviews
    conn = get_db()
    from datetime import datetime, timedelta
    since = (datetime.now() - timedelta(days=days)).isoformat()

    where = ["r.created_at >= ?"]
    params = [since]
    if cabinet_id:
        where.append("r.cabinet_id = ?")
        params.append(cabinet_id)
    if category:
        where.append("r.category = ?")
        params.append(category)
    if product_id:
        pids = [p.strip() for p in product_id.split(",") if p.strip()]
        if len(pids) == 1:
            where.append("r.product_id = ?")
            params.append(pids[0])
        elif pids:
            placeholders = ",".join("?" * len(pids))
            where.append(f"r.product_id IN ({placeholders})")
            params.extend(pids)

    where_sql = " AND ".join(where)

    # Get stats for context
    total = conn.execute(f"SELECT COUNT(*) FROM reviews r WHERE {where_sql}", params).fetchone()[0]
    avg_r = conn.execute(f"SELECT AVG(rating) FROM reviews r WHERE {where_sql} AND rating > 0", params).fetchone()[0] or 0

    by_rating = {}
    for row in conn.execute(f"SELECT rating, COUNT(*) as cnt FROM reviews r WHERE {where_sql} GROUP BY rating", params).fetchall():
        by_rating[row["rating"]] = row["cnt"]

    # Sample reviews for AI context (up to 80 recent ones with text)
    sample_rows = conn.execute(f"""
        SELECT r.product_name, r.rating, r.text, r.user_name
        FROM reviews r
        WHERE {where_sql} AND r.text != ''
        ORDER BY r.created_at DESC LIMIT 80
    """, params).fetchall()
    conn.close()

    if total == 0:
        return JSONResponse({"response": "Нет отзывов за выбранный период с указанными фильтрами."})

    # Build context for AI
    reviews_text = "\n".join([
        f"[{r['rating']}★] {r['product_name']}: {r['text'][:200]}"
        for r in sample_rows
    ])

    rating_breakdown = ", ".join([f"{k}★: {v}" for k, v in sorted(by_rating.items(), reverse=True)])

    system_msg = f"""Ты AI-аналитик отзывов на маркетплейсе Wildberries. Тебе дана выборка отзывов покупателей.

Статистика за период ({days} дней):
- Всего отзывов: {total}
- Средний рейтинг: {avg_r:.1f}
- По рейтингам: {rating_breakdown}

Отвечай на русском языке. Будь конкретен, давай цифры и примеры из отзывов. Структурируй ответ."""

    messages = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": f"Отзывы:\n{reviews_text}\n\nВопрос: {query}"},
    ]

    response = await ai_engine._chat(messages, temperature=0.4, max_tokens=1500)
    if not response:
        return JSONResponse({"error": "Не удалось получить ответ от AI"})

    return JSONResponse({"response": response})


# --- Analysis ---

@app.get("/api/analysis/{cab_id}/{product_id}")
async def api_analyze_product(cab_id: int, product_id: str, days: int = 30):
    reviews = get_reviews_for_product(cab_id, product_id, days)
    if not reviews:
        return JSONResponse({"error": "Нет отзывов по этому товару"})

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
        return JSONResponse({"error": "Не удалось сгенерировать отчёт"})

    total = len(reviews)
    avg = sum(r.get("rating", 0) for r in reviews) / total if total else 0

    return JSONResponse({
        "product_name": product_name,
        "product_id": product_id,
        "total_reviews": total,
        "avg_rating": round(avg, 1),
        "report": report,
    })


# =============================================
# STARTUP
# =============================================

if __name__ == "__main__":
    init_db()
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
