import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Play, Pause, ChevronDown, ChevronUp } from 'lucide-react';
import { MotionValue } from 'framer-motion';
import ProgressBar from './ProgressBar';
import { PlayerState, LyricData, Theme } from '../types';
import LyricsTimelineModal from './modal/LyricsTimelineModal';
import TrackTitleNavigator from './floating-player/TrackTitleNavigator';
import PlayerControlSlotButton from './floating-player/PlayerControlSlotButton';
import PlayerBottomBarPositioner from './floating-player/PlayerBottomBarPositioner';
import { usePlayerBottomBarBottomPx } from '../hooks/usePlayerBottomBarBottomPx';
import { playerBottomBarLiveOffset, playerCapsuleHeightPx } from '../stores/motionSignals';
import { usePlayerBottomBarLayoutStore } from '../stores/usePlayerBottomBarLayoutStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { PLAYER_BOTTOM_BAR_BASE_OFFSET_PX, clampPlayerBottomBarOffset, resolvePlayerBottomBarMaxOffset } from '../utils/playerBottomBarLayout';
import { useAndroidLongPress } from '../mobile/touch/useAndroidLongPress';
import { isAndroid } from '../mobile/platform';
import { useAndroidPortrait } from '../mobile/useAndroidPortrait';
import type { PlayerControlSlotActionId, PlayerControlSlotContext } from './floating-player/playerControlSlotActions';
import { usePlayerOverlayObstacle } from '../hooks/usePlayerOverlayLayout';

/** 长按进度条两侧时快退 / 快进的步长，和键盘 ← / → 一致。 */
const TOUCH_SEEK_STEP_SEC = 5;

export interface TrackNavigation {
    /** 当前曲目的稳定身份，用于识别「确实换歌了」；相邻两首同名时标题字符串不变，不能拿标题判断 */
    currentTrackKey: string;
    onPrev: () => void;
    onNext: () => void;
    canPrev: boolean;
    canNext: boolean;
    prevTitle: string | null;
    nextTitle: string | null;
    prevLabel: string;
    nextLabel: string;
}

const CONTROL_LAYOUT_SPRING = {
    type: 'spring' as const,
    stiffness: 320,
    damping: 26,
};

const HOVER_EXPAND_DELAY_MS = 20;
const HOVER_COLLAPSE_DELAY_MS = 100;
const HOVER_HITBOX_BOTTOM_BUFFER_PX = 32;
/*
 * 模组可以通过公开变量 --folium-player-bar-extra 加宽胶囊，补回进度条两侧按钮占掉的长度。
 * 外层 max-width 已经加了一份 extra；收起的胶囊是外层的 80% / 60%，所以只再补 (1 - 比例) 份，
 * 外层顶到 max-width 时收起胶囊正好宽出 extra。
 */
const COLLAPSED_WIDTH_CLASS = 'w-[min(100%,calc(80%_+_var(--folium-player-bar-extra,0px)_*_0.2))] md:w-[min(100%,calc(60%_+_var(--folium-player-bar-extra,0px)_*_0.4))]';

/**
 * 槽位上下文里由 App 提供的部分。循环模式、歌词时间轴和上一首/下一首的可用性
 * 胶囊自己已经有了，不让调用方重复传一遍。
 */
export type SlotContextFromApp = Omit<
    PlayerControlSlotContext,
    'loopMode' | 'onToggleLoop' | 'onToggleTimeline' | 'hasLyrics' | 'canPrev' | 'canNext' | 'onPrev' | 'onNext'
>;

interface FloatingPlayerControlsProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    loopMode: 'off' | 'all' | 'one';
    currentView: 'home' | 'player' | 'lattice';
    audioSrc: string | null;
    canTogglePlay?: boolean;
    lyrics: LyricData | null;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    onToggleLoop: () => void;
    onNavigateToPlayer: () => void;
    onFocusLatticeCurrentSong?: () => void;
    noTrackText?: string;
    primaryColor?: string;
    secondaryColor?: string;
    theme?: Theme;
    isDaylight: boolean;
    isHidden?: boolean;
    hideControlBar?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    /** 右侧两个可自定义槽位的动作 id。 */
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    /** 槽位共用的播放上下文里，胶囊自己能提供的那几项在内部补齐。 */
    slotContext: SlotContextFromApp;
    /** 提交定位结果；由 App 写回持久化设置。 */
    onCommitBottomBarOffset: (offsetPx: number) => void;
}


const FloatingPlayerControls: React.FC<FloatingPlayerControlsProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    loopMode,
    currentView,
    audioSrc,
    canTogglePlay = false,
    lyrics,
    onSeek,
    onTogglePlay,
    onToggleLoop,
    onNavigateToPlayer,
    onFocusLatticeCurrentSong,
    noTrackText = 'No Track',
    primaryColor = 'var(--text-primary)',
    secondaryColor = 'var(--text-secondary)',
    theme,
    isDaylight,
    isHidden = false,
    hideControlBar = false,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
    onCommitBottomBarOffset,
}) => {
    const { t } = useTranslation();
    const { ref: layoutRef, invalidate: invalidateLayout } = usePlayerOverlayObstacle('player-controls', 'playback', !isHidden);
    // 胶囊条实时高度（展开/收起，含布局弹簧的每一帧）发布给切歌卡片等贴胶囊顶边的组件。
    const capsuleBarRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const node = capsuleBarRef.current;
        if (!node || typeof ResizeObserver === 'undefined') return;
        const publish = () => { playerCapsuleHeightPx.set(node.getBoundingClientRect().height); };
        publish();
        const observer = new ResizeObserver(publish);
        observer.observe(node);
        return () => {
            observer.disconnect();
            playerCapsuleHeightPx.set(0);
        };
    }, []);
    // const isDaylight = theme?.name === 'Daylight Default'; // Deprecated, passed as prop
    const glassBgExpanded = isDaylight ? 'bg-white/60 border border-white/20 shadow-xl' : 'bg-black/40 border border-white/5';
    const glassBgCollapsed = isDaylight ? 'bg-white/40 border border-white/20 shadow-lg hover:bg-white/50' : 'bg-black/20 border border-white/5 hover:bg-black/30';
    const trackColor = isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)';
    // Button bg logic
    const buttonBg = isDaylight ? { backgroundColor: primaryColor, color: 'var(--bg-color)' } : { backgroundColor: primaryColor, color: 'var(--bg-color)' }; // Keep primary for play button, looks good

    // Other buttons hover
    const iconBtnExpandedClass = isDaylight ? 'hover:bg-black/5' : 'bg-white/20'; // Wait, loop button has logic
    const iconBtnClass = isDaylight ? 'hover:bg-black/5 text-black/60' : 'hover:bg-white/10 opacity-40 hover:opacity-100';

    const [isHovered, setIsHovered] = useState(false);
    const [isTimelineOpen, setIsTimelineOpen] = useState(false);
    const expandTimeoutRef = useRef<number | null>(null);
    const collapseTimeoutRef = useRef<number | null>(null);

    const bottomBarBottomPx = usePlayerBottomBarBottomPx();
    const isPositioning = usePlayerBottomBarLayoutStore(state => state.isPositioning);
    const commitPositioning = usePlayerBottomBarLayoutStore(state => state.commitPositioning);
    const cancelPositioning = usePlayerBottomBarLayoutStore(state => state.cancelPositioning);
    // 拖动起点：按下时的指针 Y 和当时的偏移量。位移是相对的，靠这两个值换算成绝对偏移量。
    const dragOriginRef = useRef<{ pointerY: number; offset: number; } | null>(null);
    const [maxOffsetPx, setMaxOffsetPx] = useState(() => (
        typeof window === 'undefined'
            ? PLAYER_BOTTOM_BAR_BASE_OFFSET_PX
            : resolvePlayerBottomBarMaxOffset(window.innerHeight)
    ));

    const canAutoExpand = canTogglePlay && duration > 0;
    // Android 竖屏：纵向空间充裕，折叠态的细进度条在手机上太难按，首页与播放页都保持展开。
    // 例外：用户把主页胶囊钉在缩小态（homeCapsuleMinimized），主页让出操作空间给墙；长按可临时展开。
    const isPortraitAndroid = useAndroidPortrait();
    const homeCapsuleMinimized = usePlayerChromeSettingsStore(state => state.homeCapsuleMinimized);
    const setHomeCapsuleMinimized = usePlayerChromeSettingsStore(state => state.setHomeCapsuleMinimized);
    const keepExpandedInPortrait = isPortraitAndroid && canAutoExpand
        && !(currentView === 'home' && homeCapsuleMinimized);
    // 缩小态收起按钮（Android 竖屏主页专属）：钉住缩小 + 收起长按的临时展开。
    const collapseHomeCapsule = useCallback(() => {
        setHomeCapsuleMinimized(true);
        setIsHovered(false);
    }, [setHomeCapsuleMinimized]);
    // 缩小胶囊上的展开按钮：恢复主页默认的常驻展开。
    const expandHomeCapsule = useCallback(() => {
        setHomeCapsuleMinimized(false);
    }, [setHomeCapsuleMinimized]);
    // 定位模式强制展开：用户要看到的是最终形态的胶囊，而不是一条细进度条。
    const showExpanded = isPositioning || isHovered || keepExpandedInPortrait || (canAutoExpand && playerState !== PlayerState.PLAYING && currentView !== 'home');

    // 触屏长按折叠态的胶囊 = 空格 / 悬停的触屏等价物：把胶囊展开。只在折叠且不在
    // 定位模式时成立 —— 展开态里这次长按要留给标题行（自定义命令）和思索目标。
    const capsuleLongPress = useAndroidLongPress({
        action: 'player-expand',
        enabled: !showExpanded && !isPositioning,
        onLongPress: () => setIsHovered(true),
    });

    // 上限依赖视口高度，窗口变矮时要跟着收，否则虚线框会画到屏幕外。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const syncMax = () => setMaxOffsetPx(resolvePlayerBottomBarMaxOffset(window.innerHeight));
        syncMax();
        window.addEventListener('resize', syncMax);
        return () => window.removeEventListener('resize', syncMax);
    }, [isPositioning]);

    const handlePositionDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isPositioning) {
            return;
        }
        dragOriginRef.current = { pointerY: e.clientY, offset: playerBottomBarLiveOffset.get() };
        e.currentTarget.setPointerCapture(e.pointerId);
    }, [isPositioning]);

    const handlePositionDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const origin = dragOriginRef.current;
        if (!origin) {
            return;
        }
        // 只写 MotionValue，不进 React 更新路径：这是 pointer move 级别的高频回调。
        // 指针往上走 clientY 变小，偏移量要变大，所以是 origin.pointerY - e.clientY。
        playerBottomBarLiveOffset.set(clampPlayerBottomBarOffset(
            origin.offset + (origin.pointerY - e.clientY),
            window.innerHeight,
        ));
    }, []);

    const handlePositionDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragOriginRef.current) {
            return;
        }
        dragOriginRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    }, []);

    // 定位模式只在播放页的控制条上成立。离开播放页或把控制条整条隐藏后，
    // 拖手和退出按钮都不在场了，状态留着会把胶囊永久钉在展开且不可交互的样子上。
    useEffect(() => {
        if (isPositioning && (currentView !== 'player' || hideControlBar)) {
            cancelPositioning();
        }
    }, [cancelPositioning, currentView, hideControlBar, isPositioning]);

    // 卸载时兜底：当前歌曲被清空会让整条控制条不再渲染，上面那个 effect 也就没机会跑，
    // 定位状态会残留成一个谁也退不出的模式。用 getState 读，避免把 cleanup 绑到回调身份上。
    const isPositioningRef = useRef(isPositioning);
    isPositioningRef.current = isPositioning;
    useEffect(() => () => {
        if (isPositioningRef.current) {
            usePlayerBottomBarLayoutStore.getState().cancelPositioning();
        }
    }, []);

    const handleCommitPositioning = useCallback(() => {
        onCommitBottomBarOffset(commitPositioning());
    }, [commitPositioning, onCommitBottomBarOffset]);

    // Esc 取消回滚，Enter 确认。定位模式是个全屏态，键盘出口是必须的。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelPositioning();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                handleCommitPositioning();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [cancelPositioning, handleCommitPositioning, isPositioning]);

    // 命中区补丁按离底距离收敛。抬高后胶囊下面不再是屏幕边缘，多出来的 padding
    // 只会变成一块吃掉指针事件的死区。
    //
    // 读的是已保存值而不是拖动中的 MotionValue：这个数要参与 padding/margin 的布局计算，
    // 跟着每帧变就得每帧 setState。拖动过程中 hover 展开本来也不起作用，落定后自然就对了。
    const savedBottomBarOffset = usePlayerChromeSettingsStore(state => state.playerBottomBarOffset);
    const hoverHitboxBufferPx = Math.max(
        0,
        Math.round(HOVER_HITBOX_BOTTOM_BUFFER_PX - (savedBottomBarOffset - PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)),
    );

    // 槽位上下文：调用方给的那份，加上胶囊自己掌握的循环模式、歌词时间轴和相邻曲目可用性。
    const resolvedSlotContext = useMemo<PlayerControlSlotContext>(() => ({
        ...slotContext,
        loopMode,
        onToggleLoop,
        onToggleTimeline: () => setIsTimelineOpen(true),
        hasLyrics: !!lyrics,
        canPrev: !!trackNavigation?.canPrev,
        canNext: !!trackNavigation?.canNext,
        onPrev: trackNavigation?.onPrev ?? (() => { }),
        onNext: trackNavigation?.onNext ?? (() => { }),
    }), [lyrics, loopMode, onToggleLoop, slotContext, trackNavigation]);

    useEffect(() => {
        return () => {
            if (expandTimeoutRef.current !== null) {
                window.clearTimeout(expandTimeoutRef.current);
            }
            if (collapseTimeoutRef.current !== null) {
                window.clearTimeout(collapseTimeoutRef.current);
            }
        };
    }, []);

    const handleMouseEnter = () => {
        if (collapseTimeoutRef.current !== null) {
            window.clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }

        if (expandTimeoutRef.current !== null) {
            return;
        }

        expandTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(true);
            expandTimeoutRef.current = null;
        }, HOVER_EXPAND_DELAY_MS);
    };

    const handleMouseLeave = () => {
        if (expandTimeoutRef.current !== null) {
            window.clearTimeout(expandTimeoutRef.current);
            expandTimeoutRef.current = null;
        }

        if (!isHovered || collapseTimeoutRef.current !== null) {
            return;
        }

        collapseTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(false);
            collapseTimeoutRef.current = null;
        }, HOVER_COLLAPSE_DELAY_MS);
    };

    const handleClick = () => {
        if (isPositioning) {
            return;
        }
        if (currentView !== 'lattice') {
            onNavigateToPlayer();
        } else {
            onFocusLatticeCurrentSong?.();
        }
    };

    if (hideControlBar) {
        return null;
    }

    return (
        <>
            {/*
                定位层和动画层必须分开。这一层用 Tailwind 的 `-translate-x-1/2` 做水平居中，
                而下面那层的 animate 会写 y/scale —— framer-motion 生成的 transform 会整个
                盖掉同一节点上的 Tailwind transform，合并两层会让胶囊丢失居中、向右偏出去。
                bottom 走共享 MotionValue（默认 32，即原来的 bottom-8），不是 transform 属性，
                所以挂在这一层不会干扰居中。
            */}
            <motion.div
                className={`absolute left-1/2 -translate-x-1/2 z-60 w-full flex justify-center pointer-events-none
                    ${isPortraitAndroid
                        // Android 竖屏：胶囊收窄，右边让出 56px 给右下角工具按钮（24px 边距 + 48px 按钮 + 4px 间距，按钮悬在胶囊上方），
                        // 左右对称保持居中；比之前稍长一点，视觉更平衡。
                        ? 'max-w-[calc(100vw-112px)]'
                        : currentView === 'home'
                            ? 'max-w-[calc(100vw-120px)] md:max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),calc(100vw-120px))]'
                            : 'max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),100vw)] px-4'}`}
                style={{ bottom: bottomBarBottomPx }}
                onUpdate={invalidateLayout}
            >
            <motion.div
                className="w-full flex justify-center transition-all duration-300 pointer-events-none"
                onUpdate={invalidateLayout}
                initial={false}
                animate={{
                    opacity: isHidden ? 0 : 1,
                    y: isHidden ? 24 : 0,
                    scale: isHidden ? 0.97 : 1,
                }}
                transition={{ duration: 0.26, ease: 'easeOut' }}
                style={{ pointerEvents: isHidden ? 'none' : 'auto' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    className="pointer-events-auto w-full flex justify-center"
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    style={{
                        // 这块向下的命中区补丁只在胶囊贴底时才有意义；抬高之后按当前偏移量收敛，
                        // 否则胶囊下方会留一条既不可点也挡不住东西的死区。
                        paddingBottom: `${hoverHitboxBufferPx}px`,
                        marginBottom: `${-hoverHitboxBufferPx}px`,
                    }}
                >
                    <motion.div
                        ref={(element: HTMLDivElement | null) => {
                            layoutRef(element);
                            capsuleBarRef.current = element;
                        }}
                        onUpdate={invalidateLayout}
                        onLayoutAnimationComplete={invalidateLayout}
                        layout
                        transition={{ layout: CONTROL_LAYOUT_SPRING }}
                        onClick={handleClick}
                        // 用原生 pointer 事件而不是 framer-motion 的 drag：位移已经由 playerBottomBarLiveOffset
                        // 经外层 lift 表达，再让 drag 往这个节点写一份 y 会叠加成两倍位移；
                        // 而且 dragConstraints 依赖的起始值放在 ref 里不会触发重渲染，读到的会是上一帧的。
                        data-ponder="player-bar"
                        // 折叠态才挂长按锚点：展开态里这个属性要留给胶囊内部的标题行 / 进度条，
                        // 免得委托层把整个胶囊都当成「已由元素级 hook 接管」而让路。
                        data-folia-long-press={!showExpanded && !isPositioning ? 'player-expand' : undefined}
                        onPointerDown={(e) => {
                            capsuleLongPress.longPressProps.onPointerDown(e);
                            handlePositionDragStart(e);
                        }}
                        onPointerMove={(e) => {
                            capsuleLongPress.longPressProps.onPointerMove(e);
                            handlePositionDragMove(e);
                        }}
                        onPointerUp={(e) => {
                            capsuleLongPress.longPressProps.onPointerUp(e);
                            handlePositionDragEnd(e);
                        }}
                        onPointerCancel={(e) => {
                            capsuleLongPress.longPressProps.onPointerCancel(e);
                            handlePositionDragEnd(e);
                        }}
                        onClickCapture={capsuleLongPress.longPressProps.onClickCapture}
                        style={{ touchAction: isPositioning ? 'none' : undefined }}
                        className={`backdrop-blur-xl shadow-2xl overflow-hidden rounded-full relative transition-colors duration-300
                            ${isPositioning ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
                            ${showExpanded ? `p-3 ${glassBgExpanded} w-full` : `px-4 py-2 ${glassBgCollapsed} ${COLLAPSED_WIDTH_CLASS}`}`}
                    >
                        <motion.div
                            layout
                            transition={{ layout: CONTROL_LAYOUT_SPRING }}
                            // 定位模式下 seek 和所有按钮一起失效：这时胶囊是个被拖的物体，不是控件。
                            className={`w-full ${isPositioning ? 'pointer-events-none select-none' : ''}`}
                        >
                            {showExpanded ? (
                                <ExpandedView
                                    currentSong={currentSong}
                                    playerState={playerState}
                                    currentTime={currentTime}
                                    lyricCurrentTime={lyricCurrentTime}
                                    duration={duration}
                                    canTogglePlay={canTogglePlay}
                                    onSeek={onSeek}
                                    onTogglePlay={onTogglePlay}
                                    noTrackText={noTrackText}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    isDaylight={isDaylight}
                                    controlsDisabled={controlsDisabled || isPositioning}
                                    trackNavigation={trackNavigation}
                                    slotPrimary={slotPrimary}
                                    slotSecondary={slotSecondary}
                                    slotContext={resolvedSlotContext}
                                    showHomeCollapse={isPortraitAndroid && currentView === 'home'}
                                    onCollapseHome={collapseHomeCapsule}
                                />
                            ) : (
                                <CollapsedView
                                    currentTime={currentTime}
                                    duration={duration}
                                    onSeek={onSeek}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    controlsDisabled={controlsDisabled}
                                    showHomeExpand={isPortraitAndroid && currentView === 'home'}
                                    onExpandHome={expandHomeCapsule}
                                />
                            )}
                        </motion.div>
                    </motion.div>
                </div>
            </motion.div>
            </motion.div>

            <AnimatePresence>
                {isPositioning && (
                    <PlayerBottomBarPositioner
                        maxOffsetPx={maxOffsetPx}
                        accentColor={primaryColor}
                        isDaylight={isDaylight}
                        onReset={() => playerBottomBarLiveOffset.set(PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)}
                        onCommit={handleCommitPositioning}
                        onCancel={cancelPositioning}
                    />
                )}
            </AnimatePresence>

            <LyricsTimelineModal
                isOpen={isTimelineOpen}
                onClose={() => setIsTimelineOpen(false)}
                lyrics={lyrics}
                duration={duration}
                currentTime={lyricCurrentTime ?? currentTime}
                onSeek={(time) => {
                    const offset = currentTime.get() - (lyricCurrentTime?.get() ?? currentTime.get());
                    onSeek(Math.max(0, time + offset));
                }}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                accentColor="var(--text-accent)"
                theme={theme}
                isDaylight={isDaylight}
                disabled={controlsDisabled}
            />
        </>
    );
};

// 展开视图组件
interface ExpandedViewProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    canTogglePlay: boolean;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    noTrackText: string;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    isDaylight?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    slotContext: PlayerControlSlotContext;
    /** Android 竖屏主页：显示「收起胶囊」按钮。 */
    showHomeCollapse?: boolean;
    onCollapseHome?: () => void;
}

const ExpandedView: React.FC<ExpandedViewProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    canTogglePlay,
    onSeek,
    onTogglePlay,
    noTrackText,
    primaryColor,
    secondaryColor,
    trackColor,
    isDaylight,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
    showHomeCollapse = false,
    onCollapseHome,
}) => {
    const { t } = useTranslation();
    // 触屏上 ← / → 的等价物：长按进度条两侧的空白带快退 / 快进。锚点摆在进度条「两侧」
    // 而不是压在进度条上 —— 后者会撞上 range input 自己的拖动 seek（按下不动 400ms 后松手
    // 仍会按触点位置绝对 seek 一次，把这里的相对 seek 覆盖掉）。
    const platformAndroid = useMemo(() => isAndroid(), []);
    const canTouchSeek = platformAndroid && !controlsDisabled && duration > 0;
    const seekBackLongPress = useAndroidLongPress({
        action: 'player-seek',
        enabled: canTouchSeek,
        onLongPress: () => onSeek(Math.max(0, currentTime.get() - TOUCH_SEEK_STEP_SEC)),
    });
    const seekForwardLongPress = useAndroidLongPress({
        action: 'player-seek',
        enabled: canTouchSeek,
        onLongPress: () => onSeek(Math.min(duration, currentTime.get() + TOUCH_SEEK_STEP_SEC)),
    });

    return (
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            {/* Desktop Layout - responsive grid positions apply from the sm breakpoint */}
            {/* Mobile Layout - base grid positions apply below the sm breakpoint */}
            {/* Row 1: Centered Title */}
            {/* 收起按钮在流内（右侧）+ 左侧等宽占位：标题保持居中，且按钮不会探出圆角胶囊的边缘
                （胶囊是 rounded-full 药丸形，绝对定位贴边的按钮会探出右端弧线）。 */}
            <div className="col-span-3 row-start-1 min-w-0 px-2 flex items-center gap-1 sm:col-start-2 sm:col-span-1">
                {showHomeCollapse && <span className="mr-4 h-6 w-6 shrink-0" aria-hidden="true" />}
                <div className="flex-1 min-w-0">
                {trackNavigation ? (
                    <TrackTitleNavigator
                        title={currentSong?.name || noTrackText}
                        trackKey={trackNavigation.currentTrackKey}
                        prevTitle={trackNavigation.prevTitle}
                        nextTitle={trackNavigation.nextTitle}
                        canPrev={trackNavigation.canPrev}
                        canNext={trackNavigation.canNext}
                        onPrev={trackNavigation.onPrev}
                        onNext={trackNavigation.onNext}
                        prevLabel={trackNavigation.prevLabel}
                        nextLabel={trackNavigation.nextLabel}
                        color={primaryColor}
                        isDaylight={isDaylight}
                        disabled={controlsDisabled}
                    />
                ) : (
                    <div className="truncate text-center text-sm font-bold select-none" style={{ color: primaryColor }}>
                        {currentSong?.name || noTrackText}
                    </div>
                )}
                </div>
                {showHomeCollapse && (
                    // 主页缩小胶囊的入口（Android 竖屏主页专属）。流内靠右 + 左等宽占位，
                    // 标题居中不受挤压；mr-4 让按钮避开药丸形右端弧线（否则会探出胶囊边缘）。
                    // 阻止冒泡，避免触发标题行的长按（自定义命令）。
                    <button
                        type="button"
                        aria-label={t('player.capsuleCollapseHome')}
                        title={t('player.capsuleCollapseHome')}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            onCollapseHome?.();
                        }}
                        className="mr-4 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90"
                        style={{
                            color: secondaryColor,
                            backgroundColor: isDaylight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.12)',
                        }}
                    >
                        <ChevronDown size={14} />
                    </button>
                )}
            </div>

            {/* Row 3: Loop Button, Play Button, Lyrics Button */}
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePlay();
                }}
                disabled={!canTogglePlay || controlsDisabled}
                className={`col-start-2 row-start-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-none bg-(--text-primary) text-black shadow-lg transition-transform sm:col-start-1 sm:row-start-1 sm:row-span-2 ${controlsDisabled ? 'cursor-not-allowed opacity-45' : 'hover:scale-105'}`}
                style={{ backgroundColor: primaryColor, color: 'var(--bg-color)' }}
            >
                {playerState === PlayerState.PLAYING ? (
                    <Pause size={20} fill="currentColor" />
                ) : (
                    <Play size={20} fill="currentColor" className="ml-1" />
                )}
            </button>

            {/* 两个可自定义槽位。默认仍是循环模式 + 歌词时间轴，和改动前一致。 */}
            <div
                data-ponder-slots
                className="contents sm:col-start-3 sm:row-start-1 sm:row-span-2 sm:flex sm:items-center sm:gap-1"
            >
                <PlayerControlSlotButton
                    actionId={slotPrimary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-1 row-start-2 justify-self-end sm:justify-self-auto"
                />

                <PlayerControlSlotButton
                    actionId={slotSecondary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-3 row-start-2 justify-self-start sm:justify-self-auto"
                />
            </div>

            {/* Row 2: Current Time, Progress Bar, Duration */}
            <div className="col-span-3 row-start-3 w-full px-2 sm:col-start-2 sm:col-span-1 sm:row-start-2 flex items-center gap-2">
                {/* 两侧的长按带只在 Android 渲染：桌面端保持原有满宽布局。 */}
                {platformAndroid && (
                    <div
                        {...seekBackLongPress.longPressProps}
                        aria-hidden
                        className="h-9 w-9 shrink-0 rounded-full"
                    />
                )}
                <div className="min-w-0 flex-1">
                    <ProgressBar
                        currentTime={currentTime}
                        duration={duration}
                        onSeek={onSeek}
                        primaryColor={primaryColor}
                        secondaryColor={secondaryColor}
                        trackColor={trackColor}
                        disabled={controlsDisabled}
                    />
                </div>
                {platformAndroid && (
                    <div
                        {...seekForwardLongPress.longPressProps}
                        aria-hidden
                        className="h-9 w-9 shrink-0 rounded-full"
                    />
                )}
            </div>
        </div>
    );
};

// 折叠视图组件
interface CollapsedViewProps {
    currentTime: MotionValue<number>;
    duration: number;
    onSeek: (time: number) => void;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    controlsDisabled?: boolean;
    /** Android 竖屏主页缩小态：显示「展开胶囊」按钮。 */
    showHomeExpand?: boolean;
    onExpandHome?: () => void;
}

const CollapsedView: React.FC<CollapsedViewProps> = ({
    currentTime,
    duration,
    onSeek,
    primaryColor,
    secondaryColor,
    trackColor,
    controlsDisabled = false,
    showHomeExpand = false,
    onExpandHome,
}) => {
    const { t } = useTranslation();
    return (
        <div className="flex items-center w-full h-8 px-4 gap-2">
            <div className="min-w-0 flex-1">
                <ProgressBar
                    currentTime={currentTime}
                    duration={duration}
                    onSeek={onSeek}
                    primaryColor={primaryColor}
                    secondaryColor={secondaryColor}
                    trackColor={trackColor}
                    disabled={controlsDisabled}
                    collapsed
                />
            </div>
            {showHomeExpand && (
                // 恢复主页常驻展开。阻止冒泡：胶囊本身的点击是「去播放页」，
                // pointerdown 冒泡还会触发胶囊的展开长按，都要绕开。
                <button
                    type="button"
                    aria-label={t('player.capsuleExpandHome')}
                    title={t('player.capsuleExpandHome')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        onExpandHome?.();
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90"
                    style={{ color: secondaryColor }}
                >
                    <ChevronUp size={15} />
                </button>
            )}
        </div>
    );
};

export default FloatingPlayerControls;
