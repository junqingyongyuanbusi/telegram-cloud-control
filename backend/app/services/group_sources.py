"""精准找群搜索源体系：标准化枚举、历史别名映射、来源可信度分级与中文标签。

约定：所有召回来源只负责往统一候选池里放候选群/频道，不能跳过后续的类型、权限、活跃度与相关性核验。
"""

from __future__ import annotations

from enum import Enum
from typing import Iterable, Mapping


class SearchSource(str, Enum):
    """标准化的找群候选来源枚举。"""

    CONTACTS_SEARCH = "contacts_search"
    GLOBAL_MESSAGE_SEARCH = "global_message_search"
    SHORT_QUERY = "short_query"
    LINKED_CHAT = "linked_chat"
    CHANNEL_RECOMMENDATION = "channel_recommendation"
    CHANNEL_MESSAGE_LINK = "channel_message_link"
    JOINED_GROUP_GRAPH = "joined_group_graph"
    CANDIDATE_LINK = "candidate_link"
    TME_PREVIEW = "tme_preview"
    EXTERNAL_WEB = "external_web"
    CHANNEL_POSTS = "channel_posts"
    COMMON_CHAT_GRAPH = "common_chat_graph"
    LOCAL_INDEX = "local_index"


LEGACY_SOURCE_ALIASES: dict[str, str] = {
    "contacts": SearchSource.CONTACTS_SEARCH.value,
    "message_search": SearchSource.GLOBAL_MESSAGE_SEARCH.value,
    "short_core": SearchSource.SHORT_QUERY.value,
    "recommendation": SearchSource.CHANNEL_RECOMMENDATION.value,
    "channel_link": SearchSource.CHANNEL_MESSAGE_LINK.value,
    "joined_dialog": SearchSource.JOINED_GROUP_GRAPH.value,
    "joined_link": SearchSource.JOINED_GROUP_GRAPH.value,
    "message_link": SearchSource.CHANNEL_MESSAGE_LINK.value,
    "web_candidate": SearchSource.CANDIDATE_LINK.value,
}

SEARCH_SOURCE_LABELS: dict[str, str] = {
    SearchSource.CONTACTS_SEARCH.value: "原生搜索",
    SearchSource.GLOBAL_MESSAGE_SEARCH.value: "消息反查",
    SearchSource.SHORT_QUERY.value: "短词召回",
    SearchSource.LINKED_CHAT.value: "频道讨论群",
    SearchSource.CHANNEL_RECOMMENDATION.value: "相似推荐",
    SearchSource.CHANNEL_MESSAGE_LINK.value: "频道外链",
    SearchSource.JOINED_GROUP_GRAPH.value: "已入群图谱",
    SearchSource.CANDIDATE_LINK.value: "人工候选链接",
    SearchSource.TME_PREVIEW.value: "t.me公开页",
    SearchSource.EXTERNAL_WEB.value: "外部网页/目录",
    SearchSource.CHANNEL_POSTS.value: "频道帖子搜索",
    SearchSource.COMMON_CHAT_GRAPH.value: "共同群扩展",
    SearchSource.LOCAL_INDEX.value: "本地历史群库",
}

#: Telegram 官方搜索 / 原生图谱 / 本地已核验索引（直接反映实体在 TG 内部存在）
NATIVE_TG_SOURCES: frozenset[str] = frozenset(
    {
        SearchSource.CONTACTS_SEARCH.value,
        SearchSource.GLOBAL_MESSAGE_SEARCH.value,
        SearchSource.SHORT_QUERY.value,
        SearchSource.LINKED_CHAT.value,
        SearchSource.CHANNEL_RECOMMENDATION.value,
        SearchSource.CHANNEL_MESSAGE_LINK.value,
        SearchSource.CHANNEL_POSTS.value,
        SearchSource.LOCAL_INDEX.value,
    }
)

#: 与我方账号产生过实际会话关系的来源（已入群、与已知成员的共同群）
JOINED_GRAPH_SOURCES: frozenset[str] = frozenset(
    {
        SearchSource.JOINED_GROUP_GRAPH.value,
        SearchSource.COMMON_CHAT_GRAPH.value,
    }
)

#: 外部非 TG 原生入口（必须先走 ResolveUsername/CheckChatInvite 实体验证）
EXTERNAL_SOURCES: frozenset[str] = frozenset(
    {
        SearchSource.CANDIDATE_LINK.value,
        SearchSource.EXTERNAL_WEB.value,
    }
)

#: 仅作元数据补充，不算独立召回源
ENRICHMENT_ONLY_SOURCES: frozenset[str] = frozenset({SearchSource.TME_PREVIEW.value})

# Short queries use the same Telegram contacts.search endpoint as the primary
# contacts source. Keep the query template visible in evidence, but do not
# count it as an independent retrieval system for trust scoring.
SOURCE_FAMILIES: dict[str, str] = {
    SearchSource.SHORT_QUERY.value: SearchSource.CONTACTS_SEARCH.value,
}


def normalize_search_source(value: str) -> str:
    """把历史来源名（如 contacts / message_search）归一成标准 SearchSource 字符串。"""

    cleaned = str(value or "").strip()
    if not cleaned:
        return SearchSource.CONTACTS_SEARCH.value
    return LEGACY_SOURCE_ALIASES.get(cleaned, cleaned)


def normalize_source_list(values: Iterable[str]) -> list[str]:
    """按出现顺序归一化并去重来源列表。"""

    out: list[str] = []
    seen: set[str] = set()
    for item in values:
        norm = normalize_search_source(item)
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def compute_source_trust(
    sources: Iterable[str],
    *,
    source_counts: Mapping[str, int] | None = None,
    joined: bool = False,
) -> tuple[int, str, list[str]]:
    """根据多源交叉印证情况计算来源可信度加成、分层标识与中文说明。

    返回 `(trust_bonus, verification_tier, reasons)`:
    - 仅单一外部来源发现并由 Telegram 核验通过：`trust_bonus = 0`, tier = `"external_verified"`
    - 有 Telegram 原生/图谱来源交叉印证或高赞消息命中：`trust_bonus` 在 0..8 之间，tier = `"tg_verified"`
    - `joined=True` 或来自 `joined_group_graph`/`common_chat_graph` 会附加图谱加分
    """

    normalized = normalize_source_list(sources)
    discovery = [s for s in normalized if s not in ENRICHMENT_ONLY_SOURCES]
    if not discovery:
        return 0, "tg_verified", []

    counts = {normalize_search_source(k): max(0, int(v or 0)) for k, v in (source_counts or {}).items()}
    families = {SOURCE_FAMILIES.get(source, source) for source in discovery}
    has_native = any(s in NATIVE_TG_SOURCES for s in discovery)
    has_joined = bool(joined) or any(s in JOINED_GRAPH_SOURCES for s in discovery)
    has_external = any(s in EXTERNAL_SOURCES for s in discovery)

    reasons: list[str] = []
    trust = 0
    # Multiple queries through the same Telegram endpoint are evidence volume,
    # not independent source corroboration. External-only candidates remain at
    # zero trust even when two external adapters found the same link.
    if has_external and not has_native and not has_joined:
        return 0, "external_verified", ["外部发现，Telegram已验证"]

    if len(families) >= 3:
        trust += 6
        reasons.append(f"多源交叉验证({len(families)}源)")
    elif len(families) == 2:
        trust += 3
        reasons.append("双源交叉验证")

    msg_count = counts.get(SearchSource.GLOBAL_MESSAGE_SEARCH.value, 0)
    if msg_count >= 2:
        trust += 2
        reasons.append(f"消息反查命中{msg_count}次")

    if has_joined:
        trust += 2
        if not any("已入群" in r or "共同群" in r for r in reasons):
            reasons.append("已入群/关系图谱关联")

    trust = min(8, trust)
    tier = "tg_verified"
    if has_external:
        reasons.append("外部候选且有Telegram原生来源印证")

    return trust, tier, list(dict.fromkeys(reasons))
