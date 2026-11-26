/**
 * 触达中心：素材库 / 加群群发 / 批次进度。
 *
 * 「加群群发」= 一号一条任务、号内逐群「加群 → 过验证 → 发内容」，合并了旧的 群发 / 素材群发 / 加群；
 * 其余动作（批量私信 / 退群 / 强拉 / 批量改资料 / 吵群 / 拟人发言）保留代码但不在 UI 露出。
 * 提交后后端按「一号一任务」入队，结果弹窗复用 BulkResultModal；执行进度看「批次进度」。
 */
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
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
import { PageContainer, StatusBadge } from '../components';
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
import { notifySuccess, toast } from '../utils/feedback';
import { formatNumber, formatTime } from '../utils/format';
import type {
  AccountOut,
  AccountStatus,
  BulkPmRequest,
  BulkResultOut,
  CampaignBatchItem,
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
          { label: '全部可见账号', value: 'all' },
          { label: '按分组', value: 'group' },
          { label: '手动选择', value: 'selected' },
        ]}
      />
      {value.scope === 'selected' ? (
        <>
          <Button size="middle" icon={<TeamOutlined />} onClick={() => setPickerOpen(true)}>
            选择账号{value.ids?.length ? `（已选 ${value.ids.length}）` : ''}
          </Button>
          <AccountPickerModal
            open={pickerOpen}
            title="选择要执行本次任务的账号"
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
          placeholder="选择账号分组"
          value={value.groupId ?? undefined}
          loading={groups.loading}
          onChange={(groupId) => onChange({ ...value, groupId })}
          options={(groups.data ?? []).map((group) => ({ label: group.name, value: group.id }))}
        />
      ) : null}
      <span className="tg-scope-limit">
        <span className="tg-scope-limit-label">最多处理</span>
        {/* 原本用 InputNumber 的 addonBefore/addonAfter 做前后缀，antd 已弃用；
            改成并列的普通元素，语义一样、也不会有弃用警告 */}
        <InputNumber
          min={1}
          max={500}
          value={value.limit}
          onChange={(limit) => onChange({ ...value, limit: limit ?? 200 })}
          style={{ width: 110 }}
        />
        <span className="tg-scope-limit-label">个号</span>
      </span>
    </Space>
  );
}

/** 可选素材选择：把素材库里的图片/视频/文档配在文本一起发（批量私信 / 群发共用） */
function MaterialPickField({ value, onChange }: { value?: string | null; onChange?: (next: string | null) => void }) {
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), [], { immediate: false });
  useEffect(() => {
    void materials.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Form.Item
      label="附带素材（可选）"
      className="tg-pm-material"
      tooltip="选了素材就按素材发：图片/视频/文档带配文，文本作为配文一起发；留空则只发文本"
    >
      <Select
        allowClear
        // 宽度交给卡片（原先写死 320，比 span3 卡片的内容区还宽，会撑破边框）
        style={{ width: '100%' }}
        placeholder="不附带素材，只发文本"
        value={value ?? undefined}
        loading={materials.loading}
        onChange={(next) => onChange?.(next ?? null)}
        options={(materials.data?.items ?? []).map((item) => ({
          value: item.id,
          label: `[${item.kind_label ?? item.kind}] ${item.name}`,
        }))}
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
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), []);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);

  const createText = async () => {
    if (!name.trim()) {
      toast.warning('先给素材起个名字');
      return;
    }
    setCreating(true);
    try {
      await materialApi.create({ name: name.trim(), text });
      notifySuccess('文字素材已保存');
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
    notifySuccess('素材已删除');
    void materials.reload();
  };

  const columns: ColumnsType<MaterialOut> = [
    {
      title: '预览',
      dataIndex: 'id',
      width: 72,
      render: (_: string, record) => (
        <MaterialThumb materialId={record.id} kind={record.kind} alt={record.name} />
      ),
    },
    { title: '名称', dataIndex: 'name', width: 180 },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 90,
      render: (kind: MaterialKind, record) => <Tag color={KIND_COLORS[kind]}>{record.kind_label}</Tag>,
    },
    {
      title: '内容',
      dataIndex: 'text',
      ellipsis: true,
      render: (value: string, record) => value || record.original_name || <span className="tg-muted">—</span>,
    },
    {
      title: '大小',
      dataIndex: 'size_bytes',
      width: 90,
      render: (value: number) => (value ? formatNumber(value) : <span className="tg-muted">—</span>),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 170, render: (value: string) => formatTime(value) },
    {
      title: '操作',
      width: 130,
      render: (_, record) => (
        <Space>
          {record.kind !== 'text' ? (
            <a href={materialApi.downloadUrl(record.id)} target="_blank" rel="noreferrer">
              下载
            </a>
          ) : null}
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => void remove(record)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
      <Card size="small" title="新建文字素材">
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="素材名（便于识别，例如：八月活动话术）"
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{ width: 240 }}
          />
          <Input.TextArea
            placeholder="要发送的文字（批量私信 / 群发 / 吵群都会用到）"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={() => void createText()}>
            保存
          </Button>
        </Space.Compact>
      </Card>
      <Card size="small" title="上传媒体素材（图片 / 视频 / 文件，最大 20MB）">
        <Upload.Dragger
          multiple={false}
          showUploadList={false}
          customRequest={async (options) => {
            const file = options.file as File;
            const baseName = file.name.replace(/\.[^.]+$/, '');
            try {
              await materialApi.upload(baseName, file);
              notifySuccess(`「${baseName}」已上传`);
              void materials.reload();
            } catch {
              /* client 已统一提示 */
            }
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到这里上传</p>
          <p className="ant-upload-hint">素材名取文件名；发送时可在素材群发里配说明文字</p>
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
  const materials = useAsyncData(() => materialApi.list({ page: 1, page_size: 100 }), []);
  return (
    <Select
      {...props}
      placeholder="选择素材"
      loading={materials.loading}
      options={(materials.data?.items ?? []).map((item) => ({
        label: `${item.name}（${item.kind_label}）`,
        value: item.id,
      }))}
    />
  );
}

// ---------------------------------------------------------------- 批次进度

function BatchesTab() {
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
    { title: '账号', dataIndex: 'account_label', width: 140 },
    { title: '任务类型', dataIndex: 'type_label', width: 110 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string, record) => (
        <StatusBadge status={value as AccountStatus} label={record.status_label} size="sm" />
      ),
    },
    { title: '尝试', dataIndex: 'attempts', width: 60 },
    {
      title: '进度',
      dataIndex: 'stage',
      width: 230,
      render: (value: string, record) => {
        if (!record.total) return <span className="tg-muted">—</span>;
        return (
          <Tooltip title={record.detail || value || ''}>
            <span className="tg-mono">
              {record.wave_total ? `第 ${(record.wave_index ?? 0) + 1}/${record.wave_total} 轮 · ` : ''}
              已加 {record.joined ?? 0}/{record.total} · 已发 {record.sent ?? 0}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: '失败原因',
      dataIndex: 'error',
      ellipsis: true,
      render: (value: string) => value || <span className="tg-muted">—</span>,
    },
  ];

  const columns: ColumnsType<CampaignBatchOut> = [
    {
      title: '批次',
      dataIndex: 'batch_id',
      width: 220,
      render: (value: UUID) => <span className="tg-mono">{value.slice(0, 8)}…</span>,
    },
    { title: '提交时间', dataIndex: 'created_at', width: 170, render: (value: string) => formatTime(value) },
    { title: '任务数', dataIndex: 'total', width: 80 },
    {
      title: '状态分布',
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
      title: '操作',
      width: 160,
      render: (_, record) => (
        <Space>
          <Button size="small" loading={detailLoading} onClick={() => void openDetail(record.batch_id)}>
            详情
          </Button>
          <Button size="small" danger onClick={() => void cancel(record.batch_id)}>
            取消
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
      <Space>
        <Button icon={<ReloadOutlined />} onClick={() => void batches.reload()}>
          刷新
        </Button>
        <Typography.Text type="secondary">执行中的吵群 / 拟人任务会随每轮发言实时更新进度</Typography.Text>
      </Space>
      <Table<CampaignBatchOut>
        size="small"
        rowKey="batch_id"
        columns={columns}
        dataSource={batches.data?.items ?? []}
        loading={batches.loading}
        pagination={{ pageSize: 20, size: 'small', showTotal: (total) => `共 ${total} 批` }}
      />
      {detail ? (
        <Card
          size="small"
          title={`批次 ${detail.batch_id} · ${formatTime(detail.created_at ?? '')} · 共 ${detail.total} 条任务`}
          extra={
            <Button size="small" danger onClick={() => void cancel(detail.batch_id)}>
              取消未完成任务
            </Button>
          }
        >
          <Table<CampaignBatchItem>
            size="small"
            rowKey="task_id"
            columns={itemColumns}
            dataSource={detail.items}
            pagination={{ pageSize: 10, size: 'small' }}
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
  const navigate = useNavigate();
  const accounts = useAsyncData(() => accountApi.list({ page: 1, page_size: 200 }), []);
  // null = 还没初始化（首次加载后默认全选）；[] = 用户主动清空
  const [selected, setSelected] = useState<string[] | null>(null);
  // 默认自动挑号：按健康分优先从可用号里选，不用手动勾
  const [autoAccounts, setAutoAccounts] = useState(true);
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
  const [groupPage, setGroupPage] = useState(1);
  // 跨分页保留选择：tg_chat_id → 可直接使用的链接（邀请链接优先，公开群用 @用户名）
  const [pickedGroups, setPickedGroups] = useState<Record<string, string>>({});

  const groups = useAsyncData(
    () =>
      pickerOpen
        ? groupIntelApi.profiles({
            q: groupKeyword || undefined,
            speakable: true,
            page: groupPage,
            page_size: 20,
          })
        : Promise.resolve(null),
    [pickerOpen, groupKeyword, groupPage],
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
      title: '账号',
      dataIndex: 'display_label',
      render: (value: string, record) => value || record.phone_masked,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (value: AccountStatus, record) => (
        <StatusBadge status={value} label={record.status_label} size="sm" />
      ),
    },
    { title: '健康分', dataIndex: 'health_score', width: 76 },
    {
      title: '分组',
      dataIndex: 'group_name',
      width: 110,
      render: (value: string) => value || <span className="tg-muted">—</span>,
    },
    { title: '群数', dataIndex: 'group_count', width: 64 },
    {
      title: '执行状态',
      width: 300,
      render: (_, record) => {
        const item = progressByAccount.get(record.id);
        if (!item) {
          return <span className="tg-muted">{record.current_task_label || '待提交'}</span>;
        }
        const progress = item.total ? `已加 ${item.joined ?? 0}/${item.total} · 已发 ${item.sent ?? 0}` : '';
        return (
          <span className="tg-stack" style={{ gap: 2 }}>
            <Space size={6} wrap>
              <Tag color={TASK_STATUS_COLOR[item.status] ?? 'default'}>{item.status_label}</Tag>
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
      title: '群',
      dataIndex: 'title',
      render: (value: string, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <span>{value || '未命名群'}</span>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {record.username ? `@${record.username}` : record.tg_chat_id}
          </span>
        </span>
      ),
    },
    {
      title: '成员',
      dataIndex: 'member_count',
      width: 90,
      render: (value: number | null) => (value ? formatNumber(value) : '—'),
    },
    {
      title: '发言',
      dataIndex: 'send_permission',
      width: 90,
      render: (value: string | null) =>
        value === 'open' ? (
          <Tag color="green">可发言</Tag>
        ) : (
          <Tag>{value === 'restricted' ? '禁言' : '未校验'}</Tag>
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
      toast.warning('选中的群既没有邀请链接，也没有公开用户名');
      return;
    }
    const merged = Array.from(new Set([...splitField(form.getFieldValue('targets')), ...links]));
    form.setFieldValue('targets', merged.join('\n'));
    setPickedGroups({});
    setPickerOpen(false);
  };

  const onFinish = async (values: Record<string, unknown>) => {
    if (!autoAccounts && !picked.length) {
      toast.warning('先在账号表里勾选至少一个号，或打开「自动挑选账号」');
      return;
    }
    const targets = splitField(values.targets);
    if (!targets.length) {
      toast.warning('至少填一个群链接');
      return;
    }
    const text = String(values.text ?? '').trim();
    const materialId = (values.material_id as string | undefined) ?? null;
    if (mode === 'material' && !materialId) {
      toast.warning('素材模式要先选一个素材');
      return;
    }
    if (mode === 'text' && !text) {
      toast.warning('写一段要发布的内容');
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
      dispatch: 'each',
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
              <h2 className="tg-section-title">内容与目标群</h2>
              <span className="tg-section-note">先写发什么，再挑群；提交后每个号逐群执行</span>
            </div>
            <div className="tg-form-grid">
              <div>
                <div className="tg-form-group-title">发布内容</div>
                <Segmented
                  value={mode}
                  onChange={(next) => setMode(next as 'text' | 'material')}
                  options={[
                    { label: '文本', value: 'text' },
                    { label: '素材', value: 'material' },
                  ]}
                />
                {mode === 'text' ? (
                  <Form.Item name="text" style={{ marginTop: 'var(--tg-space-sm)' }}>
                    <Input.TextArea
                      placeholder="进群后发送这段话；每个号发同一段"
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
                    <Form.Item label="配文（可选）" name="text">
                      <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
                    </Form.Item>
                  </>
                )}
              </div>
              <div>
                <div className="tg-form-group-title">目标群</div>
                <Space wrap style={{ marginBottom: 'var(--tg-space-sm)' }}>
                  <Button size="small" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>
                    从群情报选可发言群
                  </Button>
                  <span className="tg-muted">一行一个，最多 100 个</span>
                </Space>
                <Form.Item name="targets" rules={[{ required: true, message: '至少一个群链接' }]}>
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
                label: '节奏与验证（已按保守值预设，通常不用改）',
                children: (
                  <div className="tg-form-grid">
                    <Form.Item label="群间最小间隔（秒）" name="join_min_interval">
                      <InputNumber min={5} max={300} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label="群间最大间隔（秒）" name="join_max_interval">
                      <InputNumber min={5} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label="加群后等待（秒）"
                      name="delay_after_join"
                      tooltip="固定等这么久再发言；0 = 用下面的发送间隔"
                    >
                      <InputNumber min={0} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label="发送间隔最小（秒）" name="send_min_interval">
                      <InputNumber min={1} max={60} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item label="发送间隔最大（秒）" name="send_max_interval">
                      <InputNumber min={1} max={120} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label="验证等待（秒）"
                      name="verify_timeout"
                      tooltip="等待入群验证消息的最长时间（佩奇 Cap / NuoMi Turnstile）"
                    >
                      <InputNumber min={30} max={600} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      label="忽略活跃时段"
                      name="ignore_active_hours"
                      valuePropName="checked"
                      tooltip="打开后不受「活跃时段（默认 8-24 点）」限制；熔断与最小间隔照常"
                    >
                      <Switch checkedChildren="立即" unCheckedChildren="按时段" />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />

          <section className="tg-section">
            <div className="tg-section-head">
              <span className="tg-section-bar" />
              <h2 className="tg-section-title">账号与执行状态</h2>
              <span className="tg-section-note">
                自动模式按健康分挑号；轮次跑完一轮才开下一轮，提交后同一张表显示每号进度
              </span>
            </div>
            <div className="tg-form-grid" style={{ marginBottom: 'var(--tg-space-md)' }}>
              <Form.Item label="账号挑选" tooltip="自动：按健康分优先从可用号里挑，不需要手动勾选">
                <Switch
                  checked={autoAccounts}
                  onChange={setAutoAccounts}
                  checkedChildren="自动"
                  unCheckedChildren="手动"
                />
              </Form.Item>
              <Form.Item
                label="每轮账号数"
                name="accounts_per_wave"
                tooltip="例如每轮 100 个号；0 = 全部账号一轮跑完"
              >
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="每号每轮群数"
                name="groups_per_account"
                tooltip="例如 10 = 每个号每轮处理 10 个群；0 = 一个号一次处理全部群"
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="最多使用账号数"
                name="max_accounts"
                tooltip="0 = 不限制；按健康分排序取前 N 个"
              >
                <InputNumber min={0} max={500} style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Space wrap style={{ marginBottom: 'var(--tg-space-md)' }}>
              {autoAccounts ? null : (
                <>
                  <Button size="small" icon={<TeamOutlined />} onClick={() => setSelected(rows.map((item) => item.id))}>
                    全选
                  </Button>
                  <Button size="small" onClick={() => setSelected([])}>
                    清空
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
                刷新账号
              </Button>
              <span className="tg-muted">
                {autoAccounts ? (
                  <>
                    自动挑选：可用{' '}
                    <b>{rows.filter((item) => item.status === 'healthy' || item.status === 'limited').length}</b> 个号
                  </>
                ) : (
                  <>
                    已选 <b>{picked.length}</b> / {rows.length} 个号
                  </>
                )}
              </span>
              {batchId ? (
                <>
                  <Tag color="blue">批次 {batchId.slice(0, 8)}</Tag>
                  <span className="tg-muted">
                    {batch
                      ? `运行 ${batch.counts?.running ?? 0} · 完成 ${batch.counts?.completed ?? 0} · 失败 ${batch.counts?.failed ?? 0}`
                      : '同步中…'}
                  </span>
                  <Button size="small" onClick={() => navigate('/campaigns/batches')}>
                    批次进度
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
              pagination={{ pageSize: 10, size: 'small', showTotal: (total) => `共 ${total} 个号` }}
            />
          </section>
        </div>

        <footer className="tg-submit-dock">
          <Button type="primary" size="large" htmlType="submit" icon={<RocketOutlined />} loading={submitting}>
            提交任务
          </Button>
          <div className="tg-submit-hint">
            <strong>提交即排队</strong>
            <span>按轮次串行执行，每号逐群「加群 → 验证 → 发言」；批次进度页可随时终止</span>
          </div>
        </footer>
      </Form>

      <Modal
        open={pickerOpen}
        title="从群情报选择可发言群"
        width={820}
        okText={`添加 ${Object.keys(pickedGroups).length} 个群`}
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
            placeholder="按关键词筛选群名 / 用户名"
            style={{ width: 300 }}
            onSearch={(value) => {
              setGroupPage(1);
              setGroupKeyword(value);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void groups.reload()}>
            刷新
          </Button>
          <span className="tg-muted">只列「可发言」的讨论组；没有邀请链接时用 @用户名</span>
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
    setMessage(`已保存模板「${name}」`);
  };

  const applyTemplate = (name: string) => {
    form.setFieldsValue(templates[name]);
    setMessage(`已套用模板「${name}」`);
  };

  const removeTemplate = (name: string) => {
    const next = { ...templates };
    delete next[name];
    persist(next);
    setMessage(`已删除模板「${name}」`);
  };

  const names = Object.keys(templates);

  return (
    <div className="tg-template-bar" style={{ gridColumn: '1 / -1' }}>
      <span className="tg-template-label">资料模板</span>
      {names.length === 0 && <span className="tg-template-empty">还没有模板，填好下面内容后点右侧保存</span>}
      {names.map((name) => (
        <span key={name} className="tg-template-chip">
          <button type="button" onClick={() => applyTemplate(name)} title="套用这套资料">
            {name}
          </button>
          <button type="button" className="tg-template-del" onClick={() => removeTemplate(name)} title="删除">
            ×
          </button>
        </span>
      ))}
      {naming ? (
        <span className="tg-template-save">
          <Input
            size="small"
            autoFocus
            placeholder="模板名，例如「印尼号-男」"
            value={draftName}
            style={{ width: 200 }}
            onChange={(event) => setDraftName(event.target.value)}
            onPressEnter={saveCurrent}
          />
          <Button size="small" type="primary" onClick={saveCurrent}>保存</Button>
          <Button size="small" onClick={() => setNaming(false)}>取消</Button>
        </span>
      ) : (
        <Button size="small" onClick={() => setNaming(true)}>＋ 保存当前为模板</Button>
      )}
      {message && <span className="tg-template-msg">{message}</span>}
    </div>
  );
}

/** 节奏预设按钮：靠 Form.useFormInstance 拿到当前表单实例，一键套用整组参数 */
function RhythmPresets() {
  const form = Form.useFormInstance();
  return (
    <div
      className="tg-preset-row"
      /* 这排预设是横向卡片组，必须独占整行；靠 CSS 选择器匹配容易失手，直接写死更稳 */
      style={{ gridColumn: '1 / -1' }}
    >
      <span className="tg-preset-label">一键套用节奏：</span>
      {RHYTHM_PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className="tg-preset-btn"
          title={preset.detail}
          onClick={() => form.setFieldsValue(preset.values)}
        >
          <b>{preset.label}</b>
          <span>{preset.detail}</span>
        </button>
      ))}
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
        notifySuccess('已加入定时队列，可在下方「正在定时」里查看与暂停');
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
          <span className="tg-chip">错峰入队</span>
          <span className="tg-chip tg-chip-soft">Worker 执行</span>
        </div>
      </header>

      <Form form={form} layout="vertical" className="tg-action-form" initialValues={initialValues} onFinish={(values) => void onFinish(values)}>
        <div className="tg-form-body">{children}</div>

        {scheduleAction ? (
          <section className="tg-section">
            <div className="tg-section-head">
              <span className="tg-section-bar" />
              <h2 className="tg-section-title">定时队列</h2>
              <span className="tg-section-note">
                打开后提交不是立刻发，而是每 N 分钟自动跑一批；下方「正在定时」实时显示下次执行时间
              </span>
            </div>
            <div className="tg-flex" style={{ gap: 'var(--tg-space-xl)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Form.Item label="加入定时队列" name="schedule_enabled" valuePropName="checked" initialValue={false}>
                <Switch />
              </Form.Item>
              <Form.Item label="间隔（分钟）" name="schedule_interval" initialValue={30}>
                <InputNumber min={1} max={1440} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item
                label="执行时间窗"
                name="schedule_window"
                tooltip="留空 = 不限；写成 09:00-22:00 时，窗口外的任务会自动顺延到窗口开始再发"
              >
                <Input placeholder="09:00-22:00" style={{ width: 180 }} />
              </Form.Item>
            </div>
          </section>
        ) : null}

        <section className="tg-section">
          <div className="tg-section-head">
            <span className="tg-section-bar" />
            <h2 className="tg-section-title">账号范围</h2>
            <span className="tg-section-note">
              冻结 / 失效 / 停用的号会自动跳过（它们发不出去消息）；检测 / 申诉解封 / 官方养号不受此限制
            </span>
          </div>
          <ScopeFields value={scope} onChange={setScope} />
        </section>

        <footer className="tg-submit-dock">
          <Button type="primary" size="large" htmlType="submit" icon={<RocketOutlined />} loading={submitting}>
            提交任务
          </Button>
          <div className="tg-submit-hint">
            <strong>提交即排队</strong>
            <span>按「一号一任务」错峰入队，由 Worker 执行；进度在「批次进度」页查看与取消</span>
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
        placeholder="选要覆盖的群（可多选）"
        optionFilterProp="label"
        loading={options.loading}
        value={picked}
        onChange={(value: string[]) => setPicked(value)}
        // 宽度自适应卡片（原先 minWidth: 420，比 span3 卡片还宽 → 撑破边框 117px）
        style={{ width: '100%' }}
        options={(options.data ?? []).map((row) => ({
          value: row.value,
          label: `${row.title || row.value}（${row.kind === 'channel' ? '频道·需管理员' : '群'}，${row.account_count} 个号在里面）`,
        }))}
      />
      <Button type="primary" ghost loading={busy} disabled={!picked.length} onClick={() => void run()}>
        让所有号都进这些群
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
      placeholder="从已同步的群里挑（可搜群名 / @用户名）"
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
              全选（{allValues.length}）
            </Button>
            <Button
              type="link"
              size="small"
              disabled={!selected.length}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearAll}
            >
              清空
            </Button>
            <Typography.Text type="secondary">已选 {selected.length} 个</Typography.Text>
          </Space>
          {menu}
        </>
      )}
      options={rows.map((row) => ({
        value: row.value,
        // 频道只有管理员能发言：标出来，不然选完只会收到 ChatAdminRequiredError
        label: `${row.title || row.value}（${row.kind === 'channel' ? '频道·需管理员' : '群'}，${row.account_count} 个号在里面）`,
      }))}
      notFoundContent={options.loading ? '加载中…' : '还没有已同步的群：先去「会话」页把各号的群列表同步一次'}
    />
  );
}

/**
 * 「正在定时」：定时计划列表。
 *
 * 计划到点由服务端调度器展开成任务，这里只做展示与三件事——暂停/启用、立即跑一轮、删掉。
 */
function SchedulePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const schedules = useAsyncData(() => campaignScheduleApi.list(), [refreshKey]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = schedules.data ?? [];

  const toggle = async (row: CampaignScheduleOut) => {
    setBusyId(row.id);
    try {
      await campaignScheduleApi.update(row.id, { enabled: !row.enabled });
      toast.success(row.enabled ? '已暂停，不再自动跑' : '已启用');
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
      notifySuccess('已提交一轮，进度去「批次进度」看');
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
      notifySuccess('计划已删除');
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
        <h2 className="tg-section-title">正在定时</h2>
        <span className="tg-section-note">
          到点自动提交一批（按上面配置的目标 / 文案 / 账号范围）；暂停后不再自动跑，已排队的任务不受影响
        </span>
        <Button size="small" icon={<ReloadOutlined />} loading={schedules.loading} onClick={() => void schedules.reload()}>
          刷新
        </Button>
      </div>

      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有定时计划：上面填好内容，打开「加入定时队列」再提交即可"
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
              <Tag color={row.enabled ? 'green' : 'default'}>{row.enabled ? '定时中' : '已暂停'}</Tag>
              <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>{row.name}</span>
              <span className="tg-muted">{row.action_label}</span>
              <span className="tg-mono tg-muted">{row.target_summary}</span>
              <span className="tg-muted">每 {row.interval_minutes} 分钟</span>
              {row.send_window ? <span className="tg-muted">窗口 {row.send_window}</span> : null}
              <span className="tg-muted">
                下次 {formatTime(row.next_run_at)}
                {row.run_count ? ` · 已跑 ${formatNumber(row.run_count)} 次` : ''}
              </span>
              {row.last_error ? (
                <Tooltip title={row.last_error}>
                  <span className="tg-text-danger tg-clamp-cell" style={{ maxWidth: 220 }}>
                    上次失败：{row.last_error}
                  </span>
                </Tooltip>
              ) : null}
              <Space size={8} style={{ marginLeft: 'auto' }}>
                <Button size="small" loading={busyId === row.id} onClick={() => void toggle(row)}>
                  {row.enabled ? '暂停' : '启用'}
                </Button>
                <Button size="small" type="primary" ghost loading={busyId === row.id} onClick={() => void runNow(row)}>
                  立即执行
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
    key: 'safe',
    label: '保守养号',
    detail: '新号 / 刚解封的号用这套：间隔长、白天发、每天少发',
    values: { min_interval: 25, max_interval: 70, send_window: '10:00-22:00', daily_quota: 20 },
  },
  {
    key: 'normal',
    label: '标准推广',
    detail: '日常批量默认值：中等间隔、全天主要时段、每号每天 50 条',
    values: { min_interval: 8, max_interval: 25, send_window: '09:00-23:00', daily_quota: 50 },
  },
  {
    key: 'fast',
    label: '快速触达',
    detail: '老号 / 急需铺量：间隔短、白天全时段、每号每天 120 条（风险自负）',
    values: { min_interval: 3, max_interval: 10, send_window: '08:00-24:00', daily_quota: 120 },
  },
  {
    key: 'unlimited',
    label: '不限时段',
    detail: '配合已有配额的号源：清掉时间窗与配额限制，交给节流自己管',
    values: { min_interval: 3, max_interval: 8, send_window: '', daily_quota: 0 },
  },
];

export default function Campaigns() {
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
    { key: 'materials', label: '素材库', children: <MaterialsTab /> },
    {
      key: 'join-send',
      label: '加群群发',
      children: <JoinAndSendTab initialTargets={syncedJoinTargets} />,
    },
    {
      key: 'bulk-pm',
      label: '批量私信',
      children: (
        <ActionTab
          title="批量私信"
          description="一批号各向目标逐个发消息；文本池给多条时按账号顺序分配给不同号，说的话不重样。目标支持 @用户名、手机号或数字用户 ID，一行一个或逗号分隔。"
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
          <div className="tg-form-group-title">内容：发什么、发给谁</div>
          <Form.Item label="私信目标" name="targets" rules={[{ required: true, message: '至少一个目标' }]}>
            <Input.TextArea placeholder="@user1\n@user2\n+12025550143" autoSize={{ minRows: 3, maxRows: 6 }} style={{ maxWidth: '100%' }} />
          </Form.Item>
          <Form.Item label="文本（所有号同一句）" name="text">
            <Input.TextArea placeholder="填了统一文本就忽略文本池" autoSize={{ minRows: 3, maxRows: 4 }} style={{ maxWidth: '100%' }} />
          </Form.Item>
          <Form.Item label="文本池（按账号取模分配，每行一条）" name="texts">
            <Input.TextArea placeholder="第一号发这句\n第二号发这句\n…" autoSize={{ minRows: 3, maxRows: 6 }} style={{ maxWidth: '100%' }} />
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
          <div className="tg-form-group-title">节奏与配额</div>
          <RhythmPresets />
          <div className="tg-form-grid">
            <Form.Item label="目标间最小间隔（秒）" name="min_interval" initialValue={3}>
              <InputNumber min={1} max={60} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="最大间隔（秒）" name="max_interval" initialValue={8}>
              <InputNumber min={1} max={120} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              label="文字格式（富文本）"
              name="parse_mode"
              tooltip="Markdown：**加粗**、> 引用、`代码`；HTML：<b>加粗</b>。留空 = 纯文本"
            >
              <Select
                style={{ width: '100%' }}
                allowClear
                placeholder="纯文本"
                options={[
                  { value: 'md', label: 'Markdown（加粗 / 引用 / 代码块）' },
                  { value: 'html', label: 'HTML（<b> 等标签）' },
                ]}
              />
            </Form.Item>
            <Form.Item
              label="转发模式（可选）"
              className="tg-pm-forward"
              tooltip="填了来源会话与消息 id 就转发那条消息，而不是发文本；勾上隐藏来源则不显示原频道署名"
            >
              <Space size="small" wrap>
                <Form.Item name="forward_from_chat_id" noStyle>
                  <InputNumber placeholder="来源 chat_id（-100...）" style={{ width: 210 }} />
                </Form.Item>
                <Form.Item name="forward_from_message_id" noStyle>
                  <InputNumber placeholder="消息 id" style={{ width: 130 }} />
                </Form.Item>
                <Form.Item name="drop_author" valuePropName="checked" noStyle>
                  <Checkbox>隐藏转发来源</Checkbox>
                </Form.Item>
              </Space>
            </Form.Item>
            <Form.Item
              label="发送时间窗（定时）"
              name="send_window"
              className="tg-pm-num"
              tooltip="只在这个时间段内发；不在窗内会自动顺延到窗口开始，不用手动掐点。留空 = 不限"
            >
              <Input placeholder="09:00-23:00（留空 = 不限）" allowClear />
            </Form.Item>
            <Form.Item
              label="每号每日配额（定量）"
              name="daily_quota"
              className="tg-pm-num"
              tooltip="每个号每天最多发多少条，超了自动顺延到次日。0 = 不限"
            >
              <InputNumber min={0} max={2000} style={{ width: '100%' }} placeholder="0 = 不限" />
            </Form.Item>
            <Form.Item
              label="口语化微调"
              name="naturalize"
              valuePropName="checked"
              initialValue={false}
              className="tg-field-switch"
              tooltip="在文本里做轻微改写（同义替换、标点变化），让不同号发出去的话不完全一样"
            >
              <Switch />
            </Form.Item>
          </div>
          <div className="tg-form-group-title">发送通道</div>
          <div className="tg-form-grid">
            <Form.Item
              label="用谁发"
              name="via_bot"
              initialValue={false}
              className="tg-pm-via"
              tooltip="用 Bot 发：不占账号每日配额、不受账号冻结影响；但 Telegram 规定 Bot 只能给**和它交互过**的用户发私信，陌生目标会失败"
            >
              <Segmented
                block
                options={[
                  { label: '用账号私信', value: false },
                  { label: '用 Bot 私信', value: true },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.via_bot !== next.via_bot}>
              {({ getFieldValue }) =>
                getFieldValue('via_bot') ? (
                  <Form.Item label="选择 Bot（必填）" name="bot_id" className="tg-pm-bot">
                    <Select
                      placeholder="选一个已配置的 Bot"
                      options={(bots.data ?? []).map((item: { id: string; name: string; bot_username?: string | null }) => ({
                        value: item.id,
                        label: `@${item.bot_username || item.name}`,
                      }))}
                      notFoundContent="还没有配置 Bot"
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </div>

          <div className="tg-form-group-title">执行方式</div>
          <div className="tg-form-grid">
            <Form.Item
              label="分发方式"
              name="dispatch"
              initialValue="each"
              className="tg-pm-dispatch"
            tooltip="轮询分配：目标按账号轮流切分，一个目标只由一个号处理——多号并行分摊，互不重复打扰"
          >
            <Segmented
              options={[
                { label: '每个号都发一遍', value: 'each' },
                { label: '按账号轮询分配目标', value: 'round_robin' },
              ]}
            />
            </Form.Item>
            <Form.Item
              label="无号时自动补号"
              name="auto_supply"
              valuePropName="checked"
              className="tg-field-switch tg-pm-supply"
              tooltip="可用的号不够承担这批目标时，自动从号池补状态正常的号；补进来的号同样受配额与节流约束"
            >
              <Switch />
            </Form.Item>
          </div>
        </ActionTab>
      ),
    },
    {
      key: 'broadcast',
      label: '群发',
      children: (
        <ActionTab
          title="批量群发"
          description="一批号各向指定群发一条。目标群支持 @用户名、数字群 ID 或已同步的会话 ID。"
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
          <Form.Item label="文本（所有号同一句）" name="text" className="tg-bc-text">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} />
          </Form.Item>
          <Form.Item label="文本池（按账号取模分配，每行一条）" name="texts" className="tg-bc-text">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} />
          </Form.Item>
          <Form.Item
            label="目标群（可多选）"
            name="target_groups"
            className="tg-bc-target"
            rules={[{ required: true, message: '至少选一个群' }]}
            tooltip="列表来自各号已同步的会话；括号里的数字是「这个群里有几个号能发」——提交只会派给这些号"
          >
            <GroupPicker />
          </Form.Item>
          <Form.Item
            label="口语化微调"
            name="naturalize"
            valuePropName="checked"
            initialValue={false}
            className="tg-bc-toggle"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="只发给群成员"
            name="only_members"
            valuePropName="checked"
            initialValue={true}
            className="tg-bc-toggle"
            tooltip="提交时自动过滤掉「不在这个群里」的号——它们发出去只会失败，还白占队列、多挨一次限流"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="忽略活跃时段"
            name="ignore_active_hours"
            valuePropName="checked"
            initialValue={false}
            className="tg-bc-toggle"
            tooltip="打开后不受「活跃时段（默认 8-24 点）」限制，凌晨也立即发；最小间隔 / 每日配额 / 熔断照常"
          >
            <Switch checkedChildren="立即" unCheckedChildren="按时段" />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'material-send',
      label: '素材群发',
      children: (
        <ActionTab
          title="素材群发"
          description="把素材库里的文字或媒体发给目标：填目标群就发到群里；填私信目标则逐个私信。"
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
          <Form.Item label="素材" name="material_id" className="tg-field-line" rules={[{ required: true, message: '先到素材库建一条' }]}>
            <MaterialSelect />
          </Form.Item>
          <Form.Item label="目标群（二选一）" name="target_group" className="tg-field-line">
            <Input placeholder="@用户名 / 群 ID / 会话 ID" />
          </Form.Item>
          <Form.Item label="私信目标（二选一，每行一个）" name="targets" className="tg-field-line">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Space wrap className="tg-mat-intervals">
            <Form.Item label="最小间隔（秒）" name="min_interval" initialValue={3}>
              <InputNumber min={1} max={60} />
            </Form.Item>
            <Form.Item label="最大间隔（秒）" name="max_interval" initialValue={8}>
              <InputNumber min={1} max={120} />
            </Form.Item>
          </Space>
          <Form.Item
            label="分发方式"
            name="dispatch"
            initialValue="each"
            className="tg-mat-dispatch"
            tooltip="轮询分配：目标列表按账号轮流切分，多号并行分摊，互不重复"
          >
            <Segmented
              options={[
                { label: '每个号都发一遍', value: 'each' },
                { label: '按账号轮询分配目标', value: 'round_robin' },
              ]}
            />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'join',
      label: '加群',
      children: (
        <ActionTab
          title="批量加群"
          description="一批号加入一个或多个群：邀请链接（t.me/+...）或 @公开群用户名，一行一个。已加入的自动跳过；群多时可选「按账号轮询分配」，让每个号分头进不同的群。"
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
            label="补齐覆盖（让所有号都进这些群）"
            className="tg-join-cover"
            tooltip="按「哪些号在哪些群」自动算差集：已经在群里的号跳过，只给缺的号排加群任务；一个号一条任务，群与群之间按 20–60 秒间隔慢慢加"
          >
            <JoinMissingPanel />
          </Form.Item>
          <Form.Item
            label="邀请链接或公开群（一行一个，可批量）"
            name="targets"
            rules={[{ required: true, message: '至少填一个群' }]}
          >
            <Input.TextArea
              placeholder={'t.me/+AbCdEfGh1234\n@public_group\nt.me/another_group'}
              autoSize={{ minRows: 3, maxRows: 10 }}
            />
          </Form.Item>
          <Form.Item
            label="分发方式"
            name="dispatch"
            initialValue="each"
            className="tg-join-dispatch"
            tooltip="轮询分配：群按账号轮流切分，一个群只由一个号去加——避免所有号同时挤进同一个群"
          >
            <Segmented
              options={[
                { label: '每个号都加全部群', value: 'each' },
                { label: '按账号轮询分配群', value: 'round_robin' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="自动过入群验证"
            name="auto_verify"
            valuePropName="checked"
            initialValue
            className="tg-field-switch"
            tooltip="识别佩奇(Cap) / NuoMi(Turnstile) 等验证机器人，自动打开浏览器完成验证，再回查能否发言确认放行；失败会自动退群重进重试（每个号在每个群原本只有一次验证机会，退群重进可重置）"
          >
            <Switch checkedChildren="自动过" unCheckedChildren="跳过" />
          </Form.Item>
          <Form.Item
            label="验证等待时长（秒）"
            name="verify_timeout"
            initialValue={150}
            tooltip="等验证机器人发来验证消息的最长时间。验证链接寿命很短（NuoMi 60 秒、佩奇 300 秒），设太长没有意义"
          >
            <InputNumber min={30} max={600} step={30} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            label="忽略活跃时段"
            name="ignore_active_hours"
            valuePropName="checked"
            initialValue={false}
            className="tg-field-switch"
            tooltip="默认只在本地 08:00–24:00 执行加群，避开凌晨批量操作这种机器特征；打开后凌晨也立即执行，熔断 / 最小间隔 / 每日配额仍然生效"
          >
            <Switch checkedChildren="立即" unCheckedChildren="按时段" />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'leave',
      label: '退群',
      children: (
        <ActionTab
          title="批量退群"
          description="一批号退出一个或多个群，一行一个。支持 @用户名、数字群 ID 或会话 ID；群多时可选「按账号轮询分配」，让每个号分头退不同的群。"
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
            label="要退的群（一行一个，可批量）"
            name="targets"
            className="tg-leave-targets tg-field-line"
            rules={[{ required: true, message: '至少一个群' }]}
          >
            <Input.TextArea placeholder={'@group_a\n-1001234567890\nt.me/group_c'} autoSize={{ minRows: 3, maxRows: 10 }} />
          </Form.Item>
          {/* 顺序调整：开关挪到分发方式之前，三者正好排满一行（6+2+4 列），并一起拉伸等高 */}
          <Form.Item
            label="退出后删除该会话记录"
            name="delete_history"
            valuePropName="checked"
            initialValue={true}
            className="tg-field-switch tg-field-line"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="分发方式"
            name="dispatch"
            initialValue="each"
            className="tg-leave-dispatch tg-field-line"
            tooltip="轮询分配：群按账号轮流切分，一个群只由一个号去退"
          >
            <Segmented
              options={[
                { label: '每个号都退全部群', value: 'each' },
                { label: '按账号轮询分配群', value: 'round_robin' },
              ]}
            />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'force-add',
      label: '强拉进群',
      children: (
        <ActionTab
          title="强拉进群"
          description="把成员拉进一个或多个目标群。执行号必须是这些群的管理员（普通群需成员为执行号的联系人）。成员：@用户名、手机号或数字用户 ID，每行一个，最多 50。"
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
          <Form.Item label="目标群（一行一个，可批量）" name="groups" rules={[{ required: true, message: '至少一个群' }]}>
            <Input.TextArea placeholder={'@group_a\n-1001234567890'} autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
          <Form.Item label="要拉进的成员（每行一个）" name="members" rules={[{ required: true, message: '至少一个成员' }]}>
            <Input.TextArea placeholder="@user1\n@user2" autoSize={{ minRows: 3, maxRows: 8 }} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'profile',
      label: '批量改资料',
      children: (
        <ActionTab
          title="批量改资料"
          description="一批号改名 / 简介 / 用户名 / 头像。文字框里写一行=所有号统一改成它，写多行=当成候选池，每个号拿不同的值（避免一批号资料完全一样）。留空的字段不改。可把整套配置存成模板，下次一键套用。"
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
            <Form.Item label="名字（多行=候选池）" name="first_name">
              <Input.TextArea placeholder={'David\nAlex\n小林'} autoSize={{ minRows: 2, maxRows: 6 }} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label="姓氏（多行=候选池）" name="last_name">
              <Input.TextArea placeholder={'Chen\nWang\nLi'} autoSize={{ minRows: 2, maxRows: 6 }} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item
              label="固定用户名（@ 后面部分）"
              name="username"
              tooltip="直接填用户名即可；带 @ 或 t.me 链接会被自动清洗。规则：5-32 位，字母/数字/下划线，以字母开头"
            >
              <Input placeholder="例如 woieduanai（@ 会自动去掉）" style={{ width: 240 }} />
            </Form.Item>
          </Space>
          <Form.Item label="简介（多行=候选池）" name="bio" className="tg-pf-bio">
            <Input.TextArea
              placeholder={'第一句简介\n第二句简介\n第三句简介'}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
          </Form.Item>
          <Space wrap align="start" className="tg-pf-lines">
            <Form.Item
              label="用户名前缀（推荐）"
              name="username_prefix"
              tooltip="用户名全局唯一，批量时用「前缀 + 随机数字」，每个号自动生成不撞名"
            >
              <Input placeholder="例如 user_" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label="随机数字位数" name="username_random_digits" initialValue={4}>
              <InputNumber min={2} max={8} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item
              label="池化取值方式"
              name="assign_mode"
              initialValue="sequence"
              tooltip="按号顺序：同批号轮流取池里的值，互不重复；随机：每个号随机取一个"
            >
              <Segmented
                options={[
                  { label: '按号顺序', value: 'sequence' },
                  { label: '随机', value: 'random' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            label="头像（推荐从素材库选）"
            name="photo_material_id"
            className="tg-pf-photo"
            tooltip="直接选素材库里的图片；也可以改下面的地址字段，二选一"
          >
            <MaterialPicker kinds={['photo']} placeholder="从素材库选一张图片（可选）" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="或填头像图片地址" name="photo_url">
            <Input placeholder="https://…/avatar.jpg" style={{ maxWidth: 420 }} />
          </Form.Item>
        </ActionTab>
      ),
    },
    {
      key: 'storm',
      label: '吵群',
      children: (
        <ActionTab
          title="吵群"
          description="一批号在同一个群里按随机间隔轮流发文本池里的话（每轮随机挑一句），可配置每轮回复群内最近消息的概率。总时长 = 轮数 × 最大间隔，不能超过 25 分钟。"
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
          <Form.Item label="目标群" name="group" className="tg-field-line" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="@用户名 或 群 ID" />
          </Form.Item>
          <Form.Item label="文本池（每轮随机挑一句，每行一条）" name="texts" className="tg-field-line" rules={[{ required: true, message: '至少一句' }]}>
            <Input.TextArea placeholder="这句不错\n顶一下\n有道理" autoSize={{ minRows: 4, maxRows: 8 }} />
          </Form.Item>
          <Space wrap className="tg-storm-params">
            <Form.Item label="每个号发几轮" name="rounds" initialValue={5}>
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item label="最小间隔（秒）" name="min_interval" initialValue={8}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label="最大间隔（秒）" name="max_interval" initialValue={30}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label="回复群内最近消息的概率" name="reply_probability" initialValue={0}>
              <InputNumber min={0} max={1} step={0.1} />
            </Form.Item>
          </Space>
        </ActionTab>
      ),
    },
    {
      key: 'persona',
      label: '拟人发言',
      children: (
        <ActionTab
          title="拟人发言"
          description="一批号按人设连续发言：每轮看群里最近消息，用 AI 生成符合人设的话；AI 未配置或失败时自动退回备用文本池。"
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
          <Form.Item label="目标群" name="group" className="tg-field-line" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="@用户名 或 群 ID" />
          </Form.Item>
          <Form.Item label="人设（给 AI 的角色设定）" name="persona" className="tg-field-line" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea
              placeholder="例：你是 25 岁的数码爱好者，说话随意、爱用短句和网络词，偶尔吐槽。"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Form.Item label="话题（可选）" name="topic" className="tg-field-line">
            <Input placeholder="不给就看群里在聊什么" />
          </Form.Item>
          <Form.Item label="AI 不可用时的备用文本池（每行一条）" name="texts" className="tg-persona-texts">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
          </Form.Item>
          <Space wrap className="tg-persona-params">
            <Form.Item label="使用 AI 生成" name="use_ai" valuePropName="checked" initialValue={true} className="tg-field-switch">
              <Switch />
            </Form.Item>
            <Form.Item label="每个号发几轮" name="rounds" initialValue={5}>
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item label="最小间隔（秒）" name="min_interval" initialValue={10}>
              <InputNumber min={3} max={120} />
            </Form.Item>
            <Form.Item label="最大间隔（秒）" name="max_interval" initialValue={40}>
              <InputNumber min={3} max={120} />
            </Form.Item>
          </Space>
        </ActionTab>
      ),
    },
    { key: 'batches', label: '批次进度', children: <BatchesTab /> },
  ].filter((item) => VISIBLE_SECTIONS.has(item.key));

  const current = sections.find((item) => item.key === section);
  if (section && !current) return <Navigate to="/campaigns/materials" replace />;
  const active = current ?? sections[0];

  return (
    <PageContainer
      title={active.label}
      description="批量运营：提交后按「一 号一任务」错峰入队，由 Worker 执行；进度与取消在「批次进度」页。左侧「触达中心」子菜单可切换功能。"
      actions={
        <Select
          size="small"
          style={{ width: 176 }}
          value={active.key}
          onChange={(key) => navigate(`/campaigns/${key}`)}
          options={sections.map((item) => ({ value: item.key, label: item.label }))}
          aria-label="切换触达中心功能"
        />
      }
    >
      {active.children}
    </PageContainer>
  );
}
