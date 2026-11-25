"""关键词扩展的离线检查：不连 Telegram，不碰数据库。

    cd backend && .venv/bin/python -m tests.group_search_check
"""

from __future__ import annotations

from app.services.group_search import MAX_QUERY_LEN, build_short_queries, expand_queries


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

    # 泰语地区：泰文主题词 + กลุ่ม/พูดคุย 前缀 + 泰国城市。
    thai = [item.query for item in expand_queries(["Forex"], regions=["TH"], languages=["th", "en"], max_queries=80)]
    lowered_thai = {item.casefold() for item in thai}
    for expected in ("กลุ่มฟอเร็กซ์", "พูดคุย ฟอเร็กซ์", "ฟอเร็กซ์ ไทย", "forex กรุงเทพ", "forex bangkok"):
        assert expected.casefold() in lowered_thai, f"缺少泰语查询：{expected}\n{thai}"

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

    # 短核心词：即使只给一个长尾词，也要补出 forex/เทรด/ทอง 等基础词。
    short = build_short_queries(["Forex Thailand signal group"], regions=["TH"], limit=40)
    short_queries = [item.query for item in short]
    assert "forex" in short_queries, short_queries
    assert "เทรด" in short_queries, short_queries
    assert "ทองคำ" in short_queries, short_queries
    assert "กลุ่มเทรด" in short_queries, short_queries
    assert "XM Thailand" in short_queries, short_queries
    assert "forex thai" in short_queries, short_queries
    assert all(item.template == "short_core" for item in short), short
    # 用户已输入的基础词不重复追加。
    short_again = [item.query for item in build_short_queries(["forex", "gold"], regions=["TH"], limit=40)]
    assert "forex" not in short_again and "gold" not in short_again, short_again
    # 上限生效。
    assert len(build_short_queries(["forex"], regions=["TH"], limit=5)) == 5

    # 非金融自定义话题 + strict_topic=True：不能混入 forex/gold，也不能无条件加泰语/重复地名。
    crypto_short = [
        item.query
        for item in build_short_queries(["Crypto Thailand", "USDT"], regions=["TH"], limit=20, strict_topic=True)
    ]
    assert "forex" not in crypto_short and "ทองคำ" not in crypto_short, crypto_short
    assert "Crypto" in crypto_short and "กลุ่ม Crypto" in crypto_short, crypto_short
    assert "Crypto Thailand thailand" not in [q.casefold() for q in crypto_short], crypto_short

    my_short = [
        item.query
        for item in build_short_queries(["马来西亚 开卡"], regions=["MY"], limit=20, strict_topic=True)
    ]
    assert not any(q.startswith("กลุ่ม ") for q in my_short), my_short

    # 越南 / 日本等扩展地区与自定义中文扩展，避免重复地名拼接。
    my_custom_zh = [item.query for item in expand_queries(["马来西亚 开卡"], regions=["MY"], max_queries=20)]
    assert "马来西亚 马来西亚 开卡" not in my_custom_zh, my_custom_zh
    vn_expanded = [item.query for item in expand_queries(["crypto"], regions=["VN"], max_queries=30)]
    assert any("hanoi" in q.casefold() or "vietnam" in q.casefold() for q in vn_expanded), vn_expanded

    print("group_search_check: ok")


if __name__ == "__main__":
    main()
