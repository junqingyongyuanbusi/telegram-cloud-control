"""精准找群的可选 AI 辅助：多语言扩词 + 候选语义/反垃圾复核。

未开启 `AI_ENABLED` 或未配置 `AI_API_KEY` 时只返回明确降级提示，绝不中断主流程。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional, Sequence

from app.services.ai import AIUnavailable, ai_service

logger = logging.getLogger(__name__)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I)


def _strip_fence(text: str) -> str:
    return _CODE_FENCE_RE.sub("", (text or "").strip()).strip()


def _parse_json_list(raw: str) -> list[Any]:
    cleaned = _strip_fence(raw)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except Exception:  # noqa: BLE001
        pass
    match = re.search(r"\[.*\]", cleaned, re.S)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, list):
                return parsed
        except Exception:  # noqa: BLE001
            pass
    return []


async def expand_queries_with_ai(
    keywords: Sequence[str],
    *,
    country: Optional[str] = None,
    languages: Sequence[str] = (),
    limit: int = 12,
) -> tuple[list[str], Optional[str]]:
    """根据行业关键词 + 目标地区/语言生成高命中短搜索词；失败时返回降级提示。"""

    if not keywords:
        return [], None
    if not ai_service.available:
        return [], "AI 扩词未配置（需开启 AI_ENABLED 与 AI_API_KEY），已自动降级为规则扩展"

    prompt = (
        "你是 Telegram 公开群搜索专家。请根据用户输入生成适合调用 Telegram contacts.Search 的短搜索词。\n"
        f"- 原始关键词：{', '.join(keywords)}\n"
        f"- 目标地区：{country or '不限'}\n"
        f"- 目标语言：{', '.join(languages) if languages else '按地区常见语言'}\n"
        f"要求：\n"
        f"1. 每条搜索词保持 1~4 个词（总长度不超过 40 字符），优先覆盖本地语/英文/中文常用群名表达与本地常见机构词；\n"
        f"2. 只输出最多 {max(1, min(int(limit), 20))} 条字符串组成的 JSON 数组，不要解释文字。"
    )
    try:
        reply = await ai_service.chat(
            [
                {"role": "system", "content": "只返回合法 JSON 字符串数组。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )
    except (AIUnavailable, Exception) as exc:  # noqa: BLE001
        logger.warning("AI 扩词失败，已降级为规则扩展：%s", exc)
        return [], f"AI 扩词调用失败（{type(exc).__name__}），已自动降级为规则扩展"

    parsed = _parse_json_list(reply)
    out: list[str] = []
    seen: set[str] = set()
    for item in parsed:
        text = " ".join(str(item or "").split()).strip()
        if not text or len(text) > 64:
            continue
        key = text.casefold()
        if key not in seen:
            seen.add(key)
            out.append(text)
        if len(out) >= limit:
            break
    if not out:
        return [], "AI 扩词未返回有效词条，已自动降级为规则扩展"
    return out, None


async def review_candidates_with_ai(
    candidates: Sequence[dict[str, Any]],
    *,
    keywords: Sequence[str],
    country: Optional[str] = None,
    languages: Sequence[str] = (),
) -> tuple[dict[int, dict[str, Any]], Optional[str]]:
    """对候选讨论组做语义/反垃圾二次复核，返回 `{tg_chat_id: {relevant, delta, reason}}`。"""

    if not candidates:
        return {}, None
    if not ai_service.available:
        return {}, "AI 语义复核未配置（需开启 AI_ENABLED 与 AI_API_KEY），已自动降级为规则打分"

    batch = list(candidates)[:15]
    items_payload = [
        {
            "tg_chat_id": int(item["tg_chat_id"]),
            "title": str(item.get("title") or "")[:120],
            "username": item.get("username") or "",
            "about": str(item.get("about") or "")[:300],
            "sample_messages": [str(msg)[:120] for msg in (item.get("sample_messages") or [])[:5]],
        }
        for item in batch
    ]
    prompt = (
        "请逐条评估以下 Telegram 讨论组是否与业务目标真实匹配，并排除纯广告刷屏/博彩色情/无关群。\n"
        f"- 检索关键词：{', '.join(keywords)}\n"
        f"- 目标地区：{country or '不限'}\n"
        f"- 目标语言：{', '.join(languages) if languages else '不限'}\n"
        f"- 候选列表 JSON：{json.dumps(items_payload, ensure_ascii=False)}\n"
        "请只返回 JSON 数组，每项格式："
        '{"tg_chat_id": 123, "relevant": true, "delta": 10, "reason": "简短中文原因"}\n'
        "其中 delta 为 -25 到 +15 的整数（广告/跑题给负分，高度贴合给正分）。"
    )
    try:
        reply = await ai_service.chat(
            [
                {"role": "system", "content": "只返回合法 JSON 对象数组，不要额外文本。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
    except (AIUnavailable, Exception) as exc:  # noqa: BLE001
        logger.warning("AI 语义复核失败，已降级为规则打分：%s", exc)
        return {}, f"AI 语义复核调用失败（{type(exc).__name__}），已自动降级为规则打分"

    parsed = _parse_json_list(reply)
    reviews: dict[int, dict[str, Any]] = {}
    for row in parsed:
        if not isinstance(row, dict) or row.get("tg_chat_id") is None:
            continue
        try:
            chat_id = int(row["tg_chat_id"])
            delta = max(-25, min(15, int(row.get("delta") or 0)))
        except (TypeError, ValueError):
            continue
        reviews[chat_id] = {
            "relevant": bool(row.get("relevant", delta >= 0)),
            "delta": delta,
            "reason": str(row.get("reason") or "")[:120],
        }
    return reviews, None
