/**
 * ConnectionStatus —— 顶栏实时连接状态（WS /api/ws）。
 *
 * props 契约：
 * ┌──────────┬────────────────────────────────────────────────────────────────┐
 * │ status   │ 'connecting'|'open'|'closed'  不传则自己订阅（useWebSocket）    │
 * │ showText │ boolean  是否显示文字，默认 true（窄屏自动只显示圆点）           │
 * └──────────┴────────────────────────────────────────────────────────────────┘
 * 颜色：open=success / connecting=warning / closed=neutral（走 token）
 */
import { Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WsStatus } from '../../api/types';

export interface ConnectionStatusProps {
  status?: WsStatus;
  showText?: boolean;
}

const TONE_CLASS: Record<WsStatus, string> = {
  open: 'is-open',
  connecting: 'is-connecting',
  closed: 'is-closed',
};

const DOT_COLOR: Record<WsStatus, string> = {
  open: 'var(--tg-color-success)',
  connecting: 'var(--tg-color-warning)',
  closed: 'var(--tg-color-neutral)',
};

const HINT_KEY: Record<WsStatus, string> = {
  open: 'ws.hintOpen',
  connecting: 'ws.hintConnecting',
  closed: 'ws.hintClosed',
};

export function ConnectionStatus({ status: statusProp, showText = true }: ConnectionStatusProps) {
  const { t } = useTranslation('shell');
  // 始终以 enabled=true 订阅：wsClient 是单例，重复调用只会复用同一条连接；
  // 传 status 只是让外壳把状态透传下来（避免每个顶栏组件各自 setState）。
  const hook = useWebSocket(true);
  const status = statusProp ?? hook.status;
  const statusText = t(`ws.${status}`);

  return (
    <Tooltip title={`${statusText} (${t(HINT_KEY[status])})`}>
      <span className={`app-conn ${TONE_CLASS[status]}`} role="status" aria-live="polite">
        <span
          className={['tg-status-dot', status === 'connecting' ? 'is-pulse' : ''].filter(Boolean).join(' ')}
          style={{ width: 7, height: 7, background: DOT_COLOR[status], color: DOT_COLOR[status] }}
        />
        {showText ? <span className="app-conn-text">{statusText}</span> : null}
      </span>
    </Tooltip>
  );
}

export default ConnectionStatus;
