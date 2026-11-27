/**
 * 账号管理页面私有弹窗（新建 / 改分组代理 / 改资料 / 批量操作参数）。
 * 只被 pages/Accounts.tsx 使用；通用交互走 components/ 的 ConfirmModal、AccountLoginWizard 等。
 */
import MaterialSelect from '../materials/MaterialSelect';
import { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { accountBulkApi, accountApi } from '../../api/endpoints';
import { toast } from '../../utils/feedback';
import type {
  AccountOut,
  BulkAccountRequest,
  BulkAction,
  BulkResultOut,
  GroupOut,
  ProxyOut,
  UserOut,
} from '../../api/types';

// ---------------------------------------------------------------- 新建账号

interface CreateForm {
  phone: string;
  group_id?: string;
  proxy_id?: string;
  remark?: string;
}

export function CreateAccountModal({
  open,
  groups,
  proxies,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  groups: GroupOut[];
  proxies: ProxyOut[];
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['accounts', 'common']);
  const [form] = Form.useForm<CreateForm>();
  const [submitting, setSubmitting] = useState(false);

  const handleFinish = async (values: CreateForm) => {
    setSubmitting(true);
    try {
      await accountApi.create({
        phone: values.phone.trim(),
        group_id: values.group_id || null,
        proxy_id: values.proxy_id || null,
        remark: values.remark ?? '',
      });
      toast.success(t('accounts:toasts.accountCreated'));
      form.resetFields();
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
      title={t('accounts:createModal.title')}
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      onOk={() => form.submit()}
      okText={t('accounts:createModal.okText')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('accounts:createModal.alert')}
      />
      <Form form={form} layout="vertical" onFinish={handleFinish} autoComplete="off">
        <Form.Item
          label={t('accounts:createModal.phoneLabel')}
          name="phone"
          rules={[{ required: true, message: t('accounts:createModal.phoneRequired') }]}
        >
          <Input placeholder="+12025550143" allowClear />
        </Form.Item>
        <Form.Item label={t('accounts:createModal.groupLabel')} name="group_id">
          <Select allowClear placeholder={t('accounts:createModal.groupPlaceholder')} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        </Form.Item>
        <Form.Item label={t('accounts:createModal.proxyLabel')} name="proxy_id">
          <Select allowClear placeholder={t('accounts:createModal.proxyPlaceholder')} options={proxies.map((p) => ({ value: p.id, label: `${p.name} (${p.endpoint})` }))} />
        </Form.Item>
        <Form.Item label={t('accounts:createModal.remarkLabel')} name="remark">
          <Input.TextArea rows={2} placeholder={t('accounts:createModal.remarkPlaceholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 改分组 / 代理

export function EditAccountModal({
  account,
  groups,
  proxies,
  onCancel,
  onSuccess,
}: {
  account: AccountOut | null;
  groups: GroupOut[];
  proxies: ProxyOut[];
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['accounts', 'common']);
  const [form] = Form.useForm<{ group_id?: string | null; proxy_id?: string | null; remark?: string }>();
  const [submitting, setSubmitting] = useState(false);

  const handleFinish = async (values: { group_id?: string | null; proxy_id?: string | null; remark?: string }) => {
    if (!account) return;
    setSubmitting(true);
    try {
      await accountApi.update(account.id, {
        group_id: values.group_id ?? null,
        proxy_id: values.proxy_id ?? null,
        remark: values.remark ?? '',
      });
      toast.success(t('accounts:toasts.saved'));
      onSuccess();
    } catch {
      /* client 已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(account)}
      title={t('accounts:editModal.title', { label: account?.display_label || account?.phone_masked || '' })}
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
        initialValues={{
          group_id: account?.group_id ?? undefined,
          proxy_id: account?.proxy_id ?? undefined,
          remark: account?.remark ?? '',
        }}
        key={account?.id}
      >
        <Form.Item label={t('accounts:editModal.groupLabel')} name="group_id">
          <Select allowClear placeholder={t('accounts:editModal.groupPlaceholder')} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        </Form.Item>
        <Form.Item label={t('accounts:editModal.proxyLabel')} name="proxy_id">
          <Select allowClear placeholder={t('accounts:editModal.proxyPlaceholder')} options={proxies.map((p) => ({ value: p.id, label: `${p.name} (${p.endpoint})` }))} />
        </Form.Item>
        <Form.Item label={t('accounts:editModal.remarkLabel')} name="remark">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Typography.Text type="secondary">
          {t('accounts:editModal.hint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 改资料

export function ProfileModal({
  account,
  onCancel,
  onSuccess,
}: {
  account: AccountOut | null;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['accounts', 'common']);
  const [form] = Form.useForm<{
    first_name?: string;
    last_name?: string;
    bio?: string;
    username?: string;
    photo_url?: string;
  }>();
  const [submitting, setSubmitting] = useState(false);

  const handleFinish = async (values: {
    first_name?: string;
    last_name?: string;
    bio?: string;
    username?: string;
    photo_url?: string;
  }) => {
    if (!account) return;
    // 只提交真正填了的字段：契约里这些字段都可选，回空串有清空 Telegram 资料的风险
    const payload: Record<string, string> = {};
    (['first_name', 'last_name', 'bio', 'username', 'photo_url'] as const).forEach((key) => {
      const value = values[key]?.trim();
      if (value) payload[key] = value;
    });
    if (!Object.keys(payload).length) {
      toast.error(t('accounts:toasts.profileAtLeastOneField'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await accountApi.profile(account.id, payload);
      toast.success(res.message || t('accounts:toasts.profileSubmitted'));
      onSuccess();
    } catch {
      /* client 已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(account)}
      title={t('accounts:profileModal.title', { label: account?.display_label || account?.phone_masked || '' })}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t('accounts:profileModal.okText')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('accounts:profileModal.alert')}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        key={account?.id}
        initialValues={{ first_name: account?.display_name ?? '' }}
      >
        <Form.Item label={t('accounts:profileModal.firstNameLabel')} name="first_name">
          <Input placeholder={t('accounts:profileModal.firstNamePlaceholder')} allowClear />
        </Form.Item>
        <Form.Item label={t('accounts:profileModal.lastNameLabel')} name="last_name">
          <Input placeholder={t('accounts:profileModal.lastNamePlaceholder')} allowClear />
        </Form.Item>
        <Form.Item label={t('accounts:profileModal.bioLabel')} name="bio">
          <Input.TextArea rows={2} placeholder={t('accounts:profileModal.bioPlaceholder')} />
        </Form.Item>
        <Form.Item label={t('accounts:profileModal.usernameLabel')} name="username">
          <Input placeholder={t('accounts:profileModal.usernamePlaceholder')} allowClear />
        </Form.Item>
        <Form.Item
          label={t('accounts:profileModal.avatarLabel')}
          name="photo_material_id"
          tooltip={t('accounts:profileModal.avatarTooltip')}
        >
          <MaterialSelect kinds={['photo']} placeholder={t('accounts:profileModal.avatarPlaceholder')} />
        </Form.Item>
        <Form.Item label={t('accounts:profileModal.photoUrlLabel')} name="photo_url">
          <Input placeholder={t('accounts:profileModal.photoUrlPlaceholder')} allowClear />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 批量操作

export interface BulkActionModalProps {
  open: boolean;
  /** 要执行的批量动作；null 时不渲染 */
  action: BulkAction | null;
  /** 当前勾选的账号（scope=selected 时用） */
  selectedIds: string[];
  /** 当前筛选条件（scope=all 时后端会按同条件收敛，仅作提示） */
  filteredTotal: number;
  groups: GroupOut[];
  proxies: ProxyOut[];
  users: UserOut[];
  onCancel: () => void;
  onDone: (result: BulkResultOut | null) => void;
}

/** 需要额外参数的批量动作 */
const PARAM_ACTIONS: BulkAction[] = ['assign', 'group', 'proxy'];

export function BulkActionModal({
  open,
  action,
  selectedIds,
  filteredTotal,
  groups,
  proxies,
  users,
  onCancel,
  onDone,
}: BulkActionModalProps) {
  const { t } = useTranslation(['accounts', 'common']);
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [proxyId, setProxyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [mode, setMode] = useState<'assign' | 'unassign'>('assign');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setScope(selectedIds.length ? 'selected' : 'all');
      setGroupId(null);
      setProxyId(null);
      setUserId(null);
      setMode('assign');
    }
  }, [open, selectedIds.length]);

  if (!action) return null;

  const needsParam = PARAM_ACTIONS.includes(action);
  const paramReady = !needsParam || (action === 'group') || (action === 'proxy') || (action === 'assign' && userId);
  const ready = paramReady && (scope === 'selected' ? selectedIds.length > 0 : filteredTotal > 0);

  const handleOk = async () => {
    const payload: BulkAccountRequest = {
      scope,
      account_ids: scope === 'selected' ? selectedIds : null,
    };
    if (action === 'group') payload.group_id = groupId;
    if (action === 'proxy') payload.proxy_id = proxyId;
    if (action === 'assign') {
      payload.user_id = userId ?? undefined;
      payload.mode = mode;
    }
    setSubmitting(true);
    try {
      const result = await accountBulkApi.run(action, payload);
      onDone(result);
    } catch {
      onDone(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t(`accounts:bulkActionModal.actions.${action}`)}
      onCancel={onCancel}
      onOk={() => void handleOk()}
      okText={t('accounts:bulkActionModal.okText')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
      okButtonProps={{ disabled: !ready }}
    >
      <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
        <Form layout="vertical">
          <Form.Item label={t('accounts:bulkActionModal.scopeLabel')}>
            <Radio.Group value={scope} onChange={(event) => setScope(event.target.value)}>
              <Space direction="vertical">
                <Radio value="selected" disabled={!selectedIds.length}>
                  {t('accounts:bulkActionModal.scopeSelected', { count: selectedIds.length })}
                </Radio>
                <Radio value="all" disabled={!filteredTotal}>
                  {t('accounts:bulkActionModal.scopeAll', { count: filteredTotal })}
                </Radio>
              </Space>
            </Radio.Group>
          </Form.Item>

          {action === 'group' ? (
            <Form.Item label={t('accounts:bulkActionModal.targetGroupLabel')}>
              <Select
                allowClear
                placeholder={t('accounts:bulkActionModal.targetGroupPlaceholder')}
                style={{ width: '100%' }}
                value={groupId ?? undefined}
                onChange={(value) => setGroupId(value ?? null)}
                options={groups.map((g) => ({ value: g.id, label: `${g.name} (${g.account_count})` }))}
              />
            </Form.Item>
          ) : null}

          {action === 'proxy' ? (
            <Form.Item label={t('accounts:bulkActionModal.targetProxyLabel')}>
              <Select
                allowClear
                placeholder={t('accounts:bulkActionModal.targetProxyPlaceholder')}
                style={{ width: '100%' }}
                value={proxyId ?? undefined}
                onChange={(value) => setProxyId(value ?? null)}
                options={proxies.map((p) => ({ value: p.id, label: `${p.name} (${p.endpoint})` }))}
              />
            </Form.Item>
          ) : null}

          {action === 'assign' ? (
            <>
              <Form.Item label={t('accounts:bulkActionModal.staffLabel')} required>
                <Select
                  placeholder={t('accounts:bulkActionModal.staffPlaceholder')}
                  style={{ width: '100%' }}
                  value={userId ?? undefined}
                  onChange={(value) => setUserId(value ?? null)}
                  options={users.map((u) => ({ value: u.id, label: `${u.display_name || u.username} (${u.username})` }))}
                />
              </Form.Item>
              <Form.Item label={t('accounts:bulkActionModal.modeLabel')}>
                <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
                  <Radio value="assign">{t('accounts:bulkActionModal.modeAssign')}</Radio>
                  <Radio value="unassign">{t('accounts:bulkActionModal.modeUnassign')}</Radio>
                </Radio.Group>
              </Form.Item>
            </>
          ) : null}
        </Form>

        {!ready ? (
          <Alert
            type="warning"
            showIcon
            message={
              scope === 'selected'
                ? t('accounts:bulkActionModal.notReadySelected')
                : t('accounts:bulkActionModal.notReadyAll')
            }
          />
        ) : null}
        <Typography.Text type="secondary">
          {action === 'check' || action === 'sync-dialogs'
            ? t('accounts:bulkActionModal.hintCheckOrSync')
            : action === 'disable'
              ? t('accounts:bulkActionModal.hintDisable')
              : action === 'release-lease'
                ? t('accounts:bulkActionModal.hintReleaseLease')
                : t('accounts:bulkActionModal.hintDefault')}
        </Typography.Text>
      </div>
    </Modal>
  );
}