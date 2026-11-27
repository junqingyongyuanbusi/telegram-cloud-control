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
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { readRememberedUsername, writeRememberedUsername } from '../features/auth/rememberUsername';
import LanguageToggle from '../components/shell/LanguageToggle';
import ThemeToggle from '../components/shell/ThemeToggle';

interface LoginForm {
  username: string;
  password: string;
  remember: boolean;
}

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
  const { t } = useTranslation(['login', 'common']);
  const { login, user, ready } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const envMode = import.meta.env.MODE;
  const envLabel =
    envMode === 'development'
      ? t('login:envDevelopment')
      : envMode === 'production'
        ? t('login:envProduction')
        : envMode;
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
        setError(err.detail || err.friendlyMessage || t('login:loginFailed'));
      } else {
        setError(t('login:loginFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 20,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          zIndex: 10,
        }}
      >
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <main className="login-card">
        <div className="login-brandline">
          <span className="login-brand-mark">
            <BrandMark />
          </span>
          <span className="login-wordmark">{t('common:appTitle')}</span>
          {envMode !== 'production' ? <span className="login-env">{envLabel}</span> : null}
        </div>

        <header className="login-head">
          <h1 className="login-title">{t('login:welcomeTitle')}</h1>
          <p className="login-subtitle">{t('login:welcomeSubtitle')}</p>
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
          <Form.Item
            label={t('login:usernameLabel')}
            name="username"
            rules={[{ required: true, message: t('login:usernameRequired') }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder={t('login:usernamePlaceholder')}
              size="large"
              autoComplete="username"
              autoFocus
            />
          </Form.Item>

          <Form.Item
            label={t('login:passwordLabel')}
            name="password"
            rules={[{ required: true, message: t('login:passwordRequired') }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder={t('login:passwordPlaceholder')}
              size="large"
              autoComplete="current-password"
              onKeyUp={(event) => setCapsLock(event.getModifierState?.('CapsLock') ?? false)}
              onBlur={() => setCapsLock(false)}
            />
          </Form.Item>

          {capsLock ? (
            <div className="login-capslock">
              <ExclamationCircleOutlined /> {t('login:capsLockOn')}
            </div>
          ) : null}

          <div className="login-row">
            <Form.Item name="remember" valuePropName="checked" noStyle>
              <Checkbox>{t('login:rememberUsername')}</Checkbox>
            </Form.Item>
            <span className="login-note">{t('login:forgotPassword')}</span>
          </div>

          <Button
            className="login-submit"
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
          >
            {submitting ? t('login:signingIn') : t('login:signIn')}
          </Button>
        </Form>

        <div className="login-foot">{typeof __APP_VERSION__ === 'string' ? `v${__APP_VERSION__}` : ''}</div>
      </main>
    </div>
  );
}
