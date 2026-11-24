"""关键词扩展的离线检查：不连 Telegram，不碰数据库。

    cd backend && .venv/bin/python -m tests.group_search_check
"""

from __future__ import annotations

from app.services.group_search import MAX_QUERY_LEN, expand_queries


def main() -> None:
    # 没有地区时保持旧行为：只搜原始关键词。
    base = expand_queries(["forex", "  Gold  ", "forex"])
    assert [item.query for item in base] == ["forex", "Gold"], [item.query for item in base]

    # 地区扩展：原始词第一，地区、城市、群组后缀都要出现。
    expanded = expand_queries(["forex"], regions=["MY"], max_queries=80)
    queries = [item.query for item in expanded]
    assert queries[0] == "forex", queries[:3]
    for expected in (
        "forex malaysia",
        "fx malaysia",
        "forex kuala lumpur",
        "forex kl",
        "forex malaysia group",
        "kumpulan forex malaysia",
        "forex malaysia 群",
        "signal forex",
        "signal forex kuala lumpur",
        "马来西亚 外汇",
        "马来西亚 外汇 群",
        "外汇 群",
        "forex telegram",
        "forex sabah",
        "forex kota kinabalu",
    ):
        assert expected in queries, f"缺少查询：{expected}\n{queries}"

    # 主题别名：gold -> emas，并展开马来语本地词组。
    gold = [item.query for item in expand_queries(["gold"], regions=["MY"], max_queries=80)]
    assert "emas malaysia" in gold, gold
    assert "pelaburan emas" in gold, gold
    assert "trading emas" in gold, gold

    # 已停用的查询不参与扩展，但用户手输的基础词仍保留。
    excluded = [item.query for item in expand_queries(["forex"], regions=["MY"], max_queries=80, exclude=["signal forex"])]
    assert "signal forex" not in excluded, excluded
    assert excluded[0] == "forex", excluded[:2]

    # 去重与限长。
    assert len(queries) == len({item.casefold() for item in queries}), "查询没有去重"
    assert all(len(item) <= MAX_QUERY_LEN for item in queries), "查询超过长度上限"

    # 硬上限：max_queries 必须生效。
    capped = expand_queries(["forex"], regions=["MY"], max_queries=5)
    assert len(capped) == 5, len(capped)
    assert expand_queries(["forex"], regions=["MY"], max_queries=1)[0].query == "forex"

    # 未知地区按用户输入展开，不报错。
    custom = [item.query for item in expand_queries(["saham"], regions=["Johor Bahru"], max_queries=20)]
    assert "saham johor bahru" in custom, custom

    print("group_search_check: ok")


if __name__ == "__main__":
    main()
