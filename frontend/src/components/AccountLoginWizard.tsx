import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Steps, Typography } from 'antd';
import { accountLoginApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AccountOut, GroupOut, LoginStep, LoginStepResponse, ProxyOut } from '../api/types';

interface Props {
  open: boolean;
  /** 「重新登录」已有号时传；新建登录时为空 */
  account?: AccountOut | null;
  groups: GroupOut[];
  proxies: ProxyOut[];
  onCancel: () => void;
  /** 走到 done 之后通知列表刷新 */
  onDone: () => void;
}

interface StartForm {
  /** 已有账号重新登录时可以留空：后端用 phone_enc 里加密保存的号码 */
  phone?: string;
  group_id?: string;
  proxy_id?: string;
}

const STEP_INDEX: Record<LoginStep, number> = {
  code_required: 1,
  password_required: 2,
  done: 3,
};

/**
 * 单号登录向导：手机号 → 验证码 → 两步密码。
 * 三步都由 Worker 执行 Telethon 登录，这里只按 LoginStepResponse.step 推进。
 */
export function AccountLoginWizard({ open, account, groups, proxies, onCancel, onDone }: Props) {
  const [form] = Form.useForm();
  const [step, setStep] = useState(0);
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [message, setMessage] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [nextType, setNextType] = useState<string | null>(null);
  const [stateEpoch, setStateEpoch] = useState(0);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setStep(0);
    setAccountId(account?.id ?? null);
    setMessage('');
    setTaskId(null);
    setError(null);
    setDelivery(null);
    setNextType(null);
    setStateEpoch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  // 等待输码时轮询：Telegram 到底把码发到了短信还是已登录客户端
  useEffect(() => {
    if (!open || step !== 1 || !accountId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const poll = async () => {
      tries += 1;
      try {
        const state = await accountLoginApi.state(accountId);
        if (stopped) return;
        setDelivery(state.delivery || null);
        setNextType(state.next_type || null);
        if (state.delivery) return; // 已知投递方式，停止轮询
      } catch {
        // Worker 可能还没把状态写进 Redis，继续重试
      }
      if (!stopped && tries < 20) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, step, accountId, stateEpoch]);

  const applyStep = (res: LoginStepResponse) => {
    setAccountId(res.account_id);
    setMessage(res.message || '');
    setTaskId(res.task_id ?? null);
    setStep(STEP_INDEX[res.step] ?? 0);
    if (res.step === 'done') {
      onDone();
    }
  };

  const fail = (err: unknown) => {
    setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
  };

  const handleStart = async (values: StartForm) => {
    setSubmitting(true);
    setError(null);
    try {
      applyStep(
        await accountLoginApi.start({
          phone: values.phone?.trim() || undefined,
          group_id: values.group_id || null,
          proxy_id: values.proxy_id || null,
          account_id: account?.id ?? null,
        }),
      );
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  // 同一 auth key 的 ResendCode 会被 Telegram 判为「方式已用尽」；
  // 重新发起登录会换新的 auth key 和新码，这是唯一可靠的重发方式。
  const handleResend = async () => {
    if (!accountId) return;
    setSubmitting(true);
    setError(null);
    setDelivery(null);
    setNextType(null);
    try {
      applyStep(await accountLoginApi.start({ account_id: accountId }));
      setStateEpoch((n) => n + 1);
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCode = async (values: { code: string }) => {
    if (!accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      applyStep(await accountLoginApi.code(accountId, values.code.trim()));
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePassword = async (values: { password: string }) => {
    if (!accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      applyStep(await accountLoginApi.password(accountId, values.password));
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinish = async (values: Record<string, string>) => {
    if (step === 0) return handleStart(values as unknown as StartForm);
    if (step === 1) return handleCode(values as { code: string });
    if (step === 2) return handlePassword(values as { password: string });
    return undefined;
  };

  const appDelivery = !!delivery && delivery.includes('App');

  return (
    <Modal
      open={open}
      title={account ? `重新登录：${account.phone_masked}` : '新建账号并登录'}
      onCancel={onCancel}
      onOk={() => {
        if (step === 3) {
          onCancel();
          return;
        }
        form.submit();
      }}
      okText={step === 3 ? '完成' : step === 1 ? '提交验证码' : step === 2 ? '提交两步密码' : '发送验证码'}
      cancelText={step === 3 ? '关闭' : '取消'}
      confirmLoading={submitting}
      maskClosable={false}
      width={520}
    >
      <Steps
        size="small"
        current={Math.min(step, 2)}
        status={step === 3 ? 'finish' : 'process'}
        items={[{ title: '手机号' }, { title: '验证码' }, { title: '两步密码' }]}
        style={{ marginBottom: 20 }}
      />

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      {message ? (
        <Alert
          type={step === 3 ? 'success' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={message}
          description={taskId ? <Typography.Text type="secondary">关联任务 {taskId}</Typography.Text> : null}
        />
      ) : null}

      {step === 1 && delivery ? (
        <Alert
          type={appDelivery ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            appDelivery
              ? '验证码发到了 Telegram 客户端，不是短信'
              : `验证码已通过「${delivery}」发送`
          }
          description={
            appDelivery
              ? nextType
                ? `请打开这个号已登录的 Telegram 客户端，进官方「Telegram」聊天（777000）查看；Telegram 还提供「${nextType}」作为备选。`
                : '请打开这个号已登录的 Telegram 客户端，进官方「Telegram」聊天（777000）查看。Telegram 没有给这个号提供短信备选，重发也只会再发到客户端；如果找不到任何已登录设备，请改用扫码登录。'
              : '请留意对应渠道；没收到可以等倒计时结束后重发。'
          }
        />
      ) : null}

      <Form form={form} layout="vertical" onFinish={handleFinish} autoComplete="off">
        {step === 0 ? (
          <>
            <Form.Item
              label="完整手机号（带国家码）"
              name="phone"
              initialValue=""
              rules={[{ required: !account, message: '请输入完整手机号' }]}
              extra={
                account
                  ? '可以留空：后端会用库里加密保存的号码发起登录；填了则以填的为准。发送方式是短信还是 Telegram 客户端，由 Telegram 决定。'
                  : '只登录这个号自己，不导入别人的会话文件。发送方式是短信还是 Telegram 客户端，由 Telegram 决定。'
              }
            >
              <Input placeholder={account ? '留空则用库里保存的号码' : '+12025550143'} allowClear />
            </Form.Item>
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
          </>
        ) : null}

        {step === 1 ? (
          <Form.Item
            label="Telegram 发来的验证码"
            name="code"
            rules={[{ required: true, message: '请输入验证码' }]}
            extra="只填这个号收到的码；没收到先看该号已登录客户端的官方「Telegram」聊天（777000）。"
          >
            <Input placeholder="12345" allowClear autoFocus />
          </Form.Item>
        ) : null}

        {step === 1 ? (
          <Button type="link" size="small" onClick={handleResend} loading={submitting} style={{ padding: 0 }}>
            没收到？重新发送验证码
          </Button>
        ) : null}

        {step === 2 ? (
          <Form.Item
            label="两步验证密码"
            name="password"
            rules={[{ required: true, message: '请输入两步验证密码' }]}
            extra="这个号开了两步验证，需要补一次密码才能拿到会话。"
          >
            <Input.Password placeholder="两步验证密码" autoFocus />
          </Form.Item>
        ) : null}

        {step === 3 ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            会话已加密写回 tg_accounts.session_enc。可以点「单号检测」确认它能连上。
          </Typography.Paragraph>
        ) : null}
      </Form>
    </Modal>
  );
}

export default AccountLoginWizard;
