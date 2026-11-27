import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudSyncOutlined,
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  MoreOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UserSwitchOutlined,
  ImportOutlined,
  LoginOutlined,
  QrcodeOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { accountApi, accountBulkApiExtra, exportApi, groupApi, proxyApi, userApi } from '../api/endpoints';
import '../features/accounts/accounts.css';
import { useAsyncData } from '../hooks/useAsyncData';
import { useWsEvent } from '../hooks/useWebSocket';
import { useTableQuery, buildActiveFilters } from '../hooks/useTableQuery';
import { useAuth } from '../auth/AuthContext';
import { getAccountStatusOptions, getCurrentTaskOptions } from '../constants';
import { resolveEnumLabel } from '../i18n';
import { downloadBlob } from '../utils/download';
import { formatAccountAge } from '../utils/format';
import { toast } from '../utils/feedback';
import {
  ConfirmModal,
  CurrentTaskTag,
  DataTable,
  FilterBar,
  PageContainer,
  RelativeTime,
  SoftTag,
  StatCard,
  StatGrid,
  StatusBadge,
} from '../components';
import AccountDetailDrawer, { type AccountDetailHandlers } from '../features/accounts/AccountDetailDrawer';
import { BulkActionModal, CreateAccountModal, EditAccountModal, ProfileModal } from '../features/accounts/AccountModals';
import BulkResultModal from '../features/accounts/BulkResultModal';
import AccountAvatar, { forgetAvatar } from '../features/accounts/AccountAvatar';
import AccountImportModal from '../features/accounts/AccountImportModal';
import AccountLoginWizard from '../components/AccountLoginWizard';
import QrLoginModal from '../components/QrLoginModal';
import { useRowSelection } from '../features/accounts/useRowSelection';
import type { AccountOut, AccountStatus, BulkAction, BulkResultOut, CurrentTask } from '../api/types';

/** 筛选条件的字段类型（group_id 可为 null，便于 useTableQuery 泛型推导） */
interface AccountFilters extends Record<string, unknown> {
  group_id: string | null;
  status: string;
  current_task: string;
  phone: string;
  keyword: string;
}

/**
 * 限流倒计时：`limited`（临时受限）状态下显示「还有多久自己恢复」。
 * 到点后 worker 的扫描循环会把号改回「正常」，不用人工解。
 */
function FloodCountdown({ until }: { until: string }) {
  const { t } = useTranslation('accounts');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const target = new Date(until).getTime();
  if (Number.isNaN(target)) return null;
  const left = Math.ceil((target - now) / 1000);
  if (left <= 0) {
    return (
      <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
        {t('flood.recovering')}
      </span>
    );
  }
  const text = left >= 60 ? t('flood.minutes', { count: Math.ceil(left / 60) }) : t('flood.seconds', { count: left });
  return (
    <span style={{ fontSize: 'var(--tg-font-size-xs)', color: 'var(--tg-color-warning)' }}>
      {t('flood.recoverAfter', { time: text })}
    </span>
  );
}

export default function Accounts() {
  const { t, i18n } = useTranslation(['accounts', 'common', 'enums']);
  const { isAdmin } = useAuth();
  const accountStatusOptions = useMemo(() => getAccountStatusOptions(), [i18n.language]);
  const currentTaskOptions = useMemo(() => getCurrentTaskOptions(), [i18n.language]);
  const [draftPhone, setDraftPhone] = useState('');
  const [draftKeyword, setDraftKeyword] = useState('');
  const selection = useRowSelection();
  const [createOpen, setCreateOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<AccountOut | null>(null);
  const [profileAccount, setProfileAccount] = useState<AccountOut | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<AccountOut | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResultOut | null>(null);
  // 账号矩阵入口：导入向导、深度验活、节流设置
  const [importOpen, setImportOpen] = useState(false);
  // 登录入口：验证码登录（已有号可留空手机号）与扫码登录
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<AccountOut | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrAccount, setQrAccount] = useState<AccountOut | null>(null);
  // 申诉解封：模拟真人向官方 @SpamBot 走一遍流程（24 小时内不重复）
  // 批量删除：不可恢复，弹窗里要手打 DELETE 才让提交（接口也再挡一道）
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealWarmup, setAppealWarmup] = useState(true);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [warmupBusy, setWarmupBusy] = useState(false);
  const [warmupForm] = Form.useForm();
  const [probeOpen, setProbeOpen] = useState(false);
  const [probeWrite, setProbeWrite] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [throttleOpen, setThrottleOpen] = useState(false);
  const [throttleBusy, setThrottleBusy] = useState(false);
  const [throttleForm] = Form.useForm();

  const q = useTableQuery<AccountFilters>({
    filters: { group_id: null, status: '', current_task: '', phone: '', keyword: '', archived: '' },
    pageSize: 20,
  });

  const accounts = useAsyncData(
    () =>
      accountApi.list({
        ...q.params,
        group_id: (q.filters.group_id as string | null) ?? undefined,
        status: (q.filters.status as AccountStatus) || undefined,
        current_task: (q.filters.current_task as CurrentTask) || undefined,
        phone: (q.filters.phone as string) || undefined,
        keyword: (q.filters.keyword as string) || undefined,
        // 归档筛选：默认只看在用的号；选「已归档」才列出被自动归档的号和原因
        archived: q.filters.archived === 'yes' ? true : undefined,
        sort: q.sort ?? undefined,
        order: q.order ?? undefined,
      }),
    [q.paramsKey, q.sort, q.order],
  );
  const groups = useAsyncData(() => groupApi.list(), []);
  const proxies = useAsyncData(() => proxyApi.list(), []);
  const users = useAsyncData(() => (isAdmin ? userApi.list() : Promise.resolve([])), [isAdmin]);

  const summary = accounts.data?.summary ?? null;

  const commitTextFilters = () => {
    q.setFilter('phone', draftPhone.trim());
    q.setFilter('keyword', draftKeyword.trim());
  };

  const reloadAll = () => {
    void accounts.reload();
    void groups.reload();
    void proxies.reload();
  };

  // ---------------------------------------------------------------- 行内动作

  const handleCheck = async (account: AccountOut) => {
    const res = await accountApi.check(account.id);
    // 这次检测会让 Worker 顺带刷新该号的头像缓存，旧结论作废、头像位立刻重拉
    forgetAvatar(account.id);
    // 分隔用中点：掩码号码后面直接跟一长串中文太挤
    if (res.reachable) toast.success(`${res.phone_masked} · ${res.message || t('accounts:toasts.reachable')}`);
    else {
      const statusText = resolveEnumLabel(`accountStatus.${res.status}`, res.status_label, '');
      toast.error(`${res.phone_masked} · ${res.message || statusText || t('accounts:toasts.unreachable')}`);
    }
    void accounts.reload();
  };

  const handleSync = async (account: AccountOut) => {
    const res = await accountApi.syncDialogs(account.id);
    toast.success(res.message || t('accounts:toasts.syncSubmitted'));
    void accounts.reload();
  };

  const handleReleaseLease = async (account: AccountOut) => {
    const res = await accountApi.releaseLease(account.id);
    toast.success(res.message || t('accounts:toasts.leaseReleased'));
    void accounts.reload();
  };

  const handleToggleEnabled = async (account: AccountOut) => {
    const res =
      account.status === 'disabled'
        ? await accountApi.enable(account.id)
        : await accountApi.disable(account.id);
    toast.success(
      res.message || (account.status === 'disabled' ? t('accounts:toasts.accountEnabled') : t('accounts:toasts.accountDisabled')),
    );
    void accounts.reload();
  };

  const handleDelete = async () => {
    if (!deleteAccount) return;
    setDeleting(true);
    try {
      const res = await accountApi.remove(deleteAccount.id);
      toast.success(res.message || t('accounts:toasts.accountDeleted'));
      setDeleteAccount(null);
      reloadAll();
    } catch {
      /* client 已统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  const handlers: AccountDetailHandlers = {
    onCheck: handleCheck,
    onSync: handleSync,
    onEdit: setEditAccount,
    onProfile: setProfileAccount,
    onReleaseLease: handleReleaseLease,
    onToggleEnabled: handleToggleEnabled,
    onRemove: (account) => setDeleteAccount(account),
  };

  const handleExport = async () => {
    const result = await exportApi.accounts({
      group_id: (q.filters.group_id as string | null) ?? undefined,
      status: (q.filters.status as AccountStatus) || undefined,
      current_task: (q.filters.current_task as CurrentTask) || undefined,
      phone: (q.filters.phone as string) || undefined,
      keyword: (q.filters.keyword as string) || undefined,
      sort: q.sort ?? undefined,
      order: q.order ?? undefined,
    });
    downloadBlob(result.blob, result.filename);
    if (result.truncated) toast.warning(t('accounts:toasts.exportTruncated'));
    else {
      toast.success(
        t('accounts:toasts.exportSuccess', {
          total: result.total ?? t('accounts:toasts.exportAll'),
          filename: result.filename,
        }),
      );
    }
  };

  // ---------------------------------------------------------------- 表格列

  const pageIds = useMemo(() => (accounts.data?.items ?? []).map((item) => item.id), [accounts.data]);

  const baseColumns: ColumnsType<AccountOut> = useMemo(
    () => [
      {
        title: t('accounts:columns.phone'),
        dataIndex: 'phone_masked',
        key: 'phone_masked',
        width: 130,
        fixed: 'left',
        render: (value: string, record) => (
          <Tooltip title={record.display_name ? t('accounts:columns.profileNameTooltip', { name: record.display_name }) : undefined}>
            <span className="tg-flex" style={{ gap: 'var(--tg-space-sm)', alignItems: 'center' }}>
              <AccountAvatar
                accountId={record.id}
                title={record.phone || record.display_label || value}
                fallback={(record.display_name || record.username || value || '?').trim().charAt(0).toUpperCase()}
              />
              <span className="tg-stack" style={{ gap: 0, minWidth: 0 }}>
                <span className="tg-mono">{record.display_label || value}</span>
                {record.display_name ? (
                  <span className="tg-muted tg-clamp-cell" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                    {record.display_name}
                  </span>
                ) : null}
              </span>
            </span>
          </Tooltip>
        ),
      },
      { title: t('accounts:columns.username'), dataIndex: 'username', key: 'username', width: 120, render: (value: string | null) => value || <span className="tg-muted">—</span> },
      {
        title: t('accounts:columns.userId'),
        dataIndex: 'tg_user_id',
        key: 'tg_user_id',
        width: 110,
        render: (value: number | null) => (value ? <span className="tg-mono">{String(value)}</span> : <span className="tg-muted">—</span>),
      },
      { title: t('accounts:columns.age'), dataIndex: 'age_days', key: 'age_days', width: 90, render: (value: number | null) => formatAccountAge(value) },
      { title: t('accounts:columns.groupCount'), dataIndex: 'group_count', key: 'group_count', width: 80, render: (value: number) => <span className="tg-num">{value}</span> },
      {
        title: t('accounts:columns.group'),
        dataIndex: 'group_name',
        key: 'group_name',
        width: 110,
        render: (value: string | null) => (value ? <SoftTag tone="primary" size="sm">{value}</SoftTag> : <SoftTag tone="neutral" size="sm">{t('accounts:columns.ungrouped')}</SoftTag>),
      },
      {
        title: t('accounts:columns.proxy'),
        dataIndex: 'proxy_endpoint',
        key: 'proxy_endpoint',
        width: 170,
        render: (value: string | null) =>
          value ? <span className="tg-mono tg-ellipsis" style={{ display: 'inline-block', maxWidth: 150 }}>{value}</span> : <span className="tg-muted">{t('accounts:columns.direct')}</span>,
      },
      {
        title: t('accounts:columns.status'),
        dataIndex: 'status',
        key: 'status',
        width: 140,
        render: (_: unknown, record) => (
          <span className="tg-flex" style={{ gap: 'var(--tg-space-xs)', alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusBadge status={record.status} label={record.status_label} reason={record.status_reason || record.last_error} size="sm" />
            {/* 临时受限：把「还有多久自己恢复」摆在旁边——worker 每 10 秒扫一遍，到点自动改回正常 */}
            {record.status === 'limited' && record.flood_until ? (
              <FloodCountdown until={record.flood_until} />
            ) : null}
          </span>
        ),
      },
      {
        title: t('accounts:columns.currentTask'),
        dataIndex: 'current_task',
        key: 'current_task',
        width: 120,
        render: (_: unknown, record) => <CurrentTaskTag task={record.current_task} label={record.current_task_label} size="sm" />,
      },
      {
        title: t('accounts:columns.lastHeartbeat'),
        dataIndex: 'last_heartbeat',
        key: 'last_heartbeat',
        width: 150,
        render: (value: string | null) => <RelativeTime value={value} />,
      },
      {
        title: t('accounts:columns.actions'),
        key: 'actions',
        width: 132,
        fixed: 'right',
        render: (_: unknown, record) => (
          <span onClick={(event) => event.stopPropagation()} className="tg-flex" style={{ gap: 'var(--tg-space-xs)' }}>
            {/* 单号检测直接放行内：一眼可见、一点就走，不用进菜单找 */}
            <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => void handleCheck(record)}>
              {t('accounts:actions.check')}
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'check', icon: <SafetyCertificateOutlined />, label: t('accounts:actions.singleCheck') },
                  { key: 'sync', icon: <CloudSyncOutlined />, label: t('accounts:actions.syncDialogs') },
                  { key: 'login', icon: <LoginOutlined />, label: t('accounts:actions.codeLogin') },
                  { key: 'qr', icon: <QrcodeOutlined />, label: t('accounts:actions.qrLogin') },
                  { key: 'edit', icon: <EditOutlined />, label: t('accounts:actions.editGroupProxy') },
                  { key: 'profile', icon: <UserSwitchOutlined />, label: t('accounts:actions.editProfile') },
                  { key: 'release', icon: <ThunderboltOutlined />, label: t('accounts:actions.releaseLease') },
                  { type: 'divider' },
                  record.status === 'disabled'
                    ? { key: 'enable', icon: <StopOutlined />, label: t('accounts:actions.enable') }
                    : { key: 'disable', icon: <StopOutlined />, label: t('accounts:actions.disable'), danger: true },
                  { type: 'divider' },
                  { key: 'delete', label: t('accounts:actions.delete'), danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'check') void handleCheck(record);
                  if (key === 'sync') void handleSync(record);
                  if (key === 'login') {
                    setLoginAccount(record);
                    setLoginOpen(true);
                  }
                  if (key === 'qr') {
                    setQrAccount(record);
                    setQrOpen(true);
                  }
                  if (key === 'edit') setEditAccount(record);
                  if (key === 'profile') setProfileAccount(record);
                  if (key === 'release') void handleReleaseLease(record);
                  if (key === 'disable' || key === 'enable') void handleToggleEnabled(record);
                  if (key === 'delete') setDeleteAccount(record);
                },
              }}
            >
              <Button
                size="small"
                type="text"
                icon={<MoreOutlined />}
                aria-label={t('accounts:actions.accountActionsAria', { phone: record.phone_masked })}
              />
            </Dropdown>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language],
  );

  const selectColumn: ColumnsType<AccountOut>[number] = {
    title: (
      <Checkbox
        checked={selection.pageAllSelected(pageIds)}
        indeterminate={selection.pageSomeSelected(pageIds) && !selection.pageAllSelected(pageIds)}
        onChange={(event) => selection.togglePage(pageIds, event.target.checked)}
        aria-label={t('accounts:actions.selectAllOnPageAria')}
      />
    ),
    key: 'select',
    width: 44,
    fixed: 'left',
    render: (_: unknown, record) => (
      <span onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={selection.isSelected(record.id)}
          onChange={(event) => selection.toggleOne(record.id, event.target.checked)}
          aria-label={t('accounts:actions.selectAccountAria', { phone: record.phone_masked })}
        />
      </span>
    ),
  };

  // 申诉解封：给 @SpamBot 发 /start → 看判定 → 点「这是误判」，可选顺带养号
  const runAppeal = async () => {
    if (!selection.count) {
      toast.warning(t('accounts:toasts.selectAccountsForAppeal'));
      return;
    }
    setAppealBusy(true);
    try {
      const res = await accountBulkApiExtra.appeal({
        scope: 'selected',
        account_ids: selection.selectedIds,
        with_warmup: appealWarmup,
      });
      setAppealOpen(false);
      setBulkResult(res);
      reloadAll();
    } catch {
      /* client 已统一提示 */
    } finally {
      setAppealBusy(false);
    }
  };

  // 官方机制养号：上线/翻会话/下线，不发消息
  const runWarmup = async () => {
    if (!selection.count) {
      toast.warning(t('accounts:toasts.selectAccountsForWarmup'));
      return;
    }
    const values = warmupForm.getFieldsValue() as {
      rounds?: number;
      online_min_seconds?: number;
      online_max_seconds?: number;
      read_inbox?: boolean;
      typing?: boolean;
      sync_limits?: boolean;
    };
    setWarmupBusy(true);
    try {
      const res = await accountBulkApiExtra.warmup({
        scope: 'selected',
        account_ids: selection.selectedIds,
        rounds: values.rounds ?? 1,
        online_min_seconds: values.online_min_seconds ?? 60,
        online_max_seconds: values.online_max_seconds ?? 300,
        read_inbox: Boolean(values.read_inbox),
        typing: Boolean(values.typing),
        sync_limits: values.sync_limits !== false,
      });
      setWarmupOpen(false);
      setBulkResult(res);
      reloadAll();
    } catch {
      /* client 已统一提示 */
    } finally {
      setWarmupBusy(false);
    }
  };

  // 深度验活：排队执行，结果写回健康分
  const runProbe = async () => {
    if (!selection.count) {
      toast.warning(t('accounts:toasts.selectAccountsForProbe'));
      return;
    }
    setProbeBusy(true);
    try {
      const res = await accountBulkApiExtra.probe({
        scope: 'selected',
        account_ids: selection.selectedIds,
        write_probe: probeWrite,
      });
      setProbeOpen(false);
      setBulkResult(res);
      reloadAll();
    } catch {
      /* client 已统一提示 */
    } finally {
      setProbeBusy(false);
    }
  };

  // 节流设置：留空不改，填 0 回到自动阶梯
  const runThrottle = async () => {
    if (!selection.count) {
      toast.warning(t('accounts:toasts.selectAccountsForThrottle'));
      return;
    }
    const values = throttleForm.getFieldsValue() as {
      interval?: number;
      resetFlood?: boolean;
      warmupNow?: boolean;
    };
    setThrottleBusy(true);
    try {
      const res = await accountBulkApiExtra.throttle({
        scope: 'selected',
        account_ids: selection.selectedIds,
        // 每日额度已关闭（后端 throttle.DAILY_QUOTA_ENABLED=False），这里不再下发 daily_message_limit
        min_action_seconds: values.interval ?? undefined,
        reset_flood: Boolean(values.resetFlood),
        start_warmup_now: Boolean(values.warmupNow),
      });
      setThrottleOpen(false);
      setBulkResult(res);
      reloadAll();
    } catch {
      /* client 已统一提示 */
    } finally {
      setThrottleBusy(false);
    }
  };

  // 健康分列：验活结果的直观呈现（绿 ≥80 / 黄 ≥50 / 红 <50）
  // 官方身份列：显示对齐的客户端平台（导入时从官方发布版本表里取）
  const clientColumn: ColumnsType<AccountOut>[number] = {
    title: t('accounts:columns.client'),
    dataIndex: 'client_kind',
    width: 110,
    render: (value: string) => {
      const label =
        value === 'android'
          ? t('accounts:columns.clientAndroid')
          : value === 'ios'
            ? t('accounts:columns.clientIos')
            : value === 'tdesktop'
              ? t('accounts:columns.clientDesktop')
              : t('accounts:columns.clientUnaligned');
      return <SoftTag tone={value ? 'neutral' : 'warning'} size="sm">{label}</SoftTag>;
    },
  };

  // API 配置：这个号是用哪套 api_id 登录的（多套凭据混用时便于排查限流来源）
  const apiColumn: ColumnsType<AccountOut>[number] = {
    title: t('accounts:columns.apiConfig'),
    dataIndex: 'api_id',
    width: 110,
    render: (value: number | null) => (
      <span className="tg-mono" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
        {value ? `API ID: ${value}` : <span className="tg-muted">—</span>}
      </span>
    ),
  };

  const healthColumn: ColumnsType<AccountOut>[number] = {
    title: t('accounts:columns.health'),
    dataIndex: 'health_score',
    width: 88,
    render: (value: number, record) => {
      const score = Number(value ?? 0);
      const tone = score >= 80 ? 'success' : score >= 50 ? 'warning' : 'danger';
      const color = `var(--tg-color-${tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'danger'})`;
      return (
        <Tooltip title={record.health_checked_at ? t('accounts:columns.healthCheckedTooltip') : t('accounts:columns.healthUncheckedTooltip')}>
          <span className="tg-num" style={{ color, fontWeight: 'var(--tg-font-weight-medium)' }}>
            {score}
          </span>
        </Tooltip>
      );
    },
  };

  // 每日额度已在后端关闭（throttle.DAILY_QUOTA_ENABLED=False），列表不再展示「今日额度」列

  const columns: ColumnsType<AccountOut> = [
    selectColumn,
    clientColumn,
    apiColumn,
    healthColumn,
    ...baseColumns,
  ];

  // 任务进度变了就刷新列表：不用手动点，发完一条这里就跟着动
  useWsEvent('task', () => {
    void accounts.reload();
  });

  const bulkMenuItems = [
    { key: 'appeal', label: t('accounts:bulkMenu.appeal') },
    { type: 'divider' as const },
    { key: 'bulk_delete', danger: true, label: t('accounts:bulkMenu.bulkDelete') },
    { key: 'warmup', label: t('accounts:bulkMenu.warmup') },
    { key: 'probe', label: t('accounts:bulkMenu.probe') },
    { key: 'throttle', label: t('accounts:bulkMenu.throttle') },
    { type: 'divider' as const },
    { key: 'check', label: t('accounts:bulkMenu.check') },
    { key: 'sync-dialogs', label: t('accounts:bulkMenu.syncDialogs') },
    { key: 'group', label: t('accounts:bulkMenu.group') },
    { key: 'proxy', label: t('accounts:bulkMenu.proxy') },
    ...(isAdmin ? [{ key: 'assign', label: t('accounts:bulkMenu.assign') }] : []),
    { type: 'divider' as const },
    { key: 'disable', label: t('accounts:bulkMenu.disable'), danger: true },
    { key: 'enable', label: t('accounts:bulkMenu.enable') },
    { key: 'release-lease', label: t('accounts:bulkMenu.releaseLease') },
  ];

  return (
    <PageContainer
      title={t('accounts:pageTitle')}
      description={t('accounts:pageDescription')}
      actions={
        <Space>
          <Button
            icon={<LoginOutlined />}
            onClick={() => {
              setLoginAccount(null);
              setLoginOpen(true);
            }}
          >
            {t('accounts:actions.codeLogin')}
          </Button>
          <Button
            icon={<QrcodeOutlined />}
            onClick={() => {
              setQrAccount(null);
              setQrOpen(true);
            }}
          >
            {t('accounts:actions.qrLogin')}
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            {t('accounts:actions.bulkImport')}
          </Button>
        </Space>
      }
    >
      <StatGrid>
        <StatCard
          title={t('accounts:stats.total')}
          value={summary?.total ?? accounts.data?.total ?? 0}
          tone="primary"
          icon={<UserSwitchOutlined />}
          hint={t('accounts:stats.totalHint')}
          onClick={() => q.reset()}
        />
        <StatCard
          title={t('accounts:stats.healthy')}
          value={summary?.healthy ?? 0}
          tone="success"
          icon={<SafetyCertificateOutlined />}
          hint={t('accounts:stats.healthyHint')}
          onClick={() => q.setFilter('status', 'healthy')}
        />
        <StatCard
          title={t('accounts:stats.abnormal')}
          value={summary?.abnormal ?? 0}
          tone={summary?.abnormal ? 'danger' : 'success'}
          icon={<ThunderboltOutlined />}
          hint={t('accounts:stats.abnormalHint')}
        />
        <StatCard
          title={t('accounts:stats.newThisWeek')}
          value={summary?.new_this_week ?? 0}
          tone="info"
          icon={<PlusOutlined />}
          hint={t('accounts:stats.onlineAndLeased', { online: summary?.online ?? 0, leased: summary?.leased ?? 0 })}
        />
      </StatGrid>

      {/* 状态分类：冻结 / 限流这类异常态单独成类，一点就看那批号，不用在长列表里翻 */}
      <div className="tg-account-cats">
        {(() => {
          const by = summary?.by_status ?? {};
          const cats: { key: string; label: string; tone?: string }[] = [
            { key: '', label: t('accounts:categories.all') },
            { key: 'healthy', label: t('accounts:categories.healthy'), tone: 'is-ok' },
            { key: 'frozen', label: t('accounts:categories.frozen'), tone: 'is-danger' },
            { key: 'needs_code', label: t('accounts:categories.needs_code'), tone: 'is-warn' },
            { key: 'invalid', label: t('accounts:categories.invalid'), tone: 'is-danger' },
            { key: 'dead', label: t('accounts:categories.dead'), tone: 'is-danger' },
            { key: 'disabled', label: t('accounts:categories.disabled'), tone: 'is-muted' },
          ];
          const current = q.filters.status || '';
          return cats.map((cat) => {
            const count = cat.key ? (by[cat.key] ?? 0) : (summary?.total ?? 0);
            return (
              <button
                key={cat.key || 'all'}
                type="button"
                className={[
                  'tg-account-cat',
                  cat.tone ?? '',
                  count === 0 && cat.key ? 'is-zero' : '',
                  current === cat.key ? 'is-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => q.setFilter('status', cat.key)}
              >
                {cat.label}
                <b>{count}</b>
              </button>
            );
          });
        })()}
      </div>

      <FilterBar
        collapsible
        onReset={() => {
          q.reset();
          setDraftPhone('');
          setDraftKeyword('');
        }}
        onSearch={commitTextFilters}
        loading={accounts.loading}
        activeFilters={buildActiveFilters([
          {
            key: 'group_id',
            label: t('accounts:filters.group'),
            display: groups.data?.find((g) => g.id === q.filters.group_id)?.name,
            clear: () => q.setFilter('group_id', null),
          },
          {
            key: 'archived',
            label: t('accounts:filters.archived'),
            display: q.filters.archived === 'yes' ? t('accounts:filters.archivedDisplay') : undefined,
            clear: () => q.setFilter('archived', ''),
          },
          {
            key: 'status',
            label: t('accounts:filters.status'),
            display: accountStatusOptions.find((o) => o.value === q.filters.status)?.label,
            clear: () => q.setFilter('status', ''),
          },
          {
            key: 'current_task',
            label: t('accounts:filters.currentTask'),
            display: currentTaskOptions.find((o) => o.value === q.filters.current_task)?.label,
            clear: () => q.setFilter('current_task', ''),
          },
          { key: 'phone', label: t('accounts:filters.phone'), display: q.filters.phone as string, clear: () => { setDraftPhone(''); q.setFilter('phone', ''); } },
          { key: 'keyword', label: t('accounts:filters.keyword'), display: q.filters.keyword as string, clear: () => { setDraftKeyword(''); q.setFilter('keyword', ''); } },
        ])}
      >
        <Select
          allowClear
          placeholder={t('accounts:filters.archivedPlaceholder')}
          style={{ width: 190 }}
          value={(q.filters.archived as string) || undefined}
          onChange={(value) => q.setFilter('archived', value ?? '')}
          options={[{ label: t('accounts:filters.archivedOnly'), value: 'yes' }]}
        />
        <Select
          allowClear
          placeholder={t('accounts:filters.group')}
          style={{ width: 170 }}
          value={(q.filters.group_id as string | null) ?? undefined}
          onChange={(value) => q.setFilter('group_id', value ?? null)}
          options={(groups.data ?? []).map((g) => ({ value: g.id, label: `${g.name} (${g.account_count})` }))}
        />
        <Select
          allowClear
          placeholder={t('accounts:filters.status')}
          style={{ width: 130 }}
          value={(q.filters.status as string) || undefined}
          onChange={(value) => q.setFilter('status', (value as AccountStatus) ?? '')}
          options={accountStatusOptions}
        />
        <Select
          allowClear
          placeholder={t('accounts:filters.currentTask')}
          style={{ width: 150 }}
          value={(q.filters.current_task as string) || undefined}
          onChange={(value) => q.setFilter('current_task', (value as CurrentTask) ?? '')}
          options={currentTaskOptions}
        />
        <Input allowClear placeholder={t('accounts:filters.phone')} style={{ width: 150 }} value={draftPhone} onChange={(e) => setDraftPhone(e.target.value)} />
        <Input allowClear placeholder={t('accounts:filters.keywordPlaceholder')} style={{ width: 200 }} value={draftKeyword} onChange={(e) => setDraftKeyword(e.target.value)} />
      </FilterBar>

      <DataTable<AccountOut>
        rowKey="id"
        columns={columns}
        dataSource={accounts.data?.items ?? []}
        total={accounts.data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPageChange={q.setPage}
        loading={accounts.loading}
        error={accounts.error}
        onRetry={() => void accounts.reload()}
        sortableColumns={{
          phone_masked: 'phone_masked',
          username: 'username',
          age_days: 'age_days',
          group_count: 'group_count',
          status: 'status',
          current_task: 'current_task',
          last_heartbeat: 'last_heartbeat',
        }}
        sortField={q.sort}
        sortOrder={q.order}
        onSortChange={q.setSort}
        columnSettingsKey="accounts"
        scrollX={1500}
        onExport={handleExport}
        title={
          selection.count ? (
            <span className="tg-flex" style={{ alignItems: 'center', gap: 'var(--tg-space-sm)' }}>
              <span style={{ color: 'var(--tg-color-primary)' }}>{t('common:selectedCount', { count: selection.count })}</span>
              <Button type="link" size="small" onClick={selection.clear}>
                {t('accounts:actions.clearSelection')}
              </Button>
            </span>
          ) : undefined
        }
        toolbar={
          <span className="tg-flex" style={{ alignItems: 'center', gap: 'var(--tg-space-sm)' }}>
            <Dropdown
              menu={{
                items: bulkMenuItems,
                onClick: ({ key }) => {
                  // bulk_delete 有专属的强确认弹窗（要手输 DELETE），不能走 BulkActionModal
                  if (key === 'bulk_delete') setBulkDeleteOpen(true);
                  else if (key === 'probe') setProbeOpen(true);
                  else if (key === 'throttle') setThrottleOpen(true);
                  else setBulkAction(key as BulkAction);
                },
              }}
              trigger={['click']}
            >
              <Button icon={<ExportOutlined />} disabled={!accounts.data?.total}>
                {t('accounts:actions.bulkActions')} <DownOutlined />
              </Button>
            </Dropdown>
            <Button size="small" onClick={() => selection.togglePage(pageIds, true)}>
              {t('accounts:actions.selectPage')}
            </Button>
          </span>
        }
        onRow={(record) => ({
          onClick: () => setDetailId(record.id),
          style: { cursor: 'pointer' },
        })}
        empty={{
          art: 'accounts',
          title: t('accounts:empty.title'),
          description: t('accounts:empty.description'),
          action: <Button type="primary" onClick={() => setImportOpen(true)}>{t('accounts:actions.bulkImport')}</Button>,
        }}
      />

      <CreateAccountModal
        open={createOpen}
        groups={groups.data ?? []}
        proxies={proxies.data ?? []}
        onCancel={() => setCreateOpen(false)}
        onSuccess={() => {
          setCreateOpen(false);
          reloadAll();
        }}
      />

      <AccountLoginWizard
        open={loginOpen}
        account={loginAccount}
        groups={groups.data ?? []}
        proxies={proxies.data ?? []}
        onCancel={() => setLoginOpen(false)}
        onDone={() => {
          setLoginOpen(false);
          reloadAll();
        }}
      />

      <QrLoginModal
        open={qrOpen}
        account={qrAccount}
        groups={groups.data ?? []}
        proxies={proxies.data ?? []}
        onClose={() => setQrOpen(false)}
        onDone={() => {
          setQrOpen(false);
          reloadAll();
        }}
      />


      <EditAccountModal
        account={editAccount}
        groups={groups.data ?? []}
        proxies={proxies.data ?? []}
        onCancel={() => setEditAccount(null)}
        onSuccess={() => {
          setEditAccount(null);
          reloadAll();
        }}
      />

      <ProfileModal
        account={profileAccount}
        onCancel={() => setProfileAccount(null)}
        onSuccess={() => {
          setProfileAccount(null);
          void accounts.reload();
        }}
      />

      <ConfirmModal
        open={Boolean(deleteAccount)}
        danger
        title={t('accounts:deleteConfirm.title', { label: deleteAccount?.display_label || deleteAccount?.phone_masked || '' })}
        content={<Typography.Text>{t('accounts:deleteConfirm.content')}</Typography.Text>}
        confirmPhrase={deleteAccount?.display_label || deleteAccount?.phone_masked || ''}
        confirmPhraseHint={t('accounts:deleteConfirm.phraseHint')}
        okText={t('accounts:deleteConfirm.okText')}
        loading={deleting}
        onOk={() => void handleDelete()}
        onCancel={() => setDeleteAccount(null)}
      />

      <BulkActionModal
        open={Boolean(bulkAction)}
        action={bulkAction}
        selectedIds={selection.selectedIds}
        filteredTotal={accounts.data?.total ?? 0}
        groups={groups.data ?? []}
        proxies={proxies.data ?? []}
        users={users.data ?? []}
        onCancel={() => setBulkAction(null)}
        onDone={(result) => {
          setBulkAction(null);
          setBulkResult(result);
          reloadAll();
        }}
      />

      <BulkResultModal open={Boolean(bulkResult)} result={bulkResult} onClose={() => setBulkResult(null)} />

      <AccountImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          reloadAll();
        }}
      />

      <Modal
        open={bulkDeleteOpen}
        title={t('accounts:bulkDelete.title', { count: selection.count })}
        okText={t('accounts:bulkDelete.okText')}
        okButtonProps={{ danger: true, disabled: deletePhrase !== 'DELETE' }}
        cancelText={t('common:cancel')}
        confirmLoading={bulkDeleting}
        onCancel={() => {
          setBulkDeleteOpen(false);
          setDeletePhrase('');
        }}
        onOk={async () => {
          setBulkDeleting(true);
          try {
            const res = await api.post(
              '/api/accounts/bulk/delete',
              { scope: 'selected', account_ids: selection.selectedIds, confirm: 'DELETE' },
              { silent: true },
            );
            setBulkDeleteOpen(false);
            setDeletePhrase('');
            setBulkResult(res as never);
            selection.clear?.();
            reloadAll();
          } catch {
            /* client 已提示 */
          } finally {
            setBulkDeleting(false);
          }
        }}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="error"
            showIcon
            message={t('accounts:bulkDelete.alertTitle')}
            description={t('accounts:bulkDelete.alertDesc')}
          />
          <div className="tg-stack" style={{ gap: 'var(--tg-space-xs)' }}>
            <span>{t('accounts:bulkDelete.prompt')}</span>
            <Input
              value={deletePhrase}
              onChange={(e) => setDeletePhrase(e.target.value)}
              placeholder="DELETE"
              style={{ width: 200 }}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={appealOpen}
        title={t('accounts:appeal.title')}
        okText={t('accounts:appeal.okText')}
        cancelText={t('common:cancel')}
        confirmLoading={appealBusy}
        onCancel={() => setAppealOpen(false)}
        onOk={() => void runAppeal()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message={t('accounts:appeal.alertTitle', { count: selection.count })}
            description={t('accounts:appeal.alertDesc')}
          />
          <Checkbox checked={appealWarmup} onChange={(event) => setAppealWarmup(event.target.checked)}>
            {t('accounts:appeal.withWarmup')}
          </Checkbox>
        </div>
      </Modal>

      <Modal
        open={warmupOpen}
        title={t('accounts:warmup.title')}
        okText={t('accounts:warmup.okText')}
        cancelText={t('common:cancel')}
        confirmLoading={warmupBusy}
        onCancel={() => setWarmupOpen(false)}
        onOk={() => void runWarmup()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message={t('accounts:warmup.alertTitle', { count: selection.count })}
            description={t('accounts:warmup.alertDesc')}
          />
          <Form
            form={warmupForm}
            layout="vertical"
            initialValues={{ rounds: 1, online_min_seconds: 60, online_max_seconds: 300, sync_limits: true }}
          >
            <Form.Item label={t('accounts:warmup.rounds')} name="rounds">
              <InputNumber min={1} max={5} style={{ width: 140 }} />
            </Form.Item>
            <Space>
              <Form.Item label={t('accounts:warmup.onlineMin')} name="online_min_seconds">
                <InputNumber min={10} max={1800} style={{ width: 160 }} />
              </Form.Item>
              <Form.Item label={t('accounts:warmup.onlineMax')} name="online_max_seconds">
                <InputNumber min={10} max={3600} style={{ width: 160 }} />
              </Form.Item>
            </Space>
            <Form.Item name="read_inbox" valuePropName="checked" style={{ marginBottom: 'var(--tg-space-sm)' }}>
              <Checkbox>{t('accounts:warmup.readInbox')}</Checkbox>
            </Form.Item>
            <Form.Item name="typing" valuePropName="checked" style={{ marginBottom: 'var(--tg-space-sm)' }}>
              <Checkbox>{t('accounts:warmup.typing')}</Checkbox>
            </Form.Item>
            <Form.Item name="sync_limits" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('accounts:warmup.syncLimits')}</Checkbox>
            </Form.Item>
          </Form>
        </div>
      </Modal>

      <Modal
        open={probeOpen}
        title={t('accounts:probe.title')}
        okText={t('accounts:probe.okText')}
        cancelText={t('common:cancel')}
        confirmLoading={probeBusy}
        onCancel={() => setProbeOpen(false)}
        onOk={() => void runProbe()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message={t('accounts:probe.alertTitle', { count: selection.count })}
            description={t('accounts:probe.alertDesc')}
          />
          <Checkbox checked={probeWrite} onChange={(event) => setProbeWrite(event.target.checked)}>
            {t('accounts:probe.writeProbe')}
          </Checkbox>
        </div>
      </Modal>

      <Modal
        open={throttleOpen}
        title={t('accounts:throttle.title')}
        okText={t('accounts:throttle.okText')}
        cancelText={t('common:cancel')}
        confirmLoading={throttleBusy}
        onCancel={() => setThrottleOpen(false)}
        onOk={() => void runThrottle()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message={t('accounts:throttle.alertTitle', { count: selection.count })}
            description={t('accounts:throttle.alertDesc')}
          />
          <Form form={throttleForm} layout="vertical" initialValues={{ interval: undefined }}>
            <Form.Item label={t('accounts:throttle.intervalLabel')} name="interval">
              <InputNumber min={0} max={3600} style={{ width: 200 }} placeholder={t('accounts:throttle.intervalPlaceholder')} />
            </Form.Item>
            <Form.Item name="resetFlood" valuePropName="checked" style={{ marginBottom: 'var(--tg-space-md)' }}>
              <Checkbox>{t('accounts:throttle.resetFlood')}</Checkbox>
            </Form.Item>
            <Form.Item name="warmupNow" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>{t('accounts:throttle.warmupNow')}</Checkbox>
            </Form.Item>
          </Form>
        </div>
      </Modal>

      <AccountDetailDrawer accountId={detailId} handlers={handlers} onClose={() => setDetailId(null)} />
    </PageContainer>
  );
}
