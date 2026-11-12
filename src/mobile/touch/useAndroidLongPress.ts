import { useCallback, useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import { isAndroid } from '../platform';
import {
    LONG_PRESS_ANCHOR_ATTRIBUTE,
    createLongPressTracker,
    type FoliaLongPressAction,
    type LongPressOrigin,
} from '../../utils/longPressGesture';

// src/mobile/touch/useAndroidLongPress.ts
// 元素级的长按：贴在一个元素上，按住 400ms 就回调一次。
//
// 和 useAndroidTouchShortcuts 那个应用级委托层的分工是：这里处理「动作需要组件自己的
// 闭包」的锚点（胶囊展开要 setIsHovered、进度条 seek 要 onSeek / currentTime），委托层
// 处理够得着 store 或 App 级回调的锚点。委托层看到本 hook 打在元素上的
// data-folia-long-press 标记会让路，所以两者不会有同一次长按被两处接管的情况。
//
// 只回调「长按完成」这一个离散事件，按下 / 移动 / 抬起全在 ref 和计时器里，不进 React。
//
// 不 setPointerCapture、不在 pointerdown 上 preventDefault、不改 touch-action：这几样都会
// 破坏同一元素上既有的滚动与拖拽（胶囊的定位拖拽、进度条 range input 的拖动 seek）。
// 代价是进度条的 range input 会在 pointerdown 里捕获指针，之后的 move/up 不再冒泡到外层
// 容器，所以移动与抬起除了元素自身的处理器，还会挂一份 window 监听兜底 —— 指针被谁捕获
// 都不影响这一轮长按的取消。

/** 长按完成时交给调用方的东西：命中的动作、元素、以及落点坐标。 */
export type AndroidLongPressContext = {
    action: FoliaLongPressAction | string;
    element: Element;
    x: number;
    y: number;
};

type UseAndroidLongPressOptions = {
    action: FoliaLongPressAction | string;
    /** 默认只在 Android 原生容器里生效。调用方可以再用业务状态收窄（比如只在折叠态）。 */
    enabled?: boolean;
    onLongPress: (context: AndroidLongPressContext) => void;
    onCancel?: () => void;
    /**
     * 长按后要不要吃掉随之而来的那一次 click。默认吃 —— 长按是个完整手势，
     * 不该在手指抬起时再顺带触发元素原本的点击（胶囊会导航到播放页、手柄会开关面板）。
     */
    suppressClick?: boolean;
};

export const useAndroidLongPress = ({
    action,
    enabled,
    onLongPress,
    onCancel,
    suppressClick = true,
}: UseAndroidLongPressOptions) => {
    const platformAndroid = useMemo(() => isAndroid(), []);
    const active = enabled ?? platformAndroid;

    // 回调存 ref：它们每次渲染都是新的闭包，但不该让监听器跟着解绑重绑。
    const onLongPressRef = useRef(onLongPress);
    onLongPressRef.current = onLongPress;
    const onCancelRef = useRef(onCancel);
    onCancelRef.current = onCancel;

    const elementRef = useRef<Element | null>(null);
    // 「这一轮长按已经满过」：click 在 pointerup 之后才派发，用它决定要不要吃掉。
    const didFireRef = useRef(false);

    const tracker = useMemo(
        () => createLongPressTracker({
            onFire: (origin: LongPressOrigin) => {
                didFireRef.current = true;
                const element = elementRef.current;
                if (element) {
                    onLongPressRef.current({ action, element, x: origin.x, y: origin.y });
                }
            },
            onCancel: () => onCancelRef.current?.(),
        }),
        [action],
    );

    // 一轮长按活跃期间挂上的兜底监听：指针被 range input 捕获时，元素自身的
    // pointerup / pointermove 收不到，这几条就是用来补上取消与位移判定的。
    useEffect(() => {
        if (!active || typeof window === 'undefined') {
            return undefined;
        }

        const handleMove = (event: PointerEvent) => tracker.move(event.pointerId, event.clientX, event.clientY);
        const handleRelease = () => tracker.cancel();
        // 第二根手指落下：这一轮作废，避免两指各自计时。
        const handleExtraDown = () => {
            if (tracker.isActive()) {
                tracker.cancel();
            }
        };
        const handleVisibility = () => {
            if (document.visibilityState !== 'visible') {
                tracker.cancel();
            }
        };

        window.addEventListener('pointermove', handleMove, { capture: true, passive: true });
        window.addEventListener('pointerup', handleRelease, { capture: true, passive: true });
        window.addEventListener('pointercancel', handleRelease, { capture: true, passive: true });
        window.addEventListener('pointerdown', handleExtraDown, { capture: true, passive: true });
        window.addEventListener('scroll', handleRelease, { capture: true, passive: true });
        window.addEventListener('blur', handleRelease);
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            window.removeEventListener('pointermove', handleMove, { capture: true });
            window.removeEventListener('pointerup', handleRelease, { capture: true });
            window.removeEventListener('pointercancel', handleRelease, { capture: true });
            window.removeEventListener('pointerdown', handleExtraDown, { capture: true });
            window.removeEventListener('scroll', handleRelease, { capture: true });
            window.removeEventListener('blur', handleRelease);
            document.removeEventListener('visibilitychange', handleVisibility);
            tracker.cancel();
        };
    }, [active, tracker]);

    const handlePointerDown = useCallback((event: React.PointerEvent) => {
        if (!active || event.pointerType !== 'touch') {
            return;
        }
        elementRef.current = event.currentTarget;
        didFireRef.current = false;
        tracker.start({ pointerId: event.pointerId, x: event.clientX, y: event.clientY });
    }, [active, tracker]);

    const handlePointerMove = useCallback((event: React.PointerEvent) => {
        tracker.move(event.pointerId, event.clientX, event.clientY);
    }, [tracker]);

    // 事件参数用不上，但保留形参：调用方常把它和 setPointerCapture 那类处理器并排组合，
    // 统一签名能免掉一层 `() =>` 包装。
    const handlePointerRelease = useCallback((_event?: React.PointerEvent) => tracker.cancel(), [tracker]);

    const handleClickCapture = useCallback((event: React.MouseEvent) => {
        if (!didFireRef.current) {
            return;
        }
        didFireRef.current = false;
        if (suppressClick) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, [suppressClick]);

    // 给调用方直接铺开的一包 props。动作 id 同时是给委托层的让路标记。
    const longPressProps = useMemo(() => ({
        [LONG_PRESS_ANCHOR_ATTRIBUTE]: action,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerRelease,
        onPointerCancel: handlePointerRelease,
        onClickCapture: handleClickCapture,
    }), [action, handleClickCapture, handlePointerDown, handlePointerMove, handlePointerRelease]);

    return { longPressProps, isLongPressEnabled: active };
};
