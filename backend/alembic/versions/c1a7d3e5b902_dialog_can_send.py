"""会话补发言权限：不能发言的群不进目标群列表

Revision ID: c1a7d3e5b902
Revises: b7c2e5f1a9d3
Create Date: 2026-11-24 09:12:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c1a7d3e5b902"
down_revision = "b7c2e5f1a9d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 历史行默认 True（老数据没查过权限，不能一上来就全隐藏），同步后按真实权限回填。
    op.add_column(
        "dialogs",
        sa.Column("can_send", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("dialogs", "can_send", server_default=None)


def downgrade() -> None:
    op.drop_column("dialogs", "can_send")
