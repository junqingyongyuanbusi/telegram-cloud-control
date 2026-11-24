/**
 * MaterialThumb —— 素材库列表里的缩略图。
 *
 * 媒体文件接口要带 `Authorization`，`<img src>` 带不了，所以先 fetch 成 blob 再转
 * objectURL（与 AccountAvatar 同一套路）；按素材 id 缓存，列表滚动不重复拉。
 * 图片以外的类型没有可渲染的预览，按类型显示图标。
 */
import { FileOutlined, FileTextOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { getToken } from '../../api/client';
import type { MaterialKind, UUID } from '../../api/types';

/** 同一次会话内缓存；null 表示拉取失败，避免反复请求 */
const cache = new Map<string, string | null>();

export interface MaterialThumbProps {
  materialId: UUID;
  kind: MaterialKind;
  alt?: string;
  /** 边长（像素） */
  size?: number;
}

export default function MaterialThumb({ materialId, kind, alt, size = 40 }: MaterialThumbProps) {
  const isPhoto = kind === 'photo';
  const [url, setUrl] = useState<string | null>(() => cache.get(materialId) ?? null);

  useEffect(() => {
    if (!isPhoto) return;
    const hit = cache.get(materialId);
    if (hit !== undefined) {
      setUrl(hit);
      return;
    }
    let alive = true;
    const token = getToken();
    void fetch(`/api/materials/${materialId}?download=true`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        cache.set(materialId, objectUrl);
        if (alive) setUrl(objectUrl);
      })
      .catch(() => {
        cache.set(materialId, null);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [materialId, isPhoto]);

  if (isPhoto && url) {
    return (
      <img
        src={url}
        alt={alt ?? ''}
        title={alt}
        width={size}
        height={size}
        style={{ objectFit: 'cover', borderRadius: 6, display: 'block', background: 'rgba(0, 0, 0, 0.04)' }}
      />
    );
  }

  const Icon = kind === 'video' ? PlayCircleOutlined : kind === 'document' ? FileOutlined : FileTextOutlined;
  return (
    <span
      title={alt}
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.04)',
        color: 'rgba(0, 0, 0, 0.45)',
        fontSize: size * 0.45,
      }}
    >
      <Icon />
    </span>
  );
}
