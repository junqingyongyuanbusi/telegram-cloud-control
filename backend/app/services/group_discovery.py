"""群组发现的离线工具：从消息里抠链接、解析 t.me 公开页。

这一步刻意不依赖 Telegram 客户端：
- 链接提取是纯正则，方便单测；
- t.me 公开页只发 HTTP GET，不登录、不加群，失败就当没拿到。
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Iterable, Literal
from urllib.parse import quote

LinkKind = Literal["username", "invite"]

_PREVIEW_RE = re.compile(r"(?:https?://)?(?:www\.)?t\.me/s/([A-Za-z][A-Za-z0-9_]{3,31})", re.I)
_INVITE_RE = re.compile(r"(?:https?://)?(?:www\.)?t\.me/(?:\+|joinchat/)([A-Za-z0-9_-]{8,})", re.I)
_USERNAME_RE = re.compile(r"(?:https?://)?(?:www\.)?t\.me/([A-Za-z][A-Za-z0-9_]{3,31})", re.I)
_MENTION_RE = re.compile(r"(?<![\w/@])@([A-Za-z][A-Za-z0-9_]{3,31})")

# t.me 的功能路径，不是用户名。
_RESERVED = {
    "joinchat",
    "addstickers",
    "addtheme",
    "share",
    "proxy",
    "socks",
    "login",
    "setlanguage",
    "iv",
    "telegram",
}

_OG_TITLE_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']*)', re.I
)
_OG_TITLE_RE_REVERSED = re.compile(
    r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']og:title["\']', re.I
)
_OG_DESC_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']og:description["\'][^>]+content=["\']([^"\']*)', re.I
)
_OG_DESC_RE_REVERSED = re.compile(
    r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']og:description["\']', re.I
)
_PAGE_EXTRA_RE = re.compile(r'<div[^>]+class=["\'][^"\']*tgme_page_extra[^"\']*["\'][^>]*>(.*?)</div>', re.I | re.S)
_PAGE_TITLE_RE = re.compile(r'<div[^>]+class=["\'][^"\']*tgme_page_title[^"\']*["\'][^>]*>(.*?)</div>', re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class ExtractedLink:
    kind: LinkKind
    value: str
    url: str


def _clean_username(value: str) -> str:
    return value.strip().lstrip("@").casefold()


def _add_link(bucket: list[ExtractedLink], seen: set[tuple[str, str]], link: ExtractedLink) -> None:
    key = (link.kind, link.value)
    if key in seen:
        return
    seen.add(key)
    bucket.append(link)


def extract_links(texts: Iterable[str], *, limit: int = 200) -> list[ExtractedLink]:
    """从一组文本里提取公开用户名和邀请链接，按出现顺序去重。

    邀请链接优先于用户名：`t.me/+hash` 不会被误当成用户名 `+hash`。
    """

    limit = max(1, min(int(limit or 1), 1000))
    links: list[ExtractedLink] = []
    seen: set[tuple[str, str]] = set()
    for text in texts:
        raw = str(text or "")
        if not raw:
            continue

        for match in _INVITE_RE.finditer(raw):
            value = match.group(1).strip()
            if value:
                _add_link(links, seen, ExtractedLink("invite", value, f"https://t.me/+{value}"))
            if len(links) >= limit:
                return links

        for regex in (_PREVIEW_RE, _USERNAME_RE):
            for match in regex.finditer(raw):
                value = _clean_username(match.group(1))
                if len(value) < 4 or value in _RESERVED:
                    continue
                _add_link(links, seen, ExtractedLink("username", value, f"https://t.me/{value}"))
                if len(links) >= limit:
                    return links

        for match in _MENTION_RE.finditer(raw):
            value = _clean_username(match.group(1))
            if len(value) < 4 or value in _RESERVED:
                continue
            _add_link(links, seen, ExtractedLink("username", value, f"https://t.me/{value}"))
            if len(links) >= limit:
                return links
    return links


def _strip_tags(value: str) -> str:
    return html.unescape(_TAG_RE.sub(" ", value or "")).strip()


def _first_meta(html_text: str, primary: re.Pattern[str], reversed_pattern: re.Pattern[str]) -> str:
    match = primary.search(html_text) or reversed_pattern.search(html_text)
    return html.unescape(match.group(1)).strip() if match else ""


def _parse_count(text: str) -> int | None:
    match = re.search(r"([\d][\d\s,\.]*)\s*([KkMm]?)\s*(?:members?|subscribers?)", text or "", re.I)
    if not match:
        return None
    raw = match.group(1).replace(" ", "").replace(",", "")
    try:
        number = float(raw)
    except ValueError:
        return None
    multiplier = {"k": 1_000, "m": 1_000_000}.get(match.group(2).casefold(), 1)
    return int(number * multiplier)


def parse_tme_page(html_text: str, *, username: str = "") -> dict:
    """解析 `t.me/<username>` 的公开预览页，拿标题/简介/成员数。

    公开群页面会显示成员数；频道显示订阅数；私群邀请页只有标题/成员数，没有简介。
    """

    title = _first_meta(html_text, _OG_TITLE_RE, _OG_TITLE_RE_REVERSED)
    if not title:
        match = _PAGE_TITLE_RE.search(html_text)
        title = _strip_tags(match.group(1)) if match else ""
    about = _first_meta(html_text, _OG_DESC_RE, _OG_DESC_RE_REVERSED)
    extra = ""
    match = _PAGE_EXTRA_RE.search(html_text)
    if match:
        extra = _strip_tags(match.group(1))
    member_count = _parse_count(extra)
    lowered = html_text.casefold()
    kind = "channel" if "subscriber" in extra.casefold() or "subscribers" in lowered else "group"
    return {
        "username": _clean_username(username),
        "title": " ".join(title.split()),
        "about": " ".join(about.split()),
        "member_count": member_count,
        "kind": kind,
        "extra": extra,
    }


def tme_url(username: str) -> str:
    return f"https://t.me/{quote(_clean_username(username))}"


def invite_url(invite_hash: str) -> str:
    return f"https://t.me/+{quote(invite_hash.strip())}"
