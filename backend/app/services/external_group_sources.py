"""可插拔外部公开群候选适配器：搜索引擎 / 公开目录 / 运营种子清单。

严格边界：外部适配器只做一件事——提取公开 `t.me/username` 与私群 `t.me/+invite_hash`，
**绝不**跳过 Telegram 实体验证（ResolveUsername / CheckChatInvite / GetFullChannel / 评分）。
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, Sequence
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.services.group_discovery import ExtractedLink, LinkKind, extract_links
from app.services.group_sources import SearchSource

logger = logging.getLogger(__name__)


def validate_external_url(value: str) -> tuple[bool, str]:
    """Reject malformed and local-network URLs before an outbound request."""

    try:
        parsed = urlparse(str(value or "").strip())
    except ValueError:
        return False, "URL 解析失败"
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False, "仅允许带主机名的 http/https URL"
    host = parsed.hostname.rstrip(".").casefold()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".local", ".internal")):
        return False, "禁止访问本地主机名"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and (
        address.is_private or address.is_loopback or address.is_link_local or address.is_reserved
    ):
        return False, "禁止访问私网、回环、链路本地或保留地址"
    return True, ""


def _safe_url(value: str, *, label: str) -> tuple[str | None, str | None]:
    ok, reason = validate_external_url(value)
    if not ok:
        return None, f"{label} URL 已跳过：{reason}"
    return str(value).strip(), None


@dataclass(frozen=True)
class ExternalCandidateHit:
    """外部源提取到的单条公开/邀请链接候选与来源上下文。"""

    kind: LinkKind
    value: str
    url: str
    adapter: str
    query: str
    source: str = SearchSource.EXTERNAL_WEB.value
    title_hint: str = ""
    snippet: str = ""


@dataclass
class ExternalFetchResult:
    """一轮外部候选召回汇总。"""

    links: list[ExtractedLink] = field(default_factory=list)
    hits: list[ExternalCandidateHit] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    errors: int = 0
    queries_run: int = 0


class ExternalSourceAdapter(Protocol):
    """外部候选源适配器协议（便于按配置插拔与替换）。"""

    name: str

    async def fetch(
        self,
        client: httpx.AsyncClient,
        keywords: Sequence[str],
        *,
        country: Optional[str],
        per_keyword: int,
        allow_paid: bool,
    ) -> tuple[list[ExternalCandidateHit], list[str], int, int]: ...


def _collect_strings(obj: Any, bucket: list[str], *, depth: int = 0) -> None:
    if depth > 5 or len(bucket) >= 400 or obj is None:
        return
    if isinstance(obj, str):
        stripped = obj.strip()
        if stripped:
            bucket.append(stripped)
        return
    if isinstance(obj, dict):
        for val in obj.values():
            _collect_strings(val, bucket, depth=depth + 1)
        return
    if isinstance(obj, list):
        for item in obj[:100]:
            _collect_strings(item, bucket, depth=depth + 1)


def _hits_from_texts(
    texts: Sequence[str],
    *,
    adapter: str,
    query: str,
    limit: int,
    title_hint: str = "",
) -> list[ExternalCandidateHit]:
    links = extract_links(texts, limit=max(1, limit))
    return [
        ExternalCandidateHit(
            kind=link.kind,
            value=link.value,
            url=link.url,
            adapter=adapter,
            query=query,
            source=SearchSource.EXTERNAL_WEB.value,
            title_hint=title_hint[:200],
        )
        for link in links
    ]


class SearchEngineAdapter:
    """通过可配置的 Web Search API 执行 `site:t.me <关键词>` 查询。"""

    name = "search_engine"

    async def fetch(
        self,
        client: httpx.AsyncClient,
        keywords: Sequence[str],
        *,
        country: Optional[str],
        per_keyword: int,
        allow_paid: bool,
    ) -> tuple[list[ExternalCandidateHit], list[str], int, int]:
        provider = str(settings.external_search_engine_provider or "").strip().lower()
        api_key = str(settings.external_search_engine_api_key or "").strip()
        configured_base_url = str(settings.external_search_engine_base_url or "").strip()
        base_url = configured_base_url
        if configured_base_url:
            base_url, url_note = _safe_url(configured_base_url, label="外部搜索引擎")
            if url_note:
                return [], [url_note], 0, 0
        if not provider:
            return [], [], 0, 0
        if provider not in {"serper", "brave", "custom_json"}:
            return [], [f"不支持的外部搜索引擎 provider={provider}（仅支持 serper/brave/custom_json）"], 0, 0
        if provider in {"serper", "brave"} and not api_key:
            return [], [f"外部搜索引擎({provider})未配置 API Key，已跳过网页检索"], 0, 0
        if provider == "custom_json" and not base_url:
            return [], ["外部搜索引擎(custom_json)未配置 BASE_URL，已跳过网页检索"], 0, 0
        if not allow_paid and api_key:
            return [], [f"外部搜索引擎({provider})需要开启「允许外部付费查询」才执行"], 0, 0

        hits: list[ExternalCandidateHit] = []
        notes: list[str] = []
        errors = 0
        queries_sent = 0
        region_hint = f" {country}" if country else ""
        for kw in keywords:
            q = f'site:t.me "{kw}"{region_hint}' if " " in kw else f"site:t.me {kw}{region_hint}"
            queries_sent += 1
            try:
                texts: list[str] = []
                if provider == "serper":
                    url = base_url or "https://google.serper.dev/search"
                    resp = await client.post(
                        url,
                        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                        json={"q": q, "num": min(max(per_keyword, 5), 20)},
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    for item in data.get("organic") or []:
                        texts.extend(
                            [str(item.get("link") or ""), str(item.get("title") or ""), str(item.get("snippet") or "")]
                        )
                elif provider == "brave":
                    url = base_url or "https://api.search.brave.com/res/v1/web/search"
                    resp = await client.get(
                        url,
                        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
                        params={"q": q, "count": min(max(per_keyword, 5), 20)},
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    for item in ((data.get("web") or {}).get("results") or []):
                        texts.extend(
                            [
                                str(item.get("url") or ""),
                                str(item.get("title") or ""),
                                str(item.get("description") or ""),
                            ]
                        )
                else:
                    headers = {"Accept": "application/json"}
                    if api_key:
                        headers["Authorization"] = f"Bearer {api_key}"
                    resp = await client.get(
                        base_url,
                        headers=headers,
                        params={"q": q, "country": country or "", "limit": per_keyword},
                    )
                    resp.raise_for_status()
                    _collect_strings(resp.json(), texts)
                hits.extend(_hits_from_texts(texts, adapter=self.name, query=q, limit=per_keyword))
            except Exception as exc:  # noqa: BLE001 - 外部接口异常不阻断主流程
                errors += 1
                logger.debug("外部搜索引擎查询失败 provider=%s query=%s: %s", provider, q, exc)
                notes.append(f"外部搜索引擎查询失败({type(exc).__name__})")
        return hits, notes, errors, queries_sent


class DirectoryAdapter:
    """可插拔 Telegram 公开目录接口适配器（不硬编码特定三方站点）。"""

    name = "directory"

    async def fetch(
        self,
        client: httpx.AsyncClient,
        keywords: Sequence[str],
        *,
        country: Optional[str],
        per_keyword: int,
        allow_paid: bool,
    ) -> tuple[list[ExternalCandidateHit], list[str], int, int]:
        provider = str(settings.external_search_directory_provider or "").strip().lower()
        configured_base_url = str(settings.external_search_directory_base_url or "").strip()
        base_url = configured_base_url
        if configured_base_url:
            base_url, url_note = _safe_url(configured_base_url, label="外部目录")
            if url_note:
                return [], [url_note], 0, 0
        api_key = str(settings.external_search_directory_api_key or "").strip()
        if not provider and not base_url:
            return [], [], 0, 0
        if not base_url:
            return [], ["公开目录适配器缺少 BASE_URL，已跳过"], 0, 0
        if not allow_paid and api_key:
            return [], ["外部公开目录接口需要开启「允许外部付费查询」才执行"], 0, 0

        hits: list[ExternalCandidateHit] = []
        notes: list[str] = []
        errors = 0
        queries_sent = 0
        headers: dict[str, str] = {"Accept": "application/json, text/html"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        for kw in keywords:
            queries_sent += 1
            try:
                resp = await client.get(
                    base_url,
                    headers=headers,
                    params={"q": kw, "country": country or "", "limit": per_keyword},
                )
                resp.raise_for_status()
                ctype = (resp.headers.get("content-type") or "").lower()
                texts: list[str] = []
                if "json" in ctype:
                    _collect_strings(resp.json(), texts)
                else:
                    texts.append(resp.text)
                hits.extend(_hits_from_texts(texts, adapter=self.name, query=kw, limit=per_keyword))
            except Exception as exc:  # noqa: BLE001
                errors += 1
                logger.debug("公开目录抓取失败 url=%s kw=%s: %s", base_url, kw, exc)
                notes.append(f"公开目录接口失败({type(exc).__name__})")
        return hits, notes, errors, queries_sent


class SeedManifestAdapter:
    """运营维护的公开种子页 / 清单 URL 适配器（只提 t.me 链接，无需付费 API Key）。"""

    name = "seed_manifest"

    async def fetch(
        self,
        client: httpx.AsyncClient,
        keywords: Sequence[str],
        *,
        country: Optional[str],
        per_keyword: int,
        allow_paid: bool,
    ) -> tuple[list[ExternalCandidateHit], list[str], int, int]:
        del country, allow_paid
        raw_urls = str(settings.external_search_seed_urls or "").strip()
        if not raw_urls:
            return [], [], 0, 0
        urls: list[str] = []
        notes: list[str] = []
        for raw_url in raw_urls.split(","):
            value = raw_url.strip()
            if not value.startswith(("http://", "https://")):
                continue
            safe_url, url_note = _safe_url(value, label="外部种子清单")
            if safe_url:
                urls.append(safe_url)
            elif url_note:
                notes.append(url_note)
        if not urls:
            return [], notes, 0, 0

        hits: list[ExternalCandidateHit] = []
        errors = 0
        queries_sent = 0
        query_label = ", ".join(keywords[:3])
        cap = max(per_keyword * max(len(keywords), 1), 20)
        for seed_url in urls:
            queries_sent += 1
            try:
                resp = await client.get(seed_url)
                resp.raise_for_status()
                hits.extend(
                    _hits_from_texts([resp.text], adapter=self.name, query=query_label or seed_url, limit=cap)
                )
            except Exception as exc:  # noqa: BLE001
                errors += 1
                logger.debug("种子清单抓取失败 url=%s: %s", seed_url, exc)
                notes.append(f"种子清单抓取失败({type(exc).__name__})")
        return hits, notes, errors, queries_sent


DEFAULT_EXTERNAL_ADAPTERS: tuple[ExternalSourceAdapter, ...] = (
    SearchEngineAdapter(),
    DirectoryAdapter(),
    SeedManifestAdapter(),
)


async def fetch_external_candidates(
    keywords: Sequence[str],
    *,
    country: Optional[str] = None,
    max_keywords: Optional[int] = None,
    per_keyword: Optional[int] = None,
    max_candidates: int = 30,
    allow_paid: bool = False,
    timeout_seconds: Optional[float] = None,
    adapters: Sequence[ExternalSourceAdapter] = DEFAULT_EXTERNAL_ADAPTERS,
    client: Optional[httpx.AsyncClient] = None,
) -> ExternalFetchResult:
    """按配置与预算调用外部候选适配器，提取并去重 `t.me` / 邀请链接。"""

    result = ExternalFetchResult()
    if not settings.external_search_enabled:
        result.notes.append("服务端未启用 EXTERNAL_SEARCH_ENABLED，已跳过自动外部网页检索")
        return result

    try:
        max_candidates_int = int(max_candidates)
    except (TypeError, ValueError):
        max_candidates_int = 30
    if max_candidates_int <= 0:
        result.notes.append("外部候选预算为 0，已跳过外部网页/目录检索")
        return result
    total_cap = min(max_candidates_int, 200)
    kw_cap = max(1, min(int(max_keywords or settings.external_search_max_keywords or 3), 10))
    per_kw = max(1, min(int(per_keyword or settings.external_search_per_keyword or 15), 50))
    cleaned_keywords = [str(k).strip() for k in keywords if str(k).strip()][:kw_cap]
    if not cleaned_keywords:
        return result

    any_configured = bool(
        str(settings.external_search_engine_provider or "").strip()
        or str(settings.external_search_directory_base_url or "").strip()
        or str(settings.external_search_seed_urls or "").strip()
    )
    if not any_configured:
        result.notes.append("未配置外部搜索引擎、目录地址或种子清单 URL，已跳过自动外部召回")
        return result

    timeout = float(timeout_seconds or settings.external_search_timeout_seconds or 10.0)
    headers = {"User-Agent": "tgcc-discovery/1.0 (external candidate adapter)"}
    seen: set[tuple[str, str]] = set()
    note_seen: set[str] = set()

    async def _run(http: httpx.AsyncClient) -> None:
        for adapter in adapters:
            if len(result.hits) >= total_cap:
                break
            hits, notes, errs, queries_sent = await adapter.fetch(
                http,
                cleaned_keywords,
                country=country,
                per_keyword=per_kw,
                allow_paid=allow_paid,
            )
            result.errors += errs
            result.queries_run += queries_sent
            for n in notes:
                if n not in note_seen:
                    note_seen.add(n)
                    result.notes.append(n)
            for hit in hits:
                key = (hit.kind, hit.value)
                if key in seen:
                    continue
                if len(result.hits) >= total_cap:
                    break
                seen.add(key)
                result.hits.append(hit)
                result.links.append(ExtractedLink(kind=hit.kind, value=hit.value, url=hit.url))

    if client is not None:
        await _run(client)
    else:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers) as http:
            await _run(http)

    return result
