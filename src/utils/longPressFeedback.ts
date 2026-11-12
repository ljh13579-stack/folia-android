// src/utils/longPressFeedback.ts
// 长按的「看得见、摸得着」的那一半：一枚跟着落点走的进度环，外加按满时的一次轻震。
//
// 为什么和长按计时器紧挨着放：计时器决定「什么时候算满」，这里决定「按住的这几百毫秒里
// 用户看到什么」。两者必须一一对应 —— 环走满的那一刻就是动作触发的那一刻，差一点用户就会
// 以为「还没到位」而继续按。所以时长不从常量里取，而是由调用方把计时器自己的 durationMs 传进来。
//
// 为什么全是 DOM/WAAPI 而不是 React：按下到触发只有 400ms，走一遍渲染树的话环还没画出来
// 手势就结束了；而每帧的进度值一旦进 state，就会每帧重渲染整棵子树 —— 那正是要避免的卡顿。
//
// 环心落在手指按下的那一点上。手指落下后先等 LONG_PRESS_FEEDBACK_DELAY_MS 再让它现身：
// 短促的点击（滚动、切歌、换页）不该在屏幕上闪一下环，只有真的按住时才出现。

/** 手指落下之后隔这么久才让环现身。短于它的那次按压从头到尾都不会看到任何东西。 */
export const LONG_PRESS_FEEDBACK_DELAY_MS = 120;

/** 环现身之后到完全消失之间的淡出时长。触发那一下界面本来就要变，淡出只是把交接做顺。 */
const RING_FADE_OUT_MS = 140;

const SVG_NS = 'http://www.w3.org/2000/svg' as const;
const RING_SIZE_PX = 44;
const RING_STROKE_PX = 3;
const RING_RADIUS_PX = (RING_SIZE_PX - RING_STROKE_PX) / 2;
const RING_CIRCUMFERENCE_PX = 2 * Math.PI * RING_RADIUS_PX;

/** 和 Android 自带的「长按到位」轻震同一量级：一下、短、不吵。 */
const HAPTIC_MS = 18;

type LongPressFeedbackNode = {
    host: HTMLDivElement;
    arc: SVGCircleElement;
};

// 一次性建好、反复复用的单例。长按的落点就压在滚动、拖拽和切歌的高频路径旁边，
// 每次按下都新建再销毁一个节点，等于把 DOM 分配塞进手势里。
let node: LongPressFeedbackNode | null = null;
let revealTimerId: number | null = null;
let concealTimerId: number | null = null;
let arcAnimation: Animation | null = null;

const createNode = (): LongPressFeedbackNode | null => {
    if (!document.body) {
        return null;
    }
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    const style = host.style;
    style.position = 'fixed';
    style.left = '0px';
    style.top = '0px';
    // 用负 margin 把环心挪到落点上，而不是 transform —— transform 要留给动画用。
    style.marginLeft = `${-RING_SIZE_PX / 2}px`;
    style.marginTop = `${-RING_SIZE_PX / 2}px`;
    style.width = `${RING_SIZE_PX}px`;
    style.height = `${RING_SIZE_PX}px`;
    style.pointerEvents = 'none';
    style.visibility = 'hidden';
    style.opacity = '0';
    style.zIndex = '2147483000';
    // 跟着主题走：浅色主题下固定成白环就等于画在纸上了。
    style.color = 'var(--text-primary, #ffffff)';
    style.contain = 'layout paint style';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${RING_SIZE_PX} ${RING_SIZE_PX}`);
    svg.setAttribute('width', `${RING_SIZE_PX}`);
    svg.setAttribute('height', `${RING_SIZE_PX}`);

    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', `${RING_SIZE_PX / 2}`);
    track.setAttribute('cy', `${RING_SIZE_PX / 2}`);
    track.setAttribute('r', `${RING_RADIUS_PX}`);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'currentColor');
    track.setAttribute('stroke-opacity', '0.22');
    track.setAttribute('stroke-width', `${RING_STROKE_PX}`);

    const arc = document.createElementNS(SVG_NS, 'circle');
    arc.setAttribute('cx', `${RING_SIZE_PX / 2}`);
    arc.setAttribute('cy', `${RING_SIZE_PX / 2}`);
    arc.setAttribute('r', `${RING_RADIUS_PX}`);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', `${RING_STROKE_PX}`);
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE_PX}`);
    // 从 12 点方向开始走，而不是 SVG 默认的 3 点。
    arc.setAttribute('transform', `rotate(-90 ${RING_SIZE_PX / 2} ${RING_SIZE_PX / 2})`);
    // 内联值同时是「还没开始」的基线与动画取消后的回落值。
    arc.style.strokeDashoffset = `${RING_CIRCUMFERENCE_PX}`;

    svg.append(track, arc);
    host.appendChild(svg);
    document.body.appendChild(host);
    return { host, arc };
};

const ensureNode = (): LongPressFeedbackNode | null => {
    if (node) {
        return node;
    }
    node = createNode();
    return node;
};

const clearRevealTimer = () => {
    if (revealTimerId !== null) {
        window.clearTimeout(revealTimerId);
        revealTimerId = null;
    }
};

const clearConcealTimer = () => {
    if (concealTimerId !== null) {
        window.clearTimeout(concealTimerId);
        concealTimerId = null;
    }
};

const cancelArcAnimation = () => {
    arcAnimation?.cancel();
    arcAnimation = null;
};

const concealNow = () => {
    if (!node) {
        return;
    }
    node.host.style.transition = 'none';
    node.host.style.visibility = 'hidden';
    node.host.style.opacity = '0';
};

/**
 * 手指落下，起一轮。这一刻不写 DOM —— 环要等确定「这是在长按」之后才建，
 * 免得每次点击都在滚动/拖拽的路径上做一次节点分配。
 */
export const showLongPressFeedback = (origin: { x: number; y: number }, durationMs: number): void => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }
    clearRevealTimer();
    clearConcealTimer();
    cancelArcAnimation();
    concealNow();

    // 现身之后剩下的时间刚好填满：环走满的瞬间正是计时器触发的那一刻。
    const fillMs = Math.max(80, durationMs - LONG_PRESS_FEEDBACK_DELAY_MS);
    revealTimerId = window.setTimeout(() => {
        revealTimerId = null;
        const target = ensureNode();
        if (!target) {
            return;
        }
        const { host, arc } = target;
        host.style.left = `${origin.x}px`;
        host.style.top = `${origin.y}px`;
        host.style.transition = 'none';
        host.style.visibility = 'visible';
        host.style.opacity = '1';
        arc.style.strokeDashoffset = `${RING_CIRCUMFERENCE_PX}`;
        arcAnimation = arc.animate(
            [
                { strokeDashoffset: `${RING_CIRCUMFERENCE_PX}` },
                { strokeDashoffset: '0' },
            ],
            { duration: fillMs, easing: 'linear', fill: 'forwards' },
        );
    }, LONG_PRESS_FEEDBACK_DELAY_MS);
};

/**
 * 一次轻震。长按按满和拖拽落点都用它 —— 「已经响应」的那一下手感只该有一个定义。
 *
 * 需要 AndroidManifest 里的 android.permission.VIBRATE，否则 WebView 静默忽略。
 */
export const pulseHaptic = (): void => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(HAPTIC_MS);
    }
};

/**
 * 这一轮结束。completed 是「按满触发」—— 那一下用一次轻震画句号；否则是松手、滑走或切页，
 * 静悄悄地把环淡掉就好。
 */
export const dismissLongPressFeedback = (completed: boolean): void => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }
    clearRevealTimer();
    cancelArcAnimation();

    if (completed) {
        pulseHaptic();
    }

    // 还没现身就被取消（短促的点击）：没有任何东西需要收尾。
    if (!node || node.host.style.visibility === 'hidden') {
        return;
    }
    clearConcealTimer();
    node.host.style.transition = `opacity ${RING_FADE_OUT_MS}ms linear`;
    node.host.style.opacity = '0';
    concealTimerId = window.setTimeout(() => {
        concealTimerId = null;
        concealNow();
    }, RING_FADE_OUT_MS);
};
