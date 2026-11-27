/**
 * 消息流渲染：按时间正序的气泡 + 日期分隔 + 未读分隔线 + 媒体占位 + 失败重发。
 * 滚动行为：贴底状态跟踪、跳到底部按钮、滚到顶部自动加载更早。
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { Button, Spin, Tooltip } from 'antd';
import {
  CloudSyncOutlined,
  FileImageOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, MessageStatusTag } from '../../components';
import { isEnglish } from '../../i18n';
import type { MessageOut } from '../../api/types';
import type { ImListItem } from './types';

interface MessageListProps {
  items: ImListItem[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadEarlier: () => void;
  onResend: (message: MessageOut) => void;
  onSync: () => void;
  onMarkRead: () => void;
  searchMode: boolean;
  searchQ: string;
  clearSearch: () => void;
  scrollRef: RefObject<HTMLDivElement>;
  scrollToBottom: (smooth?: boolean) => void;
}

function senderInitial(name: string, fallback: string): string {
  const trimmed = (name || fallback).trim();
  return trimmed ? Array.from(trimmed)[0] : fallback;
}

export function MessageList({
  items,
  hasMore,
  loading,
  loadingMore,
  error,
  onRetry,
  onLoadEarlier,
  onResend,
  onSync,
  onMarkRead,
  searchMode,
  searchQ,
  clearSearch,
  scrollRef,
  scrollToBottom,
}: MessageListProps) {
  const { t, i18n } = useTranslation('dialogs');
  const [atBottom, setAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 120);
    if (node.scrollTop < 40 && hasMore && !loadingMore) onLoadEarlier();
  }, [scrollRef, hasMore, loadingMore, onLoadEarlier]);

  // 新消息进来时如果本来贴底，跟着滚到底
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const wasAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (wasAtBottom) node.scrollTop = node.scrollHeight;
  }, [items.length, scrollRef]);

  if (error) {
    return (
      <div className="im-messages">
        <div style={{ padding: 'var(--tg-space-giant)' }}>
          <ErrorState error={error} onRetry={onRetry} compact />
        </div>
      </div>
    );
  }

  return (
    <div className="im-messages" ref={scrollRef} onScroll={handleScroll}>
      {loading && !items.length ? (
        <div className="im-chat-empty">
          <Spin size="small" />
        </div>
      ) : null}

      {!loading && !items.length && searchMode ? (
        <div className="im-chat-empty">
          <EmptyState
            compact
            art="search"
            title={t('messages.emptySearchTitle', { query: searchQ.trim() })}
            description={t('messages.emptySearchDesc')}
            action={<Button size="small" onClick={clearSearch}>{t('chat.exitSearch')}</Button>}
          />
        </div>
      ) : null}

      {!loading && !items.length && !searchMode ? (
        <div className="im-chat-empty">
          <EmptyState
            compact
            art="message"
            title={t('messages.emptyTitle')}
            description={t('messages.emptyDesc')}
            action={
              <Button size="small" type="primary" icon={<CloudSyncOutlined />} onClick={onSync}>
                {t('chat.syncHistoryFull')}
              </Button>
            }
          />
        </div>
      ) : null}

      {hasMore && items.length ? (
        <div className="im-load-earlier">
          <Button size="small" loading={loadingMore} onClick={onLoadEarlier}>
            {t('messages.loadEarlier')}
          </Button>
        </div>
      ) : null}

      {items.map((item) => {
        if (item.kind === 'date') {
          return (
            <div className="im-date-sep" key={item.key}>
              <span>{item.text}</span>
            </div>
          );
        }
        if (item.kind === 'unread') {
          return (
            <div className="im-unread-sep" key={item.key}>
              <button type="button" onClick={onMarkRead} title={t('messages.unreadSepTooltip')}>
                {t('messages.unreadSep', { count: item.count })}
              </button>
            </div>
          );
        }
        const message = item.message;
        const outgoing = message.direction === 'outgoing';
        const failed = outgoing && message.status === 'failed';
        const time = message.created_at ? formatMessageTime(message.created_at, i18n.language) : '';
        return (
          <div
            key={item.key}
            className={[
              'im-msg-row',
              outgoing ? 'is-out' : 'is-in',
              failed ? 'is-failed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {!outgoing ? (
              <div className="im-avatar" title={message.sender_name || t('messages.noSenderTooltip')}>
                {senderInitial(message.sender_name, t('messages.defaultInitial'))}
              </div>
            ) : null}
            <div className="im-bubble">
              <div className="im-bubble-head">
                {outgoing ? (
                  <span>{t('messages.me')}</span>
                ) : (
                  <span>{message.sender_name || t('messages.unknownSender')}</span>
                )}
                {message.sender_tg_id && !outgoing ? <span>ID {message.sender_tg_id}</span> : null}
              </div>
              {message.has_media ? (
                <div className="im-media-card">
                  <FileImageOutlined />
                  <span>{t('messages.mediaLabel', { type: message.media_type || t('messages.defaultMediaType') })}</span>
                </div>
              ) : null}
              {message.body ? <div className="im-bubble-body">{message.body}</div> : null}
              {message.link ? (
                <a className="im-bubble-link" href={message.link} target="_blank" rel="noreferrer">
                  {t('messages.viewInTelegram')}
                </a>
              ) : null}
              <div className="im-bubble-foot">
                {failed ? <span>{t('messages.sendFailed')}</span> : null}
                <span>{time}</span>
                {outgoing && !failed ? (
                  <MessageStatusTag status={message.status} label={message.status_label} size="sm" showDot={false} />
                ) : null}
                {failed ? (
                  <Tooltip title={t('messages.resendTooltip')}>
                    <button type="button" className="im-retry-btn" onClick={() => onResend(message)}>
                      {t('messages.resend')}
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      {!atBottom && items.length ? (
        <button
          type="button"
          className="im-jump-bottom"
          aria-label={t('messages.jumpToBottom')}
          title={t('messages.jumpToBottom')}
          onClick={() => scrollToBottom(true)}
        >
          <VerticalAlignBottomOutlined />
        </button>
      ) : null}

      {loadingMore ? (
        <div className="im-load-earlier">
          <Spin size="small" />
        </div>
      ) : null}
    </div>
  );
}

function formatMessageTime(iso: string, locale: string): string {
  // 轻量时间展示（气泡内只显示时:分）
  return new Date(iso).toLocaleTimeString(isEnglish(locale) ? 'en-US' : 'zh-Hans', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
