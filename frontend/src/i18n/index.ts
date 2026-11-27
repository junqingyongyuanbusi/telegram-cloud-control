/**
 * i18n 运行时（i18next + react-i18next）：支持简体中文（zh-CN）与英语（en-US）。
 *
 * - 持久化键：tgcc_locale（localStorage），支持多标签页同步；
 * - 切换语言时同步更新 dayjs.locale、<html lang> 与 document.title；
 * - 默认命名空间为 common，模块按 domain 拆分。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';

import zhCommon from './locales/zh-CN/common.json';
import zhShell from './locales/zh-CN/shell.json';
import zhEnums from './locales/zh-CN/enums.json';
import zhApi from './locales/zh-CN/api.json';
import zhLogin from './locales/zh-CN/login.json';
import zhDashboard from './locales/zh-CN/dashboard.json';
import zhAccounts from './locales/zh-CN/accounts.json';
import zhGroups from './locales/zh-CN/groups.json';
import zhNetwork from './locales/zh-CN/network.json';
import zhDialogs from './locales/zh-CN/dialogs.json';
import zhGroupIntel from './locales/zh-CN/groupIntel.json';
import zhTasks from './locales/zh-CN/tasks.json';
import zhCampaigns from './locales/zh-CN/campaigns.json';
import zhAssignments from './locales/zh-CN/assignments.json';
import zhAudit from './locales/zh-CN/audit.json';

import enCommon from './locales/en-US/common.json';
import enShell from './locales/en-US/shell.json';
import enEnums from './locales/en-US/enums.json';
import enApi from './locales/en-US/api.json';
import enLogin from './locales/en-US/login.json';
import enDashboard from './locales/en-US/dashboard.json';
import enAccounts from './locales/en-US/accounts.json';
import enGroups from './locales/en-US/groups.json';
import enNetwork from './locales/en-US/network.json';
import enDialogs from './locales/en-US/dialogs.json';
import enGroupIntel from './locales/en-US/groupIntel.json';
import enTasks from './locales/en-US/tasks.json';
import enCampaigns from './locales/en-US/campaigns.json';
import enAssignments from './locales/en-US/assignments.json';
import enAudit from './locales/en-US/audit.json';

export const LOCALE_STORAGE_KEY = 'tgcc_locale';

export type SupportedLocale = 'zh-CN' | 'en-US';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['zh-CN', 'en-US'];

export function normalizeLocale(raw?: string | null): SupportedLocale {
  if (!raw) return 'zh-CN';
  const lower = raw.toLowerCase();
  if (lower.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

export function readStoredLocale(): SupportedLocale {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'zh-CN' || raw === 'en-US') return raw;
  } catch {
    /* 隐私模式或无 localStorage 时回退默认中文 */
  }
  return 'zh-CN';
}

export function storeLocale(locale: SupportedLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 忽略 */
  }
}

export function isEnglish(locale: string = i18n.language): boolean {
  return normalizeLocale(locale) === 'en-US';
}

function syncSideEffects(locale: SupportedLocale): void {
  dayjs.locale(locale === 'en-US' ? 'en' : 'zh-cn');
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'en-US' ? 'en' : 'zh-CN';
    const title = i18n.t('common:appTitle');
    if (title && title !== 'appTitle') document.title = title;
  }
}

export const resources = {
  'zh-CN': {
    common: zhCommon,
    shell: zhShell,
    enums: zhEnums,
    api: zhApi,
    login: zhLogin,
    dashboard: zhDashboard,
    accounts: zhAccounts,
    groups: zhGroups,
    network: zhNetwork,
    dialogs: zhDialogs,
    groupIntel: zhGroupIntel,
    tasks: zhTasks,
    campaigns: zhCampaigns,
    assignments: zhAssignments,
    audit: zhAudit,
  },
  'en-US': {
    common: enCommon,
    shell: enShell,
    enums: enEnums,
    api: enApi,
    login: enLogin,
    dashboard: enDashboard,
    accounts: enAccounts,
    groups: enGroups,
    network: enNetwork,
    dialogs: enDialogs,
    groupIntel: enGroupIntel,
    tasks: enTasks,
    campaigns: enCampaigns,
    assignments: enAssignments,
    audit: enAudit,
  },
} as const;

const initialLocale = readStoredLocale();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  ns: [
    'common',
    'shell',
    'enums',
    'api',
    'login',
    'dashboard',
    'accounts',
    'groups',
    'network',
    'dialogs',
    'groupIntel',
    'tasks',
    'campaigns',
    'assignments',
    'audit',
  ],
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

syncSideEffects(initialLocale);

i18n.on('languageChanged', (lng) => {
  const normalized = normalizeLocale(lng);
  storeLocale(normalized);
  syncSideEffects(normalized);
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = readStoredLocale();
    if (normalizeLocale(i18n.language) !== next) {
      void i18n.changeLanguage(next);
    }
  });
}

export function setLocale(locale: SupportedLocale): void {
  const next = normalizeLocale(locale);
  if (normalizeLocale(i18n.language) !== next) {
    void i18n.changeLanguage(next);
  }
}

export function getLocale(): SupportedLocale {
  return normalizeLocale(i18n.language);
}

/**
 * 枚举标签解析：中文模式优先用后端下发的 *_label（若非空），英文模式优先走前端 i18n 字典，
 * 避免切换英文后表格和抽屉里依然残留后端写死的中文标签。
 */
export function resolveEnumLabel(
  nsKey: string,
  backendLabel?: string | null,
  fallback = '',
): string {
  const hasTranslation = i18n.exists(`enums:${nsKey}`);
  if (isEnglish()) {
    if (hasTranslation) return i18n.t(`enums:${nsKey}`);
    return backendLabel || fallback;
  }
  if (backendLabel) return backendLabel;
  if (hasTranslation) return i18n.t(`enums:${nsKey}`);
  return fallback;
}

export default i18n;
