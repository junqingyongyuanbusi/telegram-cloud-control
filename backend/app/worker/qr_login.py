"""扫码登录：Worker 轮询 `auth.ExportLoginToken`，页面从 Redis 读二维码与进度。

为什么不照搬参考项目「Web 进程内存态」：本项目约定 API 不连 Telethon，用户号的
连接统一归 Worker（租约 + 心跳）。这里复用 `login_start` 任务类型，payload 带
`mode=qr`；扫码期间 Worker 持有该号租约，成功后走与验证码登录相同的落库路径。

二维码 token 约 30 秒过期，过期后 `ExportLoginToken` 会直接返回新 token；因此用
轮询而不是 `QRLogin.wait()`：后者靠 `UpdateLoginToken` 事件唤醒，页面/网络抖动时
可能错过一次更新，轮询则每次都能拿到当前 token 的真实状态。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from telethon import functions
from telethon.errors import PasswordHashInvalidError, SessionPasswordNeededError
from telethon.tl import types as tl_types

from app.config import settings
from app.core import audit as audit_core
from app.core import events as core_events
from app.core.tasks import enqueue_task
from app.models import AccountStatus, Task, TaskType, TgAccount
from app.security import encrypt_secret, mask_phone, short_hash
from app.worker.login import build_login_client, safe_disconnect
from app.worker.telethon_account import (
    TaskFailure,
    describe_exception,
    flood_wait_seconds,
    is_network_error,
    persist_identity,
)

logger = logging.getLogger(__name__)

STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_EXPIRED = "expired"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"
STATUS_PASSWORD_REQUIRED = "password_required"

#: 连续导出失败多少次就放弃（网络抖动允许重试，不让任务卡到超时）
_MAX_CONSECUTIVE_ERRORS = 5


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _state_ttl() -> int:
    return max(60, int(settings.qr_login_ttl_seconds)) + 120


def _initial_state(account: TgAccount) -> dict:
    return {
        "account_id": str(account.id),
        "status": STATUS_PENDING,
        "qr_url": None,
        "expires_at": None,
        "message": "正在向 Telegram 申请二维码…",
        "phone_masked": account.phone_masked,
    }


async def _save_state(
    worker: Any, login_id: uuid.UUID | str, state: dict, **patch: Any
) -> None:
    """把最新快照写回 Redis；页面轮询读到的就是这里的内容。"""
    state.update(patch)
    state["updated_at"] = _now().isoformat()
    try:
        await core_events.save_qr_login(worker.redis, login_id, state, ttl=_state_ttl())
    except Exception:  # noqa: BLE001 - Redis 抖动不该把登录本身打断
        logger.warning("写扫码登录状态失败 login_id=%s", login_id, exc_info=True)


def _qr_url(token: bytes) -> str:
    # 与 telethon.tl.custom.qrlogin.QRLogin.url 完全一致（base64url 去掉 padding）
    import base64

    return "tg://login?token={}".format(
        base64.urlsafe_b64encode(token).decode("utf-8").rstrip("=")
    )


async def _finalize(
    session: Any,
    *,
    client: Any,
    account: TgAccount,
    me: Any,
    task: Task,
    worker: Any,
    login_id: uuid.UUID | str,
) -> None:
    """扫码授权成功：回填手机号/身份、封存会话、写审计、补一条同步会话任务。"""
    phone = getattr(me, "phone", None)
    if phone:
        digits = "".join(ch for ch in str(phone) if ch.isdigit())
        if digits:
            normalized = f"+{digits}"
            account.phone_enc = encrypt_secret(normalized)
            account.phone_hash = short_hash(normalized)
            account.phone_masked = mask_phone(normalized)
    account.status_reason = ""
    await persist_identity(
        session,
        account,
        me,
        session_string=client.session.save(),
        reset_authorized_at=True,
        client_for_avatar=client,
    )
    # pending 的号登录后就是健康；sticky 状态（冻结/失效等）由 persist_identity 守住
    if account.status == AccountStatus.pending:
        account.status = AccountStatus.healthy
    await audit_core.write_audit(
        session,
        action="account.login_qr",
        account_id=account.id,
        target_type="tg_account",
        target_id=str(account.id),
        detail={
            "phone_masked": account.phone_masked,
            "tg_user_id": account.tg_user_id,
            "username": account.username,
            "login_id": str(login_id),
        },
    )
    await enqueue_task(
        session,
        type=TaskType.sync_dialogs,
        account_id=account.id,
        payload={"reason": "login_finalize_qr"},
        priority=60,
        dedupe_key=f"login-qr-sync:{account.id}:{task.id}",
    )
    await login_flow_publish(worker, account)
    logger.info(
        "扫码登录完成",
        extra={
            "worker_id": worker.worker_id,
            "account_id": str(account.id),
            "task_id": str(task.id),
            "tg_user_id": account.tg_user_id,
        },
    )


async def login_flow_publish(worker: Any, account: TgAccount) -> None:
    """推送账号状态（复用验证码登录的推送函数，失败只记日志）。"""
    from app.worker.login import _publish_account

    await _publish_account(worker, account)


async def _export_token(client: Any) -> Any:
    return await client(
        functions.auth.ExportLoginTokenRequest(client.api_id, client.api_hash, [])
    )


async def _await_password(
    client: Any,
    *,
    worker: Any,
    login_id: uuid.UUID | str,
    account: TgAccount,
    state: dict,
    deadline: datetime,
    interval: float,
) -> Optional[Any]:
    """扫码确认后账号开启了两步验证：等页面提交一次性密码，再补 `sign_in`。"""
    await _save_state(
        worker,
        login_id,
        state,
        status=STATUS_PASSWORD_REQUIRED,
        qr_url=None,
        message="该账号开启了两步验证，请输入密码",
    )
    logger.info(
        "扫码已确认，等待两步验证密码",
        extra={"account_id": str(account.id), "login_id": str(login_id)},
    )
    while _now() < deadline:
        if await core_events.qr_cancel_requested(worker.redis, login_id):
            await core_events.clear_qr_cancel(worker.redis, login_id)
            await _save_state(
                worker,
                login_id,
                state,
                status=STATUS_CANCELLED,
                message="已取消扫码登录",
            )
            logger.info(
                "扫码登录已取消（两步验证阶段）",
                extra={"account_id": str(account.id), "login_id": str(login_id)},
            )
            return None

        password = await core_events.take_qr_password(worker.redis, login_id)
        if password:
            try:
                await client.sign_in(password=password)
                return await client.get_me()
            except PasswordHashInvalidError:
                await _save_state(
                    worker,
                    login_id,
                    state,
                    status=STATUS_PASSWORD_REQUIRED,
                    message="两步验证密码不正确，请重试",
                )
            except SessionPasswordNeededError:
                # 服务器仍要密码（例如刚提交的密码落在旧连接上），继续等下一页输入
                pass
            except Exception as exc:  # noqa: BLE001 - 网络/限流不终止会话
                wait = flood_wait_seconds(exc)
                logger.warning(
                    "扫码两步验证失败：%s",
                    describe_exception(exc),
                    extra={"account_id": str(account.id), "login_id": str(login_id)},
                )
                await _save_state(
                    worker,
                    login_id,
                    state,
                    status=STATUS_PASSWORD_REQUIRED,
                    message=f"两步验证失败：{describe_exception(exc)}，请重试",
                )
                if wait:
                    await asyncio.sleep(wait + 1)
                    continue
        await asyncio.sleep(interval)

    await _save_state(
        worker,
        login_id,
        state,
        status=STATUS_EXPIRED,
        qr_url=None,
        message="两步验证等待超时，请重新生成二维码",
    )
    logger.info(
        "扫码登录两步验证等待超时",
        extra={"account_id": str(account.id), "login_id": str(login_id)},
    )
    return None


async def run(
    session: Any, *, task: Task, account: TgAccount, worker: Any
) -> dict:
    """执行一次扫码登录，直到授权成功 / 用户取消 / 总窗口超时。"""
    payload = dict(task.payload or {})
    login_id = payload.get("login_id") or str(task.id)
    if not worker.telegram_ready:
        raise TaskFailure(
            "未配置 TELEGRAM_API_ID/TELEGRAM_API_HASH，Worker 空转，无法发起扫码登录",
            retryable=True,
            requeue_after=60,
        )

    ttl = max(60, int(settings.qr_login_ttl_seconds))
    interval = max(0.5, float(settings.qr_poll_interval_seconds))
    deadline = _now() + timedelta(seconds=ttl)
    state = _initial_state(account)
    await _save_state(worker, login_id, state)
    logger.info(
        "扫码登录开始，等待用户确认",
        extra={"account_id": str(account.id), "login_id": str(login_id), "ttl": ttl},
    )

    client = build_login_client(account=account)
    consecutive_errors = 0
    user: Optional[Any] = None
    last_url: Optional[str] = None
    try:
        await client.connect()
        while _now() < deadline:
            if await core_events.qr_cancel_requested(worker.redis, login_id):
                await core_events.clear_qr_cancel(worker.redis, login_id)
                await _save_state(
                    worker,
                    login_id,
                    state,
                    status=STATUS_CANCELLED,
                    message="已取消扫码登录",
                )
                logger.info(
                    "扫码登录已取消",
                    extra={"account_id": str(account.id), "login_id": str(login_id)},
                )
                return {"step": STATUS_CANCELLED}

            try:
                resp = await _export_token(client)
                consecutive_errors = 0
            except SessionPasswordNeededError:
                # 手机端已确认，但该号开了两步验证：转成「等密码」阶段，仍受同一总超时约束
                user = await _await_password(
                    client,
                    worker=worker,
                    login_id=login_id,
                    account=account,
                    state=state,
                    deadline=deadline,
                    interval=interval,
                )
                if user is None:
                    latest = await core_events.load_qr_login(worker.redis, login_id) or {}
                    return {"step": latest.get("status", STATUS_EXPIRED)}
                break
            except Exception as exc:  # noqa: BLE001 - 网络抖动继续轮询
                consecutive_errors += 1
                wait = flood_wait_seconds(exc)
                logger.warning(
                    "导出扫码 token 失败（第 %s 次）：%s",
                    consecutive_errors,
                    describe_exception(exc),
                    extra={"account_id": str(account.id), "login_id": str(login_id)},
                )
                if consecutive_errors >= _MAX_CONSECUTIVE_ERRORS:
                    await _save_state(
                        worker,
                        login_id,
                        state,
                        status=STATUS_FAILED,
                        message=f"获取二维码失败：{describe_exception(exc)}",
                    )
                    return {"step": STATUS_FAILED, "error": describe_exception(exc)}
                await asyncio.sleep(wait + 1 if wait else interval)
                continue

            if isinstance(resp, tl_types.auth.LoginTokenSuccess):
                user = resp.authorization.user
                break

            if isinstance(resp, tl_types.auth.LoginTokenMigrateTo):
                # 账号在别的 DC：切过去再导入同一个 token
                try:
                    await client._switch_dc(resp.dc_id)
                    imported = await client(
                        functions.auth.ImportLoginTokenRequest(resp.token)
                    )
                except SessionPasswordNeededError:
                    # 跨 DC 导入同样可能要求两步验证密码，不能当普通失败处理
                    user = await _await_password(
                        client,
                        worker=worker,
                        login_id=login_id,
                        account=account,
                        state=state,
                        deadline=deadline,
                        interval=interval,
                    )
                    if user is None:
                        latest = await core_events.load_qr_login(worker.redis, login_id) or {}
                        return {"step": latest.get("status", STATUS_EXPIRED)}
                    break
                except Exception as exc:  # noqa: BLE001
                    await _save_state(
                        worker,
                        login_id,
                        state,
                        status=STATUS_FAILED,
                        message=f"跨数据中心登录失败：{describe_exception(exc)}",
                    )
                    return {"step": STATUS_FAILED, "error": describe_exception(exc)}
                if isinstance(imported, tl_types.auth.LoginTokenSuccess):
                    user = imported.authorization.user
                    break
                # 其余情况按普通 token 继续（极少数服务端会回 LoginToken）
                resp = imported

            token = getattr(resp, "token", None)
            expires = getattr(resp, "expires", None)
            if token is not None:
                url = _qr_url(token)
                # token 未换时不必每秒写一次 Redis；只有 URL 变化才更新快照
                if url != last_url:
                    await _save_state(
                        worker,
                        login_id,
                        state,
                        status=STATUS_PENDING,
                        qr_url=url,
                        expires_at=expires.isoformat() if expires else None,
                        message="请用已登录 Telegram 的手机端扫码（设置 → 设备 → 扫描二维码）",
                    )
                    last_url = url
            await asyncio.sleep(interval)

        if user is None:
            await _save_state(
                worker,
                login_id,
                state,
                status=STATUS_EXPIRED,
                qr_url=None,
                message=f"二维码已过期（{ttl} 秒内未扫码），请重新生成",
            )
            return {"step": STATUS_EXPIRED}

        # LoginTokenSuccess 之后还要把客户端内部状态切成已登录（与 QRLogin.wait 一致）
        await client._on_login(user)
        me = await client.get_me()
        await _finalize(
            session,
            client=client,
            account=account,
            me=me or user,
            task=task,
            worker=worker,
            login_id=login_id,
        )
        await _save_state(
            worker,
            login_id,
            state,
            status=STATUS_DONE,
            qr_url=None,
            phone_masked=account.phone_masked,
            message="扫码登录成功，会话已加密写回该账号",
        )
        logger.info(
            "扫码登录成功，会话已写回",
            extra={
                "account_id": str(account.id),
                "login_id": str(login_id),
                "tg_user_id": account.tg_user_id,
            },
        )
        return {
            "step": STATUS_DONE,
            "phone_masked": account.phone_masked,
            "tg_user_id": account.tg_user_id,
            "username": account.username,
        }
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - 收口成页面可见的失败状态
        logger.exception(
            "扫码登录异常",
            extra={"account_id": str(account.id), "login_id": str(login_id)},
        )
        await _save_state(
            worker,
            login_id,
            state,
            status=STATUS_FAILED,
            message=f"扫码登录异常：{describe_exception(exc)}",
        )
        if is_network_error(exc):
            raise TaskFailure(
                f"扫码登录网络异常：{describe_exception(exc)}",
                retryable=False,
            ) from exc
        return {"step": STATUS_FAILED, "error": describe_exception(exc)}
    finally:
        await safe_disconnect(client)


__all__ = [
    "run",
    "STATUS_CANCELLED",
    "STATUS_DONE",
    "STATUS_EXPIRED",
    "STATUS_FAILED",
    "STATUS_PASSWORD_REQUIRED",
    "STATUS_PENDING",
]
