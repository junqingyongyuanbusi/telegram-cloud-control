/**
 * JsonBlock —— 详情里的格式化 JSON 块（等宽字体 + 复制按钮 + 超长滚动）。
 * 任务详情（payload/result）与审计详情（detail JSON）共用。
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Tooltip } from 'antd';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { copyText } from '../../utils/download';
import { stringifyDetail } from '../../utils/format';
import { toast } from '../../utils/feedback';

interface JsonBlockProps {
  title?: ReactNode;
  value: unknown;
  emptyText?: string;
  maxHeight?: number;
  style?: CSSProperties;
  className?: string;
}

export function JsonBlock({
  title,
  value,
  emptyText,
  maxHeight = 320,
  style,
  className,
}: JsonBlockProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [copied, setCopied] = useState(false);
  const text = stringifyDetail(value);
  const resolvedEmptyText = emptyText ?? t('tasks:jsonBlock.empty');

  const handleCopy = async () => {
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      toast.success(t('common:copied'));
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error(t('common:copyFailed'));
    }
  };

  return (
    <div className={['tg-json-block', className].filter(Boolean).join(' ')} style={style}>
      <div className="tg-json-block-head">
        {title ? <span className="tg-json-block-title">{title}</span> : null}
        {text ? (
          <Tooltip title={t('tasks:jsonBlock.copyFull')}>
            <Button
              type="text"
              size="small"
              icon={copied ? <CheckOutlined style={{ color: 'var(--tg-color-success)' }} /> : <CopyOutlined />}
              onClick={() => void handleCopy()}
              aria-label={title ? t('tasks:jsonBlock.copyNamed', { title: String(title) }) : t('common:copy')}
            />
          </Tooltip>
        ) : null}
      </div>
      <pre className="tg-json-block-body" style={{ maxHeight }}>
        {text || resolvedEmptyText}
      </pre>
    </div>
  );
}
