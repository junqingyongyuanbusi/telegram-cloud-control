/**
 * 会话列表左栏：关键词搜索 + 折叠筛选（通道/类型/账号/Bot/只看未读）+ 排序切换 +
 * 滚动到底自动加载下一页；每条含渠道色条、未读角标、最后消息预览。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Popover, Select, Switch, Tooltip } from 'antd';
import {
  FilterOutlined,
  ReloadOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, RelativeTime, SoftTag } from '../../components';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { previewText } from '../../utils/format';
import { getDialogChannelOptions, getDialogKindOptions } from '../../constants';
import { resolveEnumLabel } from '../../i18n';
import type { DialogChannel, DialogKind, DialogOut, WsStatus } from '../../api/types';
import type { DialogListFilters } from './useDialogList';

export interface SelectOptionLike {
  value: string;
  label: string;
}

interface DialogListPaneProps {
  items: DialogOut[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  filters: DialogListFilters;
  onFiltersChange: (patch: Partial<DialogListFilters>) => void;
  onResetFilters: () => void;
  activeCount: number;
  sortOrder: 'desc' | 'asc';
  onToggleSort: () => void;
  onReload: () => void;
  onLoadMore: () => void;
  activeId: string | null;
  onOpen: (dialog: DialogOut) => void;
  accountOptions: SelectOptionLike[];
  botOptions: SelectOptionLike[];
  wsStatus: WsStatus;
}

export function DialogListPane({
  items,
  total,
  loading,
  loadingMore,
  error,
  filters,
  onFiltersChange,
  onResetFilters,
  activeCount,
  sortOrder,
  onToggleSort,
  onReload,
  onLoadMore,
  activeId,
  onOpen,
  accountOptions,
  botOptions,
  wsStatus,
}: DialogListPaneProps) {
  const { t, i18n } = useTranslation(['dialogs', 'common', 'shell', 'enums']);
  const [keywordInput, setKeywordInput] = useState(filters.keyword);
  const [filterOpen, setFilterOpen] = useState(false);
  const debouncedKeyword = useDebouncedValue(keywordInput, 400);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const channelOptions = useMemo(() => getDialogChannelOptions(), [i18n.language]);
  const kindOptions = useMemo(() => getDialogKindOptions(), [i18n.language]);

  // 关键词防抖后才会触发查询（避免每敲一个字就请求一次）
  useEffect(() => {
    if (debouncedKeyword.trim() === filters.keyword.trim()) return;
    onFiltersChange({ keyword: debouncedKeyword });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKeyword]);

  // 滚动到底自动加载下一页
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading && !loadingMore && items.length < total) {
          onLoadMore();
        }
      },
      { root: node.parentElement, rootMargin: '120px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, loadingMore, items.length, total, onLoadMore]);

  const filterPopover = (
    <div style={{ width: 264, display: 'flex', flexDirection: 'column', gap: 'var(--tg-space-md)' }}>
      <Select
        allowClear
        size="small"
        placeholder={t('dialogs:list.filterChannel')}
        value={filters.channel || undefined}
        onChange={(value) => onFiltersChange({ channel: (value as DialogChannel) ?? '' })}
        options={channelOptions}
      />
      <Select
        allowClear
        size="small"
        placeholder={t('dialogs:list.filterKind')}
        value={filters.kind || undefined}
        onChange={(value) => onFiltersChange({ kind: (value as DialogKind) ?? '' })}
        options={kindOptions}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        size="small"
        placeholder={t('dialogs:list.filterAccount')}
        value={filters.account_id ?? undefined}
        onChange={(value) => onFiltersChange({ account_id: value ?? null })}
        options={accountOptions}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        size="small"
        placeholder={t('dialogs:list.filterBot')}
        value={filters.bot_id ?? undefined}
        onChange={(value) => onFiltersChange({ bot_id: value ?? null })}
        options={botOptions}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--tg-color-text-secondary)', fontSize: 'var(--tg-font-size-sm)' }}>
          {t('dialogs:list.onlyUnread')}
        </span>
        <Switch
          size="small"
          checked={filters.only_unread}
          onChange={(checked) => onFiltersChange({ only_unread: checked })}
        />
      </div>
      {activeCount > 0 ? (
        <Button size="small" block onClick={onResetFilters}>
          {t('dialogs:list.clearFilters')}
        </Button>
      ) : null}
    </div>
  );

  const wsText = t(`shell:ws.${wsStatus}`);

  return (
    <div className="im-list-pane">
      <div className="im-list-toolbar">
        <Input
          allowClear
          size="small"
          placeholder={t('dialogs:list.searchPlaceholder')}
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <div className="im-list-tools">
          <Popover
            open={filterOpen}
            onOpenChange={setFilterOpen}
            trigger="click"
            placement="bottomLeft"
            content={filterPopover}
          >
            <Tooltip title={t('dialogs:list.filter')}>
              <Button size="small" icon={<FilterOutlined />} style={{ position: 'relative' }}>
                {t('dialogs:list.filter')}
                {activeCount > 0 ? <span className="im-filter-badge">{activeCount}</span> : null}
              </Button>
            </Tooltip>
          </Popover>
          <Tooltip title={sortOrder === 'desc' ? t('dialogs:list.sortDescTooltip') : t('dialogs:list.sortAscTooltip')}>
            <Button
              size="small"
              icon={sortOrder === 'desc' ? <SortDescendingOutlined /> : <SortAscendingOutlined />}
              onClick={onToggleSort}
            >
              {sortOrder === 'desc' ? t('dialogs:list.sortNewest') : t('dialogs:list.sortOldest')}
            </Button>
          </Tooltip>
          <Tooltip title={t('common:refresh')}>
            <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={onReload} aria-label={t('common:refresh')} />
          </Tooltip>
        </div>
        <div className="im-list-meta">
          <span>
            {t('dialogs:list.totalDialogs', { count: total })}
            {filters.only_unread ? t('dialogs:list.onlyUnreadSuffix') : ''}
            {filters.keyword.trim() ? t('dialogs:list.keywordSuffix', { keyword: filters.keyword.trim() }) : ''}
          </span>
          <span className="im-ws-dot">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: wsStatus === 'open' ? 'var(--tg-color-success)' : 'var(--tg-color-warning)',
              }}
            />
            {wsText}
          </span>
        </div>
      </div>

      <div className="im-list-scroll">
        {error ? (
          <div style={{ padding: 'var(--tg-space-giant)' }}>
            <ErrorState compact error={error} onRetry={onReload} />
          </div>
        ) : null}

        {!error && loading && !items.length ? (
          <div className="im-list-empty" style={{ textAlign: 'center', color: 'var(--tg-color-text-tertiary)' }}>
            {t('dialogs:list.loading')}
          </div>
        ) : null}

        {!error && !loading && !items.length ? (
          <div className="im-list-empty">
            <EmptyState
              compact
              art={activeCount > 0 || filters.keyword.trim() ? 'search' : 'inbox'}
              title={activeCount > 0 || filters.keyword.trim() ? t('dialogs:list.emptyFilteredTitle') : t('dialogs:list.emptyTitle')}
              description={
                activeCount > 0 || filters.keyword.trim()
                  ? t('dialogs:list.emptyFilteredDesc')
                  : t('dialogs:list.emptyDesc')
              }
              action={
                activeCount > 0 || filters.keyword.trim() ? (
                  <Button size="small" onClick={onResetFilters}>
                    {t('dialogs:list.clearFilters')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        {items.map((dialog) => {
          const isBot = dialog.channel === 'bot';
          return (
            <div
              key={dialog.id}
              className={[
                'im-dialog-item',
                dialog.id === activeId ? 'is-active' : '',
                isBot ? 'is-bot' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(dialog)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(dialog);
                }
              }}
            >
              <span className={['im-channel-dot', isBot ? 'is-bot' : ''].filter(Boolean).join(' ')} />
              <div className="im-dialog-main">
                <div className="im-dialog-title-row">
                  <span className="im-dialog-title">
                    {dialog.title || dialog.peer_display || t('dialogs:list.fallbackTitle', { chatId: dialog.tg_chat_id })}
                  </span>
                  <SoftTag tone={isBot ? 'info' : 'primary'} size="sm">
                    {resolveEnumLabel(`dialogChannel.${dialog.channel}`, dialog.channel_label, dialog.channel)}
                  </SoftTag>
                  <SoftTag tone="neutral" size="sm">
                    {resolveEnumLabel(`dialogKind.${dialog.kind}`, dialog.kind_label, dialog.kind)}
                  </SoftTag>
                </div>
                <div className="im-dialog-preview">
                  {previewText(dialog.last_message_preview, 40) || t('dialogs:list.noMessages')}
                </div>
                <div className="im-dialog-sub">
                  {dialog.account_label ||
                    (dialog.bot_label ? `@${dialog.bot_label}` : '—')}
                  {dialog.member_count ? ` · ${t('dialogs:list.memberCount', { count: dialog.member_count })}` : ''}
                  {dialog.username ? ` · @${dialog.username}` : ''}
                </div>
              </div>
              <div className="im-dialog-meta">
                <RelativeTime
                  value={dialog.last_message_at}
                  refreshMs={60_000}
                  className="tg-muted"
                  style={{ fontSize: 'var(--tg-font-size-xs)' }}
                />
                {dialog.unread_count > 0 ? (
                  <span className="im-unread-badge">{dialog.unread_count}</span>
                ) : null}
              </div>
            </div>
          );
        })}

        <div ref={sentinelRef} style={{ height: 1 }} />
      </div>

      <div className="im-list-footer">
        {loadingMore ? (
          t('dialogs:list.loading')
        ) : items.length < total ? (
          <Button type="link" size="small" onClick={onLoadMore}>
            {t('dialogs:list.loadMore', { shown: items.length, total })}
          </Button>
        ) : items.length > 0 ? (
          t('dialogs:list.allLoaded')
        ) : null}
      </div>
    </div>
  );
}
