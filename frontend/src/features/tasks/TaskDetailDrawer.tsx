/**
 * 任务详情抽屉：基本信息 + 时间线 + payload / result / error（格式化 JSON 可复制）。
 * 打开时用 taskApi.get 拉最新一条，footer 提供重试 / 取消。
 */
import { useEffect, useMemo } from 'react';
import { Button, Space, Typography } from 'antd';
import { RedoOutlined, StopOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  CopyableText,
  DetailDrawer,
  RelativeTime,
  TaskStatusTag,
  TaskTypeTag,
  type DetailSection,
} from '../../components';
import { taskApi } from '../../api/endpoints';
import { useAsyncData, useInterval } from '../../hooks/useAsyncData';
import { useWsEvent } from '../../hooks/useWebSocket';
import { resolveEnumLabel } from '../../i18n';
import { formatTime } from '../../utils/format';
import type { TaskOut } from '../../api/types';
import { JsonBlock } from './JsonBlock';

interface TaskDetailDrawerProps {
  taskId: string | null;
  onClose: () => void;
  onRetry: (task: TaskOut) => void;
  onCancel: (task: TaskOut) => void;
}

const KNOWN_EMPTY_LOG_STATUSES = new Set([
  'pending',
  'running',
  'failed',
  'completed',
  'cancelled',
  'pending_confirmation',
]);

const KNOWN_STAGES = new Set([
  'start',
  'scanning',
  'searching',
  'sending',
  'progress',
  'online',
  'done',
  'error',
  'failed',
]);

export function TaskDetailDrawer({ taskId, onClose, onRetry, onCancel }: TaskDetailDrawerProps) {
  const { t } = useTranslation(['tasks', 'common', 'enums']);
  const detail = useAsyncData<TaskOut>(() => taskApi.get(taskId as string), [taskId], {
    immediate: false,
    silentError: true,
  });

  useEffect(() => {
    if (taskId) {
      detail.setData(null);
      void detail.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const task = detail.data;

  // 实时：任务事件一到就刷（WS 推的是「状态变了」；逐条追加的日志仍靠下面的轮询兜底）
  useWsEvent(
    'task',
    (event) => {
      if (taskId && event.task_id === taskId) void detail.reload();
    },
    Boolean(taskId),
  );

  // 兜底轮询：任务还在排队 / 执行中时每 3 秒拉一次，抽屉开着就能看到日志往上长
  useInterval(() => {
    if (!taskId) return;
    if (task?.status === 'pending' || task?.status === 'running') void detail.reload();
  }, 3000);

  // 执行日志：与列表页展开的那份同源（result.logs）
  const logs = useMemo(() => {
    const raw = (task?.result as Record<string, unknown> | null)?.logs;
    return Array.isArray(raw) ? (raw as { at: string; stage: string; detail: string }[]) : [];
  }, [task]);

  const canRetry = task?.status === 'failed' || task?.status === 'pending_confirmation';
  const canCancel =
    task?.status === 'pending' ||
    task?.status === 'running' ||
    task?.status === 'pending_confirmation';

  /** 没有日志时按状态给一句人话——留白会让人以为功能坏了 */
  const emptyLogHint = (status: string) =>
    KNOWN_EMPTY_LOG_STATUSES.has(status)
      ? t(`tasks:detail.emptyLogHint.${status}`)
      : t('tasks:detail.noLogsFallback');

  /** 日志分级：把 stage 翻成短标签 + 配色，一眼看出「在干嘛 / 卡哪了」 */
  const stageTone = (stage: string): { label: string; color: string } => {
    const key = (stage || '').toLowerCase();
    const label = KNOWN_STAGES.has(key)
      ? t(`tasks:stages.${key}`)
      : stage || t('tasks:stages.progress');
    if (key.includes('error') || key.includes('fail')) return { label, color: 'var(--tg-color-danger)' };
    if (key.includes('done') || key.includes('complete') || key === 'ok') {
      return { label, color: 'var(--tg-color-success)' };
    }
    if (key.includes('start')) return { label, color: 'var(--tg-color-primary)' };
    return { label, color: 'var(--tg-color-text-secondary)' };
  };

  const sections: DetailSection[] = task
    ? [
        {
          title: t('tasks:detail.logsTitle'),
          content: logs.length ? (
            <div className="tg-stack" style={{ gap: 2, maxHeight: 340, overflowY: 'auto' }}>
              {logs.map((entry, index) => {
                const tone = stageTone(entry.stage);
                const isLatest = index === logs.length - 1;
                return (
                  <div
                    key={`${entry.at}-${index}`}
                    style={{
                      display: 'flex',
                      gap: 'var(--tg-space-md)',
                      alignItems: 'baseline',
                      padding: '3px var(--tg-space-sm)',
                      borderRadius: 4,
                      // 最新一条加底纹：一眼看到「现在卡在哪一步」
                      background: isLatest ? 'var(--tg-color-primary-bg)' : undefined,
                    }}
                  >
                    <span
                      style={{
                        flex: 'none',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: isLatest ? tone.color : 'transparent',
                        border: `2px solid ${tone.color}`,
                      }}
                    />
                    <span
                      style={{
                        flex: 'none',
                        color: 'var(--tg-color-text-tertiary)',
                        fontSize: 'var(--tg-font-size-xs)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatTime(entry.at)}
                    </span>
                    <span
                      style={{
                        flex: 'none',
                        minWidth: 56,
                        fontSize: 'var(--tg-font-size-xs)',
                        color: tone.color,
                        fontWeight: 'var(--tg-font-weight-medium)',
                      }}
                    >
                      {tone.label}
                    </span>
                    <span style={{ color: 'var(--tg-color-text-primary)' }}>{entry.detail}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Typography.Text type="secondary">
              {emptyLogHint(task.status)}
            </Typography.Text>
          ),
        },
        {
          title: t('tasks:detail.basicInfo'),
          items: [
            {
              label: t('tasks:detail.taskType'),
              value: <TaskTypeTag type={task.type} label={task.type_label} />,
            },
            {
              label: t('tasks:detail.status'),
              value: <TaskStatusTag status={task.status} label={task.status_label} />,
            },
            {
              label: t('tasks:detail.taskId'),
              value: <CopyableText value={task.id} mono />,
            },
            { label: t('tasks:detail.attempts'), value: `${task.attempts} / ${task.max_attempts}` },
            { label: t('tasks:detail.priority'), value: task.priority },
            {
              label: t('tasks:detail.worker'),
              value: task.worker_id ? <CopyableText value={task.worker_id} mono /> : undefined,
            },
            { label: t('tasks:detail.createdBy'), value: task.created_by_name || undefined },
            { label: t('tasks:detail.nextRunAt'), value: formatTime(task.next_run_at) },
          ],
        },
        {
          title: t('tasks:detail.timeline'),
          content: (
            <div className="tg-stack" style={{ gap: 'var(--tg-space-md)' }}>
              <TimelineRow label={t('tasks:detail.timelineCreated')} value={task.created_at} />
              <TimelineRow label={t('tasks:detail.timelineStarted')} value={task.started_at} />
              <TimelineRow label={t('tasks:detail.timelineCompleted')} value={task.completed_at} />
              <TimelineRow label={t('tasks:detail.timelineNextRun')} value={task.next_run_at} />
            </div>
          ),
        },
      ]
    : [];

  return (
    <DetailDrawer
      open={Boolean(taskId)}
      onClose={onClose}
      title={task ? resolveEnumLabel(`taskType.${task.type}`, task.type_label, task.type) : t('tasks:detail.title')}
      subtitle={
        task ? (
          <Space size={8}>
            <span>
              {task.account_label || task.bot_label || t('tasks:detail.systemTask')}
            </span>
            {task.created_at ? <RelativeTime value={task.created_at} refreshMs={0} /> : null}
          </Space>
        ) : undefined
      }
      width={680}
      loading={detail.loading}
      error={detail.error}
      onRetry={() => void detail.reload()}
      sections={sections}
      footer={
        task ? (
          <Space>
            <Button
              icon={<RedoOutlined />}
              disabled={!canRetry}
              title={canRetry ? undefined : t('tasks:actions.retryDisabledHint')}
              onClick={() => onRetry(task)}
            >
              {t('common:retry')}
            </Button>
            <Button
              danger
              icon={<StopOutlined />}
              disabled={!canCancel}
              title={canCancel ? undefined : t('tasks:actions.cancelDisabledHint')}
              onClick={() => onCancel(task)}
            >
              {t('common:cancel')}
            </Button>
          </Space>
        ) : null
      }
    >
      {task ? (
        <div className="tg-stack" style={{ gap: 'var(--tg-space-xl)' }}>
          {task.error ? (
            <div>
              <Typography.Text strong>{t('tasks:detail.errorReason')}</Typography.Text>
              <div style={{ marginTop: 'var(--tg-space-md)' }}>
                <JsonBlock value={task.error} emptyText={t('tasks:jsonBlock.empty')} />
              </div>
            </div>
          ) : null}
          <JsonBlock title={t('tasks:detail.payloadTitle')} value={task.payload} />
          {task.result !== null && task.result !== undefined ? (
            <JsonBlock title={t('tasks:detail.resultTitle')} value={task.result} />
          ) : (
            <JsonBlock title={t('tasks:detail.resultTitle')} value={null} emptyText={t('tasks:detail.noResult')} />
          )}
        </div>
      ) : null}
    </DetailDrawer>
  );
}

function TimelineRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--tg-space-lg)',
        fontSize: 'var(--tg-font-size-sm)',
      }}
    >
      <span style={{ color: 'var(--tg-color-text-tertiary)', minWidth: 64, flex: 'none' }}>{label}</span>
      <span style={{ color: 'var(--tg-color-text-primary)' }}>{formatTime(value)}</span>
    </div>
  );
}
