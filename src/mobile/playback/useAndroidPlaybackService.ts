import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../../types';
import type { SongResult } from '../../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../../services/onlineMusic/songMetadata';
import { isAndroid } from '../platform';
import { FoliaPlayback, type FoliaRemoteAction } from './playbackServicePlugin';

// src/mobile/playback/useAndroidPlaybackService.ts
// 仅在 Android（Capacitor）下生效：把当前曲目元数据与播放状态推给原生前台服务，
// 使音频在 WebView 退到后台时仍能继续播放，并获得系统媒体控件/锁屏/蓝牙按键。
// 浏览器端的 navigator.mediaSession 路径不受影响（useMediaSessionBridge 同时保留两条路径）。

type UseAndroidPlaybackServiceOptions = {
    audioSrc: string | null;
    currentSong: SongResult | null;
    cachedCoverUrl: string | null;
    playerState: PlayerState;
    /** 与浏览器 MediaSession 桥共用：拿到「正在展示」的那块 deck 以读取进度/时长 */
    getDisplayAudioElement?: () => HTMLAudioElement | null;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
    unknownArtistLabel: string;
};

/** 读取显示中曲目的元数据并推送到前台服务；无真实字节可读时进度取 0。 */
const pushTrackState = (options: UseAndroidPlaybackServiceOptions) => {
    const song = options.currentSong;
    const audio = options.getDisplayAudioElement?.() ?? null;

    const rawCover = options.cachedCoverUrl || (song ? getSongCoverUrl(song) : '') || '';
    // blob:/data: 封面原生无法读取，仅接受可直接访问的 http(s) 图片
    const artworkUrl = rawCover.startsWith('http') ? rawCover : '';

    const durationMs = audio && Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
    const positionMs = audio && Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0;

    void FoliaPlayback.updateState({
        title: song ? song.name : '',
        artist: song ? (getSongArtistLabel(song) || options.unknownArtistLabel) : '',
        album: song ? getSongAlbumLabel(song) : '',
        artworkUrl,
        playing: options.playerState === PlayerState.PLAYING,
        positionMs,
        durationMs,
    }).catch(() => undefined);
};

export const useAndroidPlaybackService = (options: UseAndroidPlaybackServiceOptions) => {
    const enabled = isAndroid();
    // 保存最新一次入参：事件回调与进度定时器都从 ref 读取，避免把回调写进依赖导致频繁重订阅
    const latest = useRef(options);
    latest.current = options;

    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let handle: { remove: () => Promise<void> } | null = null;

        void FoliaPlayback.start().catch(() => undefined);
        void FoliaPlayback.addListener('remoteAction', event => {
            const action: FoliaRemoteAction = event.action;
            const current = latest.current;
            if (current.isNowPlayingControlDisabledRef.current) return;
            switch (action) {
                case 'play':
                    void current.mediaSessionPlayRef.current().catch(() => undefined);
                    break;
                case 'pause':
                    current.mediaSessionPauseRef.current();
                    break;
                case 'previous':
                    current.mediaSessionPrevRef.current();
                    break;
                case 'next':
                    void current.mediaSessionNextRef.current();
                    break;
                default:
                    break;
            }
        }).then(registered => {
            if (disposed) {
                void registered.remove();
                return;
            }
            handle = registered;
        });

        return () => {
            disposed = true;
            if (handle) void handle.remove();
            void FoliaPlayback.stop().catch(() => undefined);
        };
    }, [enabled]);

    // 曲目/播放状态/封面变化时立即同步一次
    useEffect(() => {
        if (!enabled) return;
        pushTrackState(latest.current);
    }, [enabled, options.audioSrc, options.cachedCoverUrl, options.currentSong, options.playerState]);

    // 播放中每 4s 刷新进度，供系统媒体控件显示进度条
    useEffect(() => {
        if (!enabled || options.playerState !== PlayerState.PLAYING) return;
        const timer = window.setInterval(() => pushTrackState(latest.current), 4000);
        return () => window.clearInterval(timer);
    }, [enabled, options.playerState]);
};
