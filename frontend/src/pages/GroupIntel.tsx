/**
 * 群情报：关键词找群与精准找群的入口，页面只展示找到的群档案。
 *
 * 搜索全程只读：不加群、不发言、不回应。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
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
import { useTranslation } from 'react-i18next';
import { CopyableText, DataTable, FilterBar, PageContainer, RelativeTime, SoftTag } from '../components';
import { isEnglish } from '../i18n';
import { toast } from '../utils/feedback';
import { formatNumber } from '../utils/format';
import { languageLabel, languageOptions, regionLabel, regionOptions } from '../utils/region';
import { groupIntelApi } from '../api/endpoints';
import { useAsyncData } from '../hooks/useAsyncData';
import { buildActiveFilters, useTableQuery } from '../hooks/useTableQuery';
import { notifySuccess } from '../utils/feedback';
import type {
  GroupProfileOut,
  GroupSearchMatchOut,
  PreciseBatchOut,
  UnverifiedCandidateOut,
} from '../api/types';

const SEND_COLOR: Record<string, string | undefined> = {
  open: 'green',
  restricted: 'red',
  unknown: undefined,
};

/** 结果表只列讨论组：频道/讨论区在搜索阶段已排除。 */
const isDiscussionRow = (row: GroupSearchMatchOut) => {
  const reason = String(row.raw?.type_reason ?? '');
  return reason ? reason === 'ok' : row.status !== 'rejected';
};

/** 群档案筛选字段：与账号 / 任务列表共用 useTableQuery 的口径。 */
interface ProfileFilters extends Record<string, unknown> {
  q: string;
  speakable: boolean;
  country: string;
  language: string;
  country_source: string;
}

export default function GroupIntel() {
  const { t } = useTranslation(['groupIntel', 'common']);
  const navigate = useNavigate();

  const kindLabel = (value: string) => t(`groupIntel:kind.${value}`, { defaultValue: value });
  const discoverySourceLabel = (value: string) =>
    t(`groupIntel:discoverySource.${value}`, { defaultValue: value });

  /** 近 3 个月活跃度与发言权限都来自候选核验结果（matches.raw）。 */
  const activityLabel = (row: GroupSearchMatchOut) => {
    const act = row.raw?.activity as { recent_90d?: number } | undefined;
    if (!act) return { text: t('groupIntel:activity.unconfirmed'), color: undefined };
    const recent = Number(act.recent_90d ?? 0);
    return recent > 0
      ? { text: t('groupIntel:activity.hasMessages', { count: recent }), color: 'green' }
      : { text: t('groupIntel:activity.noMessages'), color: 'red' };
  };

  const speakLabel = (row: GroupSearchMatchOut) => {
    const perm = String(row.raw?.send_permission ?? 'unknown');
    if (perm === 'restricted' || row.raw?.readonly === true) {
      return { text: t('groupIntel:sendPermission.restricted'), color: 'red' };
    }
    if (perm === 'open') {
      return { text: t('groupIntel:sendPermission.open'), color: 'green' };
    }
    return { text: t('groupIntel:sendPermission.unknown'), color: undefined };
  };
  // 群档案筛选：与账号 / 任务列表同一套 useTableQuery，分页、排序、重置口径一致。
  const q = useTableQuery<ProfileFilters>({
    filters: { q: '', speakable: false, country: '', language: '', country_source: '' },
    pageSize: 20,
    sort: 'member_count',
    order: 'desc',
  });
  const [draftKeyword, setDraftKeyword] = useState('');
  const commitKeyword = () => q.setFilter('q', draftKeyword.trim());
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
        q: q.filters.q || undefined,
        speakable: q.filters.speakable || undefined,
        country: q.filters.country || undefined,
        language: q.filters.language || undefined,
        country_source: q.filters.country_source || undefined,
        sort: q.sort ?? undefined,
        order: q.order,
        page: q.page,
        page_size: q.pageSize,
      }),
    [q.paramsKey, q.sort, q.order],
  );

  // 把当前关键词下的可发言群链接带到「加群」页：邀请链接优先，公开群退化为 @username
  const syncSpeakableToJoin = async () => {
    setSyncingJoin(true);
    try {
      // 同一个群会被多个号各采一行，按 tg_chat_id 去重
      const targets = new Map<number, string>();
      for (let pageNo = 1; ; pageNo += 1) {
        const res = await groupIntelApi.profiles({
          q: q.filters.q || undefined,
          speakable: true,
          country: q.filters.country || undefined,
          language: q.filters.language || undefined,
          country_source: q.filters.country_source || undefined,
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
        toast.warning(t('groupIntel:profiles.syncEmptyWarning'));
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
      title: t('groupIntel:profiles.columns.group'),
      dataIndex: 'title',
      render: (value: string, record) => (
        <span className="tg-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>
            {value || t('groupIntel:profiles.unnamedGroup')}
          </span>
          <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
            {record.username ? `@${record.username}` : record.tg_chat_id}
          </span>
        </span>
      ),
    },
    {
      title: t('groupIntel:profiles.columns.kind'),
      dataIndex: 'kind',
      width: 90,
      render: (value: string) => (
        <SoftTag tone="neutral" size="sm">
          {kindLabel(value)}
        </SoftTag>
      ),
    },
    {
      title: t('groupIntel:profiles.columns.region'),
      dataIndex: 'country',
      width: 128,
      render: (value: string | null, record) => {
        // 国家 + 语言压成一行，行高一致；来源放进悬浮提示，不再占第二行。
        const sourceLabel =
          record.country_source === 'target'
            ? t('groupIntel:profiles.countrySource.target')
            : record.country_source === 'inferred'
              ? t('groupIntel:profiles.countrySource.inferred')
              : '';
        const cell = (
          <span className="tg-flex" style={{ alignItems: 'center', gap: 6 }}>
            {value ? (
              <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                {value}
              </Tag>
            ) : (
              <span className="tg-muted">—</span>
            )}
            {record.language ? (
              <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                {record.language}
              </span>
            ) : null}
          </span>
        );
        return sourceLabel ? <Tooltip title={sourceLabel}>{cell}</Tooltip> : cell;
      },
    },
    {
      title: t('groupIntel:profiles.columns.speak'),
      dataIndex: 'send_permission',
      width: 84,
      render: (value: string | null) => {
        if (!value || !(value in SEND_COLOR)) return <span className="tg-muted">—</span>;
        return (
          <Tag color={SEND_COLOR[value]}>
            {t(`groupIntel:sendPermission.${value}`)}
          </Tag>
        );
      },
    },
    {
      title: t('groupIntel:profiles.columns.memberCount'),
      dataIndex: 'member_count',
      width: 96,
      align: 'right',
      render: (value: number | null) => (
        <span className="tg-num">{value == null ? '—' : formatNumber(value)}</span>
      ),
    },
    {
      title: t('groupIntel:profiles.columns.memberSampled'),
      dataIndex: 'member_sampled',
      width: 110,
      align: 'right',
      render: (value: number, record) => (
        <span className="tg-num">
          {formatNumber(value)}
          {record.member_synced_at ? null : (
            <span
              className="tg-muted"
              style={{ marginLeft: 6, fontSize: 'var(--tg-font-size-xs)', fontWeight: 'normal' }}
            >
              {t('groupIntel:profiles.unsynced')}
            </span>
          )}
        </span>
      ),
    },
    {
      title: t('groupIntel:profiles.columns.collectedAt'),
      dataIndex: 'collected_at',
      width: 130,
      render: (value: string | null) => <RelativeTime value={value} />,
    },
    {
      title: t('groupIntel:profiles.columns.source'),
      dataIndex: 'source',
      width: 110,
      render: (value: string) => (
        <SoftTag tone="neutral" size="sm">
          {t(`groupIntel:profiles.sources.${value}`, { defaultValue: value })}
        </SoftTag>
      ),
    },
  ];

  return (
    <PageContainer
      title={t('groupIntel:title')}
      description={t('groupIntel:description')}
      actions={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void profiles.reload()}>
            {t('common:refresh')}
          </Button>
          <Button icon={<SearchOutlined />} onClick={() => setFindOpen(true)}>
            {t('groupIntel:actions.keywordSearch')}
          </Button>
          <Button type="primary" ghost icon={<AimOutlined />} onClick={() => setPreciseOpen(true)}>
            {t('groupIntel:actions.preciseSearch')}
          </Button>
        </Space>
      }
    >
      <FilterBar
        collapsible
        onReset={() => {
          q.reset();
          setDraftKeyword('');
        }}
        onSearch={commitKeyword}
        loading={profiles.loading}
        activeFilters={buildActiveFilters([
          {
            key: 'q',
            label: t('groupIntel:profiles.filterKeyword'),
            display: q.filters.q,
            clear: () => {
              setDraftKeyword('');
              q.setFilter('q', '');
            },
          },
          {
            key: 'speakable',
            label: t('groupIntel:profiles.columns.speak'),
            display: q.filters.speakable ? t('groupIntel:profiles.filterSpeakable') : '',
            clear: () => q.setFilter('speakable', false),
          },
          {
            key: 'country',
            label: t('groupIntel:profiles.filterCountry'),
            display: q.filters.country ? regionLabel(q.filters.country) : '',
            clear: () => q.setFilter('country', ''),
          },
          {
            key: 'language',
            label: t('groupIntel:profiles.filterLanguage'),
            display: q.filters.language ? languageLabel(q.filters.language) : '',
            clear: () => q.setFilter('language', ''),
          },
          {
            key: 'country_source',
            label: t('groupIntel:profiles.filterCountrySource'),
            display: q.filters.country_source
              ? t(`groupIntel:profiles.countrySource.${q.filters.country_source}`, {
                  defaultValue: q.filters.country_source,
                })
              : '',
            clear: () => q.setFilter('country_source', ''),
          },
        ])}
        primary={
          <Input
            allowClear
            prefix={<SearchOutlined />}
            style={{ width: 260 }}
            placeholder={t('groupIntel:profiles.searchPlaceholder')}
            value={draftKeyword}
            onChange={(event) => setDraftKeyword(event.target.value)}
          />
        }
      >
        <Select
          value={q.filters.speakable ? 'speakable' : 'all'}
          onChange={(value) => q.setFilter('speakable', value === 'speakable')}
          style={{ width: 168 }}
          options={[
            { label: t('groupIntel:profiles.filterAll'), value: 'all' },
            { label: t('groupIntel:profiles.filterSpeakable'), value: 'speakable' },
          ]}
        />
        <Select
          allowClear
          value={q.filters.country || undefined}
          placeholder={t('groupIntel:profiles.filterCountry')}
          onChange={(value?: string) => q.setFilter('country', value ?? '')}
          style={{ width: 160 }}
          showSearch
          optionFilterProp="label"
          options={regionOptions(profiles.data?.summary.countries, q.filters.country || undefined)}
        />
        <Select
          allowClear
          value={q.filters.language || undefined}
          placeholder={t('groupIntel:profiles.filterLanguage')}
          onChange={(value?: string) => q.setFilter('language', value ?? '')}
          style={{ width: 150 }}
          showSearch
          optionFilterProp="label"
          options={languageOptions(profiles.data?.summary.languages, q.filters.language || undefined)}
        />
        <Select
          allowClear
          value={q.filters.country_source || undefined}
          placeholder={t('groupIntel:profiles.filterCountrySource')}
          onChange={(value?: string) => q.setFilter('country_source', value ?? '')}
          style={{ width: 160 }}
          options={[
            { label: t('groupIntel:profiles.countrySource.target'), value: 'target' },
            { label: t('groupIntel:profiles.countrySource.inferred'), value: 'inferred' },
          ]}
        />
      </FilterBar>

      <DataTable<GroupProfileOut>
        rowKey="id"
        columns={profileColumns}
        dataSource={profiles.data?.items ?? []}
        total={profiles.data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPageChange={q.setPage}
        loading={profiles.loading}
        error={profiles.error}
        onRetry={() => void profiles.reload()}
        sortableColumns={{ title: 'title', member_count: 'member_count', collected_at: 'collected_at' }}
        sortField={q.sort}
        sortOrder={q.order}
        onSortChange={q.setSort}
        columnSettingsKey="group-intel-profiles"
        scrollX={1120}
        title={
          <Space size={6}>
            <span style={{ fontWeight: 'var(--tg-font-weight-medium)' }}>
              {t('groupIntel:profiles.cardTitle')}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 'var(--tg-font-size-sm)' }}>
              {t('groupIntel:profiles.totalGroups', { count: profiles.data?.total ?? 0 })}
            </Typography.Text>
          </Space>
        }
        extra={
          <Tooltip title={t('groupIntel:actions.syncToJoinTooltip')}>
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              loading={syncingJoin}
              onClick={() => void syncSpeakableToJoin()}
            >
              {t('groupIntel:actions.syncToJoin')}
            </Button>
          </Tooltip>
        }
        empty={{
          art: 'search',
          title: t('groupIntel:profiles.emptyTitle'),
          description: t('groupIntel:profiles.emptyText'),
          action: (
            <Button type="primary" onClick={() => setFindOpen(true)}>
              {t('groupIntel:actions.keywordSearch')}
            </Button>
          ),
        }}
      />


      <Modal
        open={findOpen}
        title={t('groupIntel:findModal.title')}
        okText={t('groupIntel:findModal.okText')}
        cancelText={t('common:cancel')}
        confirmLoading={findBusy}
        onCancel={() => setFindOpen(false)}
        onOk={async () => {
          const keywords = findKeywords
            .split(/[,\n，]/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!keywords.length) {
            toast.warning(t('groupIntel:findModal.keywordRequired'));
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
            message={t('groupIntel:findModal.alertTitle')}
            description={t('groupIntel:findModal.alertDescription')}
          />
          <div className="tg-stack" style={{ gap: 2 }}>
            <span>{t('groupIntel:findModal.keywordsLabel')}</span>
            <Input.TextArea
              rows={2}
              style={{ maxWidth: 460 }}
              placeholder={t('groupIntel:findModal.keywordsPlaceholder')}
              value={findKeywords}
              onChange={(e) => setFindKeywords(e.target.value)}
            />
          </div>
          <div className="tg-stack" style={{ gap: 6 }}>
            <span>{t('groupIntel:findModal.regionExpandLabel')}</span>
            <Space wrap>
              <Select
                mode="multiple"
                allowClear
                value={findRegions}
                onChange={setFindRegions}
                style={{ minWidth: 220 }}
                placeholder={t('groupIntel:findModal.regionPlaceholder')}
                options={[
                  { label: t('groupIntel:findModal.regions.MY'), value: 'MY' },
                  { label: t('groupIntel:findModal.regions.SG'), value: 'SG' },
                  { label: t('groupIntel:findModal.regions.ID'), value: 'ID' },
                  { label: t('groupIntel:findModal.regions.TH'), value: 'TH' },
                ]}
              />
              <Select
                mode="multiple"
                allowClear
                value={findLanguages}
                onChange={setFindLanguages}
                style={{ minWidth: 200 }}
                placeholder={t('groupIntel:findModal.languagePlaceholder')}
                options={[
                  { label: t('groupIntel:findModal.languages.ms'), value: 'ms' },
                  { label: t('groupIntel:findModal.languages.en'), value: 'en' },
                  { label: t('groupIntel:findModal.languages.zh'), value: 'zh' },
                  { label: t('groupIntel:findModal.languages.id'), value: 'id' },
                  { label: t('groupIntel:findModal.languages.th'), value: 'th' },
                ]}
              />
            </Space>
            <Checkbox checked={findExpandLinked} onChange={(e) => setFindExpandLinked(e.target.checked)}>
              {t('groupIntel:findModal.expandLinked')}
            </Checkbox>
            <Checkbox checked={findExpandMessages} onChange={(e) => setFindExpandMessages(e.target.checked)}>
              {t('groupIntel:findModal.expandMessages')}
            </Checkbox>
            <Checkbox
              checked={findExpandRecommendations}
              onChange={(e) => setFindExpandRecommendations(e.target.checked)}
            >
              {t('groupIntel:findModal.expandRecommendations')}
            </Checkbox>
            <Checkbox checked={findEnrichTme} onChange={(e) => setFindEnrichTme(e.target.checked)}>
              {t('groupIntel:findModal.enrichTme')}
            </Checkbox>
            <span className="tg-muted">
              {t('groupIntel:findModal.expandHint')}
            </span>
          </div>
          <Space size="large" wrap>
            <span>
              {t('groupIntel:findModal.perKeywordPrefix')}
              <InputNumber min={1} max={100} value={findPer} onChange={(v) => setFindPer(Number(v) || 50)} style={{ width: 90, margin: '0 6px' }} />
              {t('groupIntel:findModal.perKeywordSuffix')}
            </span>
            <span>
              {t('groupIntel:findModal.minMembersLabel')}
              <InputNumber min={0} max={1000000} step={100} value={findMinMembers} onChange={(v) => setFindMinMembers(Number(v) || 0)} style={{ width: 120, margin: '0 6px' }} />
            </span>
            <Select
              value={findKind}
              onChange={setFindKind}
              style={{ width: 130 }}
              options={[
                { value: 'group', label: t('groupIntel:findModal.kindOptions.group') },
                { value: 'channel', label: t('groupIntel:findModal.kindOptions.channel') },
                { value: 'any', label: t('groupIntel:findModal.kindOptions.any') },
              ]}
            />
          </Space>
        </div>
      </Modal>

      <Modal
        open={preciseOpen}
        width={preciseBatchId || preciseTaskId ? 1040 : 640}
        title={t('groupIntel:preciseModal.title')}
        okText={
          preciseBatchId || preciseTaskId
            ? t('groupIntel:preciseModal.okRestart')
            : t('groupIntel:preciseModal.okStart')
        }
        cancelText={t('common:close')}
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
            toast.warning(t('groupIntel:preciseModal.keywordRequired'));
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
              <span>{t('groupIntel:preciseModal.keywordsLabel')}</span>
              <Input.TextArea
                rows={3}
                placeholder={t('groupIntel:preciseModal.keywordsPlaceholder')}
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
                    ? t('groupIntel:preciseModal.status.batchFound', {
                        count: preciseRows.length,
                        completed: preciseBatch.completed_tasks,
                        total: preciseBatch.total_tasks,
                      })
                    : t('groupIntel:preciseModal.status.batchRunning', {
                        completed: preciseBatch.completed_tasks,
                        total: preciseBatch.total_tasks,
                        active: preciseBatch.active_tasks,
                      })
                  : preciseRows.length
                    ? t('groupIntel:preciseModal.status.taskFound', { count: preciseRows.length })
                    : t('groupIntel:preciseModal.status.taskQueued')
              }
              description={
                preciseBatch
                  ? t('groupIntel:preciseModal.status.batchDesc', {
                      batchId: preciseBatch.batch_id,
                      failedPart: preciseBatch.failed_tasks
                        ? t('groupIntel:preciseModal.status.failedTasksPart', {
                            count: preciseBatch.failed_tasks,
                          })
                        : '',
                    })
                  : t('groupIntel:preciseModal.status.taskDesc', { taskId: preciseTaskId })
              }
            />
            {preciseBatch && preciseBatch.ai_notes.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={t('groupIntel:preciseModal.aiNotesTitle')}
                description={preciseBatch.ai_notes.join(isEnglish() ? '; ' : '；')}
              />
            ) : null}
            {preciseBatch?.source_stats && Object.keys(preciseBatch.source_stats).length > 0 ? (
              <Space size={[6, 6]} wrap>
                <Tag color="blue">
                  {t('groupIntel:preciseModal.stats.contactsSearch', {
                    count: preciseBatch.source_stats.contacts_search ?? 0,
                  })}
                </Tag>
                <Tag color="cyan">
                  {t('groupIntel:preciseModal.stats.messageSearch', {
                    count: preciseBatch.source_stats.global_message_search ?? 0,
                  })}
                </Tag>
                <Tag color="geekblue">
                  {t('groupIntel:preciseModal.stats.channelLinked', {
                    count:
                      (preciseBatch.source_stats.linked_chat ?? 0) +
                      (preciseBatch.source_stats.channel_recommendation ?? 0) +
                      (preciseBatch.source_stats.channel_message_link ?? 0),
                  })}
                </Tag>
                <Tag>
                  {t('groupIntel:preciseModal.stats.postSeeds', {
                    count: preciseBatch.source_stats.channel_posts_seeds ?? 0,
                  })}
                </Tag>
                <Tag>
                  {t('groupIntel:preciseModal.stats.externalLinks', {
                    count: preciseBatch.source_stats.external_links ?? 0,
                  })}
                </Tag>
                <Tag>
                  {t('groupIntel:preciseModal.stats.relationGraph', {
                    count:
                      (preciseBatch.source_stats.joined_group_graph ?? 0) +
                      (preciseBatch.source_stats.common_chat_graph ?? 0),
                  })}
                </Tag>
                <Tag color="green">
                  {t('groupIntel:preciseModal.stats.accepted', {
                    count: preciseBatch.source_stats.accepted ?? 0,
                  })}
                </Tag>
                <Tag color="gold">
                  {t('groupIntel:preciseModal.stats.needsReview', {
                    count: preciseBatch.source_stats.needs_review ?? 0,
                  })}
                </Tag>
                <Tag>
                  {t('groupIntel:preciseModal.stats.filtered', {
                    count:
                      (preciseBatch.source_stats.rejected ?? 0) +
                      (preciseBatch.source_stats.dropped_members ?? 0),
                  })}
                </Tag>
                <Tag>
                  {t('groupIntel:preciseModal.stats.rpcUsed', {
                    count: preciseBatch.source_stats.rpc_used ?? 0,
                  })}
                </Tag>
                {((preciseBatch.source_stats.flood_stopped ?? 0) > 0 ||
                  (preciseBatch.source_stats.budget_stopped ?? 0) > 0) ? (
                  <Tag color="red">
                    {t('groupIntel:preciseModal.stats.limitStopped', {
                      count:
                        (preciseBatch.source_stats.flood_stopped ?? 0) +
                        (preciseBatch.source_stats.budget_stopped ?? 0),
                    })}
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
                  label: t('groupIntel:preciseModal.tabs.verified', { count: preciseRows.length }),
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
                          title: t('groupIntel:preciseModal.verifiedColumns.group'),
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
                        {
                          title: t('groupIntel:preciseModal.verifiedColumns.members'),
                          dataIndex: 'member_count',
                          width: 76,
                        },
                        {
                          title: t('groupIntel:preciseModal.verifiedColumns.activity90d'),
                          width: 120,
                          render: (_: unknown, row) => {
                            const label = activityLabel(row);
                            return <Tag color={label.color}>{label.text}</Tag>;
                          },
                        },
                        {
                          title: t('groupIntel:preciseModal.verifiedColumns.speakable'),
                          width: 100,
                          render: (_: unknown, row) => {
                            const label = speakLabel(row);
                            return <Tag color={label.color}>{label.text}</Tag>;
                          },
                        },
                        {
                          title: t('groupIntel:preciseModal.verifiedColumns.archived'),
                          dataIndex: 'status',
                          width: 90,
                          render: (value: string) =>
                            value === 'accepted' ? (
                              <Tag color="green">
                                {t('groupIntel:preciseModal.matchStatus.accepted')}
                              </Tag>
                            ) : value === 'needs_review' ? (
                              <Tag color="gold">
                                {t('groupIntel:preciseModal.matchStatus.needs_review')}
                              </Tag>
                            ) : (
                              <Tag>{t('groupIntel:preciseModal.matchStatus.rejected')}</Tag>
                            ),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: 'pending',
                  label: t('groupIntel:preciseModal.tabs.pending', {
                    count: preciseBatch?.unverified_candidates?.length ?? 0,
                  }),
                  children: (
                    <Table<UnverifiedCandidateOut>
                      size="small"
                      rowKey={(row) => `${row.kind}:${row.value}:${row.url}`}
                      dataSource={preciseBatch?.unverified_candidates ?? []}
                      pagination={{ pageSize: 10 }}
                      scroll={{ y: 360 }}
                      columns={[
                        {
                          title: t('groupIntel:preciseModal.pendingColumns.url'),
                          dataIndex: 'url',
                          width: 250,
                          render: (value: string) => <CopyableText value={value} mono maxLength={38} />,
                        },
                        {
                          title: t('groupIntel:preciseModal.pendingColumns.source'),
                          dataIndex: 'source',
                          width: 120,
                          render: (value: string) => <Tag>{discoverySourceLabel(value)}</Tag>,
                        },
                        {
                          title: t('groupIntel:preciseModal.pendingColumns.status'),
                          dataIndex: 'status_label',
                          width: 150,
                          render: (value: string | undefined) => (
                            <Tag color="orange">
                              {!value || (isEnglish() && value === '外部发现，尚未验证')
                                ? t('groupIntel:preciseModal.unverifiedDefaultStatus')
                                : value}
                            </Tag>
                          ),
                        },
                        {
                          title: t('groupIntel:preciseModal.pendingColumns.queryAdapter'),
                          dataIndex: 'query',
                          width: 160,
                          ellipsis: true,
                          render: (value: string | undefined, row) =>
                            [row.adapter, value].filter(Boolean).join(' · ') || '—',
                        },
                        {
                          title: t('groupIntel:preciseModal.pendingColumns.reason'),
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