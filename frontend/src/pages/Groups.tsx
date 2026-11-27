import { useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { accountApi, groupApi } from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatTime } from '../utils/format';
import { toast } from '../utils/feedback';
import { isAbnormalStatus } from '../constants';
import AccountPickerModal from '../components/AccountPickerModal';
import { ConfirmModal, DataTable, PageContainer, SoftTag, StatusDot } from '../components';
import type { GroupOut } from '../api/types';

interface GroupForm {
  name: string;
  description?: string;
}

/** 每个分组的账号状态分布（基于当前加载到的账号列表） */
interface GroupDistribution {
  healthy: number;
  pending: number;
  abnormal: number;
  /** 是否只是部分统计（账号总数超过单次拉取上限） */
  partial: boolean;
}

export default function Groups() {
  const { t } = useTranslation(['groups', 'common']);
  const groups = useAsyncData(() => groupApi.list(), []);
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<GroupOut | null>(null);
  const [deleting, setDeleting] = useState<GroupOut | null>(null);
  const [removing, setRemoving] = useState(false);
  const [memberGroup, setMemberGroup] = useState<GroupOut | null>(null);
  const [savingMembers, setSavingMembers] = useState(false);

  const allAccounts = useMemo(() => accounts.data?.items ?? [], [accounts.data]);
  const accountsTotal = accounts.data?.total ?? 0;

  const distributionOf = useMemo(() => {
    const map = new Map<string, GroupDistribution>();
    (groups.data ?? []).forEach((group) => {
      const members = allAccounts.filter((item) => item.group_id === group.id);
      map.set(group.id, {
        healthy: members.filter((item) => item.status === 'healthy').length,
        pending: members.filter((item) => item.status === 'pending').length,
        abnormal: members.filter((item) => isAbnormalStatus(item.status)).length,
        partial: accountsTotal > 200,
      });
    });
    return map;
  }, [groups.data, allAccounts, accountsTotal]);

  const memberIds = useMemo(() => {
    if (!memberGroup) return [];
    return allAccounts.filter((item) => item.group_id === memberGroup.id).map((item) => item.id);
  }, [allAccounts, memberGroup]);

  const handleDelete = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      const res = await groupApi.remove(deleting.id);
      toast.success(res.message || t('groups:toast.deleted'));
      setDeleting(null);
      void groups.reload();
      void accounts.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setRemoving(false);
    }
  };

  const handleSaveMembers = async (selectedIds: string[]) => {
    if (!memberGroup) return;
    const current = new Set(memberIds);
    const next = new Set(selectedIds);
    const added = selectedIds.filter((id) => !current.has(id));
    const removed = memberIds.filter((id) => !next.has(id));
    setSavingMembers(true);
    try {
      if (added.length) {
        const res = await groupApi.addAccounts(memberGroup.id, added);
        toast.success(res.message || t('groups:toast.addedMembers', { count: added.length }));
      }
      if (removed.length) {
        const res = await groupApi.removeAccounts(memberGroup.id, removed);
        toast.success(res.message || t('groups:toast.removedMembers', { count: removed.length }));
      }
      if (!added.length && !removed.length) toast.info(t('groups:toast.noMemberChange'));
      setMemberGroup(null);
      void groups.reload();
      void accounts.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setSavingMembers(false);
    }
  };

  const columns: ColumnsType<GroupOut> = [
    {
      title: t('groups:columns.name'),
      dataIndex: 'name',
      width: 200,
      render: (value: string) => <SoftTag tone="primary">{value}</SoftTag>,
    },
    {
      title: t('groups:columns.description'),
      dataIndex: 'description',
      render: (value: string) => value || <span className="tg-muted">—</span>,
    },
    { title: t('groups:columns.accountCount'), dataIndex: 'account_count', width: 90, render: (value: number) => <span className="tg-num">{value}</span> },
    {
      title: t('groups:columns.distribution'),
      key: 'distribution',
      width: 280,
      render: (_: unknown, record) => {
        const dist = distributionOf.get(record.id);
        if (!dist) return <span className="tg-muted">—</span>;
        const chips = [
          { label: t('groups:status.healthy'), count: dist.healthy, status: 'healthy' as const },
          { label: t('groups:status.pending'), count: dist.pending, status: 'pending' as const },
          { label: t('groups:status.abnormal'), count: dist.abnormal, status: 'frozen' as const },
        ];
        return (
          <span className="tg-flex" style={{ gap: 'var(--tg-space-md)', flexWrap: 'wrap' }}>
            {chips.map((chip) => (
              <Tooltip
                key={chip.status}
                title={t(dist.partial ? 'groups:status.tooltipPartial' : 'groups:status.tooltip', {
                  label: chip.label,
                  count: chip.count,
                })}
              >
                <span
                  className="tg-flex"
                  style={{
                    alignItems: 'center',
                    gap: 'var(--tg-space-sm)',
                    fontSize: 'var(--tg-font-size-sm)',
                    color: 'var(--tg-color-text-secondary)',
                  }}
                >
                  <StatusDot status={chip.status} kind="account" size={8} />
                  {chip.label} <span className="tg-num">{chip.count}</span>
                </span>
              </Tooltip>
            ))}
          </span>
        );
      },
    },
    {
      title: t('groups:columns.createdAt'),
      dataIndex: 'created_at',
      width: 170,
      render: (value: string | null) => formatTime(value),
    },
    {
      title: t('groups:columns.actions'),
      key: 'actions',
      width: 250,
      render: (_: unknown, record) => (
        <Space>
          <Button size="small" icon={<TeamOutlined />} onClick={() => setMemberGroup(record)}>
            {t('groups:actions.manageAccounts')}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(record)}>
            {t('groups:actions.edit')}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setDeleting(record)}>
            {t('groups:actions.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title={t('groups:title')}
      description={t('groups:description')}
      actions={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={groups.loading}
            onClick={() => {
              void groups.reload();
              void accounts.reload();
            }}
          >
            {t('common:refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('groups:create')}
          </Button>
        </Space>
      }
    >
      <DataTable<GroupOut>
        rowKey="id"
        columns={columns}
        dataSource={groups.data ?? []}
        loading={groups.loading}
        error={groups.error}
        onRetry={() => {
          void groups.reload();
          void accounts.reload();
        }}
        showDensity={false}
        empty={{
          art: 'list',
          title: t('groups:empty.title'),
          description: t('groups:empty.description'),
          action: <Button type="primary" onClick={() => setCreateOpen(true)}>{t('groups:create')}</Button>,
        }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
        {t('groups:footnote')}
      </Typography.Paragraph>

      <GroupFormModal
        open={createOpen || Boolean(editing)}
        group={editing}
        onCancel={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        onSuccess={() => {
          setCreateOpen(false);
          setEditing(null);
          void groups.reload();
          void accounts.reload();
        }}
      />

      <ConfirmModal
        open={Boolean(deleting)}
        danger
        title={t('groups:deleteConfirm.title', { name: deleting?.name ?? '' })}
        content={<Typography.Text>{t('groups:deleteConfirm.content')}</Typography.Text>}
        okText={t('groups:deleteConfirm.ok')}
        loading={removing}
        onOk={() => void handleDelete()}
        onCancel={() => setDeleting(null)}
      />

      <AccountPickerModal
        open={Boolean(memberGroup)}
        title={t('groups:membersModal.title', { name: memberGroup?.name ?? '' })}
        hint={t('groups:membersModal.hint')}
        value={memberIds}
        confirmLoading={savingMembers}
        onCancel={() => setMemberGroup(null)}
        onSubmit={handleSaveMembers}
      />
    </PageContainer>
  );
}

function GroupFormModal({
  open,
  group,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  group: GroupOut | null;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['groups', 'common']);
  const [form] = Form.useForm<GroupForm>();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(group);

  const handleFinish = async (values: GroupForm) => {
    setSubmitting(true);
    try {
      if (group) {
        await groupApi.update(group.id, { name: values.name.trim(), description: values.description ?? '' });
        toast.success(t('groups:toast.updated'));
      } else {
        await groupApi.create({ name: values.name.trim(), description: values.description ?? '' });
        toast.success(t('groups:toast.created'));
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
      title={isEdit ? t('groups:form.editTitle', { name: group?.name ?? '' }) : t('groups:form.createTitle')}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t('common:save')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        key={group?.id ?? 'new'}
        initialValues={{ name: group?.name ?? '', description: group?.description ?? '' }}
      >
        <Form.Item
          label={t('groups:form.nameLabel')}
          name="name"
          rules={[
            { required: true, message: t('groups:form.nameRequired') },
            { max: 64, message: t('groups:form.nameMax') },
          ]}
        >
          <Input placeholder={t('groups:form.namePlaceholder')} allowClear />
        </Form.Item>
        <Form.Item label={t('groups:form.descriptionLabel')} name="description">
          <Input.TextArea rows={2} placeholder={t('groups:form.descriptionPlaceholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
