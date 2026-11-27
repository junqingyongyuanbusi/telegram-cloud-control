/**
 * LanguageToggle —— 顶栏语言切换按钮（简体中文 / English），紧邻 ThemeToggle。
 *
 * 交互与样式与 ThemeToggle 保持一致：app-icon-button + Dropdown 下拉菜单 + 当前项打勾。
 */
import { useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, TranslationOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LOCALES, normalizeLocale, setLocale, type SupportedLocale } from '../../i18n';

export interface LanguageToggleProps {
  size?: 'sm' | 'md';
}

const LOCALE_BADGE: Record<SupportedLocale, string> = {
  'zh-CN': '中',
  'en-US': 'EN',
};

export function LanguageToggle({ size = 'md' }: LanguageToggleProps) {
  const { t, i18n } = useTranslation('shell');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const current = normalizeLocale(i18n.language);
  const currentLabel = t(`language.${current}`);

  const items: MenuProps['items'] = SUPPORTED_LOCALES.map((locale) => ({
    key: locale,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tg-color-text-tertiary)',
          }}
        >
          {LOCALE_BADGE[locale]}
        </span>
        <span>{t(`language.${locale}`)}</span>
      </span>
    ),
    onClick: () => {
      setLocale(locale);
      setDropdownOpen(false);
    },
    extra: current === locale ? <CheckOutlined style={{ color: 'var(--tg-color-primary)' }} /> : null,
  }));

  return (
    <Dropdown
      open={dropdownOpen}
      onOpenChange={setDropdownOpen}
      menu={{ items, selectedKeys: [current] }}
      trigger={['click']}
      placement="bottomRight"
    >
      <Tooltip title={t('language.tooltip', { label: currentLabel })} open={dropdownOpen ? false : undefined}>
        <button
          type="button"
          className="app-icon-button"
          aria-label={t('language.ariaLabel', { label: currentLabel })}
          data-testid="language-toggle"
          style={size === 'sm' ? { width: 28, height: 28 } : undefined}
        >
          <TranslationOutlined />
        </button>
      </Tooltip>
    </Dropdown>
  );
}

export default LanguageToggle;
