"""
One-off script: load last 90 days of reviews & questions from WB API.
- Skips duplicates (INSERT OR IGNORE)
- Marks already-answered reviews as 'sent' so they don't get re-answered
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, timedelta
from database import init_db, get_db, get_cabinets, save_review, save_question
from wb_api import get_wb_client

DAYS = 365
BATCH = 100  # WB API max per request
cutoff = datetime.now() - timedelta(days=DAYS)


def parse_fb(fb: dict) -> dict:
    return {
        "id": str(fb.get("id", "")),
        "wb_id": str(fb.get("id", "")),
        "product_name": fb.get("productDetails", {}).get("productName", "Товар"),
        "product_id": str(fb.get("productDetails", {}).get("nmId", "")),
        "user_name": fb.get("userName", "Покупатель"),
        "rating": fb.get("productValuation", 0),
        "text": fb.get("text", ""),
        "photos": [p.get("fullSize", "") for p in (fb.get("photoLinks") or [])],
        "created_at": fb.get("createdDate", ""),
    }


def parse_q(q: dict) -> dict:
    return {
        "id": str(q.get("id", "")),
        "wb_id": str(q.get("id", "")),
        "product_name": q.get("productDetails", {}).get("productName", "Товар"),
        "product_id": str(q.get("productDetails", {}).get("nmId", "")),
        "question_text": q.get("text", ""),
        "created_at": q.get("createdDate", ""),
    }


def is_within_range(date_str: str) -> bool:
    if not date_str:
        return False
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00")).replace(tzinfo=None)
        return dt >= cutoff
    except Exception:
        return False


async def backfill():
    init_db()
    cabinets = get_cabinets(active_only=True)
    if not cabinets:
        print("No active cabinets")
        return

    for cab in cabinets:
        cab_id = cab["id"]
        cab_name = cab["name"]
        client = get_wb_client(cab_id, cab["api_key"])
        print(f"\n=== Cabinet: {cab_name} (ID {cab_id}) ===")

        # --- Reviews ---
        for is_answered in [True, False]:
            label = "answered" if is_answered else "unanswered"
            print(f"\nFetching {label} reviews...")
            skip = 0
            new_count = 0
            skipped_count = 0
            total_fetched = 0
            stop = False

            while not stop:
                data = await client.get_feedbacks(is_answered=is_answered, take=BATCH, skip=skip)
                if not data or "data" not in data:
                    print(f"  No more data at skip={skip}")
                    break

                feedbacks = data.get("data", {}).get("feedbacks", [])
                if not feedbacks:
                    break

                for fb in feedbacks:
                    created = fb.get("createdDate", "")
                    if not is_within_range(created):
                        stop = True
                        break

                    total_fetched += 1
                    parsed = parse_fb(fb)
                    is_new = save_review(parsed, cabinet_id=cab_id)

                    if is_new:
                        new_count += 1
                        # If already answered on WB, mark as sent
                        if is_answered:
                            conn = get_db()
                            review_id = f"{cab_id}_{parsed['id']}"
                            conn.execute(
                                "UPDATE reviews SET reply_status = 'sent', reply_sent_at = ? WHERE id = ?",
                                (datetime.now().isoformat(), review_id)
                            )
                            conn.commit()
                            conn.close()
                    else:
                        skipped_count += 1

                skip += BATCH
                print(f"  ... fetched {total_fetched} {label} (new: {new_count}, dup: {skipped_count})")
                await asyncio.sleep(0.3)

            print(f"  Done {label}: {new_count} new, {skipped_count} duplicates")

        # --- Questions ---
        for is_answered in [True, False]:
            label = "answered" if is_answered else "unanswered"
            print(f"\nFetching {label} questions...")
            skip = 0
            new_count = 0
            skipped_count = 0
            total_fetched = 0
            stop = False

            while not stop:
                data = await client.get_questions(is_answered=is_answered, take=BATCH, skip=skip)
                if not data or "data" not in data:
                    break

                questions = data.get("data", {}).get("questions", [])
                if not questions:
                    break

                for q in questions:
                    created = q.get("createdDate", "")
                    if not is_within_range(created):
                        stop = True
                        break

                    total_fetched += 1
                    parsed = parse_q(q)
                    is_new = save_question(parsed, cabinet_id=cab_id)

                    if is_new:
                        new_count += 1
                        if is_answered:
                            conn = get_db()
                            q_id = f"{cab_id}_{parsed['id']}"
                            conn.execute(
                                "UPDATE questions SET answer_status = 'sent', answer_sent_at = ? WHERE id = ?",
                                (datetime.now().isoformat(), q_id)
                            )
                            conn.commit()
                            conn.close()
                    else:
                        skipped_count += 1

                skip += BATCH
                print(f"  ... fetched {total_fetched} {label} (new: {new_count}, dup: {skipped_count})")
                await asyncio.sleep(0.3)

            print(f"  Done {label}: {new_count} new, {skipped_count} duplicates")

        await client.close()

    # Final stats
    conn = get_db()
    total = conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
    pending = conn.execute("SELECT COUNT(*) FROM reviews WHERE reply_status='pending'").fetchone()[0]
    sent = conn.execute("SELECT COUNT(*) FROM reviews WHERE reply_status='sent'").fetchone()[0]
    q_total = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
    conn.close()
    print(f"\n=== DONE ===")
    print(f"Reviews: {total} total, {pending} pending, {sent} sent")
    print(f"Questions: {q_total} total")


if __name__ == "__main__":
    asyncio.run(backfill())
