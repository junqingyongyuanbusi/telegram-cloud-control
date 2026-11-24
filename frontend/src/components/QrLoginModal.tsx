/**
 * 扫码登录弹窗：后端 Worker 生成 `tg://login?token=…`，这里渲染成二维码并轮询进度。
 *
 * 与验证码登录的差别：
 * - 不用手机号，授权成功后由 Telegram 返回号码，后端回填到账号；
 * - 二维码约 30 秒换一次，轮询到新 `qr_url` 就重绘，不需要用户手动刷新；
 * - 扫码确认在手机端完成；若账号开了两步验证，需在本弹窗补一次密码。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space, Spin, Typography } from 'antd';
import QRCode from 'qrcode';
import { accountQrLoginApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AccountOut, GroupOut, ProxyOut, QrLoginState } from '../api/types';

interface Props {
  open: boolean;
  /** 「重新扫码」已有号时传；新号扫码为空 */
  account?: AccountOut | null;
  groups: GroupOut[];
  proxies: ProxyOut[];
  onClose: () => void;
  onDone: () => void;
}

const TERMINAL = new Set(['done', 'expired', 'failed', 'cancelled']);

export function QrLoginModal({ open, account, groups, proxies, onClose, onDone }: Props) {
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm<{ password: string }>();
  const [loginId, setLoginId] = useState<string | null>(null);
  const [state, setState] = useState<QrLoginState | null>(null);
  const [image, setImage] = useState('');
  const [starting, setStarting] = useState(false);
  const [pwdSending, setPwdSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const doneRef = useRef(false);
  // 轮询 effect 不跟着父组件每次 render 重建；回调放 ref 里取最新值
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const reset = () => {
    form.resetFields();
    pwdForm.resetFields();
    setLoginId(null);
    setState(null);
    setImage('');
    setError(null);
    setStarting(false);
    doneRef.current = false;
  };

  useEffect(() => {
    if (!open) return;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  // 二维码 token 换新时重绘
  useEffect(() => {
    const url = state?.qr_url;
    if (!url) {
      setImage('');
      return;
    }
    let alive = true;
    QRCode.toDataURL(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => {
        if (alive) setImage(data);
      })
      .catch(() => {
        if (alive) setImage('');
      });
    return () => {
      alive = false;
    };
  }, [state?.qr_url]);

  // 轮询进度：pending 时每 2 秒一次，终态就停
  useEffect(() => {
    if (!open || !loginId) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await accountQrLoginApi.state(loginId);
        if (stopped) return;
        setState(next);
        if (next.status === 'done') {
          stopped = true;
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current();
          }
          return;
        }
        if (TERMINAL.has(next.status)) {
          stopped = true;
          return;
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) {
          stopped = true;
          setState((prev) =>
            prev ? { ...prev, status: 'expired', message: '扫码会话已过期，请重新生成' } : prev,
          );
          return;
        }
        // 其它错误（网络抖动）继续轮询，避免一次超时就把二维码判死
      }
      if (!stopped) timer = window.setTimeout(tick, 2000);
    };
    timer = window.setTimeout(tick, 600);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [open, loginId]);

  // 倒计时每秒走一次；没有二维码时不跑
  useEffect(() => {
    if (!state?.expires_at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.expires_at]);

  const handleStart = async (values: { group_id?: string; proxy_id?: string }) => {
    setStarting(true);
    setError(null);
    try {
      const res = await accountQrLoginApi.start({
        account_id: account?.id ?? null,
        group_id: values.group_id ?? null,
        proxy_id: values.proxy_id ?? null,
      });
      setLoginId(res.login_id);
      setState({
        login_id: res.login_id,
        account_id: res.account_id,
        status: res.status,
        qr_url: null,
        expires_at: null,
        message: '已排队生成二维码，请稍候…',
        phone_masked: account?.phone_masked ?? null,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '生成二维码失败，请稍后重试');
    } finally {
      setStarting(false);
    }
  };

  const handlePassword = async (values: { password: string }) => {
    if (!loginId) return;
    setPwdSending(true);
    setError(null);
    try {
      await accountQrLoginApi.password(loginId, values.password);
      pwdForm.resetFields();
      setState((prev) =>
        prev ? { ...prev, message: '密码已提交，正在校验…' } : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '提交密码失败，请重试');
    } finally {
      setPwdSending(false);
    }
  };

  const handleClose = async () => {
    if (loginId && state && !TERMINAL.has(state.status)) {
      try {
        await accountQrLoginApi.cancel(loginId);
      } catch {
        /* 取消失败不挡关闭：Worker 会在总窗口到期后自己收尾 */
      }
    }
    onClose();
  };

  const expiresIn = state?.expires_at
    ? Math.max(0, Math.ceil((new Date(state.expires_at).getTime() - now) / 1000))
    : null;

  const statusAlert = () => {
    if (!state) return null;
    if (state.status === 'done') {
      return (
        <Alert
          type="success"
          showIcon
          message="扫码登录成功"
          description={
            <span>
              会话已加密写回账号{state.phone_masked ? `（${state.phone_masked}）` : ''}，可以关闭本窗口。
            </span>
          }
        />
      );
    }
    if (state.status === 'pending') {
      return (
        <Alert
          type="info"
          showIcon
          message={state.message || '请用手机 Telegram 扫码'}
          description={
            expiresIn !== null
              ? `二维码 ${expiresIn > 0 ? `${expiresIn} 秒后` : '即将'}自动刷新，无需手动操作。`
              : '正在申请二维码…'
          }
        />
      );
    }
    if (state.status === 'password_required') {
      return (
        <Alert
          type="info"
          showIcon
          message="手机端已确认，该账号开启了两步验证"
          description="请输入两步验证密码；密码只用于本次登录，校验后立即丢弃。"
        />
      );
    }
    return <Alert type="warning" showIcon message={state.message || '扫码未完成'} />;
  };

  return (
    <Modal
      open={open}
      title={account ? `扫码重新登录：${account.phone_masked}` : '扫码登录新账号'}
      onCancel={() => void handleClose()}
      maskClosable={false}
      width={560}
      footer={
        <Space>
          <Button onClick={() => void handleClose()}>关闭</Button>
          {!loginId || (state && TERMINAL.has(state.status) && state.status !== 'done') ? (
            <Button
              type="primary"
              loading={starting}
              onClick={() => {
                if (!loginId) {
                  form.submit();
                  return;
                }
                // 重新生成时保留已选的分组/代理，只换一张二维码
                const values = form.getFieldsValue() as { group_id?: string; proxy_id?: string };
                reset();
                void handleStart(values);
              }}
            >
              {loginId ? '重新生成' : '生成二维码'}
            </Button>
          ) : null}
        </Space>
      }
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      <Form
        form={form}
        layout="vertical"
        onFinish={handleStart}
        autoComplete="off"
        disabled={Boolean(loginId)}
      >
        <Form.Item label="分组（可选）" name="group_id">
          <Select
            allowClear
            placeholder="不选则不分组"
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        </Form.Item>
        <Form.Item label="代理（可选）" name="proxy_id">
          <Select
            allowClear
            placeholder="不选则直连"
            options={proxies.map((p) => ({ value: p.id, label: `${p.name}（${p.endpoint}）` }))}
          />
        </Form.Item>
      </Form>

      {loginId ? (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {statusAlert()}
          {state?.status === 'pending' ? (
            <div style={{ textAlign: 'center', minHeight: 248 }}>
              {image ? (
                <img
                  src={image}
                  alt="Telegram 扫码登录二维码"
                  width={240}
                  height={240}
                  style={{ display: 'block', margin: '0 auto', borderRadius: 8 }}
                />
              ) : (
                <Spin tip="正在生成二维码…" style={{ marginTop: 96 }} />
              )}
            </div>
          ) : null}
          {state?.status === 'password_required' ? (
            <Form
              form={pwdForm}
              layout="inline"
              onFinish={(values) => void handlePassword(values)}
              autoComplete="off"
              style={{ gap: 8 }}
            >
              <Form.Item
                name="password"
                rules={[{ required: true, message: '请输入两步验证密码' }]}
                style={{ flex: 1, marginBottom: 0 }}
              >
                <Input.Password
                  placeholder="两步验证密码"
                  autoComplete="current-password"
                  allowClear
                />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" loading={pwdSending}>
                  提交密码
                </Button>
              </Form.Item>
            </Form>
          ) : null}
          {state?.status === 'done' ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              手机端已确认，Worker 正在把会话写回账号；列表会自动刷新。
            </Typography.Paragraph>
          ) : null}
          <Typography.Text type="secondary">
            手机 Telegram → 设置 → 设备 → 扫描二维码。扫码确认在手机上完成；若账号开了两步验证，确认后按上方提示补密码。
          </Typography.Text>
        </Space>
      ) : null}
    </Modal>
  );
}

export default QrLoginModal;
