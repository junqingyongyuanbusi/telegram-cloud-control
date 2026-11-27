/**
 * NotFound —— 404 兜底页（在外壳里渲染，不会白屏，也不会把人甩回登录页）。
 *
 * props 契约：{ pathname?: string; onBack?: () => void }
 */
import { Button } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { HomeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import EmptyState from './EmptyState';

export interface NotFoundProps {
  pathname?: string;
  onBack?: () => void;
}

export function NotFound({ pathname, onBack }: NotFoundProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const current = pathname ?? location.pathname;
  return (
    <div className="tg-page">
      <div className="tg-card" style={{ padding: 'var(--tg-space-xl)' }}>
        <EmptyState
          art="search"
          title={t('notFoundTitle')}
          description={
            <>
              {t('notFoundDescPrefix')}
              <code className="tg-mono">{current}</code>
              {t('notFoundDescSuffix')}
            </>
          }
          action={
            <Button
              type="primary"
              icon={<HomeOutlined />}
              onClick={() => {
                if (onBack) onBack();
                else navigate('/');
              }}
            >
              {t('backToDashboard')}
            </Button>
          }
        />
      </div>
    </div>
  );
}

export default NotFound;
