/**
 * 聊天右栏：会话头（信息/同步/标记已读/会话内搜索/WS 状态）+
 * 消息流（MessageList）+ 输入区（AI 草稿、发送、Ctrl/⌘+Enter、二分支失败提示）。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Space, Tooltip, Typography } from 'antd';
import {
  CheckOutlined,
  CloudSyncOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { DetailDrawer, CopyableText, EmptyState, SoftTag, StatusBadge } from '../../components';
import { api } from '../../api/client';
import { resolveEnumLabel } from '../../i18n';
import { formatTime } from '../../utils/format';
import type { AccountOut } from '../../api/types';
import type { ChatRoomState } from './useChatRoom';
import { MessageList } from './MessageList';

interface ChatPaneProps {
  room: ChatRoomState;
}

const { Text } = Typography;

export function ChatPane({ room }: ChatPaneProps) {
  const { t } = useTranslation(['dialogs', 'shell', 'enums']);
  const dialog = room.dialog;
  const [infoOpen, setInfoOpen] = useState(false);
  const [account, setAccount] = useState<AccountOut | null>(null);

  // 用户号会话：拉一下账号状态，输入区实时展示校验提示
  useEffect(() => {
    setAccount(null);
    if (!dialog?.account_id) return;
    api
      .get<AccountOut>(`/api/accounts/${dialog.account_id}`, undefined, { silent: true })
      .then(setAccount)
      .catch(() => setAccount(null));
  }, [dialog?.account_id]);

  if (!dialog) {
    return (
      <div className="im-chat-pane">
        <div className="im-chat-empty">
          <EmptyState
            art="inbox"
            title={t('dialogs:chat.emptySelectTitle')}
            description={t('dialogs:chat.emptySelectDesc')}
          />
        </div>
      </div>
    );
  }

  const isBot = dialog.channel === 'bot';
  const channelLabel = resolveEnumLabel(`dialogChannel.${dialog.channel}`, dialog.channel_label, dialog.channel);
  const kindLabel = resolveEnumLabel(`dialogKind.${dialog.kind}`, dialog.kind_label, dialog.kind);
  const dialogDisplayTitle = dialog.title || dialog.peer_display || t('dialogs:list.fallbackTitle', { chatId: dialog.tg_chat_id });

  const infoSections = [
    {
      title: t('dialogs:chat.infoSection.dialogTitle'),
      items: [
        { label: t('dialogs:chat.infoSection.channel'), value: <SoftTag tone={isBot ? 'info' : 'primary'} size="sm">{channelLabel}</SoftTag> },
        { label: t('dialogs:chat.infoSection.kind'), value: kindLabel },
        { label: t('dialogs:chat.infoSection.chatId'), value: <CopyableText value={dialog.tg_chat_id} mono /> },
        { label: t('dialogs:chat.infoSection.username'), value: dialog.username || undefined },
        { label: t('dialogs:chat.infoSection.memberCount'), value: dialog.member_count ?? undefined },
        { label: t('dialogs:chat.infoSection.pinned'), value: dialog.is_pinned ? t('dialogs:chat.infoSection.yes') : t('dialogs:chat.infoSection.no') },
        { label: t('dialogs:chat.infoSection.unread'), value: dialog.unread_count },
        { label: t('dialogs:chat.infoSection.lastMessageAt'), value: formatTime(dialog.last_message_at) },
        { label: t('dialogs:chat.infoSection.lastMessagePreview'), value: dialog.last_message_preview || undefined, span: 'full' as const },
      ],
    },
    {
      title: t('dialogs:chat.infoSection.ownershipTitle'),
      items: [
        {
          label: t('dialogs:chat.infoSection.account'),
          value: dialog.account_label ? (
            <Space size={4}>
              <span>{dialog.account_label}</span>
              {dialog.account_id ? <CopyableText value={dialog.account_id} mono maxLength={20} /> : null}
            </Space>
          ) : undefined,
        },
        {
          label: t('dialogs:chat.infoSection.bot'),
          value: dialog.bot_label ? (
            <Space size={4}>
              <span>@{dialog.bot_label}</span>
              {dialog.bot_id ? <CopyableText value={dialog.bot_id} mono maxLength={20} /> : null}
            </Space>
          ) : undefined,
        },
      ],
    },
  ];

  return (
    <div className="im-chat-pane">
      {/* ---------- 会话头 ---------- */}
      <div className="im-chat-header">
        <div className="im-chat-title-wrap">
          <div className="im-chat-title">
            <Text strong ellipsis style={{ maxWidth: 320, fontSize: 'var(--tg-font-size)' }}>
              {dialogDisplayTitle}
            </Text>
            <SoftTag tone={isBot ? 'info' : 'primary'} size="sm">
              {channelLabel}
            </SoftTag>
            <SoftTag tone="neutral" size="sm">
              {kindLabel}
            </SoftTag>
            {dialog.kind === 'group' && dialog.member_count ? (
              <span className="im-chat-meta">{t('dialogs:list.memberCount', { count: dialog.member_count })}</span>
            ) : null}
          </div>
          <div className="im-chat-meta">
            {dialog.account_label ? t('dialogs:chat.accountPrefix', { label: dialog.account_label }) : ''}
            {dialog.bot_label ? t('dialogs:chat.botPrefix', { label: dialog.bot_label }) : ''}
            {` · chat_id ${dialog.tg_chat_id}`}
            {dialog.username ? ` · @${dialog.username}` : ''}
          </div>
        </div>

        <div className="im-chat-actions">
          <Tooltip title={t(`shell:ws.${room.wsStatus}`)}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                display: 'inline-block',
                background:
                  room.wsStatus === 'open' ? 'var(--tg-color-success)' : 'var(--tg-color-warning)',
              }}
            />
          </Tooltip>
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined style={{ color: 'var(--tg-color-text-tertiary)' }} />}
            placeholder={t('dialogs:chat.searchPlaceholder')}
            style={{ width: 180 }}
            value={room.searchQ}
            onChange={(event) => room.setSearchQ(event.target.value)}
          />
          <Button size="small" icon={<CheckOutlined />} onClick={() => void room.markRead()}>
            {t('dialogs:chat.markRead')}
          </Button>
          <Tooltip title={isBot ? t('dialogs:chat.syncBotDisabledTooltip') : t('dialogs:chat.syncTooltip')}>
            <Button
              size="small"
              icon={<CloudSyncOutlined />}
              disabled={isBot}
              onClick={() => void room.syncHistory()}
            >
              {t('dialogs:chat.syncHistory')}
            </Button>
          </Tooltip>
          <Button size="small" icon={<InfoCircleOutlined />} onClick={() => setInfoOpen(true)}>
            {t('dialogs:chat.dialogInfo')}
          </Button>
        </div>
      </div>

      {/* ---------- 消息流 ---------- */}
      {room.searchMode ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--tg-space-md)',
            padding: 'var(--tg-space-xs) var(--tg-space-xl)',
            background: 'var(--tg-color-bg-card)',
            borderBottom: '1px solid var(--tg-color-border-subtle)',
            fontSize: 'var(--tg-font-size-sm)',
            color: 'var(--tg-color-text-secondary)',
          }}
        >
          <SearchOutlined />
          {t('dialogs:chat.searchBanner', {
            title: dialog.title || dialog.peer_display,
            query: room.searchQ.trim(),
            count: room.searchTotal,
          })}
          <Button type="link" size="small" onClick={room.clearSearch}>
            {t('dialogs:chat.exitSearch')}
          </Button>
        </div>
      ) : null}

      <MessageList
        items={room.items}
        hasMore={room.hasMore}
        loading={room.loading}
        loadingMore={room.loadingMore}
        error={room.error}
        onRetry={() => {
          room.clearSearch();
        }}
        onLoadEarlier={room.loadEarlier}
        onResend={(message) => void room.resend(message)}
        onSync={() => void room.syncHistory()}
        onMarkRead={() => void room.markRead()}
        searchMode={room.searchMode}
        searchQ={room.searchQ}
        clearSearch={room.clearSearch}
        scrollRef={room.scrollRef}
        scrollToBottom={room.scrollToBottom}
      />

      {/* ---------- 输入区 ---------- */}
      <div className="im-composer">
        {room.sendError ? (
          <Alert
            type="error"
            showIcon
            closable
            onClose={room.dismissSendError}
            message={t('dialogs:chat.sendFailedTitle')}
            description={room.sendError}
          />
        ) : null}

        {room.aiGuide ? (
          <Alert
            type="info"
            showIcon
            closable
            onClose={room.dismissAiGuide}
            message={t('dialogs:chat.aiDraftTitle')}
            description={room.aiGuide}
          />
        ) : null}

        {room.draftId ? (
          <Alert
            type="warning"
            showIcon
            message={t('dialogs:chat.draftReadyTitle')}
            description={t('dialogs:chat.draftReadyDesc')}
            action={
              <Button size="small" onClick={() => void room.discardDraft()}>
                {t('dialogs:chat.discardDraft')}
              </Button>
            }
          />
        ) : null}

        {room.unreadMarker ? (
          <Alert
            type="info"
            showIcon
            message={t('dialogs:chat.unreadBannerTitle', { count: room.unreadMarker.count })}
            description={t('dialogs:chat.unreadBannerDesc')}
          />
        ) : null}

        <div className="im-composer-hints">
          {account ? (
            <Space size={4}>
              <span className="im-composer-note">{t('dialogs:chat.accountStatusLabel')}</span>
              <StatusBadge status={account.status} label={account.status_label} size="sm" />
            </Space>
          ) : null}
          <span className="im-composer-note">
            {isBot ? t('dialogs:chat.botChannelHint') : t('dialogs:chat.userChannelHint')}
          </span>
        </div>

        <Input.TextArea
          value={room.text}
          onChange={(event) => room.setText(event.target.value)}
          placeholder={
            isBot ? t('dialogs:chat.botComposerPlaceholder') : t('dialogs:chat.userComposerPlaceholder')
          }
          autoSize={{ minRows: 2, maxRows: 6 }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void room.send();
            }
          }}
        />

        <div className="im-composer-toolbar">
          <Input
            size="small"
            style={{ width: 260 }}
            value={room.instruction}
            onChange={(event) => room.setInstruction(event.target.value)}
            placeholder={t('dialogs:chat.aiInstructionPlaceholder')}
            prefix={<RobotOutlined />}
          />
          <Button icon={<RobotOutlined />} loading={room.drafting} onClick={() => void room.generateDraft()}>
            {t('dialogs:chat.aiDraftTitle')}
          </Button>
          <div className="im-composer-spacer" />
          <span className="im-composer-note">{t('dialogs:chat.shortcutHint')}</span>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={room.sending}
            disabled={!room.text.trim()}
            onClick={() => void room.send()}
          >
            {t('dialogs:chat.send')}
          </Button>
        </div>
      </div>

      {/* ---------- 会话信息抽屉 ---------- */}
      <DetailDrawer
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        title={dialogDisplayTitle}
        subtitle={channelLabel}
        width={560}
        sections={infoSections}
        footer={
          <Space>
            <Button icon={<CheckOutlined />} onClick={() => void room.markRead()}>
              {t('dialogs:chat.markRead')}
            </Button>
            <Tooltip title={isBot ? t('dialogs:chat.syncBotDisabledShort') : t('dialogs:chat.syncDrawerTooltip')}>
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                disabled={isBot}
                onClick={() => void room.syncHistory()}
              >
                {t('dialogs:chat.syncHistoryFull')}
              </Button>
            </Tooltip>
          </Space>
        }
      />
    </div>
  );
}
