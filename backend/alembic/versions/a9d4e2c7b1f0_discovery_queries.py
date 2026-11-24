"""group discovery: 查询绩效表 + 私群邀请线索

Revision ID: a9d4e2c7b1f0
Revises: c3e9f5a2b4d6
Create Date: 2026-11-24 07:40:00.000000

- `discovery_query_stats`：每条查询的 runs/raw/产出/连续 0 产出，用于自动停用无效词；
- `discovery_leads`：`CheckChatInvite` 只能拿到标题/人数、拿不到实体 id 的私群邀请线索。
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a9d4e2c7b1f0"
down_revision: Union[str, None] = "c3e9f5a2b4d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "discovery_query_stats",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("query", sa.String(length=128), nullable=False),
        sa.Column("region", sa.String(length=16), nullable=True),
        sa.Column("lang", sa.String(length=8), nullable=True),
        sa.Column("template", sa.String(length=24), nullable=False, server_default=""),
        sa.Column("runs", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("found_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("zero_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("yield_rate", sa.Float(), nullable=False, server_default="0"),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_error", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discovery_query_stats")),
        sa.UniqueConstraint("query", name=op.f("uq_discovery_query_stats_query")),
    )
    op.create_index(op.f("ix_discovery_query_stats_query"), "discovery_query_stats", ["query"])
    op.create_index(op.f("ix_discovery_query_stats_enabled"), "discovery_query_stats", ["enabled"])

    op.create_table(
        "discovery_leads",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=True),
        sa.Column("invite_hash", sa.String(length=64), nullable=False),
        sa.Column("invite_link", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("tg_chat_id", sa.BigInteger(), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("about", sa.Text(), nullable=False, server_default=""),
        sa.Column("member_count", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="group"),
        sa.Column("source", sa.String(length=24), nullable=False, server_default="message_link"),
        sa.Column("query", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("seed_chat_id", sa.BigInteger(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="new"),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discovery_leads")),
        sa.ForeignKeyConstraint(
            ["account_id"], ["tg_accounts.id"], name=op.f("fk_discovery_leads_account_id_tg_accounts"), ondelete="CASCADE"
        ),
        sa.UniqueConstraint("account_id", "invite_hash", name="uq_discovery_leads_account_invite"),
    )
    op.create_index(op.f("ix_discovery_leads_account_id"), "discovery_leads", ["account_id"])
    op.create_index(op.f("ix_discovery_leads_tg_chat_id"), "discovery_leads", ["tg_chat_id"])
    op.create_index(op.f("ix_discovery_leads_status"), "discovery_leads", ["status"])
    op.create_index("ix_discovery_leads_seed_chat", "discovery_leads", ["seed_chat_id"])


def downgrade() -> None:
    op.drop_table("discovery_leads")
    op.drop_table("discovery_query_stats")
