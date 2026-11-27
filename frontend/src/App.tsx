/**
 * 应用入口：主题 Provider → antd ConfigProvider → 消息桥 → 路由。
 *
 * 全局体验（不白屏的四道保险）：
 *  1. ErrorBoundary（最外层，兜住 Provider / 路由级异常）
 *  2. 每个页面各自的 ErrorBoundary + Suspense 骨架（见 AppShell）
 *  3. 页面内的 ErrorState / EmptyState（见各页面与共享组件）
 *  4. api/client 的统一中文错误提示（含 401 自动回登录页）
 *
 * 路由级懒加载：12 个页面各自成 chunk，首屏只加载工作台。
 */
import { lazy, Suspense, useEffect } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider, useTheme } from './theme';
import { normalizeLocale } from './i18n';
import { AuthProvider } from './auth/AuthContext';
import { bindMessageApi, bindNotificationApi } from './utils/feedback';
import { AdminHome, AppShell, RequireAdmin, RequireAuth } from './components/shell/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NotFound } from './components/NotFound';
import { PageSkeleton } from './components/LoadingSkeleton';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Groups = lazy(() => import('./pages/Groups'));
const Network = lazy(() => import('./pages/Network'));
const Dialogs = lazy(() => import('./pages/Dialogs'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const GroupIntel = lazy(() => import('./pages/GroupIntel'));
const Assignments = lazy(() => import('./pages/Assignments'));
const Audit = lazy(() => import('./pages/Audit'));
/**
 * 组件库预览：仅开发环境注册（见 components/DevComponentPreview.tsx）。
 * 写成三元表达式是为了让生产构建能把这段动态 import 整块 DCE 掉，不产生多余 chunk。
 */
const DevComponentPreview = import.meta.env.DEV
  ? lazy(() => import('./components/DevComponentPreview'))
  : null;

/** 把 antd 的 message/notification 实例交给非组件代码（fetch 封装、toast 工具） */
function FeedbackBridge() {
  const { message, notification } = AntdApp.useApp();
  useEffect(() => {
    bindMessageApi(message);
    bindNotificationApi(notification);
    return () => {
      bindMessageApi(null);
      bindNotificationApi(null);
    };
  }, [message, notification]);
  return null;
}

/**
 * 路由表（侧栏显示名 → 路径）：
 * 工作台 /、任务中心 /tasks、账号管理 /accounts、账号分组 /groups、
 * 网络 /network、会话 /dialogs、员工分配 /assignments、
 * 操作记录 /audit；登录 /login。
 */
function ThemedApp() {
  const { antdTheme } = useTheme();
  const { i18n } = useTranslation();
  const antdLocale = normalizeLocale(i18n.language) === 'en-US' ? enUS : zhCN;
  return (
    <ConfigProvider locale={antdLocale} theme={antdTheme}>
      <AntdApp>
        <FeedbackBridge />
        {/* future 标志：提前采用 v7 行为，消掉两个弃用警告
            （v7_startTransition 用 startTransition 包装状态更新；v7_relativeSplatPath 统一相对路径解析） */}
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ErrorBoundary>
            <AuthProvider>
              <Routes>
                <Route
                  path="/login"
                  element={
                    <Suspense fallback={<div className="app-center"><PageSkeleton title={false} /></div>}>
                      <Login />
                    </Suspense>
                  }
                />
                <Route
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  {/* operator 只保留：任务中心 / 触达中心 / 会话 / 群情报；
                      其余管理员页面由 RequireAdmin 给 403，工作台直接把 operator 送到任务中心 */}
                  <Route
                    path="/"
                    element={
                      <AdminHome>
                        <Dashboard />
                      </AdminHome>
                    }
                  />
                  <Route path="/tasks" element={<Tasks />} />
                  <Route path="/campaigns" element={<Navigate to="/campaigns/materials" replace />} />
                  <Route path="/campaigns/:section" element={<Campaigns />} />
                  <Route path="/group-intel" element={<GroupIntel />} />
                  <Route
                    path="/accounts"
                    element={
                      <RequireAdmin>
                        <Accounts />
                      </RequireAdmin>
                    }
                  />
                  <Route
                    path="/groups"
                    element={
                      <RequireAdmin>
                        <Groups />
                      </RequireAdmin>
                    }
                  />
                  <Route
                    path="/network"
                    element={
                      <RequireAdmin>
                        <Network />
                      </RequireAdmin>
                    }
                  />
                  <Route path="/dialogs" element={<Dialogs />} />
                  <Route
                    path="/inbox"
                    element={
                      <RequireAdmin>
                        <Inbox />
                      </RequireAdmin>
                    }
                  />
                  <Route
                    path="/assignments"
                    element={
                      <RequireAdmin>
                        <Assignments />
                      </RequireAdmin>
                    }
                  />
                  <Route
                    path="/audit"
                    element={
                      <RequireAdmin>
                        <Audit />
                      </RequireAdmin>
                    }
                  />
                  {/* 开发环境专属：共享组件库预览（生产构建不注册） */}
                  {DevComponentPreview ? (
                    <Route
                      path="/__components"
                      element={
                        <RequireAdmin>
                          <DevComponentPreview />
                        </RequireAdmin>
                      }
                    />
                  ) : null}
                  {/* 登录后的未知地址：给一个可读的 404，而不是静默跳回工作台 */}
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AuthProvider>
          </ErrorBoundary>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  );
}
