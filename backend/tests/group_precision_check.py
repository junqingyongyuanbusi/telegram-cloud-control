"""group_precision 的离线规则检查（不联网）。"""

from types import SimpleNamespace

from app.services.group_precision import (
    classify,
    detect_language,
    discussion_verdict,
    permission_verdict,
    score_group,
)


def _channel(**kwargs):
    base = {
        "id": 1,
        "title": "",
        "username": None,
        "megagroup": True,
        "broadcast": False,
        "gigagroup": False,
        "monoforum": False,
        "default_banned_rights": None,
        "join_request": False,
        "join_to_send": False,
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


def main() -> None:
    group = _channel()
    assert discussion_verdict(group) == (True, "ok")
    assert discussion_verdict(_channel(megagroup=False, broadcast=True)) == (False, "not_megagroup")
    assert discussion_verdict(_channel(gigagroup=True)) == (False, "gigagroup")
    assert discussion_verdict(_channel(monoforum=True)) == (False, "monoforum")

    assert permission_verdict(_channel(default_banned_rights=SimpleNamespace(send_messages=True))) == ("restricted", True)
    assert permission_verdict(_channel(default_banned_rights=SimpleNamespace(send_messages=False, send_plain=False))) == ("open", False)
    assert permission_verdict(_channel()) == ("unknown", False)

    assert detect_language("กลุ่มเทรด Forex ไทย") == "th"
    assert detect_language("马来西亚 外汇 交流群") == "zh"
    assert detect_language("kumpulan forex malaysia untuk belajar") == "ms"

    thai = score_group(
        title="กลุ่มเทรด Forex ไทย",
        about="พูดคุย วิเคราะห์กราฟ ทองคำ และค่าเงิน",
        keywords=["Forex Thailand", "กลุ่มเทรด Forex"],
        country="TH",
        languages=["th", "en"],
    )
    assert thai.score >= 85, thai
    assert "region" in thai.breakdown and thai.breakdown["region"] == 20
    assert thai.language == "th"

    channel = score_group(
        title="Thai Forex Signal",
        about="Daily signals",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
    )
    # 名称/地区分再高，也不会把广播频道变成讨论组；类型是独立硬条件。
    assert discussion_verdict(_channel(broadcast=True, megagroup=False))[0] is False

    low = score_group(
        title="Thailand Travel Group",
        about="Travel tips",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
    )
    assert low.score < 60, low
    assert classify(low.score) in {"needs_review", "rejected"}

    unrelated = score_group(
        title="Travel Group",
        about="Travel tips",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
    )
    assert unrelated.score < 40, unrelated
    assert classify(unrelated.score) == "rejected"

    print("group_precision_check: ok")


if __name__ == "__main__":
    main()
