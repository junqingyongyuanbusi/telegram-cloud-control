/**
 * 群情报（无感采集）：左边的群档案列表 + 右侧选中群的成员名单与入退群事件流。
 *
 * 采集是只读的：只调 GetFullChannel / GetParticipants，不发消息、不回应、不加群。
 * 入群/退群流水本身由 Worker 事件监听被动记录，这里只负责「看」和「手动补采」。
 */
import { useEffect, useState } from 'react';
import KeywordWatchPanel from '../features/group/KeywordWatchPanel';
import ReplyRulePanel from '../features/group/ReplyRulePanel';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Select,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AimOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CommentOutlined,
  FileZipOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Progress } from 'antd';
import { PageContainer, StatCard, StatGrid, RelativeTime, SoftTag, CopyableText } from '../components';
import { notifyError, toast } from '../utils/feedback';
import { downloadBlob, filenameFromDisposition } from '../utils/download';
import BulkResultModal from '../features/accounts/BulkResultModal';
import { groupIntelApi } from '../api/endpoints';
import { useAsyncData, useInterval } from '../hooks/useAsyncData';
import { notifySuccess } from '../utils/feedback';
import type {
  BulkResultOut,
  CollectJob,
  DiscoveryLeadOut,
  GroupEventOut,
  GroupMemberOut,
  GroupProfileOut,
  GroupSearchMatchOut,
  PreciseBatchOut,
  UnverifiedCandidateOut,
} from '../api/types';

const KIND_LABEL: Record<string, string> = {
  group: '普通群',
  megagroup: '超级群',
  channel: '频道',
  chat: '群聊',
};

const SEND_LABEL: Record<string, { text: string; color?: string }> = {
  open: { text: '可发言', color: 'green' },
  restricted: { text: '禁言', color: 'red' },
  unknown: { text: '未校验' },
};

const SOURCE_LABEL: Record<string, string> = {
  contacts_search: '原生搜索',
  global_message_search: '消息反查',
  short_query: '短词召回',
  linked_chat: '频道讨论群',
  channel_recommendation: '相似推荐',
  channel_message_link: '频道外链',
  joined_group_graph: '已入群图谱',
  candidate_link: '人工候选链接',
  tme_preview: 't.me公开页',
  external_web: '外部网页/目录',
  channel_posts: '频道帖子搜索',
  common_chat_graph: '共同群扩展',
  local_index: '本地历史群库',
  // 兼容历史记录中的旧短键
  contacts: '原生搜索',
  short_core: '短词兜底',
  message_search: '消息反查',
  joined_dialog: '已入群',
  joined_link: '已入群内链',
  recommendation: '相似推荐',
  channel_link: '频道外链',
  web_candidate: '外部候选',
};

function extractCandidateLinks(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (val: string) => {
    const key = val.toLowerCase();
    if (!seen.has(key) && out.length < 200) {
      seen.add(key);
      out.push(val);
    }
  };
  const inviteRe = /(?:https?:\/\/)?(?:www\.)?t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]{8,})/gi;
  const userRe = /(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})/gi;
  const mentionRe = /(?:^|[\s,，;；(（])@([A-Za-z][A-Za-z0-9_]{3,31})/g;
  for (const m of raw.matchAll(inviteRe)) push(`https://t.me/+${m[1]}`);
  for (const m of raw.matchAll(userRe)) {
    const u = m[1].toLowerCase();
    if (u !== 'joinchat' && u !== 'addstickers' && u !== 'share' && u !== 'proxy') {
      push(`https://t.me/${m[1]}`);
    }
  }
  for (const m of raw.matchAll(mentionRe)) push(`@${m[1]}`);
  return out;
}

export default function GroupIntel() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [speakableOnly, setSpeakableOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<GroupProfileOut | null>(null);
  // 采集群内对话：成员名单被群主隐藏时，靠「谁发过言」来淘成员
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgDays, setMsgDays] = useState(7);
  const [msgExcludeAdmins, setMsgExcludeAdmins] = useState(false);
  const [msgIncludeBots, setMsgIncludeBots] = useState(false);
  const [msgLimit, setMsgLimit] = useState(1000);
  const [msgKeywords, setMsgKeywords] = useState('');
  // 按关键词找群：走 Telegram 原生搜索，结果直接落进群档案
  const [findOpen, setFindOpen] = useState(false);
  const [findBusy, setFindBusy] = useState(false);
  const [findKeywords, setFindKeywords] = useState('');
  const [findPer, setFindPer] = useState(50);
  const [findMinMembers, setFindMinMembers] = useState(500);
  const [findKind, setFindKind] = useState<'any' | 'group' | 'channel'>('group');
  // 查询扩展：地区 + 语言 + linked_chat；留空则保持旧行为（只搜原始关键词）
  const [findRegions, setFindRegions] = useState<string[]>([]);
  const [findLanguages, setFindLanguages] = useState<string[]>([]);
  const [findExpandLinked, setFindExpandLinked] = useState(true);
  // 第二步结果扩展：消息链接 / 相似推荐 / t.me 富化（都只读）
  const [findExpandMessages, setFindExpandMessages] = useState(true);
  const [findExpandRecommendations, setFindExpandRecommendations] = useState(true);
  const [findEnrichTme, setFindEnrichTme] = useState(true);
  // 精准检索：多源召回 + 近 3 个月活跃/可发言校验
  const [preciseOpen, setPreciseOpen] = useState(false);
  const [preciseBusy, setPreciseBusy] = useState(false);
  const [preciseKeywords, setPreciseKeywords] = useState('');
  const [preciseCountry, setPreciseCountry] = useState<string | undefined>('TH');
  const [preciseLanguages, setPreciseLanguages] = useState<string[]>(['th', 'en']);
  const [preciseFullLimit, setPreciseFullLimit] = useState(60);
  const [preciseContactsSearch, setPreciseContactsSearch] = useState(true);
  const [preciseContactsLimit, setPreciseContactsLimit] = useState(120);
  const [preciseGlobalMessages, setPreciseGlobalMessages] = useState(true);
  const [preciseMessageQueries, setPreciseMessageQueries] = useState(5);
  const [preciseMessagePages, setPreciseMessagePages] = useState(2);
  const [preciseShortQueries, setPreciseShortQueries] = useState(true);
  const [preciseShortLimit, setPreciseShortLimit] = useState(60);
  const [preciseLinkedGroups, setPreciseLinkedGroups] = useState(true);
  const [preciseLinkedLimit, setPreciseLinkedLimit] = useState(50);
  const [preciseRecommendations, setPreciseRecommendations] = useState(true);
  const [preciseRecommendationLimit, setPreciseRecommendationLimit] = useState(8);
  const [preciseChannelMessages, setPreciseChannelMessages] = useState(true);
  const [preciseChannelLimit, setPreciseChannelLimit] = useState(8);
  const [preciseMessageLimit, setPreciseMessageLimit] = useState(100);
  const [preciseJoinedGraph, setPreciseJoinedGraph] = useState(true);
  const [preciseJoinedLimit, setPreciseJoinedLimit] = useState(15);
  const [preciseEnrichTme, setPreciseEnrichTme] = useState(true);
  const [preciseTmeLimit, setPreciseTmeLimit] = useState(30);
  const [preciseExpandScope, setPreciseExpandScope] = useState(false);
  const [preciseChannelPosts, setPreciseChannelPosts] = useState(false);
  const [precisePostsLimit, setPrecisePostsLimit] = useState(5);
  const [preciseAllowPaidPosts, setPreciseAllowPaidPosts] = useState(false);
  const [precisePostStars, setPrecisePostStars] = useState(20);
  const [preciseExternalWeb, setPreciseExternalWeb] = useState(false);
  const [preciseWebCandidateLimit, setPreciseWebCandidateLimit] = useState(30);
  const [preciseAllowPaidWeb, setPreciseAllowPaidWeb] = useState(false);
  const [preciseCommonChats, setPreciseCommonChats] = useState(false);
  const [preciseCommonUserLimit, setPreciseCommonUserLimit] = useState(8);
  const [preciseRpcBudget, setPreciseRpcBudget] = useState(180);
  const [preciseAllowDuplicateAccounts, setPreciseAllowDuplicateAccounts] = useState(false);
  const [preciseAiExpand, setPreciseAiExpand] = useState(false);
  const [preciseCandidateLinks, setPreciseCandidateLinks] = useState('');
  const [preciseResultTab, setPreciseResultTab] = useState<'verified' | 'pending'>('verified');
  const [preciseTaskId, setPreciseTaskId] = useState<string | null>(null);
  const [preciseBatchId, setPreciseBatchId] = useState<string | null>(null);
  const [preciseBatch, setPreciseBatch] = useState<PreciseBatchOut | null>(null);
  const [preciseRows, setPreciseRows] = useState<GroupSearchMatchOut[]>([]);
  const [preciseLoading, setPreciseLoading] = useState(false);
  // 私群邀请线索弹窗
  const [leadsOpen, setLeadsOpen] = useState(false);
  const [leadsRows, setLeadsRows] = useState<DiscoveryLeadOut[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [memberScope, setMemberScope] = useState<'all' | 'human' | 'bot'>('all');
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectBusy, setCollectBusy] = useState(false);
  const [collectForm] = Form.useForm();
  const [collectResult, setCollectResult] = useState<BulkResultOut | null>(null);
  // 按链接采集：粘贴群链接 → 自动解析 + 采群员
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkForm] = Form.useForm();

  useEffect(() => {
    if (!preciseBatchId && !preciseTaskId) return;
    let stopped = false;
    let attempts = 0;
    setPreciseLoading(true);
    const tick = async () => {
      attempts += 1;
      try {
        if (preciseBatchId) {
          const batch = await groupIntelApi.preciseBatch(preciseBatchId);
          if (!stopped) {
            setPreciseBatch(batch);
            setPreciseRows(batch.matches.filter((row) => row.status !== 'rejected'));
          }
          if (batch.total_tasks > 0 && batch.active_tasks === 0) {
            window.clearInterval(timer);
          }
        } else if (preciseTaskId) {
          const rows = await groupIntelApi.preciseMatches(preciseTaskId);
          if (!stopped) setPreciseRows(rows.filter((row) => row.status !== 'rejected'));
        }
      } catch {
        /* 任务还没产出时保持旧表 */
      } finally {
        if (!stopped) setPreciseLoading(false);
      }
      if (attempts >= 60) window.clearInterval(timer);
    };
    const timer = window.setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [preciseBatchId, preciseTaskId]);

  const openLeadsModal = async () => {
    setLeadsOpen(true);
    setLeadsLoading(true);
    try {
      const items = await groupIntelApi.discoveryLeads({ limit: 200 });
      setLeadsRows(items);
    } catch {
      /* client 已统一提示 */
    } finally {
      setLeadsLoading(false);
    }
  };

  const stats = useAsyncData(() => groupIntelApi.stats(), []);
  // 采集进度：进行中时每 5 秒刷新一次，避免黑盒等待
  const jobs = useAsyncData(() => groupIntelApi.jobs({ limit: 30 }), []);
  const [exporting, setExporting] = useState(false);
  const [syncingJoin, setSyncingJoin] = useState(false);
  useInterval(() => {
    if ((jobs.data?.summary.active ?? 0) > 0) void jobs.reload();
  }, 5000);
  const profiles = useAsyncData(
    () =>
      groupIntelApi.profiles({
        q: keyword || undefined,
        speakable: speakableOnly || undefined,
        page,
        page_size: 20,
      }),
    [keyword, page, speakableOnly],
  );
  const members = useAsyncData(
    () =>
      selected
        ? groupIntelApi.members(selected.id, {
            page: 1,
            page_size: 50,
            only_bots: memberScope === 'bot' || undefined,
            exclude_bots: memberScope === 'human' || undefined,
          })
        : Promise.resolve(null),
    [selected?.id, memberScope],
    { immediate: false },
  );
  const events = useAsyncData(
    () => groupIntelApi.events({ tg_chat_id: selected?.tg_chat_id, hours: 24 * 7, page_size: 50 }),
    [selected?.tg_chat_id],
  );

  useEffect(() => {
    if (selected) void members.reload();
  }, [selected?.id, memberScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCollect = async () => {
    const values = collectForm.getFieldsValue() as {
      scope?: 'all' | 'group';
      limit_groups?: number;
      sample_members?: number;
      with_members?: boolean;
      member_limit?: number;
    };
    setCollectBusy(true);
    try {
      const res = await groupIntelApi.collect({
        scope: 'all',
        limit_groups: values.limit_groups ?? 30,
        sample_members: values.sample_members ?? 0,
        with_members: Boolean(values.with_members),
        member_limit: values.member_limit ?? 200,
      });
      setCollectOpen(false);
      setCollectResult(res);
      notifySuccess(res.message);
      void stats.reload();
      void profiles.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setCollectBusy(false);
    }
  };

  // 把当前关键词下的可发言群链接带到「加群」页：邀请链接优先，公开群退化为 @username
  const syncSpeakableToJoin = async () => {
    setSyncingJoin(true);
    try {
      // 同一个群会被多个号各采一行，按 tg_chat_id 去重
      const targets = new Map<number, string>();
      for (let pageNo = 1; ; pageNo += 1) {
        const res = await groupIntelApi.profiles({
          q: keyword || undefined,
          speakable: true,
          page: pageNo,
          page_size: 200,
        });
        for (const item of res.items) {
          const link = item.invite_link || (item.username ? `@${item.username}` : '');
          if (link && !targets.has(item.tg_chat_id)) targets.set(item.tg_chat_id, link);
        }
        if (pageNo * 200 >= res.total) break;
      }
      if (!targets.size) {
        toast.warning('没有可同步的群：这些群既没采到邀请链接，也没有公开用户名');
        return;
      }
      navigate('/campaigns/join', { state: { joinTargets: [...targets.values()] } });
    } catch {
      /* client 已统一提示 */
    } finally {
      setSyncingJoin(false);
    }
  };

  const runCollectByLink = async () => {
    const values = linkForm.getFieldsValue() as {
      links?: string;
      join_if_missing?: boolean;
      leave_after?: boolean;
      member_limit?: number;
    };
    const links = String(values.links ?? '')
      .split(/[\n\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!links.length) {
      toast.warning('先粘贴至少一个群链接');
      return;
    }
    setLinkBusy(true);
    try {
      const res = await groupIntelApi.collectByLink({
        scope: 'all',
        links,
        join_if_missing: Boolean(values.join_if_missing),
        leave_after: Boolean(values.leave_after),
        member_limit: values.member_limit ?? 200,
      });
      setLinkOpen(false);
      setCollectResult(res);
      notifySuccess(res.message);
      void stats.reload();
    } catch {
      /* client 已统一提示 */
    } finally {
      setLinkBusy(false);
    }
  };

  const runExport = async (query?: { batch_id?: string; profile_ids?: string }) => {
    setExporting(true);
    try {
      const res = await groupIntelApi.exportZip({ ...query, include_events: true });
      const filename = filenameFromDisposition(null, 'group-intel.zip');
      downloadBlob(res.blob, filename);
      notifySuccess(`已打包 ${res.total ?? ''} 行数据，浏览器正在下载`);
    } catch {
      notifyError('打包导出失败，稍后重试');
    } finally {
      setExporting(false);
    }
  };

  const STAGE_LABEL: Record<string, string> = {
    queued: '排队中',
    resolving: '解析链接',
    resolved: '已定位群',
    joined: '已加入群',
    fetching: '采集中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    running: '执行中',
  };

  const jobColumns: ColumnsType<CollectJob> = [
    {
      title: '目标',
      dataIndex: 'link',
      width: 300,
      render: (value: string | null, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <Tooltip title={value || record.title || ''} placement="topLeft">
            <span className="tg-clamp-cell tg-mono">{value || record.title || '—'}</span>
          </Tooltip>
          {record.title ? (
            <span className="tg-muted tg-clamp-cell" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
              {record.title}
            </span>
          ) : null}
        </span>
      ),
    },
    { title: '执行号', dataIndex: 'account_label', width: 120 },
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 110,
      render: (value: string) => (
        <SoftTag
          tone={value === 'done' ? 'success' : value === 'failed' ? 'danger' : value === 'fetching' ? 'info' : 'warning'}
          size="sm"
        >
          {STAGE_LABEL[value] ?? value}
        </SoftTag>
      ),
    },
    {
      title: '进度',
      dataIndex: 'fetched',
      width: 120,
      render: (value: number | null, record) => (
        <span className="tg-num">
          {value ?? 0}
          {record.target_count ? ` / ${record.target_count}` : ''}
        </span>
      ),
    },
    {
      title: '说明',
      dataIndex: 'detail',
      width: 380,
      ellipsis: { showTitle: false },
      render: (value: string, record) => {
        const text = record.error || value || '—';
        return (
          <Tooltip title={text} placement="topLeft">
            <span className={record.error ? 'tg-clamp-cell tg-text-danger' : 'tg-clamp-cell'}>{text}</span>
          </Tooltip>
        );
      },
    },
    {
      title: '更新',
      dataIndex: 'updated_at',
      width: 120,
      render: (value: string | null, record) => <RelativeTime value={value ?? record.completed_at ?? record.created_at} />,
    },
  ];

  const profileColumns: ColumnsType<GroupProfileOut> = [
    {
      title: '群',
      dataIndex: 'title',
      render: (value: string, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>{value || '未命名群'}</span>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {record.username ? `@${record.username}` : record.tg_chat_id}
          </span>
        </span>
      ),
    },
    { title: '类型', dataIndex: 'kind', width: 90, render: (value: string) => <Tag>{KIND_LABEL[value] ?? value}</Tag> },
    {
      title: '发言',
      dataIndex: 'send_permission',
      width: 84,
      render: (value: string | null) => {
        const label = value ? SEND_LABEL[value] : undefined;
        return label ? <Tag color={label.color}>{label.text}</Tag> : <span className="tg-muted">—</span>;
      },
    },
    {
      title: '相关性',
      dataIndex: 'relevance_score',
      width: 86,
      sorter: (a, b) => (a.relevance_score ?? 0) - (b.relevance_score ?? 0),
      render: (value: number | null) =>
        value == null ? <span className="tg-muted">—</span> : <Tag color={value >= 80 ? 'green' : value >= 60 ? 'gold' : 'default'}>{value}</Tag>,
    },
    {
      title: '语言/地区',
      width: 96,
      render: (_: unknown, record) => `${record.language || '—'} / ${record.country || '—'}`,
    },
    {
      title: '成员数',
      dataIndex: 'member_count',
      width: 90,
      render: (value: number | null) => <span className="tg-num">{value ?? '—'}</span>,
    },
    {
      title: '已采成员',
      dataIndex: 'member_sampled',
      width: 100,
      render: (value: number, record) => (
        <span>
          <span className="tg-num">{value}</span>
          {record.member_synced_at ? null : <Tag style={{ marginLeft: 6 }}>未同步</Tag>}
        </span>
      ),
    },
    {
      title: '采集时间',
      dataIndex: 'collected_at',
      width: 130,
      render: (value: string | null) => <RelativeTime value={value} />,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (value: string) => (
        <SoftTag tone="neutral" size="sm">{value === 'join_event' ? '入群事件' : value === 'profile_sync' ? '资料同步' : value}</SoftTag>
      ),
    },
  ];

  const memberColumns: ColumnsType<GroupMemberOut> = [
    {
      title: '成员',
      dataIndex: 'display_name',
      render: (value: string, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <span>
            {value || '—'}
            {record.is_admin ? <Tag color="gold" style={{ marginLeft: 6 }}>管理员</Tag> : null}
            {record.is_bot ? <Tag style={{ marginLeft: 6 }}>机器人</Tag> : null}
            {record.is_premium ? <Tag color="purple" style={{ marginLeft: 6 }}>会员</Tag> : null}
          </span>
          <span className="tg-muted tg-mono" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {record.username ? `@${record.username}` : record.tg_user_id}
          </span>
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) =>
        value === 'member' ? <SoftTag tone="success" size="sm">在群</SoftTag> : <SoftTag tone="danger" size="sm">{value === 'kicked' ? '被移除' : '已退群'}</SoftTag>,
    },
    { title: '来源', dataIndex: 'source', width: 110, render: (value: string) => (value === 'join_event' ? '入群事件' : value === 'message' ? '群内发言' : '名单同步') },
    { title: '入群时间', dataIndex: 'joined_at', width: 130, render: (value: string | null) => <RelativeTime value={value} /> },
    { title: '最近出现', dataIndex: 'last_seen_at', width: 130, render: (value: string | null) => <RelativeTime value={value} /> },
  ];

  const eventColumns: ColumnsType<GroupEventOut> = [
    {
      title: '类型',
      dataIndex: 'event_type_label',
      width: 100,
      render: (value: string, record) => (
        <SoftTag tone={record.event_type === 'join' || record.event_type === 'invite' ? 'success' : 'danger'} size="sm">
          {value}
        </SoftTag>
      ),
    },
    { title: '成员', dataIndex: 'user_display', render: (value: string, record) => value || record.username || record.tg_user_id || '—' },
    {
      title: '群',
      dataIndex: 'group_title',
      width: 180,
      ellipsis: true,
      render: (value: string | null) => value || <span className="tg-muted">—</span>,
    },
    {
      title: '被谁拉进来',
      dataIndex: 'actor_tg_id',
      width: 120,
      render: (value: number | null) => (value ? <span className="tg-mono">{value}</span> : <span className="tg-muted">自己进/退</span>),
    },
    { title: '时间', dataIndex: 'occurred_at', width: 130, render: (value: string | null) => <RelativeTime value={value} /> },
  ];

  return (
    <PageContainer
      title="群情报"
      description="入群即采：Worker 在事件回调里静默记录入群/退群，不发言、不回应；群资料与成员名单按需只读拉取。"
      actions={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { void stats.reload(); void profiles.reload(); void events.reload(); }}>
            刷新
          </Button>
          <Button icon={<LinkOutlined />} onClick={() => setLinkOpen(true)}>
            按链接采集
          </Button>
          <Button icon={<SearchOutlined />} onClick={() => setFindOpen(true)}>
            按关键词找群
          </Button>
          <Button type="primary" ghost icon={<AimOutlined />} onClick={() => setPreciseOpen(true)}>
            精准找群
          </Button>
          <Button onClick={() => void openLeadsModal()}>
            私群线索
          </Button>
          <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => setCollectOpen(true)}>
            采集群情报
          </Button>
        </Space>
      }
    >
      <StatGrid>
        <StatCard title="已采群数" value={stats.data?.groups ?? 0} tone="primary" hint="有档案的群" />
        <StatCard title="已采成员" value={stats.data?.members ?? 0} tone="success" hint={`其中机器人 ${stats.data?.bots ?? 0} 个`} />
        <StatCard title="今日入群" value={stats.data?.joins_today ?? 0} tone="success" hint="含被邀请入群" />
        <StatCard title="今日退群" value={stats.data?.leaves_today ?? 0} tone={stats.data?.leaves_today ? 'warning' : 'neutral'} hint="含被移除" />
      </StatGrid>

      <Card
        size="small"
        title="采集进度"
        extra={
          <Space>
            <SoftTag tone="info" size="sm">进行中 {jobs.data?.summary.active ?? 0}</SoftTag>
            <SoftTag tone="success" size="sm">完成 {jobs.data?.summary.completed ?? 0}</SoftTag>
            {(jobs.data?.summary.failed ?? 0) > 0 ? (
              <SoftTag tone="danger" size="sm">失败 {jobs.data?.summary.failed ?? 0}</SoftTag>
            ) : null}
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void jobs.reload()}>
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<FileZipOutlined />}
              loading={exporting}
              onClick={() => void runExport()}
            >
              打包导出
            </Button>
          </Space>
        }
      >
        <Progress
          percent={
            jobs.data && jobs.data.summary.total > 0
              ? Math.round((jobs.data.summary.completed / jobs.data.summary.total) * 100)
              : 0
          }
          size="small"
          status={(jobs.data?.summary.failed ?? 0) > 0 ? 'exception' : 'active'}
          format={(percent) =>
            `${percent}%（已采 ${jobs.data?.summary.members_collected ?? 0} 人，共 ${jobs.data?.summary.total ?? 0} 条任务）`
          }
        />
        <Table<CollectJob>
          size="small"
          rowKey="task_id"
          tableLayout="fixed"
          scroll={{ x: 1080 }}
          style={{ marginTop: 'var(--tg-space-md)' }}
          columns={jobColumns}
          dataSource={jobs.data?.jobs ?? []}
          loading={jobs.loading}
          pagination={{ pageSize: 6, size: 'small' }}
          locale={{ emptyText: '还没有采集任务：用「按链接采集」粘贴链接，或点「采集群情报」' }}
        />
      </Card>

      {stats.data && !stats.data.watching ? (
        <Alert
          type="warning"
          showIcon
          message="入群事件监听已关闭（GROUP_INTEL_WATCH_ENABLED=false）"
          description="关闭后只能手动采集，事件流不会自动积累。"
        />
      ) : null}

      <Card
        size="small"
        title="群档案"
        extra={
          <Space>
            <Tooltip title="按当前关键词筛出可发言群，把邀请链接 / @用户名 带到「加群」页">
              <Button
                size="small"
                icon={<CloudUploadOutlined />}
                loading={syncingJoin}
                onClick={() => void syncSpeakableToJoin()}
              >
                同步到加群
              </Button>
            </Tooltip>
            <Segmented
              size="small"
              value={memberScope}
              onChange={(value) => setMemberScope(value as 'all' | 'human' | 'bot')}
              options={[
                { label: '全部成员', value: 'all' },
                { label: '只看真人', value: 'human' },
                { label: '只看机器人', value: 'bot' },
              ]}
            />
          </Space>
        }
      >
        <Space style={{ marginBottom: 'var(--tg-space-lg)' }} wrap>
          <input
            className="ant-input"
            style={{ width: 240, height: 'var(--tg-layout-control-height)' }}
            placeholder="按群名 / 用户名搜索"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setPage(1);
                void profiles.reload();
              }
            }}
          />
          <Button icon={<SearchOutlined />} onClick={() => { setPage(1); void profiles.reload(); }}>
            搜索
          </Button>
          <Select
            value={speakableOnly ? 'speakable' : 'all'}
            onChange={(value) => {
              setSpeakableOnly(value === 'speakable');
              setPage(1);
            }}
            style={{ width: 168 }}
            options={[
              { label: '全部群', value: 'all' },
              { label: '只看能发言的', value: 'speakable' },
            ]}
          />
          <Button
            icon={<CommentOutlined />}
            disabled={!selected}
            onClick={() => setMsgOpen(true)}
          >
            {selected ? `采集对话：${selected.title || selected.tg_chat_id}` : '采集对话（先点一行选群）'}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
            共 {profiles.data?.total ?? 0} 个群；点一行看成员与事件
          </Typography.Text>
        </Space>

        <Table<GroupProfileOut>
          size="small"
          rowKey="id"
          columns={profileColumns}
          dataSource={profiles.data?.items ?? []}
          loading={profiles.loading}
          pagination={{
            current: page,
            pageSize: 20,
            total: profiles.data?.total ?? 0,
            showSizeChanger: false,
            onChange: setPage,
            size: 'small',
          }}
          onRow={(record) => ({ onClick: () => setSelected(record), style: { cursor: 'pointer' } })}
          rowClassName={(record) => (record.id === selected?.id ? 'ant-table-row-selected' : '')}
          locale={{ emptyText: '还没有群档案：点右上角「采集群情报」，或等入群事件自动积累' }}
        />
      </Card>

      {selected ? (
        <Card
          size="small"
          title={`${selected.title || '未命名群'} · 情报详情`}
          extra={
            <Space>
              <Button size="small" onClick={() => void runExport({ profile_ids: selected.id })} loading={exporting}>
                打包这个群
              </Button>
              <Button size="small" href={groupIntelApi.membersCsvUrl(selected.id)} target="_blank">
                导出成员 CSV
              </Button>
              <Button size="small" onClick={() => setSelected(null)}>
                关闭
              </Button>
            </Space>
          }
        >
          <Tabs
            size="small"
            items={[
              {
                key: 'members',
                label: `成员（${members.data?.total ?? selected.member_sampled}）`,
                children: (
                  <Table<GroupMemberOut>
                    size="small"
                    rowKey="id"
                    columns={memberColumns}
                    dataSource={members.data?.items ?? []}
                    loading={members.loading}
                    pagination={{ pageSize: 10, size: 'small' }}
                    locale={{ emptyText: '还没有成员数据：用「采集群情报」采集（默认就会采成员名单）' }}
                  />
                ),
              },
              {
                key: 'events',
                label: `入退群（${events.data?.total ?? 0}）`,
                children: (
                  <Table<GroupEventOut>
                    size="small"
                    rowKey="id"
                    columns={eventColumns}
                    dataSource={events.data?.items ?? []}
                    loading={events.loading}
                    pagination={{ pageSize: 10, size: 'small' }}
                    locale={{ emptyText: '最近 7 天没有入退群事件' }}
                  />
                ),
              },
              {
                key: 'profile',
                label: '群资料',
                children: (
                  <div className="tg-stack" style={{ gap: 'var(--tg-space-md)' }}>
                    <div>群 ID：<span className="tg-mono">{selected.tg_chat_id}</span></div>
                    <div>类型：{KIND_LABEL[selected.kind] ?? selected.kind}{selected.is_public ? '（公开）' : '（私有）'}</div>
                    <div>成员数：{selected.member_count ?? '未知'}</div>
                    <div>邀请链接：{selected.invite_link ? <span className="tg-mono">{selected.invite_link}</span> : <span className="tg-muted">未采集到（需要管理员权限）</span>}</div>
                    <div>简介：{selected.about || <span className="tg-muted">—</span>}</div>
                    <div>采集时间：<RelativeTime value={selected.collected_at} /></div>
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Modal
        open={collectOpen}
        title="采集群情报"
        okText="开始采集"
        cancelText="取消"
        confirmLoading={collectBusy}
        onCancel={() => setCollectOpen(false)}
        onOk={() => void runCollect()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message="只读采集，不会在群里留下任何痕迹"
            description="对账号选择范围内全部可见账号执行：读取它们已加入群的资料；开启成员名单后会按页拉取（页间有间隔、单群有上限）。"
          />
          <Form form={collectForm} layout="vertical" initialValues={{ limit_groups: 30, sample_members: 0, with_members: true, member_limit: 200 }}>
            <Form.Item label="每个号最多采多少个群" name="limit_groups">
              <InputNumber min={1} max={300} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label="每群顺带抽样多少个成员（0 = 只采群档案）" name="sample_members">
              <InputNumber min={0} max={500} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="with_members" valuePropName="checked">
              <Checkbox>同时为每个群排队「采集群成员」任务（默认开启；按群成员名单采集，速度慢一些）</Checkbox>
            </Form.Item>
            <Form.Item label="成员任务每群上限" name="member_limit">
              <InputNumber min={1} max={500} style={{ width: 200 }} />
            </Form.Item>
          </Form>
        </div>
      </Modal>

      <Modal
        open={linkOpen}
        title="按群链接采集群员"
        okText="开始采集"
        cancelText="取消"
        confirmLoading={linkBusy}
        onCancel={() => setLinkOpen(false)}
        onOk={() => void runCollectByLink()}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message="粘贴群链接，系统自动解析群并采集群员"
            description="支持 t.me/xxx、t.me/+hash、@username、数字 ID，一行一个（最多 50 个）。只有号**已经在群里**才能读到成员名单；不在群里时可勾选自动加入。多个链接会轮流分给不同账号，避免一个号连续进群。"
          />
          <Form form={linkForm} layout="vertical" initialValues={{ join_if_missing: false, leave_after: false, member_limit: 200 }}>
            <Form.Item
              label="群链接（每行一个）"
              name="links"
              rules={[{ required: true, message: '至少一个链接' }]}
            >
              <Input.TextArea
                rows={6}
                placeholder={'https://t.me/somegroup\nt.me/+AbCdEfGh123\n@public_group'}
                style={{ fontFamily: 'var(--tg-font-family-mono, monospace)' }}
              />
            </Form.Item>
            <Form.Item name="join_if_missing" valuePropName="checked">
              <Checkbox>不在群里时自动加入（会在群里留下一条入群系统消息，并按高风险动作计费）</Checkbox>
            </Form.Item>
            <Form.Item name="leave_after" valuePropName="checked">
              <Checkbox>采完自动退出该群（留人不留痕，仅对本次加入的号生效）</Checkbox>
            </Form.Item>
            <Form.Item label="每群采集多少成员" name="member_limit">
              <InputNumber min={0} max={500} style={{ width: 200 }} />
            </Form.Item>
          </Form>
        </div>
      </Modal>

      <BulkResultModal open={Boolean(collectResult)} result={collectResult} onClose={() => setCollectResult(null)} />

      <Modal
        open={msgOpen}
        title={`采集群内对话：${selected?.title || ''}`}
        okText="开始扫描"
        cancelText="取消"
        confirmLoading={msgBusy}
        onCancel={() => setMsgOpen(false)}
        onOk={async () => {
          if (!selected) return;
          setMsgBusy(true);
          try {
            const res = await groupIntelApi.collectMessages({
              profile_id: selected.id,
              scope: 'all',
              days: msgDays,
              exclude_admins: msgExcludeAdmins,
              exclude_bots: !msgIncludeBots,
              limit: msgLimit,
              keywords: msgKeywords
                .split(/[,\n，]/)
                .map((item) => item.trim())
                .filter(Boolean),
            });
            setMsgOpen(false);
            setCollectResult(res);
            void jobs.reload();
          } catch {
            /* client 已统一提示 */
          } finally {
            setMsgBusy(false);
          }
        }}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message="群主隐藏「成员名单」时用这个"
            description="成员列表拉不到，但群里的对话照样能读——按时间范围扫消息，把发过言的人落成成员档案，还带发言条数，比静态名单更能看出谁还活跃。全程只读，不发言、不回应。"
          />
          <div className="tg-stack" style={{ gap: 'var(--tg-space-sm)' }}>
            <span>扫描最近</span>
            <Segmented
              value={msgDays}
              onChange={(value) => setMsgDays(Number(value))}
              options={[
                { label: '1 天', value: 1 },
                { label: '3 天', value: 3 },
                { label: '7 天', value: 7 },
                { label: '30 天', value: 30 },
              ]}
            />
            <div className="tg-stack" style={{ gap: 2 }}>
              <span>关键词（可选，逗号或换行分隔）</span>
              <Input.TextArea
                rows={2}
                style={{ maxWidth: 420 }}
                placeholder="例如：开卡、USDT、怎么收费 —— 只捞聊到这些词的人，留空则全量扫"
                value={msgKeywords}
                onChange={(e) => setMsgKeywords(e.target.value)}
              />
            </div>
            <Space>
              <span className="tg-muted">最多扫多少条</span>
              <InputNumber min={50} max={5000} step={100} value={msgLimit} onChange={(v) => setMsgLimit(Number(v) || 1000)} />
            </Space>
            <Checkbox checked={msgExcludeAdmins} onChange={(e) => setMsgExcludeAdmins(e.target.checked)}>
              跳过管理员的发言（默认不跳——管理员往往正是要联系的人）
            </Checkbox>
            <Checkbox checked={msgIncludeBots} onChange={(e) => setMsgIncludeBots(e.target.checked)}>
              把机器人也算进来（默认不算）
            </Checkbox>
          </div>
        </div>
      </Modal>
      <Modal
        open={findOpen}
        title="按关键词找公开群"
        okText="开始搜索"
        cancelText="取消"
        confirmLoading={findBusy}
        onCancel={() => setFindOpen(false)}
        onOk={async () => {
          const keywords = findKeywords
            .split(/[,\n，]/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!keywords.length) {
            toast.warning('至少填一个关键词');
            return;
          }
          setFindBusy(true);
          try {
            const res = await groupIntelApi.searchGroups({
              scope: 'all',
              keywords,
              per_keyword: findPer,
              min_members: findMinMembers,
              kind: findKind,
              regions: findRegions,
              languages: findLanguages,
              max_queries: 120,
              expand_linked_chats: findExpandLinked,
              max_linked_chats: 50,
              expand_messages: findExpandMessages,
              message_channels: 10,
              message_limit: 200,
              max_links: 100,
              expand_recommendations: findExpandRecommendations,
              recommendation_channels: 10,
              enrich_tme: findEnrichTme,
              tme_limit: 50,
            });
            setFindOpen(false);
            setCollectResult(res);
            void jobs.reload();
            void profiles.reload();
          } catch {
            /* client 已统一提示 */
          } finally {
            setFindBusy(false);
          }
        }}
      >
        <div className="tg-stack" style={{ gap: 'var(--tg-space-lg)' }}>
          <Alert
            type="info"
            showIcon
            message="用 Telegram 原生搜索找群，不依赖第三方目录站"
            description="输入关键词，系统直接调 Telegram 的公开搜索（可选按地区/语言扩展成多组查询），连成员数一起返回；找到的群会落进下面的群档案，之后可以接着用「筛群」判断值不值得投。全程只读：不加群、不发言。"
          />
          <div className="tg-stack" style={{ gap: 2 }}>
            <span>关键词（逗号或换行分隔，最多 20 个）</span>
            <Input.TextArea
              rows={2}
              style={{ maxWidth: 460 }}
              placeholder={'USDT\n开卡\ncrypto 中文'}
              value={findKeywords}
              onChange={(e) => setFindKeywords(e.target.value)}
            />
          </div>
          <div className="tg-stack" style={{ gap: 6 }}>
            <span>地区扩展（可选；不选则只搜原始关键词）</span>
            <Space wrap>
              <Select
                mode="multiple"
                allowClear
                value={findRegions}
                onChange={setFindRegions}
                style={{ minWidth: 220 }}
                placeholder="选择地区，例如马来西亚"
                options={[
                  { label: '马来西亚 MY', value: 'MY' },
                  { label: '新加坡 SG', value: 'SG' },
                  { label: '印度尼西亚 ID', value: 'ID' },
                  { label: '泰国 TH', value: 'TH' },
                ]}
              />
              <Select
                mode="multiple"
                allowClear
                value={findLanguages}
                onChange={setFindLanguages}
                style={{ minWidth: 200 }}
                placeholder="群组后缀语言（默认按地区）"
                options={[
                  { label: '马来语 ms', value: 'ms' },
                  { label: '英语 en', value: 'en' },
                  { label: '中文 zh', value: 'zh' },
                  { label: '印尼语 id', value: 'id' },
                  { label: '泰语 th', value: 'th' },
                ]}
              />
            </Space>
            <Checkbox checked={findExpandLinked} onChange={(e) => setFindExpandLinked(e.target.checked)}>
              顺着公开频道的讨论群继续找（linked_chat，只读）
            </Checkbox>
            <Checkbox checked={findExpandMessages} onChange={(e) => setFindExpandMessages(e.target.checked)}>
              读频道最近消息里的 t.me / @username，继续反查（图扩散 depth=1）
            </Checkbox>
            <Checkbox
              checked={findExpandRecommendations}
              onChange={(e) => setFindExpandRecommendations(e.target.checked)}
            >
              取 Telegram 的相似频道推荐
            </Checkbox>
            <Checkbox checked={findEnrichTme} onChange={(e) => setFindEnrichTme(e.target.checked)}>
              访问 t.me 公开页，补简介和成员数（不登录）
            </Checkbox>
            <span className="tg-muted">
              选了地区后，会把「主题词 × 地区 / 城市 / 本地语 / 中文 / 群组后缀」展开成多组查询（最多 120 条），
              比单词搜索覆盖更全；频道也会作为种子落档。本轮的查询产出会记进绩效表，跑满 5 次且连续 3 次 0 产出的扩展词会自动停用。
            </span>
          </div>
          <Space size="large" wrap>
            <span>
              每个词取
              <InputNumber min={1} max={100} value={findPer} onChange={(v) => setFindPer(Number(v) || 50)} style={{ width: 90, margin: '0 6px' }} />
              个
            </span>
            <span>
              成员数 ≥
              <InputNumber min={0} max={1000000} step={100} value={findMinMembers} onChange={(v) => setFindMinMembers(Number(v) || 0)} style={{ width: 120, margin: '0 6px' }} />
            </span>
            <Select
              value={findKind}
              onChange={setFindKind}
              style={{ width: 130 }}
              options={[
                { value: 'group', label: '只要群' },
                { value: 'channel', label: '只要频道' },
                { value: 'any', label: '群和频道' },
              ]}
            />
          </Space>
        </div>
      </Modal>

      <Modal
        open={preciseOpen}
        width={1040}
        title="精准找群：多源召回 · 统一核验"
        okText={preciseBatchId || preciseTaskId ? '重新检索' : '开始检索'}
        cancelText="关闭"
        confirmLoading={preciseBusy}
        onCancel={() => setPreciseOpen(false)}
        onOk={async () => {
          if (preciseBatchId || preciseTaskId) {
            setPreciseBatchId(null);
            setPreciseTaskId(null);
            setPreciseBatch(null);
            setPreciseRows([]);
            setPreciseResultTab('verified');
            return;
          }
          const keywords = preciseKeywords
            .split(/[,\n，]/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!keywords.length) {
            toast.warning('至少填一个关键词');
            return;
          }
          const candidateLinks = extractCandidateLinks(preciseCandidateLinks);
          setPreciseBusy(true);
          try {
            const res = await groupIntelApi.preciseSearch({
              scope: 'all',
              dispatch: preciseAllowDuplicateAccounts ? 'each' : 'round_robin',
              keywords,
              country: preciseCountry || null,
              languages: preciseLanguages,
              per_keyword: 50,
              max_queries: 120,
              group_only: true,
              public_only: true,
              enable_contacts_search: preciseContactsSearch,
              contacts_query_limit: preciseContactsLimit,
              include_linked_groups: preciseLinkedGroups,
              max_linked_chats: preciseLinkedLimit,
              exclude_readonly: true,
              search_messages: preciseGlobalMessages,
              message_search_queries: preciseMessageQueries,
              message_search_pages: preciseMessagePages,
              full_check_limit: preciseFullLimit,
              simple_screen: true,
              expand_short_queries: preciseShortQueries,
              short_query_limit: preciseShortLimit,
              expand_recommendations: preciseRecommendations,
              recommendation_channels: preciseRecommendationLimit,
              expand_channel_messages: preciseChannelMessages,
              message_channels: preciseChannelLimit,
              message_limit: preciseMessageLimit,
              scan_joined_groups: preciseJoinedGraph,
              joined_group_limit: preciseJoinedLimit,
              enrich_tme: preciseEnrichTme,
              tme_limit: preciseTmeLimit,
              expand_scope_preset: preciseExpandScope,
              expand_channel_posts: preciseChannelPosts,
              channel_posts_query_limit: precisePostsLimit,
              allow_paid_channel_posts: preciseAllowPaidPosts,
              channel_posts_max_stars: preciseAllowPaidPosts ? precisePostStars : 0,
              expand_external_web: preciseExternalWeb,
              external_web_query_limit: 3,
              external_web_candidate_limit: preciseWebCandidateLimit,
              allow_paid_external_search: preciseAllowPaidWeb,
              expand_common_chats: preciseCommonChats,
              common_chat_user_limit: preciseCommonUserLimit,
              rpc_budget: preciseRpcBudget,
              verify_activity: true,
              activity_check_limit: 60,
              ai_expand: preciseAiExpand,
              candidate_links: candidateLinks,
            });
            setPreciseRows([]);
            setPreciseBatch(null);
            setPreciseResultTab('verified');
            setPreciseBatchId(res.batch_id || null);
            setPreciseTaskId(res.task_ids[0] || null);
            void jobs.reload();
            void profiles.reload();
          } catch {
            /* client 已统一提示 */
          } finally {
            setPreciseBusy(false);
          }
        }}
      >
        {!(preciseBatchId || preciseTaskId) ? (
          <div className="tg-stack" style={{ gap: 'var(--tg-space-md)' }}>
            <Alert
              type="info"
              showIcon
              message="多源召回 → 统一候选池 → 统一 Telegram 核验"
              description="当前只保留「近 3 个月有消息 + 可发言」的讨论组；评分门槛、成员数、AI 复核等其他规则暂不参与判定。私群邀请单独进「私群线索」。"
            />
            <div className="tg-stack" style={{ gap: 2 }}>
              <span>关键词（逗号或换行分隔，最多 20 个）</span>
              <Input.TextArea
                rows={2}
                style={{ maxWidth: 620 }}
                placeholder={'Forex Thailand\nกลุ่มเทรด Forex\nCrypto MY'}
                value={preciseKeywords}
                onChange={(e) => setPreciseKeywords(e.target.value)}
              />
            </div>
            <Space size="middle" wrap>
              <span>
                目标地区
                <Select
                  allowClear
                  placeholder="不限地区"
                  value={preciseCountry}
                  onChange={setPreciseCountry}
                  style={{ width: 135, marginLeft: 8 }}
                  options={[
                    { value: 'TH', label: '泰国 TH' },
                    { value: 'MY', label: '马来西亚 MY' },
                    { value: 'SG', label: '新加坡 SG' },
                    { value: 'ID', label: '印尼 ID' },
                    { value: 'VN', label: '越南 VN' },
                    { value: 'PH', label: '菲律宾 PH' },
                    { value: 'TW', label: '台湾 TW' },
                    { value: 'HK', label: '香港 HK' },
                    { value: 'JP', label: '日本 JP' },
                    { value: 'KR', label: '韩国 KR' },
                    { value: 'AE', label: '阿联酋 AE' },
                    { value: 'IN', label: '印度 IN' },
                    { value: 'TR', label: '土耳其 TR' },
                    { value: 'BR', label: '巴西 BR' },
                    { value: 'US', label: '美国 US' },
                    { value: 'GB', label: '英国 GB' },
                    { value: 'AU', label: '澳大利亚 AU' },
                    { value: 'DE', label: '德国 DE' },
                  ]}
                />
              </span>
              <span>
                目标语言
                <Select
                  mode="multiple"
                  value={preciseLanguages}
                  onChange={setPreciseLanguages}
                  style={{ minWidth: 220, marginLeft: 8 }}
                  options={[
                    { value: 'th', label: '泰语' },
                    { value: 'en', label: '英语' },
                    { value: 'ms', label: '马来语' },
                    { value: 'id', label: '印尼语' },
                    { value: 'zh', label: '中文' },
                    { value: 'vi', label: '越南语' },
                    { value: 'ja', label: '日语' },
                    { value: 'ko', label: '韩语' },
                    { value: 'ru', label: '俄语' },
                    { value: 'ar', label: '阿拉伯语' },
                  ]}
                />
              </span>
              <Tag color="green">筛选规则：近 3 个月有消息 + 可发言（其他规则已隐藏）</Tag>
              <span>
                全检上限
                <InputNumber
                  min={10}
                  max={200}
                  step={10}
                  value={preciseFullLimit}
                  onChange={(v) => setPreciseFullLimit(Number(v) || 60)}
                  style={{ width: 74, marginLeft: 6 }}
                />
              </span>
            </Space>

            <Card
              size="small"
              title="高级搜索来源与预算控制"
              extra={
                <Checkbox
                  checked={preciseExpandScope}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setPreciseExpandScope(next);
                    setPreciseChannelPosts(next);
                    setPreciseExternalWeb(next);
                    setPreciseCommonChats(next);
                  }}
                >
                  <strong>扩大搜索范围</strong>（开启帖子搜索 + 外部网页 + 共同群）
                </Checkbox>
              }
            >
              <div className="tg-stack" style={{ gap: 10 }}>
                <div>
                  <div className="tg-muted" style={{ marginBottom: 4 }}>
                    默认 Telegram 原生与图谱来源：
                  </div>
                  <Space size={[12, 6]} wrap>
                    <Checkbox checked={preciseContactsSearch} onChange={(e) => setPreciseContactsSearch(e.target.checked)}>
                      原生搜索 (contacts_search)
                    </Checkbox>
                    <Checkbox checked={preciseGlobalMessages} onChange={(e) => setPreciseGlobalMessages(e.target.checked)}>
                      全局消息反查 (global_message_search)
                    </Checkbox>
                    <Checkbox checked={preciseShortQueries} onChange={(e) => setPreciseShortQueries(e.target.checked)}>
                      短词召回 (short_query)
                    </Checkbox>
                    <Checkbox checked={preciseLinkedGroups} onChange={(e) => setPreciseLinkedGroups(e.target.checked)}>
                      频道讨论群 (linked_chat)
                    </Checkbox>
                    <Checkbox checked={preciseRecommendations} onChange={(e) => setPreciseRecommendations(e.target.checked)}>
                      相似推荐 (channel_recommendation)
                    </Checkbox>
                    <Checkbox checked={preciseChannelMessages} onChange={(e) => setPreciseChannelMessages(e.target.checked)}>
                      频道外链 (channel_message_link)
                    </Checkbox>
                    <Checkbox checked={preciseJoinedGraph} onChange={(e) => setPreciseJoinedGraph(e.target.checked)}>
                      已入群图谱 (joined_group_graph)
                    </Checkbox>
                    <Checkbox checked={preciseEnrichTme} onChange={(e) => setPreciseEnrichTme(e.target.checked)}>
                      t.me 页面补充 (tme_preview)
                    </Checkbox>
                  </Space>
                </div>

                <div>
                  <div className="tg-muted" style={{ marginBottom: 4 }}>
                    扩展补充来源与 AI 增强（按需开启，未配置或受限时自动降级）：
                  </div>
                  <Space size={[12, 6]} wrap>
                    <Checkbox checked={preciseChannelPosts} onChange={(e) => setPreciseChannelPosts(e.target.checked)}>
                      公开频道帖子搜索 (channel_posts)
                    </Checkbox>
                    <Checkbox
                      checked={preciseAllowPaidPosts}
                      disabled={!preciseChannelPosts}
                      onChange={(e) => setPreciseAllowPaidPosts(e.target.checked)}
                    >
                      允许帖子搜索用 Stars
                    </Checkbox>
                    <Checkbox checked={preciseExternalWeb} onChange={(e) => setPreciseExternalWeb(e.target.checked)}>
                      外部网页/目录候选 (external_web)
                    </Checkbox>
                    <Checkbox
                      checked={preciseAllowPaidWeb}
                      disabled={!preciseExternalWeb}
                      onChange={(e) => setPreciseAllowPaidWeb(e.target.checked)}
                    >
                      允许外部付费 API 查询
                    </Checkbox>
                    <Checkbox checked={preciseCommonChats} onChange={(e) => setPreciseCommonChats(e.target.checked)}>
                      已知用户共同群扩展 (common_chat_graph)
                    </Checkbox>
                    <Checkbox checked={preciseAiExpand} onChange={(e) => setPreciseAiExpand(e.target.checked)}>
                      AI 同义扩词
                    </Checkbox>
                  </Space>
                </div>

                <Space size="middle" wrap>
                  <span>
                    消息查询词
                    <InputNumber
                      min={0}
                      max={20}
                      value={preciseMessageQueries}
                      disabled={!preciseGlobalMessages}
                      onChange={(v) => setPreciseMessageQueries(v == null ? 5 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    消息翻页
                    <InputNumber
                      min={1}
                      max={5}
                      value={preciseMessagePages}
                      disabled={!preciseGlobalMessages}
                      onChange={(v) => setPreciseMessagePages(Number(v) || 2)}
                      style={{ width: 58, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    短词上限
                    <InputNumber
                      min={0}
                      max={80}
                      value={preciseShortLimit}
                      disabled={!preciseShortQueries}
                      onChange={(v) => setPreciseShortLimit(v == null ? 60 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    讨论群上限
                    <InputNumber
                      min={0}
                      max={200}
                      value={preciseLinkedLimit}
                      disabled={!preciseLinkedGroups}
                      onChange={(v) => setPreciseLinkedLimit(v == null ? 50 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    推荐频道
                    <InputNumber
                      min={0}
                      max={30}
                      value={preciseRecommendationLimit}
                      disabled={!preciseRecommendations}
                      onChange={(v) => setPreciseRecommendationLimit(v == null ? 8 : Number(v))}
                      style={{ width: 60, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    频道源
                    <InputNumber
                      min={0}
                      max={30}
                      value={preciseChannelLimit}
                      disabled={!preciseChannelMessages}
                      onChange={(v) => setPreciseChannelLimit(v == null ? 8 : Number(v))}
                      style={{ width: 60, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    每源消息
                    <InputNumber
                      min={20}
                      max={300}
                      value={preciseMessageLimit}
                      disabled={!preciseChannelMessages}
                      onChange={(v) => setPreciseMessageLimit(v == null ? 100 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    已入群群数
                    <InputNumber
                      min={0}
                      max={100}
                      value={preciseJoinedLimit}
                      disabled={!preciseJoinedGraph}
                      onChange={(v) => setPreciseJoinedLimit(v == null ? 15 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    t.me补充
                    <InputNumber
                      min={0}
                      max={100}
                      value={preciseTmeLimit}
                      disabled={!preciseEnrichTme}
                      onChange={(v) => setPreciseTmeLimit(v == null ? 30 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    单号总 RPC 上限
                    <InputNumber
                      min={20}
                      max={500}
                      step={20}
                      value={preciseRpcBudget}
                      onChange={(v) => setPreciseRpcBudget(Number(v) || 180)}
                      style={{ width: 76, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    原生查询上限
                    <InputNumber
                      min={0}
                      max={300}
                      step={10}
                      value={preciseContactsLimit}
                      onChange={(v) => setPreciseContactsLimit(v == null ? 120 : Number(v))}
                      style={{ width: 74, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    帖子搜索词上限
                    <InputNumber
                      min={0}
                      max={20}
                      value={precisePostsLimit}
                      disabled={!preciseChannelPosts}
                      onChange={(v) => setPrecisePostsLimit(v == null ? 5 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    帖子 Stars 上限
                    <InputNumber
                      min={0}
                      max={500}
                      value={precisePostStars}
                      disabled={!preciseChannelPosts || !preciseAllowPaidPosts}
                      onChange={(v) => setPrecisePostStars(v == null ? 20 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    外部候选上限
                    <InputNumber
                      min={0}
                      max={200}
                      step={10}
                      value={preciseWebCandidateLimit}
                      disabled={!preciseExternalWeb}
                      onChange={(v) => setPreciseWebCandidateLimit(v == null ? 30 : Number(v))}
                      style={{ width: 74, marginLeft: 6 }}
                    />
                  </span>
                  <span>
                    共同群用户上限
                    <InputNumber
                      min={0}
                      max={25}
                      value={preciseCommonUserLimit}
                      disabled={!preciseCommonChats}
                      onChange={(v) => setPreciseCommonUserLimit(v == null ? 8 : Number(v))}
                      style={{ width: 68, marginLeft: 6 }}
                    />
                  </span>
                  <Checkbox
                    checked={preciseAllowDuplicateAccounts}
                    onChange={(e) => setPreciseAllowDuplicateAccounts(e.target.checked)}
                  >
                    允许多个账号重复全量执行（不分片）
                  </Checkbox>
                </Space>
              </div>
            </Card>

            <div className="tg-stack" style={{ gap: 4 }}>
              <Space align="center" style={{ justifyContent: 'space-between', maxWidth: 620 }}>
                <span>人工候选链接或网页文本（自动抽取 t.me/+邀请码、t.me/xxx 与 @username）</span>
                <label style={{ cursor: 'pointer', color: 'var(--tg-color-primary, #1677ff)', fontSize: 12 }}>
                  导入 .txt/.csv 链接文本
                  <input
                    type="file"
                    accept=".txt,.csv,.md"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const text = await file.text();
                      const extracted = extractCandidateLinks(text);
                      if (!extracted.length) {
                        toast.warning('文件中未识别到 t.me 或 @username 链接');
                        return;
                      }
                      setPreciseCandidateLinks((prev) =>
                        [prev.trim(), ...extracted].filter(Boolean).join('\n'),
                      );
                      toast.success(`已从文件提取 ${extracted.length} 条链接`);
                    }}
                  />
                </label>
              </Space>
              <Input.TextArea
                rows={2}
                style={{ maxWidth: 620 }}
                placeholder={'可直接粘贴整段网页或群目录文本，如：\nhttps://t.me/CitytraderEa  https://t.me/+HASH  @ExampleGroup'}
                value={preciseCandidateLinks}
                onChange={(e) => setPreciseCandidateLinks(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="tg-stack" style={{ gap: 'var(--tg-space-md)' }}>
            <Alert
              type={preciseRows.length ? 'success' : 'info'}
              showIcon
              message={
                preciseBatch
                  ? preciseRows.length
                    ? `已验证精准群 ${preciseRows.length} 个（已完成 ${preciseBatch.completed_tasks}/${preciseBatch.total_tasks} 个账号任务）`
                    : `多号检索进行中（已完成 ${preciseBatch.completed_tasks}/${preciseBatch.total_tasks}，运行中 ${preciseBatch.active_tasks}）；每 3 秒自动刷新`
                  : preciseRows.length
                    ? `已产出 ${preciseRows.length} 条匹配（按分数排序）`
                    : '检索任务已排队，正在搜索/校验；结果每 3 秒刷新。'
              }
              description={
                preciseBatch
                  ? `批次 ${preciseBatch.batch_id}${preciseBatch.failed_tasks ? `（${preciseBatch.failed_tasks} 个子任务失败）` : ''}；已验证公开群写入群档案，未核验公开链接见下方「待核验候选」，私群邀请请查右上角「私群线索」。`
                  : `任务 ${preciseTaskId}；保留与待确认的群已写入群档案。`
              }
            />
            {preciseBatch && preciseBatch.ai_notes.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="渠道/预算/AI 降级提示"
                description={preciseBatch.ai_notes.join('；')}
              />
            ) : null}
            {preciseBatch?.source_stats && Object.keys(preciseBatch.source_stats).length > 0 ? (
              <Space size={[6, 6]} wrap>
                <Tag color="blue">原生搜索 {preciseBatch.source_stats.contacts_search ?? 0}</Tag>
                <Tag color="cyan">消息反查 {preciseBatch.source_stats.global_message_search ?? 0}</Tag>
                <Tag color="geekblue">
                  频道关联{' '}
                  {(preciseBatch.source_stats.linked_chat ?? 0) +
                    (preciseBatch.source_stats.channel_recommendation ?? 0) +
                    (preciseBatch.source_stats.channel_message_link ?? 0)}
                </Tag>
                <Tag>帖子种子 {preciseBatch.source_stats.channel_posts_seeds ?? 0}</Tag>
                <Tag>外部链接 {preciseBatch.source_stats.external_links ?? 0}</Tag>
                <Tag>
                  关系图谱{' '}
                  {(preciseBatch.source_stats.joined_group_graph ?? 0) +
                    (preciseBatch.source_stats.common_chat_graph ?? 0)}
                </Tag>
                <Tag color="green">核验保留 {preciseBatch.source_stats.accepted ?? 0}</Tag>
                <Tag color="gold">待确认 {preciseBatch.source_stats.needs_review ?? 0}</Tag>
                <Tag>
                  被过滤{' '}
                  {(preciseBatch.source_stats.rejected ?? 0) +
                    (preciseBatch.source_stats.dropped_members ?? 0)}
                </Tag>
                <Tag>RPC消耗 {preciseBatch.source_stats.rpc_used ?? 0}</Tag>
                {((preciseBatch.source_stats.flood_stopped ?? 0) > 0 ||
                  (preciseBatch.source_stats.budget_stopped ?? 0) > 0) ? (
                  <Tag color="red">
                    限流/预算停机{' '}
                    {(preciseBatch.source_stats.flood_stopped ?? 0) +
                      (preciseBatch.source_stats.budget_stopped ?? 0)}
                  </Tag>
                ) : null}
              </Space>
            ) : null}
            <Tabs
              size="small"
              activeKey={preciseResultTab}
              onChange={(key) => setPreciseResultTab(key as 'verified' | 'pending')}
              items={[
                {
                  key: 'verified',
                  label: `已验证精准群 (${preciseRows.length})`,
                  children: (
                    <Table<GroupSearchMatchOut>
                      size="small"
                      rowKey="id"
                      loading={preciseLoading}
                      dataSource={preciseRows}
                      pagination={false}
                      scroll={{ y: 360 }}
                      columns={[
                        {
                          title: '分',
                          dataIndex: 'relevance_score',
                          width: 78,
                          sorter: (a, b) => a.relevance_score - b.relevance_score,
                          render: (value: number, row) => (
                            <Space size={2}>
                              <Tag color={value >= 80 ? 'green' : value >= 60 ? 'gold' : 'default'}>{value}</Tag>
                              {(row.trust_bonus ?? 0) > 0 ? (
                                <Tooltip title="多源交叉印证/关系图谱可信加分">
                                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                                    +{row.trust_bonus}
                                  </Tag>
                                </Tooltip>
                              ) : null}
                            </Space>
                          ),
                        },
                        {
                          title: '结论/验证',
                          dataIndex: 'status',
                          width: 120,
                          render: (value: string, row) => (
                            <Space direction="vertical" size={2}>
                              {value === 'accepted' ? (
                                <Tag color="green">保留</Tag>
                              ) : value === 'needs_review' ? (
                                <Tag color="gold">待确认</Tag>
                              ) : (
                                <Tag>排除</Tag>
                              )}
                              {row.verification_tier === 'external_verified' ? (
                                <Tag color="cyan" style={{ fontSize: 11 }}>
                                  外部发现·TG已验证
                                </Tag>
                              ) : null}
                            </Space>
                          ),
                        },
                        {
                          title: '群组',
                          dataIndex: 'title',
                          ellipsis: true,
                          render: (value: string, row) =>
                            row.username ? (
                              <a href={`https://t.me/${row.username}`} target="_blank" rel="noreferrer">
                                {value}
                              </a>
                            ) : (
                              value
                            ),
                        },
                        { title: '成员', dataIndex: 'member_count', width: 76 },
                        {
                          title: '来源与证据',
                          dataIndex: 'discovery_sources',
                          width: 210,
                          render: (sources: string[] | undefined, row) => {
                            const items = (sources && sources.length ? sources : [row.source]).slice(0, 4);
                            const counts = row.source_counts || {};
                            const evLines = (row.evidence || []).slice(0, 5).map((ev) => {
                              const s = String(ev.source || '');
                              const q = ev.query ? `词:${String(ev.query)}` : '';
                              const l = ev.link ? `链:${String(ev.link)}` : '';
                              return `${SOURCE_LABEL[s] ?? s} ${q} ${l}`.trim();
                            });
                            return (
                              <Tooltip title={evLines.length ? evLines.join(' | ') : '无额外证据'}>
                                <Space size={2} wrap>
                                  {items.map((src) => {
                                    const cnt = counts[src] || 0;
                                    return (
                                      <Tag key={src} style={{ marginInlineEnd: 0 }}>
                                        {SOURCE_LABEL[src] ?? src}
                                        {cnt > 1 ? ` ×${cnt}` : ''}
                                      </Tag>
                                    );
                                  })}
                                </Space>
                              </Tooltip>
                            );
                          },
                        },
                        {
                          title: '语言/地区',
                          width: 90,
                          render: (_: unknown, row) => `${row.language || '—'} / ${row.country || '—'}`,
                        },
                        {
                          title: '判定原因',
                          dataIndex: 'reasons',
                          ellipsis: true,
                          render: (value: string[]) => value.join('；'),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: 'pending',
                  label: `待核验候选 (${preciseBatch?.unverified_candidates?.length ?? 0})`,
                  children: (
                    <Table<UnverifiedCandidateOut>
                      size="small"
                      rowKey={(row) => `${row.kind}:${row.value}:${row.url}`}
                      dataSource={preciseBatch?.unverified_candidates ?? []}
                      pagination={{ pageSize: 10 }}
                      scroll={{ y: 360 }}
                      columns={[
                        {
                          title: '公开候选链接',
                          dataIndex: 'url',
                          width: 250,
                          render: (value: string) => <CopyableText value={value} mono maxLength={38} />,
                        },
                        {
                          title: '发现来源',
                          dataIndex: 'source',
                          width: 120,
                          render: (value: string) => <Tag>{SOURCE_LABEL[value] ?? value}</Tag>,
                        },
                        {
                          title: '状态',
                          dataIndex: 'status_label',
                          width: 150,
                          render: (value: string | undefined) => (
                            <Tag color="orange">{value || '外部发现，尚未验证'}</Tag>
                          ),
                        },
                        {
                          title: '查询 / 适配器',
                          dataIndex: 'query',
                          width: 160,
                          ellipsis: true,
                          render: (value: string | undefined, row) =>
                            [row.adapter, value].filter(Boolean).join(' · ') || '—',
                        },
                        {
                          title: '未核验原因',
                          dataIndex: 'reason',
                          ellipsis: true,
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </div>
        )}
      </Modal>

      <Modal
        open={leadsOpen}
        width={900}
        title="私群邀请线索（只读校验产出，未入群）"
        footer={null}
        onCancel={() => setLeadsOpen(false)}
      >
        <Table<DiscoveryLeadOut>
          size="small"
          rowKey="id"
          loading={leadsLoading}
          dataSource={leadsRows}
          pagination={{ pageSize: 12 }}
          columns={[
            {
              title: '名称',
              dataIndex: 'title',
              ellipsis: true,
              render: (value: string, row) => (
                <Space size={4}>
                  <span>{value || '未命名'}</span>
                  <Tag>{KIND_LABEL[row.kind] ?? row.kind}</Tag>
                </Space>
              ),
            },
            {
              title: '成员',
              dataIndex: 'member_count',
              width: 84,
              render: (v: number | null | undefined) => v ?? '—',
            },
            {
              title: '邀请链接',
              dataIndex: 'invite_link',
              width: 240,
              render: (value: string) => <CopyableText value={value} mono maxLength={32} />,
            },
            {
              title: '来源',
              dataIndex: 'source',
              width: 110,
              render: (value: string) => <Tag>{SOURCE_LABEL[value] ?? value}</Tag>,
            },
            { title: '状态', dataIndex: 'status', width: 88 },
          ]}
        />
      </Modal>

      <KeywordWatchPanel />
      <ReplyRulePanel />
    </PageContainer>
  );
}