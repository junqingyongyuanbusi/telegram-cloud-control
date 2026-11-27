/**
 * Forbidden —— 403 页：operator 访问管理员专属地址时，在外壳内给中文提示。
 *
 * 只做页面级拦截（不请求接口）；真正的鉴权仍由后端 403 兜底。
 * 路由层用法见 AppShell 的 <RequireAdmin> / <AdminHome>。
 */
import { Button } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PageContainer from './PageContainer';
import SectionCard from './SectionCard';
import ErrorState from './ErrorState';
import { OPERATOR_HOME } from './shell/navAccess';

export interface ForbiddenProps {
  title?: string;
  description?: string;
}

export function Forbidden({ title, description }: ForbiddenProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  return (
    <PageContainer title={t('forbidden.pageTitle')} description={t('forbidden.pageDesc')}>
      <SectionCard>
        <ErrorState
          title={title ?? t('forbidden.title')}
          description={description ?? t('forbidden.description')}
          extra={
            <Button type="primary" icon={<ArrowLeftOutlined />} onClick={() => navigate(OPERATOR_HOME)}>
              {t('forbidden.backToTasks')}
            </Button>
          }
          compact
        />
      </SectionCard>
    </PageContainer>
  );
}

export default Forbidden;
