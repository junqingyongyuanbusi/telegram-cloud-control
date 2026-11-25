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
from typing import Any, Iterable, Mapping, Optional, Sequence

from app.services.group_sources import compute_source_trust
# ---------------------------------------------------------------- 词典

#: 主题词：英文 / 泰文 / 中文 / 本地语。键是内部规范主题。
TOPIC_TERMS: dict[str, tuple[str, ...]] = {
    "forex": (
        "forex",
        "fx",
        "foreign exchange",
        "currency trading",
        "pips",
        "ฟอเร็กซ์",
        "ฟอเรกซ์",
        "แลกเปลี่ยนเงิน",
        "ค่าเงิน",
        "เงินตรา",
        "外汇",
        "外匯",
        "汇率",
        "炒汇",
    ),
    "gold": (
        "gold",
        "xauusd",
        "xau",
        "emas",
        "ทองคำ",
        "ทอง",
        "黄金",
        "黃金",
    ),
    "stock": (
        "stock",
        "stocks",
        "equity",
        "equities",
        "saham",
        "bursa",
        "klse",
        "ihsg",
        "set50",
        "tfex",
        "หุ้น",
        "ตลาดหุ้น",
        "股票",
        "股市",
        "马股",
        "美股",
        "港股",
    ),
    "crypto": (
        "crypto",
        "cryptocurrency",
        "bitcoin",
        "btc",
        "eth",
        "ethereum",
        "usdt",
        "web3",
        "defi",
        "binance",
        "คริปโต",
        "บิทคอยน์",
        "加密货币",
        "加密貨幣",
        "币圈",
        "虚拟币",
        "区块链",
    ),
    "trading": (
        "trading",
        "trade",
        "trader",
        "traders",
        "เทรด",
        "นักเทรด",
        "เทรดเดอร์",
        "交易",
        "投资",
        "投資",
        "pelaburan",
    ),
    "property": (
        "property",
        "real estate",
        "hartanah",
        "properti",
        "อสังหา",
        "อสังหาริมทรัพย์",
        "房产",
        "房產",
        "楼市",
    ),
    "jobs": (
        "jobs",
        "job",
        "career",
        "hiring",
        "recruitment",
        "kerja kosong",
        "loker",
        "lowongan",
        "รับสมัครงาน",
        "หางาน",
        "招聘",
        "求职",
    ),
}

#: 主题别名（用户输入的主题词 → 规范主题）。
TOPIC_ALIASES: dict[str, str] = {
    "forex": "forex",
    "fx": "forex",
    "外汇": "forex",
    "外匯": "forex",
    "ฟอเร็กซ์": "forex",
    "ฟอเรกซ์": "forex",
    "gold": "gold",
    "xauusd": "gold",
    "xau": "gold",
    "emas": "gold",
    "ทองคำ": "gold",
    "黄金": "gold",
    "黃金": "gold",
    "stock": "stock",
    "stocks": "stock",
    "saham": "stock",
    "bursa": "stock",
    "klse": "stock",
    "tfex": "stock",
    "หุ้น": "stock",
    "股票": "stock",
    "crypto": "crypto",
    "bitcoin": "crypto",
    "btc": "crypto",
    "eth": "crypto",
    "web3": "crypto",
    "คริปโต": "crypto",
    "加密货币": "crypto",
    "币圈": "crypto",
    "trading": "trading",
    "trade": "trading",
    "trader": "trading",
    "traders": "trading",
    "เทรด": "trading",
    "交易": "trading",
    "property": "property",
    "real estate": "property",
    "hartanah": "property",
    "อสังหา": "property",
    "房产": "property",
    "jobs": "jobs",
    "kerja kosong": "jobs",
    "loker": "jobs",
    "รับสมัครงาน": "jobs",
    "招聘": "jobs",
}

#: 地区词：用于判断「这个群是否属于目标国家」的文本证据（含城市、货币、本地交易所等强特征）。
REGION_TERMS: dict[str, tuple[str, ...]] = {
    "MY": (
        "malaysia",
        "malaysian",
        "马来西亚",
        "馬來西亞",
        "大马",
        "kuala lumpur",
        "selangor",
        "johor",
        "penang",
        "sabah",
        "sarawak",
        "kuching",
        "kota kinabalu",
        "ipoh",
        "melaka",
        "myr",
        "ringgit",
        "bursa malaysia",
        "klse",
        "马股",
        "令吉",
    ),
    "SG": ("singapore", "singaporean", "新加坡", "獅城", "jurong", "woodlands", "sgd", "sgx"),
    "ID": (
        "indonesia",
        "indonesian",
        "印度尼西亚",
        "印尼",
        "jakarta",
        "surabaya",
        "bandung",
        "medan",
        "bali",
        "idr",
        "rupiah",
        "ihsg",
    ),
    "TH": (
        "thailand",
        "thai",
        "ไทย",
        "ประเทศไทย",
        "ไทยแลนด์",
        "กรุงเทพ",
        "เชียงใหม่",
        "ภูเก็ต",
        "bangkok",
        "chiang mai",
        "phuket",
        "pattaya",
        "thb",
        "baht",
        "บาท",
        "หุ้นไทย",
        "tfex",
        "泰国",
        "泰國",
    ),
    "VN": ("vietnam", "vietnamese", "việt nam", "hanoi", "hồ chí minh", "saigon", "vnd", "越南"),
    "PH": ("philippines", "philippine", "filipino", "pinoy", "manila", "cebu", "php", "peso", "菲律宾", "菲律賓"),
    "TW": ("taiwan", "taipei", "kaohsiung", "twd", "台股", "台湾", "台灣"),
    "HK": ("hong kong", "hongkong", "hkd", "港股", "香港"),
    "JP": ("japan", "japanese", "tokyo", "osaka", "jpy", "nikkei", "日本", "日股"),
    "KR": ("korea", "korean", "seoul", "krw", "kospi", "韩国", "韓國"),
    "IN": ("india", "indian", "mumbai", "delhi", "bangalore", "inr", "nifty", "sensex", "印度"),
    "AE": ("dubai", "uae", "abu dhabi", "emirates", "aed", "迪拜", "阿联酋"),
    "AU": ("australia", "australian", "sydney", "melbourne", "aud", "asx", "澳洲", "澳大利亚"),
    "US": ("united states", "usa", "america", "new york", "nasdaq", "nyse", "wall street", "美国", "美國", "美股"),
    "GB": ("united kingdom", "uk", "britain", "england", "london", "gbp", "ftse", "英国", "英國"),
    "DE": ("germany", "german", "berlin", "frankfurt", "dax", "德国", "德國"),
    "FR": ("france", "french", "paris", "cac40", "法国", "法國"),
    "BR": ("brazil", "brazilian", "brasil", "sao paulo", "brl", "bovespa", "巴西"),
    "RU": ("russia", "russian", "moscow", "москва", "россия", "rub", "俄罗斯", "俄羅斯"),
}

#: 跨国冲突强证据：目标国未命中但明确命中其他国家独有特征时扣分，防止马来语/英文把印尼/印度/欧美群混进来。
REGION_CONFLICT_ANCHORS: dict[str, tuple[str, ...]] = {
    "MY": ("malaysia", "malaysian", "kuala lumpur", "selangor", "johor", "penang", "ringgit", "klse", "马来西亚", "馬來西亞"),
    "SG": ("singapore", "singaporean", "新加坡"),
    "ID": ("indonesia", "indonesian", "jakarta", "surabaya", "bandung", "rupiah", "ihsg", "印尼", "印度尼西亚"),
    "TH": ("thailand", "thai", "bangkok", "ประเทศไทย", "กรุงเทพ", "ไทยแลนด์", "泰国", "泰國"),
    "VN": ("vietnam", "vietnamese", "việt nam", "hanoi", "saigon", "越南"),
    "PH": ("philippines", "filipino", "pinoy", "manila", "菲律宾"),
    "IN": ("india", "indian", "mumbai", "delhi", "nifty", "sensex", "印度"),
    "US": ("united states", "usa", "america", "nasdaq", "nyse", "美国", "美國"),
    "GB": ("united kingdom", "britain", "england", "london", "英国", "英國"),
    "AE": ("dubai", "uae", "abu dhabi", "迪拜", "阿联酋"),
}

#: 讨论意图词：群名/简介里出现这些词，才更像「讨论组」而不是频道。
INTENT_TERMS: tuple[str, ...] = (
    "group",
    "chat",
    "community",
    "discussion",
    "discuss",
    "talk",
    "forum",
    "club",
    "hub",
    "lounge",
    "กลุ่ม",
    "พูดคุย",
    "แชท",
    "คอมมูนิตี้",
    "สังคม",
    "ห้องคุย",
    "群",
    "交流",
    "讨论",
    "討論",
    "聊天",
    "社群",
    "kumpulan",
    "grup",
    "komunitas",
    "sembang",
    "diskusi",
    "nhóm",
    "cộng đồng",
    "thảo luận",
)

#: 明显垃圾/违规/纯广告频道化负向信号（用户自己搜索词里显式包含时除外）。
SPAM_NEGATIVE_TERMS: tuple[str, ...] = (
    "porn",
    "nsfw",
    "onlyfans",
    "18+",
    "casino",
    "slot gacor",
    "judi online",
    "togel",
    "carding",
    "guaranteed profit",
    "100% profit",
    "double your money",
    "airdrop bot",
    "channel backup",
    "mirror channel",
    "no chat",
    "admin only",
    "跑分",
    "接码",
    "买卖号",
    "兼职刷单",
    "色情",
    "网赌",
    "菠菜",
    "博彩",
    "广告招租",
    "互推频道",
)

#: 语言判断用的停用词/特征词。
SHARED_MS_ID_STOPWORDS = frozenset(
    "dan yang untuk dengan ini itu kami kita anda ada dari pada akan di ke "
    "saham emas modal belajar".split()
)
MALAY_LEXICAL = frozenset(
    "kumpulan pelaburan boleh tak saya awak korang sembang kelas ringgit myr bursa klse".split()
)
MALAY_GEO = frozenset("malaysia malaysian selangor johor penang sabah sarawak".split())
MALAY_MARKERS = MALAY_LEXICAL | MALAY_GEO
INDONESIAN_LEXICAL = frozenset(
    "komunitas grup cuan bisa tidak rupiah idr ihsg gratis aja banget buat gabung yuk "
    "diskusi investasi harian pemula".split()
)
INDONESIAN_GEO = frozenset("indonesia indonesian jakarta surabaya bandung".split())
INDONESIAN_MARKERS = INDONESIAN_LEXICAL | INDONESIAN_GEO
MALAY_STOPWORDS = SHARED_MS_ID_STOPWORDS | MALAY_MARKERS
EN_STOPWORDS = frozenset("the and for with this that you your our from have will about are all".split())
EN_COMMON_WORDS = frozenset(
    "group chat community discussion discuss talk forum club hub channel official "
    "trading trade trader traders forex gold signal signals market markets daily "
    "news vip free share learn investment investing crypto stocks analysis price "
    "live global world pro team zone network".split()
)

_THAI_RE = re.compile(r"[\u0e00-\u0e7f]")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_JP_KANA_RE = re.compile(r"[\u3040-\u30ff]")
_KR_HANGUL_RE = re.compile(r"[\uac00-\ud7af\u1100-\u11ff]")
_CYRILLIC_RE = re.compile(r"[\u0400-\u04ff]")
_ARABIC_RE = re.compile(r"[\u0600-\u06ff]")
_VI_RE = re.compile(r"[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]", re.I)
_WORD_RE = re.compile(r"[a-z0-9]+")


# ---------------------------------------------------------------- 文本


def normalize_text(text: str) -> str:
    """NFKC + 去零宽字符 + 折叠空白；泰文/中文不做分词，保留原串做子串匹配。"""

    value = unicodedata.normalize("NFKC", str(text or ""))
    value = value.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "").replace("\ufeff", "")
    return " ".join(value.split()).strip()


def _lower(text: str) -> str:
    return normalize_text(text).casefold()


def _username_tokens_text(username: Optional[str]) -> str:
    """把 @forex_malaysia_vip2 拆成空白分隔词，同时拆分驼峰。"""

    raw = str(username or "").strip().lstrip("@")
    if not raw:
        return ""
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"[_\d]+", " ", spaced)
    return normalize_text(spaced)


def detect_language(text: str) -> str:
    """轻量语言判断：先判非拉丁字符集与越南语，再区分印尼语/马来语/英语，不盲目兜底 en。"""

    value = normalize_text(text)
    if not value:
        return "unknown"
    thai = len(_THAI_RE.findall(value))
    kana = len(_JP_KANA_RE.findall(value))
    hangul = len(_KR_HANGUL_RE.findall(value))
    cjk = len(_CJK_RE.findall(value))
    cyrillic = len(_CYRILLIC_RE.findall(value))
    arabic = len(_ARABIC_RE.findall(value))
    letters = sum(1 for char in value if char.isalpha())

    if thai and thai * 2 >= max(letters, 1):
        return "th"
    if kana and (kana + cjk) * 2 >= max(letters, 1):
        return "ja"
    if hangul and hangul * 2 >= max(letters, 1):
        return "ko"
    if cjk and cjk * 2 >= max(letters, 1):
        return "zh"
    if cyrillic and cyrillic * 2 >= max(letters, 1):
        return "ru"
    if arabic and arabic * 2 >= max(letters, 1):
        return "ar"
    if len(_VI_RE.findall(value)) >= 2:
        return "vi"

    words = set(_WORD_RE.findall(value.casefold()))
    if not words:
        return "unknown"
    id_lex = len(words & INDONESIAN_LEXICAL)
    ms_lex = len(words & MALAY_LEXICAL)
    id_hits = len(words & INDONESIAN_MARKERS)
    ms_hits = len(words & MALAY_MARKERS)
    shared_hits = len(words & SHARED_MS_ID_STOPWORDS)
    en_stop_hits = len(words & EN_STOPWORDS)

    if id_lex >= 1 and ms_lex == 0 and en_stop_hits == 0:
        return "id"
    if ms_lex >= 1 and id_lex == 0 and en_stop_hits == 0:
        return "ms"
    if id_hits > ms_hits and (id_hits + shared_hits) >= 2 and (id_lex >= 1 or shared_hits >= 1):
        return "id"
    if (ms_hits + shared_hits) >= 2 and (ms_lex >= 1 or shared_hits >= 1):
        return "ms"
    if words & EN_STOPWORDS or words & EN_COMMON_WORDS:
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
    return topics


def _contains(text: str, term: str) -> bool:
    """英文按词边界，泰文/中文/日韩按子串；避免 "gold" 命中 "goldfish" 这类误伤。"""

    lowered = _lower(text)
    needle = _lower(term)
    if not needle:
        return False
    if (
        _THAI_RE.search(needle)
        or _CJK_RE.search(needle)
        or _JP_KANA_RE.search(needle)
        or _KR_HANGUL_RE.search(needle)
    ):
        return needle in lowered
    if " " in needle:
        return needle in lowered
    return re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", lowered) is not None


def _contains_username(username: Optional[str], term: str) -> bool:
    """在用户名里查词：优先按 _/数字/驼峰切词匹配；长度 >= 5 的长词容许无下划线粘连（如 forexmalaysia）。"""

    spaced = _username_tokens_text(username)
    if not spaced:
        return False
    if _contains(spaced, term):
        return True
    needle = re.sub(r"[^a-z0-9]", "", _lower(term))
    raw_user = re.sub(r"[^a-z0-9]", "", _lower(str(username or "").lstrip("@")))
    return len(needle) >= 5 and needle in raw_user


_REGION_STOP_TERMS: frozenset[str] = frozenset(
    word
    for terms in (*REGION_TERMS.values(), *REGION_CONFLICT_ANCHORS.values())
    for term in terms
    for word in (term.casefold(), *term.casefold().split())
)


def _keyword_tokens(raw_keywords: Sequence[str], *, country: Optional[str] = None) -> list[str]:
    """把多词关键词拆出纯主题子词，排除地区词和意图词，避免把国家名当主题重复加分。"""

    stop = EN_STOPWORDS | _REGION_STOP_TERMS | set(INTENT_TERMS) | {"channel", "telegram", "tg"}
    country_norm = _lower(country or "")
    if country_norm:
        stop = stop | {country_norm, *country_norm.split()}
    tokens: list[str] = []
    seen: set[str] = set()
    for kw in raw_keywords:
        lowered = _lower(kw)
        if not lowered:
            continue
        for part in lowered.split():
            if part in stop:
                continue
            min_len = 2 if (_CJK_RE.search(part) or _THAI_RE.search(part)) else 3
            if len(part) >= min_len and part not in seen:
                seen.add(part)
                tokens.append(part)
    return tokens


def region_evidence(
    text: str, country: Optional[str], *, username: Optional[str] = None
) -> tuple[bool, list[str]]:
    """目标国家的文本证据；返回 (是否命中, 命中的词)。"""

    code = str(country or "").strip().upper()
    if not code:
        return False, []
    terms = REGION_TERMS.get(code, (code.casefold(),))
    hits = [term for term in terms if _contains(text, term) or _contains_username(username, term)]
    return bool(hits), list(dict.fromkeys(hits))


def conflict_region_evidence(
    text: str, country: Optional[str], *, username: Optional[str] = None
) -> list[str]:
    """检测是否明确命中了「非目标国家」的强地理锚点。"""

    code = str(country or "").strip().upper()
    if not code:
        return []
    hits: list[str] = []
    for other_code, anchors in REGION_CONFLICT_ANCHORS.items():
        if other_code == code:
            continue
        for term in anchors:
            if _contains(text, term) or _contains_username(username, term):
                hits.append(term)
                break
    return list(dict.fromkeys(hits))


def spam_evidence(text: str, raw_keywords: Sequence[str]) -> list[str]:
    """命中明显广告/博彩/色情/死群提示词（用户显式搜索的词除外）。"""

    user_blob = " ".join(_lower(k) for k in raw_keywords)
    hits: list[str] = []
    for term in SPAM_NEGATIVE_TERMS:
        if term in user_blob:
            continue
        if _contains(text, term):
            hits.append(term)
    return list(dict.fromkeys(hits))


def topic_evidence(
    text: str, topics: Sequence[str], *, username: Optional[str] = None
) -> tuple[bool, list[str]]:
    hits: list[str] = []
    for topic in topics:
        for term in TOPIC_TERMS.get(topic, (topic,)):
            if _contains(text, term) or _contains_username(username, term):
                hits.append(term)
    return bool(hits), list(dict.fromkeys(hits))


def intent_evidence(text: str, *, username: Optional[str] = None) -> tuple[bool, list[str]]:
    hits = [term for term in INTENT_TERMS if _contains(text, term) or _contains_username(username, term)]
    return bool(hits), list(dict.fromkeys(hits))

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
    member_count: Optional[int] = None,
    message_hits: int = 0,
    activity: Optional[dict[str, Any]] = None,
    sources: Sequence[str] = (),
    source_counts: Optional[Mapping[str, int]] = None,
    joined: bool = False,
) -> ScoreResult:
    """按方案权重打分：名称/用户名 30 / 简介 25 / 地区 20 / 讨论意图 15 / 语言 10 + 质量/活跃度修正。"""

    title_text = normalize_text(title)
    about_text = normalize_text(about)
    user_text = _username_tokens_text(username)
    combined = f"{title_text}\n{about_text}"
    lang_sample = f"{title_text}\n{about_text}".strip() or user_text
    topics = canonical_topics(keywords)
    raw_keywords = [normalize_text(item) for item in keywords if normalize_text(item)]
    raw_tokens = _keyword_tokens(raw_keywords, country=country)

    title_topic, title_hits = topic_evidence(title_text, topics)
    user_topic, user_hits = topic_evidence("", topics, username=username)
    about_topic, about_hits = topic_evidence(about_text, topics)
    region_hit, region_hits = region_evidence(combined, country, username=username)
    conflict_hits = conflict_region_evidence(combined, country, username=username) if not region_hit else []
    intent_hit, intent_hits = intent_evidence(combined, username=username)

    language = detected_language or detect_language(lang_sample)
    target_languages = {str(item).casefold() for item in languages if str(item).strip()}

    # 名称（含用户名补充）：直接命中主题/用户词给 30，拆词命中给 24，仅用户名命中给 26/22。
    direct_title = any(_contains(title_text, kw) for kw in raw_keywords)
    token_title = any(_contains(title_text, tok) for tok in raw_tokens)
    direct_user = any(_contains_username(username, kw) for kw in raw_keywords)
    token_user = any(_contains_username(username, tok) for tok in raw_tokens)

    if title_topic or direct_title:
        name_score = 30
    elif token_title:
        name_score = 24
    elif user_topic or direct_user:
        name_score = 26
    elif token_user:
        name_score = 22
    else:
        name_score = 0

    direct_about = any(_contains(about_text, kw) for kw in raw_keywords)
    token_about = any(_contains(about_text, tok) for tok in raw_tokens)
    if about_topic or direct_about:
        about_score = 25
    elif token_about:
        about_score = 18
    else:
        about_score = 0

    if region_hit:
        region_score = 20
    elif conflict_hits:
        region_score = -20
    elif target_languages and language in target_languages:
        region_score = 8
    else:
        region_score = 0

    intent_score = 15 if intent_hit else 0
    if language in target_languages:
        language_score = 10
    elif language == "unknown":
        language_score = 4
    else:
        language_score = 0

    activity_info = activity if isinstance(activity, dict) else {}
    msg_kw_hits = int(activity_info.get("keyword_hits") or 0)
    total_msg_hits = max(0, int(message_hits or 0)) + max(0, msg_kw_hits)
    message_score = 0
    if total_msg_hits > 0:
        message_score = 20 if (name_score == 0 and about_score == 0) else 5

    # 质量/噪声修正：负向垃圾词 + 成员规模 + 真人活跃度
    spam_hits = spam_evidence(combined, raw_keywords)
    quality_score = -min(45, 25 * len(spam_hits)) if spam_hits else 0

    if member_count is not None and member_count > 0:
        if member_count < 15:
            quality_score -= 15
        elif member_count < 50:
            quality_score -= 5
        elif member_count >= 500:
            quality_score += 5

    recent_7d = int(activity_info.get("recent_7d") or 0)
    unique_senders = int(activity_info.get("unique_senders") or 0)
    ad_ratio = float(activity_info.get("ad_ratio") or 0.0)
    activity_checked = bool(activity_info.get("checked"))
    if activity_checked:
        if recent_7d == 0:
            quality_score -= 20
        elif recent_7d >= 5 and unique_senders >= 3 and ad_ratio < 0.6:
            quality_score += 8
        if recent_7d >= 4 and ad_ratio >= 0.75:
            quality_score -= 20

    # 名称/简介/用户名里出现用户原始关键词（包括本地语）时，补进命中词。
    matched = list(dict.fromkeys([*title_hits, *user_hits, *about_hits, *region_hits, *intent_hits]))
    for keyword in raw_keywords:
        if (_contains(combined, keyword) or _contains_username(username, keyword)) and keyword not in matched:
            matched.append(keyword)

    breakdown: dict[str, int] = {
        "name": name_score,
        "about": about_score,
        "region": region_score,
        "intent": intent_score,
        "language": language_score,
    }
    if message_score:
        breakdown["message"] = message_score
    if quality_score:
        breakdown["quality"] = quality_score

    trust_bonus, _tier, trust_reasons = compute_source_trust(
        sources,
        source_counts=source_counts,
        joined=joined,
    )
    if trust_bonus:
        breakdown["trust"] = trust_bonus

    score = max(0, min(100, sum(breakdown.values())))
    reasons: list[str] = []
    if title_topic or direct_title or token_title:
        reasons.append("名称命中主题词")
    elif user_topic or direct_user or token_user:
        reasons.append("用户名命中主题词")
    if about_topic or direct_about or token_about:
        reasons.append("简介命中主题词")
    if message_score:
        reasons.append("群内消息命中关键词")
    if region_hit:
        reasons.append(f"地区命中：{'/'.join(region_hits[:3])}")
    elif conflict_hits:
        reasons.append(f"地区冲突：命中非目标地区({'/'.join(conflict_hits[:2])})")
    elif region_score > 0:
        reasons.append("语言与目标地区一致")
    if intent_hit:
        reasons.append(f"讨论意图：{'/'.join(intent_hits[:3])}")
    if language_score == 0 and target_languages:
        reasons.append(f"语言不匹配：{language}")
    if spam_hits:
        reasons.append(f"命中噪声词：{'/'.join(spam_hits[:2])}")
    if member_count is not None and 0 < member_count < 15:
        reasons.append("成员数过少(<15)")
    elif member_count is not None and member_count >= 500:
        reasons.append(f"规模成熟({member_count}人)")
    if activity_checked:
        if recent_7d == 0:
            reasons.append("近7天无消息（疑似沉寂）")
        elif recent_7d >= 5 and unique_senders >= 3 and ad_ratio < 0.6:
            reasons.append(f"近期活跃（7天{recent_7d}条/{unique_senders}人）")
        if recent_7d >= 4 and ad_ratio >= 0.75:
            reasons.append(f"广告外链占比过高({int(ad_ratio * 100)}%)")
    reasons.extend(trust_reasons)

    topic = topics[0] if topics else None
    return ScoreResult(
        score=score,
        breakdown=breakdown,
        matched_keywords=matched,
        language=language,
        country=country if (region_hit or region_score > 0) else None,
        topic=topic,
        reasons=reasons,
    )


def classify(score: int, *, min_score: int = 60) -> str:
    """把分数映射成状态；min_score 是「保留」门槛（40..100），低于它但 ≥40 的进待确认。"""

    threshold = max(40, min(100, int(min_score)))
    if score >= threshold:
        return "accepted"
    if score >= 40:
        return "needs_review"
    return "rejected"
