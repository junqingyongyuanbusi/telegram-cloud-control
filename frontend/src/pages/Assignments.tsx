/**
 * 员工分配页（admin 专属）：
 * - 员工列表：用户名/角色/启用状态/已分配账号数/最后登录；
 * - 新建 / 改口令 / 停用 / 启用 / 删除；
 * - 选员工 → 账号选择器（搜索/分组筛选/多选/「未分配」视图，行内显示归属人）批量分配/取消；
 * - 分配矩阵：每个员工名下的账号一览；
 * - operator 访问：不请求任何接口，直接给中文 403 提示。
 */
import { useMemo, useState } from 'react';
import { Button, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  ConfirmModal,
  DataTable,
  ErrorState,
  PageContainer,
  RelativeTime,
  SectionCard,
  SoftTag,
  StatCard,
  StatGrid,
} from '../components';
import { accountApi, assignmentApi, userApi } from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { resolveEnumLabel } from '../i18n';
import { formatNumber, shortId } from '../utils/format';
import { notifySuccess } from '../utils/feedback';
import { useAuth } from '../auth/AuthContext';
import type { UserOut, UserRole } from '../api/types';
import { AccountAssignModal } from '../features/assignments/AccountAssignModal';
import { PasswordModal, UserFormModal } from '../features/assignments/UserFormModal';

export default function Assignments() {
  const { t } = useTranslation(['assignments', 'common', 'enums']);
  const { isAdmin, user: currentUser } = useAuth();
  const users = useAsyncData(() => userApi.list(), [], { immediate: isAdmin });
  const assignments = useAsyncData(() => assignmentApi.list(), [], { immediate: isAdmin });
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }), [], {
    immediate: isAdmin,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserOut | null>(null);
  const [assignUser, setAssignUser] = useState<UserOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserOut | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const userList = useMemo(() => users.data ?? [], [users.data]);
  const assignmentList = useMemo(() => assignments.data ?? [], [assignments.data]);
  const accountList = useMemo(() => accounts.data?.items ?? [], [accounts.data]);

  const assignedAccountCount = useMemo(() => {
    const set = new Set<string>();
    for (const item of assignmentList) for (const id of item.account_ids) set.add(id);
    return set.size;
  }, [assignmentList]);
  const unassignedCount = Math.max(0, accountList.length - assignedAccountCount);
  const operatorCount = userList.filter((item) => item.role === 'operator').length;

  // 分配矩阵：每个员工名下的账号标签（管理员行说明「看全部」）
  const accountLabelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of accountList) map.set(item.id, item.phone_masked);
    return map;
  }, [accountList]);

  const matrixRows = useMemo(
    () =>
      assignmentList.map((item) => ({
        ...item,
        labels: item.account_ids.map((id) => accountLabelOf.get(id) ?? shortId(id)),
      })),
    [assignmentList, accountLabelOf],
  );

  // operator 访问：管理端专属页，直接给中文 403 提示（接口同样拒绝，这里不再发起请求）
  if (!isAdmin) {
    return (
      <PageContainer title={t('assignments:page.title')} description={t('assignments:forbidden.pageDesc')}>
        <SectionCard>
          <ErrorState
            title={t('assignments:forbidden.title')}
            description={t('assignments:forbidden.description')}
            error={t('assignments:forbidden.error')}
            compact
          />
        </SectionCard>
      </PageContainer>
    );
  }

  const handleToggleActive = async (record: UserOut) => {
    setBusyId(record.id);
    try {
      await userApi.update(record.id, { is_active: !record.is_active });
      notifySuccess(record.is_active ? t('assignments:toast.userDisabled') : t('assignments:toast.userEnabled'));
      void users.reload();
    } catch {
      /* 最后一个管理员的保护等后端 400/409 中文原因已由 client 统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await userApi.remove(deleteTarget.id);
      notifySuccess(res.message || t('assignments:toast.userDeleted'));
      setDeleteTarget(null);
      void users.reload();
      void assignments.reload();
    } catch {
      /* client 已统一中文提示 */
    } finally {
      setDeleting(false);
    }
  };

  const columns: ColumnsType<UserOut> = [
    {
      title: t('assignments:columns.username'),
      dataIndex: 'username',
      width: 170,
      render: (value: string, record) => (
        <div className="tg-stack">
          <span>{value}</span>
          {record.display_name && record.display_name !== value ? (
            <Typography.Text type="secondary">{record.display_name}</Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: t('assignments:columns.role'),
      dataIndex: 'role',
      width: 100,
      render: (value: UserRole) => (
        <SoftTag tone={value === 'admin' ? 'primary' : 'neutral'}>
          {resolveEnumLabel(`userRole.${value}`, undefined, value)}
        </SoftTag>
      ),
    },
    {
      title: t('assignments:columns.status'),
      dataIndex: 'is_active',
      width: 90,
      render: (value: boolean) => (
        <SoftTag tone={value ? 'success' : 'neutral'}>
          {value ? t('assignments:status.active') : t('assignments:status.inactive')}
        </SoftTag>
      ),
    },
    {
      title: t('assignments:columns.assignedCount'),
      dataIndex: 'account_count',
      width: 130,
      align: 'right',
      render: (value: number, record) => (
        <Space size={6}>
          <span className="tg-num">{formatNumber(value)}</span>
          {record.role === 'admin' ? (
            <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
              {t('assignments:table.adminSeesAll')}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('assignments:columns.lastLogin'),
      dataIndex: 'last_login_at',
      width: 150,
      render: (value: string | null) => <RelativeTime value={value} />,
    },
    {
      title: t('assignments:columns.actions'),
      key: 'actions',
      width: 340,
      fixed: 'right',
      render: (_: unknown, record) => {
        const isSelf = record.id === currentUser?.id;
        return (
          <Space size="small" wrap>
            <Tooltip title={record.role === 'admin' ? t('assignments:actions.adminNoAssignHint') : undefined}>
              <Button
                size="small"
                icon={<TeamOutlined />}
                disabled={record.role === 'admin'}
                onClick={() => setAssignUser(record)}
              >
                {t('assignments:actions.assignAccounts')}
              </Button>
            </Tooltip>
            <Button size="small" icon={<KeyOutlined />} onClick={() => setPwdUser(record)}>
              {t('assignments:actions.changePassword')}
            </Button>
            <Button
              size="small"
              loading={busyId === record.id}
              disabled={isSelf}
              onClick={() => void handleToggleActive(record)}
            >
              {record.is_active ? t('assignments:actions.disable') : t('assignments:actions.enable')}
            </Button>
            <Tooltip title={isSelf ? t('assignments:actions.cannotDeleteSelf') : undefined}>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={isSelf}
                onClick={() => setDeleteTarget(record)}
              >
                {t('assignments:actions.delete')}
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const matrixColumns: ColumnsType<(typeof matrixRows)[number]> = [
    {
      title: t('assignments:matrix.staff'),
      dataIndex: 'username',
      width: 200,
      render: (value: string, record) => (
        <div className="tg-stack">
          <span>{value}</span>
          {record.display_name && record.display_name !== value ? (
            <Typography.Text type="secondary">{record.display_name}</Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: t('assignments:matrix.accountCount'),
      dataIndex: 'account_count',
      width: 90,
      align: 'right',
      render: (value: number) => <span className="tg-num">{formatNumber(value)}</span>,
    },
    {
      title: t('assignments:matrix.accounts'),
      key: 'labels',
      render: (_: unknown, record) =>
        record.labels.length ? (
          <Space size={6} wrap>
            {record.labels.map((label: string) => (
              <SoftTag key={label} tone="info">
                {label}
              </SoftTag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('assignments:matrix.noAccounts')}</Typography.Text>
        ),
    },
  ];

  return (
    <PageContainer
      title={t('assignments:page.title')}
      description={t('assignments:page.description')}
      actions={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={users.loading}
            onClick={() => {
              void users.reload();
              void assignments.reload();
              void accounts.reload();
            }}
          >
            {t('common:refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('assignments:actions.createStaff')}
          </Button>
        </Space>
      }
    >
      <StatGrid>
        <StatCard title={t('assignments:stats.totalStaff')} value={userList.length} tone="neutral" />
        <StatCard title={t('assignments:stats.operators')} value={operatorCount} tone="primary" />
        <StatCard title={t('assignments:stats.assignedAccounts')} value={assignedAccountCount} tone="success" />
        <StatCard title={t('assignments:stats.unassignedAccounts')} value={unassignedCount} tone="warning" />
      </StatGrid>

      <DataTable<UserOut>
        rowKey="id"
        columns={columns}
        dataSource={userList}
        loading={users.loading}
        error={users.error}
        onRetry={() => void users.reload()}
        columnSettingsKey="assignments-users"
        scrollX={1100}
        empty={{
          art: 'accounts',
          title: t('assignments:empty.usersTitle'),
          description: t('assignments:empty.usersDesc'),
          action: (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('assignments:actions.createStaff')}
            </Button>
          ),
        }}
      />

      <SectionCard
        title={t('assignments:matrix.title')}
        subtitle={t('assignments:matrix.subtitle')}
        bodyPadding="none"
      >
        <DataTable<(typeof matrixRows)[number]>
          rowKey="user_id"
          columns={matrixColumns}
          dataSource={matrixRows}
          loading={assignments.loading}
          error={assignments.error}
          onRetry={() => void assignments.reload()}
          showDensity={false}
          scrollX={760}
          empty={{
            art: 'list',
            title: t('assignments:empty.matrixTitle'),
            description: t('assignments:empty.matrixDesc'),
          }}
        />
      </SectionCard>

      <UserFormModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onSuccess={() => {
          setCreateOpen(false);
          void users.reload();
        }}
      />

      <PasswordModal user={pwdUser} onCancel={() => setPwdUser(null)} onSuccess={() => setPwdUser(null)} />

      <AccountAssignModal
        open={Boolean(assignUser)}
        user={assignUser}
        assignments={assignmentList}
        accounts={accountList}
        onCancel={() => setAssignUser(null)}
        onSaved={() => {
          setAssignUser(null);
          void users.reload();
          void assignments.reload();
        }}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        danger
        loading={deleting}
        title={t('assignments:deleteConfirm.title', { username: deleteTarget?.username ?? '' })}
        content={t('assignments:deleteConfirm.content')}
        okText={t('assignments:actions.delete')}
        onOk={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </PageContainer>
  );
}
