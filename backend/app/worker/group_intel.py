"""群情报 Worker 侧：入群/退群事件的「无感」记录 + 群档案与成员名单的按需采集。

无感的三条纪律（代码里逐条落实）：
1. 事件回调**只写库**：不回复、不打招呼、不加表情、不做任何群内可见动作；
2. 采集只用读接口（`GetFullChannel` / `GetParticipants`），且分页之间有间隔、单任务有上限；
3. 成员数变化等群内动静全部来自事件的被动观察，不主动轮询群列表。
"""

from __future__ import annotations

import asyncio
import logging
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
    Dialog,
    DialogChannel,
    DiscoveryLead,
    DiscoveryQueryStat,
    GroupProfile,
    GroupSearchKeyword,
    GroupSearchMatch,
    Task,
    TgAccount,
)
from app.services.group_discovery import extract_links, invite_url, parse_tme_page, tme_url
from app.services.group_precision import (
    classify,
    canonical_topics,
    discussion_verdict,
    score_group,
    verification_flags,
)
from app.services.group_intel import (
    describe_chat_action,
    display_name_of,
    member_status_for_event,
    profile_fields_from_entity,
    record_event,
    upsert_member,
    upsert_profile,
)
from app.services.group_search import SearchQuery, expand_queries
from app.worker.entities import resolve_chat_entity, resolve_entity
from app.worker.campaign_tasks import _invite_hash_of, _username_from_target
from app.worker.humanize import sleep_human
from app.worker.telethon_account import TaskFailure, describe_exception, flood_wait_seconds

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
    if stat.template != "base" and stat.runs >= 5 and stat.zero_streak >= 3:
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
    ) -> Optional[dict]:
        """验证一个用户名/邀请链接；公开群落档案，私群落线索。"""

        raw = {
            "discovered_from": source,
            "seed_chat_id": seed_chat_id,
            "link": link.url,
            "query": query,
            "depth": 1,
        }
        if link.kind == "username":
            res = await client(functions.contacts.ResolveUsernameRequest(username=link.value))
            chats = list(getattr(res, "chats", []) or [])
            chat = next(
                (item for item in chats if str(getattr(item, "username", "") or "").casefold() == link.value),
                chats[0] if chats else None,
            )
            if chat is None:
                return None
            chat_id = await self._store_discovered_chat(session, account, chat, source=source, raw=raw)
            if chat_id is None:
                return None
            kind = "channel" if getattr(chat, "broadcast", False) else "group"
            return {
                "title": getattr(chat, "title", "") or "",
                "username": getattr(chat, "username", None),
                "tg_chat_id": chat_id,
                "kind": kind,
                "members": getattr(chat, "participants_count", None),
            }

        res = await client(functions.messages.CheckChatInviteRequest(hash=link.value))
        if isinstance(res, (tl_types.ChatInviteAlready, tl_types.ChatInvitePeek)):
            chat = getattr(res, "chat", None)
            if chat is None:
                return None
            chat_id = await self._store_discovered_chat(session, account, chat, source=source, raw=raw)
            if chat_id is None:
                return None
            kind = "channel" if getattr(chat, "broadcast", False) else "group"
            return {
                "title": getattr(chat, "title", "") or "",
                "username": getattr(chat, "username", None),
                "tg_chat_id": chat_id,
                "kind": kind,
                "members": getattr(chat, "participants_count", None),
            }
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
    ) -> list[dict]:
        """读种子频道最近消息，抓 t.me/@username 反查，图扩散深度固定为 1。"""

        found: list[dict] = []
        seen_links: set[tuple[str, str]] = set()
        channels = seeds[: max(0, channel_limit)]
        for index, seed in enumerate(channels):
            seed_id = int(getattr(seed, "id", 0) or 0)
            try:
                async for message in client.iter_messages(seed, limit=message_limit):
                    if len(seen_links) >= max_links:
                        break
                    texts = [getattr(message, "message", "") or ""]
                    for link in extract_links(texts, limit=max_links - len(seen_links)):
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
                                source="message_link",
                                query=query,
                                seed_chat_id=seed_id,
                                metrics=metrics,
                            )
                        except BaseException as exc:  # noqa: BLE001 - 单条链接失败继续下一条
                            metrics["message_errors"] += 1
                            self.log.debug("消息链接验证失败 %s: %s", link.url, exc)
                            hit = None
                        if hit is not None:
                            found.append(hit)
                            metrics["message_profiles"] += 1
                        await sleep_human(1.0, 2.2, rng)
                        if len(seen_links) >= max_links:
                            break
            except BaseException as exc:  # noqa: BLE001 - 单个频道读不到就跳过
                metrics["message_errors"] += 1
                self.log.debug("读频道消息失败 seed=%s: %s", seed_id, exc)
            await self._report_progress(
                session,
                task,
                stage="expanding_messages",
                detail=(
                    f"已读 {index + 1}/{len(channels)} 个频道，发现 {len(seen_links)} 个链接，"
                    f"公开群 {len(found)} 个"
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
    ) -> list[dict]:
        """用 Telegram 的相似频道推荐扩展种子，仍然只读。"""

        found: list[dict] = []
        channels = seeds[: max(0, channel_limit)]
        for index, seed in enumerate(channels):
            seed_id = int(getattr(seed, "id", 0) or 0)
            try:
                res = await client(functions.channels.GetChannelRecommendationsRequest(channel=seed))
                for chat in list(getattr(res, "chats", []) or []):
                    chat_id = await self._store_discovered_chat(
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
                    if chat_id is None:
                        continue
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
        self._ensure_sendable(account)
        payload = dict(task.payload or {})
        if str(payload.get("mode") or "") == "precise":
            return await self._search_groups_precise(session, task, account, payload)
        keywords = [str(item).strip() for item in (payload.get("keywords") or []) if str(item).strip()][:20]
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

    async def _search_groups_precise(
        self,
        session: Any,
        task: Task,
        account: TgAccount,
        payload: dict,
    ) -> dict:
        """多语言精准检索：多源召回 → 严格类型/权限校验 → 相关性评分 → 匹配快照。

        与旧 `_search_groups` 的区别：
        - 召回源不只 contacts.search，还支持 messages.searchGlobal、频道 linked_chat；
        - 搜索阶段不提前过滤频道，频道只作为 linked_chat/图扩散种子；
        - 每个群必须通过「超级群 + 非广播/非 gigagroup/非 monoforum」硬校验；
        - 评分满分 100，按名称/简介/地区/讨论意图/语言五项落库，便于解释排序。
        """

        self._ensure_sendable(account)
        keywords = [str(item).strip() for item in (payload.get("keywords") or []) if str(item).strip()][:20]
        if not keywords:
            raise TaskFailure("精准检索缺少关键词", retryable=False)

        country = str(payload.get("country") or "").strip().upper() or None
        languages = [str(item).strip() for item in (payload.get("languages") or []) if str(item).strip()][:6]
        per_query = max(1, min(int(payload.get("limit") or 50), 100))
        min_members = max(0, int(payload.get("min_members") or 0))
        max_queries = max(1, min(int(payload.get("max_queries") or 120), 300))
        group_only = bool(payload.get("group_only", True))
        public_only = bool(payload.get("public_only", True))
        exclude_readonly = bool(payload.get("exclude_readonly", True))
        include_linked = bool(payload.get("include_linked_groups", True))
        max_linked = max(0, min(int(payload.get("max_linked_chats") or 50), 200))
        search_messages = bool(payload.get("search_messages", True))
        message_queries = max(0, min(int(payload.get("message_search_queries") or 3), 20))
        full_check_limit = max(0, min(int(payload.get("full_check_limit") or 40), 100))
        min_score = max(0, min(int(payload.get("min_relevance_score") or 60), 100))

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
        if not queries:
            raise TaskFailure("精准检索没有生成可用查询", retryable=False)

        client = self._client(account.id)
        rng = self._campaign_rng(task, payload)
        metrics = {
            "queries": len(queries),
            "raw_chats": 0,
            "candidates": 0,
            "message_raw_chats": 0,
            "message_errors": 0,
            "query_errors": 0,
            "local_found": 0,
            "local_errors": 0,
            "linked_found": 0,
            "linked_errors": 0,
            "full_checked": 0,
            "full_errors": 0,
            "accepted": 0,
            "needs_review": 0,
            "rejected": 0,
            "channels": 0,
            "readonly": 0,
            "dropped_members": 0,
            "score_sum": 0,
        }
        candidates: dict[int, dict[str, Any]] = {}

        def add_candidate(chat: Any, *, source: str, query: str, keyword: str) -> Optional[int]:
            chat_id = int(getattr(chat, "id", 0) or 0)
            if not chat_id:
                return None
            entry = candidates.get(chat_id)
            if entry is None:
                entry = {
                    "chat": chat,
                    "sources": [],
                    "query": query,
                    "keyword": keyword,
                    "full": None,
                }
                candidates[chat_id] = entry
                metrics["candidates"] += 1
            if source not in entry["sources"]:
                entry["sources"].append(source)
            return chat_id

        async def record_keyword(query: str, source: str, *, status: str, raw: int, found: int, error: str = "") -> None:
            await session.execute(
                pg_insert(GroupSearchKeyword)
                .values(
                    id=uuid.uuid4(),
                    task_id=task.id,
                    account_id=account.id,
                    query=query[:255],
                    source=source,
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

        # 1) contacts.search：全局实体搜索，原始关键词和地区扩展都跑。
        for index, item in enumerate(queries):
            try:
                res = await client(functions.contacts.SearchRequest(q=item.query, limit=per_query))
            except BaseException as exc:  # noqa: BLE001 - 单条失败不影响整批
                metrics["query_errors"] += 1
                err = f"{type(exc).__name__}: {str(exc)[:160]}"
                await record_keyword(item.query, "contacts", status="error", raw=0, found=0, error=err)
                try:
                    await _record_query_stat(session, item, raw_count=0, found_count=0, error=err)
                except BaseException:  # noqa: BLE001
                    pass
                continue

            chats = list(getattr(res, "chats", []) or [])
            metrics["raw_chats"] += len(chats)
            found = 0
            for chat in chats:
                if add_candidate(chat, source="contacts", query=item.query, keyword=item.keyword):
                    found += 1
            await record_keyword(item.query, "contacts", status="ok", raw=len(chats), found=found)
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
                total=len(queries),
            )
            if index < len(queries) - 1:
                await sleep_human(2.0, 5.0, rng)

        # 2) messages.searchGlobal：只搜群消息，补 contacts.search 召回不到的长尾。
        if search_messages and message_queries:
            for index, item in enumerate(queries[:message_queries]):
                try:
                    res = await client(
                        functions.messages.SearchGlobalRequest(
                            q=item.query,
                            filter=tl_types.InputMessagesFilterEmpty(),
                            min_date=None,
                            max_date=None,
                            offset_rate=0,
                            offset_peer=tl_types.InputPeerEmpty(),
                            offset_id=0,
                            limit=min(per_query, 50),
                            groups_only=True,
                        )
                    )
                except BaseException as exc:  # noqa: BLE001
                    metrics["message_errors"] += 1
                    await record_keyword(
                        item.query,
                        "message_search",
                        status="error",
                        raw=0,
                        found=0,
                        error=f"{type(exc).__name__}: {str(exc)[:160]}",
                    )
                    continue

                chats = list(getattr(res, "chats", []) or [])
                metrics["message_raw_chats"] += len(chats)
                found = 0
                for chat in chats:
                    if add_candidate(chat, source="message_search", query=item.query, keyword=item.keyword):
                        found += 1
                await record_keyword(item.query, "message_search", status="ok", raw=len(chats), found=found)
                await self._report_progress(
                    session,
                    task,
                    stage="searching",
                    detail=f"消息搜索「{item.query}」返回 {len(chats)} 个实体（候选 {len(candidates)}）",
                    scanned=index + 1,
                    found=len(candidates),
                    total=message_queries,
                )
                if index < message_queries - 1:
                    await sleep_human(3.0, 6.0, rng)

        # 2b) 本地历史群档案：已经采过的公开群，按标题/简介命中后复核用户名再加入候选。
        local_profiles = list(
            await session.scalars(
                select(GroupProfile)
                .where(
                    GroupProfile.account_id == account.id,
                    GroupProfile.username.is_not(None),
                    or_(
                        *[
                            GroupProfile.title.ilike(f"%{keyword}%")
                            for keyword in keywords
                        ],
                        *[
                            GroupProfile.about.ilike(f"%{keyword}%")
                            for keyword in keywords
                        ],
                    ),
                )
                .order_by(GroupProfile.updated_at.desc())
                .limit(20)
            )
        )
        for index, profile in enumerate(local_profiles):
            username = str(profile.username or "").lstrip("@")
            if not username or int(profile.tg_chat_id or 0) in candidates:
                continue
            try:
                resolved = await client(functions.contacts.ResolveUsernameRequest(username=username))
                chats = list(getattr(resolved, "chats", []) or [])
                if chats and add_candidate(chats[0], source="local_index", query="", keyword=keywords[0]):
                    metrics["local_found"] += 1
            except BaseException:  # noqa: BLE001
                metrics["local_errors"] += 1
            if index < len(local_profiles) - 1:
                await sleep_human(1.0, 2.0, rng)

        # 3) 频道 linked_chat：只读，不需要入群。
        if include_linked and max_linked:
            seeds = [
                entry["chat"]
                for entry in candidates.values()
                if bool(getattr(entry["chat"], "broadcast", False)) and getattr(entry["chat"], "username", None)
            ][:max_linked]
            for index, seed in enumerate(seeds):
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
                        linked = await client.get_entity(tl_types.PeerChannel(linked_id))
                    if add_candidate(linked, source="linked_chat", query="", keyword=keywords[0]):
                        metrics["linked_found"] += 1
                except BaseException:  # noqa: BLE001
                    metrics["linked_errors"] += 1
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

        # 4) 只对讨论组候选拉 GetFullChannel（拿 about/权限），频道不浪费配额。
        full_targets = [
            cid
            for cid, entry in candidates.items()
            if discussion_verdict(entry["chat"])[0]
        ][:full_check_limit]
        for index, chat_id in enumerate(full_targets):
            entry = candidates[chat_id]
            try:
                entry["full"] = await client(functions.channels.GetFullChannelRequest(channel=entry["chat"]))
                metrics["full_checked"] += 1
            except BaseException:  # noqa: BLE001
                metrics["full_errors"] += 1
            if index < len(full_targets) - 1:
                await sleep_human(1.0, 2.5, rng)

        # 5) 校验 + 评分 + 落库。
        for chat_id, entry in candidates.items():
            chat = entry["chat"]
            full = entry.get("full")
            full_chat = getattr(full, "full_chat", None) if full is not None else None
            title = str(getattr(chat, "title", "") or "")
            about = str(getattr(full_chat, "about", "") or "") if full_chat is not None else ""
            username = getattr(chat, "username", None)
            members = (
                getattr(full_chat, "participants_count", None)
                if full_chat is not None
                else None
            ) or getattr(chat, "participants_count", None)
            if min_members and (members or 0) < min_members:
                metrics["dropped_members"] += 1
                continue

            type_ok, type_reason = discussion_verdict(chat)
            flags = verification_flags(chat, full)
            score = score_group(
                title=title,
                about=about,
                username=username,
                keywords=keywords,
                country=country,
                languages=languages,
            )
            reasons = list(score.reasons)
            status = classify(score.score, min_score=min_score)
            if group_only and not type_ok:
                status = "rejected"
                reasons.append(f"类型不合格：{type_reason}")
                metrics["channels"] += 1
            if public_only and not flags["is_public"]:
                status = "rejected"
                reasons.append("没有公开用户名")
            if exclude_readonly and flags["readonly"]:
                status = "rejected"
                reasons.append("默认权限为只读")
                metrics["readonly"] += 1

            metrics[status] += 1
            metrics["score_sum"] += score.score

            try:
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
                        "query": entry["query"],
                        "keyword": entry["keyword"],
                    },
                    **profile_fields_from_entity(chat, full),
                    language=score.language,
                    country=score.country,
                    topic=score.topic,
                    relevance_score=score.score,
                    send_permission=flags["send_permission"],
                    join_request=flags["join_request"],
                    linked_channel_id=flags["linked_channel_id"],
                    verification_status=flags["verification_status"],
                    last_verified_at=_now(),
                    discovery_sources=entry["sources"],
                    matched_keywords=score.matched_keywords,
                )
            except BaseException:  # noqa: BLE001 - 单个群落档失败不影响整批
                self.log.debug("精准检索落档失败 tg_chat_id=%s", chat_id)
                continue

            await session.execute(
                pg_insert(GroupSearchMatch)
                .values(
                    id=uuid.uuid4(),
                    task_id=task.id,
                    account_id=account.id,
                    profile_id=profile.id,
                    tg_chat_id=chat_id,
                    title=title[:255],
                    username=username,
                    member_count=int(members) if members is not None else None,
                    source=str(entry["sources"][0] if entry["sources"] else "contacts"),
                    query=str(entry["query"] or "")[:255],
                    keywords=keywords,
                    relevance_score=score.score,
                    breakdown=score.breakdown,
                    matched_keywords=score.matched_keywords,
                    discovery_sources=entry["sources"],
                    language=score.language,
                    country=score.country,
                    topic=score.topic,
                    status=status,
                    reasons=reasons,
                    raw={"type_reason": type_reason, **flags},
                )
                .on_conflict_do_update(
                    index_elements=["task_id", "tg_chat_id"],
                    set_={
                        "profile_id": profile.id,
                        "title": title[:255],
                        "username": username,
                        "member_count": int(members) if members is not None else None,
                        "relevance_score": score.score,
                        "breakdown": score.breakdown,
                        "matched_keywords": score.matched_keywords,
                        "discovery_sources": entry["sources"],
                        "status": status,
                        "reasons": reasons,
                        "raw": {"type_reason": type_reason, **flags},
                        "updated_at": _now(),
                    },
                )
            )

        await self._report_progress(
            session,
            task,
            stage="done",
            detail=(
                f"精准检索完成：{len(candidates)} 个候选，{metrics['accepted']} 个保留，"
                f"{metrics['needs_review']} 个待确认，{metrics['rejected']} 个排除"
            ),
            scanned=len(queries),
            found=metrics["accepted"],
            total=len(queries),
        )
        average = round(metrics["score_sum"] / max(metrics["accepted"] + metrics["needs_review"] + metrics["rejected"], 1), 1)
        return {
            "mode": "precise",
            "keywords": keywords,
            "country": country,
            "languages": languages,
            "queries_run": len(queries),
            "min_relevance_score": min_score,
            "candidates": len(candidates),
            "accepted": metrics["accepted"],
            "needs_review": metrics["needs_review"],
            "rejected": metrics["rejected"],
            "average_score": average,
            "metrics": metrics,
            "summary": (
                f"精准检索：{len(queries)} 条查询，{len(candidates)} 个候选，"
                f"保留 {metrics['accepted']} 个、待确认 {metrics['needs_review']} 个、排除 {metrics['rejected']} 个"
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
