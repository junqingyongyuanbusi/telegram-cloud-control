"""精准检索：群档案判定字段 + 查询流水 + 匹配快照

Revision ID: f4b8c1d9e2a7
Revises: a9d4e2c7b1f0
Create Date: 2026-11-24 00:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f4b8c1d9e2a7"
down_revision = "a9d4e2c7b1f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 群档案补判定结果（历史行为空，不阻塞旧数据）。
    op.add_column("group_profiles", sa.Column("language", sa.String(length=8), nullable=True))
    op.add_column("group_profiles", sa.Column("country", sa.String(length=8), nullable=True))
    op.add_column("group_profiles", sa.Column("topic", sa.String(length=24), nullable=True))
    op.add_column("group_profiles", sa.Column("relevance_score", sa.Integer(), nullable=True))
    op.add_column("group_profiles", sa.Column("send_permission", sa.String(length=16), nullable=True))
    op.add_column("group_profiles", sa.Column("join_request", sa.Boolean(), nullable=True))
    op.add_column("group_profiles", sa.Column("linked_channel_id", sa.BigInteger(), nullable=True))
    op.add_column("group_profiles", sa.Column("verification_status", sa.String(length=16), nullable=True))
    op.add_column("group_profiles", sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "group_profiles",
        sa.Column(
            "discovery_sources",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "group_profiles",
        sa.Column(
            "matched_keywords",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.create_index("ix_group_profiles_language", "group_profiles", ["language"])
    op.create_index("ix_group_profiles_country", "group_profiles", ["country"])
    op.create_index("ix_group_profiles_topic", "group_profiles", ["topic"])
    op.create_index("ix_group_profiles_relevance_score", "group_profiles", ["relevance_score"])

    op.create_table(
        "group_search_keywords",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("query", sa.String(length=255), nullable=False),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("raw_count", sa.Integer(), nullable=False),
        sa.Column("found_count", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["tg_accounts.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "source", "query", name="uq_group_search_keywords_task_source_query"),
    )
    op.create_index("ix_group_search_keywords_task_id", "group_search_keywords", ["task_id"])
    op.create_index("ix_group_search_keywords_account_id", "group_search_keywords", ["account_id"])

    op.create_table(
        "group_search_matches",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("profile_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("tg_chat_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("member_count", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("query", sa.String(length=255), nullable=False),
        sa.Column("keywords", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("relevance_score", sa.Integer(), nullable=False),
        sa.Column("breakdown", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("matched_keywords", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("discovery_sources", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("language", sa.String(length=8), nullable=True),
        sa.Column("country", sa.String(length=8), nullable=True),
        sa.Column("topic", sa.String(length=24), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reasons", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["tg_accounts.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["profile_id"], ["group_profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "tg_chat_id", name="uq_group_search_matches_task_chat"),
    )
    op.create_index("ix_group_search_matches_task_id", "group_search_matches", ["task_id"])
    op.create_index("ix_group_search_matches_account_id", "group_search_matches", ["account_id"])
    op.create_index("ix_group_search_matches_profile_id", "group_search_matches", ["profile_id"])
    op.create_index("ix_group_search_matches_tg_chat_id", "group_search_matches", ["tg_chat_id"])
    op.create_index("ix_group_search_matches_relevance_score", "group_search_matches", ["relevance_score"])
    op.create_index("ix_group_search_matches_language", "group_search_matches", ["language"])
    op.create_index("ix_group_search_matches_country", "group_search_matches", ["country"])
    op.create_index("ix_group_search_matches_status", "group_search_matches", ["status"])
    op.create_index("ix_group_search_matches_task_status", "group_search_matches", ["task_id", "status"])


def downgrade() -> None:
    op.drop_table("group_search_matches")
    op.drop_table("group_search_keywords")
    op.drop_index("ix_group_profiles_relevance_score", table_name="group_profiles")
    op.drop_index("ix_group_profiles_topic", table_name="group_profiles")
    op.drop_index("ix_group_profiles_country", table_name="group_profiles")
    op.drop_index("ix_group_profiles_language", table_name="group_profiles")
    for column in (
        "matched_keywords",
        "discovery_sources",
        "last_verified_at",
        "verification_status",
        "linked_channel_id",
        "join_request",
        "send_permission",
        "relevance_score",
        "topic",
        "country",
        "language",
    ):
        op.drop_column("group_profiles", column)
