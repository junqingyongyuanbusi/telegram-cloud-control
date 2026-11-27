import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Segmented, Space, Switch, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  FieldTimeOutlined,
  GlobalOutlined,
  MessageOutlined,
  ReloadOutlined,
  LoginOutlined,
  RiseOutlined,
  ScheduleOutlined,
  SendOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { dashboardApi, metricsApi, notificationApi } from '../api/endpoints';
import { useAsyncData, useInterval } from '../hooks/useAsyncData';
import { useBreakpoint } from '../hooks/useMediaQuery';
import { formatTime, isHeartbeatStale } from '../utils/format';
import { toast } from '../utils/feedback';
import {
  DataTable,
  PageContainer,
  RelativeTime,
  SectionCard,
  SoftTag,
  StatCard,
  StatGrid,
  TaskTypeTag,
} from '../components';
import type { FailedTaskOut, MetricsWindow, NotificationOut, WorkerStatus } from '../api/types';
import type { Tone } from '../constants';
import TrendChart from '../features/dashboard/TrendChart';

const REFRESH_MS = 15_000;

/** 从趋势序列里算「环比」：最后一个点相对上一个点的变化百分比 */
function deltaOf(points: { v: number }[]): number | null {
  if (points.length < 2) return null;
  const prev = points[points.length - 2].v;
  const last = points[points.length - 1].v;
  if (!prev) return last > 0 ? 100 : 0;
  return Math.round(((last - prev) / prev) * 100);
}

const QUICK_LINK_SPECS: {
  path: string;
  labelKey: string;
  descKey: string;
  icon: ReactNode;
  tone: Tone;
}[] = [
  { path: '/accounts', labelKey: 'quickLinks.accounts', descKey: 'quickLinks.accountsDesc', icon: <UserOutlined />, tone: 'primary' },
  { path: '/network', labelKey: 'quickLinks.network', descKey: 'quickLinks.networkDesc', icon: <GlobalOutlined />, tone: 'info' },
  { path: '/tasks', labelKey: 'quickLinks.tasks', descKey: 'quickLinks.tasksDesc', icon: <ScheduleOutlined />, tone: 'warning' },
  { path: '/campaigns', labelKey: 'quickLinks.campaigns', descKey: 'quickLinks.campaignsDesc', icon: <SendOutlined />, tone: 'danger' },
  { path: '/dialogs', labelKey: 'quickLinks.dialogs', descKey: 'quickLinks.dialogsDesc', icon: <MessageOutlined />, tone: 'primary' },
];

export default function Dashboard() {
  const { t } = useTranslation(['dashboard', 'common']);
  const navigate = useNavigate();
  const { isCompact } = useBreakpoint();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [window, setWindow] = useState<MetricsWindow>('24h');
  const [marking, setMarking] = useState(false);

  const { data, loading, error, reload } = useAsyncData(() => dashboardApi.get(), []);
  const trends = useAsyncData(() => metricsApi.trends(window), [window]);
  const notifications = useAsyncData(
    () => notificationApi.list({ unread_only: true, page: 1, page_size: 8 }),
    [],
  );

  useInterval(() => {
    void reload();
    void trends.reload();
    void notifications.reload();
  }, autoRefresh ? REFRESH_MS : null);

  const trendByKey = useMemo(() => {
    const map = new Map<string, { v: number }[]>();
    (trends.data?.series ?? []).forEach((series) => map.set(series.key, series.points));
    return map;
  }, [trends.data]);

  const onlineDelta = deltaOf(trendByKey.get('online_accounts') ?? []);
  const abnormalDelta = deltaOf(trendByKey.get('abnormal_accounts') ?? []);
  const failedDelta = deltaOf(trendByKey.get('tasks_failed') ?? []);

  const staleWorkers = useMemo(
    () => (data?.workers ?? []).filter((worker) => worker.stale || isHeartbeatStale(worker.last_heartbeat)),
    [data],
  );

  const workerColumns: ColumnsType<WorkerStatus> = [
    {
      title: t('dashboard:workers.colWorker'),
      dataIndex: 'worker_id',
      render: (value: string, record) => {
        const stale = record.stale || isHeartbeatStale(record.last_heartbeat);
        return (
          <span className="tg-flex" style={{ alignItems: 'center', gap: 'var(--tg-space-sm)' }}>
            <span className="tg-mono" style={stale ? { color: 'var(--tg-color-danger)', fontWeight: 'var(--tg-font-weight-semibold)' } : undefined}>
              {value || '—'}
            </span>
            {stale ? (
              <SoftTag tone="danger" size="sm">{t('dashboard:workers.statusStale')}</SoftTag>
            ) : (
              <SoftTag tone="success" size="sm">{t('dashboard:workers.statusHealthy')}</SoftTag>
            )}
          </span>
        );
      },
    },
    {
      title: t('dashboard:workers.colLastHeartbeat'),
      dataIndex: 'last_heartbeat',
      width: 150,
      render: (value: string | null, record) => {
        const stale = record.stale || isHeartbeatStale(value);
        return (
          <span style={stale ? { color: 'var(--tg-color-danger)' } : undefined}>
            <RelativeTime value={value} />
          </span>
        );
      },
    },
    { title: t('dashboard:workers.colOnlineAccounts'), dataIndex: 'online_accounts', width: 100, render: (value: number) => <span className="tg-num">{value}</span> },
    { title: t('dashboard:workers.colLeasedAccounts'), dataIndex: 'leased_accounts', width: 110, render: (value: number) => <span className="tg-num">{value}</span> },
    {
      title: t('dashboard:workers.colSource'),
      dataIndex: 'source',
      width: 110,
      render: (value: string) => <SoftTag tone="neutral" size="sm">{value === 'redis' ? t('dashboard:workers.sourceRedis') : value || '—'}</SoftTag>,
    },
  ];

  const failureColumns: ColumnsType<FailedTaskOut> = [
    {
      title: t('dashboard:failures.colTaskType'),
      dataIndex: 'type',
      width: 130,
      render: (_: unknown, record) => <TaskTypeTag type={record.type} label={record.type_label} size="sm" />,
    },
    {
      title: t('dashboard:failures.colAccount'),
      dataIndex: 'account_label',
      width: 130,
      render: (value: string | null) => value || <span className="tg-muted">—</span>,
    },
    {
      title: t('dashboard:failures.colError'),
      dataIndex: 'error',
      render: (value: string) =>
        value ? (
          <Tooltip title={<div style={{ maxWidth: 460, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{value}</div>}>
            <span className="tg-ellipsis" style={{ display: 'inline-block', maxWidth: 360 }}>
              {value}
            </span>
          </Tooltip>
        ) : (
          <span className="tg-muted">—</span>
        ),
    },
    {
      title: t('dashboard:failures.colAttempts'),
      dataIndex: 'attempts',
      width: 90,
      render: (value: number, record) => (
        <span className="tg-num" style={value >= record.max_attempts ? { color: 'var(--tg-color-danger)' } : undefined}>
          {value}/{record.max_attempts}
        </span>
      ),
    },
    {
      title: t('dashboard:failures.colCreatedAt'),
      dataIndex: 'created_at',
      width: 160,
      render: (value: string | null) => <RelativeTime value={value} />,
    },
  ];

  const markRead = async (item: NotificationOut) => {
    setMarking(true);
    try {
      await notificationApi.markRead(item.id);
      void notifications.reload();
      if (item.link) navigate(item.link);
    } catch {
      /* client 已统一提示 */
    } finally {
      setMarking(false);
    }
  };

  const markAllRead = async () => {
    setMarking(true);
    try {
      const res = await notificationApi.markAllRead();
      toast.success(res.message || t('dashboard:notifications.markedAllRead'));
      void notifications.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setMarking(false);
    }
  };

  const queueItems = [
    { key: 'pending', label: t('dashboard:queue.pending'), value: data?.tasks_pending ?? 0, tone: 'info' as const, icon: <ClockCircleOutlined /> },
    { key: 'running', label: t('dashboard:queue.running'), value: data?.tasks_running ?? 0, tone: 'primary' as const, icon: <RiseOutlined /> },
    { key: 'overdue', label: t('dashboard:queue.overdue'), value: data?.tasks_overdue ?? 0, tone: 'warning' as const, icon: <FieldTimeOutlined /> },
    { key: 'stuck', label: t('dashboard:queue.stuck'), value: data?.tasks_stuck ?? 0, tone: 'danger' as const, icon: <ExclamationCircleOutlined /> },
  ];

  return (
    <PageContainer
      title={t('dashboard:title')}
      description={
        data?.generated_at
          ? t('dashboard:descriptionWithTime', { time: formatTime(data.generated_at) })
          : t('dashboard:descriptionDefault')
      }
      actions={
        <Space>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
            {t('dashboard:autoRefresh')} <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </span>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void reload()}>
            {t('common:refresh')}
          </Button>
        </Space>
      }
    >
      {data && data.telegram_ready === false ? (
        <Alert
          type="warning"
          showIcon
          message={t('dashboard:telegramNotReady.message')}
          description={
            <span className="tg-stack" style={{ gap: 'var(--tg-space-xs)' }}>
              <span>
                {t('dashboard:telegramNotReady.introBeforeCode')}
                <code> api_id / api_hash </code>
                {t('dashboard:telegramNotReady.introAfterCode')}
              </span>
              <span>
                {t('dashboard:telegramNotReady.step1BeforeLink')}
                <a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a>
                {t('dashboard:telegramNotReady.step1AfterLink')}
              </span>
              <span>
                {t('dashboard:telegramNotReady.step2BeforeBold')}
                <b>API development tools</b>
                {t('dashboard:telegramNotReady.step2AfterBold')}
              </span>
              <span>
                {t('dashboard:telegramNotReady.step3Part1')}
                <code>api_id</code>
                {t('dashboard:telegramNotReady.step3Part2')}
                <code>api_hash</code>
                {t('dashboard:telegramNotReady.step3Part3')}
                <code> backend/.env </code>
                {t('dashboard:telegramNotReady.step3Part4')}
                <code>make stack-down && make stack-up</code>
                {t('dashboard:telegramNotReady.step3Part5')}
              </span>
              <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                {t('dashboard:telegramNotReady.tip')}
              </span>
            </span>
          }
          style={{ marginBottom: 'var(--tg-layout-page-gap)' }}
        />
      ) : null}

      {data && !loading && (data.total_accounts ?? 0) === 0 ? (
        <Alert
          type="info"
          showIcon
          icon={<LoginOutlined />}
          message={t('dashboard:noAccounts.message')}
          description={t('dashboard:noAccounts.description')}
          action={
            <Space direction={isCompact ? 'vertical' : 'horizontal'}>
              <Button type="primary" onClick={() => navigate('/accounts')}>
                {t('dashboard:noAccounts.loginFirst')}
              </Button>
              <Button onClick={() => navigate('/accounts')}>{t('dashboard:noAccounts.goAccounts')}</Button>
            </Space>
          }
        />
      ) : null}

      <StatGrid>
        <StatCard
          title={t('dashboard:stats.online')}
          value={data?.online_accounts ?? 0}
          unit={<span className="tg-muted">{t('dashboard:stats.onlineUnit', { total: data?.total_accounts ?? 0 })}</span>}
          tone="success"
          icon={<CheckCircleOutlined />}
          delta={onlineDelta === null ? undefined : { value: onlineDelta, goodWhen: 'up' }}
          trend={trendByKey.get('online_accounts')}
          hint={t('dashboard:stats.onlineHint', { count: data?.leased_accounts ?? 0 })}
          onClick={() => navigate('/accounts')}
        />
        <StatCard
          title={t('dashboard:stats.abnormal')}
          value={data?.abnormal_accounts ?? 0}
          tone={data?.abnormal_accounts ? 'danger' : 'success'}
          icon={<WarningOutlined />}
          delta={abnormalDelta === null ? undefined : { value: abnormalDelta, goodWhen: 'down' }}
          trend={trendByKey.get('abnormal_accounts')}
          hint={t('dashboard:stats.abnormalHint')}
          onClick={() => navigate('/accounts?status=abnormal')}
        />
        <StatCard
          title={t('dashboard:stats.failedTasks')}
          value={data?.tasks_failed ?? 0}
          tone={data?.tasks_failed ? 'danger' : 'success'}
          icon={<ExclamationCircleOutlined />}
          delta={failedDelta === null ? undefined : { value: failedDelta, goodWhen: 'down' }}
          trend={trendByKey.get('tasks_failed')}
          hint={t('dashboard:stats.failedTasksHint')}
          onClick={() => navigate('/tasks?only_failed=true')}
        />
        <StatCard
          title={t('dashboard:stats.totalAccounts')}
          value={data?.total_accounts ?? 0}
          tone="primary"
          icon={<ThunderboltOutlined />}
          hint={t('dashboard:stats.totalAccountsHint', {
            dialogs: data?.total_dialogs ?? 0,
            unread: data?.unread_dialogs ?? 0,
            bots: data?.total_bots ?? 0,
          })}
          onClick={() => navigate('/accounts')}
        />
      </StatGrid>

      <SectionCard title={t('dashboard:quickLinks.title')} subtitle={t('dashboard:quickLinks.subtitle')}>
        <div className="tg-quick-grid">
          {QUICK_LINK_SPECS.map((item) => (
            <button
              key={item.path}
              type="button"
              className="tg-quick-link"
              onClick={() => navigate(item.path)}
            >
              <span className={`tg-quick-link-icon is-${item.tone}`}>{item.icon}</span>
              <span className="tg-stack" style={{ gap: 'var(--tg-space-xxs)', minWidth: 0 }}>
                <span className="tg-quick-link-label">{t(`dashboard:${item.labelKey}`)}</span>
                <span className="tg-quick-link-desc tg-ellipsis">{t(`dashboard:${item.descKey}`)}</span>
              </span>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={t('dashboard:trends.title')}
        subtitle={t('dashboard:trends.subtitle')}
        extra={
          <Segmented
            size="small"
            value={window}
            onChange={(value) => setWindow(value as MetricsWindow)}
            options={[
              { value: '24h', label: t('dashboard:trends.window24h') },
              { value: '7d', label: t('dashboard:trends.window7d') },
              { value: '30d', label: t('dashboard:trends.window30d') },
            ]}
          />
        }
        loading={trends.initialLoading}
        error={trends.error}
        onRetry={() => void trends.reload()}
      >
        <TrendChart series={trends.data?.series ?? []} height={280} />
      </SectionCard>

      <div
        style={{
          display: 'grid',
          gap: 'var(--tg-layout-page-gap)',
          gridTemplateColumns: isCompact ? 'minmax(0, 1fr)' : 'minmax(0, 3fr) minmax(0, 2fr)',
        }}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-layout-page-gap)' }}>
          <SectionCard
            title={t('dashboard:workers.title')}
            subtitle={t('dashboard:workers.subtitle')}
            loading={loading && !data}
            error={error}
            onRetry={() => void reload()}
            bodyPadding="none"
            empty={
              !loading && !error && !(data?.workers?.length)
                ? { art: 'network', title: t('dashboard:workers.emptyTitle'), description: t('dashboard:workers.emptyDesc') }
                : false
            }
          >
            {staleWorkers.length ? (
              <Alert
                type="warning"
                showIcon
                style={{ margin: 'var(--tg-space-lg) var(--tg-space-lg) 0' }}
                message={t('dashboard:workers.staleAlertMessage', { count: staleWorkers.length })}
                description={t('dashboard:workers.staleAlertDesc')}
              />
            ) : null}
            <DataTable<WorkerStatus>
              rowKey="worker_id"
              columns={workerColumns}
              dataSource={data?.workers ?? []}
              loading={loading}
              showDensity={false}
              skeletonRows={3}
              empty={{ art: 'network', title: t('dashboard:workers.emptyTitle'), description: t('dashboard:workers.emptyDesc') }}
            />
          </SectionCard>

          <SectionCard
            title={t('dashboard:failures.title')}
            subtitle={t('dashboard:failures.subtitle')}
            extra={
              <Button type="link" size="small" onClick={() => navigate('/tasks?only_failed=true')}>
                {t('dashboard:failures.goTasks')}
              </Button>
            }
            loading={loading && !data}
            error={error}
            onRetry={() => void reload()}
            bodyPadding="none"
          >
            <DataTable<FailedTaskOut>
              rowKey="id"
              columns={failureColumns}
              dataSource={data?.recent_failures ?? []}
              loading={loading}
              showDensity={false}
              skeletonRows={3}
              empty={{ art: 'task', title: t('dashboard:failures.emptyTitle'), description: t('dashboard:failures.emptyDesc') }}
            />
          </SectionCard>
        </div>

        <div className="tg-stack" style={{ gap: 'var(--tg-layout-page-gap)' }}>
          <SectionCard
            title={t('dashboard:queue.title')}
            subtitle={t('dashboard:queue.subtitle')}
            loading={loading && !data}
            error={error}
            onRetry={() => void reload()}
          >
            <div className="tg-queue-grid">
              {queueItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="tg-queue-tile"
                  onClick={() => navigate(`/tasks?status=${item.key}`)}
                >
                  <span className={`tg-queue-tile-icon is-${item.tone}`}>{item.icon}</span>
                  <span className="tg-queue-tile-label">{item.label}</span>
                  <span className="tg-queue-tile-value tg-num">{item.value}</span>
                </button>
              ))}
            </div>
            <Typography.Paragraph type="secondary" style={{ marginTop: 'var(--tg-space-lg)', marginBottom: 0, fontSize: 'var(--tg-font-size-sm)' }}>
              {t('dashboard:queue.explanation')}
            </Typography.Paragraph>
          </SectionCard>

          <SectionCard
            title={t('dashboard:notifications.title')}
            subtitle={
              notifications.data
                ? t('dashboard:notifications.unreadSubtitle', { count: notifications.data.unread })
                : t('dashboard:notifications.defaultSubtitle')
            }
            extra={
              <Button type="link" size="small" loading={marking} disabled={!(notifications.data?.unread)} onClick={() => void markAllRead()}>
                {t('dashboard:notifications.markAllRead')}
              </Button>
            }
            loading={notifications.initialLoading}
            error={notifications.error}
            onRetry={() => void notifications.reload()}
            empty={
              notifications.data && !notifications.loading
                ? {
                    art: 'inbox',
                    compact: true,
                    title: t('dashboard:notifications.emptyTitle'),
                    description: t('dashboard:notifications.emptyDesc'),
                  }
                : false
            }
            bodyPadding="none"
          >
            <div className="tg-stack" style={{ gap: 'var(--tg-space-xs)' }}>
              {(notifications.data?.items ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="tg-notify-item"
                  onClick={() => void markRead(item)}
                >
                  <span
                    aria-hidden
                    style={{
                      flex: 'none',
                      width: 8,
                      height: 8,
                      marginTop: 6,
                      borderRadius: 'var(--tg-radius-pill)',
                      background: `var(--tg-color-${item.level === 'error' ? 'danger' : item.level === 'warning' ? 'warning' : 'info'})`,
                    }}
                  />
                  <span className="tg-stack" style={{ gap: 'var(--tg-space-xxs)' }}>
                    <span className="tg-flex-between" style={{ gap: 'var(--tg-space-md)' }}>
                      <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>{item.title}</span>
                      <span className="tg-muted tg-nowrap" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                        <RelativeTime value={item.created_at} />
                      </span>
                    </span>
                    <span className="tg-muted tg-clamp-2" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                      {item.body}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </SectionCard>

        </div>
      </div>
    </PageContainer>
  );
}
