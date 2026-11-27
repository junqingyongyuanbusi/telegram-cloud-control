/**
 * BulkResultModal —— 批量账号操作结果弹窗（逐条展示成功/失败/跳过）。
 *
 * 输入是 /api/accounts/bulk/* 的统一响应 BulkResultOut；
 * 命中上限截断（truncated）时在顶部给黄色提示，引导缩小范围。
 */
import { Modal, Alert, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { resolveEnumLabel } from '../../i18n';
import type { BulkItemResult, BulkResultOut } from '../../api/types';

interface Props {
  open: boolean;
  result: BulkResultOut | null;
  onClose: () => void;
}

export default function BulkResultModal({ open, result, onClose }: Props) {
  const { t } = useTranslation(['accounts', 'common']);
  const items = result?.items ?? [];

  const columns: ColumnsType<BulkItemResult> = [
    { title: t('accounts:bulkResult.columns.account'), dataIndex: 'account_label', width: 140 },
    {
      title: t('accounts:bulkResult.columns.result'),
      dataIndex: 'ok',
      width: 90,
      render: (value: boolean, record) =>
        value ? (
          <span style={{ color: 'var(--tg-color-success)' }}>{t('accounts:bulkResult.statusOk')}</span>
        ) : record.message && record.status === 'disabled' ? (
          <span className="tg-muted">{t('accounts:bulkResult.statusSkipped')}</span>
        ) : (
          <span style={{ color: 'var(--tg-color-danger)' }}>{t('accounts:bulkResult.statusFailed')}</span>
        ),
    },
    {
      title: t('accounts:bulkResult.columns.message'),
      dataIndex: 'message',
      width: 340,
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip title={value || ''} placement="topLeft">
          <span className="tg-clamp-cell">{value || '—'}</span>
        </Tooltip>
      ),
    },
    {
      title: t('accounts:bulkResult.columns.task'),
      dataIndex: 'task_id',
      width: 160,
      render: (value: string | null) =>
        value ? (
          <Link className="tg-mono" to={`/tasks?account_id=${value}`} style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {t('accounts:bulkResult.taskLink', { id: value.slice(0, 6) })}
          </Link>
        ) : (
          <span className="tg-muted">—</span>
        ),
    },
  ];

  // 只有确实带检测结果的批次才显示这一列，避免整列全是「—」占位
  const columnsWithCheck = items.some((item) => item.status_label)
    ? [
        ...columns.slice(0, 3),
        {
          title: t('accounts:bulkResult.columns.checkStatus'),
          dataIndex: 'status_label',
          width: 110,
          render: (value: string | undefined, record: BulkItemResult) => {
            const label = record.status
              ? resolveEnumLabel(`accountStatus.${record.status}`, value, value ?? '')
              : value;
            return label ? <Tag>{label}</Tag> : <span className="tg-muted">—</span>;
          },
        },
        ...columns.slice(3),
      ]
    : columns;

  return (
    <Modal
      open={open}
      title={t('accounts:bulkResult.title')}
      onCancel={onClose}
      onOk={onClose}
      okText={t('accounts:bulkResult.okText')}
      cancelText={t('common:close')}
      width={760}
    >
      {result ? (
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          {/* 统计块：每个数字独立成块，配色区分「成了几个 / 挂了几个 / 跳了几个」 */}
          <div className="tg-flex" style={{ gap: 'var(--tg-space-sm)', flexWrap: 'wrap' }}>
            <span className="tg-result-stat is-total">
              {t('accounts:bulkResult.stats.requested')} <b>{result.requested}</b>
            </span>
            {result.succeeded ? (
              <span className="tg-result-stat is-ok">
                {t('accounts:bulkResult.stats.succeeded')} <b>{result.succeeded}</b>
              </span>
            ) : null}
            {result.failed ? (
              <span className="tg-result-stat is-fail">
                {t('accounts:bulkResult.stats.failed')} <b>{result.failed}</b>
              </span>
            ) : null}
            {result.skipped ? (
              <span className="tg-result-stat is-skip">
                {t('accounts:bulkResult.stats.skipped')} <b>{result.skipped}</b>
              </span>
            ) : null}
            {result.task_ids.length ? (
              <span className="tg-result-stat is-task">
                {t('accounts:bulkResult.stats.tasks')} <b>{result.task_ids.length}</b>
              </span>
            ) : null}
          </div>
          {result.truncated ? (
            <Alert
              type="warning"
              showIcon
              message={t('accounts:bulkResult.truncatedTitle')}
              description={t('accounts:bulkResult.truncatedDesc')}
            />
          ) : null}
          <Table<BulkItemResult>
            size="small"
            rowKey={(record) => record.account_id}
            columns={columnsWithCheck}
            dataSource={items}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              size: 'small',
              showTotal: (total) => t('common:totalItems', { count: total }),
            }}
          />
        </div>
      ) : null}
    </Modal>
  );
}
