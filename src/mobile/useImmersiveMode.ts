// src/mobile/useImmersiveMode.ts
// Android 沉浸模式：active 时隐藏状态栏与手势导航条（全屏视频应用同款行为，
// 从屏幕边缘滑动可临时唤出，几秒后自动收回），离开时恢复。
//
// SystemBars 是 Capacitor 8 核心插件（@capacitor/core 导出），无需额外原生代码。
// 隐藏后 --safe-area-inset-* 随 insetsHandling:'css' 配置归零，底部基线等布局
// 自动让出空间；targetSdk 36 下 WebView 本就是 edge-to-edge 绘制，不会产生残留黑条。
import { useEffect, useRef } from 'react';
import { SystemBars } from '@capacitor/core';
import { isAndroid } from './platform';

export const useImmersiveMode = (active: boolean): void => {
    // 恢复系统栏的原生动画如果和视图切换（首页淡入）落在同一帧，insets 回调会触发一轮
    // 全局 style recalc。延迟 300ms（等首页淡入 250ms 结束后再恢复）避开竞争。
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!isAndroid()) return;
        if (showTimerRef.current) {
            clearTimeout(showTimerRef.current);
            showTimerRef.current = null;
        }
        if (active) {
            void SystemBars.hide().catch(() => undefined);
        } else {
            showTimerRef.current = setTimeout(() => {
                void SystemBars.show().catch(() => undefined);
                showTimerRef.current = null;
            }, 300);
        }
    }, [active]);
};

export default useImmersiveMode;
