// src/utils/longPressGesture.ts
// 触屏「长按」这一种手势的公共定义。
//
// 桌面端有一整套键盘快捷键，触屏没有键盘 —— 所以每一个只靠按键才能触达的动作，都要在
// Android 上换成「按住某个元素」。这些长按散落在三四个组件里，但它们必须看起来一样：
// 同样的时长、同样的位移容忍、同样的取消时机。各写一份必然走散，而「一样」正是这套
// 手势的全部意义，所以常量、判定和计时器都收在这里。
//
// 「按住这几百毫秒里用户看到什么」在相邻的 longPressFeedback 里，并且由本文件的计时器直接
// 驱动：所有长按共用同一枚计时器，于是不可能出现某一处忘了给反馈，或者给出不一样的长短。

import { dismissLongPressFeedback, showLongPressFeedback } from './longPressFeedback';

/** 按多久算长按。和思索长按共用：用户学会的是「按住，等擦除走满」，不是学会两套时长。 */
export const LONG_PRESS_DURATION_MS = 400;

/** 手指在按下后移动超过这么多像素就不再算长按 —— 那是在滚动或者拖拽。 */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 12;

/**
 * 元素自己处理长按时打在它身上的标记，值就是动作 id。
 *
 * 它的作用是把「这个元素已经被元素级 hook 接管」这件事告诉应用级委托层：委托层在
 * window 上先一步收到 pointerdown，看到这个属性就不再插手，交给元素自己计时。
 */
export const LONG_PRESS_ANCHOR_ATTRIBUTE = 'data-folia-long-press';

/**
 * 触屏长按能干的那些事。元素级 hook 和应用级委托层共用一个名字空间，
 * 委托层比自己处理的动作集合，不在集合里的会原样跳过（那些由元素级 hook 接管）。
 */
export type FoliaLongPressAction =
    /** 折叠态胶囊长按 → 展开，对应空格 / 悬停。 */
    | 'player-expand'
    /** 展开态进度条两侧长按 → 相对快退 / 快进，对应 ← / → 。 */
    | 'player-seek'
    /** 播放页空白区长按 → 循环切换 chrome 显隐模式，对应 H。 */
    | 'player-chrome'
    /** 面板手柄长按 → 面板开则关，否则返回上一页，对应 Esc。 */
    | 'player-panel'
    /** 长按 → 打开命令面板，对应 Ctrl+K。 */
    | 'palette-open'
    /** 胶囊内标题行长按 → 执行自定义 Alt+字母 命令。 */
    | 'custom-shortcut'
    /** 网格 / 集合页长按 → 过滤视图，对应 Ctrl+F。 */
    | 'grid-filter';

/** 一次长按的起点。pointerId 用来确认后续的移动和抬起还是同一根手指。 */
export type LongPressOrigin = {
    pointerId: number;
    x: number;
    y: number;
};

/** 位移是否还在容忍范围内。用平方比较，省掉每帧的 hypot。 */
export const isWithinLongPressTolerance = (deltaX: number, deltaY: number): boolean => (
    deltaX * deltaX + deltaY * deltaY <= LONG_PRESS_MOVE_TOLERANCE_PX * LONG_PRESS_MOVE_TOLERANCE_PX
);

type LongPressTrackerOptions = {
    /** 满时长后回调一次。之后计时器自毁，要再按就得重新 start。 */
    onFire: (origin: LongPressOrigin) => void;
    onCancel?: () => void;
    durationMs?: number;
};

/**
 * 一枚长按计时器，把「什么时候满」这件事从回调里剥出来。
 *
 * 元素级 hook 和委托层各持一枚：前者每元素一枚，后者全局一枚。两处要做的判断完全一样
 * （起点、位移、满时长），所以计时这件事只实现一遍，剩下的只是「谁来 start、谁来回调」。
 *
 * 全部状态都在闭包里，不进 React —— 计时与位移是每帧值，进 state 会每帧重渲染。
 *
 * 进度环与按满时的轻震也挂在这里，而不是交给每个调用方自己去喊：调用方有四处，
 * 各喊一次必然走散；挂在计时器里，谁用这枚计时器谁就自动拿到一模一样的反馈。
 */
export const createLongPressTracker = ({
    onFire,
    onCancel,
    durationMs = LONG_PRESS_DURATION_MS,
}: LongPressTrackerOptions) => {
    let timerId: number | null = null;
    let origin: LongPressOrigin | null = null;

    const clearTimer = () => {
        if (timerId !== null) {
            window.clearTimeout(timerId);
            timerId = null;
        }
    };

    const cancel = () => {
        if (origin === null && timerId === null) {
            return;
        }
        clearTimer();
        origin = null;
        dismissLongPressFeedback(false);
        onCancel?.();
    };

    const start = (next: LongPressOrigin) => {
        // 上一轮的残留先清掉：一根手指还没抬就按第二根，应该只认后者。
        cancel();
        origin = next;
        // 现身要等 LONG_PRESS_FEEDBACK_DELAY_MS，所以按下这一刻只是起个计时器，不碰 DOM。
        showLongPressFeedback(next, durationMs);
        timerId = window.setTimeout(() => {
            timerId = null;
            const fired = origin;
            // 先置空再回调：回调里可能再次 start（比如长按触发了一个新面板）。
            origin = null;
            if (fired) {
                // 反馈先收尾（那次轻震也在里面）再跑动作：动作本身可能一次改掉一大片 DOM，
                // 先落下「已经响应」的证据，那一下就不会被读成「卡住了」。
                dismissLongPressFeedback(true);
                onFire(fired);
            }
        }, durationMs);
    };

    /** 移动超容忍就取消。pointerId 不符（另一根手指）不许动这一轮。 */
    const move = (pointerId: number, x: number, y: number) => {
        if (origin === null || origin.pointerId !== pointerId) {
            return;
        }
        if (!isWithinLongPressTolerance(x - origin.x, y - origin.y)) {
            cancel();
        }
    };

    return {
        start,
        move,
        cancel,
        isActive: () => origin !== null,
    };
};
