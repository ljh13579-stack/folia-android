import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// src/mobile/lanSync/lanPlugin.ts
// FoliaLan 原生插件（Android 局域网播放接续）的 JS 类型与入口。
// 原生实现见 android/app/src/main/java/top/izuna/foliamajor/FoliaLanPlugin.java。
// 契约：startAdvertising 开 UDP 信标 + TCP 服务；peers 列对端；
// sendHandoff 推接续；handoffReceived 事件接收对端推送。

import type { LanHandoffPayload, LanPeer, LanRole } from '../../services/lanSync/protocol';

export interface FoliaLanPlugin {
    startAdvertising(options: { name: string; role?: LanRole }): Promise<void>;
    stop(): Promise<void>;
    peers(): Promise<{ peers: LanPeer[] }>;
    /** 调试/诊断：本机 TCP 接续端口等。 */
    status(): Promise<{ running: boolean; port: number; name: string }>;
    sendHandoff(options: {
        host: string;
        port: number;
        payload: LanHandoffPayload;
    }): Promise<void>;
    addListener(
        eventName: 'handoffReceived',
        listenerFunc: (event: LanHandoffPayload) => void,
    ): Promise<PluginListenerHandle>;
}

export const FoliaLan = registerPlugin<FoliaLanPlugin>('FoliaLan');
