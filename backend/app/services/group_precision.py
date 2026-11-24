"""Telegram 讨论组精准检索的规则层。

这里不放网络请求，只做三件事，方便单测和复用：

1. 文本归一化 + 语言/地区判断；
2. 讨论组实体与发言权限的硬校验；
3. 主题/地区/讨论意图/语言的相关性评分（满分 100）。

设计原则：先用硬规则排除「频道、只读群、私有群、机器人」，
再用评分决定排序；高分不能救回一个类型不合格的实体。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable, Optional, Sequence

# ---------------------------------------------------------------- 词典

#: 主题词：英文 / 泰文 / 中文。键是内部规范主题。
TOPIC_TERMS: dict[str, tuple[str, ...]] = {
    "forex": (
        "forex",
        "fx",
        "foreign exchange",
        "currency trading",
        "ฟอเร็กซ์",
        "ฟอเรกซ์",
        "แลกเปลี่ยนเงิน",
        "ค่าเงิน",
        "เงินตรา",
        "外汇",
        "汇率",
    ),
    "gold": ("gold", "xauusd", "ทองคำ", "ทอง", "黄金", "黃金"),
    "stock": ("stock", "stocks", "equity", "หุ้น", "ตลาดหุ้น", "股票", "股市"),
    "crypto": ("crypto", "bitcoin", "btc", "คริปโต", "บิทคอยน์", "加密货币", "加密貨幣"),
    "trading": ("trading", "trade", "trader", "เทรด", "นักเทรด", "交易", " traders"),
    "property": ("property", "real estate", "hartanah", "อสังหา", "房产", "房產"),
    "jobs": ("jobs", "career", "kerja kosong", "รับสมัครงาน", "招聘", "求职"),
}

#: 主题别名（用户输入的主题词 → 规范主题）。
TOPIC_ALIASES: dict[str, str] = {
    "forex": "forex",
    "fx": "forex",
    "外汇": "forex",
    "ฟอเร็กซ์": "forex",
    "gold": "gold",
    "xauusd": "gold",
    "ทองคำ": "gold",
    "黄金": "gold",
    "stock": "stock",
    "stocks": "stock",
    "saham": "stock",
    "หุ้น": "stock",
    "股票": "stock",
    "crypto": "crypto",
    "bitcoin": "crypto",
    "btc": "crypto",
    "คริปโต": "crypto",
    "加密货币": "crypto",
    "trading": "trading",
    "trade": "trading",
    "trader": "trading",
    "เทรด": "trading",
    "交易": "trading",
    "property": "property",
    "hartanah": "property",
    "房产": "property",
    "jobs": "jobs",
    "kerja kosong": "jobs",
    "招聘": "jobs",
}

#: 地区词：唯一用于判断「这个群是否属于目标国家」的文本证据。
REGION_TERMS: dict[str, tuple[str, ...]] = {
    "MY": ("malaysia", "malaysian", "马来西亚", "馬來西亞", "kuala lumpur", "selangor", "johor", "penang", "sabah", "sarawak"),
    "SG": ("singapore", "新加坡", "jurong", "woodlands"),
    "ID": ("indonesia", "indonesian", "印度尼西亚", "印尼", "jakarta", "surabaya", "bandung"),
    "TH": (
        "thailand",
        "thai",
        "ไทย",
        "ประเทศไทย",
        "กรุงเทพ",
        "เชียงใหม่",
        "ภูเก็ต",
        "bangkok",
        "chiang mai",
        "phuket",
    ),
    "US": ("united states", "usa", "america", "美国"),
    "GB": ("united kingdom", "uk", "britain", "england", "英国"),
}

#: 讨论意图词：群名/简介里出现这些词，才更像「讨论组」而不是频道。
INTENT_TERMS: tuple[str, ...] = (
    "group",
    "chat",
    "community",
    "discussion",
    "talk",
    "forum",
    "club",
    "กลุ่ม",
    "พูดคุย",
    "แชท",
    "คอมมูนิตี้",
    "สังคม",
    "群",
    "交流",
    "讨论",
    "討論",
    "kumpulan",
    "grup",
    "komunitas",
)

#: 语言判断用的停用词/特征词。
MALAY_STOPWORDS = frozenset(
    "dan yang untuk dengan ini itu kami kita anda boleh tidak tak ada dari pada akan di ke "
    "saya awak korang kumpulan grup komunitas belajar trading saham pelaburan modal".split()
)
EN_STOPWORDS = frozenset("the and for with this that you your our from have will about".split())

_THAI_RE = re.compile(r"[฀-๿]")
_CJK_RE = re.compile(r"[㐀-䶿一-鿿]")
_WORD_RE = re.compile(r"[a-z0-9]+")


# ---------------------------------------------------------------- 文本


def normalize_text(text: str) -> str:
    """NFKC + 去零宽字符 + 折叠空白；泰文/中文不做分词，保留原串做子串匹配。"""

    value = unicodedata.normalize("NFKC", str(text or ""))
    value = value.replace("​", "").replace("‌", "").replace("‍", "").replace("﻿", "")
    return " ".join(value.split()).strip()


def _lower(text: str) -> str:
    return normalize_text(text).casefold()


def detect_language(text: str) -> str:
    """轻量语言判断：泰文/中文按字符集，马来语按停用词，其余归为 en。"""

    value = normalize_text(text)
    if not value:
        return "unknown"
    thai = len(_THAI_RE.findall(value))
    cjk = len(_CJK_RE.findall(value))
    letters = sum(1 for char in value if char.isalpha())
    if thai and thai * 2 >= max(letters, 1):
        return "th"
    if cjk and cjk * 2 >= max(letters, 1):
        return "zh"
    words = set(_WORD_RE.findall(value.casefold()))
    if len(words & MALAY_STOPWORDS) >= 2:
        return "ms"
    if words & EN_STOPWORDS or words:
        return "en"
    return "unknown"


def canonical_topics(keywords: Iterable[str]) -> list[str]:
    """把用户输入映射成规范主题；未识别的词保留为自定义主题。"""

    topics: list[str] = []
    for keyword in keywords:
        lowered = _lower(keyword)
        topic = TOPIC_ALIASES.get(lowered)
        if topic and topic not in topics:
            topics.append(topic)
            continue
        # 输入可能是「กลุ่มเทรด Forex ไทย」这种多词短语：只要短语里出现主题词就算，
        # 不要求整个短语与词典完全相等。
        for canonical, terms in TOPIC_TERMS.items():
            if canonical not in topics and any(_contains(lowered, term) for term in terms):
                topics.append(canonical)
                break
    return topics


def _contains(text: str, term: str) -> bool:
    """英文按词边界，泰文/中文按子串；避免 "gold" 命中 "goldfish" 这类误伤。"""

    lowered = _lower(text)
    needle = _lower(term)
    if not needle:
        return False
    if _THAI_RE.search(needle) or _CJK_RE.search(needle):
        return needle in lowered
    if " " in needle:
        return needle in lowered
    return re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", lowered) is not None


def region_evidence(text: str, country: Optional[str]) -> tuple[bool, list[str]]:
    """目标国家的文本证据；返回 (是否命中, 命中的词)。"""

    code = str(country or "").strip().upper()
    if not code:
        return False, []
    terms = REGION_TERMS.get(code, (code.casefold(),))
    hits = [term for term in terms if _contains(text, term)]
    return bool(hits), hits


def topic_evidence(text: str, topics: Sequence[str]) -> tuple[bool, list[str]]:
    hits: list[str] = []
    for topic in topics:
        for term in TOPIC_TERMS.get(topic, (topic,)):
            if _contains(text, term):
                hits.append(term)
    return bool(hits), list(dict.fromkeys(hits))


def intent_evidence(text: str) -> tuple[bool, list[str]]:
    hits = [term for term in INTENT_TERMS if _contains(text, term)]
    return bool(hits), hits


# ---------------------------------------------------------------- 实体校验


def discussion_verdict(chat: Any) -> tuple[bool, str]:
    """严格判断是否为公开讨论组（超级群）。

    Telegram 的频道和超级群共用 `Channel` 构造器，必须靠属性区分：
    只有 `megagroup=True` 且不是 `broadcast/gigagroup/monoforum` 才算讨论组。
    """

    name = type(chat).__name__
    if "ChannelForbidden" in name:
        return False, "forbidden"
    if not hasattr(chat, "megagroup"):
        return False, "not_channel"
    if not bool(getattr(chat, "megagroup", False)):
        return False, "not_megagroup"
    if bool(getattr(chat, "broadcast", False)):
        return False, "broadcast"
    if bool(getattr(chat, "gigagroup", False)):
        return False, "gigagroup"
    if bool(getattr(chat, "monoforum", False)):
        return False, "monoforum"
    return True, "ok"


def permission_verdict(chat: Any) -> tuple[str, bool]:
    """返回 (send_permission, readonly)。

    `default_banned_rights.send_messages/send_plain=True` 表示普通成员不能发文字，
    也就是只读群；`join_to_send` 只是要求先加入，不算只读。
    """

    rights = getattr(chat, "default_banned_rights", None)
    if rights is None:
        return "unknown", False
    send_messages = bool(getattr(rights, "send_messages", False))
    send_plain = bool(getattr(rights, "send_plain", False))
    if send_messages or send_plain:
        return "restricted", True
    return "open", False


def can_send_verdict(chat: Any, participant: Any = None) -> bool:
    """当前账号能否在 chat 里发言。

    `participant` 是 `channels.GetParticipant(participant='me')` 返回的成员信息（可为空）：

    - 群主 / 管理员：不受默认禁言限制，能发；
    - 被单独禁言（`banned_rights.send_messages/send_plain`）：不能发；
    - 频道（`broadcast=True`）：非管理员不能发；
    - 群默认禁言（`default_banned_rights`）：不能发。

    只看 `default_banned_rights` 会漏掉「这个号被单独禁言」和「频道只有管理员能发」，
    所以调用方应尽量把 participant 一起传进来。
    """

    if participant is not None:
        name = type(participant).__name__
        if name in ("ChannelParticipantCreator", "ChannelParticipantAdmin"):
            return True
        banned = getattr(participant, "banned_rights", None)
        if banned is not None and (
            bool(getattr(banned, "send_messages", False))
            or bool(getattr(banned, "send_plain", False))
        ):
            return False
    if bool(getattr(chat, "broadcast", False)):
        return False
    rights = getattr(chat, "default_banned_rights", None)
    if rights is not None and (
        bool(getattr(rights, "send_messages", False)) or bool(getattr(rights, "send_plain", False))
    ):
        return False
    return True


def is_public_entity(chat: Any) -> bool:
    return bool(str(getattr(chat, "username", "") or "").strip())


def verification_flags(chat: Any, full: Any = None) -> dict[str, Any]:
    """汇总落库用的校验字段。full 为空表示只做了实体级校验。"""

    send_permission, readonly = permission_verdict(chat)
    full_chat = getattr(full, "full_chat", None) if full is not None else None
    linked_id = getattr(full_chat, "linked_chat_id", None) if full_chat is not None else None
    return {
        "send_permission": send_permission,
        "readonly": readonly,
        "join_request": bool(getattr(chat, "join_request", False)),
        "join_to_send": bool(getattr(chat, "join_to_send", False)),
        "linked_channel_id": int(linked_id) if linked_id else None,
        "is_public": is_public_entity(chat),
        "verification_status": "full" if full_chat is not None else "entity_only",
    }


# ---------------------------------------------------------------- 评分


@dataclass(frozen=True)
class ScoreResult:
    score: int
    breakdown: dict[str, int]
    matched_keywords: list[str]
    language: str
    country: Optional[str]
    topic: Optional[str]
    reasons: list[str]


def score_group(
    *,
    title: str,
    about: str = "",
    username: Optional[str] = None,
    keywords: Sequence[str],
    country: Optional[str] = None,
    languages: Sequence[str] = (),
    detected_language: Optional[str] = None,
) -> ScoreResult:
    """按方案权重打分：名称 30 / 简介 25 / 地区 20 / 讨论意图 15 / 语言 10。"""

    title_text = normalize_text(title)
    about_text = normalize_text(about)
    combined = f"{title_text}\n{about_text}"
    topics = canonical_topics(keywords)
    raw_keywords = [normalize_text(item) for item in keywords if normalize_text(item)]

    title_topic, title_hits = topic_evidence(title_text, topics)
    about_topic, about_hits = topic_evidence(about_text, topics)
    region_hit, region_hits = region_evidence(combined, country)
    intent_hit, intent_hits = intent_evidence(combined)

    language = detected_language or detect_language(combined)
    target_languages = {str(item).casefold() for item in languages if str(item).strip()}

    # 名称：直接命中规范主题给 30，只命中别名/泛交易词给 24，只有相关词根给 18。
    if title_topic:
        name_score = 30
    elif any(_contains(title_text, keyword) for keyword in raw_keywords):
        name_score = 24
    else:
        name_score = 0
    about_score = 25 if about_topic else (14 if any(_contains(about_text, keyword) for keyword in raw_keywords) else 0)
    region_score = 20 if region_hit else 0
    if not region_hit and target_languages and language in target_languages:
        region_score = 8
    intent_score = 15 if intent_hit else 0
    if language in target_languages:
        language_score = 10
    elif language == "unknown":
        language_score = 4
    else:
        language_score = 0

    # 名称/简介里出现用户原始关键词（包括本地语）时，补进命中词。
    matched = list(dict.fromkeys([*title_hits, *about_hits, *region_hits, *intent_hits]))
    for keyword in raw_keywords:
        if _contains(combined, keyword) and keyword not in matched:
            matched.append(keyword)

    breakdown = {
        "name": name_score,
        "about": about_score,
        "region": region_score,
        "intent": intent_score,
        "language": language_score,
    }
    score = max(0, min(100, sum(breakdown.values())))
    reasons: list[str] = []
    if title_topic:
        reasons.append("名称命中主题词")
    if about_topic:
        reasons.append("简介命中主题词")
    if region_hit:
        reasons.append(f"地区命中：{'/'.join(region_hits[:3])}")
    elif region_score:
        reasons.append("语言与目标地区一致")
    if intent_hit:
        reasons.append(f"讨论意图：{'/'.join(intent_hits[:3])}")
    if language_score == 0 and target_languages:
        reasons.append(f"语言不匹配：{language}")

    topic = topics[0] if topics else None
    return ScoreResult(
        score=score,
        breakdown=breakdown,
        matched_keywords=matched,
        language=language,
        country=country if region_hit else (country if region_score else None),
        topic=topic,
        reasons=reasons,
    )


def classify(score: int, *, min_score: int = 60) -> str:
    """把分数映射成状态；min_score 是「保留」门槛，低于它但 ≥40 的进待确认。"""

    if score >= max(80, min_score):
        return "accepted"
    if score >= max(60, min_score):
        return "accepted"
    if score >= 40:
        return "needs_review"
    return "rejected"
