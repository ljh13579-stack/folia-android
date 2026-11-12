import React, { useEffect, useRef, useState } from 'react';
import { Disc, Home as HomeIcon, MirrorRectangular, Settings, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SongResult } from '../../../types';
import { getProviderSongMetadata } from '../../../services/onlineMusic/songMetadata';
import { getSizedCoverUrl } from '../../../utils/coverUrl';
import { LikeButton, type SongLike } from './LikeButton';
import { useMeasuredSize } from './useMeasuredSize';

// src/components/panelTab/shell/SongHeader.tsx
// The playing song at the top of the panel. On the cover tab it is the large cover with what the
// caller puts under it (title, artists, album, the row of actions). On every other tab it folds to
// one line: a small cover, title, artist and the heart; a press on that line goes to the cover tab.
// Both forms are in the document at once, so the cover can grow and shrink between them.
//
// 大封面的四个角上还各藏着一颗按钮（设置 / 播放页透明 / 回主页 / 加入歌单）：桌面 hover
// 封面时滑出，触屏点一下封面切换显隐。四角平时完全看不见，所以整块封面是思索的落点：
// 指针停在封面上，讲的就是「这上面还藏着什么」。

/** The height of the folded line, and the side of its cover. */
export const FOLDED_PX = 48;
/** Between the large cover and what is under it. */
const COVER_GAP_PX = 14;
/** The large cover is never lower than this, however short the window. */
const MIN_COVER_PX = 96;

/** 四角按钮的显隐过渡：按角给滑入方向。 */
const cornerRevealClass = (visible: boolean, supportsHover: boolean, corner: 'tl' | 'tr' | 'bl' | 'br'): string => {
    const offset = {
        tl: '-translate-x-3 -translate-y-3',
        tr: 'translate-x-3 -translate-y-3',
        bl: '-translate-x-3 translate-y-3',
        br: 'translate-x-3 translate-y-3',
    }[corner];
    if (supportsHover) {
        return `pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 ${offset} group-hover:translate-x-0 group-hover:translate-y-0`;
    }
    return visible
        ? 'pointer-events-auto opacity-100 translate-x-0 translate-y-0'
        : `pointer-events-none opacity-0 ${offset}`;
};

type SongHeaderProps = {
    /** The cover tab is open: the large form. */
    isBig: boolean;
    currentSong: SongResult | null;
    coverUrl: string | null;
    like: SongLike;
    /** Goes to the cover tab. */
    onShowCover: () => void;
    /** What stands under the large cover. */
    children: React.ReactNode;
    /** 左上角：打开设置。没有就不渲染这颗。 */
    onOpenSettings?: () => void;
    /** 左下角：回主页。 */
    onNavigateHome?: () => void;
    /** 右上角：播放页透明开关。 */
    transparentPlayerBackground?: boolean;
    onToggleTransparentPlayerBackground?: (enabled: boolean) => void;
    /** 右下角：加入歌单。show 为 false 时不渲染。 */
    addToPlaylist?: {
        show: boolean;
        canAdd: boolean;
        disabledReason: string | null;
        onOpen: () => void;
    };
};

const SongHeader: React.FC<SongHeaderProps> = ({
    isBig,
    currentSong,
    coverUrl,
    like,
    onShowCover,
    children,
    onOpenSettings,
    onNavigateHome,
    transparentPlayerBackground,
    onToggleTransparentPlayerBackground,
    addToPlaylist,
}) => {
    const { t } = useTranslation();
    const underRef = useRef<HTMLDivElement>(null);
    const under = useMeasuredSize(underRef);
    const artists = (currentSong ? getProviderSongMetadata(currentSong).artists : []).map(artist => artist.name).join(' / ');
    // The large cover is a square as wide as the panel's inside (100cqw), and lower where the
    // window leaves less: --pn-room is the height PanelShell can give this header.
    const underPx = COVER_GAP_PX + under.height;
    const coverHeight = `clamp(${MIN_COVER_PX}px, calc(var(--pn-room) - ${underPx}px), 100cqw)`;

    const supportsHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    // Android 竖屏触控目标放大到 48px（Material 下限），桌面保持 44px。
    const coverActionSizeClass = supportsHover ? 'w-11 h-11' : 'w-12 h-12';
    const coverAreaRef = useRef<HTMLDivElement>(null);
    const [isCoverActionsVisible, setIsCoverActionsVisible] = useState(false);

    // 换歌或离开封面页时收起四角按钮。
    useEffect(() => {
        setIsCoverActionsVisible(false);
    }, [currentSong?.id, isBig]);

    // 触屏上点封面之外的地方就把四角按钮收起来。
    useEffect(() => {
        if (supportsHover || !isCoverActionsVisible) {
            return undefined;
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) {
                return;
            }

            if (!coverAreaRef.current?.contains(target)) {
                setIsCoverActionsVisible(false);
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [isCoverActionsVisible, supportsHover]);

    const hasCoverActions = Boolean(
        isBig && (onOpenSettings || onNavigateHome || onToggleTransparentPlayerBackground || addToPlaylist?.show),
    );

    return (
        <header
            className="st-t-unfold relative shrink-0 overflow-hidden transition-[height]"
            style={{ height: isBig ? `calc(${coverHeight} + ${underPx}px)` : FOLDED_PX }}
        >
            {/* The cover is where the lessons about this panel's song buttons point (data-ponder-panel-artwork). */}
            <div
                ref={coverAreaRef}
                data-ponder-panel-artwork
                onClick={isBig
                    ? (event) => {
                        event.stopPropagation();
                        if (!supportsHover && hasCoverActions) {
                            setIsCoverActionsVisible(prev => !prev);
                        }
                    }
                    : onShowCover}
                className={`st-t-unfold absolute left-0 top-0 grid place-items-center overflow-hidden bg-[var(--st-fill)] transition-[width,height,border-radius] ${isBig ? 'group rounded-[10px]' : 'cursor-pointer rounded-lg'}`}
                style={isBig ? { width: '100%', height: coverHeight } : { width: FOLDED_PX, height: FOLDED_PX }}
            >
                {coverUrl ? (
                    <img src={getSizedCoverUrl(coverUrl, 512)} alt="Art" decoding="async" className="h-full w-full object-cover" />
                ) : (
                    <Disc size={isBig ? 40 : 20} className="text-[color:var(--st-t3)]" />
                )}
                <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--st-line)]" />

                {hasCoverActions && (
                    <>
                        <div className={`absolute inset-0 pointer-events-none transition-opacity duration-200 ${
                            supportsHover
                                ? 'opacity-0 group-hover:opacity-100'
                                : (isCoverActionsVisible ? 'opacity-100' : 'opacity-0')
                        }`}>
                            <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                        </div>

                        {/* 左上角：打开设置 */}
                        {onOpenSettings && (
                            <div className={`absolute left-3 top-3 transition-all duration-200 ${cornerRevealClass(isCoverActionsVisible, supportsHover, 'tl')}`}>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onOpenSettings();
                                    }}
                                    className={`${coverActionSizeClass} rounded-full border border-white/15 bg-black/25 text-white/90 backdrop-blur-md flex items-center justify-center transition-all hover:bg-black/40 hover:text-white`}
                                    title={t('ui.options')}
                                >
                                    <Settings size={18} />
                                </button>
                            </div>
                        )}

                        {/* 右上角：播放页透明。不算高频，所以只占封面的空位，不占面板结构。 */}
                        {onToggleTransparentPlayerBackground && (
                            <div className={`absolute right-3 top-3 transition-all duration-200 ${cornerRevealClass(isCoverActionsVisible, supportsHover, 'tr')}`}>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onToggleTransparentPlayerBackground(!transparentPlayerBackground);
                                    }}
                                    className={`${coverActionSizeClass} rounded-full border backdrop-blur-md flex items-center justify-center transition-all ${
                                        transparentPlayerBackground
                                            ? 'border-white/30 bg-white/85 text-zinc-900 hover:bg-white'
                                            : 'border-white/15 bg-black/25 text-white/90 hover:bg-black/40 hover:text-white'
                                    }`}
                                    title={t('options.transparentPlayerBackground')}
                                    aria-label={t('options.transparentPlayerBackground')}
                                    aria-pressed={transparentPlayerBackground}
                                >
                                    <MirrorRectangular size={18} />
                                </button>
                            </div>
                        )}

                        {/* 左下角：回主页 */}
                        {onNavigateHome && (
                            <div className={`absolute left-3 bottom-3 transition-all duration-200 ${cornerRevealClass(isCoverActionsVisible, supportsHover, 'bl')}`}>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onNavigateHome();
                                    }}
                                    className={`${coverActionSizeClass} rounded-full border border-white/15 bg-black/25 text-white/90 backdrop-blur-md flex items-center justify-center transition-all hover:bg-black/40 hover:text-white`}
                                    title={t('ui.backToHome')}
                                >
                                    <HomeIcon size={18} />
                                </button>
                            </div>
                        )}

                        {/* 右下角：加入歌单 */}
                        {addToPlaylist?.show && (
                            <div
                                title={addToPlaylist.disabledReason || t('localMusic.addToPlaylist')}
                                className={`absolute right-3 bottom-3 transition-all duration-200 ${cornerRevealClass(isCoverActionsVisible, supportsHover, 'br')}`}
                            >
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (!addToPlaylist.canAdd) return;
                                        setIsCoverActionsVisible(false);
                                        addToPlaylist.onOpen();
                                    }}
                                    disabled={!addToPlaylist.canAdd}
                                    className={`${coverActionSizeClass} rounded-full border border-white/15 bg-black/25 text-white/90 backdrop-blur-md flex items-center justify-center transition-all hover:bg-black/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/25`}
                                    title={addToPlaylist.disabledReason || t('localMusic.addToPlaylist')}
                                    aria-label={addToPlaylist.disabledReason || t('localMusic.addToPlaylist')}
                                >
                                    <Star size={18} />
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            <button
                // A new song's line comes in as a page of the kit does.
                key={currentSong?.id ?? ''}
                type="button"
                onClick={onShowCover}
                inert={isBig}
                className={`st-page-in st-t-move absolute left-[60px] right-11 top-[5px] flex flex-col text-left transition-[opacity,translate] ${isBig ? '-translate-y-1 opacity-0' : ''}`}
            >
                <span className="truncate text-sm font-semibold leading-5">{currentSong?.name || t('ui.noTrack')}</span>
                <span className="truncate text-xs leading-[18px] text-[color:var(--st-t2)]">{artists}</span>
            </button>
            <LikeButton
                like={like}
                className={`st-t-move absolute right-0 top-2 transition-[opacity,translate,visibility] ${isBig ? 'invisible -translate-y-1 opacity-0' : ''}`}
            />

            <div
                ref={underRef}
                inert={!isBig}
                className={`absolute inset-x-1 bottom-0 transition-[opacity,translate,visibility] ${isBig ? 'st-t-move' : 'st-t-fast invisible translate-y-2 opacity-0'}`}
            >
                {children}
            </div>
        </header>
    );
};

export default SongHeader;
