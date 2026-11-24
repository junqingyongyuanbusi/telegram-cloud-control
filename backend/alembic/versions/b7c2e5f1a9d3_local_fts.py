"""本地群库全文检索：search_vector 生成列 + pg_trgm

Revision ID: b7c2e5f1a9d3
Revises: f4b8c1d9e2a7
Create Date: 2026-11-24 01:10:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b7c2e5f1a9d3"
down_revision = "f4b8c1d9e2a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.add_column(
        "group_profiles",
        sa.Column(
            "search_vector",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(username, '') "
                "|| ' ' || coalesce(about, ''))",
                persisted=True,
            ),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_group_profiles_search_vector",
        "group_profiles",
        ["search_vector"],
        postgresql_using="gin",
    )
    # 中文/泰文没有空格分词，tsvector 只能按整段处理；trgm 负责子串召回。
    op.execute(
        "CREATE INDEX ix_group_profiles_search_trgm ON group_profiles "
        "USING gin ((coalesce(title, '') || ' ' || coalesce(username, '') || ' ' || "
        "coalesce(about, '')) gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_group_profiles_search_trgm")
    op.drop_index("ix_group_profiles_search_vector", table_name="group_profiles")
    op.drop_column("group_profiles", "search_vector")
