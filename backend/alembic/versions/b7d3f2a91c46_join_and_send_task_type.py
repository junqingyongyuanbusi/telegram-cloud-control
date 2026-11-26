"""加群群发任务类型：向 task_type 枚举追加 join_and_send

Revision ID: b7d3f2a91c46
Revises: c1a7d3e5b902
Create Date: 2026-11-25 23:52:00.000000

背景：触达中心把「群发 / 素材群发 / 加群」三个入口合并成「加群群发」——
一个号一条任务，号内逐群「加群 → 过验证 → 发内容」。
PG 枚举的 ADD VALUE 不能回滚，downgrade 留空（沿用 a8c4e7f31b95 的做法）。
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "b7d3f2a91c46"
down_revision = "c1a7d3e5b902"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE task_type ADD VALUE IF NOT EXISTS 'join_and_send'")


def downgrade() -> None:
    # PG 不支持从枚举里删值；旧代码不认识该值也不会执行到（无历史任务时无副作用）。
    pass
