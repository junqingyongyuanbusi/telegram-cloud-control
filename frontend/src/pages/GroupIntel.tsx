/**
 * 群情报：关键词找群与精准找群的入口，页面只展示找到的群档案。
 *
 * 搜索全程只读：不加群、不发言、不回应。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
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
  CloudUploadOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { PageContainer, RelativeTime, SoftTag, CopyableText } from '../components';
import { toast } from '../utils/feedback';
import { groupIntelApi } from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { notifySuccess } from '../utils/feedback';
import type {
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

/** 结果表只列讨论组：频道/讨论区在搜索阶段已排除。 */
const isDiscussionRow = (row: GroupSearchMatchOut) => {
  const reason = String(row.raw?.type_reason ?? '');
  return reason ? reason === 'ok' : row.status !== 'rejected';
};

/** 近 3 个月活跃度与发言权限都来自候选核验结果（matches.raw）。 */
const activityLabel = (row: GroupSearchMatchOut) => {
  const act = row.raw?.activity as { recent_90d?: number } | undefined;
  if (!act) return { text: '未确认', color: undefined };
  const recent = Number(act.recent_90d ?? 0);
  return recent > 0
    ? { text: `有 ${recent} 条`, color: 'green' }
    : { text: '无消息', color: 'red' };
};

const speakLabel = (row: GroupSearchMatchOut) => {
  const perm = String(row.raw?.send_permission ?? 'unknown');
  if (perm === 'restricted' || row.raw?.readonly === true) return { text: '禁言', color: 'red' };
  if (perm === 'open') return { text: '可发言', color: 'green' };
  return { text: '未校验', color: undefined };
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

export default function GroupIntel() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [speakableOnly, setSpeakableOnly] = useState(false);
  const [page, setPage] = useState(1);
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
  const [preciseResultTab, setPreciseResultTab] = useState<'verified' | 'pending'>('verified');
  const [preciseTaskId, setPreciseTaskId] = useState<string | null>(null);
  const [preciseBatchId, setPreciseBatchId] = useState<string | null>(null);
  const [preciseBatch, setPreciseBatch] = useState<PreciseBatchOut | null>(null);
  const [preciseRows, setPreciseRows] = useState<GroupSearchMatchOut[]>([]);
  const [preciseLoading, setPreciseLoading] = useState(false);

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
            setPreciseRows(batch.matches.filter(isDiscussionRow));
          }
          if (batch.total_tasks > 0 && batch.active_tasks === 0) {
            window.clearInterval(timer);
          }
        } else if (preciseTaskId) {
          const rows = await groupIntelApi.preciseMatches(preciseTaskId);
          if (!stopped) setPreciseRows(rows.filter(isDiscussionRow));
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

  const [syncingJoin, setSyncingJoin] = useState(false);
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
      navigate('/campaigns/join-send', { state: { joinTargets: [...targets.values()] } });
    } catch {
      /* client 已统一提示 */
    } finally {
      setSyncingJoin(false);
    }
  };

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

  return (
    <PageContainer
      title="群情报"
      description="用关键词找群或精准找群，找到的群统一沉淀为群档案。"
      actions={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void profiles.reload()}>
            刷新
          </Button>
          <Button icon={<SearchOutlined />} onClick={() => setFindOpen(true)}>
            按关键词找群
          </Button>
          <Button type="primary" ghost icon={<AimOutlined />} onClick={() => setPreciseOpen(true)}>
            精准找群
          </Button>
        </Space>
      }
    >
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
          <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
            共 {profiles.data?.total ?? 0} 个群
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
          locale={{ emptyText: '还没有群档案：用右上角「按关键词找群」或「精准找群」开始搜索' }}
        />
      </Card>


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
            notifySuccess(res.message);
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
        width={preciseBatchId || preciseTaskId ? 1040 : 640}
        title="精准找群"
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
          setPreciseBusy(true);
          try {
            const res = await groupIntelApi.preciseSearch({
              scope: 'all',
              dispatch: 'round_robin',
              keywords,
              per_keyword: 50,
              max_queries: 120,
              group_only: true,
              public_only: true,
              enable_contacts_search: true,
              contacts_query_limit: 120,
              include_linked_groups: true,
              max_linked_chats: 50,
              exclude_readonly: true,
              search_messages: true,
              message_search_queries: 5,
              message_search_pages: 2,
              full_check_limit: 60,
              simple_screen: true,
              expand_short_queries: true,
              short_query_limit: 20,
              expand_recommendations: true,
              recommendation_channels: 8,
              expand_channel_messages: true,
              message_channels: 8,
              message_limit: 100,
              scan_joined_groups: true,
              joined_group_limit: 15,
              enrich_tme: true,
              tme_limit: 30,
              expand_channel_posts: true,
              channel_posts_query_limit: 5,
              allow_paid_channel_posts: false,
              channel_posts_max_stars: 0,
              expand_external_web: true,
              external_web_query_limit: 3,
              external_web_candidate_limit: 30,
              allow_paid_external_search: false,
              expand_common_chats: true,
              common_chat_user_limit: 8,
              rpc_budget: 180,
              verify_activity: true,
              activity_check_limit: 60,
              ai_expand: false,
            });
            setPreciseRows([]);
            setPreciseBatch(null);
            setPreciseResultTab('verified');
            setPreciseBatchId(res.batch_id || null);
            setPreciseTaskId(res.task_ids[0] || null);
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
            <div className="tg-stack" style={{ gap: 2 }}>
              <span>关键词（逗号或换行分隔，最多 20 个）</span>
              <Input.TextArea
                rows={3}
                placeholder={'Forex Thailand\nกลุ่มเทรด Forex\nCrypto MY'}
                value={preciseKeywords}
                onChange={(e) => setPreciseKeywords(e.target.value)}
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
                    ? `检索到 ${preciseRows.length} 个讨论组（已完成 ${preciseBatch.completed_tasks}/${preciseBatch.total_tasks} 个账号任务）`
                    : `多号检索进行中（已完成 ${preciseBatch.completed_tasks}/${preciseBatch.total_tasks}，运行中 ${preciseBatch.active_tasks}）；每 3 秒自动刷新`
                  : preciseRows.length
                    ? `已产出 ${preciseRows.length} 条匹配`
                    : '检索任务已排队，正在搜索/校验；结果每 3 秒刷新。'
              }
              description={
                preciseBatch
                  ? `批次 ${preciseBatch.batch_id}${preciseBatch.failed_tasks ? `（${preciseBatch.failed_tasks} 个子任务失败）` : ''}；近 3 个月有消息且可发言的群写入群档案，其余只在这里显示；未核验公开链接见下方「待核验候选」。`
                  : `任务 ${preciseTaskId}；近 3 个月有消息且可发言的群写入群档案。`
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
                  label: `检索结果 (${preciseRows.length})`,
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
                          title: '近3个月会话',
                          width: 120,
                          render: (_: unknown, row) => {
                            const label = activityLabel(row);
                            return <Tag color={label.color}>{label.text}</Tag>;
                          },
                        },
                        {
                          title: '能否发言',
                          width: 100,
                          render: (_: unknown, row) => {
                            const label = speakLabel(row);
                            return <Tag color={label.color}>{label.text}</Tag>;
                          },
                        },
                        {
                          title: '入库',
                          dataIndex: 'status',
                          width: 90,
                          render: (value: string) =>
                            value === 'accepted' ? (
                              <Tag color="green">已入库</Tag>
                            ) : value === 'needs_review' ? (
                              <Tag color="gold">未确认</Tag>
                            ) : (
                              <Tag>未达标</Tag>
                            ),
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


    </PageContainer>
  );
}