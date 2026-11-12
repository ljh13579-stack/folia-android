// Folia Android 适配层：统一平台探测
// 项目原有约定是 `Boolean(window.electron)` 区分 Electron/Web，本模块新增第三个运行时分支：Capacitor 原生容器。
import { Capacitor } from '@capacitor/core';

/** 是否运行在 Capacitor 原生容器（Android/iOS WebView）中 */
export const isNativeMobile = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** 是否运行在 Android 上 */
export const isAndroid = (): boolean => {
  try {
    return Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
};

/** 是否运行在 Android 竖屏下（手机竖屏 UI 分支共用这一个判定） */
export const isAndroidPortrait = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.innerHeight > window.innerWidth && isAndroid();
};

/** Electron 渲染进程（沿用项目原有判定方式） */
export const isElectronRuntime = (): boolean =>
  typeof window !== 'undefined' && Boolean((window as any).electron);

/** 当前运行平台 */
export type FoliaPlatform = 'electron' | 'capacitor' | 'web';

export const getFoliaPlatform = (): FoliaPlatform => {
  if (isElectronRuntime()) return 'electron';
  if (isNativeMobile()) return 'capacitor';
  return 'web';
};
