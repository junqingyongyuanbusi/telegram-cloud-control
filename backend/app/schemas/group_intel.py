"""群情报 schema：采集请求、群档案、成员、事件流。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator
from app.schemas.bulk import BulkScopeRequest
from app.schemas.common import ORMModel
from app.services.group_sources import normalize_search_source, normalize_source_list

class GroupCollectRequest(BulkScopeRequest):
    """批量采集请求：对选中的号，采它们已加入的群。"""

    dialog_ids: Optional[List[uuid.UUID]] = Field(
        default=None, description="只采这些会话（已同步的群）；不给就采该号已加入的全部群"
    )
    limit_groups: int = Field(default=30, ge=1, le=300, description="每个号最多采多少个群")
    sample_members: int = Field(
        default=0, ge=0, le=500, description="每个群顺带抽样多少个成员；0 表示只采群档案"
    )
    with_members: bool = Field(
        default=False, description="是否额外为每个群排队一条「采集群成员」任务（用更大额度拉名单）"
    )
    member_limit: int = Field(default=200, ge=1, le=500, description="with_members 时每个群采多少成员")


class CollectLinkRequest(BulkScopeRequest):
    """按群链接采集：粘贴若干链接，自动解析群、可选加入、采档案与群员。"""

    links: List[str] = Field(description="群链接，每行一个：t.me/xxx、t.me/+hash、@username、数字 ID 都支持")
    join_if_missing: bool = Field(
        default=False,
        description="号不在群里时是否自动加入（加入会产生一条入群系统消息，且按高风险动作计费）",
    )
    leave_after: bool = Field(default=False, description="采完就退出——留人不留痕，适合一次性采集号")
    member_limit: int = Field(default=200, ge=0, le=500, description="每群采多少成员；0 表示只采群档案")

    @model_validator(mode="after")
    def _check_links(self):
        cleaned = [str(item).strip() for item in (self.links or []) if str(item).strip()]
        cleaned = list(dict.fromkeys(cleaned))
        if not cleaned:
            raise ValueError("至少给一个群链接")
        if len(cleaned) > 50:
            raise ValueError("单次最多提交 50 个链接，请分批")
        self.links = cleaned
        return self


class GroupProfileOut(ORMModel):
    id: uuid.UUID
    account_id: Optional[uuid.UUID] = None
    dialog_id: Optional[uuid.UUID] = None
    tg_chat_id: int
    title: str = ""
    username: Optional[str] = None
    kind: str = "group"
    member_count: Optional[int] = None
    about: str = ""
    invite_link: Optional[str] = None
    is_public: bool = False
    is_restricted: bool = False
    creator_tg_id: Optional[int] = None
    tg_created_at: Optional[datetime] = None
    collected_at: Optional[datetime] = None
    member_synced_at: Optional[datetime] = None
    member_sampled: int = 0
    source: str = "profile_sync"
    language: Optional[str] = None
    country: Optional[str] = None
    topic: Optional[str] = None
    relevance_score: Optional[int] = None
    send_permission: Optional[str] = None
    join_request: Optional[bool] = None
    verification_status: Optional[str] = None


class GroupProfileListResponse(BaseModel):
    items: List[GroupProfileOut]
    total: int
    page: int = 1
    page_size: int = 20
    # 汇总：群数、成员总数（已采集到的）、今日入群事件数
    summary: Dict[str, Any] = Field(default_factory=dict)


class GroupMemberOut(ORMModel):
    id: uuid.UUID
    group_id: uuid.UUID
    tg_chat_id: int
    tg_user_id: int
    username: Optional[str] = None
    display_name: str = ""
    is_bot: bool = False
    is_premium: bool = False
    is_admin: bool = False
    status: str = "member"
    source: str = "participant_sync"
    joined_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    message_count: int = 0


class GroupMemberListResponse(BaseModel):
    items: List[GroupMemberOut]
    total: int
    page: int = 1
    page_size: int = 20
    counts: Dict[str, int] = Field(default_factory=dict)


class GroupEventOut(ORMModel):
    id: uuid.UUID
    account_id: Optional[uuid.UUID] = None
    tg_chat_id: int
    tg_user_id: Optional[int] = None
    event_type: str
    event_type_label: str = ""
    actor_tg_id: Optional[int] = None
    user_display: str = ""
    username: Optional[str] = None
    is_bot: bool = False
    occurred_at: Optional[datetime] = None
    group_title: Optional[str] = None


class GroupEventListResponse(BaseModel):
    items: List[GroupEventOut]
    total: int
    page: int = 1
    page_size: int = 50
    counts: Dict[str, int] = Field(default_factory=dict)


class GroupIntelStats(BaseModel):
    groups: int = 0
    members: int = 0
    bots: int = 0
    events_today: int = 0
    joins_today: int = 0
    leaves_today: int = 0
    watching: bool = True


class CollectMessagesRequest(BaseModel):
    """采集群内对话：成员名单被群主隐藏时的替代方案（对话照样能读）。"""

    profile_id: uuid.UUID = Field(description="群档案 id")
    account_ids: Optional[List[uuid.UUID]] = Field(default=None, description="执行账号（留空按 scope）")
    scope: str = Field(default="selected", description="selected / all / group:<分组ID>")
    days: int = Field(default=7, ge=1, le=365, description="只扫最近多少天的消息")
    exclude_admins: bool = Field(default=False, description="跳过管理员的发言")
    exclude_bots: bool = Field(default=True, description="跳过机器人")
    limit: int = Field(default=1000, ge=10, le=5000, description="最多扫多少条消息")
    keywords: List[str] = Field(
        default_factory=list,
        max_length=10,
        description="只捞聊到这些词的人（留空=全量扫；命中走 Telegram 服务端搜索，比本地过滤准）",
    )


class InspectGroupsRequest(BaseModel):
    """筛群：批量体检群链接（只读）。"""

    links: List[str] = Field(default_factory=list, min_length=1, max_length=200, description="群链接 / @用户名，一行一个")
    account_id: Optional[uuid.UUID] = Field(default=None, description="用哪个号体检（留空自动挑一个可用的）")
    min_interval: float = Field(default=2.0, ge=0.5, le=30, description="每条之间最小间隔（秒）")
    max_interval: float = Field(default=6.0, ge=0.5, le=60, description="最大间隔（秒）")


class KeywordWatchRequest(BaseModel):
    """新建关键词监听规则。"""

    name: str = Field(default="", max_length=64, description="规则名（留空自动取前几个词）")
    keywords: List[str] = Field(default_factory=list, description="关键词，命中任意一个即记录")
    tg_chat_ids: List[int] = Field(default_factory=list, description="只监听这些群；留空 = 全部")
    account_ids: List[uuid.UUID] = Field(default_factory=list, description="只用这些号监听；留空 = 全部在线号")
    enabled: bool = Field(default=True, description="是否启用")
    notify: bool = Field(default=True, description="命中时推通知")


class KeywordWatchUpdate(BaseModel):
    """改规则：只传要改的字段。"""

    name: Optional[str] = None
    keywords: Optional[List[str]] = None
    tg_chat_ids: Optional[List[int]] = None
    account_ids: Optional[List[uuid.UUID]] = None
    enabled: Optional[bool] = None
    notify: Optional[bool] = None


class ReplyRuleRequest(BaseModel):
    """新建自动回复规则。"""

    name: str = Field(default="", max_length=64)
    keywords: List[str] = Field(default_factory=list)
    reply_text: str = Field(default="", max_length=4000, description="命中后自动回复的内容")
    match_mode: str = Field(default="contains", pattern="^(contains|exact|regex)$")
    scope: str = Field(default="private", pattern="^(private|group|both)$", description="private 仅私信 / group 仅群 / both 都回")
    account_ids: List[uuid.UUID] = Field(default_factory=list, description="只用这些号自动回；留空 = 全部")
    enabled: bool = True
    priority: int = Field(default=100, ge=1, le=999, description="数字小的先匹配")
    cooldown_seconds: int = Field(default=300, ge=0, le=86400, description="同一会话多久内只回一次")


class ReplyRuleUpdate(BaseModel):
    """改规则：只传要改的字段。"""

    name: Optional[str] = None
    keywords: Optional[List[str]] = None
    reply_text: Optional[str] = None
    match_mode: Optional[str] = None
    scope: Optional[str] = None
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    cooldown_seconds: Optional[int] = None


class SearchGroupsRequest(BulkScopeRequest):
    """按关键词找公开群（走 Telegram 原生搜索）。

    继承 `BulkScopeRequest` 是为了复用统一的账号范围（scope / account_ids / limit），
    所以「每个词取多少结果」单独叫 `per_keyword`，避免和账号上限的 `limit` 撞名。
    """

    keywords: List[str] = Field(default_factory=list, min_length=1, max_length=20, description="关键词，最多 20 个")
    per_keyword: int = Field(default=50, ge=1, le=100, description="每个关键词最多取多少个结果")
    min_members: int = Field(default=0, ge=0, le=1000000, description="成员数门槛：小于这个数的不收")
    kind: str = Field(default="any", pattern="^(any|group|channel)$", description="只要群 / 只要频道 / 都要")
    regions: List[str] = Field(
        default_factory=list,
        max_length=10,
        description="地区扩展：MY/SG/ID/TH 或自定义地名；留空则只搜原始关键词",
    )
    languages: List[str] = Field(
        default_factory=list,
        max_length=5,
        description="群组后缀语言：ms/en/zh/id/th；留空则用地区预设",
    )
    max_queries: int = Field(
        default=120,
        ge=1,
        le=300,
        description="本轮最多执行多少个查询（含原始关键词），防止展开过多触发限流",
    )
    expand_linked_chats: bool = Field(
        default=True,
        description="是否从公开频道展开 linked_chat 讨论群（只读，不加群）",
    )
    max_linked_chats: int = Field(
        default=50,
        ge=0,
        le=200,
        description="本轮最多展开多少个频道/群的 linked_chat",
    )
    expand_messages: bool = Field(
        default=True,
        description="是否从命中频道的最近消息里抓 t.me/@username 反查群（图扩散 depth=1）",
    )
    message_channels: int = Field(default=10, ge=0, le=50, description="最多读多少个频道的消息")
    message_limit: int = Field(default=200, ge=20, le=500, description="每个频道读最近多少条消息")
    expand_recommendations: bool = Field(
        default=True,
        description="是否调用 channels.GetChannelRecommendations 找相似频道",
    )
    recommendation_channels: int = Field(default=10, ge=0, le=50, description="最多对多少个种子频道取推荐")
    enrich_tme: bool = Field(
        default=True,
        description="是否访问 t.me 公开页补标题/简介/成员数（只读 HTTP，不登录）",
    )
    tme_limit: int = Field(default=50, ge=0, le=200, description="每轮最多富化多少个公开实体")
    max_links: int = Field(default=100, ge=0, le=300, description="每轮最多验证多少个消息里发现的链接")


class PreciseSearchRequest(BulkScopeRequest):
    """多语言关键词精准检索讨论组（多源召回 + 严格校验 + 评分）。"""

    dispatch: str = Field(
        default="round_robin",
        description="多号分配策略：round_robin=查询/候选按号分片并行不重复（默认）；each=每个号跑全量",
    )
    keywords: List[str] = Field(default_factory=list, min_length=1, max_length=20, description="关键词，最多 20 个")
    country: Optional[str] = Field(default=None, max_length=8, description="目标地区代码，如 TH / MY / SG / ID")
    languages: List[str] = Field(default_factory=list, max_length=6, description="目标语言，如 th/en/zh/ms")
    per_keyword: int = Field(default=50, ge=1, le=100, description="每条查询最多取多少个实体")
    min_members: int = Field(default=0, ge=0, le=1000000, description="成员数门槛")
    max_queries: int = Field(default=120, ge=1, le=300, description="最多执行多少条查询")
    group_only: bool = Field(default=True, description="只保留讨论组（超级群），排除广播频道")
    public_only: bool = Field(default=True, description="只保留有公开用户名的实体")
    include_linked_groups: bool = Field(default=True, description="是否从频道展开 linked_chat 讨论组")
    max_linked_chats: int = Field(default=50, ge=0, le=200, description="最多检查多少个频道的 linked_chat")
    exclude_readonly: bool = Field(default=True, description="排除默认权限为只读的群")
    search_messages: bool = Field(default=True, description="是否用 messages.searchGlobal 补充召回")
    message_search_queries: int = Field(default=5, ge=0, le=20, description="用前几条查询做消息搜索")
    message_search_pages: int = Field(default=2, ge=1, le=5, description="每条消息搜索查询最多翻页数")
    full_check_limit: int = Field(default=60, ge=0, le=200, description="最多对多少个讨论组拉 GetFullChannel")
    min_relevance_score: int = Field(default=60, ge=0, le=100, description="保留门槛；低于它但 ≥40 的进待确认")
    enable_contacts_search: bool = Field(default=True, description="是否执行 contacts.search 原生搜索")
    contacts_query_limit: int = Field(default=120, ge=0, le=300, description="原生搜索最多执行多少条查询")
    expand_short_queries: bool = Field(
        default=True,
        description="是否追加短核心词兜底召回（仅按用户关键词所属主题扩展）",
    )
    short_query_limit: int = Field(default=60, ge=0, le=80, description="最多追加多少条短核心词")
    expand_recommendations: bool = Field(
        default=True,
        description="是否从高相关频道拉相似频道推荐并继续展开 linked_chat 讨论组",
    )
    recommendation_channels: int = Field(default=8, ge=0, le=30, description="最多取多少个频道的相似推荐")
    expand_channel_messages: bool = Field(
        default=True,
        description="是否从命中频道近期消息提取 t.me 链接做图扩散（候选仍须通过讨论组与相关性过滤）",
    )
    message_channels: int = Field(default=8, ge=0, le=30, description="最多读多少个种子频道的近期消息")
    message_limit: int = Field(default=100, ge=20, le=300, description="每个种子频道最多读多少条消息")
    scan_joined_groups: bool = Field(
        default=True,
        description="是否从执行号已加入的同主题群内扫链接与关联群作为补充候选",
    )
    joined_group_limit: int = Field(default=15, ge=0, le=100, description="已加入群图谱最多扫描多少个匹配群")
    enrich_tme: bool = Field(
        default=True,
        description="是否对未分配到 GetFullChannel 配额或缺少简介的公开群补抓 t.me 公开页（零账号配额消耗）",
    )
    tme_limit: int = Field(default=30, ge=0, le=100, description="最多补抓多少个 t.me 公开页")
    expand_scope_preset: bool = Field(
        default=False,
        description="一键扩大搜索范围（开启公开频道帖子搜索、外部网页检索与共同群扩展）",
    )
    expand_channel_posts: bool = Field(
        default=False,
        description="是否通过 channels.searchPosts 搜索公开频道帖子作种子（可能受 Premium/Stars 限制，默认关闭）",
    )
    channel_posts_query_limit: int = Field(default=5, ge=0, le=20, description="频道帖子搜索最多查询条数")
    allow_paid_channel_posts: bool = Field(default=False, description="是否允许 channels.searchPosts 消耗付费 Stars 配额")
    channel_posts_max_stars: int = Field(default=0, ge=0, le=500, description="单次帖子搜索允许消耗的 Stars 上限")
    expand_external_web: bool = Field(
        default=False,
        description="是否启用外部网页/公开目录适配器召回 t.me 候选后再经 Telegram 核验（默认关闭）",
    )
    external_web_query_limit: int = Field(default=3, ge=1, le=10, description="外部网页检索最多查询几个关键词")
    external_web_candidate_limit: int = Field(default=30, ge=0, le=200, description="外部网页最多提取多少个待核验链接")
    allow_paid_external_search: bool = Field(default=False, description="外部搜索是否允许调用配置了付费 API Key 的引擎/目录")
    expand_common_chats: bool = Field(
        default=False,
        description="是否启用「已知用户 → 共同群」图扩散 common_chat_graph（默认关闭）",
    )
    common_chat_user_limit: int = Field(default=8, ge=0, le=25, description="共同群扩展最多查询多少个已知用户")
    rpc_budget: int = Field(default=180, ge=20, le=500, description="单账号单次精准检索的 Telegram RPC 总预算上限")
    verify_activity: bool = Field(
        default=True,
        description="是否抽样最近 20 条公开消息核验近期真人活跃度（只读）",
    )
    activity_check_limit: int = Field(default=25, ge=0, le=60, description="最多对多少个高潜力群抽样近期消息活跃度")
    ai_expand: bool = Field(
        default=False,
        description="可选：用已配置的 AI 模型生成多语言扩展查询词（未配置时自动降级为规则扩展）",
    )
    ai_review: bool = Field(
        default=False,
        description="可选：用已配置的 AI 模型对候选群做语义复核与反垃圾降噪（未配置时自动降级为规则打分）",
    )
    candidate_links: List[str] = Field(
        default_factory=list,
        max_length=200,
        description="可选：外部找到的 t.me 用户名/邀请链接（支持粘贴整段文本自动提取），逐条只读核验后并入结果",
    )


class GroupSearchKeywordOut(ORMModel):
    id: uuid.UUID
    task_id: uuid.UUID
    query: str
    source: str
    status: str
    raw_count: int = 0
    found_count: int = 0
    error: str = ""
    created_at: Optional[datetime] = None


class GroupSearchMatchOut(ORMModel):
    id: uuid.UUID
    task_id: uuid.UUID
    profile_id: Optional[uuid.UUID] = None
    tg_chat_id: int
    title: str = ""
    username: Optional[str] = None
    member_count: Optional[int] = None
    source: str = "contacts_search"
    query: str = ""
    relevance_score: int = 0
    breakdown: Dict[str, int] = Field(default_factory=dict)
    matched_keywords: List[str] = Field(default_factory=list)
    discovery_sources: List[str] = Field(default_factory=list)
    source_counts: Dict[str, int] = Field(default_factory=dict)
    evidence: List[Dict[str, Any]] = Field(default_factory=list)
    verification_tier: str = "tg_verified"
    trust_bonus: int = 0
    language: Optional[str] = None
    country: Optional[str] = None
    topic: Optional[str] = None
    status: str = "needs_review"
    reasons: List[str] = Field(default_factory=list)
    raw: Dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None

    @model_validator(mode="after")
    def _hydrate_source_metadata(self) -> "GroupSearchMatchOut":
        raw = self.raw if isinstance(self.raw, dict) else {}
        self.source = normalize_search_source(self.source)
        base_sources = self.discovery_sources or ([self.source] if self.source else [])
        self.discovery_sources = normalize_source_list(base_sources)

        merged_counts: dict[str, int] = {}
        raw_counts = self.source_counts or (raw.get("source_counts") if isinstance(raw.get("source_counts"), dict) else {})
        if isinstance(raw_counts, dict):
            for k, v in raw_counts.items():
                norm_k = normalize_search_source(str(k))
                merged_counts[norm_k] = merged_counts.get(norm_k, 0) + int(v or 0)
        self.source_counts = merged_counts

        if not self.evidence and isinstance(raw.get("evidence"), list):
            normalized_ev: list[dict[str, Any]] = []
            for item in raw["evidence"][:20]:
                if isinstance(item, dict):
                    copied = dict(item)
                    if copied.get("source"):
                        copied["source"] = normalize_search_source(str(copied["source"]))
                    normalized_ev.append(copied)
            self.evidence = normalized_ev
        if raw.get("verification_tier"):
            self.verification_tier = str(raw["verification_tier"])
        if not self.trust_bonus:
            if raw.get("trust_bonus") is not None:
                self.trust_bonus = int(raw.get("trust_bonus") or 0)
            elif "trust" in self.breakdown:
                self.trust_bonus = int(self.breakdown.get("trust") or 0)
        return self


class DiscoveryQueryStatOut(ORMModel):
    """一条查询的绩效：跑了多少次、产出多少、是否已被自动停用。"""

    query: str
    region: Optional[str] = None
    lang: Optional[str] = None
    template: str = ""
    runs: int = 0
    raw: int = 0
    found_total: int = 0
    last_found: int = 0
    zero_streak: int = 0
    yield_rate: float = 0.0
    enabled: bool = True
    last_error: str = ""
    last_run_at: Optional[datetime] = None


class DiscoveryLeadOut(ORMModel):
    """只有邀请链接、还没有实体 id 的私群线索。"""

    id: uuid.UUID
    account_id: Optional[uuid.UUID] = None
    invite_hash: str
    invite_link: str = ""
    tg_chat_id: Optional[int] = None
    title: str = ""
    about: str = ""
    member_count: Optional[int] = None
    kind: str = "group"
    source: str = "channel_message_link"
    query: str = ""
    seed_chat_id: Optional[int] = None
    depth: int = 1
    confidence: float = 0.5
    status: str = "new"
    created_at: Optional[datetime] = None


class PreciseBatchOut(BaseModel):
    """一批精准找群任务（多号并行去重汇总 + 进度 + 来源统计 + 分层候选）。"""

    batch_id: uuid.UUID
    total_tasks: int = 0
    active_tasks: int = 0
    completed_tasks: int = 0
    failed_tasks: int = 0
    matches: List[GroupSearchMatchOut] = Field(default_factory=list)
    unverified_candidates: List[Dict[str, Any]] = Field(default_factory=list)
    source_stats: Dict[str, int] = Field(default_factory=dict)
    ai_notes: List[str] = Field(default_factory=list)
