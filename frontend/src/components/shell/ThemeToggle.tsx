/**
 * ThemeToggle —— 顶栏主题开关（浅色 / 深色 / 跟随系统），localStorage 记忆。
 *
 * props 契约：{ size?: 'sm'|'md' }（可选）
 * 行为：点击弹出菜单；当前项打勾；「跟随系统」时图标随系统明暗变化。
 */
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { BgColorsOutlined, CheckOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme';
import type { ThemePreference } from '../../theme';

export interface ThemeToggleProps {
  size?: 'sm' | 'md';
}

export function ThemeToggle({ size = 'md' }: ThemeToggleProps) {
  const { t } = useTranslation('shell');
  const { preference, mode, setPreference } = useTheme();
  const currentLabel = t(`theme.${preference}`);

  const items: MenuProps['items'] = (['light', 'dark', 'system'] as ThemePreference[]).map((value) => ({
    key: value,
    icon: value === 'light' ? <SunOutlined /> : value === 'dark' ? <MoonOutlined /> : <BgColorsOutlined />,
    label: t(`theme.${value}`),
    onClick: () => setPreference(value),
    extra: preference === value ? <CheckOutlined style={{ color: 'var(--tg-color-primary)' }} /> : null,
  }));

  return (
    <Dropdown menu={{ items, selectedKeys: [preference] }} trigger={['click']} placement="bottomRight">
      <Tooltip title={t('theme.tooltip', { label: currentLabel })}>
        <button
          type="button"
          className="app-icon-button"
          aria-label={t('theme.tooltip', { label: currentLabel })}
          style={size === 'sm' ? { width: 28, height: 28 } : undefined}
        >
          {mode === 'dark' ? <MoonOutlined /> : <SunOutlined />}
        </button>
      </Tooltip>
    </Dropdown>
  );
}

export default ThemeToggle;
