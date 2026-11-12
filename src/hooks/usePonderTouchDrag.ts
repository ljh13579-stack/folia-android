import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { resolvePonderHit } from '../components/ponder/ponderRegistry';
import { PAGE_SCOPE_TARGETS } from '../services/ponder/pagePonderTarget';
import { usePonderStore } from '../stores/usePonderStore';
import { pulseHaptic } from '../utils/longPressFeedback';

// src/hooks/usePonderTouchDrag.ts
// 触屏上「把右上角那颗灯泡拖到某个控件上，讲那个控件」。
//
// 为什么不是长按：长按要求手指按住不动四百毫秒，而播放页上滚动、切歌、切页都很密，
// 起手位置又在屏幕正中，误触率天然很高 —— 这正是这条入口从长按换成拖动的原因。
// 拖动的好处是起手位置固定在灯泡上：松手之前手指一直在动，而「在动」本身就是
// 「这不是一次误触」的证据。
//
// 和 useQueueDragReorder 走同一套范式：指针捕获 + 位移阈值 + rAF 合并 + 幽灵节点直接写
// ref.style.transform（不进 React state）。区别只有一个 —— 落点不是算出来的下标，而是
// elementFromPoint 命中的真实元素，描边就画在它身上。

/** 超过这么多像素才算「在拖」。比队列拖拽的 4px 大：灯泡只有 48px，手指按在它上面天然有细微抖动。 */
const DRAG_THRESHOLD_PX = 8;

/** 幽灵的边长，和灯泡按钮的 h-12 w-12 一致。 */
export const PONDER_DRAG_GHOST_SIZE_PX = 48;

const GHOST_HALF_PX = PONDER_DRAG_GHOST_SIZE_PX / 2;

/** 落点描边的粗细与外扩。只写这两个内联属性，不碰目标元素的其它样式。 */
const OUTLINE_WIDTH = '2px';
const OUTLINE_OFFSET = '2px';

/** 描边之前那个元素原有的内联值，用来还原。 */
type OutlineSnapshot = { element: HTMLElement; outline: string; outlineOffset: string };

type DragSession = {
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    /** 跨过阈值没有。没跨过就还是一次点按，交给按钮自己的 onClick。 */
    active: boolean;
    frame: number | null;
    /** 指针捕获承接在灯泡按钮自己身上（它不会被卸载）。 */
    captureTarget: HTMLElement;
    outline: OutlineSnapshot | null;
    detach: () => void;
};

type UsePonderTouchDragOptions = {
    /** 落在可教学目标上时描边的颜色。 */
    accent: string;
    /** 起拖 / 结束各回调一次。 */
    onDragStateChange?: (dragging: boolean) => void;
};

/**
 * 把一次「按住灯泡拖走」的手势接在调用方给的 beginDrag 上。
 *
 * 松手时再解析一次落点：手指动的这几百毫秒里 DOM 可能变了（面板开合、换页），
 * 起拖时记下的目标到松手时可能已经不在了。
 */
export const usePonderTouchDrag = ({ accent, onDragStateChange }: UsePonderTouchDragOptions) => {
    const [isDragging, setIsDragging] = useState(false);
    const sessionRef = useRef<DragSession | null>(null);
    const ghostNodeRef = useRef<HTMLElement | null>(null);
    /** 拖过之后那一次 click 要吃掉，否则一次拖动会先讲控件、再讲整页。 */
    const suppressClickRef = useRef(false);
    const accentRef = useRef(accent);
    accentRef.current = accent;
    const onDragStateChangeRef = useRef(onDragStateChange);
    onDragStateChangeRef.current = onDragStateChange;

    const findDropTarget = (x: number, y: number) => {
        const hit = resolvePonderHit(document.elementFromPoint(x, y));
        if (!hit) {
            return null;
        }
        // 整页目标（首页空白 = grid-page、播放页空白 = player-page）不算落点：拖拽是用来
        // 指着某一个具体控件的，想听整页就点一下灯泡 —— 两种入口各管一件事，
        // 空白处误落才不会开出一整页教程。
        if (PAGE_SCOPE_TARGETS.has(hit.target.id)) {
            return null;
        }
        if (hit.target.isAvailable?.() === false) {
            return null;
        }
        return hit;
    };

    const placeGhost = (session: DragSession) => {
        const ghost = ghostNodeRef.current;
        if (!ghost) {
            return;
        }
        ghost.style.transform = `translate3d(${session.x - GHOST_HALF_PX}px, ${session.y - GHOST_HALF_PX}px, 0)`;
    };

    const clearOutline = (session: DragSession) => {
        const snapshot = session.outline;
        if (!snapshot) {
            return;
        }
        snapshot.element.style.outline = snapshot.outline;
        snapshot.element.style.outlineOffset = snapshot.outlineOffset;
        session.outline = null;
    };

    const applyOutline = (session: DragSession, element: Element) => {
        const node = element as HTMLElement;
        session.outline = { element: node, outline: node.style.outline, outlineOffset: node.style.outlineOffset };
        node.style.outline = `${OUTLINE_WIDTH} solid ${accentRef.current}`;
        node.style.outlineOffset = OUTLINE_OFFSET;
    };

    /** 一帧：摆幽灵、解析落点、按需改描边。落点没变就不碰 DOM。 */
    const step = () => {
        const session = sessionRef.current;
        if (!session) {
            return;
        }
        session.frame = null;
        placeGhost(session);
        const hit = findDropTarget(session.x, session.y);
        if ((hit?.element ?? null) === (session.outline?.element ?? null)) {
            return;
        }
        clearOutline(session);
        if (hit) {
            applyOutline(session, hit.element);
        }
    };

    const schedule = () => {
        const session = sessionRef.current;
        if (!session || !session.active || session.frame !== null) {
            return;
        }
        session.frame = requestAnimationFrame(step);
    };

    /** 结束这次拖拽：commit 时再解析一次落点，命中就开它的教程。 */
    const finish = useCallback((commit: boolean) => {
        const session = sessionRef.current;
        if (!session) {
            return;
        }
        sessionRef.current = null;
        session.detach();
        if (session.frame !== null) {
            cancelAnimationFrame(session.frame);
        }
        try {
            if (session.captureTarget.hasPointerCapture(session.pointerId)) {
                session.captureTarget.releasePointerCapture(session.pointerId);
            }
        } catch {
            // 元素已经不在文档里：捕获早就没了。
        }

        const dragged = session.active;
        clearOutline(session);
        if (!dragged) {
            return;
        }

        suppressClickRef.current = true;
        setIsDragging(false);
        onDragStateChangeRef.current?.(false);
        if (!commit) {
            return;
        }

        const hit = findDropTarget(session.x, session.y);
        if (!hit) {
            return;
        }
        usePonderStore.getState().openPonder(hit.target.id);
        pulseHaptic();
    }, []);

    /** 灯泡按钮上按下指针（只认触摸的主指针）。 */
    const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0 || sessionRef.current) {
            return;
        }
        // 这里刻意不 preventDefault：取消 pointerdown 之后 Chrome 还派不派发 click 不是稳定保证，
        // 而「点一下灯泡 = 讲整页」正是靠那次 click。滚动与缩放由按钮上的 touch-none 挡掉，
        // 按钮里没有可选中的文字，WebView 的长按菜单也无从弹起。
        const captureTarget = event.currentTarget;
        const pointerId = event.pointerId;
        try {
            captureTarget.setPointerCapture(pointerId);
        } catch {
            return;
        }

        const handleMove = (moveEvent: PointerEvent) => {
            const session = sessionRef.current;
            if (!session || moveEvent.pointerId !== session.pointerId) {
                return;
            }
            // 主键已经不在按着：pointerup 丢了，撤掉这次拖拽（不提交）。
            if ((moveEvent.buttons & 1) === 0) {
                finish(false);
                return;
            }
            session.x = moveEvent.clientX;
            session.y = moveEvent.clientY;
            if (!session.active) {
                if (Math.hypot(session.x - session.startX, session.y - session.startY) <= DRAG_THRESHOLD_PX) {
                    return;
                }
                session.active = true;
                setIsDragging(true);
                onDragStateChangeRef.current?.(true);
                // 教程层走 React.lazy（见 PonderHost.tsx 里那行 import 的注释），chunk 不在
                // bootstrap 里。起拖这一刻就把它拉下来，免得松手那一下才现取现解析。
                void import('../components/ponder/PonderStage');
            }
            schedule();
        };
        const handleUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId === sessionRef.current?.pointerId) {
                finish(true);
            }
        };
        const handleCancel = (cancelEvent: PointerEvent) => {
            if (cancelEvent.pointerId === sessionRef.current?.pointerId) {
                finish(false);
            }
        };

        captureTarget.addEventListener('pointermove', handleMove);
        captureTarget.addEventListener('pointerup', handleUp);
        captureTarget.addEventListener('pointercancel', handleCancel);
        captureTarget.addEventListener('lostpointercapture', handleCancel);

        sessionRef.current = {
            pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            active: false,
            frame: null,
            captureTarget,
            outline: null,
            detach: () => {
                captureTarget.removeEventListener('pointermove', handleMove);
                captureTarget.removeEventListener('pointerup', handleUp);
                captureTarget.removeEventListener('pointercancel', handleCancel);
                captureTarget.removeEventListener('lostpointercapture', handleCancel);
            },
        };
    // step / schedule 是每次渲染新建的闭包，但它们只读 ref 与 setState，第一版一直对。
    }, [finish]);

    /** 幽灵节点的 ref：挂上时立刻摆到当前指针处，免得第一帧出现在屏幕角落。 */
    const ghostRef = useCallback((node: HTMLElement | null) => {
        ghostNodeRef.current = node;
        const session = sessionRef.current;
        if (node && session) {
            placeGhost(session);
        }
    }, []);

    /** 读一次即清：true 表示刚才那一下是拖动，不是点按。 */
    const consumeSuppressedClick = useCallback(() => {
        if (!suppressClickRef.current) {
            return false;
        }
        suppressClickRef.current = false;
        return true;
    }, []);

    // 卸载（换页、关掉按钮）时撤掉进行中的拖拽。
    useEffect(() => () => finish(false), [finish]);

    return { isDragging, ghostRef, beginDrag, consumeSuppressedClick };
};

export default usePonderTouchDrag;
