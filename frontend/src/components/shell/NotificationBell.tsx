/**
 * NotificationBell —— 顶栏通知铃铛 + 通知面板。
 *
 * props 契约：
 * ┌──────────────┬────────────────────────────────────────────────────────────┐
 * │ items        │ NotificationOut[]  通知列表（useShellData 提供）            │
 * │ unread       │ number  未读数（角标）                                      │
 * │ loading      │ boolean                                                 │
 * │ derived      │ boolean  true 表示列表是按 dashboard 派生的（后端通知接口未就绪）│
 * │ onRefresh    │ () => void                                              │
 * │ onMarkRead   │ (id) => void                                            │
 * │ onMarkAllRead│ () => void                                              │
 * │ onNavigate   │ (link) => void  点击通知跳转                             │
 * └──────────────┴────────────────────────────────────────────────────────────┘
 * 空态、失败态、加载态都在面板内处理，不会白屏。
 */
import { Badge, Button, Empty, Popover, Spin, Tooltip, Typography } from 'antd';
import { BellOutlined, CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import RelativeTime from '../RelativeTime';
import type { NotificationOut } from '../../api/types';
import { NOTIFICATION_LEVEL_TONE } from '../../constants';
import { resolveEnumLabel } from '../../i18n';

export interface NotificationBellProps {
  items: NotificationOut[];
  unread: number;
  loading?: boolean;
  derived?: boolean;
  onRefresh?: () => void;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  onNavigate?: (link: string) => void;
}

export function NotificationBell({
  items,
  unread,
  loading = false,
  derived = false,
  onRefresh,
  onMarkRead,
  onMarkAllRead,
  onNavigate,
}: NotificationBellProps) {
  const { t } = useTranslation(['shell', 'common']);
  const content = (
    <div className="tg-notif-panel">
      <div className="tg-notif-head">
        <Typography.Text strong>{t('shell:notifications.title')}</Typography.Text>
        <span className="tg-flex" style={{ gap: 'var(--tg-space-xs)' }}>
          {unread > 0 && onMarkAllRead ? (
            <Button type="link" size="small" icon={<CheckOutlined />} onClick={onMarkAllRead}>
              {t('shell:notifications.markAllRead')}
            </Button>
          ) : null}
          {onRefresh ? (
            <Tooltip title={t('common:refresh')}>
              <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRefresh} aria-label={t('shell:notifications.refreshAria')} />
            </Tooltip>
          ) : null}
        </span>
      </div>

      {derived ? (
        <div className="tg-notif-item" style={{ cursor: 'default', background: 'transparent' }}>
          <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {t('shell:notifications.derivedBanner')}
          </Typography.Text>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div style={{ padding: 'var(--tg-space-xxl)', textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('shell:notifications.empty')} style={{ padding: 'var(--tg-space-xl) 0' }} />
      ) : (
        <div className="tg-notif-list">
          {items.map((item) => {
            const tone = NOTIFICATION_LEVEL_TONE[item.level] ?? 'info';
            const kindText = resolveEnumLabel(`notificationKind.${item.kind}`, item.kind_label);
            return (
              <div
                key={item.id}
                className={['tg-notif-item', item.read ? '' : 'is-unread'].filter(Boolean).join(' ')}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!item.read) onMarkRead?.(item.id);
                  if (item.link) onNavigate?.(item.link);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    if (!item.read) onMarkRead?.(item.id);
                    if (item.link) onNavigate?.(item.link);
                  }
                }}
              >
                <span
                  className="tg-status-dot"
                  style={{
                    width: 8,
                    height: 8,
                    marginTop: 6,
                    background: `var(--tg-color-${tone})`,
                    color: `var(--tg-color-${tone})`,
                  }}
                />
                <div className="tg-notif-main">
                  <div className="tg-notif-title">{item.title}</div>
                  {item.body ? <div className="tg-notif-body">{item.body}</div> : null}
                  <div className="tg-notif-time" style={{ marginTop: 4 }}>
                    {kindText ? <span style={{ marginRight: 8 }}>{kindText}</span> : null}
                    <RelativeTime value={item.created_at} refreshMs={60_000} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Popover content={content} trigger="click" placement="bottomRight" arrow={false} styles={{ body: { padding: 'var(--tg-space-lg)' } }}>
      <Tooltip title={t('shell:notifications.title')}>
        <button
          type="button"
          className="app-icon-button"
          aria-label={unread ? t('shell:notifications.unreadAria', { count: unread }) : t('shell:notifications.title')}
        >
          <Badge count={unread} size="small" offset={[2, -2]}>
            <BellOutlined style={{ fontSize: 16 }} />
          </Badge>
        </button>
      </Tooltip>
    </Popover>
  );
}

export default NotificationBell;
