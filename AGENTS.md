# wikifxtg云控 —— 项目约定

> 文档索引：[docs/README.md](docs/README.md) · 相邻：贡献指南 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) · 快速开始 [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)

## Git：本项目只对接 junqingyongyuanbusi 这一个仓库

- `origin` → `https://github.com/junqingyongyuanbusi/telegram-cloud-control`（private，`main`）
- 本项目的提交和推送只允许使用这个远程，不新增或切换其他 remote。
- 凭据配置只写本仓库的 `--local` 配置，不修改全局 GitHub 登录状态或其他项目。
- 提交只包含明确指定的文件，工作区中的其他改动保持原样。

## 本地运行（不用 Docker）

依赖本机 Postgres `127.0.0.1:55432` 与 Redis `127.0.0.1:56379`（配置见 `backend/.env`）。

- 起停整套：`make stack-up` / `make stack-down` / `make stack-status`
- 控制台：<http://127.0.0.1:5173>（`cd frontend && npm run dev`，`/api` 反代到 `:8000`）
- API：<http://127.0.0.1:8000>；健康检查是 `/health` 与 `/ready`，**没有** `/api` 前缀
- 进程 pid 写在 `run/{api,worker,web}.pid`，日志在 `run/*.log`
- `backend/.env` 中 `TELEGRAM_API_ID=0`、`TELEGRAM_API_HASH` 为空时，worker 只认领租约
与发心跳、不建立 Telegram 连接，属预期行为（账号不会显示在线）

## 本地栈排障要点

- `run/*.pid` 可能因进程被外部重启而失效，`make stack-down` 前先 `make stack-status`
核对真实 pid；进程真实归属以 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 为准。
- 同时跑多个 worker 副本会互抢账号租约，日志刷 `已放开该号 / 租约已不属于本进程`；
本地只应保留一个 api + 一个 worker。
