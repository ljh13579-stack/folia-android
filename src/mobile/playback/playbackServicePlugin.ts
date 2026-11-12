import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// src/mobile/playback/playbackServicePlugin.ts
// FoliaPlayback 原生插件（Android 后台播放）的 JS 类型与入口。
// 原生实现见 android/app/src/main/java/top/izuna/foliamajor/FoliaPlaybackPlugin.java。
// 契约：start 拉起前台服务；updateState 推送当前曲目与播放状态；stop 停止服务；
// remoteAction 事件回传系统媒体按键（play/pause/next/previous）。

export type FoliaRemoteAction = 'play' | 'pause' | 'next' | 'previous';

export interface FoliaPlaybackUpdate {
    title: string;
    artist: string;
    album: string;
    /** 仅 http(s) 封面可被原生读取；本地曲库的 blob URL 无法过桥，传空字符串 */
    artworkUrl: string;
    playing: boolean;
    positionMs: number;
    durationMs: number;
}

export interface FoliaPlaybackPlugin {
    start(): Promise<void>;
    updateState(options: FoliaPlaybackUpdate): Promise<void>;
    stop(): Promise<void>;
    addListener(
        eventName: 'remoteAction',
        listenerFunc: (event: { action: FoliaRemoteAction }) => void,
    ): Promise<PluginListenerHandle>;
}

export const FoliaPlayback = registerPlugin<FoliaPlaybackPlugin>('FoliaPlayback');
