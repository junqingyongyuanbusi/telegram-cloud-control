"""回归：非 admin 登录时自动建的号必须归创建者，否则它自己读不到登录状态（403）。

修复前：POST /accounts/login/qr 建完号不写 account_assignments，operator 随后
GET /accounts/login/qr/{id} 一律 403，页面永远收不到二维码。
手工建档 /accounts 同样中招，这里一起覆盖。

不需要 pytest，直接跑（需先起栈）：
    cd backend && python -m tests.qr_visibility_check
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

import httpx

BASE = os.environ.get("TGCC_API", "http://127.0.0.1:18000")
ADMIN_USER = "admin"
ADMIN_PASSWORD = "CloudCtl-local-2026"
OP_PASSWORD = "qr-check-pass-1234"
SUFFIX = uuid.uuid4().hex[:6]

PASSED: list[str] = []
FAILED: list[str] = []
STATE: dict[str, str] = {}


def check(name: str, ok: bool, detail: str = "") -> bool:
    (PASSED if ok else FAILED).append(name)
    print(f"  {'✅' if ok else '❌'} {name}{(' — ' + detail) if detail else ''}")
    return ok


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=30.0) as c:
        r = c.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
        assert r.status_code == 200, f"admin 登录失败：{r.text[:200]}"
        admin = {"Authorization": f"Bearer {r.json()['access_token']}"}

        user = c.post(
            "/api/users",
            json={"username": f"qr-op-{SUFFIX}", "password": OP_PASSWORD,
                  "display_name": "扫码可见性校验", "role": "operator"},
            headers=admin,
        )
        assert user.status_code in (200, 201), user.text[:300]
        STATE["user"] = user.json()["id"]

        r = c.post("/api/auth/login", json={"username": f"qr-op-{SUFFIX}", "password": OP_PASSWORD})
        assert r.status_code == 200, r.text[:200]
        op = {"Authorization": f"Bearer {r.json()['access_token']}"}

        try:
            # 1) 扫码登录：建号后立刻能读二维码状态
            r = c.post("/api/accounts/login/qr", json={"account_id": None}, headers=op)
            check("operator 发起扫码登录 → 200", r.status_code == 200, r.text[:160])
            if r.status_code == 200:
                login_id = r.json()["login_id"]
                STATE["qr_account"] = r.json()["account_id"]
                poll = c.get(f"/api/accounts/login/qr/{login_id}", headers=op)
                check("operator 读自己的二维码状态 → 200（修复前 403）",
                      poll.status_code == 200, f"HTTP {poll.status_code}")

            # 2) 手工建档：创建者能立刻看到
            r = c.post("/api/accounts", json={"phone": f"+1666{SUFFIX}"}, headers=op)
            check("operator 手工建档 → 201", r.status_code == 201, r.text[:160])
            if r.status_code == 201:
                acc = r.json()["id"]
                STATE["created_account"] = acc
                overview = c.get(f"/api/accounts/{acc}/overview", headers=op)
                check("operator 读自己建的号 → 200（修复前 403）",
                      overview.status_code == 200, f"HTTP {overview.status_code}")

            # 3) 分配记录确实落库
            mine = asyncio.run(_assignment_count())
            check("创建者持有 account_assignments 记录", mine >= 2, f"{mine} 条")
        finally:
            _cleanup(c, admin)
    return 1 if FAILED else 0


async def _assignment_count() -> int:
    from sqlalchemy import func, select

    from app import db
    from app.models import AccountAssignment

    async with db.SessionFactory() as session:
        n = await session.scalar(
            select(func.count()).select_from(AccountAssignment)
            .where(AccountAssignment.user_id == uuid.UUID(STATE["user"]))
        )
    await db.dispose_engine()
    return int(n or 0)


def _cleanup(c: httpx.Client, admin: dict) -> None:
    for key in ("created_account", "qr_account"):
        if STATE.get(key):
            c.delete(f"/api/accounts/{STATE[key]}", headers=admin)
    if STATE.get("user"):
        c.delete(f"/api/users/{STATE['user']}", headers=admin)
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")


if __name__ == "__main__":
    sys.exit(main())
