"""批次控制：跨进程的「终止」标志。

任务状态是事实源；Redis 只负责让**正在执行的长任务**（加群群发）在下一组动作前停下来。
只把任务状态改成 cancelled 的话，已经领走、正在逐群跑的任务会继续干完——页面上点了终止，
号还在加群发言，这才是真正危险的。标志保留 7 天，批次结束后自然过期。
"""

from __future__ import annotations

import uuid

from app.redis_client import get_redis

CANCEL_TTL_SECONDS = 7 * 24 * 3600


def batch_cancel_key(batch_id: uuid.UUID | str) -> str:
    return f"campaign:batch:cancel:{batch_id}"


async def mark_batch_cancelled(batch_id: uuid.UUID | str, *, ttl: int = CANCEL_TTL_SECONDS) -> None:
    await get_redis().set(batch_cancel_key(batch_id), "1", ex=ttl)


async def is_batch_cancelled(batch_id: uuid.UUID | str | None) -> bool:
    """Redis 读失败按「未取消」处理：控制面故障不能把任务卡死。"""
    if not batch_id:
        return False
    try:
        return bool(await get_redis().get(batch_cancel_key(batch_id)))
    except Exception:  # noqa: BLE001
        return False


__all__ = ["CANCEL_TTL_SECONDS", "batch_cancel_key", "is_batch_cancelled", "mark_batch_cancelled"]
