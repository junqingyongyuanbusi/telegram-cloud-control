/**
 * 国家/地区与语言代码的展示名、下拉选项。
 *
 * 名称用浏览器内置的 CLDR（Intl.DisplayNames），不维护国家表；
 * 选项值来自群档案接口的分面（summary.countries / languages），
 * 所以库里有哪个值就能筛哪个，不再写死一份清单。
 */
import i18n from '../i18n';
import type { RegionFacet } from '../api/types';

export interface RegionOption {
  value: string;
  label: string;
}

function displayName(type: 'region' | 'language', code: string): string {
  try {
    const name = new Intl.DisplayNames([i18n.language], { type }).of(code);
    return name && name !== code ? `${name} ${code}` : code;
  } catch {
    return code;
  }
}

export const regionLabel = (code: string) => displayName('region', code);

/** 'unknown' 不是合法语言码，DisplayNames 对它会给出无意义译文，原样展示。 */
export const languageLabel = (code: string) =>
  code === 'unknown' ? code : displayName('language', code);

function options(
  facets: RegionFacet[] | undefined,
  selected: string | undefined,
  labelOf: (code: string) => string,
): RegionOption[] {
  const counts = new Map((facets ?? []).map((item) => [item.value, item.count]));
  // 当前选中的值不在分面里（比如刚清空了数据）也要留在下拉里，否则筛选条件看不见
  if (selected && !counts.has(selected)) counts.set(selected, 0);
  return [...counts.entries()].map(([value, count]) => ({
    value,
    label: count ? `${labelOf(value)} (${count})` : labelOf(value),
  }));
}

export const regionOptions = (facets: RegionFacet[] | undefined, selected?: string) =>
  options(facets, selected, regionLabel);

export const languageOptions = (facets: RegionFacet[] | undefined, selected?: string) =>
  options(facets, selected, languageLabel);
