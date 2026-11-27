"""新版精准找群流水线的离线测试（mock Telegram / Session / AI，不连外网与数据库）。

    cd backend && .venv/bin/python -m tests.group_precise_pipeline_check
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Optional

from telethon import functions
from telethon.errors import AuthKeyUnregisteredError, FloodWaitError
from telethon.tl import types as tl_types

import httpx

from app.api.routers.group_intel import get_precise_batch
from app.config import settings
from app.models import AccountStatus, TaskStatus, TaskType
from app.schemas.group_intel import GroupSearchMatchOut
from app.services.external_group_sources import (
    DirectoryAdapter,
    SearchEngineAdapter,
    SeedManifestAdapter,
    fetch_external_candidates,
    validate_external_url,
)
from app.services.group_ai import expand_queries_with_ai, review_candidates_with_ai
from app.services.group_search import expand_queries
from app.worker import group_intel as worker_gi
from app.worker.telethon_account import (
    TaskFailure,
    describe_exception,
    flood_wait_seconds,
    is_network_error,
    map_exception_to_status,
)


class Channel:
    """模拟 Telethon Channel 实体（名称需含 channel 供 profile_fields_from_entity 识别）。"""

    def __init__(
        self,
        *,
        id: int,
        title: str,
        username: Optional[str] = None,
        megagroup: bool = True,
        broadcast: bool = False,
        participants_count: Optional[int] = 500,
    ) -> None:
        self.id = id
        self.title = title
        self.username = username
        self.megagroup = megagroup
        self.broadcast = broadcast
        self.gigagroup = False
        self.monoforum = False
        self.default_banned_rights = None
        self.join_request = False
        self.join_to_send = False
        self.restricted = False
        self.scam = False
        self.participants_count = participants_count


class _FakeScalars:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def __iter__(self):
        return iter(self._rows)


class _FakeSession:
    def __init__(self) -> None:
        self.executed: list[Any] = []
        self.savepoints_entered = 0
        self.savepoints_exited = 0
        self.savepoints_rolled_back = 0
        self.flushed = 0

    async def scalars(self, _stmt: Any) -> _FakeScalars:
        return _FakeScalars([])

    async def scalar(self, _stmt: Any) -> None:
        return None

    async def execute(self, stmt: Any) -> None:
        self.executed.append(stmt)

    async def flush(self) -> None:
        self.flushed += 1

    async def commit(self) -> None:
        return None

    @asynccontextmanager
    async def begin_nested(self):
        self.savepoints_entered += 1
        try:
            yield self
        except BaseException:
            self.savepoints_rolled_back += 1
            raise
        finally:
            self.savepoints_exited += 1


class _Harness(worker_gi.GroupIntelMixin):
    def __init__(self, client: Any) -> None:
        self.log = logging.getLogger("group_precise_pipeline_check")
        self._fake_client = client
        self.progress: list[dict[str, Any]] = []
        self.applied_statuses: list[tuple[Optional[AccountStatus], BaseException]] = []

    def _client(self, _account_id: Any) -> Any:
        return self._fake_client

    def _campaign_rng(self, _task: Any, _payload: dict) -> random.Random:
        return random.Random(42)

    async def _report_progress(self, _session: Any, _task: Any, **kwargs: Any) -> None:
        self.progress.append(kwargs)

    async def _apply_status(
        self,
        _session: Any,
        account: Any,
        exc: BaseException,
        status: Optional[AccountStatus] = None,
    ) -> Optional[AccountStatus]:
        resolved = status or map_exception_to_status(exc)
        self.applied_statuses.append((resolved, exc))
        if resolved is None:
            return None
        account.status = resolved
        account.status_reason = describe_exception(exc)[:255]
        wait = flood_wait_seconds(exc)
        if wait:
            account.flood_until = datetime.now(tz=timezone.utc) + timedelta(seconds=wait)
        return resolved

    @staticmethod
    def _failure(exc: BaseException, prefix: str, *, retryable: Optional[bool] = None) -> TaskFailure:
        wait = flood_wait_seconds(exc)
        if wait:
            return TaskFailure(
                f"{prefix}：{describe_exception(exc)}",
                retryable=True,
                requeue_after=wait + 1,
            )
        if retryable is None:
            retryable = is_network_error(exc)
        return TaskFailure(f"{prefix}：{describe_exception(exc)}", retryable=retryable)


def _make_account_and_task(payload: dict[str, Any]):
    account_id = uuid.uuid4()
    account = SimpleNamespace(
        id=account_id,
        status=AccountStatus.healthy,
        status_reason="",
        last_error="",
        flood_until=None,
        last_checked_at=None,
    )
    task = SimpleNamespace(id=uuid.uuid4(), account_id=account_id, payload=payload, result=None)
    return account, task


async def _noop_sleep(*_args: Any, **_kwargs: Any) -> None:
    return None


async def test_helpers_and_ai_fallback() -> None:
    assert worker_gi.GroupIntelMixin._shard_list([0, 1, 2, 3, 4], 0, 2) == [0, 2, 4]
    assert worker_gi.GroupIntelMixin._shard_list([0, 1, 2, 3, 4], 1, 2) == [1, 3]

    # participants_count=0 且未拉 GetFullChannel 时应返回 None（未知规模，不误扣小群分）
    assert worker_gi.GroupIntelMixin._chat_members_of(SimpleNamespace(participants_count=0)) is None
    assert (
        worker_gi.GroupIntelMixin._chat_members_of(
            SimpleNamespace(participants_count=0),
            full_chat=SimpleNamespace(participants_count=0),
        )
        == 0
    )
    assert (
        worker_gi.GroupIntelMixin._chat_members_of(
            SimpleNamespace(participants_count=0),
            tme_info={"member_count": 0},
        )
        == 0
    )

    orig_enabled = settings.ai_enabled
    orig_key = settings.ai_api_key
    try:
        settings.ai_enabled = False
        settings.ai_api_key = ""
        extra, note_expand = await expand_queries_with_ai(["Forex Thailand"], country="TH", languages=["th"])
        reviews, note_review = await review_candidates_with_ai(
            [{"tg_chat_id": 1, "title": "Forex TH", "about": ""}],
            keywords=["Forex Thailand"],
        )
        assert extra == [] and note_expand and "降级" in note_expand, note_expand
        assert reviews == {} and note_review and "降级" in note_review, note_review
    finally:
        settings.ai_enabled = orig_enabled
        settings.ai_api_key = orig_key


async def test_expand_from_messages_tme_and_flood() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_http = worker_gi.httpx.AsyncClient
    worker_gi.sleep_human = _noop_sleep
    try:
        resolved_usernames: list[str] = []

        class _Client:
            async def iter_messages(self, _seed: Any, limit: int = 50):
                if False:
                    yield None

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.ResolveUsernameRequest):
                    resolved_usernames.append(req.username)
                    return SimpleNamespace(
                        chats=[Channel(id=5000 + len(resolved_usernames), title=req.username, username=req.username)]
                    )
                return SimpleNamespace(chats=[])

        class _FakeResp:
            status_code = 200
            text = (
                '<div class="tgme_widget_message_text">'
                '<a href="https://t.me/link_alpha">@link_alpha</a> '
                '<a href="https://t.me/link_beta">@link_beta</a> '
                '<a href="https://t.me/link_gamma">@link_gamma</a>'
                "</div>"
            )

        class _FakeAsyncHttp:
            def __init__(self, **_kwargs: Any) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args: Any) -> None:
                return None

            async def get(self, _url: str):
                return _FakeResp()

        worker_gi.httpx.AsyncClient = _FakeAsyncHttp
        harness = _Harness(_Client())
        metrics = {"message_errors": 0, "message_profiles": 0, "invite_leads": 0}
        collected_chats: list[tuple[int, str]] = []
        seeds = [
            Channel(id=91, title="Seed 1", username="seed_one", megagroup=False, broadcast=True),
            Channel(id=92, title="Seed 2", username="seed_two", megagroup=False, broadcast=True),
        ]
        await harness._expand_from_messages(
            harness._fake_client,
            _FakeSession(),
            SimpleNamespace(id=uuid.uuid4()),
            seeds,
            task=SimpleNamespace(id=uuid.uuid4()),
            query="forex",
            channel_limit=2,
            message_limit=20,
            max_links=2,
            rng=random.Random(1),
            metrics=metrics,
            store_directly=False,
            on_chat=lambda ch, tag, _sid: collected_chats.append((ch.id, tag)),
            source_tag="channel_link",
        )
        assert resolved_usernames == ["link_alpha", "link_beta"], resolved_usernames
        assert len(collected_chats) == 2 and all(tag == "channel_link" for _, tag in collected_chats)

        # iter_messages 触发 FloodWait 且提供 on_rpc_error 时应立刻中止，不再退回 t.me/s 或继续下个种子
        http_called = False

        class _FailHttp(_FakeAsyncHttp):
            async def get(self, _url: str):
                nonlocal http_called
                http_called = True
                return _FakeResp()

        class _FloodIterClient(_Client):
            async def iter_messages(self, _seed: Any, limit: int = 50):
                raise FloodWaitError(request=None, capture=12)
                yield None

        worker_gi.httpx.AsyncClient = _FailHttp
        rpc_errors: list[BaseException] = []

        async def _stop_on_err(exc: BaseException) -> bool:
            rpc_errors.append(exc)
            return True

        await _Harness(_FloodIterClient())._expand_from_messages(
            _FloodIterClient(),
            _FakeSession(),
            SimpleNamespace(id=uuid.uuid4()),
            seeds,
            task=SimpleNamespace(id=uuid.uuid4()),
            query="forex",
            channel_limit=2,
            message_limit=20,
            max_links=5,
            rng=random.Random(1),
            metrics={"message_errors": 0, "message_profiles": 0, "invite_leads": 0},
            store_directly=False,
            on_chat=lambda *_a: None,
            on_rpc_error=_stop_on_err,
        )
        assert len(rpc_errors) == 1 and not http_called
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.httpx.AsyncClient = orig_http


async def test_shard_ai_symmetry_and_search_global_message_hits() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    orig_ai = worker_gi.expand_queries_with_ai
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_ai(*_args: Any, **_kwargs: Any):
            return ["th forex community"], ""

        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"chat-{tg_chat_id}"))

        worker_gi.expand_queries_with_ai = _fake_ai
        worker_gi.upsert_profile = _fake_upsert

        expected_rule = [
            q.query
            for q in expand_queries(["Forex Thailand"], regions=["TH"], languages=["th", "en"], max_queries=20)
        ]

        queries_by_shard: dict[int, list[str]] = {}
        saved_matches_by_chat: dict[int, dict[str, Any]] = {}

        class _SearchClient:
            def __init__(self, shard_idx: int) -> None:
                self.shard_idx = shard_idx
                self.contacts_queries: list[str] = []

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    self.contacts_queries.append(req.q)
                    return SimpleNamespace(chats=[])
                if isinstance(req, functions.messages.SearchGlobalRequest):
                    chat_hit = Channel(
                        id=1001 + self.shard_idx * 10,
                        title="Thai Forex Chat",
                        username=f"thai_fx_{self.shard_idx}",
                        participants_count=600,
                    )
                    chat_nohit = Channel(
                        id=1002 + self.shard_idx * 10,
                        title="Unrelated Talk",
                        username=f"nohit_{self.shard_idx}",
                        participants_count=600,
                    )
                    return SimpleNamespace(
                        chats=[chat_hit, chat_nohit],
                        messages=[SimpleNamespace(id=1, peer_id=tl_types.PeerChannel(chat_hit.id), date=datetime.now(tz=timezone.utc))],
                        next_rate=0,
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

            async def iter_messages(self, _chat: Any, limit: int = 20):
                if False:
                    yield None

        for shard_idx in (0, 1):
            client = _SearchClient(shard_idx)
            harness = _Harness(client)
            session = _FakeSession()
            account, task = _make_account_and_task(
                {
                    "mode": "precise",
                    "dispatch": "round_robin",
                    "account_index": shard_idx,
                    "account_count": 2,
                    "keywords": ["Forex Thailand"],
                    "country": "TH",
                    "languages": ["th", "en"],
                    "max_queries": 20,
                    "expand_short_queries": False,
                    "expand_recommendations": False,
                    "expand_channel_messages": False,
                    "scan_joined_groups": False,
                    "include_linked_groups": False,
                    "enrich_tme": False,
                    "verify_activity": False,
                    "message_search_queries": 1,
                    "message_search_pages": 1,
                    "ai_expand": True,
                }
            )
            await harness._search_groups_precise(session, task, account, task.payload)
            queries_by_shard[shard_idx] = client.contacts_queries

            if shard_idx == 0:
                for stmt in session.executed:
                    if getattr(stmt, "table", None) is not None and stmt.table.name == "group_search_matches":
                        params = {col.key: val.value for col, val in stmt._values.items()}
                        saved_matches_by_chat[params["tg_chat_id"]] = params

        assert "th forex community" in queries_by_shard[0]
        assert "th forex community" not in queries_by_shard[1]
        rule_q0 = [q for q in queries_by_shard[0] if q != "th forex community"]
        rule_q1 = queries_by_shard[1]
        assert set(rule_q0) & set(rule_q1) == set(), (rule_q0, rule_q1)
        assert set(rule_q0) | set(rule_q1) == set(expected_rule)

        # SearchGlobalRequest 未出现在 messages peer_id 的群不能白拿 message_hits
        assert saved_matches_by_chat[1001]["raw"]["message_hits"] == 1
        assert saved_matches_by_chat[1002]["raw"]["message_hits"] == 0
        assert saved_matches_by_chat[1001]["keywords"] == ["Forex Thailand"]
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert
        worker_gi.expand_queries_with_ai = orig_ai


async def test_flood_wait_and_fatal_auth_handling() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"flood-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        # Case A: 第二条查询命中 FloodWait，但已有候选 2001 -> 写 flood_until、跳过后续所有 RPC、仍落库候选
        class _PartialFloodClient:
            def __init__(self) -> None:
                self.search_calls = 0
                self.other_rpc_calls: list[str] = []

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    self.search_calls += 1
                    if self.search_calls == 1:
                        return SimpleNamespace(
                            chats=[Channel(id=2001, title="Forex Thailand Chat", username="fx_th_2001")]
                        )
                    raise FloodWaitError(request=None, capture=35)
                self.other_rpc_calls.append(type(req).__name__)
                return SimpleNamespace(chats=[])

        c1 = _PartialFloodClient()
        h1 = _Harness(c1)
        acc1, task1 = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 10,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "enrich_tme": False,
                "search_messages": True,
                "expand_recommendations": True,
                "include_linked_groups": True,
                "verify_activity": True,
            }
        )
        res1 = await h1._search_groups_precise(_FakeSession(), task1, acc1, task1.payload)
        assert acc1.status == AccountStatus.limited and acc1.flood_until is not None
        assert c1.other_rpc_calls == [], f"FloodWait 后不应再发后续 RPC：{c1.other_rpc_calls}"
        assert res1["metrics"].get("flood_wait_seconds") == 35
        assert res1["candidates"] == 1 and (res1["accepted"] + res1["needs_review"] + res1["rejected"]) == 1

        # Case B: 无候选时命中 FloodWait -> 写 flood_until 并抛可重试 TaskFailure
        class _EmptyFloodClient:
            async def __call__(self, _req: Any) -> Any:
                raise FloodWaitError(request=None, capture=19)

        h2 = _Harness(_EmptyFloodClient())
        acc2, task2 = _make_account_and_task(
            {"mode": "precise", "keywords": ["Forex"], "expand_short_queries": False, "scan_joined_groups": False}
        )
        try:
            await h2._search_groups_precise(_FakeSession(), task2, acc2, task2.payload)
            raise AssertionError("空候选触发 FloodWait 时应抛 TaskFailure")
        except TaskFailure as exc:
            assert exc.retryable is True and exc.requeue_after == 20
            assert acc2.status == AccountStatus.limited and acc2.flood_until is not None

        # Case C: AuthKeyUnregisteredError 应由外层收口标记账号 invalid 并抛不可重试 TaskFailure
        class _DeadAuthClient:
            async def __call__(self, _req: Any) -> Any:
                raise AuthKeyUnregisteredError(request=None)

        h3 = _Harness(_DeadAuthClient())
        acc3, task3 = _make_account_and_task(
            {"mode": "precise", "keywords": ["Forex"], "expand_short_queries": False, "scan_joined_groups": False}
        )
        try:
            await h3._search_groups_precise(_FakeSession(), task3, acc3, task3.payload)
            raise AssertionError("AuthKeyUnregisteredError 应抛 TaskFailure")
        except TaskFailure as exc:
            assert exc.retryable is False
            assert acc3.status == AccountStatus.invalid
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_flood_continue_short_wait() -> None:
    """短限流（≤60s）等待后继续，不应把后面的查询和验活整段跳过。"""
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"short-flood-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        class _ShortFloodClient:
            def __init__(self) -> None:
                self.search_calls = 0

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    self.search_calls += 1
                    if self.search_calls == 1:
                        raise FloodWaitError(request=None, capture=5)
                    return SimpleNamespace(
                        chats=[
                            Channel(id=9301, title="Forex Thailand Chat", username="fx_short_9301", participants_count=600)
                        ]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

            async def iter_messages(self, _chat: Any, limit: int = 20):
                when = datetime.now(tz=timezone.utc)
                for _ in range(2):
                    yield SimpleNamespace(date=when, message="hello forex thailand", sender_id=1)

        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex", "Gold"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 2,
                "contacts_query_limit": 2,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": True,
                "activity_check_limit": 5,
                "simple_screen": True,
            }
        )
        client = _ShortFloodClient()
        res = await _Harness(client)._search_groups_precise(_FakeSession(), task, account, task.payload)

        assert client.search_calls >= 2, "短限流后应继续执行下一条查询"
        assert res["source_stats"]["flood_continues"] == 1, res["source_stats"]
        assert res["source_stats"]["flood_stopped"] == 0, res["source_stats"]
        assert res["metrics"]["activity_checked"] == 1, res["metrics"]
        assert res["accepted"] == 1, res
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_step5_savepoint_isolation() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _flaky_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            if tg_chat_id == 3001:
                raise RuntimeError("simulated db constraint failure")
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"sp-{tg_chat_id}"))

        worker_gi.upsert_profile = _flaky_upsert

        class _TwoChatClient:
            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    return SimpleNamespace(
                        chats=[
                            Channel(id=3001, title="Forex Thailand Broken", username="broken_3001"),
                            Channel(id=3002, title="Forex Thailand Good", username="good_3002"),
                        ]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

        session = _FakeSession()
        harness = _Harness(_TwoChatClient())
        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 1,
                "expand_short_queries": False,
                "search_messages": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": False,
                # simple_screen 默认 True，会把没有活跃度数据的群压成 needs_review；
                # 这里要验证的是「一个群写库失败不影响另一个」，必须走 accepted → upsert。
                "simple_screen": False,
            }
        )
        res = await harness._search_groups_precise(session, task, account, task.payload)
        assert session.savepoints_entered == 2
        assert session.savepoints_rolled_back == 1
        assert res["metrics"].get("persist_errors") == 1
        assert res["accepted"] + res["needs_review"] + res["rejected"] == 1
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_external_web_adapters() -> None:
    assert validate_external_url("https://public.example/search")[0]
    assert not validate_external_url("http://127.0.0.1:8080")[0]
    assert not validate_external_url("http://10.0.0.8/metadata")[0]
    assert not validate_external_url("http://localhost/admin")[0]

    orig_flags = (
        settings.external_search_enabled,
        settings.external_search_engine_provider,
        settings.external_search_engine_api_key,
        settings.external_search_engine_base_url,
        settings.external_search_directory_provider,
        settings.external_search_directory_base_url,
        settings.external_search_directory_api_key,
        settings.external_search_seed_urls,
    )
    try:
        # 1. 全局未开启时直接跳过并给出说明
        settings.external_search_enabled = False
        res_off = await fetch_external_candidates(["Forex Thailand"])
        assert res_off.links == [] and res_off.queries_run == 0
        assert any("EXTERNAL_SEARCH_ENABLED" in n for n in res_off.notes), res_off.notes

        # max_candidates=0 must short-circuit before any adapter HTTP request.
        settings.external_search_enabled = True
        settings.external_search_seed_urls = "https://seed.example/disabled"
        zero_requests = 0

        def _zero_handler(_req: httpx.Request) -> httpx.Response:
            nonlocal zero_requests
            zero_requests += 1
            raise AssertionError("max_candidates=0 must not issue HTTP requests")

        async with httpx.AsyncClient(transport=httpx.MockTransport(_zero_handler)) as http:
            res_zero = await fetch_external_candidates(
                ["Forex Thailand"], max_candidates=0, adapters=(SeedManifestAdapter(),), client=http
            )
        assert res_zero.links == [] and res_zero.queries_run == 0
        assert zero_requests == 0

        # Every configured seed URL is requested until the outer candidate cap stops an adapter.
        seed_urls = [f"https://seed.example/{index}" for index in range(18)]
        settings.external_search_seed_urls = ",".join(seed_urls)
        requested_urls: list[str] = []
        # 2. 不支持的搜索引擎 provider 与未允许付费 API 校验
        settings.external_search_enabled = True
        settings.external_search_engine_provider = "unknown_provider"
        settings.external_search_directory_base_url = ""
        settings.external_search_seed_urls = ""
        res_bad = await fetch_external_candidates(["Forex Thailand"])
        assert res_bad.queries_run == 0 and any("不支持" in n for n in res_bad.notes), res_bad.notes

        settings.external_search_engine_provider = "serper"
        settings.external_search_engine_api_key = "dummy-paid-key"
        res_unpaid = await fetch_external_candidates(["Forex Thailand"], allow_paid=False)
        assert res_unpaid.queries_run == 0 and any("付费" in n for n in res_unpaid.notes), res_unpaid.notes

        # 3. SeedManifestAdapter + 外层 max_candidates 截断，达到上限不再调后续适配器
        settings.external_search_engine_provider = ""
        settings.external_search_engine_api_key = ""
        settings.external_search_seed_urls = "https://seed.example/list"
        next_adapter_called = False

        class _TrailingAdapter:
            name = "trailing"

            async def fetch(self, *_args: Any, **_kwargs: Any):
                nonlocal next_adapter_called
                next_adapter_called = True
                return [], [], 0, 1

        transport = httpx.MockTransport(
            lambda _req: httpx.Response(
                200,
                text='<a href="https://t.me/fx_seed_a">A</a> @fx_seed_b https://t.me/+SeedInv999',
            )
        )
        async with httpx.AsyncClient(transport=transport) as http:
            res_ok = await fetch_external_candidates(
                ["Forex Thailand"],
                max_candidates=2,
                adapters=(SearchEngineAdapter(), DirectoryAdapter(), SeedManifestAdapter(), _TrailingAdapter()),
                client=http,
            )
        assert len(res_ok.links) == 2 and res_ok.queries_run == 1, res_ok
        assert not next_adapter_called, "达到 max_candidates 后不应再调后续适配器"

        settings.external_search_seed_urls = ",".join(seed_urls)

        def _seed_handler(req: httpx.Request) -> httpx.Response:
            requested_urls.append(str(req.url))
            return httpx.Response(200, text="没有 Telegram 链接的测试页面")

        async with httpx.AsyncClient(transport=httpx.MockTransport(_seed_handler)) as http:
            res_all_seeds = await fetch_external_candidates(
                ["Forex Thailand"],
                max_candidates=200,
                adapters=(SeedManifestAdapter(),),
                client=http,
            )
        assert res_all_seeds.queries_run == 18, res_all_seeds
        assert requested_urls == seed_urls, requested_urls
    finally:
        (
            settings.external_search_enabled,
            settings.external_search_engine_provider,
            settings.external_search_engine_api_key,
            settings.external_search_engine_base_url,
            settings.external_search_directory_provider,
            settings.external_search_directory_base_url,
            settings.external_search_directory_api_key,
            settings.external_search_seed_urls,
        ) = orig_flags


async def test_external_web_and_unverified_pending() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    orig_ext = worker_gi.fetch_external_candidates
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"ext-{tg_chat_id}"))

        async def _fake_ext(*_args: Any, **_kwargs: Any):
            from app.services.external_group_sources import ExternalCandidateHit, ExternalFetchResult
            from app.services.group_discovery import ExtractedLink

            return ExternalFetchResult(
                links=[
                    ExtractedLink("username", "ext_ok_group", "https://t.me/ext_ok_group"),
                    ExtractedLink("username", "ext_missing", "https://t.me/ext_missing"),
                ],
                hits=[
                    ExternalCandidateHit("username", "ext_ok_group", "https://t.me/ext_ok_group", "seed_manifest", "forex"),
                    ExternalCandidateHit("username", "ext_missing", "https://t.me/ext_missing", "seed_manifest", "forex"),
                ],
                notes=[],
                errors=0,
                queries_run=1,
            )

        worker_gi.upsert_profile = _fake_upsert
        worker_gi.fetch_external_candidates = _fake_ext

        class _ResolveExtClient:
            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.ResolveUsernameRequest):
                    if req.username == "ext_ok_group":
                        return SimpleNamespace(
                            chats=[Channel(id=5501, title="Forex Thailand Verified", username="ext_ok_group", participants_count=600)]
                        )
                    return SimpleNamespace(chats=[])
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

        session = _FakeSession()
        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "enable_contacts_search": False,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": False,
                "simple_screen": False,
                "expand_external_web": True,
            }
        )
        res = await _Harness(_ResolveExtClient())._search_groups_precise(session, task, account, task.payload)
        assert res["candidates"] == 1 and res["accepted"] == 1
        assert len(res["pending_candidates"]) == 1
        assert res["pending_candidates"][0]["value"] == "ext_missing"
        assert res["pending_candidates"][0]["status_label"] == "外部发现，尚未验证"
        assert res["source_stats"]["unverified_pending"] == 1

        saved_raws = [
            {col.key: val.value for col, val in stmt._values.items()}
            for stmt in session.executed
            if getattr(stmt, "table", None) is not None and stmt.table.name == "group_search_matches"
        ]
        assert saved_raws[0]["raw"]["verification_tier"] == "external_verified"
        assert "外部发现，Telegram已验证" in saved_raws[0]["reasons"]
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert
        worker_gi.fetch_external_candidates = orig_ext


async def test_channel_posts_seed_and_stars_fallback() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"cp-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        # Case A: SearchPostsRequest 产出广播频道种子 + 贴内公开链接 -> 仅讨论群进精准结果
        class _PostsClient:
            def __init__(self) -> None:
                self.paid_values: list[Optional[int]] = []

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.channels.SearchPostsRequest):
                    self.paid_values.append(req.allow_paid_stars)
                    return SimpleNamespace(
                        chats=[Channel(id=6101, title="Forex News CH", username="fx_post_seed", megagroup=False, broadcast=True)],
                        messages=[SimpleNamespace(message="Join discussion https://t.me/post_discuss")],
                    )
                if isinstance(req, functions.contacts.ResolveUsernameRequest) and req.username == "post_discuss":
                    return SimpleNamespace(
                        chats=[Channel(id=6103, title="Forex Thailand Chat", username="post_discuss", participants_count=700)]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    if int(getattr(req.channel, "id", 0)) == 6101:
                        linked = Channel(id=6102, title="Forex Thailand Linked", username="fx_linked_6102", participants_count=800)
                        return SimpleNamespace(
                            full_chat=SimpleNamespace(about="Forex TH", participants_count=5000, linked_chat_id=6102),
                            chats=[linked],
                        )
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=700, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

        acc_a, task_a = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand", "Gold Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "enable_contacts_search": False,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": True,
                "enrich_tme": False,
                "verify_activity": False,
                "simple_screen": False,
                "expand_channel_posts": True,
                "channel_posts_query_limit": 2,
                "allow_paid_channel_posts": True,
                "channel_posts_max_stars": 20,
            }
        )
        posts_client = _PostsClient()
        res_a = await _Harness(posts_client)._search_groups_precise(_FakeSession(), task_a, acc_a, task_a.payload)
        assert posts_client.paid_values == [20, None], posts_client.paid_values
        assert res_a["source_stats"].get("channel_posts_seeds") == 1
        assert res_a["accepted"] >= 2, res_a

        # Case B: SearchPostsRequest 报权限/Stars异常 -> 降级写入 ai_notes，不影响其他渠道完成
        class _StarsFailClient:
            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.channels.SearchPostsRequest):
                    raise RuntimeError("PREMIUM_ACCOUNT_REQUIRED")
                if isinstance(req, functions.contacts.SearchRequest):
                    return SimpleNamespace(
                        chats=[Channel(id=6201, title="Forex Thailand Talk", username="fx_6201", participants_count=600)]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand discussion", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

        acc_b, task_b = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 1,
                "expand_short_queries": False,
                "search_messages": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": False,
                "simple_screen": False,
                "expand_channel_posts": True,
                "channel_posts_query_limit": 2,
            }
        )
        res_b = await _Harness(_StarsFailClient())._search_groups_precise(_FakeSession(), task_b, acc_b, task_b.payload)
        assert res_b["source_stats"].get("channel_posts_errors") == 1
        assert any("Premium / Stars" in n for n in res_b["ai_notes"]), res_b["ai_notes"]
        assert res_b["accepted"] == 1
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_common_chat_graph_and_rpc_budget() -> None:
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"cc-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        class _MemberSession(_FakeSession):
            def __init__(self, account_id: Any) -> None:
                super().__init__()
                self._acc_id = account_id

            async def scalars(self, stmt: Any) -> _FakeScalars:
                text = str(stmt)
                if "group_members" in text:
                    return _FakeScalars(
                        [
                            SimpleNamespace(tg_user_id=701, account_id=self._acc_id, username="u701", message_count=5),
                            SimpleNamespace(tg_user_id=702, account_id=self._acc_id, username=None, message_count=1),
                        ]
                    )
                return _FakeScalars([])

        class _CommonClient:
            def __init__(self) -> None:
                self.search_calls = 0

            async def get_input_entity(self, uid: int) -> Any:
                if uid == 702:
                    raise ValueError("Could not find the input entity for 702")
                return tl_types.InputUser(user_id=uid, access_hash=999)

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    self.search_calls += 1
                    return SimpleNamespace(chats=[])
                if isinstance(req, functions.messages.GetCommonChatsRequest):
                    return SimpleNamespace(
                        chats=[Channel(id=8101, title="Forex Thailand Common Group", username="fx_common_8101", participants_count=600)]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand talk", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

        acc, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "enable_contacts_search": False,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": False,
                "simple_screen": False,
                "expand_common_chats": True,
                "common_chat_user_limit": 5,
            }
        )
        res = await _Harness(_CommonClient())._search_groups_precise(_MemberSession(acc.id), task, acc, task.payload)
        assert res["source_stats"].get("common_chat_checked") == 1, res["source_stats"]
        assert res["source_stats"].get("common_chat_graph") == 1, res["source_stats"]
        assert res["accepted"] == 1

        # 测试单号总 RPC 预算上限（rpc_budget=20 时不得越界并记录 budget_stopped）
        c_budget = _CommonClient()
        acc_b, task_b = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand", "Gold Trading", "FX Trade"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 50,
                "contacts_query_limit": 50,
                "rpc_budget": 20,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": False,
                "simple_screen": False,
            }
        )
        res_b = await _Harness(c_budget)._search_groups_precise(_FakeSession(), task_b, acc_b, task_b.payload)
        assert c_budget.search_calls == 20
        assert res_b["source_stats"].get("rpc_used") == 20
        assert res_b["source_stats"].get("budget_stopped") == 1
        assert any("RPC 预算上限" in n for n in res_b["ai_notes"]), res_b["ai_notes"]
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_simple_screen_activity_and_speakable() -> None:
    """简化筛选：只看近 3 个月有消息 + 可发言；评分门槛与成员数不参与判定。"""
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"simple-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        readonly_group = Channel(
            id=9103, title="Forex Thailand Readonly", username="fx_readonly_9103", participants_count=600
        )
        # Telethon 语义：True = 被禁止，故 send_messages=True 表示默认禁言（只读）
        readonly_group.default_banned_rights = SimpleNamespace(send_messages=True, send_plain=True)

        class _SimpleScreenClient:
            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    return SimpleNamespace(
                        chats=[
                            Channel(id=9101, title="Forex Thailand Active", username="fx_active_9101", participants_count=600),
                            Channel(id=9102, title="Forex Thailand Dormant", username="fx_dormant_9102", participants_count=600),
                            readonly_group,
                        ]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

            async def iter_messages(self, chat: Any, limit: int = 20):
                dormant = int(getattr(chat, "id", 0)) == 9102
                when = datetime.now(tz=timezone.utc) - timedelta(days=120 if dormant else 0)
                for _ in range(2):
                    yield SimpleNamespace(date=when, text="hello forex thailand")

        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 1,
                "contacts_query_limit": 1,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "exclude_readonly": False,
                "min_members": 5000,
                "min_relevance_score": 100,
            }
        )
        session = _FakeSession()
        res = await _Harness(_SimpleScreenClient())._search_groups_precise(session, task, account, task.payload)
        assert res["accepted"] == 1, res
        assert res["rejected"] == 2, res
        assert res["source_stats"].get("readonly") == 1, res["source_stats"]

        saved = {
            {col.key: val.value for col, val in stmt._values.items()}["tg_chat_id"]: {
                col.key: val.value for col, val in stmt._values.items()
            }
            for stmt in session.executed
            if getattr(stmt, "table", None) is not None and stmt.table.name == "group_search_matches"
        }
        assert saved[9101]["status"] == "accepted"
        assert saved[9101]["raw"]["activity"]["recent_90d"] == 2
        assert any("近3个月活跃" in reason for reason in saved[9101]["reasons"])
        assert saved[9102]["status"] == "rejected"
        assert "近3个月无消息（疑似沉寂）" in saved[9102]["reasons"]
        assert saved[9103]["status"] == "rejected"
        assert "默认权限为只读" in saved[9103]["reasons"]
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_simple_screen_flood_score_fallback() -> None:
    """限流导致验活没跑完时，按评分兜底，不能把整批合格群都判成待确认。"""
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"fallback-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        class _FloodOnActivityClient:
            def __init__(self) -> None:
                self.activity_calls = 0

            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    return SimpleNamespace(
                        chats=[
                            Channel(id=9201, title="Forex Thailand Active", username="fx_flood_9201", participants_count=600)
                        ]
                    )
                if isinstance(req, functions.channels.GetFullChannelRequest):
                    return SimpleNamespace(
                        full_chat=SimpleNamespace(about="Forex Thailand traders", participants_count=600, linked_chat_id=None),
                        chats=[],
                    )
                return SimpleNamespace(chats=[])

            async def iter_messages(self, _chat: Any, limit: int = 20):
                self.activity_calls += 1
                raise FloodWaitError(request=None, capture=75)
                yield  # pragma: no cover

        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 1,
                "contacts_query_limit": 1,
                "search_messages": False,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": True,
                "activity_check_limit": 5,
                "simple_screen": True,
            }
        )
        session = _FakeSession()
        client = _FloodOnActivityClient()
        res = await _Harness(client)._search_groups_precise(session, task, account, task.payload)
        assert client.activity_calls >= 1, "应至少尝试一次验活"
        assert res["accepted"] == 1, res
        assert res["needs_review"] == 0, res
        assert res["source_stats"]["score_fallback"] == 1, res["source_stats"]
        assert res["source_stats"]["flood_stopped"] == 1, res["source_stats"]

        saved = {
            {col.key: val.value for col, val in stmt._values.items()}["tg_chat_id"]: {
                col.key: val.value for col, val in stmt._values.items()
            }
            for stmt in session.executed
            if getattr(stmt, "table", None) is not None and stmt.table.name == "group_search_matches"
        }
        assert saved[9201]["status"] == "accepted"
        assert any("限流/预算不足未验活，按评分保留" in reason for reason in saved[9201]["reasons"])
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_simple_screen_budget_score_fallback() -> None:
    """RPC 预算耗尽导致验活没跑完时，同样按评分兜底。"""
    orig_sleep = worker_gi.sleep_human
    orig_upsert = worker_gi.upsert_profile
    worker_gi.sleep_human = _noop_sleep
    try:
        async def _fake_upsert(_session: Any, *, tg_chat_id: int, **_kwargs: Any):
            return SimpleNamespace(id=uuid.uuid5(uuid.NAMESPACE_DNS, f"budget-{tg_chat_id}"))

        worker_gi.upsert_profile = _fake_upsert

        class _BudgetClient:
            async def __call__(self, req: Any) -> Any:
                if isinstance(req, functions.contacts.SearchRequest):
                    return SimpleNamespace(
                        chats=[
                            Channel(id=9401, title="Forex Thailand Active", username="fx_budget_9401", participants_count=600)
                        ]
                    )
                return SimpleNamespace(chats=[], messages=[])

            async def iter_messages(self, _chat: Any, limit: int = 20):
                when = datetime.now(tz=timezone.utc)
                for _ in range(2):
                    yield SimpleNamespace(date=when, message="hello forex thailand", sender_id=1)

        account, task = _make_account_and_task(
            {
                "mode": "precise",
                "keywords": ["Forex Thailand"],
                "country": "TH",
                "languages": ["th", "en"],
                "max_queries": 20,
                "contacts_query_limit": 1,
                "rpc_budget": 20,
                "search_messages": True,
                "message_search_queries": 20,
                "message_search_pages": 5,
                "expand_short_queries": False,
                "scan_joined_groups": False,
                "expand_recommendations": False,
                "expand_channel_messages": False,
                "include_linked_groups": False,
                "enrich_tme": False,
                "verify_activity": True,
                "activity_check_limit": 5,
                "simple_screen": True,
            }
        )
        session = _FakeSession()
        res = await _Harness(_BudgetClient())._search_groups_precise(session, task, account, task.payload)

        assert res["accepted"] == 1, res
        assert res["source_stats"]["score_fallback"] == 1, res["source_stats"]
        assert res["source_stats"]["budget_stopped"] == 1, res["source_stats"]
        assert res["source_stats"]["flood_stopped"] == 0, res["source_stats"]

        saved = {
            {col.key: val.value for col, val in stmt._values.items()}["tg_chat_id"]: {
                col.key: val.value for col, val in stmt._values.items()
            }
            for stmt in session.executed
            if getattr(stmt, "table", None) is not None and stmt.table.name == "group_search_matches"
        }
        assert saved[9401]["status"] == "accepted"
        assert any("限流/预算不足未验活，按评分保留" in reason for reason in saved[9401]["reasons"])
    finally:
        worker_gi.sleep_human = orig_sleep
        worker_gi.upsert_profile = orig_upsert


async def test_batch_merge_and_hydration() -> None:
    hydrated = GroupSearchMatchOut.model_validate(
        {
            "id": uuid.uuid4(),
            "task_id": uuid.uuid4(),
            "tg_chat_id": 9001,
            "title": "Legacy Group",
            "source": "contacts",
            "discovery_sources": ["contacts", "message_search"],
            "raw": {
                "source_counts": {"contacts": 1, "message_search": 2},
                "evidence": [{"source": "message_search", "query": "forex"}],
                "verification_tier": "tg_verified",
                "trust_bonus": 5,
            },
        }
    )
    assert hydrated.source == "contacts_search"
    assert hydrated.discovery_sources == ["contacts_search", "global_message_search"]
    assert hydrated.source_counts == {"contacts_search": 1, "global_message_search": 2}
    assert hydrated.evidence[0]["source"] == "global_message_search"

    batch_id = uuid.uuid4()
    t1_id = uuid.uuid4()
    t2_id = uuid.uuid4()
    tasks = [
        SimpleNamespace(
            id=t1_id,
            account_id=uuid.uuid4(),
            type=TaskType.search_groups,
            status=TaskStatus.completed,
            payload={"batch_id": str(batch_id)},
            result={
                "source_stats": {"contacts_search": 1, "accepted": 0},
                "pending_candidates": [
                    {"url": "https://t.me/already_ok", "kind": "username", "value": "already_ok", "source": "external_web"},
                    {"url": "https://t.me/still_pending", "kind": "username", "value": "still_pending", "source": "external_web"},
                ],
                "ai_notes": ["note A"],
            },
        ),
        SimpleNamespace(
            id=t2_id,
            account_id=uuid.uuid4(),
            type=TaskType.search_groups,
            status=TaskStatus.completed,
            payload={"batch_id": str(batch_id)},
            result={"source_stats": {"global_message_search": 2, "accepted": 1}, "pending_candidates": [], "ai_notes": []},
        ),
    ]
    rows = [
        SimpleNamespace(
            id=uuid.uuid4(),
            task_id=t1_id,
            profile_id=None,
            tg_chat_id=9001,
            title="Forex Thailand Group",
            username="already_ok",
            member_count=600,
            source="contacts",
            query="forex",
            relevance_score=55,
            breakdown={"name": 30, "region": 20, "language": 5},
            matched_keywords=["forex"],
            discovery_sources=["contacts"],
            language="en",
            country="TH",
            topic="forex",
            status="needs_review",
            reasons=["名称命中主题词"],
            raw={"source_counts": {"contacts": 1}, "verification_tier": "tg_verified", "trust_bonus": 0},
            created_at=None,
        ),
        SimpleNamespace(
            id=uuid.uuid4(),
            task_id=t2_id,
            profile_id=None,
            tg_chat_id=9001,
            title="Forex Thailand Group",
            username="already_ok",
            member_count=600,
            source="message_search",
            query="forex",
            relevance_score=52,
            breakdown={"name": 30, "region": 20, "language": 2},
            matched_keywords=["thailand"],
            discovery_sources=["message_search", "linked_chat"],
            language="en",
            country="TH",
            topic="forex",
            status="needs_review",
            reasons=["群内消息命中关键词"],
            raw={
                "source_counts": {"message_search": 2, "linked_chat": 1},
                "evidence": [{"source": "linked_chat", "seed_chat_id": 12}],
                "verification_tier": "tg_verified",
                "trust_bonus": 5,
            },
            created_at=None,
        ),
    ]

    class _BatchSession(_FakeSession):
        async def scalars(self, stmt: Any) -> _FakeScalars:
            text = str(stmt)
            if "FROM tasks" in text:
                return _FakeScalars(tasks)
            if "FROM group_search_matches" in text:
                return _FakeScalars(rows)
            return _FakeScalars([])

    admin = SimpleNamespace(id=uuid.uuid4(), role="admin", is_superuser=True)
    batch_out = await get_precise_batch(batch_id, status_filter=None, limit=300, session=_BatchSession(), user=admin)
    assert len(batch_out.matches) == 1
    m = batch_out.matches[0]
    assert m.discovery_sources == ["contacts_search", "global_message_search", "linked_chat"]
    assert m.trust_bonus == 8 and m.breakdown.get("trust") == 8
    assert m.relevance_score == 63, m
    assert len(batch_out.unverified_candidates) == 1
    assert batch_out.unverified_candidates[0]["value"] == "still_pending"
    assert batch_out.source_stats["verified_total"] == 1
    assert batch_out.source_stats["unverified_pending"] == 1


async def _run_all() -> None:
    await test_helpers_and_ai_fallback()
    await test_expand_from_messages_tme_and_flood()
    await test_shard_ai_symmetry_and_search_global_message_hits()
    await test_flood_wait_and_fatal_auth_handling()
    await test_flood_continue_short_wait()
    await test_step5_savepoint_isolation()
    await test_external_web_adapters()
    await test_external_web_and_unverified_pending()
    await test_channel_posts_seed_and_stars_fallback()
    await test_common_chat_graph_and_rpc_budget()
    await test_simple_screen_activity_and_speakable()
    await test_simple_screen_flood_score_fallback()
    await test_simple_screen_budget_score_fallback()
    await test_batch_merge_and_hydration()
    print("group_precise_pipeline_check: ok")


def main() -> None:
    asyncio.run(_run_all())


if __name__ == "__main__":
    main()
