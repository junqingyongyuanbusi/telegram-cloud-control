"""群档案记录国家来源（target / inferred）

Revision ID: d4e8b6a2f037
Revises: b7d3f2a91c46
Create Date: 2026-11-26 18:42:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d4e8b6a2f037"
down_revision = "b7d3f2a91c46"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "group_profiles",
        sa.Column("country_source", sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("group_profiles", "country_source")
