#!/usr/bin/env python3
"""回填群档案的语言/地区：按群名+简介重新判定，并给旧数据补上来源标记。

    backend/.venv/bin/python scripts/backfill_group_geo.py [--dry-run] [--limit N]

与线上 `upsert_profile` 的「只补空值」不同，这个脚本会重判全部行（用于修正历史数据）：
language 为空就按群名+简介判断；country 一律按文本重新推断，推断不出时保留旧值并标成
target——旧版只在命中检索目标国时才写 country，这些值确实来自检索目标，不是文本推断。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from app.models import GroupProfile  # noqa: E402
from app.services.group_precision import detect_country, detect_language  # noqa: E402


async def run(dry_run: bool, limit: int | None) -> None:
    async with SessionFactory() as session:
        # 全部重算：旧数据里 country 很多是「检索目标国」回填的，不能直接当归属。
        stmt = select(GroupProfile).order_by(GroupProfile.collected_at.desc().nullslast())
        if limit:
            stmt = stmt.limit(limit)
        rows = list((await session.scalars(stmt)).all())
        changed = 0
        for profile in rows:
            sample = f"{profile.title or ''}\n{profile.about or ''}".strip()
            sample = sample or str(profile.username or "")
            lang = profile.language if profile.language not in (None, "", "unknown") else detect_language(sample)
            geo = detect_country(sample, username=profile.username, language=lang)
            if geo.country:
                country, source = geo.country, "inferred"
            else:
                # 文本没有足够证据时保留旧值，但如实标成 target（检索目标国回填），
                # 页面用 country_source 区分，不把它伪装成文本推断。
                if profile.country:
                    country, source = str(profile.country)[:8], "target"
                else:
                    country, source = None, None
            updates: dict[str, str | None] = {}
            if profile.language != lang:
                updates["language"] = lang[:8]
            if profile.country != country:
                updates["country"] = country[:8] if country else None
            if profile.country_source != source:
                updates["country_source"] = source[:16] if source else None
            if not updates:
                continue
            changed += 1
            if not dry_run:
                for key, value in updates.items():
                    setattr(profile, key, value)
        if not dry_run:
            await session.commit()
        print(f"scanned={len(rows)} changed={changed} dry_run={dry_run}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    asyncio.run(run(args.dry_run, args.limit))


if __name__ == "__main__":
    main()
