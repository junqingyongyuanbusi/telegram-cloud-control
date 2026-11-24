"""Redis 侧协调：页面推送、心跳缓存、Webhook 去重、登录临时会话。

Redis 丢了只影响页面订阅与临时登录态；消息、任务、租约的事实都在 Postgres。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import redis.asyncio as aioredis

CHANNEL_INBOX_ALL = "inbox:all"
CHANNEL_ACCOUNTS = "events:accounts"
CHANNEL_TASKS = "events:tasks"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def dialog_channel(dialog_id: uuid.UUID | str) -> str:
    return f"inbox:dialog:{dialog_id}"


def _dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


# ---------------- 页面推送 ----------------

async def publish_new_message(redis: aioredis.Redis, payload: dict) -> None:
    """新消息入库后推给页面。payload 见 docs/API_CONTRACT.md。"""
    body = {"kind": "message", "ts": _now_iso(), **payload}
    dialog_id = payload.get("dialog_id")
    if dialog_id:
        await redis.publish(dialog_channel(dialog_id), _dumps(body))
    await redis.publish(CHANNEL_INBOX_ALL, _dumps(body))


async def publish_account_event(redis: aioredis.Redis, payload: dict) -> None:
    await redis.publish(CHANNEL_ACCOUNTS, _dumps({"kind": "account", "ts": _now_iso(), **payload}))


async def publish_task_event(redis: aioredis.Redis, payload: dict) -> None:
    await redis.publish(CHANNEL_TASKS, _dumps({"kind": "task", "ts": _now_iso(), **payload}))


# ---------------- 心跳 ----------------

def worker_heartbeat_key(worker_id: str) -> str:
    return f"worker:heartbeat:{worker_id}"


def account_heartbeat_key(account_id: uuid.UUID | str) -> str:
    return f"account:heartbeat:{account_id}"


async def set_worker_heartbeat(
    redis: aioredis.Redis, worker_id: str, payload: Optional[dict] = None, ttl: int = 60
) -> None:
    await redis.setex(
        worker_heartbeat_key(worker_id),
        ttl,
        _dumps({"worker_id": worker_id, "ts": _now_iso(), **(payload or {})}),
    )


async def set_account_heartbeat(
    redis: aioredis.Redis,
    account_id: uuid.UUID | str,
    payload: Optional[dict] = None,
    ttl: int = 120,
) -> None:
    await redis.setex(
        account_heartbeat_key(account_id),
        ttl,
        _dumps({"account_id": str(account_id), "ts": _now_iso(), **(payload or {})}),
    )


async def worker_heartbeats(redis: aioredis.Redis) -> list[dict]:
    keys = [key async for key in redis.scan_iter(match="worker:heartbeat:*", count=100)]
    if not keys:
        return []
    values = await redis.mget(*keys)
    out = []
    for raw in values:
        if not raw:
            continue
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return out


# ---------------- Webhook 去重 ----------------

def update_dedupe_key(bot_id: uuid.UUID | str, update_id: int) -> str:
    return f"tg:update:{bot_id}:{update_id}"


async def seen_update(
    redis: aioredis.Redis, bot_id: uuid.UUID | str, update_id: int, ttl: int = 86400
) -> bool:
    """Telegram 会重试 webhook，用 update_id 保证只处理一次。"""
    key = update_dedupe_key(bot_id, update_id)
    created = await redis.set(key, "1", ex=ttl, nx=True)
    return not bool(created)


# ---------------- 登录临时会话 ----------------

def login_session_key(account_id: uuid.UUID | str) -> str:
    return f"login:session:{account_id}"


async def save_login_session(
    redis: aioredis.Redis, account_id: uuid.UUID | str, state: dict, ttl: int
) -> None:
    await redis.setex(login_session_key(account_id), ttl, _dumps(state))


async def load_login_session(redis: aioredis.Redis, account_id: uuid.UUID | str) -> Optional[dict]:
    raw = await redis.get(login_session_key(account_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def clear_login_session(redis: aioredis.Redis, account_id: uuid.UUID | str) -> None:
    await redis.delete(login_session_key(account_id))


# ---------------- 扫码登录临时态 ----------------
# 二维码会话由 Worker 持有（轮询 auth.ExportLoginToken），页面只读 Redis 里的快照；
# 取消是独立的一个短 key，避免页面和 Worker 同时改写状态对象。

def qr_login_key(login_id: uuid.UUID | str) -> str:
    return f"account:qr-login:{login_id}"


def qr_cancel_key(login_id: uuid.UUID | str) -> str:
    return f"account:qr-login:{login_id}:cancel"


async def save_qr_login(
    redis: aioredis.Redis, login_id: uuid.UUID | str, state: dict, ttl: int
) -> None:
    await redis.setex(qr_login_key(login_id), ttl, _dumps(state))


async def load_qr_login(redis: aioredis.Redis, login_id: uuid.UUID | str) -> Optional[dict]:
    return await get_json(redis, qr_login_key(login_id))


async def clear_qr_login(redis: aioredis.Redis, login_id: uuid.UUID | str) -> None:
    await redis.delete(qr_login_key(login_id))


async def request_qr_cancel(
    redis: aioredis.Redis, login_id: uuid.UUID | str, ttl: int = 300
) -> None:
    await redis.setex(qr_cancel_key(login_id), ttl, "1")


async def qr_cancel_requested(redis: aioredis.Redis, login_id: uuid.UUID | str) -> bool:
    return bool(await redis.exists(qr_cancel_key(login_id)))


async def clear_qr_cancel(redis: aioredis.Redis, login_id: uuid.UUID | str) -> None:
    await redis.delete(qr_cancel_key(login_id))


def qr_password_key(login_id: uuid.UUID | str) -> str:
    return f"account:qr-login:{login_id}:password"


async def save_qr_password(
    redis: aioredis.Redis, login_id: uuid.UUID | str, password: str, ttl: int = 180
) -> None:
    """两步验证密码只作为一次性凭证短暂停留，Worker 取走即删，不写进状态快照。"""
    await redis.setex(qr_password_key(login_id), ttl, password)


async def take_qr_password(
    redis: aioredis.Redis, login_id: uuid.UUID | str
) -> Optional[str]:
    key = qr_password_key(login_id)
    password = await redis.get(key)
    if password is not None:
        await redis.delete(key)
        return password if isinstance(password, str) else password.decode()
    return None


# ---------------- 检测请求 ----------------

def check_request_key(account_id: uuid.UUID | str) -> str:
    return f"account:check-request:{account_id}"


async def request_account_check(
    redis: aioredis.Redis, account_id: uuid.UUID | str, ttl: int = 300
) -> None:
    await redis.setex(check_request_key(account_id), ttl, "1")


async def consume_check_request(redis: aioredis.Redis, account_id: uuid.UUID | str) -> bool:
    return bool(await redis.delete(check_request_key(account_id)))


async def get_json(redis: aioredis.Redis, key: str) -> Optional[dict]:
    raw = await redis.get(key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def publish_raw(redis: aioredis.Redis, channel: str, payload: Any) -> None:
    await redis.publish(channel, _dumps(payload) if isinstance(payload, dict) else str(payload))
