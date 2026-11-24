/**
 * 登录页：单卡居中，只保留登录所需信息。
 *
 * 交互细节：
 * - 回车提交、自动聚焦用户名、口令可切换可见；
 * - 登录中按钮 loading 并禁用表单，避免重复提交；
 * - 错误提示内联展示（后端 detail 已是中文），登录成功后回到离开前的页面；
 * - 「记住用户名」写 localStorage，只记账号不记口令。
 */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, Form, Input } from 'antd';
import { ExclamationCircleOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { readRememberedUsername, writeRememberedUsername } from '../features/auth/rememberUsername';

interface LoginForm {
  username: string;
  password: string;
  remember: boolean;
}

const ENV_LABEL: Record<string, string> = {
  development: '本地开发',
  production: '生产环境',
};

/** 品牌标记：纸飞机描边，跟随主色 */
function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21.4 3.2 3.6 10.3c-.8.3-.8 1.4 0 1.7l4.6 1.5 1.8 5.4c.3.8 1.2 1 1.8.4l2.6-2.5 4.6 3.2c.6.4 1.4.1 1.6-.6l3-13.6c.2-.9-.7-1.6-1.6-1.3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Login() {
  const { login, user, ready } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const envMode = import.meta.env.MODE;
  const remembered = readRememberedUsername();

  if (ready && user) return <Navigate to={from} replace />;

  const handleFinish = async (values: LoginForm) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.username, values.password);
      writeRememberedUsername(values.remember ? values.username.trim() : null);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        // 401 账号或口令不对、403 员工被停用：后端 detail 已是中文
        setError(err.detail || err.friendlyMessage || '登录失败，请稍后重试');
      } else {
        setError('登录失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <main className="login-card">
        <div className="login-brandline">
          <span className="login-brand-mark">
            <BrandMark />
          </span>
          <span className="login-wordmark">wikifxtg云控</span>
          {envMode !== 'production' ? (
            <span className="login-env">{ENV_LABEL[envMode] ?? envMode}</span>
          ) : null}
        </div>

        <header className="login-head">
          <h1 className="login-title">欢迎回来</h1>
          <p className="login-subtitle">使用管理员分配的账号进入控制台</p>
        </header>

        {error ? (
          <Alert
            type="error"
            showIcon
            closable
            className="login-error"
            message={error}
            onClose={() => setError(null)}
          />
        ) : null}

        <Form<LoginForm>
          className="login-form"
          layout="vertical"
          onFinish={handleFinish}
          autoComplete="off"
          requiredMark={false}
          disabled={submitting}
          initialValues={{ username: remembered ?? '', remember: Boolean(remembered) }}
        >
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="输入用户名" size="large" autoComplete="username" autoFocus />
          </Form.Item>

          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="输入密码"
              size="large"
              autoComplete="current-password"
              onKeyUp={(event) => setCapsLock(event.getModifierState?.('CapsLock') ?? false)}
              onBlur={() => setCapsLock(false)}
            />
          </Form.Item>

          {capsLock ? (
            <div className="login-capslock">
              <ExclamationCircleOutlined /> 大写锁定已打开
            </div>
          ) : null}

          <div className="login-row">
            <Form.Item name="remember" valuePropName="checked" noStyle>
              <Checkbox>记住用户名</Checkbox>
            </Form.Item>
            <span className="login-note">忘记密码请联系管理员</span>
          </div>

          <Button
            className="login-submit"
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
          >
            {submitting ? '正在登录…' : '登录'}
          </Button>
        </Form>

        <div className="login-foot">{typeof __APP_VERSION__ === 'string' ? `v${__APP_VERSION__}` : ''}</div>
      </main>
    </div>
  );
}
