import type { LocalSong } from '../types';
import { isValidLocalCoverAssetId, isLocalCoverWebRuntimeSupported, readLocalCoverBinary } from './localCoverBinaryStore';
import { getSizedCoverUrl } from '../utils/coverUrl';
import { isNativeMobile } from '../mobile/platform';
import { createSafeObjectUrl } from '../utils/blobGuards';

// src/services/localCoverAssetUrl.ts
// Resolves content-addressed local covers to stable Electron or same-origin Web resource URLs.

const WEB_COVER_PATH_PREFIX = '/__folia_cover/';

// Capacitor 分支：SW 路由 /__folia_cover/ 在原生容器中不可靠（WebView 资源加载被
// Capacitor 本地服务器接管，不经过 Service Worker），改为 OPFS 读取 + blob URL 缓存。
// getLocalCoverAssetUrl 必须保持同步签名（十余处渲染路径直接调用），未水合时返回 null
// 并后台补水，完成后广播本地音乐更新事件触发一次重渲染（与封面迁移完成时同一事件）。
const MOBILE_COVER_CACHE_LIMIT = 300;
const mobileCoverUrlCache = new Map<string, string>();
const mobileCoverHydrationPending = new Set<string>();
let mobileHydratedFlushScheduled = false;

/** 多次水合完成合并为一次广播，避免滚动时连续整库重渲染 */
const scheduleMobileHydratedBroadcast = (): void => {
  if (mobileHydratedFlushScheduled) return;
  mobileHydratedFlushScheduled = true;
  setTimeout(() => {
    mobileHydratedFlushScheduled = false;
    window.dispatchEvent(new CustomEvent('folia-local-music-updated'));
  }, 250);
};

const cacheMobileCoverUrl = (assetId: string, url: string): void => {
  mobileCoverUrlCache.delete(assetId);
  mobileCoverUrlCache.set(assetId, url);
  while (mobileCoverUrlCache.size > MOBILE_COVER_CACHE_LIMIT) {
    const oldest = mobileCoverUrlCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = mobileCoverUrlCache.get(oldest);
    mobileCoverUrlCache.delete(oldest);
    if (evicted) URL.revokeObjectURL(evicted);
  }
};

const hydrateMobileCoverUrl = (assetId: string): void => {
  if (mobileCoverHydrationPending.has(assetId)) return;
  mobileCoverHydrationPending.add(assetId);
  void readLocalCoverBinary(assetId)
    .then(blob => {
      if (!blob) return;
      const url = createSafeObjectUrl(blob);
      if (!url) return;
      cacheMobileCoverUrl(assetId, url);
      scheduleMobileHydratedBroadcast();
    })
    .catch(error => {
      console.warn('[LocalCover] Mobile cover hydration failed:', assetId, error);
    })
    .finally(() => {
      mobileCoverHydrationPending.delete(assetId);
    });
};

const hasElectronCoverProtocol = (): boolean => (
  typeof window !== 'undefined' && typeof window.electron?.hasLocalCoverAsset === 'function'
);

export const getLocalCoverAssetUrl = (assetId: string | undefined, size?: number): string | null => {
  if (!isValidLocalCoverAssetId(assetId)) return null;
  let url: string;
  if (hasElectronCoverProtocol()) {
    url = `folia-cover://asset/${encodeURIComponent(assetId)}`;
  } else if (isNativeMobile()) {
    const cached = mobileCoverUrlCache.get(assetId);
    if (!cached) {
      hydrateMobileCoverUrl(assetId);
      return null;
    }
    // 触顶 LRU：命中后移到最新
    mobileCoverUrlCache.delete(assetId);
    mobileCoverUrlCache.set(assetId, cached);
    url = cached;
  } else {
    if (!isLocalCoverWebRuntimeSupported()) return null;
    url = `${WEB_COVER_PATH_PREFIX}${encodeURIComponent(assetId)}`;
  }
  return size ? getSizedCoverUrl(url, size) : url;
};

export const isLocalCoverAssetUrl = (url: string | null | undefined): url is string => (
  typeof url === 'string'
  && (url.startsWith('folia-cover://asset/') || url.startsWith(WEB_COVER_PATH_PREFIX))
);

export const getPreferredLocalSongCoverUrl = (song: LocalSong): string | null => {
  const localCoverUrl = getLocalCoverAssetUrl(song.localCoverAssetId, 1024);
  return song.useOnlineCover
    ? song.onlineMetadata?.coverUrl || localCoverUrl
    : localCoverUrl || song.onlineMetadata?.coverUrl || null;
};
