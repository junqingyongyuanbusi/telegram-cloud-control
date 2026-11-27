/**
 * ErrorState —— 统一失败态（绝不白屏）。
 *
 * props 契约：
 * ┌─────────────┬───────────────────────────────────────────────────────────┐
 * │ title       │ ReactNode  默认「加载失败」                                │
 * │ description │ ReactNode  默认「后端接口没有返回数据，请重试…」             │
 * │ error       │ string|null 具体错误（ApiError.message，已是中文）           │
 * │ onRetry     │ () => void 传了就显示「重试」按钮                           │
 * │ extra       │ ReactNode  额外操作（如「返回工作台」）                      │
 * │ compact     │ boolean    卡片内嵌小尺寸                                   │
 * │ className   │ string                                                      │
 * └─────────────┴───────────────────────────────────────────────────────────┘
 */
import type { CSSProperties, ReactNode } from 'react';
import { Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import EmptyState from './EmptyState';

export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  error?: string | null;
  onRetry?: () => void;
  retryText?: string;
  extra?: ReactNode;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function ErrorState({
  title,
  description,
  error,
  onRetry,
  retryText,
  extra,
  compact = false,
  className,
  style,
}: ErrorStateProps) {
  const { t } = useTranslation('common');
  return (
    <div className={['tg-error-state', className].filter(Boolean).join(' ')} style={style}>
      <EmptyState
        art="error"
        compact={compact}
        title={title ?? t('loadFailed')}
        description={
          description ?? (
            <span>
              {t('loadFailedDesc')}
              {error ? <span className="tg-break"> ({error})</span> : null}
            </span>
          )
        }
        action={
          onRetry ? (
            <Button icon={<ReloadOutlined />} onClick={onRetry}>
              {retryText ?? t('retry')}
            </Button>
          ) : undefined
        }
        secondaryAction={extra}
      />
    </div>
  );
}

export default ErrorState;
