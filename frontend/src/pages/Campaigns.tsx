/**
 * 触达中心：素材库 / 加群群发 / 批次进度。
 *
 * 「加群群发」= 一号一条任务、号内逐群「加群 → 过验证 → 发内容」，合并了旧的 群发 / 素材群发 / 加群；
 * 其余动作（批量私信 / 退群 / 强拉 / 批量改资料 / 吵群 / 拟人发言）保留代码但不在 UI 露出。
 * 提交后后端按「一号一任务」入队，结果弹窗复用 BulkResultModal；执行进度看「批次进度」。
 */
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  Checkbox,
  Empty,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import BulkResultModal from '../features/accounts/BulkResultModal';
import AccountPickerModal from '../components/AccountPickerModal';
import MaterialThumb from '../features/materials/MaterialThumb';
import MaterialPicker from '../features/materials/MaterialSelect';
import { PageContainer, StatusBadge, TaskStatusTag } from '../components';
import {
  accountApi,
  botApi,
  campaignApi,
  campaignScheduleApi,
  groupApi,
  groupIntelApi,
  materialApi,
} from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { isEnglish, resolveEnumLabel } from '../i18n';
import { notifySuccess, toast } from '../utils/feedback';
import { formatNumber, formatTime } from '../utils/format';
import { regionOptions } from '../utils/region';
import type {
  AccountOut,
  AccountStatus,
  BulkPmRequest,
  BulkResultOut,
  CampaignBatchItem,
  CampaignBatchResultItem,
  CampaignBatchOut,
  CampaignScheduleOut,
  ForceAddRequest,
  GroupBroadcastRequest,
  GroupProfileOut,
  JoinAndSendRequest,
  JoinGroupRequest,
  LeaveGroupRequest,
  MaterialKind,
  MaterialOut,
  MaterialSendRequest,
  PersonaRequest,
  ProfileBulkRequest,
  StormRequest,
  TaskStatus,
  UUID,
} from '../api/types';

type ScopeValue = 'all' | 'group' | 'selected';

interface ScopeState {
  scope: ScopeValue;
  groupId?: UUID | null;
  /** scope=selected 时手动勾选的账号 id */
  ids?: string[];
  limit: number;
}

const KIND_COLORS: Record<MaterialKind, string> = {
  text: 'blue',
  photo: 'green',
  video: 'purple',
  document: 'orange',
};

/** 账号范围选择器：all / group:<id>；limit 默认 200
 *
 * 注意：提交时后端只保留「能承接触达动作」的号 —— 冻结 / 失效 / 停用的号会被自动滤掉
 *（它们写操作必被 Telegram 拒绝），所以勾了 10 个可能只排出 9 条任务。
 */
function ScopeFields({ value, onChange }: { value: ScopeState; onChange: (next: ScopeState) => void }) {
  const { t } = useTranslation('campaigns');
  const groups = useAsyncData(() => groupApi.list(), [], { immediate: false });
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    void groups.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Space wrap>
      <Segmented<ScopeValue>
        value={value.scope}
        onChange={(scope) => onChange({ ...value, scope })}
        options={[
          { label: t('scope.all'), value: 'all' },
          { label: t('scope.group'), value: 'group' },
          { label: t('scope.selected'), value: 'selected' },
        ]}
      />
      {value.scope === 'selected' ? (
        <>
          <Button size="middle" icon={<TeamOutlined />} onClick={() => setPickerOpen(true)}>
            {value.ids?.length
              ? t('scope.selectAccountsWithCount', { count: value.ids.length })
              : t('scope.selectAccounts')}
          </Button>
          <AccountPickerModal
            open={pickerOpen}
            title={t('scope.pickerTitle')}
            value={value.ids ?? []}
            onCancel={() => setPickerOpen(false)}
            onSubmit={async (ids) => {
              onChange({ ...value, ids });
              setPickerOpen(false);
            }}
          />
        </>
      ) : null}
      {value.scope === 'group' ? (
        <Select
          style={{ width: 200 }}
          placeholder={t('scope.selectGroupPlaceholder')}
          value={value.groupId ?? undefined}
          loading={groups.loading}
          onChange={(groupId) => onChange({ ...value, groupId })}
          options={(groups.data ?? []).map((group) => ({ label: group.name, value: group.id }))}
        />
      ) : null}
      <span className="tg-scope-limit">
        <span className="tg-scope-limit-label">{t('scope.maxPrefix')}</span>
        {/* 原本用 InputNumber 的 addonBefore/addonAfter 做前后缀，antd 已弃用；
            改成并列的普通元素，语义一样、也不会有弃用警告 */}
        <InputNumber
          min={1}
          max={500}
          value={value.limit}
          onChange={(limit) => onChange({ ...value, limit: limit ?? 200 })}
          style={{ width: 110 }}
        />
        <span className="tg-scope-limit-label">{t('scope.maxSuffix')}</span>
      </span>
    </Space>
  );
}

/** 可选素材选择：把素材库里的图片/视频/文档配在文本一起发（批量私信 / 群发共用） */
function MaterialPickField({ value, onChange }: { value?: string | null; onChange?: (next: string | null) => void }) {
  const { t, i18n } = useTranslation('campaigns');
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), [], { immediate: false });
  useEffect(() => {
    void materials.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const en = isEnglish(i18n.language);
  return (
    <Form.Item
      label={t('materialPick.label')}
      className="tg-pm-material"
      tooltip={t('materialPick.tooltip')}
    >
      <Select
        allowClear
        // 宽度交给卡片（原先写死 320，比 span3 卡片的内容区还宽，会撑破边框）
        style={{ width: '100%' }}
        placeholder={t('materialPick.placeholder')}
        value={value ?? undefined}
        loading={materials.loading}
        onChange={(next) => onChange?.(next ?? null)}
        options={(materials.data?.items ?? []).map((item) => {
          const kindLabel = en
            ? t(`materialKind.${item.kind}`, { defaultValue: item.kind_label || item.kind })
            : item.kind_label || t(`materialKind.${item.kind}`, { defaultValue: item.kind });
          return {
            value: item.id,
            label: `[${kindLabel}] ${item.name}`,
          };
        })}
      />
    </Form.Item>
  );
}

function scopePayload(scope: ScopeState): Record<string, unknown> {
  if (scope.scope === 'group' && scope.groupId) {
    return { scope: `group:${scope.groupId}`, account_ids: null, limit: scope.limit };
  }
  if (scope.scope === 'selected') {
    // 手动挑号：直接把 id 列表交给后端（后端按 scope=selected 校验可见性）
    return { scope: 'selected', account_ids: scope.ids ?? [], limit: scope.limit };
  }
  return { scope: 'all', account_ids: null, limit: scope.limit };
}

function splitField(value?: unknown): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 素材库

function MaterialsTab() {
  const { t, i18n } = useTranslation(['campaigns', 'common']);
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), []);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);

  const createText = async () => {
    if (!name.trim()) {
      toast.warning(t('campaigns:materials.nameRequired'));
      return;
    }
    setCreating(true);
    try {
      await materialApi.create({ name: name.trim(), text });
      notifySuccess(t('campaigns:materials.textSaved'));
      setName('');
      setText('');
      void materials.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setCreating(false);
    }
  };

  const remove = async (material: MaterialOut) => {
    await materialApi.remove(material.id);
    notifySuccess(t('campaigns:materials.deleted'));
    void materials.reload();
  };

  const en = isEnglish(i18n.language);
  const columns: ColumnsType<MaterialOut> = [
    {
      title: t('campaigns:materials.colPreview'),
      dataIndex: 'id',
      width: 72,
      render: (_: string, record) => (
        <MaterialThumb materialId={record.id} kind={record.kind} alt={record.name} />
      ),
    },
    { title: t('campaigns:materials.colName'), dataIndex: 'name', width: 180 },
    {
      title: t('campaigns:materials.colKind'),
      dataIndex: 'kind',
      width: 90,
      render: (kind: MaterialKind, record) => {
        const label = en
          ? t(`campaigns:materialKind.${kind}`, { defaultValue: record.kind_label || kind })
          : record.kind_label || t(`campaigns:materialKind.${kind}`, { defaultValue: kind });
        return <Tag color={KIND_COLORS[kind]}>{label}</Tag>;
      },
    },
    {
      title: t('campaigns:materials.colContent'),
      dataIndex: 'text',
      ellipsis: true,
      render: (value: string, record) => value || record.original_name || <span className="tg-muted">—</span>,
    },
    {
      title: t('campaigns:materials.colSize'),
      dataIndex: 'size_bytes',
      width: 90,
      render: (value: number) => (value ? formatNumber(value) : <span className="tg-muted">—</span>),
    },
    { title: t('campaigns:materials.colCreatedAt'), dataIndex: 'created_at', width: 170, render: (value: string) => formatTime(value) },
    {
      title: t('campaigns:materials.colActions'),
      width: 130,
      render: (_, record) => (
        <Space>
          {record.kind !== 'text' ? (
            <a href={materialApi.downloadUrl(record.id)} target="_blank" rel="noreferrer">
              {t('campaigns:materials.download')}
            </a>
          ) : null}
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => void remove(record)}>
            {t('campaigns:materials.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
      <Card size="small" title={t('campaigns:materials.createTextTitle')}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder={t('campaigns:materials.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ width: 240 }}
          />
          <Input.TextArea
            placeholder={t('campaigns:materials.textPlaceholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={() => void createText()}>
            {t('common:save')}
          </Button>
        </Space.Compact>
      </Card>
      <Card size="small" title={t('campaigns:materials.uploadTitle')}>
        <Upload.Dragger
          multiple={false}
          showUploadList={false}
          customRequest={async (options) => {
            const file = options.file as File;
            const baseName = file.name.replace(/\.[^.]+$/, '');
            try {
              await materialApi.upload(baseName, file);
              notifySuccess(t('campaigns:materials.uploaded', { name: baseName }));
              void materials.reload();
            } catch {
              /* client 已统一提示 */
            }
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('campaigns:materials.uploadText')}</p>
          <p className="ant-upload-hint">{t('campaigns:materials.uploadHint')}</p>
        </Upload.Dragger>
      </Card>
      <Table<MaterialOut>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={materials.data?.items ?? []}
        loading={materials.loading}
        pagination={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 素材下拉

function MaterialSelect(props: { value?: string; onChange?: (value: string) => void }) {
  const { t, i18n } = useTranslation('campaigns');
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), []);
  const en = isEnglish(i18n.language);
  return (
    <Select
      {...props}
      placeholder={t('materialSelect.placeholder')}
      loading={materials.loading}
      options={(materials.data?.items ?? []).map((item) => {
        const kindLabel = en
          ? t(`materialKind.${item.kind}`, { defaultValue: item.kind_label || item.kind })
          : item.kind_label || t(`materialKind.${item.kind}`, { defaultValue: item.kind });
        return {
          label: t('materialSelect.optionLabel', { name: item.name, kind: kindLabel }),
          value: item.id,
        };
      })}
    />
  );
}

// ---------------------------------------------------------------- 批次进度

function BatchesTab() {
  const { t } = useTranslation(['campaigns', 'common', 'enums']);
  const batches = useAsyncData(() => campaignApi.batches({ page: 1, page_size: 50 }), []);
  const [detail, setDetail] = useState<CampaignBatchOut | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openDetail = async (batchId: UUID) => {
    setDetailLoading(true);
    try {
      setDetail(await campaignApi.batch(batchId));
    } catch {
      /* client 已统一提示 */
    } finally {
      setDetailLoading(false);
    }
  };

  const cancel = async (batchId: UUID) => {
    const res = await campaignApi.cancelBatch(batchId);
    notifySuccess(res.message);
    void batches.reload();
    await openDetail(batchId);
  };

  const itemColumns: ColumnsType<CampaignBatchItem> = [
    { title: t('campaigns:batches.colAccount'), dataIndex: 'account_label', width: 140 },
    {
      title: t('campaigns:batches.colTaskType'),
      dataIndex: 'type_label',
      width: 110,
      render: (value: string, record) => resolveEnumLabel(`taskType.${record.type}`, value, record.type),
    },
    {
      title: t('campaigns:batches.colStatus'),
      dataIndex: 'status',
      width: 100,
      render: (value: TaskStatus, record) => (
        <TaskStatusTag status={value} label={record.status_label} size="sm" />
      ),
    },
    { title: t('campaigns:batches.colAttempts'), dataIndex: 'attempts', width: 60 },
    {
      title: t('campaigns:batches.colProgress'),
      dataIndex: 'stage',
      width: 230,
      render: (value: string, record) => {
        if (!record.total) return <span className="tg-muted">—</span>;
        return (
          <Tooltip title={record.detail || value || ''}>
            <span className="tg-mono">
              {record.wave_total
                ? t('campaigns:batches.waveProgress', {
                    wave: (record.wave_index ?? 0) + 1,
                    waveTotal: record.wave_total,
                  })
                : ''}
              {t('campaigns:batches.joinedSentProgress', {
                joined: record.joined ?? 0,
                total: record.total,
                sent: record.sent ?? 0,
              })}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: t('campaigns:batches.colError'),
      dataIndex: 'error',
      ellipsis: true,
      render: (value: string) => value || <span className="tg-muted">—</span>,
    },
  ];

  const columns: ColumnsType<CampaignBatchOut> = [
    {
      title: t('campaigns:batches.colBatch'),
      dataIndex: 'batch_id',
      width: 220,
      render: (value: UUID) => <span className="tg-mono">{value.slice(0, 8)}…</span>,
    },
    { title: t('campaigns:batches.colSubmittedAt'), dataIndex: 'created_at', width: 170, render: (value: string) => formatTime(value) },
    { title: t('campaigns:batches.colTaskCount'), dataIndex: 'total', width: 80 },
    {
      title: t('campaigns:batches.colStatusDist'),
      dataIndex: 'counts',
      render: (counts: Record<string, number>) => {
        const parts = Object.entries(counts ?? {})
          .filter(([, count]) => count > 0)
          .map(([key, count]) => `${key}=${count}`);
        return parts.length ? (
          <span className="tg-mono tg-muted">{parts.join('  ')}</span>
        ) : (
          <span className="tg-muted">—</span>
        );
      },
    },
    {
      title: t('campaigns:batches.colActions'),
      width: 160,
      render: (_, record) => (
        <Space>
          <Button size="small" loading={detailLoading} onClick={() => void openDetail(record.batch_id)}>
            {t('campaigns:batches.detail')}
          </Button>
          <Button size="small" danger onClick={() => void cancel(record.batch_id)}>
            {t('campaigns:batches.cancel')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
      <Space>
        <Button icon={<ReloadOutlined />} onClick={() => void batches.reload()}>
          {t('common:refresh')}
        </Button>
        <Typography.Text type="secondary">{t('campaigns:batches.liveHint')}</Typography.Text>
      </Space>
      <Table<CampaignBatchOut>
        size="small"
        rowKey="batch_id"
        columns={columns}
        dataSource={batches.data?.items ?? []}
        loading={batches.loading}
        pagination={{ pageSize: 20, size: 'small', showTotal: (total) => t('campaigns:batches.totalBatches', { total }) }}
      />
      {detail ? (
        <Card
          size="small"
          title={t('campaigns:batches.detailTitle', {
            batchId: detail.batch_id,
            createdAt: formatTime(detail.created_at ?? ''),
            total: detail.total,
          })}
          extra={
            <Button size="small" danger onClick={() => void cancel(detail.batch_id)}>
              {t('campaigns:batches.cancelIncomplete')}
            </Button>
          }
        >
          <Table<CampaignBatchItem>
            size="small"
            rowKey="task_id"
            columns={itemColumns}
            dataSource={detail.items}
            pagination={{ pageSize: 10, size: 'small' }}
            expandable={{
              rowExpandable: (record) => Boolean(record.results?.length),
              expandedRowRender: (record) => (
                <Table<CampaignBatchResultItem>
                  size="small"
                  rowKey={(item) => item.target || item.link || 'row'}
                  pagination={false}
                  dataSource={record.results ?? []}
                  columns={[
                    { title: t('campaigns:batches.colTarget'), dataIndex: 'target', ellipsis: true },
                    {
                      title: t('campaigns:batches.colOutcome'),
                      width: 120,
                      render: (_, item) => {
                        if (item.error) return <Tag color="red">{t('campaigns:batches.resultFailed')}</Tag>;
                        if (item.sent) return <Tag color="green">{t('campaigns:batches.resultSent')}</Tag>;
                        if (item.pending_approval) return <Tag color="gold">{t('campaigns:batches.resultPendingApproval')}</Tag>;
                        return <Tag>{t('campaigns:batches.resultSkipped')}</Tag>;
                      },
                    },
                    {
                      title: t('campaigns:batches.colLink'),
                      width: 220,
                      render: (_, item) =>
                        item.link ? (
                          <a href={item.link} target="_blank" rel="noreferrer">
                            {t('campaigns:batches.openLink')}
                          </a>
                        ) : (
                          <span className="tg-muted">—</span>
                        ),
                    },
                  ]}
                />
              ),
            }}
          />
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 加群群发（一号一条流水线）

const TASK_STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  pending_confirmation: 'gold',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
};

/** 加群群发：一个号一条任务，号内逐群「加群 → 过验证 → 发内容」。
 *
 * 页面只留三样东西：顶部写内容 + 挑群，中间一张账号表（提交后同一张表直接显示每号执行状态），
 * 底部提交。节奏参数大多数人不改，收进折叠面板，默认值按保守值预设。 */
function JoinAndSendTab({ initialTargets = [] }: { initialTargets?: string[] }) {
  const { t } = useTranslation(['campaigns', 'common', 'enums']);
  const navigate = useNavigate();
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }), []);
  // null = 还没初始化（首次加载后默认全选）；[] = 用户主动清空
  const [selected, setSelected] = useState<string[] | null>(null);
  // 默认自动挑号：按健康分优先从可用号里选，不用手动勾
  const [autoAccounts, setAutoAccounts] = useState(true);
  // 默认轮训：一个群只由一个号发，账号之间轮流分担；重复模式才是每个号都发全部群
  const [dispatch, setDispatch] = useState<'round_robin' | 'each'>('round_robin');
  const [mode, setMode] = useState<'text' | 'material'>('text');
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkResultOut | null>(null);
  // 提交后的批次进度：同一张账号表直接显示，每 4 秒刷新一次
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batch, setBatch] = useState<CampaignBatchOut | null>(null);
  // 群情报选群弹窗
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupKeyword, setGroupKeyword] = useState('');
  const [groupCountry, setGroupCountry] = useState<string | undefined>(undefined);
  const [groupPage, setGroupPage] = useState(1);
  // 跨分页保留选择：tg_chat_id → 可直接使用的链接（邀请链接优先，公开群用 @用户名）
  const [pickedGroups, setPickedGroups] = useState<Record<string, string>>({});

  const groups = useAsyncData(
    () =>
      pickerOpen
        ? groupIntelApi.profiles({
            q: groupKeyword || undefined,
            speakable: true,
            country: groupCountry,
            page: groupPage,
            page_size: 20,
          })
        : Promise.resolve(null),
    [pickerOpen, groupKeyword, groupCountry, groupPage],
  );

  useEffect(() => {
    if (selected === null && accounts.data) {
      // 默认只选可发送的号（健康 / 限流中）；冻结、失效的号仍显示，但需要手动勾选
      setSelected(
        accounts.data.items
          .filter((item) => item.status === 'healthy' || item.status === 'limited')
          .map((item) => item.id),
      );
    }
  }, [accounts.data, selected]);

  // 群情报页「同步到加群」带过来的链接：预填目标群
  useEffect(() => {
    if (initialTargets.length) form.setFieldValue('targets', initialTargets.join('\n'));
  }, [initialTargets, form]);

  // 提交后轮询批次详情，把每号进度合并回账号表；全部进入终态就停
  useEffect(() => {
    if (!batchId) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const data = await campaignApi.batch(batchId);
        if (stopped) return;
        setBatch(data);
        if (data.items.every((item) => ['completed', 'failed', 'cancelled'].includes(item.status))) {
          window.clearInterval(timer);
        }
      } catch {
        /* 轮询失败不打断页面，下一轮继续 */
      }
    };
    void tick();
    timer = window.setInterval(() => void tick(), 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [batchId]);

  const rows = accounts.data?.items ?? [];
  const picked = selected ?? [];
  const progressByAccount = new Map<string, CampaignBatchItem>();
  batch?.items.forEach((item) => {
    if (item.account_id) progressByAccount.set(item.account_id, item);
  });

  const accountColumns: ColumnsType<AccountOut> = [
    {
      title: t('campaigns:joinAndSend.colAccount'),
      dataIndex: 'display_label',
      render: (value: string, record) => value || record.phone_masked,
    },
    {
      title: t('campaigns:joinAndSend.colStatus'),
      dataIndex: 'status',
      width: 96,
      render: (value: AccountStatus, record) => (
        <StatusBadge status={value} label={record.status_label} size="sm" />
      ),
    },
    { title: t('campaigns:joinAndSend.colHealthScore'), dataIndex: 'health_score', width: 76 },
    {
      title: t('campaigns:joinAndSend.colGroup'),
      dataIndex: 'group_name',
      width: 110,
      render: (value: string) => value || <span className="tg-muted">—</span>,
    },
    { title: t('campaigns:joinAndSend.colGroupCount'), dataIndex: 'group_count', width: 64 },
    {
      title: t('campaigns:joinAndSend.colExecStatus'),
      width: 300,
      render: (_, record) => {
        const item = progressByAccount.get(record.id);
        if (!item) {
          const taskText = record.current_task
            ? resolveEnumLabel(`currentTask.${record.current_task}`, record.current_task_label, record.current_task)
            : '';
          return <span className="tg-muted">{taskText || t('campaigns:joinAndSend.pendingSubmit')}</span>;
        }
        const progress = item.total
          ? t('campaigns:joinAndSend.joinedSentProgress', {
              joined: item.joined ?? 0,
              total: item.total,
              sent: item.sent ?? 0,
            })
          : '';
        return (
          <span className="tg-stack" style={{ gap: 2 }}>
            <Space size={6} wrap>
              <Tag color={TASK_STATUS_COLOR[item.status] ?? 'default'}>
                {resolveEnumLabel(`taskStatus.${item.status}`, item.status_label, item.status)}
              </Tag>
              {progress ? <span className="tg-mono tg-muted">{progress}</span> : null}
            </Space>
            {item.error ? (
              <Tooltip title={item.error}>
                <span
                  className="tg-muted"
                  style={{
                    fontSize: 'var(--tg-font-size-xs)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 280,
                  }}
                >
                  {item.error}
                </span>
              </Tooltip>
            ) : item.detail ? (
              <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                {item.detail}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];

  const groupColumns: ColumnsType<GroupProfileOut> = [
    {
      title: t('campaigns:joinAndSend.colGroupName'),
      dataIndex: 'title',
      render: (value: string, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <span>{value || t('campaigns:joinAndSend.unnamedGroup')}</span>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {record.username ? `@${record.username}` : record.tg_chat_id}
          </span>
        </span>
      ),
    },
    {
      title: t('campaigns:joinAndSend.colRegion'),
      dataIndex: 'country',
      width: 96,
      render: (value: string | null, record) =>
        value ? (
          <Tooltip
            title={
              record.country_source === 'target'
                ? t('campaigns:joinAndSend.regionTarget')
                : t('campaigns:joinAndSend.regionInferred')
            }
          >
            <Tag color="geekblue">{value}</Tag>
          </Tooltip>
        ) : (
          <span className="tg-muted">—</span>
        ),
    },
    {
      title: t('campaigns:joinAndSend.colMembers'),
      dataIndex: 'member_count',
      width: 90,
      render: (value: number | null) => (value ? formatNumber(value) : '—'),
    },
    {
      title: t('campaigns:joinAndSend.colSpeak'),
      dataIndex: 'send_permission',
      width: 90,
      render: (value: string | null) =>
        value === 'open' ? (
          <Tag color="green">{t('campaigns:joinAndSend.speakOpen')}</Tag>
        ) : (
          <Tag>
            {value === 'restricted'
              ? t('campaigns:joinAndSend.speakRestricted')
              : t('campaigns:joinAndSend.speakUnverified')}
          </Tag>
        ),
    },
  ];

  const groupLinkOf = (item: GroupProfileOut) =>
    item.invite_link || (item.username ? `@${item.username}` : '');

  const onPickGroups = (keys: string[]) => {
    const next = { ...pickedGroups };
    // 当前页先按本次勾选覆盖，其他页已选的保留
    (groups.data?.items ?? []).forEach((item) => {
      const key = String(item.tg_chat_id);
      if (keys.includes(key)) {
        next[key] = groupLinkOf(item);
      } else {
        delete next[key];
      }
    });
    setPickedGroups(next);
  };

  const applyPickedGroups = () => {
    const links = Object.values(pickedGroups).filter((link): link is string => Boolean(link));
    if (!links.length) {
      toast.warning(t('campaigns:joinAndSend.warnNoLink'));
      return;
    }
    const merged = Array.from(new Set([...splitField(form.getFieldValue('targets')), ...links]));
    form.setFieldValue('targets', merged.join('\n'));
    setPickedGroups({});
    setPickerOpen(false);
  };

  const onFinish = async (values: Record<string, unknown>) => {
    if (!autoAccounts && !picked.length) {
      toast.warning(t('campaigns:joinAndSend.warnNoAccount'));
      return;
    }
    const targets = splitField(values.targets);
    if (!targets.length) {
      toast.warning(t('campaigns:joinAndSend.warnNoTarget'));
      return;
    }
    const text = String(values.text ?? '').trim();
    const materialId = (values.material_id as string | undefined) ?? null;
    if (mode === 'material' && !materialId) {
      toast.warning(t('campaigns:joinAndSend.warnNoMaterial'));
      return;
    }
    if (mode === 'text' && !text) {
      toast.warning(t('campaigns:joinAndSend.warnNoText'));
      return;
    }
    const maxAccounts = Number(values.max_accounts ?? 0);
    const payload: JoinAndSendRequest = {
      // 自动模式：后端按健康分优先挑号；手动模式只跑勾选的号
      scope: autoAccounts ? 'all' : 'selected',
      account_ids: autoAccounts ? null : picked,
      limit: autoAccounts ? Math.max(1, maxAccounts || 500) : Math.min(picked.length, 500),
      max_accounts: autoAccounts ? maxAccounts : 0,
      // 轮次：每轮账号数 / 每号每轮群数；0 = 不分轮 / 该号一次拿全部群
      accounts_per_wave: Number(values.accounts_per_wave ?? 0),
      groups_per_account: Number(values.groups_per_account ?? 0),
      dispatch,
      targets,
      // 素材模式：text 是配文；文本模式：text 是正文
      text: text || null,
      texts: null,
      naturalize: false,
      material_id: mode === 'material' ? materialId : null,
      parse_mode: '',
      join_min_interval: Number(values.join_min_interval ?? 20),
      join_max_interval: Number(values.join_max_interval ?? 60),
      send_min_interval: Number(values.send_min_interval ?? 3),
      send_max_interval: Number(values.send_max_interval ?? 8),
      delay_after_join: Number(values.delay_after_join ?? 0),
      // 需求：加群后自动过验证；审核制群由 worker 标记「待审批」并跳过发送
      auto_verify: true,
      verify_timeout: Number(values.verify_timeout ?? 150),
      ignore_active_hours: Boolean(values.ignore_active_hours),
    };
    setSubmitting(true);
    try {
      const res = await campaignApi.joinAndSend(payload);
      setResult(res);
      if (res.batch_id) {
        setBatch(null);
        setBatchId(res.batch_id);
      }
    } catch {
      /* client 已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tg-action-page">
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          accounts_per_wave: 0,
          groups_per_account: 0,
          max_accounts: 0,
          join_min_interval: 20,
          join_max_interval: 60,
          send_min_interval: 3,
          send_max_interval: 8,
          delay_after_join: 0,
          verify_timeout: 150,
          ignore_active_hours: false,
        }}
        onFinish={(values) => void onFinish(values)}
      >
        <div className="tg-form-body">
          <section className="tg-section">
            <div className="tg-section-head">
              <span className="tg-section-bar" />
              <h2 className="tg-section-title">{t('campaigns:joinAndSend.contentAndTargetsTitle')}</h2>
              <span className="tg-section-note">{t('campaigns:joinAndSend.contentAndTargetsNote')}</span>
            </div>
            <div className="tg-form-grid">
              <div>
                <div className="tg-form-group-title">{t('campaigns:joinAndSend.publishContent')}</div>
                <Segmented
                  value={mode}
                  onChange={(next) => setMode(next as 'text' | 'material')}
                  options={[
                    { label: t('campaigns:joinAndSend.modeText'), value: 'text' },
                    { label: t('campaigns:joinAndSend.modeMaterial'), value: 'material' },
                  ]}
                />
                {mode === 'text' ? (
                  <Form.Item name="text" style={{ marginTop: 'var(--tg-space-sm)' }}>
                    <Input.TextArea
                      placeholder={t('campaigns:joinAndSend.textPlaceholder')}
                      autoSize={{ minRows: 5, maxRows: 10 }}
                    />
                  </Form.Item>
                ) : (
                  <>
                    <Form.Item noStyle shouldUpdate={(prev, next) => prev.material_id !== next.material_id}>
                      {({ getFieldValue, setFieldValue }) => (
                        <MaterialPickField
                          value={getFieldValue('material_id')}
                          onChange={(next) => setFieldValue('material_id', next)}
                        />
                      )}
                    </Form.Item>
                    <Form.Item label={t('campaigns:joinAndSend.captionLabel')} name="text">
                      <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
                    </Form.Item>
                  </>
                )}
              </div>
              <div>
                <div className="tg-form-group-title">{t('campaigns:joinAndSend.targetGroups')}</div>
                <Space wrap style={{ marginBottom: 'var(--tg-space-sm)' }}>
                  <Button size="small" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>
                    {t('campaigns:joinAndSend.pickFromIntel')}
                  </Button>
                  <span className="tg-muted">{t('campaigns:joinAndSend.onePerLineLimit')}</span>
                </Space>
                <Form.Item name="targets" rules={[{ required: true, message: t('campaigns:joinAndSend.targetsRequired') }]}>
                  <Input.TextArea
                    placeholder={'https://t.me/+AbCdEf123456\n@public_group\nt.me/another_group'}
                    autoSize={{ minRows: 5, maxRows: 10 }}
                  />
                </Form.Item>
              </div>
            </div>
          </section>

          <Collapse
            size="small"
            items={[
              {
                key: 'rhythm',
                label: t('campaigns:joinAndSend.rhythmPanelLabel'),
                children: (
                  <div className="tg-form-grid">
                    <Form.Item label={t('campaigns:joinAndSend.joinMinInterval')} name="join_min_interval">
                      <InputNumber min={5} max={300} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label={t('campaigns:joinAndSend.joinMaxInterval')} name="join_max_interval">
                      <InputNumber min={5} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label={t('campaigns:joinAndSend.delayAfterJoin')}
                      name="delay_after_join"
                      tooltip={t('campaigns:joinAndSend.delayAfterJoinTooltip')}
                    >
                      <InputNumber min={0} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label={t('campaigns:joinAndSend.sendMinInterval')} name="send_min_interval">
                      <InputNumber min={1} max={60} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label={t('campaigns:joinAndSend.sendMaxInterval')} name="send_max_interval">
                      <InputNumber min={1} max={120} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label={t('campaigns:joinAndSend.verifyTimeout')}
                      name="verify_timeout"
                      tooltip={t('campaigns:joinAndSend.verifyTimeoutTooltip')}
                    >
                      <InputNumber min={30} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label={t('campaigns:joinAndSend.ignoreActiveHours')}
                      name="ignore_active_hours"
                      valuePropName="checked"
                      tooltip={t('campaigns:joinAndSend.ignoreActiveHoursTooltip')}
                    >
                      <Switch
                        checkedChildren={t('campaigns:joinAndSend.switchNow')}
                        unCheckedChildren={t('campaigns:joinAndSend.switchByWindow')}
                      />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />

          <section className="tg-section">
            <div className="tg-section-head">
              <span className="tg-section-bar" />
              <h2 className="tg-section-title">{t('campaigns:joinAndSend.accountsSectionTitle')}</h2>
              <span className="tg-section-note">
                {t('campaigns:joinAndSend.accountsSectionNote')}
              </span>
            </div>
            <div className="tg-form-grid" style={{ marginBottom: 'var(--tg-space-md)' }}>
              <Form.Item label={t('campaigns:joinAndSend.accountPickLabel')} tooltip={t('campaigns:joinAndSend.accountPickTooltip')}>
                <Switch
                  checked={autoAccounts}
                  onChange={setAutoAccounts}
                  checkedChildren={t('campaigns:joinAndSend.switchAuto')}
                  unCheckedChildren={t('campaigns:joinAndSend.switchManual')}
                />
              </Form.Item>
              <Form.Item
                label={t('campaigns:joinAndSend.dispatchLabel')}
                tooltip={t('campaigns:joinAndSend.dispatchTooltip')}
              >
                <Segmented
                  value={dispatch}
                  onChange={(value) => setDispatch(value as 'round_robin' | 'each')}
                  options={[
                    { label: t('campaigns:joinAndSend.dispatchRoundRobin'), value: 'round_robin' },
                    { label: t('campaigns:joinAndSend.dispatchEach'), value: 'each' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={t('campaigns:joinAndSend.accountsPerWave')}
                name="accounts_per_wave"
                tooltip={t('campaigns:joinAndSend.accountsPerWaveTooltip')}
              >
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label={t('campaigns:joinAndSend.groupsPerAccount')}
                name="groups_per_account"
                tooltip={t('campaigns:joinAndSend.groupsPerAccountTooltip')}
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label={t('campaigns:joinAndSend.maxAccounts')}
                name="max_accounts"
                tooltip={t('campaigns:joinAndSend.maxAccountsTooltip')}
              >
                <InputNumber min={0} max={500} style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Space wrap style={{ marginBottom: 'var(--tg-space-md)' }}>
              {autoAccounts ? null : (
                <>
                  <Button size="small" icon={<TeamOutlined />} onClick={() => setSelected(rows.map((item) => item.id))}>
                    {t('common:selectAll')}
                  </Button>
                  <Button size="small" onClick={() => setSelected([])}>
                    {t('campaigns:joinAndSend.clear')}
                  </Button>
                </>
              )}
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={accounts.loading}
                onClick={() => {
                  setSelected(null);
                  void accounts.reload();
                }}
              >
                {t('campaigns:joinAndSend.refreshAccounts')}
              </Button>
              <span className="tg-muted">
                {autoAccounts ? (
                  <>
                    {t('campaigns:joinAndSend.autoPickPrefix')}
                    <b>{rows.filter((item) => item.status === 'healthy' || item.status === 'limited').length}</b>
                    {t('campaigns:joinAndSend.autoPickSuffix')}
                  </>
                ) : (
                  <>
                    {t('campaigns:joinAndSend.manualPickPrefix')}
                    <b>{picked.length}</b>
                    {t('campaigns:joinAndSend.manualPickSuffix', { total: rows.length })}
                  </>
                )}
              </span>
              {batchId ? (
                <>
                  <Tag color="blue">{t('campaigns:joinAndSend.batchTag', { id: batchId.slice(0, 8) })}</Tag>
                  <span className="tg-muted">
                    {batch
                      ? t('campaigns:joinAndSend.batchSummary', {
                          running: batch.counts?.running ?? 0,
                          completed: batch.counts?.completed ?? 0,
                          failed: batch.counts?.failed ?? 0,
                        })
                      : t('campaigns:joinAndSend.syncing')}
                  </span>
                  <Button size="small" onClick={() => navigate('/campaigns/batches')}>
                    {t('campaigns:sections.batches')}
                  </Button>
                </>
              ) : null}
            </Space>
            <Table<AccountOut>
              size="small"
              rowKey="id"
              columns={accountColumns}
              dataSource={rows}
              loading={accounts.loading}
              rowSelection={
                autoAccounts
                  ? undefined
                  : {
                      selectedRowKeys: picked,
                      onChange: (keys) => setSelected(keys as string[]),
                    }
              }
              pagination={{ pageSize: 10, size: 'small', showTotal: (total) => t('campaigns:joinAndSend.totalAccounts', { total }) }}
            />
          </section>
        </div>

        <footer className="tg-submit-dock">
          <Button type="primary" size="large" htmlType="submit" icon={<RocketOutlined />} loading={submitting}>
            {t('campaigns:joinAndSend.submitButton')}
          </Button>
          <div className="tg-submit-hint">
            <strong>{t('campaigns:joinAndSend.submitTitle')}</strong>
            <span>{t('campaigns:joinAndSend.submitDesc')}</span>
          </div>
        </footer>
      </Form>

      <Modal
        open={pickerOpen}
        title={t('campaigns:joinAndSend.pickerModalTitle')}
        width={820}
        okText={t('campaigns:joinAndSend.pickerModalOk', { count: Object.keys(pickedGroups).length })}
        okButtonProps={{ disabled: !Object.keys(pickedGroups).length }}
        onOk={applyPickedGroups}
        onCancel={() => {
          setPickerOpen(false);
          setPickedGroups({});
        }}
      >
        <Space wrap style={{ marginBottom: 'var(--tg-space-md)' }}>
          <Input.Search
            allowClear
            placeholder={t('campaigns:joinAndSend.pickerSearchPlaceholder')}
            style={{ width: 300 }}
            onSearch={(value) => {
              setGroupPage(1);
              setGroupKeyword(value);
            }}
          />
          <Select
            allowClear
            value={groupCountry}
            placeholder={t('campaigns:joinAndSend.pickerCountry')}
            style={{ width: 170 }}
            showSearch
            optionFilterProp="label"
            onChange={(value?: string) => {
              setGroupCountry(value);
              setGroupPage(1);
            }}
            options={regionOptions(groups.data?.summary.countries, groupCountry)}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void groups.reload()}>
            {t('common:refresh')}
          </Button>
          <span className="tg-muted">{t('campaigns:joinAndSend.pickerHint')}</span>
        </Space>
        <Table<GroupProfileOut>
          size="small"
          rowKey={(record) => String(record.tg_chat_id)}
          columns={groupColumns}
          dataSource={groups.data?.items ?? []}
          loading={groups.loading}
          rowSelection={{
            selectedRowKeys: Object.keys(pickedGroups),
            onChange: (keys) => onPickGroups(keys.map(String)),
            getCheckboxProps: (record) => ({ disabled: !groupLinkOf(record) }),
          }}
          pagination={{
            current: groupPage,
            pageSize: 20,
            total: groups.data?.total ?? 0,
            showSizeChanger: false,
            onChange: (page) => setGroupPage(page),
          }}
        />
      </Modal>

      <BulkResultModal open={!!result} result={result} onClose={() => setResult(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- 动作表单

interface ActionFormProps {
  title: string;
  description: string;
  submit: (payload: Record<string, unknown>) => Promise<BulkResultOut>;
  buildPayload: (scope: ScopeState, values: Record<string, unknown>) => Record<string, unknown>;
  children: React.ReactNode;
  /** 给了就显示「定时队列」区块 + 下方「正在定时」列表（值 = 计划动作名） */
  scheduleAction?: string;
  /** 表单初值（如从群情报页同步过来的加群链接） */
  initialValues?: Record<string, unknown>;
}

/** 资料模板：把「名字池 / 简介池 / 用户名规则 / 头像」整套存起来，下次一键套用。
 *
 *  为什么做在浏览器里（localStorage）而不是服务端：改资料是低频操作，
 *  模板属于操作者个人的填写习惯，不值得为它开一张表 + 一套增删改查接口；
 *  存在本地反而更直接——唯一代价是换浏览器要重新存一次。
 */
const PROFILE_TEMPLATE_KEY = 'cloudctl.profile_templates';

const PROFILE_TEMPLATE_FIELDS = [
  'first_name', 'last_name', 'bio', 'fixed_username',
  'username_prefix', 'username_digits', 'pool_mode', 'photo_material_id', 'photo_url',
] as const;

function ProfileTemplates() {
  const { t } = useTranslation(['campaigns', 'common']);
  const form = Form.useFormInstance();
  const [templates, setTemplates] = useState<Record<string, Record<string, unknown>>>(() => {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_TEMPLATE_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  });
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [message, setMessage] = useState('');

  const persist = (next: Record<string, Record<string, unknown>>) => {
    setTemplates(next);
    localStorage.setItem(PROFILE_TEMPLATE_KEY, JSON.stringify(next));
  };

  const saveCurrent = () => {
    const name = draftName.trim();
    if (!name) return;
    const values = form.getFieldsValue(true) as Record<string, unknown>;
    const snapshot: Record<string, unknown> = {};
    PROFILE_TEMPLATE_FIELDS.forEach((key) => {
      const value = values[key];
      if (value !== undefined && value !== null && value !== '') snapshot[key] = value;
    });
    persist({ ...templates, [name]: snapshot });
    setNaming(false);
    setDraftName('');
    setMessage(t('campaigns:profileTemplates.saved', { name }));
  };

  const applyTemplate = (name: string) => {
    form.setFieldsValue(templates[name]);
    setMessage(t('campaigns:profileTemplates.applied', { name }));
  };

  const removeTemplate = (name: string) => {
    const next = { ...templates };
    delete next[name];
    persist(next);
    setMessage(t('campaigns:profileTemplates.deleted', { name }));
  };

  const names = Object.keys(templates);

  return (
    <div className="tg-template-bar" style={{ gridColumn: '1 / -1' }}>
      <span className="tg-template-label">{t('campaigns:profileTemplates.label')}</span>
      {names.length === 0 && <span className="tg-template-empty">{t('campaigns:profileTemplates.empty')}</span>}
      {names.map((name) => (
        <span key={name} className="tg-template-chip">
          <button type="button" onClick={() => applyTemplate(name)} title={t('campaigns:profileTemplates.applyTitle')}>
            {name}
          </button>
          <button type="button" className="tg-template-del" onClick={() => removeTemplate(name)} title={t('campaigns:profileTemplates.deleteTitle')}>
            ×
          </button>
        </span>
      ))}
      {naming ? (
        <span className="tg-template-save">
          <Input
            size="small"
            autoFocus
            placeholder={t('campaigns:profileTemplates.namePlaceholder')}
            value={draftName}
            style={{ width: 200 }}
            onChange={(event) => setDraftName(event.target.value)}
            onPressEnter={saveCurrent}
          />
          <Button size="small" type="primary" onClick={saveCurrent}>{t('common:save')}</Button>
          <Button size="small" onClick={() => setNaming(false)}>{t('common:cancel')}</Button>
        </span>
      ) : (
        <Button size="small" onClick={() => setNaming(true)}>{t('campaigns:profileTemplates.saveCurrent')}</Button>
      )}
      {message && <span className="tg-template-msg">{message}</span>}
    </div>
  );
}

/** 节奏预设按钮：靠 Form.useFormInstance 拿到当前表单实例，一键套用整组参数 */
function RhythmPresets() {
  const { t } = useTranslation('campaigns');
  const form = Form.useFormInstance();
  return (
    <div
      className="tg-preset-row"
      /* 这排预设是横向卡片组，必须独占整行；靠 CSS 选择器匹配容易失手，直接写死更稳 */
      style={{ gridColumn: '1 / -1' }}
    >
      <span className="tg-preset-label">{t('rhythmPresets.label')}</span>
      {RHYTHM_PRESETS.map((preset) => {
        const label = t(`rhythmPresets.${preset.key}Label`);
        const detail = t(`rhythmPresets.${preset.key}Detail`);
        return (
          <button
            key={preset.key}
            type="button"
            className="tg-preset-btn"
            title={detail}
            onClick={() => form.setFieldsValue(preset.values)}
          >
            <b>{label}</b>
            <span>{detail}</span>
          </button>
        );
      })}
    </div>
  );
}

function ActionTab({
  title,
  description,
  submit,
  buildPayload,
  children,
  scheduleAction,
  initialValues,
}: ActionFormProps) {
  const { t } = useTranslation('campaigns');
  const [scope, setScope] = useState<ScopeState>({ scope: 'all', limit: 200 });
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkResultOut | null>(null);
  // 定时计划刚建完，下方「正在定时」列表要跟着刷新
  const [scheduleTick, setScheduleTick] = useState(0);

  const onFinish = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      const payload = buildPayload(scope, values);
      if (scheduleAction && values.schedule_enabled) {
        // 定时专属字段不进任务 payload：它们是给计划接口的，混进去会让任务参数校验失败
        const taskPayload = { ...payload };
        delete taskPayload.schedule_enabled;
        delete taskPayload.schedule_interval;
        delete taskPayload.schedule_window;
        await campaignScheduleApi.create({
          action: scheduleAction,
          interval_minutes: Number(values.schedule_interval ?? 30) || 30,
          send_window: String(values.schedule_window ?? '').trim(),
          start_in_minutes: 0,
          payload: taskPayload,
        });
        notifySuccess(t('actionTab.scheduledSuccess'));
        setScheduleTick((n) => n + 1);
        return;
      }
      setResult(await submit(payload));
    } catch {
      /* client 已统一提示 */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tg-action-page">
      <header className="tg-page-head">
        <div className="tg-page-head-main">
          <h1 className="tg-page-title">{title}</h1>
          <p className="tg-page-desc">{description}</p>
        </div>
        <div className="tg-page-head-meta">
          <span className="tg-chip">{t('actionTab.chipStaggered')}</span>
          <span className="tg-chip tg-chip-soft">{t('actionTab.chipWorker')}</span>
        </div>
      </header>

      <Form form={form} layout="vertical" className="tg-action-form" initialValues={initialValues} onFinish={(values) => void onFinish(values)}>
        <div className="tg-form-body">{children}</div>

        {scheduleAction ? (
          <section className="tg-section">
            <div className="tg-section-head">
              <span className="tg-section-bar" />
              <h2 className="tg-section-title">{t('actionTab.scheduleSectionTitle')}</h2>
              <span className="tg-section-note">
                {t('actionTab.scheduleSectionNote')}
              </span>
            </div>
            <div className="tg-flex" style={{ gap: 'var(--tg-space-xl)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Form.Item label={t('actionTab.scheduleEnabledLabel')} name="schedule_enabled" valuePropName="checked" initialValue={false}>
                <Switch />
              </Form.Item>
              <Form.Item label={t('actionTab.scheduleIntervalLabel')} name="schedule_interval" initialValue={30}>
                <InputNumber min={1} max={1440} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item
                label={t('actionTab.scheduleWindowLabel')}
                name="schedule_window"
                tooltip={t('actionTab.scheduleWindowTooltip')}
              >
                <Input placeholder="09:00-22:00" style={{ width: 180 }} />
              </Form.Item>
            </div>
          </section>
        ) : null}

        <section className="tg-section">
          <div className="tg-section-head">
            <span className="tg-section-bar" />
            <h2 className="tg-section-title">{t('actionTab.scopeSectionTitle')}</h2>
            <span className="tg-section-note">
              {t('actionTab.scopeSectionNote')}
            </span>
          </div>
          <ScopeFields value={scope} onChange={setScope} />
        </section>

        <footer className="tg-submit-dock">
          <Button type="primary" size="large" htmlType="submit" icon={<RocketOutlined />} loading={submitting}>
            {t('actionTab.submitButton')}
          </Button>
          <div className="tg-submit-hint">
            <strong>{t('actionTab.submitTitle')}</strong>
            <span>{t('actionTab.submitDesc')}</span>
          </div>
        </footer>
      </Form>
      {scheduleAction ? <SchedulePanel refreshKey={scheduleTick} /> : null}
      <BulkResultModal open={!!result} result={result} onClose={() => setResult(null)} />
    </div>
  );
}

/**
 * 补齐覆盖：选好几个群，一键让「系统里所有号」都进这些群。
 * 差集由后端算——已经在群里的号会跳过，不重复加群（重复加群最容易吃风控）。
 */
function JoinMissingPanel() {
  const { t } = useTranslation('campaigns');
  const options = useAsyncData(() => campaignApi.groupOptions(), []);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await campaignApi.joinMissing({ targets: picked, scope: 'all' });
      notifySuccess(res.message);
      setPicked([]);
      void options.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space wrap style={{ width: '100%' }}>
      <Select
        mode="multiple"
        showSearch
        allowClear
        placeholder={t('joinMissing.placeholder')}
        optionFilterProp="label"
        loading={options.loading}
        value={picked}
        onChange={(value: string[]) => setPicked(value)}
        // 宽度自适应卡片（原先 minWidth: 420，比 span3 卡片还宽 → 撑破边框 117px）
        style={{ width: '100%' }}
        options={(options.data ?? []).map((row) => ({
          value: row.value,
          label: t('joinMissing.optionLabel', {
            title: row.title || row.value,
            kind: row.kind === 'channel' ? t('joinMissing.kindChannel') : t('joinMissing.kindGroup'),
            count: row.account_count,
          }),
        }))}
      />
      <Button type="primary" ghost loading={busy} disabled={!picked.length} onClick={() => void run()}>
        {t('joinMissing.submit')}
      </Button>
    </Space>
  );
}

/**
 * 目标群选择器：从「系统里的号都在哪些群」里挑，可多选。
 * 每个选项后面跟着「N 个号在里面」——选之前就看得出这个群有几个号能发。
 */
function GroupPicker({
  value,
  onChange,
}: {
  /** Form.Item 注入的受控值：不接这两个 props 的话，选完表单拿不到值，会一直报「至少选一个群」 */
  value?: string[];
  onChange?: (next: string[]) => void;
}) {
  const { t } = useTranslation(['campaigns', 'common']);
  const options = useAsyncData(() => campaignApi.groupOptions(), []);
  const rows = options.data ?? [];
  const selected = value ?? [];
  const allValues = rows.map((row) => row.value);
  const allSelected = allValues.length > 0 && allValues.every((item) => selected.includes(item));

  const selectAll = () => onChange?.(allValues);
  const clearAll = () => onChange?.([]);

  return (
    <Select
      mode="multiple"
      showSearch
      allowClear
      placeholder={t('campaigns:groupPicker.placeholder')}
      loading={options.loading}
      optionFilterProp="label"
      maxTagCount="responsive"
      // 宽度交给容器（原先写死 minWidth: 460，在窄卡片里会撑破边框）
      style={{ width: '100%' }}
      value={selected}
      onChange={(next: string[]) => onChange?.(next)}
      dropdownRender={(menu) => (
        <>
          <Space style={{ padding: '8px 12px' }}>
            <Button
              type="link"
              size="small"
              disabled={!allValues.length || allSelected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={selectAll}
            >
              {t('campaigns:groupPicker.selectAllWithCount', { count: allValues.length })}
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!selected.length}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearAll}
            >
              {t('campaigns:groupPicker.clear')}
            </Button>
            <Typography.Text type="secondary">{t('common:selectedCount', { count: selected.length })}</Typography.Text>
          </Space>
          {menu}
        </>
      )}
      options={rows.map((row) => ({
        value: row.value,
        // 频道只有管理员能发言：标出来，不然选完只会收到 ChatAdminRequiredError
        label: t('campaigns:joinMissing.optionLabel', {
          title: row.title || row.value,
          kind: row.kind === 'channel' ? t('campaigns:joinMissing.kindChannel') : t('campaigns:joinMissing.kindGroup'),
          count: row.account_count,
        }),
      }))}
      notFoundContent={options.loading ? t('campaigns:groupPicker.loading') : t('campaigns:groupPicker.empty')}
    />
  );
}

/**
 * 「正在定时」：定时计划列表。
 *
 * 计划到点由服务端调度器展开成任务，这里只做展示与三件事——暂停/启用、立即跑一轮、删掉。
 */
function SchedulePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useTranslation(['campaigns', 'common', 'enums']);
  const schedules = useAsyncData(() => campaignScheduleApi.list(), [refreshKey]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = schedules.data ?? [];

  const toggle = async (row: CampaignScheduleOut) => {
    setBusyId(row.id);
    try {
      await campaignScheduleApi.update(row.id, { enabled: !row.enabled });
      toast.success(row.enabled ? t('campaigns:schedulePanel.paused') : t('campaigns:schedulePanel.enabled'));
      void schedules.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (row: CampaignScheduleOut) => {
    setBusyId(row.id);
    try {
      await campaignScheduleApi.runNow(row.id);
      notifySuccess(t('campaigns:schedulePanel.runNowSuccess'));
      void schedules.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: CampaignScheduleOut) => {
    setBusyId(row.id);
    try {
      await campaignScheduleApi.remove(row.id);
      notifySuccess(t('campaigns:schedulePanel.deleted'));
      void schedules.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="tg-section" style={{ marginTop: 'var(--tg-space-xl)' }}>
      <div className="tg-section-head">
        <span className="tg-section-bar" />
        <h2 className="tg-section-title">{t('campaigns:schedulePanel.title')}</h2>
        <span className="tg-section-note">
          {t('campaigns:schedulePanel.note')}
        </span>
        <Button size="small" icon={<ReloadOutlined />} loading={schedules.loading} onClick={() => void schedules.reload()}>
          {t('common:refresh')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('campaigns:schedulePanel.empty')}
        />
      ) : (
        <div className="tg-stack" style={{ gap: 'var(--tg-space-md)' }}>
          {rows.map((row) => (
            <div
              key={row.id}
              className="tg-flex"
              style={{
                gap: 'var(--tg-space-lg)',
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: 'var(--tg-space-md) var(--tg-space-lg)',
                border: '1px solid var(--tg-color-border)',
                borderRadius: 'var(--tg-radius-lg)',
                opacity: row.enabled ? 1 : 0.6,
              }}
            >
              <Tag color={row.enabled ? 'green' : 'default'}>
                {row.enabled ? t('campaigns:schedulePanel.statusActive') : t('campaigns:schedulePanel.statusPaused')}
              </Tag>
              <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>{row.name}</span>
              <span className="tg-muted">{resolveEnumLabel(`taskType.${row.action}`, row.action_label, row.action)}</span>
              <span className="tg-mono tg-muted">{row.target_summary}</span>
              <span className="tg-muted">{t('campaigns:schedulePanel.everyMinutes', { minutes: row.interval_minutes })}</span>
              {row.send_window ? <span className="tg-muted">{t('campaigns:schedulePanel.window', { window: row.send_window })}</span> : null}
              <span className="tg-muted">
                {t('campaigns:schedulePanel.nextRun', { time: formatTime(row.next_run_at) })}
                {row.run_count ? t('campaigns:schedulePanel.runCountSuffix', { count: formatNumber(row.run_count) }) : ''}
              </span>
              {row.last_error ? (
                <Tooltip title={row.last_error}>
                  <span className="tg-text-danger tg-clamp-cell" style={{ maxWidth: 220 }}>
                    {t('campaigns:schedulePanel.lastError', { error: row.last_error })}
                  </span>
                </Tooltip>
              ) : null}
              <Space size={8} style={{ marginLeft: 'auto' }}>
                <Button size="small" loading={busyId === row.id} onClick={() => void toggle(row)}>
                  {row.enabled ? t('campaigns:schedulePanel.pause') : t('campaigns:schedulePanel.enable')}
                </Button>
                <Button size="small" type="primary" ghost loading={busyId === row.id} onClick={() => void runNow(row)}>
                  {t('campaigns:schedulePanel.runNow')}
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={busyId === row.id}
                  onClick={() => void remove(row)}
                />
              </Space>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 页面

/** 发信节奏预设：把「间隔 / 时间窗 / 每日配额」成套套用，避免每次靠猜。
 *  数值偏保守是故意的——号被封的代价远大于发慢一点。 */
const RHYTHM_PRESETS = [
  {
    key: 'safe' as const,
    values: { min_interval: 25, max_interval: 70, send_window: '10:00-22:00', daily_quota: 20 },
  },
  {
    key: 'normal' as const,
    values: { min_interval: 8, max_interval: 25, send_window: '09:00-23:00', daily_quota: 50 },
  },
  {
    key: 'fast' as const,
    values: { min_interval: 3, max_interval: 10, send_window: '08:00-24:00', daily_quota: 120 },
  },
  {
    key: 'unlimited' as const,
    values: { min_interval: 3, max_interval: 8, send_window: '', daily_quota: 0 },
  },
];

export default function Campaigns() {
  const { t } = useTranslation('campaigns');
  const navigate = useNavigate();
  const location = useLocation();
  // 群情报页「同步到加群」把链接放在路由 state 里：进入页面时读一次，随后清掉 state，下次进来不残留
  const [syncedJoinTargets] = useState<string[]>(
    () => (location.state as { joinTargets?: string[] } | null)?.joinTargets ?? [],
  );
  useEffect(() => {
    if (syncedJoinTargets.length) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Bot 列表：私信 / 群发的「用 Bot 发送」通道要用
  const bots = useAsyncData(() => botApi.list(), []);
  const { section } = useParams<{ section: string }>();
  // 触达中心当前只开放这 5 个页面；其余（批量私信 / 退群 / 强拉进群 / 批量改资料 /
  // 吵群 / 拟人发言）在 UI 隐藏，旧地址会被下面的 !current 判断重定向回素材库。
  const VISIBLE_SECTIONS = new Set(['materials', 'join-send', 'batches']);
  const sections = [
    { key: 'materials', label: t('sections.materials'), children: <MaterialsTab /> },
    {
      key: 'join-send',
      label: t('sections.joinSend'),
      children: <JoinAndSendTab initialTargets={syncedJoinTargets} />,
    },
    {
      key: 'bulk-pm',
      label: t('sections.bulkPm'),
      children: (
        <ActionTab
          title={t('bulkPm.title')}
          description={t('bulkPm.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            targets: splitField(values.targets),
            text: String(values.text ?? '').trim() || null,
            texts: splitField(values.texts).length ? splitField(values.texts) : null,
            naturalize: Boolean(values.naturalize),
            min_interval: Number(values.min_interval ?? 3),
            max_interval: Number(values.max_interval ?? 8),
            dispatch: String(values.dispatch ?? 'each'),
            material_id: (values.material_id as string | undefined) ?? null,
            // 「用 Bot 私信」原来只做了 UI 开关、没接提交，这里补上（后端据此走 Bot 通道）
            via_bot: Boolean(values.via_bot),
            bot_id: (values.bot_id as string | undefined) ?? null,
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.bulkPm(payload as unknown as BulkPmRequest)}
        >
          <div className="tg-form-group-title">{t('bulkPm.groupContent')}</div>
          <Form.Item label={t('bulkPm.targetsLabel')} name="targets" rules={[{ required: true, message: t('bulkPm.targetsRequired') }]}>
            <Input.TextArea placeholder="@user1\n@user2\n+12025550143" autoSize={{ minRows: 3, maxRows: 6 }} style={{ maxWidth: '100%' }} />
          </Form.Item>
          <Form.Item label={t('bulkPm.textLabel')} name="text">
            <Input.TextArea placeholder={t('bulkPm.textPlaceholder')} autoSize={{ minRows: 3, maxRows: 4 }} style={{ maxWidth: '100%' }} />
          </Form.Item>
          <Form.Item label={t('bulkPm.textsLabel')} name="texts">
            <Input.TextArea placeholder={t('bulkPm.textsPlaceholder')} autoSize={{ minRows: 3, maxRows: 6 }} style={{ maxWidth: '100%' }} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.material_id !== next.material_id}>
            {({ getFieldValue, setFieldValue }) => (
              <MaterialPickField
                value={getFieldValue('material_id')}
                onChange={(next) => setFieldValue('material_id', next)}
              />
            )}
          </Form.Item>
          {/* 节奏与配额：什么时候发、发多快、一天发多少 */}
          <div className="tg-form-group-title">{t('bulkPm.groupRhythm')}</div>
          <RhythmPresets />
          <div className="tg-form-grid">
            <Form.Item label={t('bulkPm.minInterval')} name="min_interval" initialValue={3}>
              <InputNumber min={1} max={60} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label={t('bulkPm.maxInterval')} name="max_interval" initialValue={8}>
              <InputNumber min={1} max={120} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              label={t('bulkPm.parseModeLabel')}
              name="parse_mode"
              tooltip={t('bulkPm.parseModeTooltip')}
            >
              <Select
                style={{ width: '100%' }}
                allowClear
                placeholder={t('bulkPm.parseModePlain')}
                options={[
                  { value: 'md', label: t('bulkPm.parseModeMd') },
                  { value: 'html', label: t('bulkPm.parseModeHtml') },
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t('bulkPm.forwardLabel')}
              className="tg-pm-forward"
              tooltip={t('bulkPm.forwardTooltip')}
            >
              <Space size="small" wrap>
                <Form.Item name="forward_from_chat_id" noStyle>
                  <InputNumber placeholder={t('bulkPm.forwardChatIdPlaceholder')} style={{ width: 210 }} />
                </Form.Item>
                <Form.Item name="forward_from_message_id" noStyle>
                  <InputNumber placeholder={t('bulkPm.forwardMessageIdPlaceholder')} style={{ width: 130 }} />
                </Form.Item>
                <Form.Item name="drop_author" valuePropName="checked" noStyle>
                  <Checkbox>{t('bulkPm.dropAuthor')}</Checkbox>
                </Form.Item>
              </Space>
            </Form.Item>
            <Form.Item
              label={t('bulkPm.sendWindowLabel')}
              name="send_window"
              className="tg-pm-num"
              tooltip={t('bulkPm.sendWindowTooltip')}
            >
              <Input placeholder={t('bulkPm.sendWindowPlaceholder')} allowClear />
            </Form.Item>
            <Form.Item
              label={t('bulkPm.dailyQuotaLabel')}
              name="daily_quota"
              className="tg-pm-num"
              tooltip={t('bulkPm.dailyQuotaTooltip')}
            >
              <InputNumber min={0} max={2000} style={{ width: '100%' }} placeholder={t('bulkPm.dailyQuotaPlaceholder')} />
            </Form.Item>
            <Form.Item
              label={t('bulkPm.naturalizeLabel')}
              name="naturalize"
              valuePropName="checked"
              initialValue={false}
              className="tg-field-switch"
              tooltip={t('bulkPm.naturalizeTooltip')}
            >
              <Switch />
            </Form.Item>
          </div>
          <div className="tg-form-group-title">{t('bulkPm.groupChannel')}</div>
          <div className="tg-form-grid">
            <Form.Item
              label={t('bulkPm.viaBotLabel')}
              name="via_bot"
              initialValue={false}
              className="tg-pm-via"
              tooltip={t('bulkPm.viaBotTooltip')}
            >
              <Segmented
                block
                options={[
                  { label: t('bulkPm.viaAccount'), value: false },
                  { label: t('bulkPm.viaBot'), value: true },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.via_bot !== next.via_bot}>
              {({ getFieldValue }) =>
                getFieldValue('via_bot') ? (
                  <Form.Item label={t('bulkPm.botSelectLabel')} name="bot_id" className="tg-pm-bot">
                    <Select
                      placeholder={t('bulkPm.botSelectPlaceholder')}
                      options={(bots.data ?? []).map((item: { id: string; name: string; bot_username?: string | null }) => ({
                        value: item.id,
                        label: `@${item.bot_username || item.name}`,
                      }))}
                      notFoundContent={t('bulkPm.botSelectEmpty')}
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </div>

          <div className="tg-form-group-title">{t('bulkPm.groupExecution')}</div>
          <div className="tg-form-grid">
            <Form.Item
              label={t('bulkPm.dispatchLabel')}
              name="dispatch"
              initialValue="each"
              className="tg-pm-dispatch"
              tooltip={t('bulkPm.dispatchTooltip')}
            >
              <Segmented
                options={[
                  { label: t('bulkPm.dispatchEach'), value: 'each' },
                  { label: t('bulkPm.dispatchRoundRobin'), value: 'round_robin' },
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t('bulkPm.autoSupplyLabel')}
              name="auto_supply"
              valuePropName="checked"
              className="tg-field-switch tg-pm-supply"
              tooltip={t('bulkPm.autoSupplyTooltip')}
            >
              <Switch />
            </Form.Item>
          </div>
        </ActionTab>
      ),
    },
    {
      key: 'broadcast',
      label: t('sections.broadcast'),
      children: (
        <ActionTab
          title={t('broadcast.title')}
          description={t('broadcast.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            target_groups: Array.isArray(values.target_groups) ? (values.target_groups as string[]) : [],
            text: String(values.text ?? '').trim() || null,
            texts: splitField(values.texts).length ? splitField(values.texts) : null,
            naturalize: Boolean(values.naturalize),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
            // 只发给「确实在目标群里」的号：提交时后端按会话列表自动过滤
            only_members: values.only_members !== false,
            // 跳过「活跃时段」闸门：最小间隔 / 每日配额 / 熔断照常
            ignore_active_hours: Boolean(values.ignore_active_hours),
          })}
          submit={(payload) => campaignApi.groupBroadcast(payload as unknown as GroupBroadcastRequest)}
          scheduleAction="group_broadcast"
        >
          {/* 排版 class（.tg-bc-*）只在本页字段上用，规则见 styles.css 末尾「群发页字段排布」。
              两行排满 12 列：文本 / 文本池各 6 列；目标群是主输入项占 8 列，两个开关压成窄条各 2 列。 */}
          <Form.Item label={t('broadcast.textLabel')} name="text" className="tg-bc-text">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} />
          </Form.Item>
          <Form.Item label={t('broadcast.textsLabel')} name="texts" className="tg-bc-text">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} />
          </Form.Item>
          <Form.Item
            label={t('broadcast.targetGroupsLabel')}
            name="target_groups"
            className="tg-bc-target"
            rules={[{ required: true, message: t('broadcast.targetGroupsRequired') }]}
            tooltip={t('broadcast.targetGroupsTooltip')}
          >
            <GroupPicker />
          </Form.Item>
          <Form.Item
            label={t('broadcast.naturalizeLabel')}
            name="naturalize"
            valuePropName="checked"
            initialValue={false}
            className="tg-bc-toggle"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t('broadcast.onlyMembersLabel')}
            name="only_members"
            valuePropName="checked"
            initialValue={true}
            className="tg-bc-toggle"
            tooltip={t('broadcast.onlyMembersTooltip')}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t('broadcast.ignoreActiveHoursLabel')}
            name="ignore_active_hours"
            valuePropName="checked"
            initialValue={false}
            className="tg-bc-toggle"
            tooltip={t('broadcast.ignoreActiveHoursTooltip')}
          >
            <Switch checkedChildren={t('joinAndSend.switchNow')} unCheckedChildren={t('joinAndSend.switchByWindow')} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'material-send',
      label: t('sections.materialSend'),
      children: (
        <ActionTab
          title={t('materialSend.title')}
          description={t('materialSend.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            material_id: String(values.material_id ?? ''),
            target_group: String(values.target_group ?? '').trim() || null,
            targets: splitField(values.targets).length ? splitField(values.targets) : null,
            min_interval: Number(values.min_interval ?? 3),
            max_interval: Number(values.max_interval ?? 8),
            dispatch: String(values.dispatch ?? 'each'),
            // 入群验证：佩奇(Cap)/NuoMi(Turnstile) 自动过，失败退群重进重试
            auto_verify: values.auto_verify !== false,
            verify_timeout: Number(values.verify_timeout ?? 150),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.materialSend(payload as unknown as MaterialSendRequest)}
        >
          <Form.Item label={t('materialSend.materialLabel')} name="material_id" className="tg-field-line" rules={[{ required: true, message: t('materialSend.materialRequired') }]}>
            <MaterialSelect />
          </Form.Item>
          <Form.Item label={t('materialSend.targetGroupLabel')} name="target_group" className="tg-field-line">
            <Input placeholder={t('materialSend.targetGroupPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('materialSend.targetsLabel')} name="targets" className="tg-field-line">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Space wrap className="tg-mat-intervals">
            <Form.Item label={t('materialSend.minInterval')} name="min_interval" initialValue={3}>
              <InputNumber min={1} max={60} />
            </Form.Item>
            <Form.Item label={t('materialSend.maxInterval')} name="max_interval" initialValue={8}>
              <InputNumber min={1} max={120} />
            </Form.Item>
          </Space>
          <Form.Item
            label={t('materialSend.dispatchLabel')}
            name="dispatch"
            initialValue="each"
            className="tg-mat-dispatch"
            tooltip={t('materialSend.dispatchTooltip')}
          >
            <Segmented
              options={[
                { label: t('materialSend.dispatchEach'), value: 'each' },
                { label: t('materialSend.dispatchRoundRobin'), value: 'round_robin' },
              ]}
            />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'join',
      label: t('sections.join'),
      children: (
        <ActionTab
          title={t('join.title')}
          description={t('join.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            targets: splitField(values.targets),
            dispatch: String(values.dispatch ?? 'each'),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
            // 忽略活跃时段：凌晨也立即加群（熔断 / 最小间隔 / 每日配额照常）
            ignore_active_hours: Boolean(values.ignore_active_hours),
          })}
          submit={(payload) => campaignApi.joinGroup(payload as unknown as JoinGroupRequest)}
          initialValues={syncedJoinTargets.length ? { targets: syncedJoinTargets.join('\n') } : undefined}
        >
          <Form.Item
            label={t('join.coverLabel')}
            className="tg-join-cover"
            tooltip={t('join.coverTooltip')}
          >
            <JoinMissingPanel />
          </Form.Item>
          <Form.Item
            label={t('join.targetsLabel')}
            name="targets"
            rules={[{ required: true, message: t('join.targetsRequired') }]}
          >
            <Input.TextArea
              placeholder={'t.me/+AbCdEfGh1234\n@public_group\nt.me/another_group'}
              autoSize={{ minRows: 3, maxRows: 10 }}
            />
          </Form.Item>
          <Form.Item
            label={t('join.dispatchLabel')}
            name="dispatch"
            initialValue="each"
            className="tg-join-dispatch"
            tooltip={t('join.dispatchTooltip')}
          >
            <Segmented
              options={[
                { label: t('join.dispatchEach'), value: 'each' },
                { label: t('join.dispatchRoundRobin'), value: 'round_robin' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={t('join.autoVerifyLabel')}
            name="auto_verify"
            valuePropName="checked"
            initialValue
            className="tg-field-switch"
            tooltip={t('join.autoVerifyTooltip')}
          >
            <Switch checkedChildren={t('join.autoVerifyOn')} unCheckedChildren={t('join.autoVerifyOff')} />
          </Form.Item>
          <Form.Item
            label={t('join.verifyTimeoutLabel')}
            name="verify_timeout"
            initialValue={150}
            tooltip={t('join.verifyTimeoutTooltip')}
          >
            <InputNumber min={30} max={600} step={30} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            label={t('join.ignoreActiveHoursLabel')}
            name="ignore_active_hours"
            valuePropName="checked"
            initialValue={false}
            className="tg-field-switch"
            tooltip={t('join.ignoreActiveHoursTooltip')}
          >
            <Switch checkedChildren={t('joinAndSend.switchNow')} unCheckedChildren={t('joinAndSend.switchByWindow')} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'leave',
      label: t('sections.leave'),
      children: (
        <ActionTab
          title={t('leave.title')}
          description={t('leave.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            targets: splitField(values.targets),
            delete_history: values.delete_history !== false,
            dispatch: String(values.dispatch ?? 'each'),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.leaveGroup(payload as unknown as LeaveGroupRequest)}
        >
          <Form.Item
            label={t('leave.targetsLabel')}
            name="targets"
            className="tg-leave-targets tg-field-line"
            rules={[{ required: true, message: t('leave.targetsRequired') }]}
          >
            <Input.TextArea placeholder={'@group_a\n-1001234567890\nt.me/group_c'} autoSize={{ minRows: 3, maxRows: 10 }} />
          </Form.Item>
          {/* 顺序调整：开关挪到分发方式之前，三者正好排满一行（6+2+4 列），并一起拉伸等高 */}
          <Form.Item
            label={t('leave.deleteHistoryLabel')}
            name="delete_history"
            valuePropName="checked"
            initialValue={true}
            className="tg-field-switch tg-field-line"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label={t('leave.dispatchLabel')}
            name="dispatch"
            initialValue="each"
            className="tg-leave-dispatch tg-field-line"
            tooltip={t('leave.dispatchTooltip')}
          >
            <Segmented
              options={[
                { label: t('leave.dispatchEach'), value: 'each' },
                { label: t('leave.dispatchRoundRobin'), value: 'round_robin' },
              ]}
            />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'force-add',
      label: t('sections.forceAdd'),
      children: (
        <ActionTab
          title={t('forceAdd.title')}
          description={t('forceAdd.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            groups: splitField(values.groups),
            members: splitField(values.members),
            dispatch: String(values.dispatch ?? 'each'),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.forceAdd(payload as unknown as ForceAddRequest)}
        >
          <Form.Item label={t('forceAdd.groupsLabel')} name="groups" rules={[{ required: true, message: t('forceAdd.groupsRequired') }]}>
            <Input.TextArea placeholder={'@group_a\n-1001234567890'} autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          <Form.Item label={t('forceAdd.membersLabel')} name="members" rules={[{ required: true, message: t('forceAdd.membersRequired') }]}>
            <Input.TextArea placeholder="@user1\n@user2" autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'profile',
      label: t('sections.profile'),
      children: (
        <ActionTab
          title={t('profile.title')}
          description={t('profile.description')}
          buildPayload={(scope, values) => {
            // 一行 = 统一值；多行 = 候选池（按号顺序轮流取 或 随机取）
            const nameLines = splitField(values.first_name);
            const lastLines = splitField(values.last_name);
            const bioLines = splitField(values.bio);
            const one = (lines: string[]) => (lines.length === 1 ? lines[0] : null);
            return {
              ...scopePayload(scope),
              profile: {
                first_name: one(nameLines),
                last_name: one(lastLines),
                bio: one(bioLines),
                username: String(values.username ?? '').trim() || null,
                photo_url: String(values.photo_url ?? '').trim() || null,
                photo_material_id: (values.photo_material_id as string | undefined) ?? null,
              },
              first_name_pool: nameLines.length > 1 ? nameLines : null,
              last_name_pool: lastLines.length > 1 ? lastLines : null,
              bio_pool: bioLines.length > 1 ? bioLines : null,
              username_prefix: String(values.username_prefix ?? '').trim() || null,
              username_random_digits: Number(values.username_random_digits ?? 4),
              assign_mode: String(values.assign_mode ?? 'sequence'),
            };
          }}
          submit={(payload) => campaignApi.profileUpdate(payload as unknown as ProfileBulkRequest)}
        >
          <ProfileTemplates />
          <Space wrap align="start" className="tg-pf-lines">
            <Form.Item label={t('profile.firstNameLabel')} name="first_name">
              <Input.TextArea placeholder={t('profile.firstNamePlaceholder')} autoSize={{ minRows: 2, maxRows: 6 }} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label={t('profile.lastNameLabel')} name="last_name">
              <Input.TextArea placeholder={'Chen\nWang\nLi'} autoSize={{ minRows: 2, maxRows: 6 }} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item
              label={t('profile.fixedUsernameLabel')}
              name="username"
              tooltip={t('profile.fixedUsernameTooltip')}
            >
              <Input placeholder={t('profile.fixedUsernamePlaceholder')} style={{ width: 240 }} />
            </Form.Item>
          </Space>
          <Form.Item label={t('profile.bioLabel')} name="bio" className="tg-pf-bio">
            <Input.TextArea
              placeholder={t('profile.bioPlaceholder')}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
          </Form.Item>
          <Space wrap align="start" className="tg-pf-lines">
            <Form.Item
              label={t('profile.usernamePrefixLabel')}
              name="username_prefix"
              tooltip={t('profile.usernamePrefixTooltip')}
            >
              <Input placeholder={t('profile.usernamePrefixPlaceholder')} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label={t('profile.randomDigitsLabel')} name="username_random_digits" initialValue={4}>
              <InputNumber min={2} max={8} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item
              label={t('profile.assignModeLabel')}
              name="assign_mode"
              initialValue="sequence"
              tooltip={t('profile.assignModeTooltip')}
            >
              <Segmented
                options={[
                  { label: t('profile.assignSequence'), value: 'sequence' },
                  { label: t('profile.assignRandom'), value: 'random' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            label={t('profile.avatarLabel')}
            name="photo_material_id"
            className="tg-pf-photo"
            tooltip={t('profile.avatarTooltip')}
          >
            <MaterialPicker kinds={['photo']} placeholder={t('profile.avatarPlaceholder')} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('profile.avatarUrlLabel')} name="photo_url">
            <Input placeholder="https://…/avatar.jpg" style={{ maxWidth: 420 }} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'storm',
      label: t('sections.storm'),
      children: (
        <ActionTab
          title={t('storm.title')}
          description={t('storm.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            group: String(values.group ?? '').trim() || null,
            rounds: Number(values.rounds ?? 5),
            min_interval: Number(values.min_interval ?? 8),
            max_interval: Number(values.max_interval ?? 30),
            texts: splitField(values.texts),
            reply_probability: Number(values.reply_probability ?? 0),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.storm(payload as unknown as StormRequest)}
        >
          <Form.Item label={t('storm.groupLabel')} name="group" className="tg-field-line" rules={[{ required: true, message: t('storm.required') }]}>
            <Input placeholder={t('storm.groupPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('storm.textsLabel')} name="texts" className="tg-field-line" rules={[{ required: true, message: t('storm.textsRequired') }]}>
            <Input.TextArea placeholder={t('storm.textsPlaceholder')} autoSize={{ minRows: 4, maxRows: 8 }} />
          </Form.Item>
          <Space wrap className="tg-storm-params">
            <Form.Item label={t('storm.roundsLabel')} name="rounds" initialValue={5}>
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item label={t('storm.minIntervalLabel')} name="min_interval" initialValue={8}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label={t('storm.maxIntervalLabel')} name="max_interval" initialValue={30}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label={t('storm.replyProbLabel')} name="reply_probability" initialValue={0}>
              <InputNumber min={0} max={1} step={0.1} />
            </Form.Item>
          </Space>
        </ActionTab>
      ),
    },
    {
      key: 'persona',
      label: t('sections.persona'),
      children: (
        <ActionTab
          title={t('persona.title')}
          description={t('persona.description')}
          buildPayload={(scope, values) => ({
            ...scopePayload(scope),
            group: String(values.group ?? '').trim() || null,
            persona: String(values.persona ?? '').trim(),
            topic: String(values.topic ?? '').trim() || null,
            use_ai: values.use_ai !== false,
            texts: splitField(values.texts).length ? splitField(values.texts) : null,
            rounds: Number(values.rounds ?? 5),
            min_interval: Number(values.min_interval ?? 10),
            max_interval: Number(values.max_interval ?? 40),
            // 定时 / 定量 / 补号：之前只加了控件、没接到 payload，填了也不生效（本轮修）
            send_window: String(values.send_window ?? '').trim(),
            daily_quota: Number(values.daily_quota ?? 0),
            auto_supply: Boolean(values.auto_supply),
            // 内容形态：富文本 / 转发（可隐藏来源）
            parse_mode: String(values.parse_mode ?? '').trim(),
            forward_from_chat_id: values.forward_from_chat_id ?? null,
            forward_from_message_id: values.forward_from_message_id ?? null,
            drop_author: Boolean(values.drop_author),
          })}
          submit={(payload) => campaignApi.persona(payload as unknown as PersonaRequest)}
        >
          <Form.Item label={t('persona.groupLabel')} name="group" className="tg-field-line" rules={[{ required: true, message: t('persona.required') }]}>
            <Input placeholder={t('persona.groupPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('persona.personaLabel')} name="persona" className="tg-field-line" rules={[{ required: true, message: t('persona.required') }]}>
            <Input.TextArea
              placeholder={t('persona.personaPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Form.Item label={t('persona.topicLabel')} name="topic" className="tg-field-line">
            <Input placeholder={t('persona.topicPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('persona.fallbackTextsLabel')} name="texts" className="tg-persona-texts">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
          </Form.Item>
          <Space wrap className="tg-persona-params">
            <Form.Item label={t('persona.useAiLabel')} name="use_ai" valuePropName="checked" initialValue={true} className="tg-field-switch">
              <Switch />
            </Form.Item>
            <Form.Item label={t('persona.roundsLabel')} name="rounds" initialValue={5}>
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item label={t('persona.minIntervalLabel')} name="min_interval" initialValue={10}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label={t('persona.maxIntervalLabel')} name="max_interval" initialValue={40}>
              <InputNumber min={3} max={120} />
            </Form.Item>
          </Space>
        </ActionTab>
      ),
    },
    { key: 'batches', label: t('sections.batches'), children: <BatchesTab /> },
  ].filter((item) => VISIBLE_SECTIONS.has(item.key));

  const current = sections.find((item) => item.key === section);
  if (section && !current) return <Navigate to="/campaigns/materials" replace />;
  const active = current ?? sections[0];

  return (
    <PageContainer
      title={active.label}
      description={t('pageDescription')}
      actions={
        <Select
          size="small"
          style={{ width: 176 }}
          value={active.key}
          onChange={(key) => navigate(`/campaigns/${key}`)}
          options={sections.map((item) => ({ value: item.key, label: item.label }))}
          aria-label={t('switchSectionAria')}
        />
      }
    >
      {active.children}
    </PageContainer>
  );
}
