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
        "cities": ("kuala lumpur", "kl", "selangor", "johor", "penang"),
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
) -> list[SearchQuery]:
    """把关键词展开成去重后的查询列表，原始关键词永远在最前面。

    - `regions` 为空：只返回原始关键词，行为与旧版一致；
    - `languages` 为空：使用地区预设语言；
    - 所有查询统一小写去重（Telegram 搜索本身不区分大小写）。
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

    # 2. 主题词 + 地区名（每个关键词都先拿到，再进入城市）。
    for keyword in cleaned_keywords:
        for code, profile in region_profiles:
            for variant in variants[keyword]:
                for name in profile["names"][:2]:
                    add(f"{variant} {name}", keyword=keyword, template="region", region=code)

    # 3. 主题词 + 前三个城市。
    for keyword in cleaned_keywords:
        for code, profile in region_profiles:
            for variant in variants[keyword]:
                for city in profile["cities"][:3]:
                    add(f"{variant} {city}", keyword=keyword, template="city", region=code)

    # 4. 群组后缀：英文 group、马来语 kumpulan、中文 群。
    for keyword in cleaned_keywords:
        for code, profile in region_profiles:
            langs = language_override or {item.casefold() for item in profile["languages"]}
            for variant in variants[keyword]:
                for name in profile["names"][:1]:
                    if "en" in langs:
                        add(f"{variant} {name} group", keyword=keyword, template="suffix_en", region=code, lang="en")
                    if "ms" in langs:
                        add(f"kumpulan {variant} {name}", keyword=keyword, template="suffix_ms", region=code, lang="ms")
                    if "zh" in langs:
                        add(f"{variant} {name} 群", keyword=keyword, template="suffix_zh", region=code, lang="zh")

    return queries
