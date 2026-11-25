"""group_precision 的离线规则检查（不联网）。"""

from types import SimpleNamespace

from app.services.group_precision import (
    canonical_topics,
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

    assert canonical_topics(["Forex Gold"]) == ["forex", "gold"]
    assert detect_language("Kumpulan Forex") == "ms"
    assert detect_language("Grup Forex") == "id"
    assert detect_language("Diskusi Saham Harian") == "id"
    assert detect_language("Forex Malaysia") == "en"
    assert detect_language("Cộng đồng Forex Việt Nam") == "vi"
    assert detect_language("Форекс чат") == "ru"
    assert detect_language("Alpha Beta Gamma") == "unknown"

    by_user = score_group(
        title="Trading Hub",
        username="thai_forex_chat",
        about="Market talk",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
    )
    assert by_user.breakdown.get("name", 0) >= 22, by_user
    assert by_user.breakdown.get("region") == 20, by_user
    assert by_user.breakdown.get("intent") == 15, by_user

    conflict = score_group(
        title="Dubai Gold Discussion",
        about="UAE traders",
        keywords=["Gold Thailand"],
        country="TH",
        languages=["en"],
    )
    assert conflict.breakdown.get("region") == -20, conflict

    spam = score_group(
        title="Free Signal VIP Forex Thailand",
        about="Guaranteed profit 100%",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
    )
    assert spam.breakdown.get("quality", 0) < 0, spam

    unknown_members = score_group(
        title="Forex Thailand Chat",
        keywords=["Forex Thailand"],
        country="TH",
        member_count=0,
    )
    tiny_group = score_group(
        title="Forex Thailand Chat",
        keywords=["Forex Thailand"],
        country="TH",
        member_count=8,
    )
    assert unknown_members.breakdown.get("quality", 0) == 0, unknown_members
    assert tiny_group.breakdown.get("quality", 0) <= -15, tiny_group

    msg_only = score_group(
        title="Traders Lounge",
        about="",
        keywords=["Forex"],
        message_hits=2,
    )
    assert msg_only.breakdown.get("message") == 20, msg_only

    active = score_group(
        title="Forex Thailand Chat",
        about="Discuss",
        keywords=["Forex"],
        country="TH",
        languages=["en"],
        member_count=800,
        activity={
            "checked": True,
            "recent_7d": 12,
            "unique_senders": 6,
            "ad_ratio": 0.1,
            "keyword_hits": 2,
        },
    )
    assert active.breakdown.get("quality", 0) >= 13, active
    assert classify(52, min_score=50) == "accepted"
    assert classify(45, min_score=50) == "needs_review"

    from app.services.group_sources import compute_source_trust, normalize_source_list

    assert normalize_source_list(["contacts", "contacts_search", "message_search"]) == [
        "contacts_search",
        "global_message_search",
    ]
    t_ext, tier_ext, _ = compute_source_trust(["external_web"])
    assert t_ext == 0 and tier_ext == "external_verified"
    t_same_endpoint, tier_same_endpoint, _ = compute_source_trust(["contacts_search", "short_query"])
    assert t_same_endpoint == 0 and tier_same_endpoint == "tg_verified"
    t_multi, tier_multi, _ = compute_source_trust(
        ["contacts_search", "global_message_search", "linked_chat", "external_web"],
        source_counts={"global_message_search": 4},
        joined=True,
    )
    assert t_multi == 8 and tier_multi == "tg_verified"

    cross_group = score_group(
        title="Forex Thailand Chat",
        about="Discuss trading",
        keywords=["Forex Thailand"],
        country="TH",
        languages=["th", "en"],
        sources=["contacts_search", "global_message_search", "linked_chat", "external_web"],
        source_counts={"global_message_search": 4},
        joined=True,
    )
    assert cross_group.breakdown.get("trust") == 8, cross_group

    print("group_precision_check: ok")


if __name__ == "__main__":
    main()
