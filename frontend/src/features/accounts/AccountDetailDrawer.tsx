/**
 * AccountDetailDrawer —— 账号详情抽屉（/api/accounts/{id}/overview 一次拿全）。
 *
 * 分区：基本信息 / 状态与租约 / 统计 / 最近会话 / 最近消息 / 最近任务 / 最近审计；
 * 底部操作条由页面传入 handler（返回 Promise 时抽屉自动重新加载概览）。
 */
import { useState } from 'react';
import { Button, Space, Tooltip } from 'antd';
import {
  CloudSyncOutlined,
  DeleteOutlined,
  EditOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { accountApi } from '../../api/endpoints';
import { useAsyncData } from '../../hooks/useAsyncData';
import { resolveEnumLabel } from '../../i18n';
import { formatAccountAge, formatTime, previewText } from '../../utils/format';
import {
  CurrentTaskTag,
  DetailDrawer,
  MessageStatusTag,
  RelativeTime,
  StatusBadge,
  TaskStatusTag,
  TaskTypeTag,
} from '../../components';
import type { AccountOut, AccountOverviewOut } from '../../api/types';

export interface AccountDetailHandlers {
  onCheck: (account: AccountOut) => Promise<void> | void;
  onSync: (account: AccountOut) => Promise<void> | void;
  onEdit: (account: AccountOut) => void;
  onProfile: (account: AccountOut) => void;
  onReleaseLease: (account: AccountOut) => Promise<void> | void;
  onToggleEnabled: (account: AccountOut) => Promise<void> | void;
  onRemove: (account: AccountOut) => Promise<void> | void;
}

interface Props {
  accountId: string | null;
  handlers: AccountDetailHandlers;
  onClose: () => void;
}

/** 可折叠分区：点标题展开/收起。
 *
 *  详情里五个分区平铺下来很长，翻到「最近审计」要滚好几屏；
 *  而「最近消息」这类内容多数时候只是扫一眼，不需要常驻占位。
 *  默认只把审计折叠起来（它最长、最不常看），其余保持展开不改变原有习惯。
 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="tg-detail-section">
      <button type="button" className="tg-detail-section-title tg-collapsible" onClick={() => setOpen((prev: boolean) => !prev)}>
        <span className="tg-collapse-caret">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

function StatCell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div
      style={{
        background: 'var(--tg-color-bg-sunken)',
        border: '1px solid var(--tg-color-border-subtle)',
        borderRadius: 'var(--tg-radius-md)',
        padding: 'var(--tg-space-md) var(--tg-space-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--tg-space-xxs)',
      }}
    >
      <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
        {label}
      </span>
      <span className="tg-num" style={{ fontSize: 'var(--tg-font-size-lg)', fontWeight: 'var(--tg-font-weight-semibold)', color: `var(--tg-color-${tone})` }}>
        {value}
      </span>
    </div>
  );
}

export default function AccountDetailDrawer({ accountId, handlers, onClose }: Props) {
  const { t } = useTranslation(['accounts', 'common', 'enums']);
  const { data, loading, error, reload } = useAsyncData(
    () => (accountId ? accountApi.overview(accountId) : Promise.resolve(null)),
    [accountId],
  );

  const overview: AccountOverviewOut | null = data;
  const account = overview?.account ?? null;

  const run = async (fn: (account: AccountOut) => Promise<void> | void) => {
    if (!account) return;
    await fn(account);
    void reload();
  };

  return (
    <DetailDrawer
      open={Boolean(accountId)}
      onClose={onClose}
      width={680}
      title={account?.phone_masked ?? t('accounts:detail.titleFallback')}
      subtitle={
        account ? (
          <span className="tg-flex" style={{ gap: 'var(--tg-space-md)', alignItems: 'center' }}>
            {account.username ? `@${account.username}` : null}
            <StatusBadge status={account.status} label={account.status_label} reason={account.status_reason || account.last_error} size="sm" />
          </span>
        ) : null
      }
      loading={loading}
      error={error}
      onRetry={() => void reload()}
      sections={
        account
          ? [
              {
                title: t('accounts:detail.sections.basic'),
                items: [
                  {
                    label: t('accounts:detail.fields.phone'),
                    // 不脱敏：直接给完整号码；没有手机号的号（tdata / 会话导入）说明原因，
                    // 而不是丢一个导入标签（如 tdata#0）让人以为号码坏了
                    value:
                      account.phone ||
                      (account.phone_masked && /^\+?\d/.test(account.phone_masked)
                        ? account.phone_masked
                        : account.tg_user_id
                          ? t('accounts:detail.fields.importedWithoutPhone', { id: account.tg_user_id })
                          : account.phone_masked || '—'),
                    mono: true,
                  },
                  { label: t('accounts:detail.fields.username'), value: account.username || '—' },
                  { label: t('accounts:detail.fields.userId'), value: account.tg_user_id ? String(account.tg_user_id) : '—', mono: true },
                  { label: t('accounts:detail.fields.displayName'), value: account.display_name || '—' },
                  { label: t('accounts:detail.fields.age'), value: formatAccountAge(account.age_days) },
                  { label: t('accounts:detail.fields.groupCount'), value: account.group_count },
                  { label: t('accounts:detail.fields.group'), value: account.group_name || t('accounts:columns.ungrouped') },
                  { label: t('accounts:detail.fields.proxy'), value: account.proxy_endpoint || t('accounts:columns.direct'), mono: true },
                  { label: t('accounts:detail.fields.remark'), value: account.remark || '—', span: 'full' },
                  { label: t('accounts:detail.fields.createdAt'), value: formatTime(account.created_at), span: 'full' },
                ],
              },
              {
                title: t('accounts:detail.sections.statusLease'),
                items: [
                  {
                    label: t('accounts:detail.fields.currentTask'),
                    value: <CurrentTaskTag task={account.current_task} label={account.current_task_label} size="sm" />,
                  },
                  { label: t('accounts:detail.fields.lastHeartbeat'), value: <RelativeTime value={account.last_heartbeat} /> },
                  {
                    label: t('accounts:detail.fields.leaseWorker'),
                    value: overview?.lease?.worker_id ?? '—',
                    mono: true,
                  },
                  {
                    label: t('accounts:detail.fields.leaseUntil'),
                    value: overview?.lease?.lease_until ? <RelativeTime value={overview.lease.lease_until} /> : '—',
                  },
                  {
                    label: t('accounts:detail.fields.leaseStatus'),
                    value: overview?.lease?.active ? t('accounts:detail.fields.leaseActive') : t('accounts:detail.fields.leaseInactive'),
                  },
                  { label: t('accounts:detail.fields.lastCheckedAt'), value: formatTime(account.last_checked_at) },
                  {
                    label: t('accounts:detail.fields.lastError'),
                    span: 'full',
                    value: account.last_error ? (
                      <Tooltip title={account.last_error} placement="topLeft">
                        <span className="tg-clamp-cell tg-text-danger">{account.last_error}</span>
                      </Tooltip>
                    ) : (
                      '—'
                    ),
                  },
                ],
              },
            ]
          : []
      }
      footer={
        account ? (
          <Space wrap>
            <Button size="small" icon={<SafetyCertificateOutlined />} onClick={() => void run(handlers.onCheck)}>
              {t('accounts:actions.check')}
            </Button>
            <Button size="small" icon={<CloudSyncOutlined />} onClick={() => void run(handlers.onSync)}>
              {t('accounts:actions.syncDialogs')}
            </Button>
            <Button size="small" icon={<EditOutlined />} onClick={() => handlers.onEdit(account)}>
              {t('accounts:actions.editGroupProxy')}
            </Button>
            <Button size="small" icon={<UserSwitchOutlined />} onClick={() => handlers.onProfile(account)}>
              {t('accounts:actions.editProfile')}
            </Button>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => void run(handlers.onReleaseLease)}>
              {t('accounts:actions.releaseLease')}
            </Button>
            <Button
              size="small"
              icon={<StopOutlined />}
              danger={account.status !== 'disabled'}
              onClick={() => void run(handlers.onToggleEnabled)}
            >
              {account.status === 'disabled' ? t('accounts:actions.enable') : t('accounts:actions.disable')}
            </Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void run(handlers.onRemove)}>
              {t('accounts:actions.delete')}
            </Button>
          </Space>
        ) : null
      }
    >
      {overview ? (
        <div className="tg-stack" style={{ gap: 'var(--tg-space-xl)' }}>
          <CollapsibleSection title={t('accounts:detail.sections.stats')} defaultOpen={true}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 'var(--tg-space-md)',
              }}
            >
              <StatCell label={t('accounts:detail.stats.totalDialogs')} value={overview.dialog_stats.total} tone="primary" />
              <StatCell label={t('accounts:detail.stats.groupDialogs')} value={overview.dialog_stats.group} tone="info" />
              <StatCell label={t('accounts:detail.stats.unreadDialogs')} value={overview.dialog_stats.unread} tone="warning" />
              <StatCell label={t('accounts:detail.stats.failedTasks')} value={overview.task_stats.failed} tone="danger" />
            </div>
            <div
              className="tg-muted"
              style={{
                marginTop: 'var(--tg-space-md)',
                fontSize: 'var(--tg-font-size-xs)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--tg-space-lg)',
              }}
            >
              <span>
                {t('accounts:detail.stats.taskSummaryPrimary', {
                  pending: overview.task_stats.pending,
                  running: overview.task_stats.running,
                  completed: overview.task_stats.completed,
                })}
              </span>
              <span>
                {t('accounts:detail.stats.taskSummarySecondary', {
                  pendingConfirmation: overview.task_stats.pending_confirmation,
                  cancelled: overview.task_stats.cancelled,
                })}
              </span>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title={t('accounts:detail.sections.recentDialogs')} defaultOpen={true}>
            {overview.recent_dialogs.length ? (
              <div className="tg-stack" style={{ gap: 'var(--tg-space-sm)' }}>
                {overview.recent_dialogs.map((dialog) => (
                  <div
                    key={dialog.id}
                    style={{
                      background: 'var(--tg-color-bg-sunken)',
                      border: '1px solid var(--tg-color-border-subtle)',
                      borderRadius: 'var(--tg-radius-md)',
                      padding: 'var(--tg-space-md) var(--tg-space-lg)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--tg-space-md)',
                    }}
                  >
                    <span className="tg-ellipsis">{dialog.title || dialog.peer_display}</span>
                    <span className="tg-muted tg-nowrap" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                      {resolveEnumLabel(`dialogKind.${dialog.kind}`, dialog.kind_label, dialog.kind)} ·{' '}
                      {t('accounts:detail.unreadCount', { count: dialog.unread_count })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tg-muted">{t('accounts:detail.emptyDialogs')}</div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title={t('accounts:detail.sections.recentMessages')} defaultOpen={true}>
            {overview.recent_messages.length ? (
              <div className="tg-stack" style={{ gap: 'var(--tg-space-sm)' }}>
                {overview.recent_messages.map((message) => {
                  const dirKey = message.direction === 'incoming' ? 'in' : message.direction === 'outgoing' ? 'out' : message.direction;
                  return (
                    <div
                      key={message.id}
                      style={{
                        background: 'var(--tg-color-bg-sunken)',
                        border: '1px solid var(--tg-color-border-subtle)',
                        borderRadius: 'var(--tg-radius-md)',
                        padding: 'var(--tg-space-md) var(--tg-space-lg)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--tg-space-xxs)',
                      }}
                    >
                      <span className="tg-flex-between" style={{ gap: 'var(--tg-space-md)' }}>
                        <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                          {resolveEnumLabel(`messageDirection.${dirKey}`, message.direction_label, message.direction)} · {message.sender_name}
                        </span>
                        <span style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                          <MessageStatusTag status={message.status} label={message.status_label} size="sm" />
                        </span>
                      </span>
                      <span className="tg-clamp-2" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                        {previewText(message.body, 120)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="tg-muted">{t('accounts:detail.emptyMessages')}</div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title={t('accounts:detail.sections.recentTasks')} defaultOpen={true}>
            {overview.recent_tasks.length ? (
              <div className="tg-stack" style={{ gap: 'var(--tg-space-sm)' }}>
                {overview.recent_tasks.map((task) => (
                  <div
                    key={task.id}
                    style={{
                      background: 'var(--tg-color-bg-sunken)',
                      border: '1px solid var(--tg-color-border-subtle)',
                      borderRadius: 'var(--tg-radius-md)',
                      padding: 'var(--tg-space-md) var(--tg-space-lg)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--tg-space-md)',
                    }}
                  >
                    <TaskTypeTag type={task.type} label={task.type_label} size="sm" />
                    <TaskStatusTag status={task.status} label={task.status_label} size="sm" />
                    <span className="tg-muted tg-nowrap" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                      <RelativeTime value={task.created_at} />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tg-muted">{t('accounts:detail.emptyTasks')}</div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title={t('accounts:detail.sections.recentAudit')} defaultOpen={false}>
            {overview.recent_audit.length ? (
              <div className="tg-stack" style={{ gap: 'var(--tg-space-sm)' }}>
                {overview.recent_audit.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      background: 'var(--tg-color-bg-sunken)',
                      border: '1px solid var(--tg-color-border-subtle)',
                      borderRadius: 'var(--tg-radius-md)',
                      padding: 'var(--tg-space-md) var(--tg-space-lg)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--tg-space-md)',
                    }}
                  >
                    <span className="tg-ellipsis" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                      {resolveEnumLabel(`auditAction.${entry.action}`, entry.action_label, entry.action)} · {entry.user_name ?? '—'}
                    </span>
                    <span className="tg-muted tg-nowrap" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                      <RelativeTime value={entry.created_at} />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tg-muted">{t('accounts:detail.emptyAudit')}</div>
            )}
          </CollapsibleSection>
        </div>
      ) : null}
    </DetailDrawer>
  );
}
