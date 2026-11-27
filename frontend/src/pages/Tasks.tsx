/**
 * 任务中心：状态/类型/账号/Bot/只看失败筛选 + 服务端排序 + 分页 +
 * 状态汇总（含 overdue/stuck）+ 失败原因完整展示（Tooltip + 展开行）+
 * 单条重试/取消 + 勾选批量重试（POST /api/tasks/bulk/retry，404 时回退逐条）+
 * 自动刷新开关 + 详情抽屉（payload/result/error/worker_id/时间线）+ 导出 CSV。
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Checkbox, Select, Space, Switch, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { RedoOutlined, StopOutlined, FileSearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  DataTable,
  FilterBar,
  PageContainer,
  RelativeTime,
  TaskStatusTag,
  TaskTypeTag,
} from '../components';
import { api, ApiError } from '../api/client';
import { accountApi, botApi, dashboardApi, exportApi, taskApi } from '../api/endpoints';
import { useAsyncData, useInterval } from '../hooks/useAsyncData';
import { useTableQuery, buildActiveFilters } from '../hooks/useTableQuery';
import { useWsEvent } from '../hooks/useWebSocket';
import { resolveEnumLabel } from '../i18n';
import { downloadBlob } from '../utils/download';
import { formatTime, stringifyDetail } from '../utils/format';
import { toast } from '../utils/feedback';
import { getTaskStatusOptions, getTaskTypeOptions } from '../constants';
import type { TaskOut, TaskStatus, TaskType } from '../api/types';
import { JsonBlock } from '../features/tasks/JsonBlock';
import { TaskDetailDrawer } from '../features/tasks/TaskDetailDrawer';
import '../features/tasks/tasks.css';

const REFRESH_MS = 10_000;

const KNOWN_EXPANDED_LOG_STATUSES = new Set([
  'pending',
  'running',
  'failed',
  'completed',
  'cancelled',
]);

/** POST /api/tasks/bulk/retry 的响应（后端逐条给结果） */
interface BulkRetryOut {
  ok: boolean;
  requested: number;
  succeeded: number;
  failed: number;
  results: Array<{ task_id: string; ok: boolean; message: string }>;
}

/** 每个状态对应的视觉语义：数字用它自己的颜色，异常态才抢眼 */
const STATUS_CHIP_TONE: Record<TaskStatus, string> = {
  pending: 'is-neutral',
  pending_confirmation: 'is-info',
  running: 'is-info',
  completed: 'is-success',
  failed: 'is-danger',
  cancelled: 'is-muted',
};

const STATUS_CHIP_ORDER: TaskStatus[] = [
  'pending',
  'pending_confirmation',
  'running',
  'completed',
  'failed',
  'cancelled',
];

export default function Tasks() {
  const { t, i18n } = useTranslation(['tasks', 'common', 'enums']);
  const [searchParams] = useSearchParams();
  const taskStatusOptions = useMemo(() => getTaskStatusOptions(), [i18n.language]);
  const taskTypeOptions = useMemo(() => getTaskTypeOptions(), [i18n.language]);

  const q = useTableQuery({
    filters: {
      status: (searchParams.get('status') as TaskStatus) || ('' as TaskStatus | ''),
      type: (searchParams.get('type') as TaskType) || ('' as TaskType | ''),
      account_id: searchParams.get('account_id') as string | null,
      bot_id: null as string | null,
      only_failed: searchParams.get('only_failed') === 'true',
      // 批次：同一次提交（选 N 个号做同一件事）产生的任务共享 batch_id，
      // 点列表里的批次号就把筛选切到「只看这一批」
      batch: searchParams.get('batch') ?? null,
    },
    pageSize: 20,
  });

  const tasks = useAsyncData(
    () =>
      taskApi.list({
        ...q.params,
        sort: q.sort ?? undefined,
        order: q.order ?? undefined,
      }),
    [q.paramsKey, q.sort, q.order],
  );
  // overdue / stuck 来自工作台口径（后端只在 dashboard 给这两个数）
  const dashboard = useAsyncData(() => dashboardApi.get(), [], { silentError: true });
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }, { silent: true }), []);
  const bots = useAsyncData(async () => {
    try {
      return await botApi.list();
    } catch {
      return [];
    }
  }, []);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 展开行只由行首那个箭头控制；「日志」按钮走右侧详情抽屉（TaskDetailDrawer），
  // 抽屉里能看完整的执行日志 + payload / result，比展开一行宽敞得多
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [batchRetrying, setBatchRetrying] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  useInterval(() => {
    void tasks.reload();
  }, autoRefresh ? REFRESH_MS : null);

  // 任务状态变化（WS 推送）就刷新一次，让重试/取消结果尽快反映
  useWsEvent('task', () => {
    void tasks.reload();
  });

  const counts = tasks.data?.counts ?? {};
  const failedCount = counts.failed ?? 0;
  const pageItems = tasks.data?.items ?? [];
  const selectedOnPage = pageItems.filter((item) => selectedIds.includes(item.id)).length;

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((item) => item !== id)));
  };

  const togglePage = (checked: boolean) => {
    setSelectedIds((prev) => {
      const pageIds = pageItems.map((item) => item.id);
      if (checked) return [...new Set([...prev, ...pageIds])];
      return prev.filter((id) => !pageIds.includes(id));
    });
  };

  const handleRetry = async (task: TaskOut) => {
    try {
      const res = await taskApi.retry(task.id);
      toast.success(res.message || t('tasks:toast.requeued'));
      void tasks.reload();
    } catch {
      /* client 已统一提示 */
    }
  };

  const handleCancel = async (task: TaskOut) => {
    try {
      const res = await taskApi.cancel(task.id);
      toast.success(res.message || t('tasks:toast.cancelled'));
      void tasks.reload();
    } catch {
      /* client 已统一提示 */
    }
  };

  /** 一键重试全部失败：先按当前筛选拉出失败任务 id，再走批量重试接口 */
  const retryAllFailed = async () => {
    setBatchRetrying(true);
    try {
      const list = await taskApi.list(
        { status: 'failed', page: 1, page_size: 200 },
        { silent: true },
      );
      const ids = (list.items ?? []).map((item) => item.id);
      if (!ids.length) {
        toast.info(t('tasks:toast.noFailedTasks'));
        return;
      }
      const res = await api.post<BulkRetryOut>('/api/tasks/bulk/retry', { task_ids: ids }, { silent: true });
      if (res.failed === 0) {
        toast.success(t('tasks:toast.retryAllSuccess', { count: res.succeeded }));
      } else {
        toast.warning(t('tasks:toast.retryAllPartial', { succeeded: res.succeeded, failed: res.failed }));
      }
      void tasks.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setBatchRetrying(false);
    }
  };

  const handleBatchRetry = async () => {
    if (!selectedIds.length) return;
    setBatchRetrying(true);
    try {
      const res = await api.post<BulkRetryOut>(
        '/api/tasks/bulk/retry',
        { task_ids: selectedIds },
        { silent: true },
      );
      if (res.failed === 0) {
        toast.success(t('tasks:toast.batchRetrySuccess', { count: res.succeeded }));
      } else {
        const first = res.results.find((item) => !item.ok)?.message ?? '';
        toast.warning(
          first
            ? t('tasks:toast.batchRetryPartialWithReason', {
                succeeded: res.succeeded,
                failed: res.failed,
                reason: first,
                etc: res.failed > 1 ? t('tasks:toast.etcSuffix') : '',
              })
            : t('tasks:toast.batchRetryPartial', { succeeded: res.succeeded, failed: res.failed }),
          { duration: 6 },
        );
      }
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.status === 404) {
        // 后端还没有 bulk/retry 时的回退：逐条重试（retry 幂等：已 pending 会回 400）
        let ok = 0;
        const failures: string[] = [];
        for (const id of selectedIds) {
          try {
            await taskApi.retry(id);
            ok += 1;
          } catch (inner) {
            failures.push((inner as Error).message);
          }
        }
        if (failures.length === 0) {
          toast.success(t('tasks:toast.batchRetrySuccess', { count: ok }));
        } else {
          toast.warning(
            t('tasks:toast.batchRetryPartialWithReason', {
              succeeded: ok,
              failed: failures.length,
              reason: failures[0],
              etc: '',
            }),
            { duration: 6 },
          );
        }
      } else {
        toast.error(apiError.friendlyMessage || t('tasks:toast.batchRetryFailed'));
      }
    } finally {
      setBatchRetrying(false);
      setSelectedIds([]);
      void tasks.reload();
    }
  };

  const handleExport = async () => {
    const res = await exportApi.tasks({
      ...q.params,
      sort: q.sort ?? undefined,
      order: q.order ?? undefined,
    });
    downloadBlob(res.blob, res.filename);
  };

  const columns = useMemo<TableColumnsType<TaskOut>>(() => {
    const selectColumn: TableColumnsType<TaskOut>[number] = {
      key: 'select',
      width: 42,
      fixed: 'left',
      title: (
        <Checkbox
          checked={pageItems.length > 0 && selectedOnPage === pageItems.length}
          indeterminate={selectedOnPage > 0 && selectedOnPage < pageItems.length}
          onChange={(event) => togglePage(event.target.checked)}
          aria-label={t('tasks:table.selectPageAll')}
        />
      ),
      render: (_: unknown, record: TaskOut) => (
        <Checkbox
          checked={selectedIds.includes(record.id)}
          onChange={(event) => toggleOne(record.id, event.target.checked)}
          onClick={(event) => event.stopPropagation()}
          aria-label={t('tasks:table.selectTask', { id: record.id })}
        />
      ),
    };

    return [
      selectColumn,
      {
        title: t('tasks:columns.type'),
        key: 'type',
        dataIndex: 'type',
        width: 150,
        render: (_: unknown, record) => <TaskTypeTag type={record.type} label={record.type_label} />,
      },
      {
        title: t('tasks:columns.batch'),
        key: 'batch',
        width: 130,
        render: (_: unknown, record) => {
          // 同一次提交（选 N 个号做同一件事）会生成 N 条任务，共用同一个 batch_id。
          // 单看任务列表就是一盘散沙——看不出哪些是「我这次操作」产生的一批。
          const batch = ((record.payload as Record<string, unknown> | null)?.batch_id as string) ?? '';
          if (!batch) return <span className="tg-muted">—</span>;
          const total = (record.payload as Record<string, unknown> | null)?.account_count;
          return (
            <Tooltip
              title={
                total
                  ? t('tasks:table.batchTooltipWithCount', { batch, count: Number(total) })
                  : t('tasks:table.batchTooltip', { batch })
              }
            >
              <Button
                type="link"
                size="small"
                className="tg-mono"
                style={{ padding: 0 }}
                onClick={() => q.setFilter('batch', batch)}
              >
                {batch.slice(0, 8)}
              </Button>
            </Tooltip>
          );
        },
      },
      {
        title: t('tasks:columns.status'),
        key: 'status',
        dataIndex: 'status',
        width: 120,
        render: (_: unknown, record) => <TaskStatusTag status={record.status} label={record.status_label} />,
      },
      {
        title: t('tasks:columns.owner'),
        key: 'owner',
        dataIndex: 'account_label',
        width: 150,
        render: (_: unknown, record) => {
          if (record.account_label) {
            return (
              <Tooltip title={t('tasks:table.accountIdTooltip', { id: record.account_id ?? '—' })}>
                <span>{record.account_label}</span>
              </Tooltip>
            );
          }
          if (record.bot_label) {
            return <SoftTagBot label={record.bot_label} />;
          }
          return <Typography.Text type="secondary">—</Typography.Text>;
        },
      },
      {
        title: t('tasks:columns.error'),
        key: 'error',
        dataIndex: 'error',
        width: 320,
        render: (value: string, record) => {
          if (!value) return <Typography.Text type="secondary">—</Typography.Text>;
          // 待执行 / 执行中：这条 error 是上一轮留下的旧账（重试中的任务会有），
          // 用灰字标成「上次失败」，别让它看着像当前正在报错
          if (record.status !== 'failed') {
            return (
              <Tooltip
                title={
                  <div style={{ maxWidth: 520, whiteSpace: 'pre-wrap' }}>
                    {t('tasks:table.lastAttemptFailed', { error: value })}
                  </div>
                }
              >
                <span className="tg-clamp-cell tg-muted">
                  {t('tasks:table.lastFailedPrefix', { error: value })}
                  {/* 待执行的任务带着 next_run_at：把「多久后自动重试」摆出来，
                      不然只看到一条失败信息，很容易以为要手动点重试 */}
                  {record.status === 'pending' ? <RetryCountdown nextRunAt={record.next_run_at} /> : null}
                </span>
              </Tooltip>
            );
          }
          return (
            <Tooltip title={<div style={{ maxWidth: 520, whiteSpace: 'pre-wrap' }}>{value}</div>}>
              <span className="tg-clamp-cell tg-text-danger">{value}</span>
            </Tooltip>
          );
        },
      },
      {
        title: t('tasks:columns.attempts'),
        key: 'attempts',
        dataIndex: 'attempts',
        width: 100,
        render: (value: number, record) => (
          <Typography.Text
            style={{
              color: record.status === 'failed' && value >= record.max_attempts ? 'var(--tg-color-danger)' : undefined,
            }}
          >
            {value}/{record.max_attempts}
          </Typography.Text>
        ),
      },
      {
        title: t('tasks:columns.createdAt'),
        key: 'created_at',
        dataIndex: 'created_at',
        width: 150,
        render: (value: string | null) => <RelativeTime value={value} />,
      },
      {
        title: t('tasks:columns.startedAt'),
        key: 'started_at',
        dataIndex: 'started_at',
        width: 150,
        render: (v: string | null) => formatTime(v),
      },
      {
        title: t('tasks:columns.completedAt'),
        key: 'completed_at',
        dataIndex: 'completed_at',
        width: 150,
        render: (v: string | null) => formatTime(v),
      },
      {
        title: t('tasks:columns.worker'),
        key: 'worker_id',
        dataIndex: 'worker_id',
        width: 130,
        // 形如 主机名-pid（duannaideMac-mini.local-7640），一行放不下——
        // 截断加悬停提示，别让它换行把行高撑起来
        ellipsis: { showTitle: true },
        render: (value: string | null) =>
          value ? (
            <Typography.Text code style={{ fontSize: 'var(--tg-font-size-sm)' }}>
              {value}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
      {
        title: t('tasks:columns.actions'),
        key: 'actions',
        width: 230,
        fixed: 'right',
        render: (_: unknown, record) => {
          const logCount = ((record.result as Record<string, unknown> | null)?.logs as unknown[] | undefined)?.length ?? 0;
          const canRetry = record.status === 'failed' || record.status === 'pending_confirmation';
          const canCancel =
            record.status === 'pending' ||
            record.status === 'running' ||
            record.status === 'pending_confirmation';
          return (
            <Space size={0}>
              <Tooltip
                title={
                  logCount
                    ? t('tasks:actions.logsTooltipCount', { count: logCount })
                    : t('tasks:actions.logsTooltipEmpty')
                }
              >
                <Button type="text" size="small" onClick={() => setDetailId(record.id)}>
                  {logCount ? t('tasks:actions.logsWithCount', { count: logCount }) : t('tasks:actions.logs')}
                </Button>
              </Tooltip>
              <Tooltip title={canRetry ? t('tasks:actions.retryTooltip') : t('tasks:actions.retryDisabledHint')}>
                <Button
                  type="text"
                  size="small"
                  icon={<RedoOutlined />}
                  disabled={!canRetry}
                  onClick={() => void handleRetry(record)}
                >
                  {t('common:retry')}
                </Button>
              </Tooltip>
              <Tooltip title={canCancel ? t('tasks:actions.cancelTooltip') : t('tasks:actions.cancelDisabledHint')}>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  disabled={!canCancel}
                  onClick={() => void handleCancel(record)}
                >
                  {t('common:cancel')}
                </Button>
              </Tooltip>
              <Button
                type="text"
                size="small"
                icon={<FileSearchOutlined />}
                onClick={() => setDetailId(record.id)}
              >
                {t('tasks:actions.detail')}
              </Button>
            </Space>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, selectedOnPage, pageItems.length, t, i18n.language]);

  const expandable = useMemo(
    () => ({
      expandedRowKeys: expandedIds,
      onExpandedRowsChange: (keys: readonly React.Key[]) => setExpandedIds(keys.map(String)),
      expandedRowRender: (record: TaskOut) => (
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)', padding: 'var(--tg-space-md) 0' }}>
          {(() => {
            // 执行日志：任务跑的过程中每一步都写进 result.logs，
            // 批量任务（一号一条）就能看到「这一号做到哪了」
            const logs = ((record.result as Record<string, unknown> | null)?.logs as
              | { at: string; stage: string; detail: string }[]
              | undefined) ?? [];
            const progress = (record.result as Record<string, unknown> | null) ?? {};
            const summaryParts = ['sent', 'total', 'joined', 'fetched']
              .filter((key) => progress[key] !== undefined)
              .map((key) => `${key}=${progress[key]}`);
            // 没有日志时也要给反馈：之前这里直接 return null，用户点「日志」
            // 展开后一片空白，看起来就像功能坏了。排队中的任务本来就没有日志，
            // 得说清楚它现在处于什么状态、接下来会怎样。
            if (!logs.length && !summaryParts.length) {
              const statusLabel = resolveEnumLabel(`taskStatus.${record.status}`, record.status_label, record.status);
              const emptyText = KNOWN_EXPANDED_LOG_STATUSES.has(record.status)
                ? t(`tasks:expanded.emptyHint.${record.status}`)
                : t('tasks:expanded.currentStatus', { status: statusLabel });
              return (
                <div className="tg-task-logs-empty">
                  <b style={{ fontSize: 'var(--tg-font-size-sm)' }}>{t('tasks:detail.logsTitle')}</b>
                  <p>{emptyText}</p>
                  {record.error ? (
                    <p className="tg-task-logs-error">{t('tasks:expanded.errorReason', { error: record.error })}</p>
                  ) : null}
                </div>
              );
            }
            return (
              <div className="tg-stack" style={{ gap: 'var(--tg-space-xs)' }}>
                <b style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                  {t('tasks:detail.logsTitle')}
                  {summaryParts.length ? t('tasks:expanded.logsSummaryWrap', { summary: summaryParts.join(' · ') }) : ''}
                </b>
                {logs.length ? (
                  <div className="tg-stack" style={{ gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                    {logs.map((item, index) => (
                      <div key={`${item.at}-${index}`} style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                        <span className="tg-mono tg-muted">{item.at.slice(11, 19)}</span>{' '}
                        <span>{item.detail || item.stage}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
                    {t('tasks:expanded.logsPendingStep')}
                  </span>
                )}
              </div>
            );
          })()}
          <JsonBlock title={t('tasks:detail.payloadTitle')} value={record.payload} maxHeight={200} />
          <JsonBlock
            title={t('tasks:detail.resultTitle')}
            value={record.result ?? null}
            emptyText={t('tasks:expanded.noResult')}
            maxHeight={200}
          />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--tg-space-xl)',
              color: 'var(--tg-color-text-tertiary)',
              fontSize: 'var(--tg-font-size-sm)',
            }}
          >
            <span>{t('tasks:expanded.taskId', { id: record.id })}</span>
            {record.created_by_name ? <span>{t('tasks:expanded.createdBy', { name: record.created_by_name })}</span> : null}
            <span>{t('tasks:expanded.nextRunAt', { time: formatTime(record.next_run_at) })}</span>
            {record.dialog_id ? <span>{t('tasks:expanded.dialogId', { id: record.dialog_id })}</span> : null}
          </div>
        </div>
      ),
      rowExpandable: (record: TaskOut) => Boolean(stringifyDetail(record.payload)),
    }),
    [expandedIds, t, i18n.language],
  );

  const activeFilters = buildActiveFilters([
    {
      key: 'status',
      label: t('tasks:filters.status'),
      display: q.filters.status
        ? taskStatusOptions.find((item) => item.value === q.filters.status)?.label ?? q.filters.status
        : '',
      clear: () => q.setFilter('status', ''),
    },
    {
      key: 'type',
      label: t('tasks:filters.type'),
      display: q.filters.type
        ? taskTypeOptions.find((item) => item.value === q.filters.type)?.label ?? q.filters.type
        : '',
      clear: () => q.setFilter('type', ''),
    },
    {
      key: 'account_id',
      label: t('tasks:filters.account'),
      display: q.filters.account_id
        ? accounts.data?.items.find((item) => item.id === q.filters.account_id)?.phone_masked ?? q.filters.account_id
        : '',
      clear: () => q.setFilter('account_id', null),
    },
    {
      key: 'bot_id',
      label: t('tasks:filters.bot'),
      display: q.filters.bot_id
        ? bots.data?.find((item) => item.id === q.filters.bot_id)?.bot_username ?? q.filters.bot_id
        : '',
      clear: () => q.setFilter('bot_id', null),
    },
    {
      key: 'only_failed',
      label: t('tasks:filters.onlyFailed'),
      display: q.filters.only_failed ? t('tasks:filters.enabled') : '',
      clear: () => q.setFilter('only_failed', false),
    },
  ]);

  const chipStatus = (status: TaskStatus) => {
    const isActive = q.filters.status === status;
    const count = counts[status] ?? 0;
    const label = taskStatusOptions.find((item) => item.value === status)?.label ?? status;
    return (
      <button
        key={status}
        type="button"
        className={[
          'tg-task-chip',
          STATUS_CHIP_TONE[status] ?? 'is-neutral',
          isActive ? 'is-active' : '',
          count > 0 ? 'has-count' : 'is-zero',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => q.setFilter('status', isActive ? '' : status)}
        title={isActive ? t('tasks:chips.clearFilter') : t('tasks:chips.filterByStatus', { label })}
      >
        <span className="tg-task-chip-count">{count}</span>
        {label}
      </button>
    );
  };

  return (
    <PageContainer
      title={t('tasks:page.title')}
      description={t('tasks:page.description')}
    >
      <div className="tg-task-summary" style={{ marginBottom: 'var(--tg-space-lg)' }}>
        {STATUS_CHIP_ORDER.slice(0, 3).map(chipStatus)}
        <span className="tg-task-summary-sep" aria-hidden />
        {STATUS_CHIP_ORDER.slice(3).map(chipStatus)}
        <span className="tg-task-summary-sep" aria-hidden />
        <Tooltip title={t('tasks:summary.overdueTooltip')}>
          <span className="tg-task-chip is-static is-overdue">
            <span className="dot" />
            <span className="tg-task-chip-count">{dashboard.data?.tasks_overdue ?? 0}</span>
            {t('tasks:summary.overdue')}
          </span>
        </Tooltip>
        <Tooltip title={t('tasks:summary.stuckTooltip')}>
          <span className="tg-task-chip is-static is-stuck">
            <span className="dot" />
            <span className="tg-task-chip-count">{dashboard.data?.tasks_stuck ?? 0}</span>
            {t('tasks:summary.stuck')}
          </span>
        </Tooltip>
        <span className="tg-task-summary-actions">
          {failedCount > 0 ? (
            <Button
              danger
              size="small"
              icon={<RedoOutlined />}
              loading={batchRetrying}
              onClick={() => void retryAllFailed()}
            >
              {t('tasks:summary.retryAllFailed', { count: failedCount })}
            </Button>
          ) : null}
          <span className="tg-task-summary-total">
            {t('common:totalItems', { count: tasks.data?.total ?? 0 })}
          </span>
        </span>
      </div>

      <FilterBar
        collapsible
        onReset={q.reset}
        onSearch={() => void tasks.reload()}
        loading={tasks.loading}
        activeFilters={activeFilters}
        extra={
          <Space size={4}>
            <span style={{ color: 'var(--tg-color-text-secondary)', fontSize: 'var(--tg-font-size-sm)' }}>
              {t('tasks:filters.autoRefresh')}
            </span>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </Space>
        }
      >
        <Select
          allowClear
          placeholder={t('tasks:filters.status')}
          style={{ width: 140 }}
          value={q.filters.status || undefined}
          onChange={(value) => q.setFilter('status', (value as TaskStatus) ?? '')}
          options={taskStatusOptions}
        />
        <Select
          allowClear
          placeholder={t('tasks:filters.type')}
          style={{ width: 170 }}
          value={q.filters.type || undefined}
          onChange={(value) => q.setFilter('type', (value as TaskType) ?? '')}
          options={taskTypeOptions}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('tasks:filters.account')}
          style={{ width: 200 }}
          value={q.filters.account_id ?? undefined}
          onChange={(value) => q.setFilter('account_id', value ?? null)}
          options={(accounts.data?.items ?? []).map((item) => ({
            value: item.id,
            label: item.remark
              ? t('tasks:filters.accountWithRemark', { phone: item.phone_masked, remark: item.remark })
              : item.phone_masked,
          }))}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('tasks:filters.bot')}
          style={{ width: 170 }}
          value={q.filters.bot_id ?? undefined}
          onChange={(value) => q.setFilter('bot_id', value ?? null)}
          options={(bots.data ?? []).map((item) => ({
            value: item.id,
            label: item.bot_username ? `@${item.bot_username}` : item.name,
          }))}
        />
        <Space size={4}>
          <span>{t('tasks:filters.onlyFailed')}</span>
          <Switch
            size="small"
            checked={q.filters.only_failed}
            onChange={(checked) => q.setFilter('only_failed', checked)}
          />
        </Space>
      </FilterBar>

      <DataTable<TaskOut>
        rowKey="id"
        columns={columns}
        dataSource={pageItems}
        total={tasks.data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPageChange={q.setPage}
        loading={tasks.loading}
        error={tasks.error}
        onRetry={() => void tasks.reload()}
        sortableColumns={{
          type: 'type',
          status: 'status',
          attempts: 'attempts',
          created_at: 'created_at',
          started_at: 'started_at',
          completed_at: 'completed_at',
        }}
        sortField={q.sort}
        sortOrder={q.order}
        onSortChange={q.setSort}
        columnSettingsKey="tasks"
        // 这个值必须 >= 所有列宽之和（42+150+130+120+150+320+100+150+150+150+130+230 = 1822）；
        // 给小了表格会把列压扁，右侧固定的「操作」列就和 Worker 列叠在一起
        scrollX={1822}
        expandable={expandable}
        onExport={handleExport}
        toolbar={
          <Space size={4}>
            <Button
              type="primary"
              ghost
              size="small"
              icon={<RedoOutlined />}
              loading={batchRetrying}
              disabled={!selectedIds.length}
              onClick={() => void handleBatchRetry()}
            >
              {selectedIds.length
                ? t('tasks:toolbar.batchRetryWithCount', { count: selectedIds.length })
                : t('tasks:toolbar.batchRetry')}
            </Button>
            {selectedIds.length ? (
              <Button type="link" size="small" onClick={() => setSelectedIds([])}>
                {t('tasks:toolbar.clearSelection')}
              </Button>
            ) : null}
          </Space>
        }
        empty={{
          art: 'task',
          title: t('tasks:empty.title'),
          description: t('tasks:empty.description'),
        }}
      />

      <TaskDetailDrawer
        taskId={detailId}
        onClose={() => setDetailId(null)}
        onRetry={(task) => void handleRetry(task)}
        onCancel={(task) => void handleCancel(task)}
      />
    </PageContainer>
  );
}

/**
 * 自动重试倒计时：限流（FloodWait）这类失败会回队列并带上 next_run_at，
 * 这里把它翻成「N 秒后自动重试」，让人知道不用手点——到点自动跑。
 */
function RetryCountdown({ nextRunAt }: { nextRunAt?: string | null }) {
  const { t } = useTranslation('tasks');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!nextRunAt) return null;
  const target = new Date(nextRunAt).getTime();
  if (Number.isNaN(target)) return null;
  const left = Math.ceil((target - now) / 1000);
  if (left <= 0) return <span> · {t('countdown.soon')}</span>;
  // 节流可能把任务推到几小时后（等每日额度重置），用小时/分钟说才看得懂
  const text =
    left >= 3600
      ? t('countdown.hoursMinutes', { hours: Math.floor(left / 3600), minutes: Math.floor((left % 3600) / 60) })
      : left >= 60
        ? t('countdown.minutesSeconds', { minutes: Math.floor(left / 60), seconds: left % 60 })
        : t('countdown.seconds', { seconds: left });
  return <span> · {text}</span>;
}

function SoftTagBot({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 var(--tg-space-sm)',
        borderRadius: 'var(--tg-radius-sm)',
        background: 'var(--tg-color-bg-sunken)',
        border: '1px solid var(--tg-color-border-subtle)',
        color: 'var(--tg-color-text-secondary)',
        fontSize: 'var(--tg-font-size-sm)',
      }}
    >
      @{label}
    </span>
  );
}
