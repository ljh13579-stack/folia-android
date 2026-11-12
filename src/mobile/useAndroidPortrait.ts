// src/mobile/useAndroidPortrait.ts
// isAndroidPortrait() 的响应式版本：渲染分支订阅它之后，旋转屏幕会自动重渲染。
// isAndroid() 在 App 生命周期内不变，只需订阅 (orientation: portrait) 的匹配变化。
import { useMediaQuery } from '../hooks/useMediaQuery';
import { isAndroid } from './platform';

export const useAndroidPortrait = (): boolean => {
  const isPortrait = useMediaQuery('(orientation: portrait)');
  return isPortrait && isAndroid();
};

export default useAndroidPortrait;
