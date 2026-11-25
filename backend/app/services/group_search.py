"""关键词找群的查询扩展。

`contacts.Search` 没有 offset，也没有地区/语言参数，单次只会回一小批结果。
扩大召回不能靠把 `limit` 调大，只能靠「多组高区分度的查询」：

- 原始关键词永远排在最前，保证旧行为不退化；
- 有地区时，按「主题词 + 地区名 / 城市 / 群组后缀」展开，并补上常见主题别名；
- 查询去重、限长、限量，避免把 20 个词扩成几百个查询把账号打爆。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from app.services.group_precision import (
    INTENT_TERMS,
    _REGION_STOP_TERMS,
    canonical_topics,
    normalize_text,
)

# 地区词表：只放完整地名，不放 MY/SG 这种过短、容易误伤的代码。
# languages 是该地区值得尝试的群组后缀语言。
REGION_PROFILES: dict[str, dict[str, tuple[str, ...]]] = {
    "MY": {
        "names": ("malaysia",),
        "cities": (
            "kuala lumpur",
            "kl",
            "selangor",
            "johor",
            "penang",
            "sabah",
            "sarawak",
            "kota kinabalu",
            "kuching",
        ),
        "languages": ("ms", "en", "zh"),
    },
    "SG": {
        "names": ("singapore",),
        "cities": ("singapore", "jurong", "woodlands"),
        "languages": ("en", "zh", "ms"),
    },
    "ID": {
        "names": ("indonesia",),
        "cities": ("jakarta", "surabaya", "bandung", "medan", "bali"),
        "languages": ("id", "en"),
    },
    "TH": {
        # 泰语是主语言，地区名把 ไทย 放前面；英文 Thailand 仍保留。
        "names": ("ไทย", "thailand", "thai", "ประเทศไทย"),
        "cities": ("bangkok", "chiang mai", "phuket", "กรุงเทพ", "เชียงใหม่", "ภูเก็ต"),
        "languages": ("th", "en"),
    },
    "VN": {
        "names": ("vietnam", "việt nam"),
        "cities": ("hanoi", "ho chi minh", "saigon", "da nang"),
        "languages": ("vi", "en"),
    },
    "PH": {
        "names": ("philippines", "filipino"),
        "cities": ("manila", "cebu", "davao", "makati"),
        "languages": ("en",),
    },
    "TW": {
        "names": ("taiwan", "台灣", "台湾"),
        "cities": ("taipei", "kaohsiung", "taichung"),
        "languages": ("zh", "en"),
    },
    "HK": {
        "names": ("hong kong", "香港"),
        "cities": ("hong kong",),
        "languages": ("zh", "en"),
    },
    "JP": {
        "names": ("japan", "日本"),
        "cities": ("tokyo", "osaka", "yokohama"),
        "languages": ("ja", "en"),
    },
    "KR": {
        "names": ("korea", "한국", "韩国"),
        "cities": ("seoul", "busan"),
        "languages": ("ko", "en"),
    },
    "IN": {
        "names": ("india",),
        "cities": ("mumbai", "delhi", "bangalore", "hyderabad"),
        "languages": ("en",),
    },
    "AE": {
        "names": ("dubai", "uae"),
        "cities": ("dubai", "abu dhabi"),
        "languages": ("en", "ar"),
    },
    "AU": {
        "names": ("australia",),
        "cities": ("sydney", "melbourne", "brisbane"),
        "languages": ("en",),
    },
    "US": {
        "names": ("usa", "united states", "america"),
        "cities": ("new york", "los angeles", "chicago", "miami"),
        "languages": ("en",),
    },
    "GB": {
        "names": ("uk", "united kingdom", "london"),
        "cities": ("london", "manchester", "birmingham"),
        "languages": ("en",),
    },
    "DE": {
        "names": ("germany", "deutschland"),
        "cities": ("berlin", "frankfurt", "munich"),
        "languages": ("de", "en"),
    },
    "FR": {
        "names": ("france",),
        "cities": ("paris", "lyon"),
        "languages": ("fr", "en"),
    },
    "BR": {
        "names": ("brazil", "brasil"),
        "cities": ("sao paulo", "rio"),
        "languages": ("pt", "en"),
    },
    "RU": {
        "names": ("russia", "россия"),
        "cities": ("moscow", "москва"),
        "languages": ("ru", "en"),
    },
}

# 主题别名只用于「主题词 + 地区」的扩展，不会替代原始关键词。
# 马来语/印尼语的 emas、saham 等词能显著提高本地群命中率。
TOPIC_ALIASES: dict[str, tuple[str, ...]] = {
    "forex": ("fx",),
    "trading": ("trade",),
    "gold": ("emas", "xauusd"),
    "stock": ("saham", "bursa"),
    "stocks": ("saham", "bursa"),
    "crypto": ("bitcoin", "web3"),
    "property": ("hartanah",),
    "jobs": ("kerja kosong", "loker"),
}

# 马来语本地词组：比「topic + malaysia」更像真实群名，命中率更高。
# 只在 MY 且允许 ms 时展开，避免把马来语词打到别的地区。
LOCAL_TOPIC_PHRASES: dict[str, tuple[str, ...]] = {
    "forex": ("signal forex", "kelas trading"),
    "trading": ("kelas trading", "signal forex"),
    "gold": ("pelaburan emas", "trading emas"),
    "stock": ("saham malaysia", "modal saham"),
    "stocks": ("saham malaysia", "modal saham"),
    "crypto": ("kumpulan crypto", "pelaburan crypto"),
}

# 印尼本地词组：用于 ID 区域扩展。
ID_LOCAL_PHRASES: dict[str, tuple[str, ...]] = {
    "forex": ("komunitas forex", "grup forex", "belajar forex"),
    "trading": ("komunitas trading", "grup trader"),
    "gold": ("trading emas", "investasi emas"),
    "stock": ("komunitas saham", "grup saham"),
    "crypto": ("komunitas crypto", "grup kripto"),
}

# 中文词组：马来西亚/新加坡/港澳台华人群常用中文命名，直接用中文主题词往往比英文更有效。
TOPIC_NAMES_ZH: dict[str, str] = {
    "forex": "外汇",
    "trading": "交易",
    "gold": "黄金",
    "stock": "股票",
    "stocks": "股票",
    "crypto": "加密货币",
    "property": "房产",
    "jobs": "招聘",
}
# 泰语主题词：泰国群名常用「กลุ่ม + 主题」「พูดคุย + 主题」，不像英文那样用空格分隔。
TOPIC_NAMES_TH: dict[str, str] = {
    "forex": "ฟอเร็กซ์",
    "trading": "เทรด",
    "gold": "ทองคำ",
    "stock": "หุ้น",
    "stocks": "หุ้น",
    "crypto": "คริปโต",
    "property": "อสังหา",
    "jobs": "รับสมัครงาน",
}
REGION_NAMES_ZH: dict[str, str] = {
    "MY": "马来西亚",
    "SG": "新加坡",
    "ID": "印度尼西亚",
    "TH": "泰国",
    "VN": "越南",
    "PH": "菲律宾",
    "TW": "台湾",
    "HK": "香港",
    "JP": "日本",
    "KR": "韩国",
    "IN": "印度",
    "AE": "迪拜",
    "AU": "澳洲",
    "US": "美国",
    "GB": "英国",
}

DEFAULT_LANGUAGES: tuple[str, ...] = ("en",)
MAX_QUERY_LEN = 64

# 短核心词：不依赖用户输入的长尾词，直接打 Telegram 公开搜索里命中率最高的一批词。
# 长尾词（如 "Forex Thailand signal group"）经常因为所有词都要命中而整条落空；
# 短词召回更宽，再交给类型/权限/评分层过滤。顺序按经验命中率排列。
SHORT_QUERIES: dict[str, tuple[str, ...]] = {
    "global": (
        "forex",
        "forex trading",
        "forex signals",
        "forex community",
        "trading",
        "trading community",
        "trading signals",
        "trader",
        "gold",
        "gold trading",
        "xauusd",
        "gold signals",
        "xauusd signals",
        "signal",
    ),
    "TH": (
        "เทรด",
        "ทองคำ",
        "ทอง",
        "ฟอเร็กซ์",
        "กลุ่มเทรด",
        "แชทเทรด",
        "คุยเทรด",
        "ห้องเทรด",
        "ห้องแชทเทรด",
        "นักเทรด",
        "เทรดเดอร์",
        "สัญญาณ",
        "เทรดทอง",
        "เทรดทองคำ",
        "วิเคราะห์ทอง",
        "วิเคราะห์ทองคำ",
        "สอนเทรด",
        "ตลาดทุน",
        "ตลาดทองคำ",
        "ลงทุน",
        "กลุ่มลงทุน",
        "กรุ๊ปเทรด",
        "กรุ๊ป Forex",
        "กลุ่มฟอเร็กซ์",
        "คอมมูนิตี้เทรด",
        "นักลงทุนไทย",
        "หุ้นไทย",
        "ลงทุนหุ้น",
        "TFEX",
        "YLG",
        "Ausiris",
        "MTS Gold",
        "Hua Seng Heng",
        "XM Thailand",
        "Exness ไทย",
        "Mitrade Thailand",
        "Gold Online Thailand",
        "forex thai",
        "forex ไทย",
    ),
    "MY": (
        "forex malaysia",
        "forex malaysia group",
        "trading malaysia",
        "gold malaysia",
        "saham malaysia",
        "pelaburan emas",
        "trading emas",
        "signal forex",
        "kelas trading",
        "modal saham",
        "komuniti trader",
        "kumpulan forex",
        "马来西亚 外汇",
        "马来西亚 股票",
        "外汇 群",
        "股票 群",
    ),
    "SG": ("forex singapore", "trading singapore", "gold singapore", "forex singapore group"),
    "ID": ("forex indonesia", "trading indonesia", "gold indonesia", "komunitas forex", "grup forex"),
}

# 这些短词只用于扩大召回，不参与「自动停用」判断；也不替换用户原始关键词。
SHORT_QUERY_TEMPLATE = "short_core"


def _build_custom_short_queries(
    keywords: Sequence[str], region_codes: set[str]
) -> list[str]:
    """当用户关键词不在内置金融词典里时，基于用户自身词生成短核心查询，避免跑偏到 forex/gold。"""

    region_stop = _REGION_STOP_TERMS | {code.casefold() for code in region_codes} | {
        name.casefold()
        for code in region_codes
        for name in (
            *(REGION_PROFILES.get(code, {}).get("names", ())),
            *(REGION_PROFILES.get(code, {}).get("cities", ())),
            REGION_NAMES_ZH.get(code, ""),
        )
        if name
    }
    stop = region_stop | set(INTENT_TERMS) | {"channel", "telegram", "tg", "交流群"}

    candidates: list[str] = []
    for raw_kw in keywords:
        tokens = [
            part
            for part in normalize_text(raw_kw).split()
            if part.casefold() not in stop
        ]
        core = " ".join(tokens).strip() or normalize_text(raw_kw)
        if core.casefold() != normalize_text(raw_kw).casefold():
            candidates.append(core)
        for code in sorted(region_codes):
            profile = REGION_PROFILES.get(code)
            if profile and profile.get("names"):
                candidates.append(f"{core} {profile['names'][0]}")
            zh_region = REGION_NAMES_ZH.get(code)
            if zh_region and zh_region not in core:
                candidates.append(f"{zh_region} {core}")
        candidates.extend([f"{core} group", f"{core} chat", f"{core} 群"])
        if "TH" in region_codes:
            candidates.append(f"กลุ่ม {core}")
    return candidates


def build_short_queries(
    keywords: Iterable[str],
    *,
    regions: Sequence[str] = (),
    limit: int = 60,
    strict_topic: bool = False,
) -> list[SearchQuery]:
    """生成短核心词查询，按地区追加本地词；去重并避开用户已输入的关键词。

    - `strict_topic=False`（默认）：兼容传统兜底行为；
    - `strict_topic=True`：严格按用户关键词所属主题过滤 `SHORT_QUERIES`，避免搜 crypto/开卡 时
      误发 forex/gold 词条。
    """

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in keywords:
        text = _clean(item)
        key = _dedupe_key(text)
        if text and key not in seen:
            seen.add(key)
            cleaned.append(text)

    try:
        cap = int(limit)
    except (TypeError, ValueError):
        cap = 30
    cap = max(0, min(cap, 80))
    if not cap:
        return []

    region_codes = {_clean(item).upper() for item in regions if _clean(item)}
    region_terms: list[str] = []
    for code in ("TH", "MY", "SG", "ID"):
        if code in region_codes:
            region_terms.extend(SHORT_QUERIES[code])
    if region_terms:
        ordered = [*region_terms, *SHORT_QUERIES["global"]]
    else:
        ordered = list(SHORT_QUERIES["global"])

    if strict_topic and cleaned:
        user_topics = set(canonical_topics(cleaned))
        if user_topics:
            filtered = [
                q
                for q in ordered
                if set(canonical_topics([q])) & user_topics
            ]
            ordered = [*filtered, *_build_custom_short_queries(cleaned, region_codes)]
        else:
            ordered = _build_custom_short_queries(cleaned, region_codes)

    result: list[SearchQuery] = []
    seen_queries: set[str] = set()
    for query in ordered:
        text = _clean(query)
        key = _dedupe_key(text)
        if not text or key in seen or key in seen_queries or len(result) >= cap:
            continue
        seen_queries.add(key)
        keyword = next(
            (item for item in cleaned if _dedupe_key(item) in key or key in _dedupe_key(item)),
            cleaned[0] if cleaned else text,
        )
        result.append(
            SearchQuery(
                query=text,
                keyword=keyword,
                template=SHORT_QUERY_TEMPLATE,
                region=next((code for code in region_codes if code in ("TH", "MY", "SG", "ID")), None),
                lang="th" if any("\u0e00" <= char <= "\u0e7f" for char in text) else None,
            )
        )
    return result


@dataclass(frozen=True)
class SearchQuery:
    """一条待执行的 Telegram 搜索查询。"""

    query: str
    keyword: str
    template: str
    region: str | None = None
    lang: str | None = None


def _clean(text: str) -> str:
    return " ".join(str(text or "").split())


def _dedupe_key(text: str) -> str:
    return _clean(text).casefold()


def _topic_variants(keyword: str) -> list[str]:
    """原始主题词 + 最多两个别名，避免一个词扩出太多组合。"""

    variants = [keyword]
    lowered = keyword.casefold()
    for canonical, aliases in TOPIC_ALIASES.items():
        if lowered == canonical or lowered in {item.casefold() for item in aliases}:
            for alias in (canonical, *aliases):
                if alias.casefold() != lowered and alias not in variants:
                    variants.append(alias)
            break
    return variants[:3]


def _normalized_regions(regions: Sequence[str]) -> list[tuple[str, dict[str, tuple[str, ...]]]]:
    normalized: list[tuple[str, dict[str, tuple[str, ...]]]] = []
    seen: set[str] = set()
    for raw in regions:
        code = _clean(raw).upper()
        if not code or code in seen:
            continue
        seen.add(code)
        profile = REGION_PROFILES.get(code)
        if profile is None:
            # 没内置的地区按用户输入原样使用，至少保证「主题词 + 地名」可跑。
            profile = {"names": (code.casefold(),), "cities": (), "languages": DEFAULT_LANGUAGES}
        normalized.append((code, profile))
    return normalized


def expand_queries(
    keywords: Iterable[str],
    *,
    regions: Sequence[str] = (),
    languages: Sequence[str] = (),
    max_queries: int = 120,
    exclude: Sequence[str] = (),
    extra_queries: Sequence[str] = (),
) -> list[SearchQuery]:
    """把关键词展开成去重后的查询列表，原始关键词永远在最前面。

    - `regions` 为空：只返回原始关键词（以及 `extra_queries`），行为与旧版一致；
    - `languages` 为空：使用地区预设语言；
    - `exclude`：绩效表里连续 0 产出、已自动停用的非基础查询；基础词仍保留；
    - `extra_queries`：可选 AI 扩词等补充查询，放在基础词之后、扩展矩阵之前或协同进入预算。
    """

    cleaned_keywords: list[str] = []
    seen_keywords: set[str] = set()
    for item in keywords:
        text = _clean(item)
        key = _dedupe_key(text)
        if text and key not in seen_keywords:
            seen_keywords.add(key)
            cleaned_keywords.append(text)
    if not cleaned_keywords:
        return []

    try:
        limit = int(max_queries)
    except (TypeError, ValueError):
        limit = 120
    limit = max(1, min(limit, 300))

    queries: list[SearchQuery] = []
    seen_queries: set[str] = set()
    excluded = {_dedupe_key(item) for item in exclude if _clean(item)}

    def add(
        query: str,
        *,
        keyword: str,
        template: str,
        region: str | None = None,
        lang: str | None = None,
    ) -> None:
        text = _clean(query)
        if not text or len(text) > MAX_QUERY_LEN:
            return
        key = _dedupe_key(text)
        # 用户手输的基础词是兜底，不参与自动停用。
        if template != "base" and key in excluded:
            return
        if key in seen_queries or len(queries) >= limit:
            return
        seen_queries.add(key)
        queries.append(SearchQuery(query=text, keyword=keyword, template=template, region=region, lang=lang))

    # 1. 原始关键词（含旧版直接输入的长尾词）永远先跑。
    for keyword in cleaned_keywords:
        add(keyword, keyword=keyword, template="base")

    for extra in extra_queries:
        add(extra, keyword=cleaned_keywords[0], template="ai_expand")

    region_profiles = _normalized_regions(regions)
    if not region_profiles or len(queries) >= limit:
        return queries

    language_override = {_clean(item).casefold() for item in languages if _clean(item)}
    variants = {keyword: _topic_variants(keyword) for keyword in cleaned_keywords}

    # 先按关键词分桶，再轮转合并；这样 20 个词时每个词都能拿到地区/本地词，
    # 而不是前 3 个词吃满 120 条预算、后面的词只剩原始查询。
    buckets: dict[str, list[tuple[str, str, str | None, str | None]]] = {keyword: [] for keyword in cleaned_keywords}

    def push(
        keyword: str,
        query: str,
        template: str,
        region: str | None = None,
        lang: str | None = None,
    ) -> None:
        text = _clean(query)
        if text and len(text) <= MAX_QUERY_LEN:
            buckets[keyword].append((text, template, region, lang))

    for keyword in cleaned_keywords:
        lowered = keyword.casefold()
        canonical_list = canonical_topics([keyword])
        canonical = canonical_list[0] if canonical_list else ""
        topic_key = lowered if lowered in TOPIC_NAMES_ZH else canonical

        for code, profile in region_profiles:
            langs = language_override or {item.casefold() for item in profile["languages"]}
            region_name_zh = REGION_NAMES_ZH.get(code)
            topic_zh = TOPIC_NAMES_ZH.get(topic_key)
            topic_th = TOPIC_NAMES_TH.get(topic_key)

            # 2. 主题词 + 地区名（每个关键词都先拿到，再进入城市）。
            for variant in variants[keyword]:
                for name in profile["names"][:2]:
                    push(keyword, f"{variant} {name}", "region", code)

            # 3. 主题词 + 城市（MY 城市已补到东马，全部跑；其他地区先取前 4 个）。
            city_list = profile["cities"] if code in {"MY", "TH"} else profile["cities"][:4]
            for variant in variants[keyword]:
                for city in city_list:
                    push(keyword, f"{variant} {city}", "city", code, "en")

            # 4. 马来语本地词组 + 本地词组 + 城市。
            if code == "MY" and "ms" in langs:
                for phrase in LOCAL_TOPIC_PHRASES.get(topic_key, ())[:2]:
                    push(keyword, phrase, "local_phrase", code, "ms")
                    for city in profile["cities"][:2]:
                        push(keyword, f"{phrase} {city}", "local_phrase_city", code, "ms")

            # 4.5 印尼本地词组。
            if code == "ID" and "id" in langs:
                for phrase in ID_LOCAL_PHRASES.get(topic_key, ())[:3]:
                    push(keyword, phrase, "local_phrase", code, "id")
                    for city in profile["cities"][:2]:
                        push(keyword, f"{phrase} {city}", "local_phrase_city", code, "id")

            # 5. 中文地区词组：马来西亚 外汇 / 股票 群（非内置主题也生成地区+原词组合，避免重复地名）。
            if "zh" in langs and region_name_zh:
                zh_core = topic_zh or keyword
                if region_name_zh not in zh_core:
                    push(keyword, f"{region_name_zh} {zh_core}", "zh_region", code, "zh")
                    push(keyword, f"{region_name_zh} {zh_core} 群", "zh_group", code, "zh")
                else:
                    push(keyword, f"{zh_core} 群", "zh_group", code, "zh")
                if topic_zh:
                    push(keyword, f"{topic_zh} 群", "zh_topic_group", code, "zh")

            # 5.5 泰语词组：กลุ่มเทรด Forex / พูดคุย Forex / Forex ไทย。
            if code == "TH" and "th" in langs:
                for variant in variants[keyword]:
                    if topic_th:
                        push(keyword, f"กลุ่ม{topic_th}", "th_group", code, "th")
                        push(keyword, f"พูดคุย {topic_th}", "th_chat", code, "th")
                        push(keyword, f"{topic_th} ไทย", "th_region", code, "th")
                    push(keyword, f"กลุ่ม {variant}", "th_group", code, "th")
                    push(keyword, f"พูดคุย {variant}", "th_chat", code, "th")

            # 6. 群组后缀：英文 group、马来语 kumpulan、印尼语 grup/komunitas、越南语 nhóm、中文 群。
            for variant in variants[keyword]:
                for name in profile["names"][:1]:
                    if "en" in langs:
                        push(keyword, f"{variant} {name} group", "suffix_en", code, "en")
                    if "ms" in langs:
                        push(keyword, f"kumpulan {variant} {name}", "suffix_ms", code, "ms")
                    if "id" in langs:
                        push(keyword, f"grup {variant} {name}", "suffix_id", code, "id")
                        push(keyword, f"komunitas {variant} {name}", "suffix_id", code, "id")
                    if "vi" in langs:
                        push(keyword, f"nhóm {variant} {name}", "suffix_vi", code, "vi")
                    if "zh" in langs:
                        push(keyword, f"{variant} {name} 群", "suffix_zh", code, "zh")

            # 7. 英文长尾：topic malaysia telegram。
            if "en" in langs:
                for variant in variants[keyword]:
                    push(keyword, f"{variant} telegram", "telegram", code, "en")
                    for name in profile["names"][:1]:
                        push(keyword, f"{variant} {name} telegram", "telegram_region", code, "en")

    # 轮转：第 1 轮每个词取第 1 条候选，第 2 轮取第 2 条……
    depth = max((len(bucket) for bucket in buckets.values()), default=0)
    for index in range(depth):
        for keyword in cleaned_keywords:
            if len(queries) >= limit:
                return queries
            bucket = buckets[keyword]
            if index < len(bucket):
                query, template, region, lang = bucket[index]
                add(query, keyword=keyword, template=template, region=region, lang=lang)

    return queries
