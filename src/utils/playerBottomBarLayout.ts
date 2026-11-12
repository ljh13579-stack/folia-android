// src/utils/playerBottomBarLayout.ts
// 全局底部基线的共享几何：播放条、歌曲卡、操作按钮、侧边面板和播放页字幕
// 原本各自写死 bottom 值，这里把用户调整产生的抬升量收敛成一处可计算的偏移量。

/** 现有 `bottom-8`，同时是偏移量的下限：用户只能往上抬，不能压得比现状更低。 */
export const PLAYER_BOTTOM_BAR_BASE_OFFSET_PX = 32;

/**
 * 读取 CSS 安全区变量（由 Capacitor SystemBars 插件注入）。
 * 返回 0 表示无安全区（桌面端或不支持的环境）。
 */
const readSafeAreaInsetBottom = (): number => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return 0;
    }
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--safe-area-inset-bottom')
        .trim();
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 底部基线是否应叠加安全区：仅 Android 竖屏下需要避开手势导航条。
 * 横屏或桌面端不需要，保持原有行为。
 */
const shouldApplySafeArea = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }
    // 竖屏判定：高度大于宽度
    const isPortrait = window.innerHeight > window.innerWidth;
    // 仅 Android 需要（iOS 的 Capacitor 处理不同，且当前主要面向 Android）
    const platformAndroid = typeof (window as any).Capacitor !== 'undefined'
        && (window as any).Capacitor.getPlatform?.() === 'android';
    return isPortrait && platformAndroid;
};

/**
 * 获取当前生效的底部基线偏移量。
 * Android 竖屏下会叠加安全区底部 inset，避免被手势导航条遮挡。
 */
export const getEffectiveBottomBarBaseOffsetPx = (): number => {
    if (!shouldApplySafeArea()) {
        return PLAYER_BOTTOM_BAR_BASE_OFFSET_PX;
    }
    return PLAYER_BOTTOM_BAR_BASE_OFFSET_PX + readSafeAreaInsetBottom();
};

/**
 * 字幕层原本硬编码的 `112` 减去基线 `32`，即胶囊之上要留出的净空。
 * 抽出来是为了让字幕跟着基线走，而不是继续和一个魔数绑死。
 */
export const PLAYER_BOTTOM_BAR_SUBTITLE_CLEARANCE_PX = 80;

/** 展开态胶囊的高度预留（标题行 + 48px 播放按钮行 + 进度行 + p-3），用于算上限。 */
const EXPANDED_CAPSULE_HEIGHT_PX = 132;

/**
 * 偏移量上限：胶囊顶边不越过半屏。
 * 矮视口下 `viewportHeight/2 - 胶囊高度` 可能小于基线，此时上限塌回基线，range 变成一个点。
 */
export const resolvePlayerBottomBarMaxOffset = (viewportHeightPx: number): number => {
    const baseOffset = getEffectiveBottomBarBaseOffsetPx();
    if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) {
        return baseOffset;
    }
    return Math.max(
        baseOffset,
        Math.round(viewportHeightPx * 0.5 - EXPANDED_CAPSULE_HEIGHT_PX),
    );
};

/** 把偏移量夹进 [基线, 上限]；非有限值一律退回基线。 */
export const clampPlayerBottomBarOffset = (offsetPx: number, viewportHeightPx: number): number => {
    const baseOffset = getEffectiveBottomBarBaseOffsetPx();
    if (!Number.isFinite(offsetPx)) {
        return baseOffset;
    }
    const max = resolvePlayerBottomBarMaxOffset(viewportHeightPx);
    return Math.min(max, Math.max(baseOffset, Math.round(offsetPx)));
};

/** 保留组件原有底距，只叠加全局基线相对默认值的抬升量。 */
export const resolvePlayerBottomComponentBottomPx = (
    globalOffsetPx: number,
    componentBaseBottomPx: number,
): number => componentBaseBottomPx + globalOffsetPx - getEffectiveBottomBarBaseOffsetPx();

/**
 * 字幕层的 bottom，把「控制条在不在」表达成 0..1 的连续量，好让这一段单独走 spring。
 *
 * 拖动改的是 offsetPx，要跟手；控制条出现/消失改的是 presence，要平滑。
 * 两者混在一个 spring 里的话，拖动会被阻尼拖慢，和另外三个硬跟手的组件脱节。
 *
 * presence 为 1 等同于控制条在场，0 等同于不在场，中间值是过渡中的插值。
 */
export const resolvePlayerSubtitleBottomFromPresence = (
    offsetPx: number,
    controlBarPresence: number,
): number => {
    const baseOffset = getEffectiveBottomBarBaseOffsetPx();
    return baseOffset
        + controlBarPresence * (
            (offsetPx - baseOffset) + PLAYER_BOTTOM_BAR_SUBTITLE_CLEARANCE_PX
        );
};

/** 控制条在场时字幕离底边的距离：基线 32 加净空 80，即原来的 112。 */
export const PLAYER_SUBTITLE_BOTTOM_PX = PLAYER_BOTTOM_BAR_BASE_OFFSET_PX + PLAYER_BOTTOM_BAR_SUBTITLE_CLEARANCE_PX;

/**
 * 缩放舞台上要给字幕层的底栏偏移量，让控制条在场时字幕离框底的距离是 distancePx（框内像素）。
 * 预览把整页按 scale 缩小画进框里，而盖在上面的底栏（Theme Park 的歌曲卡）不缩小：
 * 舞台上的 112 缩到框里只剩 112 × scale，字幕就落到底栏后面，所以那里由预览自己给出框内的距离。
 * 没有底栏的预览（歌词样式窗口）取 112 × 放大前的缩放比例，字幕停在不放大时的位置。
 * belowBoxPx 是舞台底边被裁在框底之下的那一截（框内像素），放大裁切时字幕要多抬这么多。
 */
export const resolveUnscaledSubtitleBarOffset = (scale: number, belowBoxPx = 0, distancePx = PLAYER_SUBTITLE_BOTTOM_PX): number => (
    (distancePx + belowBoxPx) / scale
    - PLAYER_BOTTOM_BAR_SUBTITLE_CLEARANCE_PX
);
