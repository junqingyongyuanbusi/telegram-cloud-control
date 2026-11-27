"""回归：页面权限收紧后的接口兜底（operator 碰不到管理员接口）。

页面侧策略见 `frontend/src/components/shell/navAccess.ts`：
operator 只保留 会话 / 群情报 / 任务中心 / 触达中心；工作台、客服收件箱、账号、
分组、网络、员工分配、操作记录都不可见。这里验证接口侧同步收紧：

- 分组写操作（新建/改/删/加号/移号）→ 403；分组列表仍开放（触达中心选号要按分组筛）；
- 代理全部接口 → 403（仅 /network 与账号导入使用，都是管理员页面）；
- 员工、分配、用户管理 → 403（原有行为，防回退）；
- 会话/群情报/任务/触达依赖的账号、分组、审计（按人裁剪）仍可读。

不需要 pytest，直接跑（需先起栈）：
    cd backend && python -m tests.role_access_check
"""

from __future__ import annotations

import os
import sys
import uuid

import httpx

BASE = os.environ.get("TGCC_API", "http://127.0.0.1:8000")
ADMIN_USER = os.environ.get("TGCC_ADMIN_USER", "admin")
# 起栈脚本会把 admin 口令重置为 backend/.env 的 BOOTSTRAP_ADMIN_PASSWORD；
# 跑之前用它覆盖：TGCC_ADMIN_PASSWORD=... python -m tests.role_access_check
ADMIN_PASSWORD = os.environ.get("TGCC_ADMIN_PASSWORD") or "CloudCtl-local-2026"
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

        username = f"role-check-{SUFFIX}"
        user = c.post(
            "/api/users",
            json={
                "username": username,
                "password": OP_PASSWORD,
                "display_name": "页面权限校验",
                "role": "operator",
            },
            headers=admin,
        )
        assert user.status_code in (200, 201), user.text[:300]
        STATE["user"] = user.json()["id"]

        r = c.post("/api/auth/login", json={"username": username, "password": OP_PASSWORD})
        assert r.status_code == 200, r.text[:200]
        op = {"Authorization": f"Bearer {r.json()['access_token']}"}

        try:
            # ---- operator 必须仍能用的读接口（消息 / 任务 / 触达的依赖） ----
            check("operator GET /api/groups → 200", c.get("/api/groups", headers=op).status_code == 200)
            check(
                "operator GET /api/accounts → 200",
                c.get("/api/accounts", headers=op).status_code == 200,
            )
            check(
                "operator GET /api/audit → 200（按本人裁剪）",
                c.get("/api/audit", params={"page": 1, "page_size": 5}, headers=op).status_code == 200,
            )

            # ---- operator 必须被拒绝的接口 ----
            denied: list[tuple[str, str, dict | None]] = [
                ("GET", "/api/proxies", None),
                ("POST", "/api/groups", {"name": f"role-check-{SUFFIX}"}),
                ("GET", "/api/users", None),
                ("GET", "/api/assignments", None),
            ]
            for method, url, payload in denied:
                r = c.request(method, url, json=payload, headers=op)
                check(
                    f"operator {method} {url} → 403",
                    r.status_code == 403,
                    f"HTTP {r.status_code} {r.text[:80]}",
                )

            # 管理员仍能读写：证明收紧只针对 operator
            check("admin GET /api/proxies → 200", c.get("/api/proxies", headers=admin).status_code == 200)
            check("admin GET /api/users → 200", c.get("/api/users", headers=admin).status_code == 200)
            created = c.post(
                "/api/groups",
                json={"name": f"role-check-{SUFFIX}"},
                headers=admin,
            )
            check("admin POST /api/groups → 201", created.status_code == 201, created.text[:120])
            if created.status_code == 201:
                STATE["group"] = created.json()["id"]
        finally:
            _cleanup(c, admin)
    return 1 if FAILED else 0


def _cleanup(c: httpx.Client, admin: dict) -> None:
    if STATE.get("group"):
        c.delete(f"/api/groups/{STATE['group']}", headers=admin)
    if STATE.get("user"):
        c.delete(f"/api/users/{STATE['user']}", headers=admin)
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")


if __name__ == "__main__":
    sys.exit(main())
