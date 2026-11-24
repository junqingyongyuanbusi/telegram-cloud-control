/**
 * MaterialSelect —— 素材库下拉选择（默认导出，供 Form.Item 直接接管 value/onChange）。
 *
 * 账号改资料、批量改资料、素材群发等表单都从这里选素材；`kinds` 限定可选类型，
 * 只传一种时让后端按 kind 过滤，传多种或省略时取一页全量再在前端筛。
 * 选项文案带上类型标签，避免同名的文字素材和图片素材分不清。
 */
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { materialApi } from '../../api/endpoints';
import { useAsyncData } from '../../hooks/useAsyncData';
import type { MaterialKind } from '../../api/types';

export interface MaterialSelectProps extends Omit<SelectProps, 'options' | 'loading' | 'mode' | 'value' | 'onChange'> {
  /** 只展示这些类型的素材；不传表示全部 */
  kinds?: MaterialKind[];
  value?: string | null;
  onChange?: (value: string | undefined) => void;
}

export default function MaterialSelect({
  kinds,
  placeholder = '选择素材',
  allowClear = true,
  value,
  onChange,
  ...rest
}: MaterialSelectProps) {
  const singleKind = kinds?.length === 1 ? kinds[0] : undefined;
  const materials = useAsyncData(
    () => materialApi.list({ kind: singleKind, page: 1, page_size: 200 }),
    [singleKind],
  );

  const items = materials.data?.items ?? [];
  const visible = singleKind || !kinds?.length ? items : items.filter((item) => kinds.includes(item.kind));
  const options = visible.map((item) => ({
    value: item.id,
    label: `${item.name}（${item.kind_label}）`,
  }));

  return (
    <Select
      showSearch
      optionFilterProp="label"
      {...rest}
      allowClear={allowClear}
      placeholder={placeholder}
      loading={materials.loading}
      options={options}
      value={value ?? undefined}
      onChange={(next) => onChange?.(next ?? undefined)}
      notFoundContent={materials.loading ? undefined : '素材库暂无可用素材'}
    />
  );
}
