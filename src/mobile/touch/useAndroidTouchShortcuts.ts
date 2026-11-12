import { useEffect, useRef } from 'react';
import { isAndroid } from '../platform';
import {
    openCommandPalette,
    openCommandPaletteCommand,
    setIsPanelOpen,
    useAppViewStore,
} from '../../stores/useAppViewStore';
import { useInteractionSettingsStore } from '../../stores/useInteractionSettingsStore';
import { resolvePlayerEscapeAction } from '../../components/app/playback/bridges/usePlaybackInteractionBridge';
import { FILTER_VIEW_COMMAND_ID } from '../../components/command-palette/commands/filterViewCommand';
import { COMMAND_PALETTE_COMMANDS } from '../../components/command-palette/commandRegistry';
import { resolveCustomShortcutCommand } from '../../components/command-palette/customShortcut';
import { hasBlockingWindow } from '../../utils/keyboardTargets';
import { LONG_PRESS_ANCHOR_ATTRIBUTE, createLongPressTracker } from '../../utils/longPressGesture';

// src/mobile/touch/useAndroidTouchShortcuts.ts
// 应用级的长按委托层：把「只靠键盘才能按到的那些键」在 Android 上换成一次长按。
//
// 一个 window 级监听，不做逐元素绑定 —— 目标可能挂在懒加载的子树里，而且 N 个订阅者
// 做一件事正是 guardrails 要避免的形状。命中哪个动作靠 element.closest 读锚点属性。
//
// 分工：动作需要组件自身闭包的锚点（折叠胶囊、进度条）由 useAndroidLongPress 在自己
// 身上计时，并且会把动作 id 打在同一属性上；这里看到不在本层负责集合里的 id 就让路。
//
// 「长按任意处打开该元素的思索教程」曾经也在这一层，现已整条搬走：触屏上讲某个控件改成了
// 「把右上角那颗灯泡拖到它上面」（usePonderTouchDrag）。长按的起手位置在屏幕正中、又要按住
// 不动四百毫秒，在滚动和切歌都很密的播放页上误触率过高。删掉之后，首页与播放页的空白处
// 长按不再有任何动作。
//
// 只认 pointerType === 'touch'：桌面端的鼠标长按不该触发这一层，那边本来就有键盘。

/** 本层负责的动作。不在这张表里的锚点（元素级 hook 的）一律跳过。 */
const DELEGATE_ACTIONS = new Set<string>([
    'player-chrome',
    'player-panel',
    'palette-open',
    'custom-shortcut',
    'grid-filter',
]);

/** 命中这些就打一下原生 contextmenu，免得 Android WebView 弹出长按菜单。 */
const CONTEXT_MENU_SELECTOR = `[${LONG_PRESS_ANCHOR_ATTRIBUTE}]`;

/** 落点在这些东西上时不算「空白区」：空白区的长按才归本层，控件交给它自己的交互。 */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, [role="button"], [role="slider"], [data-ponder], [data-testid="panel-toggle"]';

type DelegateTitleAction =
    | 'player-chrome'
    | 'player-panel'
    | 'palette-open'
    | 'custom-shortcut'
    | 'grid-filter';

type UseAndroidTouchShortcutsParams = {
    cyclePlayerChromeVisibilityMode: () => void;
    navigateBackFromPlayer: () => void;
};

/**
 * 按下这一刻就把它归到哪个动作。多数锚点直接由属性决定；没有锚点的空白区按当前页面推：
 * 播放页是 H（切换 chrome），首页网格是 Ctrl+F，其余位置没有动作。
 */
const resolveAction = (element: Element): DelegateTitleAction | null => {
    const anchor = element.closest(CONTEXT_MENU_SELECTOR);
    const raw = anchor?.getAttribute(LONG_PRESS_ANCHOR_ATTRIBUTE) ?? null;
    if (raw) {
        // 元素级 hook 接管的锚点（player-expand / player-seek 等）本层不碰。
        return DELEGATE_ACTIONS.has(raw) ? (raw as DelegateTitleAction) : null;
    }

    const isInteractive = Boolean(element.closest(INTERACTIVE_SELECTOR));
    const { view, commandFilter, isPanelOpen } = useAppViewStore.getState();
    if (view === 'player') {
        // 落在控件上的长按交还给它自己：这里曾经借它开思索，那条路已经搬到灯泡拖拽上了。
        if (isInteractive) {
            return null;
        }
        // 对齐键盘 H 的前置条件：面板开着或有模态窗时不去切换 chrome。
        if (isPanelOpen || hasBlockingWindow()) {
            return null;
        }
        return 'player-chrome';
    }
    if (view === 'home' && commandFilter) {
        return isInteractive ? null : 'grid-filter';
    }
    return null;
};

export const useAndroidTouchShortcuts = ({
    cyclePlayerChromeVisibilityMode,
    navigateBackFromPlayer,
}: UseAndroidTouchShortcutsParams) => {
    // 回调每次渲染都是新的闭包，但监听器只该装一次：存 ref，不外泄到依赖里。
    const paramsRef = useRef({ cyclePlayerChromeVisibilityMode, navigateBackFromPlayer });
    paramsRef.current = { cyclePlayerChromeVisibilityMode, navigateBackFromPlayer };

    useEffect(() => {
        if (!isAndroid() || typeof window === 'undefined') {
            return undefined;
        }

        let pendingAction: DelegateTitleAction | null = null;
        // 长按完成后吃掉随之而来的 click：click 在 pointerup 之后派发，用时间戳认领。
        let firedAtMs = 0;

        const runAction = (action: DelegateTitleAction) => {
            const params = paramsRef.current;
            switch (action) {
                case 'player-chrome':
                    params.cyclePlayerChromeVisibilityMode();
                    break;
                case 'grid-filter':
                    openCommandPaletteCommand(FILTER_VIEW_COMMAND_ID);
                    break;
                case 'palette-open':
                    openCommandPalette();
                    break;
                case 'player-panel': {
                    // 和键盘 Esc 走同一个判定：面板开着就收面板，否则退回上一页。
                    const { view, isPanelOpen } = useAppViewStore.getState();
                    const resolved = resolvePlayerEscapeAction({
                        currentView: view,
                        hasBlockingWindow: hasBlockingWindow(),
                        isFullscreen: Boolean(document.fullscreenElement),
                        isPanelOpen,
                        isRepeat: false,
                    });
                    if (resolved === 'close-panel') {
                        setIsPanelOpen(false);
                    } else if (resolved === 'navigate-back') {
                        params.navigateBackFromPlayer();
                    }
                    break;
                }
                case 'custom-shortcut': {
                    const { customShortcutLetter, customShortcutCommandId } = useInteractionSettingsStore.getState();
                    const command = resolveCustomShortcutCommand(
                        customShortcutLetter,
                        customShortcutCommandId,
                        COMMAND_PALETTE_COMMANDS,
                    );
                    if (command) {
                        openCommandPaletteCommand(command.id);
                    }
                    break;
                }
            }
        };

        const tracker = createLongPressTracker({
            onFire: () => {
                const action = pendingAction;
                pendingAction = null;
                if (!action) {
                    return;
                }
                firedAtMs = Date.now();
                runAction(action);
            },
            onCancel: () => {
                pendingAction = null;
            },
        });

        const handlePointerDown = (event: PointerEvent) => {
            firedAtMs = 0;
            if (event.pointerType !== 'touch') {
                return;
            }
            // 第二根手指落下时这一轮作废，不再另起一轮。
            if (tracker.isActive()) {
                tracker.cancel();
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (!target) {
                return;
            }
            const action = resolveAction(target);
            if (!action) {
                return;
            }
            pendingAction = action;
            tracker.start({ pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        };

        const handlePointerMove = (event: PointerEvent) => {
            tracker.move(event.pointerId, event.clientX, event.clientY);
        };

        const handlePointerRelease = () => {
            tracker.cancel();
        };

        const handleClickCapture = (event: MouseEvent) => {
            if (firedAtMs === 0) {
                return;
            }
            firedAtMs = 0;
            event.preventDefault();
            event.stopPropagation();
        };

        const handleContextMenu = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            if (target.closest(CONTEXT_MENU_SELECTOR)) {
                event.preventDefault();
            }
        };

        const handleScroll = () => tracker.cancel();
        const handleVisibility = () => {
            if (document.visibilityState !== 'visible') {
                tracker.cancel();
            }
        };

        window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
        window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
        window.addEventListener('pointerup', handlePointerRelease, { capture: true, passive: true });
        window.addEventListener('pointercancel', handlePointerRelease, { capture: true, passive: true });
        window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
        window.addEventListener('blur', handlePointerRelease);
        window.addEventListener('click', handleClickCapture, { capture: true });
        window.addEventListener('contextmenu', handleContextMenu);
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
            window.removeEventListener('pointermove', handlePointerMove, { capture: true });
            window.removeEventListener('pointerup', handlePointerRelease, { capture: true });
            window.removeEventListener('pointercancel', handlePointerRelease, { capture: true });
            window.removeEventListener('scroll', handleScroll, { capture: true });
            window.removeEventListener('blur', handlePointerRelease);
            window.removeEventListener('click', handleClickCapture, { capture: true });
            window.removeEventListener('contextmenu', handleContextMenu);
            document.removeEventListener('visibilitychange', handleVisibility);
            tracker.cancel();
        };
    }, []);
};

export default useAndroidTouchShortcuts;
