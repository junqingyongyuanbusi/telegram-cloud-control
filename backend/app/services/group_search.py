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
        "cities": ("jakarta", "surabaya", "bandung"),
        "languages": ("id", "en"),
    },
    "TH": {
        "names": ("thailand",),
        "cities": ("bangkok", "chiang mai", "phuket"),
        "languages": ("th", "en"),
    },
}

# 主题别名只用于「主题词 + 地区」的扩展，不会替代原始关键词。
# 马来语/印尼语的 emas、saham 等词能显著提高本地群命中率。
TOPIC_ALIASES: dict[str, tuple[str, ...]] = {
    "forex": ("fx",),
    "trading": ("trade",),
    "gold": ("emas",),
    "stock": ("saham",),
    "stocks": ("saham",),
    "crypto": ("bitcoin",),
    "property": ("hartanah",),
    "jobs": ("kerja kosong",),
}

# 马来语本地词组：比「topic + malaysia」更像真实群名，命中率更高。
# 只在 MY 且允许 ms 时展开，避免把马来语词打到别的地区。
LOCAL_TOPIC_PHRASES: dict[str, tuple[str, ...]] = {
    "forex": ("signal forex", "kelas trading"),
    "trading": ("kelas trading", "signal forex"),
    "gold": ("pelaburan emas", "trading emas"),
    "stock": ("saham malaysia", "modal saham"),
    "stocks": ("saham malaysia", "modal saham"),
}

# 中文词组：马来西亚华人群常用中文命名，直接用中文主题词往往比英文更有效。
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
REGION_NAMES_ZH: dict[str, str] = {
    "MY": "马来西亚",
    "SG": "新加坡",
    "ID": "印度尼西亚",
    "TH": "泰国",
}

DEFAULT_LANGUAGES: tuple[str, ...] = ("en",)
MAX_QUERY_LEN = 64


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
) -> list[SearchQuery]:
    """把关键词展开成去重后的查询列表，原始关键词永远在最前面。

    - `regions` 为空：只返回原始关键词，行为与旧版一致；
    - `languages` 为空：使用地区预设语言；
    - `exclude`：绩效表里连续 0 产出、已自动停用的非基础查询；基础词仍保留，
      避免用户明确输入的关键词被系统静默丢掉；
    - 各关键词按候选顺序轮转取词，词多时不会让前几个词吃满全部预算。
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
        for code, profile in region_profiles:
            langs = language_override or {item.casefold() for item in profile["languages"]}
            region_name_zh = REGION_NAMES_ZH.get(code)
            topic_zh = TOPIC_NAMES_ZH.get(lowered)

            # 2. 主题词 + 地区名（每个关键词都先拿到，再进入城市）。
            for variant in variants[keyword]:
                for name in profile["names"][:2]:
                    push(keyword, f"{variant} {name}", "region", code)

            # 3. 主题词 + 城市（MY 城市已补到东马，全部跑；其他地区先取前 4 个）。
            city_list = profile["cities"] if code == "MY" else profile["cities"][:4]
            for variant in variants[keyword]:
                for city in city_list:
                    push(keyword, f"{variant} {city}", "city", code, "en")

            # 4. 马来语本地词组 + 本地词组 + 城市。
            if code == "MY" and "ms" in langs:
                for phrase in LOCAL_TOPIC_PHRASES.get(lowered, ())[:2]:
                    push(keyword, phrase, "local_phrase", code, "ms")
                    for city in profile["cities"][:2]:
                        push(keyword, f"{phrase} {city}", "local_phrase_city", code, "ms")

            # 5. 中文地区词组：马来西亚 外汇 / 股票 群。
            if "zh" in langs and topic_zh and region_name_zh:
                push(keyword, f"{region_name_zh} {topic_zh}", "zh_region", code, "zh")
                push(keyword, f"{region_name_zh} {topic_zh} 群", "zh_group", code, "zh")
                push(keyword, f"{topic_zh} 群", "zh_topic_group", code, "zh")

            # 6. 群组后缀：英文 group、马来语 kumpulan、中文 群。
            for variant in variants[keyword]:
                for name in profile["names"][:1]:
                    if "en" in langs:
                        push(keyword, f"{variant} {name} group", "suffix_en", code, "en")
                    if "ms" in langs:
                        push(keyword, f"kumpulan {variant} {name}", "suffix_ms", code, "ms")
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
