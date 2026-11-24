"""本地群库检索：PostgreSQL 全文（tsvector）+ pg_trgm 子串召回。

为什么两套：
- `to_tsvector('simple', ...)` 对英文/马来语按空格切词，能算相关性排序；
- 中文/泰文没有空格，tsvector 会把整段当一个 token，必须靠 pg_trgm 的
  `ILIKE %词%` 才能命中标题中间的词。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Iterable, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import GroupProfile

#: 生成列与 trgm 索引共用的表达式；改这里必须同步迁移。
SEARCH_TEXT = (
    func.coalesce(GroupProfile.title, "")
    + " "
    + func.coalesce(GroupProfile.username, "")
    + " "
    + func.coalesce(GroupProfile.about, "")
)


@dataclass(slots=True)
class LocalGroupMatch:
    profile: GroupProfile
    rank: float
    similarity: float


async def search_local_profiles(
    session: AsyncSession,
    keyword: str,
    *,
    limit: int = 30,
    account_ids: Optional[Iterable[uuid.UUID]] = None,
    only_public: bool = True,
) -> list[LocalGroupMatch]:
    """按关键词检索本地群档案，ts_rank 优先、trigram 相似度次之。"""

    term = (keyword or "").strip()
    if not term:
        return []

    tsquery = func.websearch_to_tsquery("simple", term)
    rank = func.ts_rank_cd(GroupProfile.search_vector, tsquery)
    similarity = func.similarity(SEARCH_TEXT, term)
    pattern = f"%{term}%"

    conditions = [
        or_(
            GroupProfile.search_vector.op("@@")(tsquery),
            # 用与 trgm 索引完全一致的表达式，确保 ILIKE 能走索引。
            SEARCH_TEXT.ilike(pattern),
        )
    ]
    if only_public:
        conditions.append(GroupProfile.username.is_not(None))
    if account_ids is not None:
        ids = list(account_ids)
        if not ids:
            return []
        conditions.append(GroupProfile.account_id.in_(ids))

    stmt = (
        select(GroupProfile, rank.label("rank"), similarity.label("similarity"))
        .where(*conditions)
        .order_by(
            rank.desc(),
            similarity.desc(),
            GroupProfile.relevance_score.desc().nullslast(),
            GroupProfile.member_count.desc().nullslast(),
        )
        .limit(max(1, min(int(limit), 100)))
    )
    rows = (await session.execute(stmt)).all()
    return [
        LocalGroupMatch(profile=row[0], rank=float(row[1] or 0.0), similarity=float(row[2] or 0.0))
        for row in rows
    ]
