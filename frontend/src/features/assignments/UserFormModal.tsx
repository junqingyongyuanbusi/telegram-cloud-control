/**
 * 员工表单弹窗：新建员工（UserFormModal）与修改口令（PasswordModal）。
 * 后端 409（用户名已存在）等中文原因直接展示在表单内。
 */
import { useMemo, useState } from 'react';
import { Alert, Form, Input, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { userApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { getUserRoleOptions } from '../../constants';
import { notifySuccess } from '../../utils/feedback';
import type { UserCreate, UserOut, UserRole } from '../../api/types';

interface UserForm {
  username: string;
  password: string;
  display_name?: string;
  role: UserRole;
}

export function UserFormModal({
  open,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t, i18n } = useTranslation(['assignments', 'common', 'enums']);
  const [form] = Form.useForm<UserForm>();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const roleOptions = useMemo(() => getUserRoleOptions(), [i18n.language]);

  const handleFinish = async (values: UserForm) => {
    setSubmitting(true);
    setFormError(null);
    const payload: UserCreate = {
      username: values.username.trim(),
      password: values.password,
      display_name: values.display_name ?? '',
      role: values.role,
    };
    try {
      await userApi.create(payload);
      notifySuccess(t('assignments:userModal.created'));
      form.resetFields();
      onSuccess();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.friendlyMessage : t('assignments:userModal.createFailedFallback'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('assignments:userModal.title')}
      onCancel={onCancel}
      okText={t('assignments:userModal.createBtn')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
      onOk={() => form.submit()}
    >
      {formError ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setFormError(null)}
          message={t('assignments:userModal.createFailedTitle')}
          description={formError}
          style={{ marginBottom: 'var(--tg-space-xl)' }}
        />
      ) : null}
      <Form form={form} layout="vertical" onFinish={handleFinish} initialValues={{ role: 'operator' }}>
        <Form.Item
          label={t('assignments:userModal.username')}
          name="username"
          rules={[
            { required: true, message: t('assignments:userModal.usernameRequired') },
            { min: 2, message: t('assignments:userModal.usernameMin') },
          ]}
        >
          <Input placeholder={t('assignments:userModal.usernamePlaceholder')} allowClear autoComplete="off" />
        </Form.Item>
        <Form.Item
          label={t('assignments:userModal.password')}
          name="password"
          rules={[
            { required: true, message: t('assignments:userModal.passwordRequired') },
            { min: 6, message: t('assignments:userModal.passwordMin') },
          ]}
          extra={t('assignments:userModal.passwordExtra')}
        >
          <Input.Password placeholder={t('assignments:userModal.passwordPlaceholder')} autoComplete="new-password" />
        </Form.Item>
        <Form.Item label={t('assignments:userModal.displayName')} name="display_name">
          <Input placeholder={t('assignments:userModal.displayNamePlaceholder')} allowClear />
        </Form.Item>
        <Form.Item
          label={t('assignments:userModal.role')}
          name="role"
          rules={[{ required: true, message: t('assignments:userModal.roleRequired') }]}
        >
          <Select options={roleOptions} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function PasswordModal({
  user,
  onCancel,
  onSuccess,
}: {
  user: UserOut | null;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation(['assignments', 'common']);
  const [form] = Form.useForm<{ password: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleFinish = async (values: { password: string }) => {
    if (!user) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await userApi.update(user.id, { password: values.password });
      notifySuccess(t('assignments:passwordModal.updated'));
      form.resetFields();
      onSuccess();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.friendlyMessage : t('assignments:passwordModal.updateFailedFallback'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      title={t('assignments:passwordModal.title', { username: user?.username ?? '' })}
      onCancel={onCancel}
      okText={t('common:save')}
      cancelText={t('common:cancel')}
      confirmLoading={submitting}
      onOk={() => form.submit()}
    >
      {formError ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setFormError(null)}
          message={t('assignments:passwordModal.updateFailedTitle')}
          description={formError}
          style={{ marginBottom: 'var(--tg-space-xl)' }}
        />
      ) : null}
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item
          label={t('assignments:passwordModal.newPassword')}
          name="password"
          rules={[
            { required: true, message: t('assignments:passwordModal.newPasswordRequired') },
            { min: 6, message: t('assignments:passwordModal.newPasswordMin') },
          ]}
          extra={t('assignments:passwordModal.newPasswordExtra')}
        >
          <Input.Password placeholder={t('assignments:passwordModal.newPasswordPlaceholder')} autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
