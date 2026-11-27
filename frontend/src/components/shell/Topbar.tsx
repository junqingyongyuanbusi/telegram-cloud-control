/**
 * Topbar —— 顶栏：面包屑 + 全局搜索入口 + 实时连接状态 + 主题开关 + 通知铃铛 + 用户菜单。
 *
 * props 契约：
 * ┌──────────────────┬──────────────────────────────────────────────────────────┐
 * │ breadcrumb       │ {title, href?}[]  当前页面路径（由 AppShell 按路由推导）   │
 * │ onToggleSidebar  │ () => void  折叠/展开侧栏（窄屏是打开抽屉）               │
 * │ sidebarCollapsed │ boolean                                                │
 * │ isNarrow         │ boolean  窄屏下隐藏文字，只留图标                         │
 * │ onOpenSearch     │ () => void                                              │
 * │ searchShortcut   │ string  显示的快捷键提示，默认 '⌘K' / 'Ctrl K'           │
 * │ wsStatus         │ WsStatus                                                │
 * │ notifications    │ NotificationBell 的一组 props（透传）                     │
 * │ user             │ UserMenu 的一组 props（透传）                             │
 * └──────────────────┴──────────────────────────────────────────────────────────┘
 */
import { Link } from 'react-router-dom';
import { Tooltip } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ConnectionStatus from './ConnectionStatus';
import LanguageToggle from './LanguageToggle';
import NotificationBell, { type NotificationBellProps } from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import UserMenu, { type UserMenuProps } from './UserMenu';
import type { WsStatus } from '../../api/types';

export interface TopbarProps {
  breadcrumb: Array<{ title: string; href?: string }>;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  isNarrow: boolean;
  onOpenSearch: () => void;
  searchShortcut?: string;
  wsStatus?: WsStatus;
  notifications?: NotificationBellProps;
  user?: UserMenuProps;
}

export function Topbar({
  breadcrumb,
  onToggleSidebar,
  sidebarCollapsed,
  isNarrow,
  onOpenSearch,
  searchShortcut = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K',
  wsStatus,
  notifications,
  user,
}: TopbarProps) {
  const { t } = useTranslation('shell');
  return (
    <header className="app-topbar">
      <div className="app-topbar-left">
        <button
          type="button"
          className="app-icon-button"
          onClick={onToggleSidebar}
          aria-label={isNarrow ? t('nav.openNav') : sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
        >
          {sidebarCollapsed || isNarrow ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>

        <nav className="app-breadcrumb" aria-label={t('topbar.breadcrumbAria')}>
          {breadcrumb.map((crumb, index) => (
            <span key={`${crumb.title}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--tg-space-sm)' }}>
              {index > 0 ? <span className="app-breadcrumb-sep">/</span> : null}
              {index === breadcrumb.length - 1 ? (
                <span className="app-breadcrumb-current">{crumb.title}</span>
              ) : crumb.href ? (
                <Link to={crumb.href} className="app-breadcrumb-link">
                  {crumb.title}
                </Link>
              ) : (
                <span>{crumb.title}</span>
              )}
            </span>
          ))}
        </nav>
      </div>

      <div className="app-topbar-right">
        <Tooltip title={t('topbar.globalSearchShortcut', { shortcut: searchShortcut })}>
          <button type="button" className="app-search-trigger" onClick={onOpenSearch} aria-label={t('topbar.globalSearch')}>
            <SearchOutlined />
            <span className="app-search-text">{t('topbar.searchPlaceholder')}</span>
            <span className="tg-kbd">{searchShortcut}</span>
          </button>
        </Tooltip>

        <ConnectionStatus status={wsStatus} showText={!isNarrow} />

        <span className="app-topbar-divider" />

        <LanguageToggle />
        <ThemeToggle />

        {notifications ? <NotificationBell {...notifications} /> : null}

        <span className="app-topbar-divider" />

        {user ? <UserMenu {...user} /> : null}
      </div>
    </header>
  );
}

export default Topbar;
