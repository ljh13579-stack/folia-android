import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import { useVocalMixStore } from '../../stores/useVocalMixStore';
import { usePlayerBottomBarBottomPx } from '../../hooks/usePlayerBottomBarBottomPx';
import { PLAYER_BOTTOM_BAR_BASE_OFFSET_PX } from '../../utils/playerBottomBarLayout';

// src/mobile/playback/VocalMixControl.tsx
// 播放页右下角、面板开关正上方的人声/伴奏滑块。收起时是一颗按钮（点击展开到中点，
// 即原声），展开后是竖向滑块：顶端纯人声、底端纯伴奏，中间按比例叠加。
// 音频侧是中置声道提取（见 services/vocalMixGraph.ts），只限竖屏安卓——横屏不加，
// 桌面不动。

/** 按钮停在面板开关上方：开关高 48px，再留 16px 间距。 */
const BUTTON_BASE_BOTTOM_PX = PLAYER_BOTTOM_BAR_BASE_OFFSET_PX + 64;

const TRACK_HEIGHT_PX = 224;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** 中点（原声）隐形卡位的吸附半径（滑块全长的比例）。 */
const CENTER_DETENT = 0.5;
const DETENT_RADIUS = 0.045;
/** 吸住卡位时的震动时长（ms），不支持震动的环境静默跳过。 */
const DETENT_VIBRATE_MS = 12;

type VocalMixControlProps = {
    theme: Theme;
    isDaylight: boolean;
};

const VocalMixControl: React.FC<VocalMixControlProps> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const position = useVocalMixStore(state => state.position);
    const setPosition = useVocalMixStore(state => state.setPosition);
    const bottomPx = usePlayerBottomBarBottomPx(BUTTON_BASE_BOTTOM_PX);
    const isOpen = position !== null;
    const trackRef = React.useRef<HTMLDivElement | null>(null);
    const isDraggingRef = React.useRef(false);
    const isAtDetentRef = React.useRef(false);

    const writeFromPointer = (clientY: number) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        if (rect.height <= 0) return;
        // 顶端 = 人声（1），底端 = 伴奏（0）。
        let next = clamp01(1 - (clientY - rect.top) / rect.height);
        // 中点（原声）隐形卡位：拖进小半径内就磁吸到 50%，要拖出半径才放行，
        // 经过时「顿一下」。首次吸住给一次轻震反馈。
        if (Math.abs(next - CENTER_DETENT) < DETENT_RADIUS) {
            if (!isAtDetentRef.current) {
                isAtDetentRef.current = true;
                navigator.vibrate?.(DETENT_VIBRATE_MS);
            }
            next = CENTER_DETENT;
        } else {
            isAtDetentRef.current = false;
        }
        setPosition(next);
    };

    const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        isDraggingRef.current = true;
        // 合成事件（自动化测试）里的 pointerId 没有活动指针，setPointerCapture 会抛
        // NotFoundError 并中断整条手势；真机上不会。捕获失败不碍事：拖动靠
        // pointerdown 后落在同一元素上的 pointermove（已 setPointerCapture 时则稳拿）。
        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
            // ignore
        }
        writeFromPointer(event.clientY);
    };
    const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!isDraggingRef.current) return;
        writeFromPointer(event.clientY);
    };
    const endDrag = () => {
        isDraggingRef.current = false;
        isAtDetentRef.current = false;
    };

    const handleButtonClick = () => {
        // 展开落在中点（原声），再点收起并恢复原声；展开中点按钮只负责收放，
        // 位置由滑块写。
        setPosition(isOpen ? null : 0.5);
    };

    const shellClass = isDaylight
        ? 'border-black/10 bg-white/80 text-zinc-900'
        : 'border-white/15 bg-zinc-900/80 text-white';
    const activeShellClass = isDaylight
        ? 'border-black/10 bg-white text-zinc-900'
        : 'border-white/20 bg-zinc-800 text-white';

    return (
        <motion.div
            className="pointer-events-auto fixed right-4 z-[60] flex flex-col items-center gap-3"
            style={{ bottom: bottomPx }}
        >
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        key="vocal-mix-panel"
                        initial={{ opacity: 0, y: 12, scale: 0.94 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.94 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className={`flex flex-col items-center gap-2 rounded-3xl border px-3 py-3 shadow-lg backdrop-blur-md ${shellClass}`}
                    >
                        <span className="text-[10px] font-medium tracking-wide opacity-70">
                            {t('player.vocalMixVocals', '人声')}
                        </span>
                        <div
                            ref={trackRef}
                            role="slider"
                            aria-label={t('player.vocalMix', '人声 / 伴奏')}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round((position ?? 0.5) * 100)}
                            onPointerDown={handleTrackPointerDown}
                            onPointerMove={handleTrackPointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            style={{ height: TRACK_HEIGHT_PX, touchAction: 'none' }}
                            className={`relative flex w-10 cursor-pointer items-stretch justify-center rounded-full border ${
                                isDaylight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-white/10'
                            }`}
                        >
                            {/* 从底端（伴奏）填到当前位置。 */}
                            <div
                                className="absolute bottom-1 left-1 right-1 rounded-full"
                                style={{
                                    height: `calc(${((position ?? 0.5) * 100).toFixed(1)}% - 8px)`,
                                    minHeight: 8,
                                    backgroundColor: theme.accentColor,
                                    opacity: 0.55,
                                }}
                            />
                            {/* 滑块指示点 */}
                            <div
                                className="pointer-events-none absolute left-1 right-1 h-6 w-auto rounded-full border shadow"
                                style={{
                                    bottom: `calc(${((position ?? 0.5) * 100).toFixed(1)}% - 12px)`,
                                    backgroundColor: isDaylight ? '#ffffff' : '#27272a',
                                    borderColor: isDaylight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.18)',
                                }}
                            />
                        </div>
                        <span className="text-[10px] font-medium tracking-wide opacity-70">
                            {t('player.vocalMixInstruments', '伴奏')}
                        </span>
                    </motion.div>
                )}
            </AnimatePresence>

            <button
                type="button"
                onClick={handleButtonClick}
                aria-label={t('player.vocalMix', '人声 / 伴奏')}
                aria-pressed={isOpen}
                className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-all duration-200 active:scale-95 ${
                    isOpen ? activeShellClass : shellClass
                }`}
            >
                <AudioLines size={20} aria-hidden="true" />
            </button>
        </motion.div>
    );
};

export default VocalMixControl;
