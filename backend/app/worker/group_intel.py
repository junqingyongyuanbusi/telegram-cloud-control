"""群情报 Worker 侧：入群/退群事件的「无感」记录 + 群档案与成员名单的按需采集。

无感的三条纪律（代码里逐条落实）：
1. 事件回调**只写库**：不回复、不打招呼、不加表情、不做任何群内可见动作；
2. 采集只用读接口（`GetFullChannel` / `GetParticipants`），且分页之间有间隔、单任务有上限；
3. 成员数变化等群内动静全部来自事件的被动观察，不主动轮询群列表。
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

import httpx
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from telethon import functions
from telethon.tl import types as tl_types

from app.config import settings
from app.db import session_scope
from app.models import (
    AccountStatus,
    Dialog,
    DialogChannel,
    DialogKind,
    DiscoveryLead,
    DiscoveryQueryStat,
    GroupMember,
    GroupProfile,
    GroupSearchKeyword,
    GroupSearchMatch,
    Task,
    TgAccount,
)
from app.services.external_group_sources import fetch_external_candidates
from app.services.group_ai import expand_queries_with_ai, review_candidates_with_ai
from app.services.group_discovery import (
    ExtractedLink,
    extract_links,
    invite_url,
    parse_tme_channel_posts,
    parse_tme_page,
    tme_channel_preview_url,
    tme_url,
)
from app.services.group_precision import (
    TOPIC_TERMS,
    _contains,
    _keyword_tokens,
    canonical_topics,
    classify,
    discussion_verdict,
    score_group,
    verification_flags,
)
from app.services.group_sources import SearchSource, compute_source_trust, normalize_search_source
from app.services.group_intel import (
    describe_chat_action,
    display_name_of,
    member_status_for_event,
    profile_fields_from_entity,
    record_event,
    upsert_member,
    upsert_profile,
)
from app.services.group_search import SearchQuery, build_short_queries, clean_keyword, expand_queries
from app.services.local_group_search import search_local_profiles
from app.worker.entities import resolve_chat_entity, resolve_entity
from app.worker.campaign_tasks import _invite_hash_of, _username_from_target
from app.worker.humanize import sleep_human
from app.worker.telethon_account import (
    TaskFailure,
    describe_exception,
    flood_wait_seconds,
    map_exception_to_status,
)

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _record_query_stat(
    session: Any,
    item: SearchQuery,
    *,
    raw_count: int,
    found_count: int,
    error: str = "",
) -> None:
    """记一条查询的产出，连续 0 产出且跑够次数的非基础查询自动停用。

    用 `ON CONFLICT DO NOTHING` + `FOR UPDATE` 串行化同一 query 的并发更新：
    多个账号同时搜同一个词时，不会因为唯一键冲突把整个任务打挂。
    """

    await session.execute(
        pg_insert(DiscoveryQueryStat)
        .values(
            id=uuid.uuid4(),
            query=item.query,
            region=item.region,
            lang=item.lang,
            template=item.template,
            runs=0,
            raw=0,
            found_total=0,
            last_found=0,
            zero_streak=0,
            yield_rate=0.0,
            enabled=True,
            last_error="",
        )
        .on_conflict_do_nothing(index_elements=["query"])
    )
    stat = await session.scalar(
        select(DiscoveryQueryStat).where(DiscoveryQueryStat.query == item.query).with_for_update()
    )
    if stat is None:
        return
    stat.runs += 1
    stat.last_run_at = _now()
    if error:
        stat.last_error = error[:500]
        # 抓取失败不等于「这个词没产出」，不计入 zero_streak。
    else:
        stat.last_error = ""
        stat.raw += max(0, raw_count)
        stat.found_total += max(0, found_count)
        stat.last_found = max(0, found_count)
        if found_count > 0:
            stat.zero_streak = 0
        else:
            stat.zero_streak += 1
    stat.yield_rate = (stat.found_total / stat.runs) if stat.runs else 0.0
    # 短核心词是兜底召回，不能因为「本轮没有新增候选」被自动停用；
    # 否则热门词在候选已存在时会连续 0 产出，反而被系统关掉。
    if stat.template not in ("base", "short_core") and stat.runs >= 5 and stat.zero_streak >= 3:
        stat.enabled = False
    await session.flush()


def _is_group_chat(chat: Any) -> bool:
    return isinstance(chat, (tl_types.Chat, tl_types.Channel, tl_types.ChatForbidden, tl_types.ChannelForbidden))


def make_chat_action_handler(
    *, worker_id: str, account_id: uuid.UUID, redis: Any
) -> Callable[[Any], Awaitable[None]]:
    """给一个号造 ChatAction 处理器：入群/退群/被拉进来，全程静默入库。

    注意这里**不做任何回应动作**——不发欢迎语、不点赞、不撤回，避免在群里留下痕迹。
    """

    async def _handler(event: Any) -> None:
        try:
            chat = await event.get_chat()
            if chat is None or not _is_group_chat(chat):
                return
            event_type = describe_chat_action(
                user_joined=bool(getattr(event, "user_joined", False)),
                user_added=bool(getattr(event, "user_added", False)),
                user_left=bool(getattr(event, "user_left", False)),
                user_kicked=bool(getattr(event, "user_kicked", False)),
            )
            if event_type is None:
                return

            user = None
            try:
                user = await event.get_user()
            except Exception:  # noqa: BLE001 - 拿不到用户实体不影响记事件
                user = None
            actor_id = getattr(event, "added_by_id", None)
            occurred = getattr(event, "date", None) or _now()

            async with session_scope() as session:
                fields = profile_fields_from_entity(chat)
                profile = await upsert_profile(
                    session,
                    account_id=account_id,
                    tg_chat_id=int(chat.id),
                    source="join_event",
                    touch_collected_at=False,
                    **fields,
                )
                await record_event(
                    session,
                    account_id=account_id,
                    tg_chat_id=int(chat.id),
                    event_type=event_type,
                    tg_user_id=getattr(user, "id", None),
                    actor_tg_id=actor_id,
                    user_display=display_name_of(user),
                    username=getattr(user, "username", None),
                    is_bot=bool(getattr(user, "bot", False)),
                    occurred_at=occurred,
                    raw={"event": event_type, "chat_kind": profile.kind},
                )
                if user is not None:
                    await upsert_member(
                        session,
                        profile=profile,
                        tg_user_id=int(user.id),
                        username=getattr(user, "username", None),
                        display_name=display_name_of(user),
                        is_bot=bool(getattr(user, "bot", False)),
                        is_premium=bool(getattr(user, "premium", False)),
                        status=member_status_for_event(event_type),
                        source="join_event",
                        raw={"event": event_type},
                    )
            logger.info(
                "群事件已记录（静默）",
                extra={
                    "worker_id": worker_id,
                    "account_id": str(account_id),
                    "tg_chat_id": int(chat.id),
                    "event_type": event_type,
                    "tg_user_id": getattr(user, "id", None),
                },
            )
        except Exception:  # noqa: BLE001 - 单个事件失败不能影响这个号的其它事件
            logger.exception(
                "处理群事件失败",
                extra={"worker_id": worker_id, "account_id": str(account_id)},
            )

    return _handler


class GroupIntelMixin:
    """采集任务：群档案（`collect_group`）、成员名单（`collect_members`）、按链接采集（`collect_link`）。"""

    async def _report_progress(
        self, session: Any, task: Task, *, stage: str, detail: str = "", **extra: Any
    ) -> None:
        """把采集进度写进 `task.result` 并推 Redis 事件——页面的「采集进度」看的就是这里。

        运行中写 result 是安全的：任务真正结束时 `complete_task` 会用最终结果整体覆盖。
        """
        moment = _now().isoformat()
        snapshot = {
            "stage": stage,
            "detail": detail,
            "updated_at": moment,
            **{key: value for key, value in extra.items() if value is not None},
        }
        # 实时日志：把每一步追加进 result.logs（保留最近 50 条，前端轮询它就能看到进度）
        previous = dict(task.result or {})
        logs = list(previous.get("logs") or [])
        logs.append({"at": moment, "stage": stage, "detail": detail})
        snapshot["logs"] = logs[-50:]
        try:
            task.result = {**previous, **snapshot}
            await session.flush()
            # 立刻提交：只 flush 的话进度压在任务自己的事务里，页面和接口都读不到——
            # 用户看到的就是「执行中」干等好几分钟（这正是「卡住了」的由来）。
            # 任务真正结束时 complete_task 会用最终结果整体覆盖，提前提交不会留脏数据。
            await session.commit()
        except Exception:  # noqa: BLE001 - 进度写不进去不能影响采集本身
            logger.debug("写入采集进度失败 task_id=%s", getattr(task, "id", ""))
        try:
            await self._publish_task_event(task, ok=True, detail=detail or stage)
        except Exception:  # noqa: BLE001
            logger.debug("推送采集进度失败 task_id=%s", getattr(task, "id", ""))

    async def _collect_group(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """采集群档案：资料 + 成员数 + 邀请链接；可选顺带抽样前 N 个成员。"""
        assert account is not None
        payload = dict(task.payload or {})
        dialog = await self._resolve_group_dialog(session, task, payload)
        tg_chat_id = int(payload.get("tg_chat_id") or dialog.tg_chat_id)
        client = self._client(account.id)
        entity = await self._resolve_entity(client, dialog, session) if dialog is not None else await resolve_chat_entity(client, tg_chat_id, session=session)

        try:
            full = await self._full_chat(client, entity)
        except Exception as exc:  # noqa: BLE001
            wait = flood_wait_seconds(exc)
            if wait:
                raise TaskFailure(
                    f"Telegram 限流，{wait} 秒后重试：{describe_exception(exc)}", retryable=True, requeue_after=wait + 1
                ) from exc
            raise TaskFailure(f"拉群资料失败：{describe_exception(exc)}", retryable=True) from exc

        fields = profile_fields_from_entity(entity, full)
        await self._report_progress(session, task, stage="fetching", detail="已读到群资料，正在写档案", tg_chat_id=tg_chat_id)
        profile = await upsert_profile(
            session,
            account_id=account.id,
            tg_chat_id=tg_chat_id,
            dialog_id=dialog.id if dialog is not None else None,
            source="profile_sync",
            raw={"collect": "collect_group"},
            **fields,
        )
        # 顺手把群标题/成员数同步到 dialogs，页面列表口径一致
        if dialog is not None:
            if fields.get("title"):
                dialog.title = str(fields["title"])[:255]
            if fields.get("member_count") is not None:
                dialog.member_count = int(fields["member_count"])
            if fields.get("username") is not None:
                dialog.username = fields["username"]
            await session.flush()

        sampled = 0
        sample_limit = int(payload.get("sample_members") or 0)
        if sample_limit > 0:
            sampled = await self._fetch_members(
                session,
                account=account,
                client=client,
                profile=profile,
                entity=entity,
                limit=sample_limit,
                task=task,
            )
            profile.member_sampled = int(profile.member_sampled or 0) + sampled
            profile.member_synced_at = _now()
            await session.flush()

        logger.info(
            "群档案采集完成",
            extra={
                "worker_id": self.worker.worker_id,
                "account_id": str(account.id),
                "task_id": str(task.id),
                "tg_chat_id": tg_chat_id,
                "member_count": profile.member_count,
                "sampled": sampled,
            },
        )
        return {
            "tg_chat_id": tg_chat_id,
            "title": profile.title,
            "kind": profile.kind,
            "member_count": profile.member_count,
            "sampled": sampled,
            "profile_id": str(profile.id),
        }

    async def _inspect_groups(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """筛群：批量体检一批群链接（只读）。

        运营要的是「这批群链接哪些还能用、值得进」——所以逐条给出：
        是否存在、类型（群 / 超级群 / 频道）、人数、**能否发言**、是否需要审核加入、
        是否隐藏成员名单、当前号是否已在群里。全程只读，不发消息、不加群。
        """
        assert account is not None
        payload = dict(task.payload or {})
        raw_links = [str(item).strip() for item in (payload.get("links") or []) if str(item).strip()]
        if not raw_links:
            raise TaskFailure("筛群任务缺少 links", retryable=False)
        client = self._client(account.id)
        rng = self._campaign_rng(task, payload)
        min_interval = self._interval_of(payload, "min_interval", 2.0)
        max_interval = self._interval_of(payload, "max_interval", 6.0)
        results: list[dict] = []
        ok_count = 0

        for index, raw in enumerate(raw_links[:200]):
            item: dict = {"input": raw, "ok": False}
            try:
                username = _username_from_target(raw) or raw.lstrip("@").strip()
                invite_hash = _invite_hash_of(raw)
                entity = None
                if invite_hash:
                    # 邀请链接：只能探到「是否有效」，拿不到群资料（未加入前 Telegram 不给）
                    try:
                        info = await client(functions.messages.CheckChatInviteRequest(hash=invite_hash))
                        chat = getattr(info, "chat", None)
                        title = getattr(chat, "title", None) or getattr(info, "title", None) or ""
                        item.update({"ok": True, "kind": "invite", "title": title,
                                     "already_joined": bool(getattr(info, "already", False))})
                    except BaseException as exc:  # noqa: BLE001
                        item["error"] = f"邀请链接无效或已过期（{type(exc).__name__}）"
                    results.append(item)
                    continue
                if username:
                    entity = await client.get_entity(f"@{username}")
                else:
                    item["error"] = "无法识别的群标识（支持 @用户名 / t.me/xxx / t.me/+hash）"
                    results.append(item)
                    continue

                is_channel = isinstance(entity, tl_types.Channel)
                item["kind"] = (
                    "channel" if getattr(entity, "broadcast", False) else "megagroup" if getattr(entity, "megagroup", False) else "chat"
                )
                item["kind_label"] = {"channel": "频道", "megagroup": "超级群", "chat": "普通群"}.get(item["kind"], item["kind"])
                item["title"] = getattr(entity, "title", "") or ""
                item["username"] = getattr(entity, "username", None)
                item["tg_chat_id"] = getattr(entity, "id", None)
                item["ok"] = True

                if is_channel:
                    full = await client(functions.channels.GetFullChannelRequest(channel=entity))
                    fc = full.full_chat
                    item["member_count"] = getattr(fc, "participants_count", None)
                    item["about"] = (getattr(fc, "about", "") or "")[:200]
                    item["members_hidden"] = bool(getattr(fc, "participants_hidden", False))
                    item["join_request"] = bool(getattr(fc, "join_request", False))
                    # 能否发言：看默认禁言权限（普通成员能不能发）
                    rights = getattr(fc, "default_banned_rights", None)
                    item["can_send"] = not bool(getattr(rights, "send_messages", False)) if rights else True
                    item["slowmode"] = getattr(fc, "slowmode_seconds", None)
                    try:
                        await client(functions.channels.GetParticipantRequest(channel=entity, participant="me"))
                        item["joined"] = True
                    except BaseException:  # noqa: BLE001 - 不在群里是常态
                        item["joined"] = False
                ok_count += 1
            except BaseException as exc:  # noqa: BLE001 - 单条失败不影响整批
                name = type(exc).__name__
                if "UsernameNotOccupied" in name or "UsernameInvalid" in name:
                    item["error"] = "这个用户名不存在"
                elif "ChannelPrivate" in name:
                    item["error"] = "私有群/频道，当前号无权访问（可能须先加入）"
                elif "Frozen" in name:
                    item["error"] = "当前号被冻结，无法体检"
                else:
                    item["error"] = f"{name}: {str(exc)[:100]}"
            results.append(item)

            if index < len(raw_links) - 1:
                await sleep_human(min_interval, max_interval, rng)
            if (index + 1) % 5 == 0:
                await self._report_progress(
                    session, task, stage="inspecting",
                    detail=f"已体检 {index + 1}/{len(raw_links)} 个链接，其中 {ok_count} 个可用",
                    scanned=index + 1, found=ok_count, total=len(raw_links),
                )

        await self._report_progress(
            session, task, stage="done",
            detail=f"体检完成：{len(raw_links)} 个链接，{ok_count} 个可用",
            scanned=len(raw_links), found=ok_count, total=len(raw_links),
        )
        return {"total": len(raw_links), "ok": ok_count, "failed": len(raw_links) - ok_count, "results": results[:200]}

    async def _store_discovered_chat(
        self,
        session: Any,
        account: TgAccount,
        chat: Any,
        *,
        source: str,
        raw: dict,
        full: Any = None,
    ) -> Optional[int]:
        """落档一个通过消息/推荐找到的公开群或频道；单条失败不影响整批。"""

        chat_id = int(getattr(chat, "id", 0) or 0)
        if not chat_id:
            return None
        try:
            await upsert_profile(
                session,
                account_id=account.id,
                tg_chat_id=chat_id,
                source=source,
                touch_collected_at=False,
                raw=raw,
                **profile_fields_from_entity(chat, full),
            )
            return chat_id
        except BaseException:  # noqa: BLE001 - 单个群落档失败不影响整批
            self.log.debug("发现链路落档失败 tg_chat_id=%s source=%s", chat_id, source)
            return None

    async def _store_invite_lead(
        self,
        session: Any,
        account: TgAccount,
        invite_hash: str,
        invite: Any,
        *,
        source: str,
        query: str,
        seed_chat_id: Optional[int],
        raw: dict,
    ) -> bool:
        """`CheckChatInvite` 只给标题/人数、不给实体 id 时，先落成私群线索。"""

        existing = await session.scalar(
            select(DiscoveryLead).where(
                DiscoveryLead.account_id == account.id,
                DiscoveryLead.invite_hash == invite_hash,
            )
        )
        title = str(getattr(invite, "title", "") or "")
        about = str(getattr(invite, "about", "") or "")
        members = getattr(invite, "participants_count", None)
        kind = "channel" if getattr(invite, "broadcast", False) else "group"
        if existing is not None:
            if title:
                existing.title = title[:255]
            if about:
                existing.about = about[:4000]
            if members is not None:
                existing.member_count = int(members)
            existing.raw = {**(existing.raw or {}), **raw}
            await session.flush()
            return False

        confidence = 0.45
        if title:
            confidence += 0.05
        if about:
            confidence += 0.05
        if members is not None:
            confidence += 0.05
        session.add(
            DiscoveryLead(
                account_id=account.id,
                invite_hash=invite_hash,
                invite_link=invite_url(invite_hash),
                title=title[:255],
                about=about[:4000],
                member_count=int(members) if members is not None else None,
                kind=kind,
                source=source,
                query=query,
                seed_chat_id=seed_chat_id,
                depth=1,
                confidence=min(confidence, 0.65),
                status="new",
                raw=raw,
            )
        )
        await session.flush()
        return True

    async def _verify_discovered_link(
        self,
        client: Any,
        session: Any,
        account: TgAccount,
        link: Any,
        *,
        source: str,
        query: str,
        seed_chat_id: Optional[int],
        metrics: dict,
        store_directly: bool = True,
        on_chat: Optional[Callable[[Any, str, Optional[int]], None]] = None,
        extra_raw: Optional[dict] = None,
        on_rpc: Optional[Callable[[], bool]] = None,
    ) -> Optional[dict]:
        """验证一个用户名/邀请链接；公开群按需落档或交付候选回调，私群落线索。"""

        raw = {
            "discovered_from": source,
            "seed_chat_id": seed_chat_id,
            "link": link.url,
            "query": query,
            "depth": 1,
            **(extra_raw or {}),
        }

        async def _handle_chat(chat: Any) -> Optional[dict]:
            chat_id = int(getattr(chat, "id", 0) or 0)
            if not chat_id:
                return None
            if store_directly:
                stored_id = await self._store_discovered_chat(session, account, chat, source=source, raw=raw)
                if stored_id is None:
                    return None
                chat_id = stored_id
            elif on_chat is not None:
                on_chat(chat, source, seed_chat_id)
            kind = "channel" if getattr(chat, "broadcast", False) else "group"
            return {
                "title": getattr(chat, "title", "") or "",
                "username": getattr(chat, "username", None),
                "tg_chat_id": chat_id,
                "kind": kind,
                "members": getattr(chat, "participants_count", None),
            }

        if link.kind == "username":
            if on_rpc is not None and not on_rpc():
                return None
            res = await client(functions.contacts.ResolveUsernameRequest(username=link.value))
            chats = list(getattr(res, "chats", []) or [])
            chat = next(
                (item for item in chats if str(getattr(item, "username", "") or "").casefold() == link.value),
                chats[0] if chats else None,
            )
            if chat is None:
                return None
            return await _handle_chat(chat)

        if on_rpc is not None and not on_rpc():
            return None
        res = await client(functions.messages.CheckChatInviteRequest(hash=link.value))
        if isinstance(res, (tl_types.ChatInviteAlready, tl_types.ChatInvitePeek)):
            chat = getattr(res, "chat", None)
            if chat is None:
                return None
            return await _handle_chat(chat)
        if isinstance(res, tl_types.ChatInvite):
            created = await self._store_invite_lead(
                session,
                account,
                link.value,
                res,
                source=source,
                query=query,
                seed_chat_id=seed_chat_id,
                raw=raw,
            )
            if created:
                metrics["invite_leads"] += 1
        return None

    async def _expand_from_messages(
        self,
        client: Any,
        session: Any,
        account: TgAccount,
        seeds: list[Any],
        *,
        task: Task,
        query: str,
        channel_limit: int,
        message_limit: int,
        max_links: int,
        rng: Any,
        metrics: dict,
        store_directly: bool = True,
        on_chat: Optional[Callable[[Any, str, Optional[int]], None]] = None,
        source_tag: str = "message_link",
        extra_raw: Optional[dict] = None,
        on_rpc_error: Optional[Callable[[BaseException], Awaitable[Any]]] = None,
        on_rpc: Optional[Callable[[], bool]] = None,
    ) -> list[dict]:
        """读种子频道/群最近消息，抓 t.me/@username 反查；若读不到且有公开频道页则兜底读 t.me/s/。"""

        found: list[dict] = []
        seen_links: set[tuple[str, str]] = set()
        channels = seeds[: max(0, channel_limit)]
        if max_links <= 0 or not channels:
            return []
        http_headers = {"User-Agent": "tgcc-discovery/1.0 (public preview reader)"}
        for index, seed in enumerate(channels):
            if len(seen_links) >= max_links:
                break
            seed_id = int(getattr(seed, "id", 0) or 0)
            seed_username = str(getattr(seed, "username", "") or "").strip()
            extracted_for_seed: list[Any] = []
            seed_seen: set[tuple[str, str]] = set()
            remaining = max_links - len(seen_links)
            if on_rpc is not None:
                page_count = max(1, (message_limit + 99) // 100)
                if any(not on_rpc() for _ in range(page_count)):
                    break
            flood_stop = False
            try:
                async for message in client.iter_messages(seed, limit=message_limit):
                    if len(seen_links) + len(extracted_for_seed) >= max_links:
                        break
                    text = getattr(message, "message", "") or ""
                    if text:
                        for item in extract_links([text], limit=remaining):
                            key = (item.kind, item.value)
                            if key not in seen_links and key not in seed_seen:
                                seed_seen.add(key)
                                extracted_for_seed.append(item)
                                if len(seen_links) + len(extracted_for_seed) >= max_links:
                                    break
            except BaseException as exc:  # noqa: BLE001 - 单个频道读不到就尝试 t.me/s 兜底
                metrics["message_errors"] += 1
                self.log.debug("读消息提链失败 seed=%s: %s", seed_id, exc)
                if on_rpc_error is not None and await on_rpc_error(exc):
                    break

            if (
                not extracted_for_seed
                and len(seen_links) < max_links
                and seed_username
                and bool(getattr(seed, "broadcast", False))
            ):
                try:
                    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=http_headers) as http:
                        resp = await http.get(tme_channel_preview_url(seed_username))
                    if resp.status_code == 200:
                        extracted_for_seed = parse_tme_channel_posts(
                            resp.text,
                            channel_username=seed_username,
                            limit=max_links - len(seen_links),
                        )
                except BaseException as exc:  # noqa: BLE001
                    self.log.debug("t.me/s 频道帖抓链失败 username=%s: %s", seed_username, exc)

            for link in extracted_for_seed:
                if len(seen_links) >= max_links:
                    break
                key = (link.kind, link.value)
                if key in seen_links:
                    continue
                seen_links.add(key)
                try:
                    hit = await self._verify_discovered_link(
                        client,
                        session,
                        account,
                        link,
                        source=source_tag,
                        query=query,
                        seed_chat_id=seed_id,
                        metrics=metrics,
                        store_directly=store_directly,
                        on_chat=on_chat,
                        on_rpc=on_rpc,
                        extra_raw=extra_raw,
                    )
                except BaseException as exc:  # noqa: BLE001 - 单条链接失败继续下一条
                    metrics["message_errors"] += 1
                    self.log.debug("消息链接验证失败 %s: %s", link.url, exc)
                    if on_rpc_error is not None and await on_rpc_error(exc):
                        flood_stop = True
                        break
                    hit = None
                if hit is not None:
                    found.append(hit)
                    metrics["message_profiles"] += 1
                if len(seen_links) >= max_links:
                    break
                await sleep_human(1.0, 2.2, rng)
            if flood_stop:
                break
            await self._report_progress(
                session,
                task,
                stage="expanding_messages",
                detail=(
                    f"已读 {index + 1}/{len(channels)} 个种子，发现 {len(seen_links)} 个链接，"
                    f"公开实体 {len(found)} 个"
                ),
                scanned=index + 1,
                found=len(found),
                total=len(channels),
            )
            if index < len(channels) - 1:
                await sleep_human(1.5, 3.0, rng)
        return found

    async def _expand_recommendations(
        self,
        client: Any,
        session: Any,
        account: TgAccount,
        seeds: list[Any],
        *,
        task: Task,
        query: str,
        channel_limit: int,
        rng: Any,
        metrics: dict,
        store_directly: bool = True,
        on_chat: Optional[Callable[[Any, str, Optional[int]], None]] = None,
        on_rpc_error: Optional[Callable[[BaseException], Awaitable[Any]]] = None,
        on_rpc: Optional[Callable[[], bool]] = None,
    ) -> list[dict]:
        """用 Telegram 的相似频道推荐扩展种子，仍然只读。"""

        found: list[dict] = []
        channels = seeds[: max(0, channel_limit)]
        for index, seed in enumerate(channels):
            seed_id = int(getattr(seed, "id", 0) or 0)
            if on_rpc is not None and not on_rpc():
                break
            try:
                res = await client(functions.channels.GetChannelRecommendationsRequest(channel=seed))
                for chat in list(getattr(res, "chats", []) or []):
                    chat_id = int(getattr(chat, "id", 0) or 0)
                    if not chat_id:
                        continue
                    if store_directly:
                        stored_id = await self._store_discovered_chat(
                            session,
                            account,
                            chat,
                            source="recommendation",
                            raw={
                                "discovered_from": "recommendation",
                                "seed_chat_id": seed_id,
                                "query": query,
                                "depth": 1,
                            },
                        )
                        if stored_id is None:
                            continue
                        chat_id = stored_id
                    elif on_chat is not None:
                        on_chat(chat, "recommendation", seed_id)
                    kind = "channel" if getattr(chat, "broadcast", False) else "group"
                    found.append(
                        {
                            "title": getattr(chat, "title", "") or "",
                            "username": getattr(chat, "username", None),
                            "tg_chat_id": chat_id,
                            "kind": kind,
                            "members": getattr(chat, "participants_count", None),
                        }
                    )
                    metrics["recommendation_profiles"] += 1
            except BaseException as exc:  # noqa: BLE001 - 单个种子失败继续下一个
                metrics["recommendation_errors"] += 1
                self.log.debug("频道推荐失败 seed=%s: %s", seed_id, exc)
                if on_rpc_error is not None and await on_rpc_error(exc):
                    break
            await self._report_progress(
                session,
                task,
                stage="expanding_recommendations",
                detail=f"已取 {index + 1}/{len(channels)} 个频道的相似推荐，新增 {len(found)} 个公开实体",
                scanned=index + 1,
                found=len(found),
                total=len(channels),
            )
            if index < len(channels) - 1:
                await sleep_human(2.0, 4.0, rng)
        return found

    async def _enrich_from_tme(self, session: Any, account: TgAccount, *, limit: int, metrics: dict) -> int:
        """访问 t.me 公开页补简介/成员数；只 GET，不带登录态。"""

        if limit <= 0:
            return 0
        rows = list(
            await session.scalars(
                select(GroupProfile)
                .where(GroupProfile.account_id == account.id, GroupProfile.username.is_not(None))
                .order_by(GroupProfile.updated_at.desc())
                .limit(limit)
            )
        )
        enriched = 0
        headers = {"User-Agent": "tgcc-discovery/1.0 (public preview reader)"}
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=headers) as http:
            for profile in rows:
                username = str(profile.username or "").strip()
                if not username:
                    continue
                try:
                    response = await http.get(tme_url(username))
                    if response.status_code != 200:
                        metrics["tme_errors"] += 1
                        continue
                    parsed = parse_tme_page(response.text, username=username)
                    if not parsed.get("title") and not parsed.get("about") and parsed.get("member_count") is None:
                        metrics["tme_errors"] += 1
                        continue
                    await upsert_profile(
                        session,
                        account_id=account.id,
                        tg_chat_id=int(profile.tg_chat_id),
                        title=str(parsed.get("title") or ""),
                        about=str(parsed.get("about") or ""),
                        member_count=parsed.get("member_count"),
                        is_public=True,
                        source="tme_preview",
                        touch_collected_at=False,
                        raw={"tme_preview": parsed, "tme_url": tme_url(username)},
                    )
                    enriched += 1
                    metrics["tme_enriched"] += 1
                except BaseException as exc:  # noqa: BLE001 - 单个页面失败不影响整批
                    metrics["tme_errors"] += 1
                    self.log.debug("t.me 富化失败 username=%s: %s", username, exc)
        return enriched

    async def _search_groups(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """按关键词找公开群：原生搜索 + 查询扩展 + linked_chat 讨论群展开。

        做法不是把 `contacts.Search` 的 limit 调大（它没有 offset，调大也没用），而是：

        1. 把「主题词 + 地区 + 语言」展开成多条查询，原始关键词永远先跑；
        2. 搜索阶段用 `kind=any` 的思路**把频道也落档当种子**，不再提前把频道滤掉；
        3. 对公开频道调 `GetFullChannel`，顺着 `linked_chat_id` 把讨论群补进来。

        全程只读：`contacts.Search` / `GetFullChannel` 都不加群、不发消息。
        """
        assert account is not None
        # 只读搜索：冻结号也能连上并读取，只有写操作会被 Telegram 拒绝，
        # 所以这里不能套 _ensure_sendable（它会把冻结号直接挡掉）。
        payload = dict(task.payload or {})
        if str(payload.get("mode") or "") == "precise":
            return await self._search_groups_precise(session, task, account, payload)
        keywords = [k for k in (clean_keyword(item) for item in (payload.get("keywords") or [])) if k][:20]
        if not keywords:
            raise TaskFailure("找群任务缺少关键词", retryable=False)
        per_keyword = max(1, min(int(payload.get("limit") or 50), 100))
        min_members = max(0, int(payload.get("min_members") or 0))
        want = str(payload.get("kind") or "any")  # any / group / channel
        regions = [str(item).strip() for item in (payload.get("regions") or []) if str(item).strip()][:10]
        languages = [str(item).strip() for item in (payload.get("languages") or []) if str(item).strip()][:5]
        max_queries = max(1, min(int(payload.get("max_queries") or 120), 300))
        expand_linked = bool(payload.get("expand_linked_chats", True))
        max_linked = max(0, min(int(payload.get("max_linked_chats") or 50), 200))
        expand_messages = bool(payload.get("expand_messages", True))
        message_channels = max(0, min(int(payload.get("message_channels") or 10), 50))
        message_limit = max(20, min(int(payload.get("message_limit") or 200), 500))
        expand_recommendations = bool(payload.get("expand_recommendations", True))
        recommendation_channels = max(0, min(int(payload.get("recommendation_channels") or 10), 50))
        enrich_tme = bool(payload.get("enrich_tme", True))
        tme_limit = max(0, min(int(payload.get("tme_limit") or 50), 200))
        max_links = max(0, min(int(payload.get("max_links") or 100), 300))

        disabled_queries = list(
            await session.scalars(select(DiscoveryQueryStat.query).where(DiscoveryQueryStat.enabled.is_(False)))
        )
        queries = expand_queries(
            keywords,
            regions=regions,
            languages=languages,
            max_queries=max_queries,
            exclude=disabled_queries,
        )
        if not queries:
            raise TaskFailure("找群任务没有生成可用查询", retryable=False)
        client = self._client(account.id)
        rng = self._campaign_rng(task, payload)

        results: list[dict] = []
        seen_entities: set[int] = set()
        hit_ids: set[int] = set()
        seed_channels: dict[int, Any] = {}
        linked_hits: list[dict] = []
        metrics = {
            "raw_chats": 0,
            "stored_entities": 0,
            "duplicates": 0,
            "dropped_kind": 0,
            "dropped_members": 0,
            "query_errors": 0,
            "linked_expanded": 0,
            "linked_found": 0,
            "linked_errors": 0,
            "message_profiles": 0,
            "invite_leads": 0,
            "recommendation_profiles": 0,
            "tme_enriched": 0,
            "message_errors": 0,
            "recommendation_errors": 0,
            "tme_errors": 0,
            "discovered_hits": 0,
        }

        def chat_kind(chat: Any) -> str:
            if getattr(chat, "megagroup", False):
                return "group"
            if getattr(chat, "broadcast", False):
                return "channel"
            return "group"

        def hit_payload(chat: Any, kind: str, members: Optional[int]) -> dict:
            return {
                "title": getattr(chat, "title", None) or "",
                "username": getattr(chat, "username", None),
                "tg_chat_id": int(getattr(chat, "id", 0) or 0),
                "kind": kind,
                "members": members,
            }

        async def store_chat(
            chat: Any,
            *,
            source: str,
            raw: dict,
            full: Any = None,
        ) -> bool:
            """落档一个群/频道；失败只记日志，不影响整批搜索。"""

            chat_id = int(getattr(chat, "id", 0) or 0)
            if not chat_id:
                return False
            try:
                await upsert_profile(
                    session,
                    account_id=account.id,
                    tg_chat_id=chat_id,
                    source=source,
                    touch_collected_at=False,
                    raw=raw,
                    **profile_fields_from_entity(chat, full),
                )
                return True
            except BaseException:  # noqa: BLE001 - 单个群落档失败不影响整批
                self.log.debug("落档失败 tg_chat_id=%s source=%s", chat_id, source)
                return False

        try:
            for index, item in enumerate(queries):
                try:
                    res = await client(functions.contacts.SearchRequest(q=item.query, limit=per_keyword))
                except BaseException as exc:  # noqa: BLE001 - 单条查询失败继续下一条
                    metrics["query_errors"] += 1
                    results.append(
                        {
                            "query": item.query,
                            "keyword": item.keyword,
                            "region": item.region,
                            "lang": item.lang,
                            "ok": False,
                            "error": f"{type(exc).__name__}: {str(exc)[:100]}",
                        }
                    )
                    try:
                        await _record_query_stat(
                            session,
                            item,
                            raw_count=0,
                            found_count=0,
                            error=f"{type(exc).__name__}: {str(exc)[:200]}",
                        )
                    except BaseException:  # noqa: BLE001 - 绩效记录失败不影响搜索
                        self.log.debug("查询绩效记录失败 query=%s", item.query)
                    continue

                raw_chats = list(getattr(res, "chats", []) or [])
                metrics["raw_chats"] += len(raw_chats)
                hits: list[dict] = []
                for chat in raw_chats:
                    chat_id = int(getattr(chat, "id", 0) or 0)
                    if not chat_id:
                        continue
                    kind = chat_kind(chat)
                    members = getattr(chat, "participants_count", None)
                    is_new = chat_id not in seen_entities
                    if is_new:
                        seen_entities.add(chat_id)
                        # 频道也落档：即使本次只要群，频道仍是 linked_chat 的种子。
                        if await store_chat(
                            chat,
                            source="keyword_search",
                            raw={
                                "role": "seed" if kind == "channel" else "result",
                                "query": item.query,
                                "keyword": item.keyword,
                                "region": item.region,
                                "lang": item.lang,
                            },
                        ):
                            metrics["stored_entities"] += 1
                        if kind == "channel" and getattr(chat, "broadcast", False):
                            seed_channels.setdefault(chat_id, chat)
                    else:
                        metrics["duplicates"] += 1

                    if want != "any" and kind != want:
                        metrics["dropped_kind"] += 1
                        continue
                    if min_members and (members or 0) < min_members:
                        metrics["dropped_members"] += 1
                        continue
                    if chat_id in hit_ids:
                        continue
                    hit_ids.add(chat_id)
                    hits.append(hit_payload(chat, kind, members))

                try:
                    await _record_query_stat(
                        session,
                        item,
                        raw_count=len(raw_chats),
                        found_count=len(hits),
                    )
                except BaseException:  # noqa: BLE001 - 绩效记录失败不影响搜索
                    self.log.debug("查询绩效记录失败 query=%s", item.query)
                results.append(
                    {
                        "query": item.query,
                        "keyword": item.keyword,
                        "region": item.region,
                        "lang": item.lang,
                        "template": item.template,
                        "ok": True,
                        "found": len(hits),
                        "chats": hits[:50],
                    }
                )
                await self._report_progress(
                    session,
                    task,
                    stage="searching",
                    detail=(
                        f"查询「{item.query}」找到 {len(hits)} 个（累计 {len(hit_ids)} 个，"
                        f"已存 {len(seen_entities)} 个实体）"
                    ),
                    scanned=index + 1,
                    found=len(hit_ids),
                    total=len(queries),
                )
                if index < len(queries) - 1:
                    await sleep_human(2.0, 5.0, rng)

            # 第二段：从公开频道顺 linked_chat 找讨论群。只读，不需要入群。
            candidates = list(seed_channels.values())
            if expand_linked and max_linked and candidates:
                candidates = candidates[:max_linked]
                for index, seed in enumerate(candidates):
                    seed_id = int(getattr(seed, "id", 0) or 0)
                    metrics["linked_expanded"] += 1
                    try:
                        full = await client(functions.channels.GetFullChannelRequest(channel=seed))
                        linked_id = int(getattr(getattr(full, "full_chat", None), "linked_chat_id", 0) or 0)
                        if not linked_id:
                            continue
                        linked = next(
                            (
                                chat
                                for chat in (getattr(full, "chats", []) or [])
                                if int(getattr(chat, "id", 0) or 0) == linked_id
                            ),
                            None,
                        )
                        if linked is None:
                            linked = await client.get_entity(tl_types.PeerChannel(linked_id))
                        kind = chat_kind(linked)
                        members = getattr(linked, "participants_count", None)
                        if linked_id not in seen_entities:
                            linked_full = None
                            try:
                                linked_full = await client(functions.channels.GetFullChannelRequest(channel=linked))
                            except BaseException:  # noqa: BLE001 - 拿不到完整信息就先用实体字段
                                linked_full = None
                            if await store_chat(
                                linked,
                                source="linked_chat",
                                raw={
                                    "role": "linked",
                                    "linked_from": seed_id,
                                    "seed_username": getattr(seed, "username", None),
                                },
                                full=linked_full,
                            ):
                                metrics["stored_entities"] += 1
                                seen_entities.add(linked_id)
                        if want != "any" and kind != want:
                            metrics["dropped_kind"] += 1
                            continue
                        if min_members and (members or 0) < min_members:
                            metrics["dropped_members"] += 1
                            continue
                        if linked_id not in hit_ids:
                            hit_ids.add(linked_id)
                            linked_hits.append(hit_payload(linked, kind, members))
                            metrics["linked_found"] += 1
                    except BaseException as exc:  # noqa: BLE001 - 单个频道失败继续下一个
                        metrics["linked_errors"] += 1
                        self.log.debug("linked_chat 展开失败 seed=%s: %s", seed_id, exc)
                        continue
                    finally:
                        await self._report_progress(
                            session,
                            task,
                            stage="expanding_linked",
                            detail=(
                                f"已展开 {index + 1}/{len(candidates)} 个频道，"
                                f"额外找到 {len(linked_hits)} 个讨论群"
                            ),
                            scanned=index + 1,
                            found=len(hit_ids),
                            total=len(candidates),
                        )
                    if index < len(candidates) - 1:
                        await sleep_human(1.5, 3.0, rng)

            # 第三段：结果扩展（图扩散 depth=1）。只读：读最近消息里的链接、取相似推荐、
            # 访问 t.me 公开页；不加入、不发言、不给群主发消息。
            discovered_hits: list[dict] = []
            seeds = list(seed_channels.values())
            query_label = ", ".join(keywords[:3])
            if expand_messages and max_links and message_channels and seeds:
                found = await self._expand_from_messages(
                    client,
                    session,
                    account,
                    seeds,
                    task=task,
                    query=query_label,
                    channel_limit=message_channels,
                    message_limit=message_limit,
                    max_links=max_links,
                    rng=rng,
                    metrics=metrics,
                )
                discovered_hits.extend(found)
            if expand_recommendations and recommendation_channels and seeds:
                found = await self._expand_recommendations(
                    client,
                    session,
                    account,
                    seeds,
                    task=task,
                    query=query_label,
                    channel_limit=recommendation_channels,
                    rng=rng,
                    metrics=metrics,
                )
                discovered_hits.extend(found)
            if enrich_tme and tme_limit:
                await self._report_progress(
                    session,
                    task,
                    stage="enriching_tme",
                    detail=f"正在补 {tme_limit} 个公开实体的 t.me 简介/成员数",
                    scanned=0,
                    found=len(discovered_hits),
                    total=tme_limit,
                )
                await self._enrich_from_tme(session, account, limit=tme_limit, metrics=metrics)

            for hit in discovered_hits:
                hit_id = int(hit.get("tg_chat_id") or 0)
                if not hit_id:
                    continue
                if want != "any" and hit.get("kind") != want:
                    metrics["dropped_kind"] += 1
                    continue
                if min_members and (hit.get("members") or 0) < min_members:
                    metrics["dropped_members"] += 1
                    continue
                if hit_id in hit_ids:
                    continue
                hit_ids.add(hit_id)
                metrics["discovered_hits"] += 1
        except BaseException as exc:  # noqa: BLE001
            await self._apply_status(session, account, exc)
            raise self._failure(exc, "按关键词找群失败") from exc

        total = sum(item.get("found", 0) for item in results if item.get("ok")) + len(linked_hits) + metrics["discovered_hits"]
        return {
            "keywords": keywords,
            "queries": [item.query for item in queries],
            "queries_run": len(queries),
            "unique_groups": len(hit_ids),
            "unique_entities": len(seen_entities),
            "total_hits": total,
            "linked_chats": linked_hits[:100],
            "discovered_chats": discovered_hits[:100],
            "metrics": metrics,
            "results": results,
            "summary": (
                f"{len(keywords)} 个原始关键词展开为 {len(queries)} 条查询，"
                f"共找到 {len(hit_ids)} 个不同的群/频道（落档 {len(seen_entities)} 个实体）；"
                f"linked_chat 额外 {len(linked_hits)} 个讨论群；"
                f"消息链接发现 {metrics['message_profiles']} 个公开实体、{metrics['invite_leads']} 个私群线索；"
                f"相似推荐 {metrics['recommendation_profiles']} 个；t.me 富化 {metrics['tme_enriched']} 个"
            ),
        }

    @staticmethod
    def _shard_list(items: list[Any], account_index: int, account_count: int) -> list[Any]:
        if account_count <= 1:
            return list(items)
        idx = max(0, int(account_index)) % int(account_count)
        return list(items)[idx::account_count]

    @staticmethod
    def _peer_chat_id(peer: Any) -> Optional[int]:
        chat_id = getattr(peer, "channel_id", None) or getattr(peer, "chat_id", None)
        return int(chat_id) if chat_id else None

    @staticmethod
    def _chat_members_of(chat: Any, full_chat: Any = None, tme_info: Optional[dict] = None) -> Optional[int]:
        raw = getattr(full_chat, "participants_count", None) if full_chat is not None else None
        if raw is None or raw == 0:
            raw = getattr(chat, "participants_count", None)
        if (raw is None or raw == 0) and tme_info:
            raw = tme_info.get("member_count")
        if raw is None:
            return None
        count = int(raw)
        # 未拉 GetFullChannel 时部分实体默认返回 0，按未知处理以免被当成小群误扣分。
        if count == 0 and full_chat is None and not (tme_info and tme_info.get("member_count") == 0):
            return None
        return count

    async def _sample_group_activity(
        self,
        client: Any,
        chat: Any,
        *,
        keywords: list[str],
        now: datetime,
        on_rpc_error: Optional[Callable[[BaseException], Awaitable[Any]]] = None,
        on_rpc: Optional[Callable[[], bool]] = None,
    ) -> tuple[Optional[dict[str, Any]], list[str]]:
        """只读抽样最近 20 条消息，统计 3 个月/7 天活跃度、发言人数与广告链接占比。"""

        cutoff_7d = now - timedelta(days=7)
        cutoff_90d = now - timedelta(days=90)
        topics = canonical_topics(keywords)
        match_terms = list(
            dict.fromkeys(
                [
                    *keywords,
                    *_keyword_tokens(keywords),
                    *(term for topic in topics for term in TOPIC_TERMS.get(topic, ())),
                ]
            )
        )
        total_sampled = 0
        recent_7d = 0
        recent_90d = 0
        last_message_at: Optional[datetime] = None
        ad_count = 0
        keyword_hits = 0
        senders: set[int] = set()
        samples: list[str] = []
        try:
            if on_rpc is not None and not on_rpc():
                return None, []
            async for message in client.iter_messages(chat, limit=20):
                total_sampled += 1
                msg_date = getattr(message, "date", None)
                if msg_date is not None:
                    aware = msg_date if msg_date.tzinfo else msg_date.replace(tzinfo=timezone.utc)
                    if aware >= cutoff_7d:
                        recent_7d += 1
                    if aware >= cutoff_90d:
                        recent_90d += 1
                    if last_message_at is None or aware > last_message_at:
                        last_message_at = aware
                sender_id = getattr(message, "sender_id", None)
                if sender_id:
                    senders.add(int(sender_id))
                text = " ".join(str(getattr(message, "message", "") or "").split())
                if text:
                    lowered = text.casefold()
                    if (
                        "http://" in lowered
                        or "https://" in lowered
                        or "t.me/" in lowered
                        or re.search(r"(?<![\w/@])@[a-z0-9_]{4,}", lowered)
                    ):
                        ad_count += 1
                    if any(_contains(text, term) for term in match_terms):
                        keyword_hits += 1
                    if len(samples) < 5:
                        samples.append(text[:120])
        except BaseException as exc:  # noqa: BLE001 - 未加群读不到历史属于正常受限，不能惩罚
            if on_rpc_error is not None:
                await on_rpc_error(exc)
            return None, []

        ad_ratio = (ad_count / total_sampled) if total_sampled else 0.0
        return {
            "checked": True,
            "total_sampled": total_sampled,
            "recent_7d": recent_7d,
            "recent_90d": recent_90d,
            "last_message_days": (now - last_message_at).days if last_message_at else None,
            "unique_senders": len(senders),
            "ad_ratio": round(ad_ratio, 2),
            "keyword_hits": keyword_hits,
        }, samples

    async def _enrich_candidates_from_tme(
        self,
        candidates: dict[int, dict[str, Any]],
        target_ids: list[int],
        *,
        metrics: dict,
    ) -> None:
        """对未拉取 GetFullChannel 且缺少简介的公开候选补抓 t.me 公开页（零账号配额消耗）。"""

        if not target_ids:
            return
        headers = {"User-Agent": "tgcc-discovery/1.0 (public preview reader)"}
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=headers) as http:
            for chat_id in target_ids:
                entry = candidates.get(chat_id)
                if not entry:
                    continue
                username = str(getattr(entry["chat"], "username", "") or "").strip()
                if not username:
                    continue
                try:
                    resp = await http.get(tme_url(username))
                    if resp.status_code != 200:
                        continue
                    parsed = parse_tme_page(resp.text, username=username)
                    if parsed.get("title") or parsed.get("about") or parsed.get("member_count") is not None:
                        entry["tme"] = parsed
                        metrics["tme_enriched"] += 1
                except BaseException:  # noqa: BLE001
                    metrics["tme_errors"] += 1

    async def _search_groups_precise(
        self,
        session: Any,
        task: Task,
        account: TgAccount,
        payload: dict,
    ) -> dict:
        """多语言精准检索：AI/规则扩词 → 多源召回（含分片与图扩散） → 优先全检/验活 → 评分与 AI 复核。"""

        keywords = [k for k in (clean_keyword(item) for item in (payload.get("keywords") or [])) if k][:20]
        if not keywords:
            raise TaskFailure("精准检索缺少关键词", retryable=False)

        def payload_int(name: str, default: int, lower: int, upper: int) -> int:
            raw = payload.get(name)
            try:
                value = default if raw is None else int(raw)
            except (TypeError, ValueError):
                value = default
            return max(lower, min(value, upper))

        country = str(payload.get("country") or "").strip().upper() or None
        languages = [str(item).strip() for item in (payload.get("languages") or []) if str(item).strip()][:6]
        per_query = payload_int("limit", 50, 1, 100)
        min_members = max(0, int(payload.get("min_members") or 0))
        max_queries = payload_int("max_queries", 120, 1, 300)
        group_only = bool(payload.get("group_only", True))
        public_only = bool(payload.get("public_only", True))
        exclude_readonly = bool(payload.get("exclude_readonly", True))
        # 简化筛选：只保留「近 3 个月有消息 + 可发言」，其余评分/成员数/AI 规则不参与判定。
        simple_screen = bool(payload.get("simple_screen", True))
        enable_contacts_search = bool(payload.get("enable_contacts_search", True))
        contacts_query_limit = payload_int("contacts_query_limit", max_queries, 0, 300)
        include_linked = bool(payload.get("include_linked_groups", True))
        max_linked = payload_int("max_linked_chats", 50, 0, 200)
        search_messages = bool(payload.get("search_messages", True))
        message_queries = payload_int("message_search_queries", 5, 0, 20)
        message_pages = payload_int("message_search_pages", 2, 1, 5)
        full_check_limit = payload_int("full_check_limit", 60, 0, 200)
        min_score = payload_int("min_relevance_score", 60, 0, 100)
        expand_short = bool(payload.get("expand_short_queries", True))
        raw_short_limit = payload.get("short_query_limit")
        short_limit = 0 if raw_short_limit == 0 else payload_int("short_query_limit", 20, 0, 80)
        expand_recommendations = bool(payload.get("expand_recommendations", True))
        recommendation_channels = payload_int("recommendation_channels", 8, 0, 30)
        expand_channel_messages = bool(payload.get("expand_channel_messages", True))
        message_channels = payload_int("message_channels", 8, 0, 30)
        message_limit = payload_int("message_limit", 100, 20, 300)
        scan_joined_groups = bool(payload.get("scan_joined_groups", True))
        joined_group_limit = payload_int("joined_group_limit", 15, 0, 100)
        enrich_tme = bool(payload.get("enrich_tme", True))
        tme_limit = payload_int("tme_limit", 30, 0, 100)
        expand_scope_preset = bool(payload.get("expand_scope_preset", False))
        expand_channel_posts = bool(payload.get("expand_channel_posts", False)) or expand_scope_preset
        channel_posts_query_limit = payload_int("channel_posts_query_limit", 5, 0, 20)
        allow_paid_channel_posts = bool(payload.get("allow_paid_channel_posts", False))
        channel_posts_max_stars = payload_int("channel_posts_max_stars", 0, 0, 500)
        expand_external_web = bool(payload.get("expand_external_web", False)) or expand_scope_preset
        external_web_query_limit = payload_int("external_web_query_limit", 3, 1, 10)
        external_web_candidate_limit = payload_int("external_web_candidate_limit", 30, 0, 200)
        allow_paid_external_search = bool(payload.get("allow_paid_external_search", False))
        expand_common_chats = bool(payload.get("expand_common_chats", False)) or expand_scope_preset
        common_chat_user_limit = payload_int("common_chat_user_limit", 8, 0, 25)
        rpc_budget = payload_int("rpc_budget", 180, 20, 500)
        verify_activity = simple_screen or bool(payload.get("verify_activity", True))
        activity_check_limit = payload_int("activity_check_limit", 25, 0, 60)
        ai_expand = bool(payload.get("ai_expand", False))
        ai_review = bool(payload.get("ai_review", False))

        dispatch = str(payload.get("dispatch") or "round_robin").strip()
        account_index = max(0, int(payload.get("account_index") or 0))
        account_count = max(1, int(payload.get("account_count") or 1))
        shard_mode = dispatch != "each" and account_count > 1
        batch_id = str(payload.get("batch_id") or "") or None

        raw_candidate_links = payload.get("candidate_links") or []
        if isinstance(raw_candidate_links, str):
            raw_candidate_links = [raw_candidate_links]
        candidate_links = [str(item).strip() for item in raw_candidate_links if str(item).strip()][:200]
        parsed_links = extract_links(candidate_links, limit=200) if candidate_links else []

        disabled_queries = list(
            await session.scalars(select(DiscoveryQueryStat.query).where(DiscoveryQueryStat.enabled.is_(False)))
        )
        queries = expand_queries(
            keywords,
            regions=[country] if country else [],
            languages=languages,
            max_queries=max_queries,
            exclude=disabled_queries,
        )
        has_any_channel = bool(
            (enable_contacts_search and queries)
            or (search_messages and message_queries and queries)
            or parsed_links
            or expand_external_web
            or (expand_channel_posts and channel_posts_query_limit and queries)
            or scan_joined_groups
            or expand_common_chats
        )
        if not has_any_channel:
            raise TaskFailure("精准检索没有生成可用查询或启用任何召回来源", retryable=False)

        short_items: list[SearchQuery] = []
        seen_query_keys = {item.query.casefold() for item in queries}
        if expand_short and short_limit and queries:
            short_items = [
                item
                for item in build_short_queries(
                    keywords,
                    regions=[country] if country else [],
                    limit=short_limit,
                    strict_topic=True,
                )
                if item.query.casefold() not in seen_query_keys
            ]

        if shard_mode:
            sharded_queries = self._shard_list(queries, account_index, account_count)
            short_items = self._shard_list(short_items, account_index, account_count)
            links = self._shard_list(parsed_links, account_index, account_count)
        else:
            sharded_queries = list(queries)
            links = list(parsed_links)

        # AI 扩词只在分片后追加给主分片，避免多账号索引错位导致重复搜或漏搜规则词。
        ai_notes: list[str] = []
        note_seen: set[str] = set()

        def push_note(msg: str) -> None:
            cleaned = str(msg or "").strip()
            if cleaned and cleaned not in note_seen:
                note_seen.add(cleaned)
                ai_notes.append(cleaned)

        if ai_expand and (not shard_mode or account_index == 0):
            ai_extra_queries, ai_exp_note = await expand_queries_with_ai(
                keywords,
                country=country,
                languages=languages,
                limit=12,
            )
            if ai_exp_note:
                push_note(ai_exp_note)
            disabled_keys = {" ".join(str(x).split()).casefold() for x in disabled_queries if x}
            short_keys = {item.query.casefold() for item in short_items}
            for extra in ai_extra_queries:
                cleaned = " ".join(str(extra or "").split())
                key = cleaned.casefold()
                if (
                    not cleaned
                    or len(cleaned) > 64
                    or key in seen_query_keys
                    or key in short_keys
                    or key in disabled_keys
                ):
                    continue
                seen_query_keys.add(key)
                sharded_queries.append(
                    SearchQuery(
                        query=cleaned,
                        keyword=keywords[0],
                        template="ai_expand",
                        region=country,
                        lang=None,
                    )
                )

        contacts_queries = sharded_queries[:contacts_query_limit] if (enable_contacts_search and contacts_query_limit) else []
        msg_query_pool = sharded_queries[:message_queries] if (search_messages and message_queries) else []
        post_query_pool = (
            sharded_queries[:channel_posts_query_limit]
            if (expand_channel_posts and channel_posts_query_limit)
            else []
        )

        # 评分仅依据用户输入的原始关键词，绝不把 short_core 兜底词混入评分！
        scoring_keywords = list(keywords)
        short_run = 0

        has_shard_work = bool(
            contacts_queries
            or msg_query_pool
            or (expand_short and short_items)
            or links
            or post_query_pool
            or (expand_external_web and (not shard_mode or account_index == 0))
            or scan_joined_groups
            or (expand_common_chats and common_chat_user_limit > 0)
        )
        if shard_mode and not has_shard_work:
            await self._report_progress(
                session,
                task,
                stage="done",
                detail="本账号分片未分配到额外查询（已由同批其他账号执行）",
                scanned=0,
                found=0,
                total=0,
            )
            return {
                "mode": "precise",
                "keywords": keywords,
                "country": country,
                "languages": languages,
                "queries_run": 0,
                "short_queries_run": 0,
                "candidate_links": 0,
                "min_relevance_score": min_score,
                "candidates": 0,
                "accepted": 0,
                "needs_review": 0,
                "rejected": 0,
                "average_score": 0,
                "ai_notes": ai_notes,
                "source_stats": {},
                "pending_candidates": [],
                "metrics": {},
                "summary": "精准检索（分片空闲）：本账号未分到查询词",
            }

        client = self._client(account.id)
        rng = self._campaign_rng(task, payload)
        metrics: dict[str, Any] = {
            "queries": len(contacts_queries),
            "short_queries": 0,
            "short_raw_chats": 0,
            "raw_chats": 0,
            "candidates": 0,
            "candidate_links": len(links),
            "candidate_found": 0,
            "candidate_errors": 0,
            "invite_leads": 0,
            "message_raw_chats": 0,
            "message_errors": 0,
            "query_errors": 0,
            "local_found": 0,
            "local_errors": 0,
            "joined_found": 0,
            "linked_found": 0,
            "linked_errors": 0,
            "message_profiles": 0,
            "recommendation_profiles": 0,
            "recommendation_errors": 0,
            "channel_posts_seeds": 0,
            "channel_posts_errors": 0,
            "external_queries": 0,
            "external_links": 0,
            "external_errors": 0,
            "common_chat_checked": 0,
            "common_chat_found": 0,
            "tme_enriched": 0,
            "tme_errors": 0,
            "full_checked": 0,
            "full_cached": 0,
            "full_errors": 0,
            "activity_checked": 0,
            "ai_reviewed": 0,
            "rpc_used": 0,
            "accepted": 0,
            "needs_review": 0,
            "rejected": 0,
            "channels": 0,
            "readonly": 0,
            "dropped_members": 0,
            "score_sum": 0,
        }
        source_stats: dict[str, int] = {}
        candidates: dict[int, dict[str, Any]] = {}
        pending_candidates: list[dict[str, Any]] = []
        seen_pending: set[tuple[str, str]] = set()

        def record_source_meta(
            entry: dict[str, Any],
            *,
            source: str,
            query: str,
            keyword: str,
            evidence_extra: Optional[dict[str, Any]] = None,
            joined: bool = False,
        ) -> None:
            norm_src = normalize_search_source(source)
            if norm_src not in entry["sources"]:
                entry["sources"].append(norm_src)
            entry["source_counts"][norm_src] = entry["source_counts"].get(norm_src, 0) + 1
            source_stats[norm_src] = source_stats.get(norm_src, 0) + 1
            if joined or norm_src in (
                SearchSource.JOINED_GROUP_GRAPH.value,
                SearchSource.COMMON_CHAT_GRAPH.value,
            ):
                entry["joined"] = True
            ev = {
                "source": norm_src,
                "query": str(query or "")[:120],
                "keyword": str(keyword or "")[:80],
                **(evidence_extra or {}),
            }
            ev_key = (ev["source"], ev.get("query"), ev.get("link"), ev.get("seed_chat_id"), ev.get("tg_user_id"))
            if ev_key not in entry["_ev_keys"] and len(entry["evidence"]) < 15:
                entry["_ev_keys"].add(ev_key)
                entry["evidence"].append(ev)

        def add_candidate(
            chat: Any,
            *,
            source: str,
            query: str,
            keyword: str,
            bump_message_hit: bool = False,
            evidence_extra: Optional[dict[str, Any]] = None,
            joined: bool = False,
        ) -> Optional[int]:
            chat_id = int(getattr(chat, "id", 0) or 0)
            if not chat_id:
                return None
            norm_src = normalize_search_source(source)
            entry = candidates.get(chat_id)
            if entry is None:
                entry = {
                    "chat": chat,
                    "sources": [],
                    "source_counts": {},
                    "evidence": [],
                    "_ev_keys": set(),
                    "query": query,
                    "keyword": keyword,
                    "full": None,
                    "cached": None,
                    "tme": None,
                    "activity": None,
                    "samples": [],
                    "message_hits": 0,
                    "joined": False,
                }
                candidates[chat_id] = entry
                metrics["candidates"] += 1
            elif not entry["query"] and query:
                entry["query"] = query
            record_source_meta(
                entry,
                source=norm_src,
                query=query,
                keyword=keyword,
                evidence_extra=evidence_extra,
                joined=joined,
            )
            if bump_message_hit:
                entry["message_hits"] += 1
            return chat_id

        def add_pending_candidate(
            link: ExtractedLink,
            *,
            source: str,
            query: str,
            reason: str,
            adapter: str = "",
        ) -> None:
            if link.kind != "username":
                return
            key = (link.kind, link.value.casefold())
            if key in seen_pending or len(pending_candidates) >= 200:
                return
            seen_pending.add(key)
            pending_candidates.append(
                {
                    "url": link.url,
                    "kind": link.kind,
                    "value": link.value,
                    "source": normalize_search_source(source),
                    "adapter": adapter,
                    "query": str(query or "")[:120],
                    "status_label": "外部发现，尚未验证",
                    "reason": str(reason or "尚未通过 Telegram 实体验证")[:160],
                }
            )

        def on_expanded_chat(chat: Any, source_tag: str, seed_id: Optional[int]) -> None:
            add_candidate(
                chat,
                source=source_tag,
                query="",
                keyword=keywords[0],
                evidence_extra={"seed_chat_id": seed_id} if seed_id else None,
            )

        async def record_keyword(
            query: str, source: str, *, status: str, raw: int, found: int, error: str = ""
        ) -> None:
            norm_src = normalize_search_source(source)[:24]
            await session.execute(
                pg_insert(GroupSearchKeyword)
                .values(
                    id=uuid.uuid4(),
                    task_id=task.id,
                    account_id=account.id,
                    query=query[:255],
                    source=norm_src,
                    status=status,
                    raw_count=raw,
                    found_count=found,
                    error=error[:1000],
                )
                .on_conflict_do_update(
                    index_elements=["task_id", "source", "query"],
                    set_={
                        "status": status,
                        "raw_count": raw,
                        "found_count": found,
                        "error": error[:1000],
                        "updated_at": _now(),
                    },
                )
            )

        flood_hit: Optional[int] = None
        budget_hit = False

        def take_rpc(cost: int = 1) -> bool:
            nonlocal budget_hit
            if flood_hit:
                return False
            if metrics["rpc_used"] + cost > rpc_budget:
                if not budget_hit:
                    budget_hit = True
                    push_note(f"达到单账号 Telegram RPC 预算上限({rpc_budget})，已停止新增扩展并将现有候选送入核验")
                return False
            metrics["rpc_used"] += cost
            return True
        async def handle_rpc_exc(exc: BaseException) -> Optional[int]:
            nonlocal flood_hit
            mapped = map_exception_to_status(exc)
            if mapped in (
                AccountStatus.dead,
                AccountStatus.invalid,
                AccountStatus.needs_code,
                AccountStatus.frozen,
            ):
                raise exc
            wait = flood_wait_seconds(exc)
            if wait:
                flood_hit = max(flood_hit or 0, wait)
                await self._apply_status(
                    session,
                    account,
                    exc,
                    status=mapped or AccountStatus.limited,
                )
            return wait

        post_seed_ids: set[int] = set()
        channel_post_seeds: list[Any] = []
        post_extra_links: list[tuple[str, ExtractedLink, str, str]] = []
        # Telegram does not return the exact Stars charge in this response. To
        # enforce a hard per-task ceiling, reserve the remaining allowance for
        # one paid request and disable further paid requests afterwards.
        paid_stars_remaining: Optional[int] = (
            channel_posts_max_stars
            if allow_paid_channel_posts and channel_posts_max_stars > 0
            else None
        )
        paid_stars_reserved = 0

        try:
            # 1) contacts.search：原生关键词 + 地区/AI 扩展词（分片执行）。
            for index, item in enumerate(contacts_queries):
                if flood_hit or not take_rpc():
                    break
                try:
                    res = await client(functions.contacts.SearchRequest(q=item.query, limit=per_query))
                except BaseException as exc:  # noqa: BLE001
                    metrics["query_errors"] += 1
                    err = f"{type(exc).__name__}: {str(exc)[:160]}"
                    await record_keyword(
                        item.query, SearchSource.CONTACTS_SEARCH.value, status="error", raw=0, found=0, error=err
                    )
                    try:
                        await _record_query_stat(session, item, raw_count=0, found_count=0, error=err)
                    except BaseException:  # noqa: BLE001
                        pass
                    wait = await handle_rpc_exc(exc)
                    if wait:
                        if not candidates and not links and not expand_external_web:
                            raise self._failure(exc, "精准找群触发限流") from exc
                        break
                    continue

                chats = list(getattr(res, "chats", []) or [])
                metrics["raw_chats"] += len(chats)
                found = 0
                for chat in chats:
                    if add_candidate(
                        chat,
                        source=SearchSource.CONTACTS_SEARCH.value,
                        query=item.query,
                        keyword=item.keyword,
                    ):
                        found += 1
                await record_keyword(
                    item.query, SearchSource.CONTACTS_SEARCH.value, status="ok", raw=len(chats), found=found
                )
                try:
                    await _record_query_stat(session, item, raw_count=len(chats), found_count=found)
                except BaseException:  # noqa: BLE001
                    self.log.debug("查询绩效记录失败 query=%s", item.query)

                await self._report_progress(
                    session,
                    task,
                    stage="searching",
                    detail=f"联系人搜索「{item.query}」返回 {len(chats)} 个实体（候选 {len(candidates)}）",
                    scanned=index + 1,
                    found=len(candidates),
                    total=len(contacts_queries),
                )
                if index < len(contacts_queries) - 1:
                    await sleep_human(2.0, 5.0, rng)

            # 1b) 外部候选：人工粘贴链接 + 可插拔外部网页/目录适配器（只提 t.me 链接后再走 TG 实体验证）。
            link_queue: list[tuple[str, ExtractedLink, str, str]] = [
                (SearchSource.CANDIDATE_LINK.value, link, link.url, "") for link in links
            ]
            if expand_external_web and not flood_hit and (not shard_mode or account_index == 0):
                ext_res = await fetch_external_candidates(
                    keywords,
                    country=country,
                    max_keywords=external_web_query_limit,
                    max_candidates=external_web_candidate_limit,
                    allow_paid=allow_paid_external_search,
                )
                for n in ext_res.notes:
                    push_note(n)
                metrics["external_queries"] += ext_res.queries_run
                metrics["external_links"] += len(ext_res.links)
                metrics["external_errors"] += ext_res.errors
                source_stats["external_queries"] = ext_res.queries_run
                source_stats["external_links"] = len(ext_res.links)
                source_stats["external_errors"] = ext_res.errors
                for hit in ext_res.hits:
                    link_queue.append(
                        (
                            SearchSource.EXTERNAL_WEB.value,
                            ExtractedLink(kind=hit.kind, value=hit.value, url=hit.url),
                            hit.query,
                            hit.adapter,
                        )
                    )

            if link_queue:
                lead_extra = {"batch_id": batch_id} if batch_id else None
                for index, (link_src, link, link_query, link_adapter) in enumerate(link_queue):
                    if flood_hit or not take_rpc():
                        for rem_src, rem_link, rem_q, rem_ad in link_queue[index:]:
                            add_pending_candidate(
                                rem_link,
                                source=rem_src,
                                query=rem_q,
                                adapter=rem_ad,
                                reason="受限流或 RPC 预算上限约束，本轮未及实体验证",
                            )
                        break

                    def _on_link_chat(chat: Any, _src: str, _sid: Optional[int]) -> None:
                        extra = {"link": link.url}
                        if link_adapter:
                            extra["adapter"] = link_adapter
                        add_candidate(
                            chat,
                            source=link_src,
                            query=link_query,
                            keyword=keywords[0],
                            evidence_extra=extra,
                        )

                    link_found = 0
                    try:
                        hit = await self._verify_discovered_link(
                            client,
                            session,
                            account,
                            link,
                            source=link_src[:24],
                            query=link_query[:128],
                            seed_chat_id=None,
                            metrics=metrics,
                            store_directly=False,
                            on_chat=_on_link_chat,
                            extra_raw={**(lead_extra or {}), **({"adapter": link_adapter} if link_adapter else {})},
                        )
                        if hit is not None:
                            metrics["candidate_found"] += 1
                            link_found = 1
                        elif link.kind == "username":
                            add_pending_candidate(
                                link,
                                source=link_src,
                                query=link_query,
                                adapter=link_adapter,
                                reason="Telegram 未解析到该公开用户名",
                            )
                        await record_keyword(link.url, link_src, status="ok", raw=1, found=link_found)
                    except BaseException as exc:  # noqa: BLE001
                        metrics["candidate_errors"] += 1
                        await record_keyword(
                            link.url,
                            link_src,
                            status="error",
                            raw=0,
                            found=0,
                            error=f"{type(exc).__name__}: {str(exc)[:160]}",
                        )
                        if link.kind == "username":
                            add_pending_candidate(
                                link,
                                source=link_src,
                                query=link_query,
                                adapter=link_adapter,
                                reason=f"核验异常：{type(exc).__name__}",
                            )
                        if await handle_rpc_exc(exc):
                            for rem_src, rem_link, rem_q, rem_ad in link_queue[index + 1 :]:
                                add_pending_candidate(
                                    rem_link,
                                    source=rem_src,
                                    query=rem_q,
                                    adapter=rem_ad,
                                    reason="触发 Telegram 限流，尚未完成验证",
                                )
                            break
                    if index < len(link_queue) - 1:
                        await sleep_human(1.0, 2.5, rng)

            # 1c) 长尾召回不足时补主题限定短核心词（不参与评分）。
            if expand_short and short_items and not flood_hit and not budget_hit and len(candidates) < per_query:
                short_run = len(short_items)
                for index, item in enumerate(short_items):
                    if flood_hit or not take_rpc():
                        short_run = index
                        break
                    try:
                        res = await client(functions.contacts.SearchRequest(q=item.query, limit=per_query))
                    except BaseException as exc:  # noqa: BLE001
                        metrics["query_errors"] += 1
                        err = f"{type(exc).__name__}: {str(exc)[:160]}"
                        await record_keyword(
                            item.query, SearchSource.SHORT_QUERY.value, status="error", raw=0, found=0, error=err
                        )
                        if await handle_rpc_exc(exc):
                            short_run = index + 1
                            break
                        continue
                    chats = list(getattr(res, "chats", []) or [])
                    metrics["raw_chats"] += len(chats)
                    metrics["short_raw_chats"] += len(chats)
                    found = 0
                    for chat in chats:
                        if add_candidate(
                            chat,
                            source=SearchSource.SHORT_QUERY.value,
                            query=item.query,
                            keyword=item.keyword,
                        ):
                            found += 1
                    await record_keyword(
                        item.query, SearchSource.SHORT_QUERY.value, status="ok", raw=len(chats), found=found
                    )
                    try:
                        await _record_query_stat(session, item, raw_count=len(chats), found_count=found)
                    except BaseException:  # noqa: BLE001
                        pass
                    await self._report_progress(
                        session,
                        task,
                        stage="searching",
                        detail=f"短词补充「{item.query}」返回 {len(chats)} 个实体（候选 {len(candidates)}）",
                        scanned=index + 1,
                        found=len(candidates),
                        total=short_run,
                    )
                    if index < short_run - 1:
                        await sleep_human(2.0, 5.0, rng)

            metrics["queries"] += short_run
            metrics["short_queries"] = short_run
            total_queries = len(contacts_queries) + short_run

            # 2) messages.searchGlobal（支持翻页 + 精准记录群内消息命中次数）。
            if msg_query_pool and not flood_hit and not budget_hit:
                fallback_done: set[str] = set()
                for index, item in enumerate(msg_query_pool):
                    if flood_hit or budget_hit:
                        break
                    attempts = [item.query]
                    for candidate in (item.keyword, item.query.split()[0] if item.query.split() else ""):
                        candidate = str(candidate or "").strip()
                        if candidate and all(candidate.casefold() != seen.casefold() for seen in attempts):
                            attempts.append(candidate)

                    raw_total = 0
                    used_queries: list[str] = []
                    for attempt in attempts:
                        if flood_hit or budget_hit:
                            break
                        if attempt != item.query and attempt in fallback_done:
                            continue
                        offset_rate = 0
                        offset_peer: Any = tl_types.InputPeerEmpty()
                        offset_id = 0
                        page_limit = min(per_query, 50)
                        attempt_raw = 0
                        attempt_found = 0
                        errored = False
                        for page_num in range(message_pages):
                            if not take_rpc():
                                errored = True
                                break
                            try:
                                res = await client(
                                    functions.messages.SearchGlobalRequest(
                                        q=attempt,
                                        filter=tl_types.InputMessagesFilterEmpty(),
                                        min_date=None,
                                        max_date=None,
                                        offset_rate=offset_rate,
                                        offset_peer=offset_peer,
                                        offset_id=offset_id,
                                        limit=page_limit,
                                        groups_only=True,
                                    )
                                )
                            except BaseException as exc:  # noqa: BLE001
                                metrics["message_errors"] += 1
                                await record_keyword(
                                    attempt,
                                    SearchSource.GLOBAL_MESSAGE_SEARCH.value,
                                    status="error",
                                    raw=attempt_raw,
                                    found=attempt_found,
                                    error=f"{type(exc).__name__}: {str(exc)[:160]}",
                                )
                                errored = True
                                await handle_rpc_exc(exc)
                                break

                            chats = list(getattr(res, "chats", []) or [])
                            msgs = list(getattr(res, "messages", []) or [])
                            hit_chat_counts: dict[int, int] = {}
                            for msg in msgs:
                                cid = self._peer_chat_id(getattr(msg, "peer_id", None))
                                if cid:
                                    hit_chat_counts[cid] = hit_chat_counts.get(cid, 0) + 1

                            attempt_raw += len(chats)
                            for chat in chats:
                                cid = int(getattr(chat, "id", 0) or 0)
                                page_msg_hits = hit_chat_counts.get(cid, 0)
                                if add_candidate(
                                    chat,
                                    source=SearchSource.GLOBAL_MESSAGE_SEARCH.value,
                                    query=attempt,
                                    keyword=item.keyword,
                                    bump_message_hit=page_msg_hits > 0,
                                    evidence_extra={"page": page_num + 1, "msg_hits": page_msg_hits},
                                ):
                                    attempt_found += 1

                            if len(msgs) < page_limit or page_num >= message_pages - 1:
                                break
                            last_msg = msgs[-1]
                            offset_id = int(getattr(last_msg, "id", 0) or 0)
                            next_rate = int(getattr(res, "next_rate", 0) or 0)
                            if not next_rate:
                                msg_dt = getattr(last_msg, "date", None)
                                next_rate = int(msg_dt.timestamp()) if msg_dt else 0
                            offset_rate = next_rate
                            try:
                                offset_peer = await client.get_input_entity(getattr(last_msg, "peer_id", None))
                            except BaseException as exc:  # noqa: BLE001
                                await handle_rpc_exc(exc)
                                break
                            await sleep_human(1.5, 3.0, rng)

                        raw_total += attempt_raw
                        if not errored:
                            used_queries.append(attempt)
                            await record_keyword(
                                attempt,
                                SearchSource.GLOBAL_MESSAGE_SEARCH.value,
                                status="ok",
                                raw=attempt_raw,
                                found=attempt_found,
                            )
                        if attempt != item.query:
                            fallback_done.add(attempt)
                        if flood_hit or budget_hit or attempt_raw > 0:
                            break

                    metrics["message_raw_chats"] += raw_total
                    await self._report_progress(
                        session,
                        task,
                        stage="searching",
                        detail=(
                            f"消息搜索「{item.query}」返回 {raw_total} 个实体"
                            f"（回退 {', '.join(used_queries[1:]) or '无'}；候选 {len(candidates)}）"
                        ),
                        scanned=index + 1,
                        found=len(candidates),
                        total=len(msg_query_pool),
                    )
                    if flood_hit or budget_hit:
                        break
                    if index < len(msg_query_pool) - 1:
                        await sleep_human(3.0, 6.0, rng)

            # 2b) 跨账号共享本地历史群库（tsvector + pg_trgm），按账号分片核验。
            if not flood_hit and not budget_hit:
                local_profiles: list[GroupProfile] = []
                local_seen: set[int] = set()
                local_keywords = list(dict.fromkeys([*keywords, *_keyword_tokens(keywords)]))[:12]
                for keyword in local_keywords:
                    try:
                        matches = await search_local_profiles(
                            session,
                            keyword,
                            limit=20,
                            account_ids=None,
                            only_public=True,
                            only_groups=True,
                            dedupe_by_chat=True,
                        )
                    except BaseException as exc:  # noqa: BLE001
                        metrics["local_errors"] += 1
                        self.log.debug("本地群库检索失败 keyword=%s error=%s", keyword, exc)
                        continue
                    for match in matches:
                        profile = match.profile
                        chat_id = int(profile.tg_chat_id or 0)
                        if not chat_id or chat_id in local_seen:
                            continue
                        local_seen.add(chat_id)
                        local_profiles.append(profile)
                if shard_mode:
                    local_profiles = self._shard_list(local_profiles, account_index, account_count)
                for index, profile in enumerate(local_profiles):
                    if flood_hit or not take_rpc():
                        break
                    username = str(profile.username or "").lstrip("@")
                    if not username or int(profile.tg_chat_id or 0) in candidates:
                        continue
                    try:
                        resolved = await client(functions.contacts.ResolveUsernameRequest(username=username))
                        chats = list(getattr(resolved, "chats", []) or [])
                        if chats and add_candidate(
                            chats[0],
                            source=SearchSource.LOCAL_INDEX.value,
                            query="",
                            keyword=keywords[0],
                        ):
                            metrics["local_found"] += 1
                    except BaseException as exc:  # noqa: BLE001
                        metrics["local_errors"] += 1
                        if await handle_rpc_exc(exc):
                            break
                    if index < len(local_profiles) - 1:
                        await sleep_human(1.0, 2.0, rng)

            # 2c) 已入群图扩散：匹配同主题已加入的群，并从最近消息挖外链与邀请码。
            matched_dialog_ids: list[int] = []
            if scan_joined_groups and not flood_hit and not budget_hit:
                joined_rows = list(
                    await session.scalars(
                        select(Dialog)
                        .where(
                            Dialog.account_id == account.id,
                            Dialog.channel == DialogChannel.user_account,
                            Dialog.kind == DialogKind.group,
                        )
                        .order_by(Dialog.member_count.desc().nulls_last(), Dialog.id)
                        .limit(200)
                    )
                )
                match_terms = [*keywords, *_keyword_tokens(keywords)]
                matched_dialogs = [
                    dlg
                    for dlg in joined_rows
                    if any(_contains(f"{dlg.title or ''} {dlg.username or ''}", term) for term in match_terms)
                ][:joined_group_limit]
                matched_dialog_ids = [int(dlg.tg_chat_id) for dlg in matched_dialogs if getattr(dlg, "tg_chat_id", None)]
                joined_entities: list[Any] = []
                for dlg in matched_dialogs:
                    if flood_hit or not take_rpc():
                        break
                    try:
                        entity = await self._resolve_entity(client, dlg, session)
                        if entity is not None:
                            if add_candidate(
                                entity,
                                source=SearchSource.JOINED_GROUP_GRAPH.value,
                                query="",
                                keyword=keywords[0],
                                joined=True,
                            ):
                                metrics["joined_found"] += 1
                            joined_entities.append(entity)
                    except BaseException as exc:  # noqa: BLE001
                        if await handle_rpc_exc(exc):
                            break
                        continue
                if expand_channel_messages and joined_entities and not flood_hit and not budget_hit:
                    await self._expand_from_messages(
                        client,
                        session,
                        account,
                        joined_entities[:3],
                        task=task,
                        query=", ".join(keywords[:3]),
                        channel_limit=3,
                        message_limit=40,
                        max_links=15,
                        rng=rng,
                        metrics=metrics,
                        store_directly=False,
                        on_chat=on_expanded_chat,
                        source_tag=SearchSource.JOINED_GROUP_GRAPH.value,
                        extra_raw={"batch_id": batch_id} if batch_id else None,
                        on_rpc_error=handle_rpc_exc,
                        on_rpc=take_rpc,
                    )

            # 2d) 可选：公开频道帖子搜索（channels.searchPosts，默认关闭）。仅产频道种子/贴内链接，绝不直接当精准群。
            if post_query_pool and not flood_hit and not budget_hit:
                for index, item in enumerate(post_query_pool):
                    if flood_hit or not take_rpc():
                        break
                    paid_request_stars = paid_stars_remaining
                    try:
                        res = await client(
                            functions.channels.SearchPostsRequest(
                                offset_rate=0,
                                offset_peer=tl_types.InputPeerEmpty(),
                                offset_id=0,
                                limit=min(per_query, 30),
                                hashtag=None,
                                query=item.query,
                                allow_paid_stars=paid_request_stars if paid_request_stars and paid_request_stars > 0 else None,
                            )
                        )
                        if paid_request_stars:
                            paid_stars_reserved += paid_request_stars
                            paid_stars_remaining = None
                            source_stats["channel_posts_stars_reserved"] = paid_stars_reserved
                    except BaseException as exc:  # noqa: BLE001
                        if paid_request_stars:
                            # A rejected paid request should not be retried for
                            # every remaining query in the same task.
                            paid_stars_remaining = None
                            source_stats["channel_posts_stars_reserved"] = paid_stars_reserved
                        metrics["channel_posts_errors"] += 1
                        source_stats["channel_posts_errors"] = source_stats.get("channel_posts_errors", 0) + 1
                        err = f"{type(exc).__name__}: {str(exc)[:160]}"
                        await record_keyword(
                            item.query, SearchSource.CHANNEL_POSTS.value, status="error", raw=0, found=0, error=err
                        )
                        wait = await handle_rpc_exc(exc)
                        if wait:
                            break
                        push_note("公开频道帖子搜索受 Telegram Premium / Stars 配额限制，已自动降级跳过，不影响其余渠道")
                        break

                    post_chats = list(getattr(res, "chats", []) or [])
                    post_msgs = list(getattr(res, "messages", []) or [])
                    seed_cnt = 0
                    for ch in post_chats:
                        cid = int(getattr(ch, "id", 0) or 0)
                        if not cid:
                            continue
                        if bool(getattr(ch, "broadcast", False)) and getattr(ch, "username", None):
                            if cid not in post_seed_ids:
                                post_seed_ids.add(cid)
                                channel_post_seeds.append(ch)
                                metrics["channel_posts_seeds"] += 1
                                source_stats["channel_posts_seeds"] = source_stats.get("channel_posts_seeds", 0) + 1
                                seed_cnt += 1
                        elif discussion_verdict(ch)[0]:
                            add_candidate(
                                ch,
                                source=SearchSource.CHANNEL_POSTS.value,
                                query=item.query,
                                keyword=item.keyword,
                            )
                    msg_texts = [str(getattr(m, "message", "") or "") for m in post_msgs if getattr(m, "message", None)]
                    if msg_texts:
                        for p_link in extract_links(msg_texts, limit=15):
                            post_extra_links.append((SearchSource.CHANNEL_POSTS.value, p_link, item.query, ""))
                    await record_keyword(
                        item.query, SearchSource.CHANNEL_POSTS.value, status="ok", raw=len(post_chats), found=seed_cnt
                    )
                    if index < len(post_query_pool) - 1:
                        await sleep_human(2.0, 4.0, rng)

                if post_extra_links:
                    lead_extra = {"batch_id": batch_id} if batch_id else None
                    for idx_p, (p_src, p_link, p_q, _) in enumerate(post_extra_links[:20]):
                        if flood_hit or not take_rpc():
                            add_pending_candidate(
                                p_link,
                                source=p_src,
                                query=p_q,
                                reason="受限流或 RPC 预算上限约束，帖子内链接本轮未核验",
                            )
                            continue
                        try:
                            await self._verify_discovered_link(
                                client,
                                session,
                                account,
                                p_link,
                                source=p_src[:24],
                                query=p_q[:128],
                                seed_chat_id=None,
                                metrics=metrics,
                                store_directly=False,
                                on_chat=lambda ch, _s, _sid: add_candidate(
                                    ch,
                                    source=p_src,
                                    query=p_q,
                                    keyword=keywords[0],
                                    evidence_extra={"link": p_link.url},
                                ),
                                extra_raw=lead_extra,
                            )
                        except BaseException as exc:  # noqa: BLE001
                            if p_link.kind == "username":
                                add_pending_candidate(
                                    p_link,
                                    source=p_src,
                                    query=p_q,
                                    reason=f"帖子内链核验失败：{type(exc).__name__}",
                                )
                            if await handle_rpc_exc(exc):
                                break
                        if idx_p < min(len(post_extra_links), 20) - 1:
                            await sleep_human(1.0, 2.0, rng)

            # 3) 频道图扩散：linked_chat + 相似频道推荐 + 频道消息提链（全部只进候选，不跳过审核落库）。
            channel_seeds: list[Any] = []
            seen_seed_ids: set[int] = set()
            for ch in [
                *(
                    entry["chat"]
                    for entry in candidates.values()
                    if bool(getattr(entry["chat"], "broadcast", False)) and getattr(entry["chat"], "username", None)
                ),
                *channel_post_seeds,
            ]:
                cid = int(getattr(ch, "id", 0) or 0)
                if cid and cid not in seen_seed_ids:
                    seen_seed_ids.add(cid)
                    channel_seeds.append(ch)
            # 优先按标题相关性 + 成员数排序频道种子，避免无关大频道占满配额
            channel_seeds.sort(
                key=lambda ch: (
                    score_group(
                        title=str(getattr(ch, "title", "") or ""),
                        username=getattr(ch, "username", None),
                        keywords=scoring_keywords,
                        country=country,
                        languages=languages,
                    ).score,
                    int(getattr(ch, "participants_count", 0) or 0),
                ),
                reverse=True,
            )

            def _on_channel_graph_chat(chat: Any, source_tag: str, seed_id: Optional[int]) -> None:
                extra = {"seed_chat_id": seed_id} if seed_id else None
                add_candidate(chat, source=source_tag, query="", keyword=keywords[0], evidence_extra=extra)
                if seed_id and seed_id in post_seed_ids:
                    add_candidate(
                        chat,
                        source=SearchSource.CHANNEL_POSTS.value,
                        query="",
                        keyword=keywords[0],
                        evidence_extra={"seed_chat_id": seed_id, "via": normalize_search_source(source_tag)},
                    )

            if expand_recommendations and recommendation_channels and channel_seeds and not flood_hit and not budget_hit:
                rec_hits = await self._expand_recommendations(
                    client,
                    session,
                    account,
                    channel_seeds,
                    task=task,
                    query=", ".join(keywords[:3]),
                    channel_limit=recommendation_channels,
                    rng=rng,
                    metrics=metrics,
                    store_directly=False,
                    on_chat=_on_channel_graph_chat,
                    on_rpc_error=handle_rpc_exc,
                    on_rpc=take_rpc,
                )
                # 相似频道推荐出来的新频道也加入 linked_chat 种子列表
                for item in rec_hits:
                    cid = int(item.get("tg_chat_id") or 0)
                    if cid and cid not in seen_seed_ids and cid in candidates:
                        ch = candidates[cid]["chat"]
                        if bool(getattr(ch, "broadcast", False)) and getattr(ch, "username", None):
                            channel_seeds.append(ch)
                            seen_seed_ids.add(cid)

            if expand_channel_messages and message_channels and channel_seeds and not flood_hit and not budget_hit:
                await self._expand_from_messages(
                    client,
                    session,
                    account,
                    channel_seeds,
                    task=task,
                    query=", ".join(keywords[:3]),
                    channel_limit=message_channels,
                    message_limit=message_limit,
                    max_links=30,
                    rng=rng,
                    metrics=metrics,
                    store_directly=False,
                    on_chat=_on_channel_graph_chat,
                    source_tag=SearchSource.CHANNEL_MESSAGE_LINK.value,
                    extra_raw={"batch_id": batch_id} if batch_id else None,
                    on_rpc_error=handle_rpc_exc,
                    on_rpc=take_rpc,
                )

            if include_linked and max_linked and channel_seeds and not flood_hit and not budget_hit:
                seeds = channel_seeds[:max_linked]
                for index, seed in enumerate(seeds):
                    if flood_hit or not take_rpc():
                        break
                    seed_id = int(getattr(seed, "id", 0) or 0)
                    try:
                        full = await client(functions.channels.GetFullChannelRequest(channel=seed))
                        linked_id = int(getattr(getattr(full, "full_chat", None), "linked_chat_id", 0) or 0)
                        if not linked_id:
                            continue
                        linked = next(
                            (
                                chat
                                for chat in (getattr(full, "chats", []) or [])
                                if int(getattr(chat, "id", 0) or 0) == linked_id
                            ),
                            None,
                        )
                        if linked is None:
                            if not take_rpc():
                                continue
                            linked = await client.get_entity(tl_types.PeerChannel(linked_id))
                        added_linked = add_candidate(
                            linked,
                            source=SearchSource.LINKED_CHAT.value,
                            query="",
                            keyword=keywords[0],
                            evidence_extra={"seed_chat_id": seed_id} if seed_id else None,
                        )
                        if seed_id and seed_id in post_seed_ids:
                            add_candidate(
                                linked,
                                source=SearchSource.CHANNEL_POSTS.value,
                                query="",
                                keyword=keywords[0],
                                evidence_extra={"seed_chat_id": seed_id, "via": SearchSource.LINKED_CHAT.value},
                            )
                        if added_linked:
                            metrics["linked_found"] += 1
                    except BaseException as exc:  # noqa: BLE001
                        metrics["linked_errors"] += 1
                        if await handle_rpc_exc(exc):
                            break
                    if index < len(seeds) - 1:
                        await sleep_human(2.0, 4.0, rng)
                    if (index + 1) % 10 == 0:
                        await self._report_progress(
                            session,
                            task,
                            stage="expanding",
                            detail=f"已检查 {index + 1}/{len(seeds)} 个频道，找到 {metrics['linked_found']} 个讨论群",
                            scanned=index + 1,
                            found=len(candidates),
                            total=len(seeds),
                        )

            # 3b) 可选：已知用户 → 共同群图扩展（默认关闭，低优先级执行，仅限本账号可解析实体且受严格人数上限约束）。
            if expand_common_chats and common_chat_user_limit > 0 and not flood_hit and not budget_hit:
                seed_chat_scope = list(dict.fromkeys([*list(candidates.keys()), *matched_dialog_ids]))[:50]
                member_stmt = select(GroupMember).where(GroupMember.is_bot.is_(False))
                if seed_chat_scope:
                    member_stmt = member_stmt.where(
                        or_(GroupMember.tg_chat_id.in_(seed_chat_scope), GroupMember.account_id == account.id)
                    )
                else:
                    member_stmt = member_stmt.where(GroupMember.account_id == account.id)
                member_rows = list(
                    await session.scalars(
                        member_stmt.order_by(
                            GroupMember.message_count.desc(),
                            GroupMember.last_seen_at.desc().nulls_last(),
                            GroupMember.id,
                        ).limit(common_chat_user_limit * 6)
                    )
                )
                # 当前账号自身采集的成员排前面（本地 session 缓存 access_hash 命中率最高）
                member_rows.sort(
                    key=lambda m: (
                        1 if getattr(m, "account_id", None) == account.id else 0,
                        1 if getattr(m, "username", None) else 0,
                        int(getattr(m, "message_count", 0) or 0),
                    ),
                    reverse=True,
                )
                user_ids_pool: list[int] = []
                seen_uids: set[int] = set()
                for m in member_rows:
                    uid = int(getattr(m, "tg_user_id", 0) or 0)
                    if uid and uid not in seen_uids:
                        seen_uids.add(uid)
                        user_ids_pool.append(uid)
                if shard_mode:
                    user_ids_pool = self._shard_list(user_ids_pool, account_index, account_count)

                common_checked = 0
                for uid in user_ids_pool:
                    if common_checked >= common_chat_user_limit or flood_hit or budget_hit:
                        break
                    try:
                        input_user = await client.get_input_entity(uid)
                    except ValueError:
                        # 本地 session 缓存不存在该用户 access_hash：静默跳过，不烧 RPC 也不计失败
                        continue
                    except BaseException as exc:  # noqa: BLE001
                        if await handle_rpc_exc(exc):
                            break
                        continue
                    if not take_rpc():
                        break
                    try:
                        res = await client(
                            functions.messages.GetCommonChatsRequest(user_id=input_user, max_id=0, limit=20)
                        )
                        common_checked += 1
                        metrics["common_chat_checked"] += 1
                        source_stats["common_chat_checked"] = source_stats.get("common_chat_checked", 0) + 1
                        for chat in list(getattr(res, "chats", []) or []):
                            if add_candidate(
                                chat,
                                source=SearchSource.COMMON_CHAT_GRAPH.value,
                                query="",
                                keyword=keywords[0],
                                joined=True,
                                evidence_extra={"tg_user_id": uid},
                            ):
                                metrics["common_chat_found"] += 1
                    except BaseException as exc:  # noqa: BLE001
                        if await handle_rpc_exc(exc):
                            break
                    if common_checked < common_chat_user_limit:
                        await sleep_human(1.2, 2.5, rng)

            # 4) 优先排序后再调 GetFullChannel（先过滤硬淘汰项、复用 24h 内已完整校验的本地档案）。
            eligible_ids: list[int] = []
            for cid, entry in candidates.items():
                chat = entry["chat"]
                if group_only and not discussion_verdict(chat)[0]:
                    continue
                flags_pre = verification_flags(chat, None)
                if public_only and not flags_pre["is_public"]:
                    continue
                if exclude_readonly and flags_pre["readonly"]:
                    continue
                pre_members = self._chat_members_of(chat)
                if not simple_screen and min_members and pre_members is not None and pre_members < min_members:
                    continue
                eligible_ids.append(cid)

            if eligible_ids:
                fresh_cutoff = _now() - timedelta(hours=24)
                cached_rows = list(
                    await session.scalars(
                        select(GroupProfile)
                        .where(
                            GroupProfile.tg_chat_id.in_(eligible_ids),
                            GroupProfile.verification_status == "full",
                            GroupProfile.last_verified_at >= fresh_cutoff,
                        )
                        .order_by(GroupProfile.last_verified_at.desc())
                    )
                )
                for row in cached_rows:
                    cid = int(row.tg_chat_id)
                    if cid in candidates and candidates[cid]["cached"] is None:
                        candidates[cid]["cached"] = row
                        metrics["full_cached"] += 1

            # 4a) 先验活：是否「近 3 个月有消息」是 simple_screen 的唯一判定依据，
            # 必须抢在批量 GetFullChannel 之前做——GetFullChannel 最容易吃 FloodWait，
            # 一旦限流就会把后面的验活整段跳过，结果全部停在「待确认」。
            if verify_activity and activity_check_limit > 0 and eligible_ids and not flood_hit and not budget_hit:
                pre_ranked: list[tuple[int, int]] = []
                for cid in eligible_ids:
                    entry = candidates[cid]
                    chat = entry["chat"]
                    full = entry.get("full")
                    full_chat = getattr(full, "full_chat", None) if full is not None else None
                    cached = entry.get("cached")
                    tme_info = entry.get("tme") or {}
                    about_pre = (
                        (getattr(full_chat, "about", "") if full_chat is not None else "")
                        or (cached.about if cached is not None else "")
                        or str(tme_info.get("about") or "")
                    )
                    members_pre = self._chat_members_of(chat, full_chat, tme_info)
                    s_pre = score_group(
                        title=str(getattr(chat, "title", "") or ""),
                        about=about_pre,
                        username=getattr(chat, "username", None),
                        keywords=scoring_keywords,
                        country=country,
                        languages=languages,
                        member_count=members_pre,
                        message_hits=entry["message_hits"],
                        sources=entry["sources"],
                        source_counts=entry["source_counts"],
                        joined=entry["joined"],
                    ).score
                    if simple_screen or s_pre >= 35 or entry["message_hits"] > 0:
                        pre_ranked.append((cid, s_pre))
                pre_ranked.sort(
                    key=lambda pair: (pair[1], self._chat_members_of(candidates[pair[0]]["chat"]) or 0),
                    reverse=True,
                )
                now_utc = _now()
                for idx, (cid, _) in enumerate(pre_ranked[:activity_check_limit]):
                    if flood_hit or budget_hit:
                        break
                    entry = candidates[cid]
                    act, samples = await self._sample_group_activity(
                        client,
                        entry["chat"],
                        keywords=scoring_keywords,
                        now=now_utc,
                        on_rpc_error=handle_rpc_exc,
                        on_rpc=take_rpc,
                    )
                    if act is not None:
                        entry["activity"] = act
                        entry["samples"] = samples
                        metrics["activity_checked"] += 1
                    if flood_hit:
                        break
                    if idx < min(len(pre_ranked), activity_check_limit) - 1:
                        await sleep_human(0.8, 1.8, rng)

            uncached_ids = [cid for cid in eligible_ids if candidates[cid]["cached"] is None]
            uncached_ids.sort(
                key=lambda cid: (
                    score_group(
                        title=str(getattr(candidates[cid]["chat"], "title", "") or ""),
                        username=getattr(candidates[cid]["chat"], "username", None),
                        keywords=scoring_keywords,
                        country=country,
                        languages=languages,
                        member_count=self._chat_members_of(candidates[cid]["chat"]),
                        message_hits=candidates[cid]["message_hits"],
                    ).score,
                    self._chat_members_of(candidates[cid]["chat"]) or 0,
                ),
                reverse=True,
            )
            full_targets = uncached_ids[:full_check_limit]
            if full_targets and not flood_hit and not budget_hit:
                for index, chat_id in enumerate(full_targets):
                    if flood_hit or not take_rpc():
                        break
                    entry = candidates[chat_id]
                    try:
                        entry["full"] = await client(functions.channels.GetFullChannelRequest(channel=entry["chat"]))
                        metrics["full_checked"] += 1
                    except BaseException as exc:  # noqa: BLE001
                        metrics["full_errors"] += 1
                        if await handle_rpc_exc(exc):
                            break
                    if index < len(full_targets) - 1:
                        await sleep_human(1.0, 2.5, rng)

            if enrich_tme:
                need_tme = [
                    cid
                    for cid in eligible_ids
                    if candidates[cid]["full"] is None and candidates[cid]["cached"] is None
                ][:tme_limit]
                if need_tme:
                    await self._enrich_candidates_from_tme(candidates, need_tme, metrics=metrics)
                    for cid in need_tme:
                        if candidates[cid].get("tme"):
                            record_source_meta(
                                candidates[cid],
                                source=SearchSource.TME_PREVIEW.value,
                                query="",
                                keyword=keywords[0],
                            )

            if flood_hit and not candidates and not pending_candidates:
                raise TaskFailure(
                    f"精准找群触发 Telegram 限流，{flood_hit} 秒后重试",
                    retryable=True,
                    requeue_after=flood_hit + 1,
                )
            if flood_hit:
                metrics["flood_wait_seconds"] = flood_hit
                push_note(f"检索过程中触发 Telegram {flood_hit}s 限流，已提前收敛并输出已召回候选")

            # 4c) 可选 AI 语义复核（未配置 AI 时返回降级提示，不阻塞评分）。
            ai_reviews: dict[int, dict[str, Any]] = {}
            if ai_review and eligible_ids:
                ai_pool: list[dict[str, Any]] = []
                for cid in eligible_ids:
                    entry = candidates[cid]
                    chat = entry["chat"]
                    full = entry.get("full")
                    full_chat = getattr(full, "full_chat", None) if full is not None else None
                    cached = entry.get("cached")
                    tme_info = entry.get("tme") or {}
                    about_val = (
                        (getattr(full_chat, "about", "") if full_chat is not None else "")
                        or (cached.about if cached is not None else "")
                        or str(tme_info.get("about") or "")
                    )
                    s_val = score_group(
                        title=str(getattr(chat, "title", "") or ""),
                        about=about_val,
                        username=getattr(chat, "username", None),
                        keywords=scoring_keywords,
                        country=country,
                        languages=languages,
                        member_count=self._chat_members_of(chat, full_chat, tme_info),
                        message_hits=entry["message_hits"],
                        activity=entry.get("activity"),
                        sources=entry["sources"],
                        source_counts=entry["source_counts"],
                        joined=entry["joined"],
                    ).score
                    if s_val >= 35:
                        ai_pool.append(
                            {
                                "tg_chat_id": cid,
                                "title": str(getattr(chat, "title", "") or ""),
                                "username": getattr(chat, "username", None),
                                "about": about_val,
                                "sample_messages": entry.get("samples") or [],
                                "_pre_score": s_val,
                            }
                        )
                ai_pool.sort(key=lambda item: item["_pre_score"], reverse=True)
                ai_reviews, ai_rev_note = await review_candidates_with_ai(
                    ai_pool[:15],
                    keywords=scoring_keywords,
                    country=country,
                    languages=languages,
                )
                if ai_rev_note:
                    push_note(ai_rev_note)
                metrics["ai_reviewed"] = len(ai_reviews)

            # 5) 最终校验 + 评分 + 落库（每条候选使用 SAVEPOINT，防止单条异常拖垮整批事务）。
            for chat_id, entry in candidates.items():
                chat = entry["chat"]
                full = entry.get("full")
                full_chat = getattr(full, "full_chat", None) if full is not None else None
                cached = entry.get("cached")
                tme_info = entry.get("tme") or {}

                title = str(getattr(chat, "title", "") or "") or str(tme_info.get("title") or "")
                about = (
                    (str(getattr(full_chat, "about", "") or "") if full_chat is not None else "")
                    or (str(cached.about or "") if cached is not None else "")
                    or str(tme_info.get("about") or "")
                )
                username = getattr(chat, "username", None)
                members = self._chat_members_of(chat, full_chat, tme_info)
                if members is None and cached is not None:
                    members = cached.member_count
                if not simple_screen and min_members and (members or 0) < min_members:
                    metrics["dropped_members"] += 1
                    continue

                type_ok, type_reason = discussion_verdict(chat)
                flags = verification_flags(chat, full)
                if flags["verification_status"] == "entity_only" and cached is not None:
                    flags["verification_status"] = "cached_full"
                    if flags["linked_channel_id"] is None:
                        flags["linked_channel_id"] = cached.linked_channel_id

                score = score_group(
                    title=title,
                    about=about,
                    username=username,
                    keywords=scoring_keywords,
                    country=country,
                    languages=languages,
                    member_count=members,
                    message_hits=entry["message_hits"],
                    activity=entry.get("activity"),
                    sources=entry["sources"],
                    source_counts=entry["source_counts"],
                    joined=entry["joined"],
                )
                trust_bonus, verification_tier, _ = compute_source_trust(
                    entry["sources"],
                    source_counts=entry["source_counts"],
                    joined=entry["joined"],
                )
                final_score = score.score
                breakdown = dict(score.breakdown)
                reasons = list(score.reasons)
                ai_row = ai_reviews.get(chat_id)
                if ai_row:
                    delta = int(ai_row.get("delta") or 0)
                    if delta:
                        breakdown["ai"] = delta
                    final_score = max(0, min(100, final_score + delta))
                    if ai_row.get("reason"):
                        reasons.append(f"AI复核({delta:+d})：{ai_row['reason']}")
                    elif not ai_row.get("relevant", True):
                        reasons.append("AI复核：疑似跑题或广告群")

                if simple_screen:
                    activity = entry.get("activity")
                    reasons = [r for r in reasons if not r.startswith(("近7天", "近期活跃"))]
                    if activity is None:
                        status = "needs_review"
                        reasons.append("无法读取近期消息，活跃度待确认")
                    elif activity.get("recent_90d"):
                        status = "accepted"
                        days = activity.get("last_message_days")
                        suffix = f"，最近一条约 {days} 天前" if days is not None else ""
                        reasons.append(
                            f"近3个月活跃（抽样 {activity.get('total_sampled', 0)} 条中 "
                            f"{activity['recent_90d']} 条{suffix}）"
                        )
                    else:
                        status = "rejected"
                        reasons.append("近3个月无消息（疑似沉寂）")
                    if ai_row and not ai_row.get("relevant", True):
                        reasons.append("AI复核：疑似跑题或广告群（仅提示，不影响判定）")
                else:
                    status = classify(final_score, min_score=min_score)
                    if ai_row and not ai_row.get("relevant", True) and status == "accepted":
                        status = "needs_review"
                if group_only and not type_ok:
                    status = "rejected"
                    reasons.append(f"类型不合格：{type_reason}")
                    metrics["channels"] += 1
                if public_only and not flags["is_public"]:
                    status = "rejected"
                    reasons.append("没有公开用户名")
                if (simple_screen or exclude_readonly) and flags["readonly"]:
                    status = "rejected"
                    reasons.append("默认权限为只读")
                    metrics["readonly"] += 1

                fields = profile_fields_from_entity(chat, full)
                if about and not fields.get("about"):
                    fields["about"] = about
                if members is not None and not fields.get("member_count"):
                    fields["member_count"] = members

                match_raw: dict[str, Any] = {
                    "type_reason": type_reason,
                    **flags,
                    "message_hits": entry["message_hits"],
                    "source_counts": dict(entry["source_counts"]),
                    "evidence": list(entry["evidence"][:15]),
                    "verification_tier": verification_tier,
                    "trust_bonus": trust_bonus,
                    "joined": entry["joined"],
                }
                if entry.get("activity"):
                    match_raw["activity"] = entry["activity"]
                if ai_row:
                    match_raw["ai_review"] = ai_row
                if tme_info:
                    match_raw["tme_preview"] = tme_info

                primary_source = str(entry["sources"][0] if entry["sources"] else SearchSource.CONTACTS_SEARCH.value)[:24]
                # 只有达标的（讨论组 + 近3个月有消息 + 能发言）才进群档案；
                # 频道、只读、活跃度没验上的只留在检索结果里，否则档案会被整片频道淹没。
                profile: Optional[GroupProfile] = None
                try:
                    async with session.begin_nested():
                        if status == "accepted":
                            profile = await upsert_profile(
                                session,
                                account_id=account.id,
                                tg_chat_id=chat_id,
                                source="precise_search",
                                touch_collected_at=False,
                                raw={
                                    "precise": True,
                                    "type_reason": type_reason,
                                    "sources": entry["sources"],
                                    "source_counts": dict(entry["source_counts"]),
                                    "verification_tier": verification_tier,
                                    "query": entry["query"],
                                    "keyword": entry["keyword"],
                                    **({"activity": entry["activity"]} if entry.get("activity") else {}),
                                },
                                **fields,
                                language=score.language,
                                country=score.country,
                                topic=score.topic,
                                relevance_score=final_score,
                                send_permission=flags["send_permission"],
                                join_request=flags["join_request"],
                                linked_channel_id=flags["linked_channel_id"],
                                verification_status=flags["verification_status"],
                                last_verified_at=_now(),
                                discovery_sources=entry["sources"],
                                matched_keywords=score.matched_keywords,
                            )
                        await session.execute(
                            pg_insert(GroupSearchMatch)
                            .values(
                                id=uuid.uuid4(),
                                task_id=task.id,
                                account_id=account.id,
                                profile_id=profile.id if profile is not None else None,
                                tg_chat_id=chat_id,
                                title=title[:255],
                                username=username,
                                member_count=int(members) if members is not None else None,
                                source=primary_source,
                                query=str(entry["query"] or "")[:255],
                                keywords=scoring_keywords,
                                relevance_score=final_score,
                                breakdown=breakdown,
                                matched_keywords=score.matched_keywords,
                                discovery_sources=entry["sources"],
                                language=score.language,
                                country=score.country,
                                topic=score.topic,
                                status=status,
                                reasons=reasons,
                                raw=match_raw,
                            )
                            .on_conflict_do_update(
                                index_elements=["task_id", "tg_chat_id"],
                                set_={
                                    "profile_id": profile.id if profile is not None else None,
                                    "title": title[:255],
                                    "username": username,
                                    "member_count": int(members) if members is not None else None,
                                    "source": primary_source,
                                    "relevance_score": final_score,
                                    "breakdown": breakdown,
                                    "matched_keywords": score.matched_keywords,
                                    "discovery_sources": entry["sources"],
                                    "status": status,
                                    "reasons": reasons,
                                    "raw": match_raw,
                                    "updated_at": _now(),
                                },
                            )
                        )
                except BaseException as exc:  # noqa: BLE001
                    metrics["persist_errors"] = metrics.get("persist_errors", 0) + 1
                    self.log.debug("精准检索落档失败 tg_chat_id=%s: %s", chat_id, exc)
                    continue

                metrics[status] += 1
                metrics["score_sum"] += final_score

            # 移除已在候选池成功通过实体验证的 username，避免重复挂进未核验列表
            verified_usernames = {
                str(getattr(entry["chat"], "username", "") or "").strip().lstrip("@").casefold()
                for entry in candidates.values()
                if getattr(entry["chat"], "username", None)
            }
            filtered_pending = [
                item
                for item in pending_candidates
                if not (item.get("kind") == "username" and str(item.get("value") or "").casefold() in verified_usernames)
            ]

            source_stats.update(
                {
                    "accepted": metrics["accepted"],
                    "needs_review": metrics["needs_review"],
                    "rejected": metrics["rejected"],
                    "dropped_members": metrics["dropped_members"],
                    "channels": metrics["channels"],
                    "readonly": metrics["readonly"],
                    "flood_stopped": 1 if flood_hit else 0,
                    "budget_stopped": 1 if budget_hit else 0,
                    "rpc_used": metrics["rpc_used"],
                    "unverified_pending": len(filtered_pending),
                }
            )

            flood_suffix = f"（触发 {flood_hit}s 限流已提前收敛）" if flood_hit else ""
            await self._report_progress(
                session,
                task,
                stage="done",
                detail=(
                    f"精准检索完成：{len(candidates)} 个候选，{metrics['accepted']} 个保留，"
                    f"{metrics['needs_review']} 个待确认，{metrics['rejected']} 个排除{flood_suffix}"
                ),
                scanned=total_queries,
                found=metrics["accepted"],
                total=total_queries,
            )
        except TaskFailure:
            raise
        except BaseException as exc:  # noqa: BLE001
            await self._apply_status(session, account, exc)
            raise self._failure(exc, "精准找群失败") from exc

        average = round(
            metrics["score_sum"] / max(metrics["accepted"] + metrics["needs_review"] + metrics["rejected"], 1), 1
        )
        flood_suffix = f"（触发 {flood_hit}s 限流提前收敛）" if flood_hit else ""
        return {
            "mode": "precise",
            "keywords": keywords,
            "country": country,
            "languages": languages,
            "queries_run": total_queries,
            "short_queries_run": short_run,
            "candidate_links": len(links),
            "min_relevance_score": min_score,
            "candidates": len(candidates),
            "accepted": metrics["accepted"],
            "needs_review": metrics["needs_review"],
            "rejected": metrics["rejected"],
            "average_score": average,
            "ai_notes": ai_notes,
            "source_stats": source_stats,
            "pending_candidates": filtered_pending,
            "metrics": metrics,
            "summary": (
                f"精准检索：{total_queries} 条查询（短词 {short_run} 条，外部候选 {len(links)} 个），{len(candidates)} 个候选，"
                f"保留 {metrics['accepted']} 个、待确认 {metrics['needs_review']} 个、排除 {metrics['rejected']} 个{flood_suffix}"
            ),
        }

    async def _collect_messages(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """采集群内对话：按时间范围扫消息，把发言的人落成成员档案。

        为什么需要它：群主可以开启「隐藏成员名单」，Telegram 就不再允许任何客户端拉成员列表——
        但**群里的对话照样能读**。从「谁发了言」就能把活跃成员捞出来，还顺带知道最后发言时间，
        比一份静态成员名单更有用。

        payload：
        - `profile_id` / `tg_chat_id` / `dialog_id`：目标群（与采集成员一致）；
        - `days`：只扫最近多少天的消息（默认 7 天）；
        - `exclude_admins`：跳过管理员的发言（默认 False，即管理员也算成员）；
        - `exclude_bots`：跳过机器人（默认 True）；
        - `limit`：最多扫多少条消息（默认 1000，避免大群扫太久）。
        """
        assert account is not None
        payload = dict(task.payload or {})
        profile_id = payload.get("profile_id")
        dialog = await self._resolve_group_dialog(session, task, payload)
        days = max(1, min(int(payload.get("days") or 7), 365))
        limit = max(10, min(int(payload.get("limit") or 1000), 5000))
        exclude_admins = bool(payload.get("exclude_admins", False))
        exclude_bots = bool(payload.get("exclude_bots", True))
        # 关键词：只捞聊到这些话题的人（走 Telegram 服务端搜索，比本地过滤准且省流量）
        keywords = [str(item).strip() for item in (payload.get("keywords") or []) if str(item).strip()][:10]
        client = self._client(account.id)

        from app.models import GroupProfile

        profile = None
        if profile_id:
            profile = await session.get(GroupProfile, uuid.UUID(str(profile_id)))
        if profile is None:
            tg_chat_id = int(payload.get("tg_chat_id") or (dialog.tg_chat_id if dialog is not None else 0))
            if not tg_chat_id:
                raise TaskFailure("采集对话任务缺少 profile_id 或 tg_chat_id", retryable=False)
            entity = await resolve_chat_entity(client, tg_chat_id, session=session)
            profile = await upsert_profile(
                session,
                account_id=account.id,
                tg_chat_id=tg_chat_id,
                dialog_id=dialog.id if dialog is not None else None,
                source="profile_sync",
                touch_collected_at=False,
                **profile_fields_from_entity(entity),
            )
        else:
            entity = await self._resolve_entity(client, dialog, session) if dialog is not None else await resolve_chat_entity(client, profile.tg_chat_id, session=session, username_hint=getattr(profile, 'username', '') or '')

        # 不在群里就读不到对话，先把原因说清楚（与成员采集同一套探测）
        blocked = await self._member_visibility(client, entity)
        if blocked and "隐藏了成员名单" not in blocked:
            raise TaskFailure(blocked, retryable=False)

        # 管理员 id 集合：用于「避开管理员」。拿不到就退化为不排除（不影响主流程）
        admin_ids: set[int] = set()
        if exclude_admins and isinstance(entity, tl_types.Channel):
            try:
                admins = await client(
                    functions.channels.GetParticipantsRequest(
                        channel=entity,
                        filter=tl_types.ChannelParticipantsAdmins(),
                        offset=0,
                        limit=100,
                        hash=0,
                    )
                )
                admin_ids = {int(user.id) for user in getattr(admins, "users", []) or []}
            except BaseException as exc:  # noqa: BLE001 - 隐藏成员名单时管理员列表也可能拿不到
                self.log.debug("取管理员列表失败（不排除管理员）: %s", describe_exception(exc))

        cutoff = _now() - timedelta(days=days)
        await self._report_progress(
            session, task, stage="scanning",
            detail=f"开始扫描最近 {days} 天的对话（最多 {limit} 条）",
            scanned=0, found=0, total=limit,
        )

        scanned = found = skipped_admin = skipped_bot = 0
        matched = 0
        seen: dict[int, dict] = {}
        keyword_hits: dict[str, int] = {}
        try:
            sources = (
                [(kw, client.iter_messages(entity, search=kw, limit=limit)) for kw in keywords]
                if keywords
                else [(None, client.iter_messages(entity, limit=limit))]
            )
            for keyword, stream in sources:
                if keyword:
                    await self._report_progress(
                        session, task, stage="searching",
                        detail=f"搜索关键词「{keyword}」（已扫 {scanned} 条，识别 {found} 人）",
                        scanned=scanned, found=found, total=limit,
                    )
                async for message in stream:
                    message_date = getattr(message, "date", None)
                    if message_date is not None and message_date < cutoff:
                        if keyword is None:
                            break  # 全量扫描是「从新往旧」，越过时间范围即可停；搜索模式交给 limit 控制
                        continue
                    if keyword:
                        keyword_hits[keyword] = keyword_hits.get(keyword, 0) + 1
                        matched += 1
                    scanned += 1
                    sender = None
                    try:
                        sender = await message.get_sender()
                    except BaseException:  # noqa: BLE001 - 单条取不到发送者不影响整批
                        sender = None
                    if sender is None or getattr(sender, "id", None) is None:
                        continue
                    if getattr(sender, "bot", False) and exclude_bots:
                        skipped_bot += 1
                        continue
                    if exclude_admins and int(sender.id) in admin_ids:
                        skipped_admin += 1
                        continue
                    user_id = int(sender.id)
                    if user_id in seen:
                        seen[user_id]["messages"] += 1
                        if keyword:
                            seen[user_id]["keywords"].add(keyword)
                    else:
                        username = getattr(sender, "username", None)
                        name = (
                            getattr(sender, "title", None)
                            or " ".join(
                                part
                                for part in (getattr(sender, "first_name", None), getattr(sender, "last_name", None))
                                if part
                            ).strip()
                            or (f"@{username}" if username else "")
                            or str(user_id)
                        )
                        seen[user_id] = {"messages": 1, "name": name, "username": username, "keywords": set()}
                        if keyword:
                            seen[user_id]["keywords"].add(keyword)
                        await upsert_member(
                            session,
                            profile=profile,
                            tg_user_id=user_id,
                            username=username,
                            display_name=name,
                            is_bot=bool(getattr(sender, "bot", False)),
                            is_premium=bool(getattr(sender, "premium", False)),
                            is_admin=user_id in admin_ids,
                            source="from_messages",
                            bump_message=True,
                            raw={
                                "matched_keywords": sorted(seen[user_id]["keywords"]),
                                "last_matched_text": (message.message or "")[:300],
                                "last_matched_at": message_date.isoformat() if message_date else None,
                            },
                        )
                        found += 1
                    if scanned % 50 == 0:
                        await self._report_progress(
                            session, task, stage="scanning",
                            detail=f"已扫 {scanned} 条，识别到 {found} 个发言成员（最近一次：{seen[user_id]['name']}）",
                            scanned=scanned, found=found, total=limit,
                        )
        except BaseException as exc:  # noqa: BLE001
            await self._apply_status(session, account, exc)
            raise self._failure(exc, "采集群内对话失败") from exc

        # 把「最后发言」时间与发言条数写进备注，方便按活跃度筛人
        active = sorted(seen.items(), key=lambda item: item[1]["messages"], reverse=True)[:20]
        top_names = "、".join(f"{info['name']}({info['messages']})" for _, info in active[:5])
        # 扫到 0 条多半不是「群里没消息」，而是这个号读不到历史：它不在群里、
        # 群不让看历史、或号被 Telegram 限制。把原因说清楚，别让人以为系统坏了。
        empty_hint = ""
        if scanned == 0:
            # 扫不到就当场查一次「我在不在这个群」，把原因写死：
            # 光回一句「0 条」等于没说，用户只能对着截图干瞪眼
            try:
                from telethon.tl.functions.channels import GetParticipantRequest

                await client(GetParticipantRequest(channel=entity, participant="me"))
                empty_hint = "；账号在群里，但读不到历史消息——群不允许看历史，或该号被 Telegram 限制了可见范围"
            except BaseException:  # noqa: BLE001 - 探测本身失败就退回笼统提示
                empty_hint = "；账号不在这个群里（或已被踢出），非成员读不到历史消息"
        await self._report_progress(
            session, task, stage="done",
            detail=(
                f"扫描 {scanned} 条消息（命中关键词 {matched} 条），识别 {found} 个发言成员"
                if keywords
                else f"扫描 {scanned} 条消息，识别 {found} 个发言成员"
            )
            + (f"；发言最多：{top_names}" if top_names else "")
            + empty_hint,
            scanned=scanned, found=found, total=limit,
        )
        return {
            "scanned": scanned,
            "matched": matched,
            "keywords": keywords,
            "keyword_hits": keyword_hits,
            "found": found,
            "skipped_admin": skipped_admin,
            "skipped_bot": skipped_bot,
            "days": days,
            "exclude_admins": exclude_admins,
            "top_speakers": [{"name": info["name"], "messages": info["messages"]} for _, info in active[:10]],
        }

    async def _collect_members(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """采集群成员名单：按页拉取，页间有间隔，单任务有上限（避免大批量拉取触发风控）。"""
        assert account is not None
        payload = dict(task.payload or {})
        profile_id = payload.get("profile_id")
        dialog = await self._resolve_group_dialog(session, task, payload)
        limit = min(
            int(payload.get("limit") or settings.group_intel_max_members_per_task),
            settings.group_intel_max_members_per_task,
        )
        client = self._client(account.id)

        from app.models import GroupProfile

        profile = None
        if profile_id:
            profile = await session.get(GroupProfile, uuid.UUID(str(profile_id)))
        if profile is None:
            tg_chat_id = int(payload.get("tg_chat_id") or (dialog.tg_chat_id if dialog is not None else 0))
            if not tg_chat_id:
                raise TaskFailure("采集成员任务缺少 profile_id 或 tg_chat_id", retryable=False)
            entity = await resolve_chat_entity(client, tg_chat_id, session=session)
            profile = await upsert_profile(
                session,
                account_id=account.id,
                tg_chat_id=tg_chat_id,
                dialog_id=dialog.id if dialog is not None else None,
                source="profile_sync",
                touch_collected_at=False,
                **profile_fields_from_entity(entity),
            )
            profile_entity = entity
        else:
            profile_entity = (
                await self._resolve_entity(client, dialog, session) if dialog is not None else await resolve_chat_entity(client, profile.tg_chat_id, session=session, username_hint=getattr(profile, 'username', '') or '')
            )

        await self._report_progress(
            session, task, stage="fetching", detail=f"开始拉成员名单（上限 {limit} 人）", tg_chat_id=profile.tg_chat_id
        )
        fetched = await self._fetch_members(
            session,
            account=account,
            client=client,
            profile=profile,
            entity=profile_entity,
            limit=limit,
            task=task,
        )
        profile.member_synced_at = _now()
        profile.member_sampled = int(profile.member_sampled or 0) + fetched
        await session.flush()
        logger.info(
            "群成员采集完成",
            extra={
                "worker_id": self.worker.worker_id,
                "account_id": str(account.id),
                "task_id": str(task.id),
                "tg_chat_id": profile.tg_chat_id,
                "fetched": fetched,
            },
        )
        return {"profile_id": str(profile.id), "fetched": fetched, "limit": limit}

    async def _collect_link(self, session: Any, task: Task, account: Optional[TgAccount]) -> dict:
        """按群链接采集群员：`t.me/xxx`、`t.me/+hash`、`@username`、数字 ID 都能吃。

        流程（每一步都写清楚，失败时前端能直接读懂原因）：
        1. 解析链接——邀请链接先用 `CheckChatInvite` 预览：号**已在群里**就直接拿到实体；
        2. 号不在群里时：`join_if_missing=true` 才加入（加入是按高风险动作计费并过节流），否则明确报错；
        3. 采群档案 + 成员名单（分页、限速、单任务上限）；
        4. `leave_after=true` 时采完退出——留人不留痕，适合只用一次就走的采集号。
        """
        assert account is not None
        payload = dict(task.payload or {})
        link = str(payload.get("link") or "").strip()
        if not link:
            raise TaskFailure("缺少群链接", retryable=False)
        client = self._client(account.id)
        await self._report_progress(session, task, stage="resolving", detail=f"正在解析链接：{link}")

        entity, joined_now, preview = await self._resolve_link(
            client, link, join_if_missing=bool(payload.get("join_if_missing")), account=account, task=task
        )
        tg_chat_id = int(getattr(entity, "id", 0) or 0)
        if not tg_chat_id:
            raise TaskFailure(f"链接解析不出群实体：{link}", retryable=False)

        await self._report_progress(
            session,
            task,
            stage="joined" if joined_now else "resolved",
            detail=("已加入群，正在读资料" if joined_now else "号已在群里，正在读资料"),
            tg_chat_id=tg_chat_id,
            joined_now=joined_now,
        )
        try:
            full = await self._full_chat(client, entity)
        except Exception as exc:  # noqa: BLE001 - 拿不到完整资料不算失败，档案字段能填多少填多少
            logger.warning("按链接采集时读群资料失败：%s", describe_exception(exc))
            full = None

        fields = profile_fields_from_entity(entity, full)
        if preview.get("title") and not fields.get("title"):
            fields["title"] = preview["title"]
        if preview.get("participants_count") and not fields.get("member_count"):
            fields["member_count"] = preview["participants_count"]
        if preview.get("about") and not fields.get("about"):
            fields["about"] = preview["about"]

        profile = await upsert_profile(
            session,
            account_id=account.id,
            tg_chat_id=tg_chat_id,
            source="manual",
            raw={"link": link, "joined_now": joined_now},
            **fields,
        )
        # 顺手写进会话表：之后这个群就能出现在批量操作的选择范围里
        try:
            from app.models import DialogChannel, DialogKind
            from app.services.inbound import upsert_dialog

            dialog = await upsert_dialog(
                session,
                channel=DialogChannel.user_account,
                kind=DialogKind.group,
                tg_chat_id=tg_chat_id,
                account_id=account.id,
                title=profile.title,
                username=profile.username,
                peer_display=profile.title,
                member_count=profile.member_count,
            )
            profile.dialog_id = dialog.id
            await session.flush()
        except Exception:  # noqa: BLE001 - 会话表写入失败不影响采集结果
            logger.warning("按链接采集后写入会话表失败 tg_chat_id=%s", tg_chat_id)

        limit = min(int(payload.get("member_limit") or 200), settings.group_intel_max_members_per_task)
        fetched = 0
        await self._report_progress(
            session,
            task,
            stage="fetching",
            detail=f"开始拉成员名单（上限 {limit} 人）",
            tg_chat_id=tg_chat_id,
            title=profile.title,
            target_count=limit,
            fetched=0,
        )
        if limit > 0:
            fetched = await self._fetch_members(
                session,
                account=account,
                client=client,
                profile=profile,
                entity=entity,
                limit=limit,
                task=task,
            )
            profile.member_synced_at = _now()
            profile.member_sampled = int(profile.member_sampled or 0) + fetched
            await session.flush()

        left = False
        if joined_now and payload.get("leave_after"):
            try:
                if isinstance(entity, (tl_types.Channel, tl_types.ChannelForbidden)):
                    await client(functions.channels.LeaveChannelRequest(channel=entity))
                else:
                    await client(functions.messages.DeleteChatUserRequest(chat_id=tg_chat_id, user_id="me"))
                left = True
            except Exception:  # noqa: BLE001 - 退出失败不影响已采到的数据
                logger.warning("采完退出群失败 tg_chat_id=%s", tg_chat_id)

        await self._report_progress(
            session,
            task,
            stage="done",
            detail=f"采集完成：{profile.title or tg_chat_id} 共 {fetched} 人" + ("（已退出该群）" if left else ""),
            tg_chat_id=tg_chat_id,
            title=profile.title,
            fetched=fetched,
            target_count=limit,
            joined_now=joined_now,
            left_after=left,
        )
        logger.info(
            "按链接采集完成",
            extra={
                "worker_id": self.worker.worker_id,
                "account_id": str(account.id),
                "task_id": str(task.id),
                "tg_chat_id": tg_chat_id,
                "fetched": fetched,
                "joined": joined_now,
                "left": left,
            },
        )
        return {
            "tg_chat_id": tg_chat_id,
            "title": profile.title,
            "member_count": profile.member_count,
            "fetched": fetched,
            "joined_now": joined_now,
            "left_after": left,
            "profile_id": str(profile.id),
        }

    async def _resolve_link(
        self, client: Any, link: str, *, join_if_missing: bool, account: TgAccount, task: Task
    ) -> tuple[Any, bool, dict]:
        """链接 → (群实体, 是否本次加入, 预览信息)。邀请链接先预览，避免「默默把人全加进去」。"""
        raw = link.strip()
        invite_hash = ""
        if "+" in raw or "joinchat" in raw:
            invite_hash = raw.rsplit("+", 1)[-1] if "+" in raw else raw.rsplit("/", 1)[-1]
            invite_hash = invite_hash.split("?")[0].strip()

        if invite_hash:
            try:
                invite = await client(functions.messages.CheckChatInviteRequest(hash=invite_hash))
            except Exception as exc:  # noqa: BLE001
                wait = flood_wait_seconds(exc)
                if wait:
                    raise TaskFailure(
                        f"检查邀请链接被限流，{wait} 秒后重试：{describe_exception(exc)}",
                        retryable=True,
                        requeue_after=wait + 1,
                    ) from exc
                raise TaskFailure(f"邀请链接无效或已过期：{describe_exception(exc)}", retryable=False) from exc

            preview = {
                "title": str(getattr(invite, "title", "") or ""),
                "participants_count": getattr(invite, "participants_count", None),
                "about": str(getattr(invite, "about", "") or ""),
            }
            chat = getattr(invite, "chat", None)  # ChatInviteAlready：号已经在群里
            if chat is not None:
                return chat, False, preview
            if not join_if_missing:
                raise TaskFailure(
                    f"该号不在群里（{preview['title'] or '未知群'}，约 {preview['participants_count'] or '?'} 人）："
                    "发起采集时勾选「不在群里时自动加入」即可采集",
                    retryable=False,
                )
            # 加入群是高风险动作：过闸门并按 3 倍权重计费
            await self._throttle_gate(account, task, task_type="join_group")
            try:
                result = await client(functions.messages.ImportChatInviteRequest(hash=invite_hash))
            except Exception as exc:  # noqa: BLE001
                wait = flood_wait_seconds(exc)
                if wait:
                    raise TaskFailure(
                        f"加入群被限流，{wait} 秒后重试：{describe_exception(exc)}", retryable=True, requeue_after=wait + 1
                    ) from exc
                raise TaskFailure(f"加入群失败：{describe_exception(exc)}", retryable=False) from exc
            await self._throttle_record(account, task, cost=3, task_type="join_group")
            chats = list(getattr(result, "chats", []) or [])
            if not chats:
                raise TaskFailure("加入群成功但没拿到群实体，稍后重试", retryable=True)
            return chats[0], True, preview

        # 公开群 / 用户名 / 数字 ID
        username = raw.split("/")[-1].lstrip("@").strip()
        try:
            entity = await client.get_entity(username)
        except Exception as exc:  # noqa: BLE001
            wait = flood_wait_seconds(exc)
            if wait:
                raise TaskFailure(
                    f"解析群链接被限流，{wait} 秒后重试：{describe_exception(exc)}", retryable=True, requeue_after=wait + 1
                ) from exc
            raise TaskFailure(
                f"解析群链接失败（{raw}）：{describe_exception(exc)}；私有群请用邀请链接 t.me/+xxx",
                retryable=False,
            ) from exc
        return entity, False, {}

    # ---------------- 公共：Telegram 调用 ----------------

    async def _resolve_group_dialog(self, session: Any, task: Task, payload: dict) -> Optional[Dialog]:
        """任务里的 dialog_id（可选）→ dialogs 行。"""
        raw = payload.get("dialog_id") or (str(task.dialog_id) if task.dialog_id else "")
        if not raw:
            return None
        try:
            dialog_id = uuid.UUID(str(raw))
        except ValueError:
            return None
        return await session.get(Dialog, dialog_id)

    async def _full_chat(self, client: Any, entity: Any) -> Any:
        """读群全量资料：超级群/频道走 GetFullChannel，普通群走 GetFullChat。"""
        if isinstance(entity, (tl_types.Channel, tl_types.ChannelForbidden)):
            return await client(functions.channels.GetFullChannelRequest(channel=entity))
        if isinstance(entity, tl_types.Chat):
            return await client(functions.messages.GetFullChatRequest(chat_id=entity.id))
        return None

    async def _member_visibility(self, client: Any, entity: Any) -> Optional[str]:
        """检查「能不能采这个群的成员」，返回 None 表示可以，否则返回给用户看的原因。

        两个常见原因都会让 Telegram 返回空列表（看起来像「采集没效果」）：
        1. **执行号不在群里**——非成员看不到成员名单；
        2. **群主隐藏了成员名单**（`participants_hidden`）——这时任何客户端都拉不到，
           不是权限或代码问题，只能群主去群设置里关掉。
        """
        try:
            full = await client(functions.channels.GetFullChannelRequest(channel=entity))
            full_chat = getattr(full, "full_chat", None)
            if getattr(full_chat, "participants_hidden", False):
                return (
                    "该群隐藏了成员名单（群主在群设置里开启的），Telegram 不允许任何客户端拉取成员；"
                    "需要群主到「群设置 → 成员 → 隐藏成员列表」关掉后才能采集。"
                )
        except BaseException as exc:  # noqa: BLE001 - 读不到群详情不阻塞，继续做成员探测
            self.log.debug("读群详情失败（继续探测成员）: %s", describe_exception(exc))

        try:
            await client(functions.channels.GetParticipantRequest(channel=entity, participant="me"))
        except BaseException as exc:  # noqa: BLE001
            name = type(exc).__name__
            if "NotParticipant" in name or "PARTICIPANT" in str(exc):
                return (
                    "执行采集的号不在这个群里，非成员看不到成员名单；"
                    "先用「加群」把它拉进群，或换一个已在群里的号再采集。"
                )
            if "ChatAdminRequired" in name:
                return "群权限不足（需要管理员权限才能读取成员），请换一个有权限的号。"
            if "ChannelPrivate" in name:
                return "该群为私有或已无法访问，执行号可能已被移出，请换号或重新入群。"
            self.log.debug("成员身份探测异常（继续尝试采集）: %s", describe_exception(exc))
        return None

    async def _fetch_members(
        self,
        session: Any,
        *,
        account: TgAccount,
        client: Any,
        profile: Any,
        entity: Any,
        limit: int,
        task: Any = None,
    ) -> int:
        """分页拉成员并写库。页与页之间 sleep `GROUP_INTEL_PAGE_INTERVAL_SECONDS`，并逐页上报进度。"""
        if limit <= 0:
            return 0
        # 先问清楚「能不能采」：不在群里 / 群隐藏名单时 Telegram 只会返回空列表，
        # 不说清楚就会变成「点了采集，结果 0 个人」这种看不懂的情况。
        blocked = await self._member_visibility(client, entity)
        if blocked:
            raise TaskFailure(blocked, retryable=False)
        page_size = max(1, min(settings.group_intel_page_size, limit))
        fetched = 0
        offset = 0
        is_channel = isinstance(entity, (tl_types.Channel, tl_types.ChannelForbidden))
        while fetched < limit:
            want = min(page_size, limit - fetched)
            try:
                if is_channel:
                    resp = await client(
                        functions.channels.GetParticipantsRequest(
                            channel=entity,
                            filter=tl_types.ChannelParticipantsRecent(),
                            offset=offset,
                            limit=want,
                            hash=0,
                        )
                    )
                    users = list(getattr(resp, "users", []) or [])
                    participants = {int(getattr(p, "user_id", 0) or 0): p for p in getattr(resp, "participants", []) or []}
                else:
                    full = await client(functions.messages.GetFullChatRequest(chat_id=entity.id))
                    users = list(getattr(full, "users", []) or [])
                    participants = {}
            except Exception as exc:  # noqa: BLE001 - 单页失败不再无限重试
                wait = flood_wait_seconds(exc)
                if wait:
                    raise TaskFailure(
                        f"拉成员被限流，{wait} 秒后重试：{describe_exception(exc)}",
                        retryable=True,
                        requeue_after=wait + 1,
                    ) from exc
                logger.warning("拉群成员失败（已采 %s 个）：%s", fetched, describe_exception(exc))
                break

            if not users:
                break
            for user in users:
                try:
                    participant = participants.get(int(getattr(user, "id", 0) or 0))
                    await upsert_member(
                        session,
                        profile=profile,
                        tg_user_id=int(user.id),
                        username=getattr(user, "username", None),
                        display_name=display_name_of(user),
                        is_bot=bool(getattr(user, "bot", False)),
                        is_premium=bool(getattr(user, "premium", False)),
                        is_admin=bool(getattr(participant, "admin_rights", None)),
                        status="member",
                        source="participant_sync",
                    )
                    fetched += 1
                except Exception:  # noqa: BLE001 - 单个成员失败不中断整页
                    continue
            offset += len(users)
            if task is not None:
                await self._report_progress(
                    session,
                    task,
                    stage="fetching",
                    detail=f"已采 {fetched}/{limit} 人",
                    tg_chat_id=profile.tg_chat_id,
                    title=profile.title,
                    fetched=fetched,
                    target_count=limit,
                )
            if len(users) < want:
                break
            if fetched < limit:
                await asyncio.sleep(max(0.5, float(settings.group_intel_page_interval_seconds)))
        return fetched


__all__ = ["GroupIntelMixin", "make_chat_action_handler"]
