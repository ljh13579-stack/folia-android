import React, { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { useSupportsFinePointer } from '../../hooks/useSupportsFinePointer';
import { usePonderStore } from '../../stores/usePonderStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import { usePonderTouchDrag } from '../../hooks/usePonderTouchDrag';
import { useBurnInDrift } from '../../mobile/useBurnInDrift';
import type { Theme } from '../../types';

// src/components/ponder/PagePonderTouchButton.tsx
// 触屏上代替「悬停 + 长按 G」和「Ctrl+G」的两条入口，都挂在这一颗灯泡上：
// 点一下讲当前整页，按住它拖到某个控件上松手则讲那个控件。
//
// 它贴右上角，不贴右下角：右下角是操作按钮最密的一块地方 —— 底部控制条、集合页那颗
// 列表/搜索按钮、播放页的侧边手柄都挤在那儿，一颗常驻的浮动按钮压上去就是挡路。
//
// 它是常驻的，不再露几秒就自己收起。上一版是一颗限时按钮：落地或换页时露四秒，之后
// 点右上角那块热区唤回。那套做法的前提是「它只需要被点一下」—— 拖动要求它必须在场：
// 想拖的时候它不在，用户得先去右上角把它叫出来再拖，而「叫出来」那一下之后只剩几秒，
// 正是拖拽最容易失败的一步。代价是它一直占着右上角一块 48px 的地方，不想要它的人
// 可以在设置里彻底关掉（showPonderTouchButton）。
//
// 随之一起删掉的是那块热区（window 上的 passive 监听按坐标判）：按钮常驻之后，
// 「按它」和「把它叫出来」是同一件事，没有第二件事要说；而那个监听还先于按钮自己的
// pointerdown 跑，在按下当刻触发一次重渲染，对指针捕获是纯粹的干扰。

type PagePonderTouchButtonProps = {
    theme?: Theme;
    isDaylight: boolean;
};

// 与 NowPlayingToast（切歌卡片）同一套入场体系：本次运行里的第一次入场从屏幕外
// spring 滑入，之后（思索会话关闭回到主页等再次出现）改用 easeOut 从 32px 滑入。
// 模块级标记跨卸载保留 —— 组件整体卸载重挂不重置「第一次」。
let hasEnteredBefore = false;

/** Touch-only equivalent of hover+G / Ctrl+G. It has no keyboard counterpart. */
const PagePonderTouchButton: React.FC<PagePonderTouchButtonProps> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const isCoarsePointer = !useSupportsFinePointer();
    const hasSession = usePonderStore(state => state.session !== null);
    const isOnboardingOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);
    const showTouchButton = usePonderStore(state => state.showPonderTouchButton);
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');

    const [isFirstEntrance, setIsFirstEntrance] = useState(!hasEnteredBefore);
    const { isDragging, ghostRef, beginDrag, consumeSuppressedClick } = usePonderTouchDrag({ accent });
    // 防烧屏漂移挂在定位外层上：按钮自己的 active:scale-95 / transition-opacity
    // 用的是 Tailwind 变换与过渡，inline 样式写进按钮会把它们盖掉。
    const driftStyle = useBurnInDrift(6, !isDragging);

    // 安卓版只保留「拖动灯泡到控件上展开思索」这一条入口；点一下讲整页的逻辑不再触发。
    if (!isCoarsePointer || !showTouchButton || hasSession || isOnboardingOpen) {
        return null;
    }

    return (
        <>
            <AnimatePresence>
                <motion.div
                    initial={{ opacity: 0, x: isFirstEntrance ? 96 : 32 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={isFirstEntrance
                        ? { type: 'spring', stiffness: 200, damping: 22, mass: 1 }
                        : { duration: 0.25, ease: 'easeOut' }}
                    onAnimationComplete={() => {
                        if (isFirstEntrance) {
                            hasEnteredBefore = true;
                            setIsFirstEntrance(false);
                        }
                    }}
                    className="fixed right-5 z-[190]"
                    style={{ top: 'calc(var(--safe-area-inset-top, 0px) + 1.25rem)', ...driftStyle }}
                >
                    <button
                        type="button"
                        data-testid="page-ponder-touch-button"
                        onPointerDown={beginDrag}
                        onClick={() => {
                            // 拖动结束时浏览器也会派发一次 click：那一下已经开过教程了，不能再讲整页。
                            if (consumeSuppressedClick()) {
                                return;
                            }
                            // 安卓版只留拖动一条入口：单击灯泡什么也不做。
                        }}
                        aria-label={t('ponder.openPage')}
                        title={t('ponder.openPage')}
                        // touch-none：手指落在它上面时是在拖它，不是滚动它底下的页面。
                        className={`flex h-12 w-12 touch-none items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-opacity duration-200 active:scale-95 ${
                            isDragging ? 'opacity-30' : 'opacity-100'
                        } ${isDaylight ? 'border-black/10 bg-white/80' : 'border-white/15 bg-zinc-900/80'}`}
                        style={{ color: accent }}
                    >
                        <Lightbulb size={20} aria-hidden="true" />
                    </button>
                </motion.div>
            </AnimatePresence>

            {/* 拖拽的幽灵：位置每帧直接写 transform（见 usePonderTouchDrag），这里只给起点。
                它必须 pointer-events-none，否则 elementFromPoint 只会命中它自己。 */}
            {isDragging && (
                <div
                    ref={ghostRef}
                    aria-hidden="true"
                    data-ponder-drag-ghost=""
                    // 不带 backdrop-blur：它是跟着手指每帧移动的，模糊层每帧都要重算背景。
                    className={`pointer-events-none fixed left-0 top-0 z-[191] flex h-12 w-12 items-center justify-center rounded-full border shadow-lg ${
                        isDaylight ? 'border-black/10 bg-white/80' : 'border-white/15 bg-zinc-900/80'
                    }`}
                    style={{ color: accent, transform: 'translate3d(-9999px, -9999px, 0)' }}
                >
                    <Lightbulb size={20} aria-hidden="true" />
                </div>
            )}
        </>
    );
};

export default PagePonderTouchButton;
