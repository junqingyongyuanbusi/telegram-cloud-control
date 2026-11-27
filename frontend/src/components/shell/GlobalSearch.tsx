/**
 * GlobalSearch —— 全局搜索（顶栏入口 + Ctrl/⌘+K 唤起）。
 *
 * props 契约：
 * ┌──────────┬──────────────────────────────────────────────────────────────────┐
 * │ open     │ boolean                                                          │
 * │ onClose  │ () => void                                                       │
 * └──────────┴──────────────────────────────────────────────────────────────────┘
 * 搜索范围（全部 silent，后端没起时不弹错误、不白屏）：
 *   1. 页面导航（本地匹配侧栏）
 *   2. 账号（GET /api/accounts?keyword=）
 *   3. 会话（GET /api/dialogs?keyword=）
 *   4. 消息正文（GET /api/messages?q=，≥2 个字符才查）
 * 键盘：↑↓ 选择，Enter 打开，Esc 关闭。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Modal, Spin, Typography } from 'antd';
import { ApiOutlined, MessageOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { visibleNavItems } from './nav';
import { useAuth } from '../../auth/AuthContext';
import { accountApi, dialogApi, messageApi } from '../../api/endpoints';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useAsyncData } from '../../hooks/useAsyncData';
import StatusBadge from '../StatusBadge';
import { previewText } from '../../utils/format';
import { resolveEnumLabel } from '../../i18n';

export interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

interface ResultItem {
  key: string;
  kind: 'page' | 'account' | 'dialog' | 'message';
  title: string;
  desc?: string;
  extra?: React.ReactNode;
  icon: React.ReactNode;
  go: () => void;
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const { t, i18n } = useTranslation('shell');
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  // 页面结果按角色裁剪：operator 不搜到管理员页面（搜索账号同样只对 admin 开放）
  const pages = useMemo(() => visibleNavItems(isAdmin), [isAdmin]);
  const [keyword, setKeyword] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const q = keyword.trim();
  const debounced = useDebouncedValue(q, 250);

  useEffect(() => {
    if (!open) {
      setKeyword('');
      setActiveIndex(0);
    }
  }, [open]);

  const accounts = useAsyncData(
    () =>
      debounced
        ? accountApi.list({ keyword: debounced, page_size: 6 }, { silent: true })
        : Promise.resolve({ items: [], total: 0, page: 1, page_size: 0 }),
    [debounced],
    { silentError: true, immediate: isAdmin },
  );

  const dialogs = useAsyncData(
    () =>
      debounced
        ? dialogApi.list({ keyword: debounced, page_size: 6 }, { silent: true })
        : Promise.resolve({ items: [], total: 0, page: 1, page_size: 0 }),
    [debounced],
    { silentError: true },
  );

  const messages = useAsyncData(
    () =>
      debounced.length >= 2
        ? messageApi.search({ q: debounced, page_size: 5 }, { silent: true })
        : Promise.resolve({ items: [], total: 0, page: 1, page_size: 0 }),
    [debounced],
    { silentError: true },
  );

  const results = useMemo<ResultItem[]>(() => {
    const items: ResultItem[] = [];
    const lower = q.toLowerCase();

    pages.filter((item) => {
      if (!q) return true;
      const label = t(item.labelKey, { defaultValue: item.label });
      const desc = item.descriptionKey ? t(item.descriptionKey, { defaultValue: item.description ?? '' }) : (item.description ?? '');
      return (
        label.toLowerCase().includes(lower) ||
        desc.toLowerCase().includes(lower) ||
        item.label.toLowerCase().includes(lower)
      );
    })
      .slice(0, 6)
      .forEach((item) => {
        const label = t(item.labelKey, { defaultValue: item.label });
        const desc = item.descriptionKey ? t(item.descriptionKey, { defaultValue: item.description ?? '' }) : item.description;
        items.push({
          key: `page:${item.path}`,
          kind: 'page',
          title: label,
          desc,
          icon: item.icon,
          go: () => navigate(item.path),
        });
      });

    (isAdmin ? accounts.data?.items ?? [] : []).forEach((account) => {
      items.push({
        key: `account:${account.id}`,
        kind: 'account',
        title: account.display_name || account.phone_masked,
        desc: `${account.phone_masked}${account.group_name ? ` · ${account.group_name}` : ''}`,
        extra: <StatusBadge status={account.status} label={account.status_label} size="sm" showDot={false} />,
        icon: <UserOutlined />,
        go: () => navigate(`/accounts?keyword=${encodeURIComponent(account.phone_masked)}`),
      });
    });

    (dialogs.data?.items ?? []).forEach((dialog) => {
      const channelText = resolveEnumLabel(`dialogChannel.${dialog.channel}`, dialog.channel_label, dialog.channel);
      const kindText = resolveEnumLabel(`dialogKind.${dialog.kind}`, dialog.kind_label, dialog.kind);
      items.push({
        key: `dialog:${dialog.id}`,
        kind: 'dialog',
        title: dialog.title || dialog.peer_display,
        desc: `${channelText} · ${kindText}${dialog.last_message_preview ? ` · ${previewText(dialog.last_message_preview, 30)}` : ''}`,
        extra: dialog.unread_count ? <span className="tg-muted">{t('search.unreadCount', { count: dialog.unread_count })}</span> : null,
        icon: <MessageOutlined />,
        go: () => navigate(`/dialogs?dialog_id=${dialog.id}`),
      });
    });

    (messages.data?.items ?? []).forEach((message) => {
      const dirText = resolveEnumLabel(`messageDirection.${message.direction}`, message.direction_label, message.direction);
      items.push({
        key: `message:${message.id}`,
        kind: 'message',
        title: previewText(message.body, 60),
        desc: `${dirText} · ${message.sender_name || t('search.unknownSender')}`,
        icon: <ApiOutlined />,
        go: () => navigate(`/dialogs?dialog_id=${message.dialog_id}`),
      });
    });

    return items;
  }, [accounts.data, dialogs.data, messages.data, isAdmin, navigate, pages, q, t, i18n.language]);

  useEffect(() => {
    setActiveIndex(0);
  }, [debounced]);

  const loading = accounts.loading || dialogs.loading || messages.loading;

  const open_ = (item?: ResultItem) => {
    const target = item ?? results[activeIndex];
    if (!target) return;
    target.go();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open_();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      destroyOnHidden
      className="tg-search-modal"
      styles={{ body: { paddingTop: 'var(--tg-space-md)' } }}
    >
      <Input
        autoFocus
        allowClear
        size="large"
        className="tg-search-input"
        prefix={<SearchOutlined style={{ color: 'var(--tg-color-text-tertiary)' }} />}
        placeholder={t('search.placeholder')}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        onKeyDown={handleKeyDown}
        suffix={loading ? <Spin size="small" /> : null}
      />

      <div className="tg-search-results">
        {!q ? (
          <div className="tg-stack" style={{ gap: 'var(--tg-space-xs)' }}>
            <div className="tg-search-group-title">{t('search.commonPages')}</div>
            {results.map((item, index) => (
              <div
                key={item.key}
                className={['tg-search-item', index === activeIndex ? 'is-active' : ''].filter(Boolean).join(' ')}
                onClick={() => open_(item)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="app-nav-icon" style={{ color: 'var(--tg-color-text-tertiary)' }}>
                  {item.icon}
                </span>
                <div className="tg-search-item-main">
                  <div className="tg-search-item-title">{item.title}</div>
                  {item.desc ? <div className="tg-search-item-desc">{item.desc}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
          <Typography.Text type="secondary" style={{ display: 'block', padding: 'var(--tg-space-xxl) 0', textAlign: 'center' }}>
            {loading ? t('search.searching') : t('search.noResult', { query: q })}
          </Typography.Text>
        ) : (
          results.map((item, index) => (
            <div
              key={item.key}
              className={['tg-search-item', index === activeIndex ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => open_(item)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="app-nav-icon" style={{ color: 'var(--tg-color-text-tertiary)' }}>
                {item.icon}
              </span>
              <div className="tg-search-item-main">
                <div className="tg-search-item-title">{item.title}</div>
                {item.desc ? <div className="tg-search-item-desc">{item.desc}</div> : null}
              </div>
              {item.extra}
              <span className="tg-muted" style={{ fontSize: 'var(--tg-font-size-xs)' }}>
                {t(`search.kinds.${item.kind}`)}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="tg-search-hint">
        <span>
          <span className="tg-kbd">↑</span> <span className="tg-kbd">↓</span> {t('search.hintSelect')}
        </span>
        <span>
          <span className="tg-kbd">Enter</span> {t('search.hintOpen')}
        </span>
        <span>
          <span className="tg-kbd">Esc</span> {t('search.hintClose')}
        </span>
        <span style={{ marginLeft: 'auto' }}>{t('search.hintMinChars')}</span>
      </div>
    </Modal>
  );
}

export default GlobalSearch;
