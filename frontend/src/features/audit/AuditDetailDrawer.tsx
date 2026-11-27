/**
 * 审计详情抽屉：谁 / 何时 / 什么动作 / 目标 / IP + detail JSON（格式化、可复制）。
 * 数据直接用列表行（auditApi.list 已返回 detail），无需二次请求。
 */
import { Button, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { CopyableText, DetailDrawer, RelativeTime } from '../../components';
import { resolveEnumLabel } from '../../i18n';
import { copyText } from '../../utils/download';
import { formatTime, stringifyDetail } from '../../utils/format';
import { toast } from '../../utils/feedback';
import type { AuditOut } from '../../api/types';
import { JsonBlock } from '../tasks/JsonBlock';
import '../tasks/tasks.css';

interface AuditDetailDrawerProps {
  record: AuditOut | null;
  onClose: () => void;
}

export function AuditDetailDrawer({ record, onClose }: AuditDetailDrawerProps) {
  const { t } = useTranslation(['audit', 'common', 'enums']);

  const actionDisplay = record
    ? resolveEnumLabel(`auditAction.${record.action}`, record.action_label, record.action)
    : '';

  const handleCopyAll = async () => {
    if (!record) return;
    const payload = stringifyDetail({
      [t('audit:drawer.copyFields.time')]: record.created_at,
      [t('audit:drawer.copyFields.actor')]: record.user_name ?? t('audit:system'),
      [t('audit:drawer.copyFields.action')]: actionDisplay,
      [t('audit:drawer.copyFields.account')]: record.account_label ?? null,
      [t('audit:drawer.copyFields.bot')]: record.bot_id ?? null,
      [t('audit:drawer.copyFields.targetType')]: record.target_type,
      [t('audit:drawer.copyFields.targetId')]: record.target_id,
      [t('audit:drawer.copyFields.clientIp')]: record.client_ip,
      [t('audit:drawer.copyFields.detail')]: record.detail ?? null,
    });
    const ok = await copyText(payload);
    if (ok) toast.success(t('audit:drawer.copiedAll'));
    else toast.error(t('common:copyFailed'));
  };

  return (
    <DetailDrawer
      open={Boolean(record)}
      onClose={onClose}
      title={record ? actionDisplay : t('audit:drawer.title')}
      subtitle={
        record ? (
          <Space size={8}>
            <span>{record.user_name ?? t('audit:system')}</span>
            {record.created_at ? <RelativeTime value={record.created_at} refreshMs={0} /> : null}
          </Space>
        ) : undefined
      }
      width={640}
      sections={
        record
          ? [
              {
                title: t('audit:drawer.recordInfo'),
                items: [
                  { label: t('audit:drawer.fields.time'), value: formatTime(record.created_at) },
                  { label: t('audit:drawer.fields.actionCode'), value: <CopyableText value={record.action} mono /> },
                  { label: t('audit:drawer.fields.actor'), value: record.user_name || t('audit:system') },
                  { label: t('audit:drawer.fields.account'), value: record.account_label || undefined },
                  {
                    label: t('audit:drawer.fields.bot'),
                    value: record.bot_id ? <CopyableText value={record.bot_id} mono maxLength={20} /> : undefined,
                  },
                  { label: t('audit:drawer.fields.targetType'), value: record.target_type || undefined },
                  {
                    label: t('audit:drawer.fields.targetId'),
                    value: record.target_id ? <CopyableText value={record.target_id} mono /> : undefined,
                  },
                  { label: t('audit:drawer.fields.clientIp'), value: record.client_ip || undefined },
                ],
              },
            ]
          : []
      }
      extra={
        record ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => void handleCopyAll()}>
            {t('audit:drawer.copyAll')}
          </Button>
        ) : null
      }
    >
      {record ? (
        <JsonBlock
          title={t('audit:drawer.detailJsonTitle')}
          value={record.detail ?? null}
          emptyText={t('audit:drawer.noDetail')}
        />
      ) : null}
    </DetailDrawer>
  );
}
