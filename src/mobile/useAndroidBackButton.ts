import { useEffect } from 'react';
import { App } from '@capacitor/app';
import { isAndroid } from './platform';
import { hasBlockingWindow } from '../utils/keyboardTargets';
import { useAppViewStore } from '../stores/useAppViewStore';
import { closeFoliumHomeTab, useFoliumHomeTabStore } from '../mods/folium/registries/homeTabs';

/**
 * 安卓侧边返回手势 = Esc 逻辑。
 * 注册监听后 Capacitor 默认行为（webView.goBack / 退出应用）被接管，
 * 因此 home 视图下需要显式调用 exitApp()。
 */
export const useAndroidBackButton = ({
    navigateBackFromPlayer,
    navigateBackFromLattice,
}: {
    navigateBackFromPlayer: () => void;
    navigateBackFromLattice: () => void;
}): void => {
    useEffect(() => {
        if (!isAndroid()) return undefined;

        const listenerPromise = App.addListener('backButton', () => {
            const { view, isPanelOpen, setIsPanelOpen } = useAppViewStore.getState();

            // 模组首页页面开着时它声明了 keyboard-window，通用 Esc 判定会让路；
            // 这里直接关页面，和页头那颗返回键同一条路径。
            if (view === 'home' && useFoliumHomeTabStore.getState().activeId !== null) {
                closeFoliumHomeTab();
                return;
            }
            if (hasBlockingWindow()) {
                // 文件头的约定是「安卓返回手势 = Esc 逻辑」：声明了接管键盘的窗口（设置、命令面板等）
                // 在桌面端各自消费 Esc 关闭自己，这里把 Esc 合成给它们走同一条路。
                // 直接 return 会让设置页上的返回手势什么都不做（窗口接管了按键却永远收不到按键）。
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                }));
                return;
            }

            if (isPanelOpen) {
                setIsPanelOpen(false);
                return;
            }

            switch (view) {
                case 'player':
                    navigateBackFromPlayer();
                    break;
                case 'lattice':
                    navigateBackFromLattice();
                    break;
                default:
                    App.exitApp();
                    break;
            }
        });

        return () => {
            void listenerPromise.then(listener => listener.remove());
        };
    }, [navigateBackFromLattice, navigateBackFromPlayer]);
};
