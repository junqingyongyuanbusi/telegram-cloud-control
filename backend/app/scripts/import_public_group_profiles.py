"""把公开 Telegram 用户名解析成真实实体，并写入群档案。

默认 dry-run：只解析、不写 group_profiles。加 ``--apply`` 才 upsert。
只调用 ``get_entity``，不加入群、不发消息、不读取成员或历史消息。

在 worker 镜像里运行（先停 worker，避免账号租约冲突）：

    docker compose run --rm -T --no-deps worker \
      python -m app.scripts.import_public_group_profiles --input - --target 100

输入是 JSON：``{"rows": [...]}``，每行至少含 ``username``；可选
``country`` / ``country_source`` / ``language`` / ``topic`` 和证据字段。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
import sys
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from telethon import TelegramClient
from telethon.errors import (
    ChannelPrivateError,
    FloodWaitError,
    RPCError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.sessions import StringSession

from app.config import settings
from app.core.leases import release_leases
from app.db import SessionFactory
from app.models import AccountStatus, GroupProfile, Lease, TgAccount
from app.services.group_intel import profile_fields_from_entity, upsert_profile
from app.worker.telethon_account import (
    connection_class_for,
    snapshot_from_row,
    telethon_proxy_argument,
)

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
LEASE_SECONDS = 7200


class FloodWaitTooLong(RuntimeError):
    """Telegram 要求等待的时间超过上限；继续睡会长时间占着账号租约。"""

    def __init__(self, seconds: int) -> None:
        super().__init__(f"FloodWait {seconds}s 超过上限")
        self.seconds = seconds


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _log(message: str) -> None:
    print(message, flush=True)


def _load_rows(source: str) -> list[dict[str, Any]]:
    raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    data = json.loads(raw)
    rows = data.get("rows") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise SystemExit("输入必须是 {\"rows\": [...]} 或数组")
    return [row for row in rows if isinstance(row, dict)]


async def _lease_account(
    session: Any, worker_id: str, account_id: str | None = None
) -> TgAccount:
    query = select(TgAccount).where(
        TgAccount.status == AccountStatus.healthy,
        TgAccount.session_enc.is_not(None),
    )
    if account_id:
        try:
            wanted = uuid.UUID(account_id)
        except ValueError as exc:
            raise RuntimeError("--account-id 不是合法 UUID") from exc
        query = query.where(TgAccount.id == wanted)
    account = await session.scalar(query.order_by(TgAccount.created_at.asc()).limit(1))
    if account is None:
        raise RuntimeError(
            f"没有可用的 healthy 且有会话的账号（account_id={account_id or 'auto'}）"
        )

    now = _now()
    active = await session.scalar(
        select(Lease).where(Lease.account_id == account.id, Lease.lease_until > now)
    )
    if active is not None:
        raise RuntimeError("账号仍被有效租约占用：先停止 worker，等租约释放后再跑")

    stmt = pg_insert(Lease).values(
        account_id=account.id,
        worker_id=worker_id,
        lease_until=now + timedelta(seconds=LEASE_SECONDS),
        last_heartbeat=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[Lease.account_id],
        set_={
            "worker_id": worker_id,
            "lease_until": now + timedelta(seconds=LEASE_SECONDS),
            "last_heartbeat": now,
            "updated_at": now,
        },
    )
    await session.execute(stmt)
    await session.commit()
    return account


def _build_client(snapshot: Any) -> TelegramClient:
    if not settings.telegram_api_id or not settings.telegram_api_hash:
        raise RuntimeError("未配置 TELEGRAM_API_ID / TELEGRAM_API_HASH")
    if not snapshot.session_string:
        raise RuntimeError("账号没有可用会话串")

    proxy_arg = telethon_proxy_argument(snapshot.proxy) if snapshot.proxy is not None else None
    kwargs: dict[str, Any] = {
        "connection": connection_class_for(snapshot.proxy),
        "proxy": proxy_arg,
        "device_model": snapshot.device_model or settings.telegram_device_model,
        "system_version": snapshot.system_version or settings.telegram_system_version,
        "app_version": snapshot.app_version or settings.telegram_app_version,
        "lang_code": snapshot.lang_code or "en",
        "timeout": 15,
        "request_retries": 3,
        "connection_retries": 3,
        "retry_delay": 1,
        "auto_reconnect": True,
        "receive_updates": False,
        "catch_up": False,
        "flood_sleep_threshold": 0,
    }
    if snapshot.lang_pack:
        kwargs["system_lang_code"] = snapshot.lang_pack
    return TelegramClient(
        StringSession(snapshot.session_string),
        settings.telegram_api_id,
        settings.telegram_api_hash,
        **kwargs,
    )


async def _resolve(client: TelegramClient, username: str, max_flood_wait: int) -> Any:
    """只读解析；短 FloodWait 等待后重试，超长等待直接中止整批。"""
    for attempt in range(3):
        try:
            return await client.get_entity(f"@{username}")
        except FloodWaitError as exc:
            wait = int(getattr(exc, "seconds", 0) or 30)
            if wait > max_flood_wait:
                raise FloodWaitTooLong(wait) from exc
            _log(f"FLOOD_WAIT {wait}s @{username}（第 {attempt + 1} 次）")
            await asyncio.sleep(wait + 2)
    raise RuntimeError("FloodWait 重试次数用尽")


def _payload(row: dict[str, Any], entity: Any, account_id: Any, now: datetime) -> dict[str, Any]:
    fields = profile_fields_from_entity(entity)
    return {
        "account_id": account_id,
        "tg_chat_id": int(getattr(entity, "id", 0) or 0),
        "source": "import",
        "touch_collected_at": False,
        "verification_status": "entity_only",
        "last_verified_at": now,
        "country": row.get("country") or None,
        "country_source": row.get("country_source") or None,
        "language": row.get("language") or None,
        "topic": row.get("topic") or None,
        "is_public": True,
        "discovery_sources": ["public_directory_research"],
        "matched_keywords": [],
        "raw": {
            "import_batch": "vn100_public_research",
            "evidence": {
                "region": row.get("region"),
                "topic": row.get("topic_evidence"),
                "type": row.get("type_evidence"),
            },
            "confidence": row.get("confidence"),
            "source_page": row.get("source_page"),
            "caveat": row.get("caveat"),
            "resolved_at": now.isoformat(),
            "resolved_username": getattr(entity, "username", None),
            "entity_type": type(entity).__name__,
        },
        **fields,
    }


async def run(args: argparse.Namespace) -> int:
    rows = _load_rows(args.input)
    if args.limit:
        rows = rows[: args.limit]

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for row in rows:
        username = str(row.get("username") or "").strip().lstrip("@")
        if username.lower() in seen:
            continue
        seen.add(username.lower())
        item = dict(row)
        item["username"] = username
        unique.append(item)

    counts: Counter[str] = Counter()
    results: list[dict[str, Any]] = []
    worker_id = f"import-{uuid.uuid4()}"
    client: TelegramClient | None = None
    account_id: uuid.UUID | None = None

    try:
        async with SessionFactory() as session:
            account = await _lease_account(session, worker_id, args.account_id)
            account_id = account.id
            snapshot = snapshot_from_row(account)
            client = _build_client(snapshot)
            await client.connect()
            if not await client.is_user_authorized():
                raise RuntimeError("账号会话未授权，无法解析")

            _log(f"account={account_id} mode={'apply' if args.apply else 'dry-run'} rows={len(unique)}")
            for row in unique:
                target_hit = counts["inserted"] if args.apply else counts["resolved"]
                if target_hit >= args.target:
                    break

                username = str(row.get("username") or "")
                if not USERNAME_RE.fullmatch(username):
                    counts["invalid"] += 1
                    results.append({"username": username, "status": "invalid"})
                    continue

                try:
                    entity = await _resolve(client, username, args.max_flood_wait)
                except FloodWaitTooLong as exc:
                    counts["flood_abort"] += 1
                    results.append(
                        {"username": username, "status": "flood_abort", "seconds": exc.seconds}
                    )
                    _log(f"ABORT FloodWait {exc.seconds}s @{username}")
                    break
                except (UsernameNotOccupiedError, UsernameInvalidError, ChannelPrivateError) as exc:
                    counts["not_found"] += 1
                    results.append({"username": username, "status": "not_found", "error": type(exc).__name__})
                    continue
                except (RPCError, RuntimeError, OSError) as exc:
                    counts["failed"] += 1
                    results.append({"username": username, "status": "failed", "error": type(exc).__name__})
                    continue

                kind_name = type(entity).__name__.lower()
                if kind_name != "channel":
                    counts["not_group"] += 1
                    results.append({"username": username, "status": "not_group", "entity": kind_name})
                    continue
                if getattr(entity, "broadcast", False):
                    counts["channel"] += 1
                    results.append({"username": username, "status": "broadcast_channel"})
                    continue
                if not getattr(entity, "megagroup", False):
                    counts["not_group"] += 1
                    results.append({"username": username, "status": "not_megagroup"})
                    continue

                tg_chat_id = int(getattr(entity, "id", 0) or 0)
                if not tg_chat_id:
                    counts["failed"] += 1
                    results.append({"username": username, "status": "failed", "error": "missing_id"})
                    continue

                existing = await session.scalar(
                    select(GroupProfile.id).where(
                        GroupProfile.account_id == account_id,
                        GroupProfile.tg_chat_id == tg_chat_id,
                    )
                )
                if existing is not None:
                    counts["existing"] += 1
                    results.append(
                        {
                            "username": username,
                            "status": "existing",
                            "tg_chat_id": tg_chat_id,
                            "title": getattr(entity, "title", ""),
                        }
                    )
                    continue

                now = _now()
                payload = _payload(row, entity, account_id, now)
                try:
                    if args.apply:
                        await upsert_profile(session, **payload)
                        await session.commit()
                        counts["inserted"] += 1
                    else:
                        counts["resolved"] += 1
                except Exception as exc:  # noqa: BLE001 - 单条失败不影响整批
                    await session.rollback()
                    counts["failed"] += 1
                    results.append(
                        {"username": username, "status": "failed", "error": type(exc).__name__}
                    )
                    continue

                results.append(
                    {
                        "username": username,
                        "status": "inserted" if args.apply else "resolved",
                        "tg_chat_id": payload["tg_chat_id"],
                        "title": payload.get("title", ""),
                        "kind": payload.get("kind", ""),
                        "member_count": payload.get("member_count"),
                    }
                )
                await asyncio.sleep(args.sleep + random.uniform(0, 0.35))
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        try:
            async with SessionFactory() as session:
                await release_leases(session, worker_id=worker_id)
        except Exception as exc:  # noqa: BLE001
            _log(f"释放租约失败：{type(exc).__name__}")

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "account_id": str(account_id) if account_id is not None else None,
        "target": args.target,
        "counts": dict(counts),
        "rows": results,
    }
    _log(
        "SUMMARY "
        + " ".join(f"{key}={value}" for key, value in sorted(counts.items()))
    )
    print("REPORT_JSON:" + json.dumps(report, ensure_ascii=False), flush=True)
    target_hit = counts["inserted"] if args.apply else counts["resolved"]
    return 0 if target_hit >= args.target else 2


def main() -> None:
    parser = argparse.ArgumentParser(description="解析公开 Telegram 用户名并导入群档案")
    parser.add_argument("--input", default="-", help="输入 JSON 文件；默认从 stdin 读取")
    parser.add_argument("--target", type=int, default=100, help="目标成功群数，默认 100")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少条输入（0=全部）")
    parser.add_argument("--sleep", type=float, default=1.2, help="两条解析之间的基础间隔秒数")
    parser.add_argument("--account-id", default=None, help="指定健康账号 UUID；默认取最早的健康账号")
    parser.add_argument(
        "--max-flood-wait",
        type=int,
        default=120,
        help="FloodWait 超过该秒数立即中止整批，默认 120",
    )
    parser.add_argument("--apply", action="store_true", help="真正写入；默认只 dry-run")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
