"""
Клиент Wildberries API — получение отзывов, вопросов, отправка ответов.
Поддержка нескольких кабинетов через параметризованный api_key.
"""
import asyncio
import aiohttp
import logging
from config import WB_API_BASE

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_BACKOFF = [1, 3, 10]


class WBClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = WB_API_BASE
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={
                "Authorization": self.api_key,
                "Content-Type": "application/json",
            })
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(self, method: str, endpoint: str, **kwargs) -> dict | list | None:
        url = f"{self.base_url}{endpoint}"
        session = await self._get_session()

        for attempt in range(MAX_RETRIES):
            try:
                async with session.request(method, url, **kwargs) as resp:
                    if resp.status in (200, 204):
                        if resp.status == 204:
                            return {}
                        return await resp.json()
                    elif resp.status == 429:
                        retry_after = resp.headers.get("X-Ratelimit-Retry")
                        wait = float(retry_after) if retry_after else RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
                        logger.warning(f"WB API rate limit, retry in {wait}s (attempt {attempt + 1})")
                        await asyncio.sleep(wait)
                        continue
                    else:
                        text = await resp.text()
                        logger.error(f"WB API {method} {endpoint} → {resp.status}: {text[:500]}")
                        return None
            except aiohttp.ClientError as e:
                logger.error(f"WB API connection error (attempt {attempt + 1}): {e}")
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_BACKOFF[attempt])
                    continue
                return None
            except Exception as e:
                logger.error(f"WB API unexpected error: {e}")
                return None

        logger.error(f"WB API {method} {endpoint}: max retries exceeded")
        return None

    # === Отзывы ===

    async def get_feedbacks(self, is_answered: bool = False, take: int = 100, skip: int = 0,
                            order: str = "dateDesc") -> dict | None:
        params = {
            "isAnswered": str(is_answered).lower(),
            "take": take,
            "skip": skip,
            "order": order,
        }
        return await self._request("GET", "/api/v1/feedbacks", params=params)

    async def get_unanswered_feedbacks(self, take: int = 100) -> list:
        data = await self.get_feedbacks(is_answered=False, take=take)
        if not data or "data" not in data:
            return []

        feedbacks = data.get("data", {}).get("feedbacks", [])
        results = []
        for fb in feedbacks:
            results.append({
                "id": str(fb.get("id", "")),
                "wb_id": str(fb.get("id", "")),
                "product_name": fb.get("productDetails", {}).get("productName", "Товар"),
                "product_id": str(fb.get("productDetails", {}).get("nmId", "")),
                "user_name": fb.get("userName", "Покупатель"),
                "rating": fb.get("productValuation", 0),
                "text": fb.get("text", ""),
                "photos": [p.get("fullSize", "") for p in (fb.get("photoLinks") or [])],
                "created_at": fb.get("createdDate", ""),
            })
        return results

    async def send_feedback_reply(self, feedback_id: str, text: str) -> bool:
        """PATCH /api/v1/feedbacks/answer"""
        payload = {"id": feedback_id, "text": text}
        result = await self._request("PATCH", "/api/v1/feedbacks/answer", json=payload)
        return result is not None

    # === Вопросы ===

    async def get_questions(self, is_answered: bool = False, take: int = 100, skip: int = 0,
                            order: str = "dateDesc") -> dict | None:
        params = {
            "isAnswered": str(is_answered).lower(),
            "take": take,
            "skip": skip,
            "order": order,
        }
        return await self._request("GET", "/api/v1/questions", params=params)

    async def get_unanswered_questions(self, take: int = 100) -> list:
        data = await self.get_questions(is_answered=False, take=take)
        if not data or "data" not in data:
            return []

        questions = data.get("data", {}).get("questions", [])
        results = []
        for q in questions:
            results.append({
                "id": str(q.get("id", "")),
                "wb_id": str(q.get("id", "")),
                "product_name": q.get("productDetails", {}).get("productName", "Товар"),
                "product_id": str(q.get("productDetails", {}).get("nmId", "")),
                "question_text": q.get("text", ""),
                "created_at": q.get("createdDate", ""),
            })
        return results

    async def send_question_reply(self, question_id: str, text: str) -> bool:
        """PATCH /api/v1/questions — answer a question"""
        payload = {"id": question_id, "text": text, "state": "wbRu"}
        result = await self._request("PATCH", "/api/v1/questions", json=payload)
        return result is not None

    # === Статистика ===

    async def get_feedbacks_count(self) -> dict:
        data = await self._request("GET", "/api/v1/feedbacks/count")
        return data.get("data", {}) if data else {}

    async def get_questions_count(self) -> dict:
        data = await self._request("GET", "/api/v1/questions/count")
        return data.get("data", {}) if data else {}


# === Кэш клиентов по кабинетам ===

_clients: dict[int, WBClient] = {}


def get_wb_client(cabinet_id: int, api_key: str) -> WBClient:
    """Получить/создать клиент для кабинета"""
    if cabinet_id not in _clients:
        _clients[cabinet_id] = WBClient(api_key)
    return _clients[cabinet_id]


def invalidate_client(cabinet_id: int):
    """Удалить клиент из кэша (при смене ключа или удалении кабинета)"""
    if cabinet_id in _clients:
        _clients.pop(cabinet_id)


async def close_all_clients():
    """Закрыть все сессии"""
    for client in _clients.values():
        await client.close()
    _clients.clear()
