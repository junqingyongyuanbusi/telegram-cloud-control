"""群组发现离线检查：链接提取 + t.me 页面解析。

    cd backend && .venv/bin/python -m tests.group_discovery_check
"""

from __future__ import annotations

from app.services.group_discovery import extract_links, parse_tme_page


def main() -> None:
    text = """
    加入 https://t.me/+AbCdEf123456 或 t.me/joinchat/XyZ_987654321
    也可以看 @forex_malaysia 和 https://t.me/s/gold_trading_my
    邮箱 someone@example.com 不是用户名；t.me/addstickers 也不是。
    """
    links = extract_links([text])
    values = {(item.kind, item.value) for item in links}
    assert ("invite", "AbCdEf123456") in values, values
    assert ("invite", "XyZ_987654321") in values, values
    assert ("username", "forex_malaysia") in values, values
    assert ("username", "gold_trading_my") in values, values
    assert ("username", "addstickers") not in values, values
    assert ("username", "example") not in values, values

    # 重复链接只保留一次。
    assert len(extract_links(["t.me/abc_group", "https://t.me/abc_group"])) == 1

    page = """
    <html><head>
      <meta property="og:title" content="Forex Malaysia">
      <meta content="Belajar forex &amp; gold di Malaysia" property="og:description">
    </head><body>
      <div class="tgme_page_extra">12 345 members</div>
    </body></html>
    """
    parsed = parse_tme_page(page, username="forex_malaysia")
    assert parsed["title"] == "Forex Malaysia", parsed
    assert parsed["about"] == "Belajar forex & gold di Malaysia", parsed
    assert parsed["member_count"] == 12345, parsed
    assert parsed["kind"] == "group", parsed

    subscribers = '<div class="tgme_page_extra">1.2K subscribers</div>'
    assert parse_tme_page(subscribers)["member_count"] == 1200
    assert parse_tme_page(subscribers)["kind"] == "channel"

    print("group_discovery_check: ok")


if __name__ == "__main__":
    main()
