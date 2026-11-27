import { useMemo, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiOutlined, DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { accountApi, proxyApi } from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { isAbnormalStatus, PROXY_SCHEME_OPTIONS } from '../constants';
import { formatTime } from '../utils/format';
import { toast } from '../utils/feedback';
import AccountPickerModal from '../components/AccountPickerModal';
import { ConfirmModal, CopyableText, DataTable, PageContainer, SoftTag, StatusDot } from '../components';
import { normalizeHost, parseEndpoint } from '../features/network/proxyNormalize';
import type { ProxyCreate, ProxyOut, ProxyScheme } from '../api/types';

export default function Network() {
  const { t } = useTranslation(['network', 'common']);
  const proxies = useAsyncData(() => proxyApi.list(), []);
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyOut | null>(null);
  const [deleting, setDeleting] = useState<ProxyOut | null>(null);
  const [removing, setRemoving] = useState(false);
  const [bindProxy, setBindProxy] = useState<ProxyOut | null>(null);
  const [saving, setSaving] = useState(false);

  const allAccounts = useMemo(() => accounts.data?.items ?? [], [accounts.data]);

  /** proxy_id → 绑定账号的状态分布（健康提示用） */
  const healthOf = useMemo(() => {
    const map = new Map<string, { healthy: number; abnormal: number; pending: number }>();
    allAccounts.forEach((item) => {
      if (!item.proxy_id) return;
      const entry = map.get(item.proxy_id) ?? { healthy: 0, abnormal: 0, pending: 0 };
      if (item.status === 'healthy') entry.healthy += 1;
      else if (item.status === 'pending') entry.pending += 1;
      else if (isAbnormalStatus(item.status)) entry.abnormal += 1;
      map.set(item.proxy_id, entry);
    });
    return map;
  }, [allAccounts]);

  const boundIds = useMemo(() => {
    if (!bindProxy) return [];
    return allAccounts.filter((item) => item.proxy_id === bindProxy.id).map((item) => item.id);
  }, [allAccounts, bindProxy]);

  const handleDelete = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      const res = await proxyApi.remove(deleting.id);
      toast.success(res.message || t('network:toast.deleted'));
      setDeleting(null);
      void proxies.reload();
      void accounts.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setRemoving(false);
    }
  };

  const handleBind = async (selectedIds: string[]) => {
    if (!bindProxy) return;
    const current = new Set(boundIds);
    const next = new Set(selectedIds);
    const added = selectedIds.filter((id) => !current.has(id));
    const removed = boundIds.filter((id) => !next.has(id));
    setSaving(true);
    try {
      if (added.length) {
        const res = await proxyApi.bindAccounts(bindProxy.id, added);
        toast.success(res.message || t('network:toast.bound', { count: added.length }));
      }
      // 契约只提供代理 → 账号的绑定接口，解绑走账号侧 PATCH proxy_id=null（显式传 null = 直连）
      for (const accountId of removed) {
        await accountApi.update(accountId, { proxy_id: null });
      }
      if (removed.length) toast.success(t('network:toast.unbound', { count: removed.length }));
      if (!added.length && !removed.length) toast.info(t('network:toast.noBindChange'));
      setBindProxy(null);
      void proxies.reload();
      void accounts.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<ProxyOut> = [
    {
      title: t('network:columns.name'),
      dataIndex: 'name',
      width: 140,
      render: (value: string) => <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>{value}</span>,
    },
    {
      title: t('network:columns.scheme'),
      dataIndex: 'scheme',
      width: 100,
      render: (value: string) => <SoftTag tone="info" size="sm">{value.toUpperCase()}</SoftTag>,
    },
    {
      title: t('network:columns.endpoint'),
      dataIndex: 'endpoint',
      render: (value: string) => <CopyableText value={value} mono maxLength={40} truncate="middle" />,
    },
    {
      title: t('network:columns.auth'),
      dataIndex: 'has_auth',
      width: 100,
      render: (value: boolean) =>
        value ? (
          <SoftTag tone="success" size="sm">{t('network:auth.configured')}</SoftTag>
        ) : (
          <SoftTag tone="neutral" size="sm">{t('network:auth.none')}</SoftTag>
        ),
    },
    {
      title: t('network:columns.binding'),
      key: 'binding',
      width: 210,
      render: (_: unknown, record) => {
        const health = healthOf.get(record.id);
        return (
          <span className="tg-flex" style={{ alignItems: 'center', gap: 'var(--tg-space-sm)' }}>
            <span className="tg-num">{t('network:binding.count', { count: record.account_count })}</span>
            {health && health.abnormal > 0 ? (
              <Tooltip title={t('network:binding.abnormalTooltip')}>
                <SoftTag tone="danger" size="sm">
                  <ThunderboltOutlined /> {t('network:binding.abnormalCount', { count: health.abnormal })}
                </SoftTag>
              </Tooltip>
            ) : record.account_count > 0 ? (
              <SoftTag tone="success" size="sm">{t('network:binding.allHealthy')}</SoftTag>
            ) : (
              <SoftTag tone="neutral" size="sm">{t('network:binding.unbound')}</SoftTag>
            )}
          </span>
        );
      },
    },
    {
      title: t('network:columns.enabled'),
      dataIndex: 'enabled',
      width: 80,
      render: (value: boolean, record) => (
        <Switch
          size="small"
          checked={value}
          onChange={async (checked) => {
            try {
              await proxyApi.update(record.id, { enabled: checked });
              toast.success(checked ? t('network:toast.enabled') : t('network:toast.disabled'));
              void proxies.reload();
            } catch {
              /* client 已统一提示 */
            }
          }}
        />
      ),
    },
    { title: t('network:columns.remark'), dataIndex: 'remark', width: 140, render: (value: string) => value || <span className="tg-muted">—</span> },
    { title: t('network:columns.createdAt'), dataIndex: 'created_at', width: 160, render: (value: string | null) => formatTime(value) },
    {
      title: t('network:columns.actions'),
      key: 'actions',
      width: 250,
      render: (_: unknown, record) => (
        <Space>
          <Button size="small" icon={<LinkOutlined />} onClick={() => setBindProxy(record)}>
            {t('network:actions.bindAccounts')}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(record)}>
            {t('network:actions.edit')}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleting(record)}>
            {t('network:actions.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title={t('network:title')}
      description={t('network:description')}
      actions={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={proxies.loading}
            onClick={() => {
              void proxies.reload();
              void accounts.reload();
            }}
          >
            {t('common:refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('network:create')}
          </Button>
        </Space>
      }
    >
      <DataTable<ProxyOut>
        rowKey="id"
        columns={columns}
        dataSource={proxies.data ?? []}
        loading={proxies.loading}
        error={proxies.error}
        onRetry={() => {
          void proxies.reload();
          void accounts.reload();
        }}
        showDensity={false}
        scrollX={1300}
        empty={{
          art: 'network',
          title: t('network:empty.title'),
          description: t('network:empty.description'),
          action: <Button type="primary" onClick={() => setCreateOpen(true)}>{t('network:create')}</Button>,
        }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
        <StatusDot status="healthy" kind="account" size={8} /> {t('network:footnote')}
      </Typography.Paragraph>

      <ProxyFormModal
        open={createOpen || Boolean(editing)}
        proxy={editing}
        onCancel={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        onSuccess={() => {
          setCreateOpen(false);
          setEditing(null);
          void proxies.reload();
          void accounts.reload();
        }}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        danger
        title={t('network:deleteConfirm.title', { name: deleting?.name ?? '' })}
        content={<Typography.Text>{t('network:deleteConfirm.content')}</Typography.Text>}
        okText={t('network:deleteConfirm.ok')}
        loading={removing}
        onOk={() => void handleDelete()}
        onCancel={() => setDeleting(null)}
      />

      <AccountPickerModal
        open={Boolean(bindProxy)}
        title={t('network:bindModal.title', { name: bindProxy?.name ?? '' })}
        hint={t('network:bindModal.hint')}
        value={boundIds}
        confirmLoading={saving}
        onCancel={() => setBindProxy(null)}
        onSubmit={handleBind}
      />
    </PageContainer>
  );
}

// ---------------------------------------------------------------- 代理表单（含出口规范化）

interface ProxyForm {
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  remark?: string;
}

function ProxyFormModal({
  open,
  proxy,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  proxy: ProxyOut | null;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['network', 'common']);
  const [form] = Form.useForm<ProxyForm>();
  const [submitting, setSubmitting] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const validateHost = (raw: string): string | null => {
    const value = raw.trim();
    if (!value) return t('network:form.hostErrRequired');
    if (/\s/.test(value)) return t('network:form.hostErrWhitespace');
    if (/^[a-z0-9]+:\/\//i.test(value)) return t('network:form.hostErrScheme');
    if (/[/?#]/.test(value)) return t('network:form.hostErrPath');
    return null;
  };

  const applyParse = () => {
    const parsed = parseEndpoint(endpoint);
    if (!parsed.host) {
      setParseError(t('network:form.parseError'));
      return;
    }
    setParseError(null);
    const patch: Record<string, unknown> = {};
    if (parsed.scheme) patch.scheme = parsed.scheme;
    if (parsed.host) patch.host = parsed.host;
    if (parsed.port) patch.port = parsed.port;
    if (parsed.username) patch.username = parsed.username;
    if (parsed.password) patch.password = parsed.password;
    form.setFieldsValue(patch as never);
    toast.success(t('network:form.parseSuccess'));
  };

  const handleFinish = async (values: ProxyForm) => {
    setSubmitting(true);
    const payload: ProxyCreate = {
      name: values.name.trim(),
      scheme: values.scheme,
      host: normalizeHost(values.host),
      port: values.port,
      enabled: values.enabled,
      remark: values.remark ?? '',
    };
    // 只有填了才提交账号密码，留空 = 不改动
    if (values.username?.trim()) payload.username = values.username.trim();
    if (values.password) payload.password = values.password;

    try {
      if (proxy) {
        await proxyApi.update(proxy.id, payload);
        toast.success(t('network:toast.updated'));
      } else {
        await proxyApi.create(payload);
        toast.success(t('network:toast.created'));
      }
      onSuccess();
    } catch {
      /* client 已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={proxy ? t('network:form.editTitle', { name: proxy.name }) : t('network:form.createTitle')}
      onCancel={() => {
        setEndpoint('');
        setParseError(null);
        onCancel();
      }}
      onOk={() => form.submit()}
      okText={t('common:save')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
      width={560}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        key={proxy?.id ?? 'new'}
        initialValues={{
          name: proxy?.name ?? '',
          scheme: (proxy?.scheme as ProxyScheme) ?? 'socks5',
          host: proxy?.host ?? '',
          port: proxy?.port ?? 1080,
          enabled: proxy?.enabled ?? true,
          remark: proxy?.remark ?? '',
        }}
      >
        {!proxy ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('network:form.parseHint')}
          />
        ) : null}
        {!proxy ? (
          <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
            <Input
              prefix={<ApiOutlined />}
              placeholder={t('network:form.parsePlaceholder')}
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                setParseError(null);
              }}
              onPressEnter={applyParse}
            />
            <Button onClick={applyParse}>{t('network:form.parseButton')}</Button>
          </Space.Compact>
        ) : null}
        {parseError ? (
          <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12, fontSize: 'var(--tg-font-size-sm)' }}>
            {parseError}
          </Typography.Text>
        ) : null}

        <Form.Item
          label={t('network:form.nameLabel')}
          name="name"
          rules={[
            { required: true, message: t('network:form.nameRequired') },
            { max: 64, message: t('network:form.nameMax') },
          ]}
        >
          <Input placeholder={t('network:form.namePlaceholder')} allowClear />
        </Form.Item>

        <div className="tg-flex" style={{ gap: 'var(--tg-space-md)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Form.Item label={t('network:form.schemeLabel')} name="scheme" rules={[{ required: true, message: t('network:form.schemeRequired') }]}>
            <Select style={{ width: 140 }} options={PROXY_SCHEME_OPTIONS} />
          </Form.Item>
          <Form.Item
            label={t('network:form.hostLabel')}
            name="host"
            style={{ minWidth: 220 }}
            rules={[
              {
                validator: (_rule, value: string) => {
                  const err = validateHost(value ?? '');
                  return err ? Promise.reject(new Error(err)) : Promise.resolve();
                },
              },
            ]}
            normalize={(value: string) => normalizeHost(value ?? '')}
          >
            <Input placeholder={t('network:form.hostPlaceholder')} allowClear prefix={<ApiOutlined />} />
          </Form.Item>
          <Form.Item label={t('network:form.portLabel')} name="port" rules={[{ required: true, message: t('network:form.portRequired') }]}>
            <InputNumber min={1} max={65535} precision={0} style={{ width: 110 }} />
          </Form.Item>
        </div>

        <Form.Item label={t('network:form.usernameLabel')} name="username">
          <Input placeholder={t('network:form.optionalPlaceholder')} allowClear autoComplete="off" />
        </Form.Item>
        <Form.Item label={t('network:form.passwordLabel')} name="password">
          <Input.Password placeholder={t('network:form.optionalPlaceholder')} autoComplete="new-password" />
        </Form.Item>
        <Form.Item label={t('network:form.enabledLabel')} name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label={t('network:form.remarkLabel')} name="remark">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
