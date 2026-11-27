/**
 * Inbox —— 客服收件箱：跨账号把「有人刚发来、还没处理」的私信集中排出来。
 *
 * 为什么要有这一页：会话页是「先选号 → 再看会话」，号一多就容易漏回。
 * 这里不选号，直接把所有号收到的新消息按**未读优先**排在一起，
 * 点任意一条跳到会话页即可直接回复（回复链路本来就有，这里补的是「集中视图」）。
 */
import { Button, Card, Space, Switch, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAsyncData } from '../hooks/useAsyncData';
import { dialogApi } from '../api/endpoints';
import { PageContainer, RelativeTime } from '../components';

export default function Inbox() {
  const { t } = useTranslation(['dialogs', 'common']);
  const navigate = useNavigate();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const inbox = useAsyncData(() => dialogApi.inbox({ limit: 200, only_unread: onlyUnread }), [onlyUnread]);

  return (
    <PageContainer
      title={t('dialogs:inbox.pageTitle')}
      description={t('dialogs:inbox.pageDescription')}
      actions={
        <Space>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-sm)' }}>{t('dialogs:inbox.onlyUnread')}</span>
          <Switch
            size="small"
            checked={onlyUnread}
            onChange={(next) => {
              setOnlyUnread(next);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void inbox.reload()} loading={inbox.loading}>
            {t('common:refresh')}
          </Button>
        </Space>
      }
    >
      <Card size="small">
        <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
          {t('dialogs:inbox.summaryPrefix', { total: inbox.data?.total ?? 0 })}
          <b style={{ color: 'var(--tg-color-error)' }}>{inbox.data?.unread_total ?? 0}</b>
          {t('dialogs:inbox.summarySuffix')}
        </Typography.Text>
        <Table
          size="small"
          rowKey="dialog_id"
          style={{ marginTop: 'var(--tg-space-sm)' }}
          dataSource={inbox.data?.items ?? []}
          loading={inbox.loading}
          pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
          onRow={(record) => ({
            onClick: () => navigate(`/dialogs?dialog_id=${record.dialog_id}${record.account_id ? `&account_id=${record.account_id}` : ''}`),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: onlyUnread ? t('dialogs:inbox.emptyUnread') : t('dialogs:inbox.emptyAll') }}
          columns={[
            {
              title: t('dialogs:inbox.colAccount'),
              dataIndex: 'account_label',
              width: 150,
              render: (value: string | null) => <span className="tg-mono">{value || '—'}</span>,
            },
            {
              title: t('dialogs:inbox.colUnread'),
              dataIndex: 'unread_count',
              width: 80,
              render: (value: number) => (value > 0 ? <Tag color="red">{value}</Tag> : <span className="tg-muted">—</span>),
            },
            { title: t('dialogs:inbox.colPeer'), dataIndex: 'title', width: 180 },
            { title: t('dialogs:inbox.colLastMessage'), dataIndex: 'last_message_preview', ellipsis: true },
            {
              title: t('dialogs:inbox.colTime'),
              dataIndex: 'last_message_at',
              width: 110,
              render: (value: string | null) => (value ? <RelativeTime value={value} /> : '—'),
            },
            {
              title: t('dialogs:inbox.colAction'),
              width: 90,
              render: () => <Button type="link" size="small">{t('dialogs:inbox.reply')}</Button>,
            },
          ]}
        />
      </Card>
    </PageContainer>
  );
}
