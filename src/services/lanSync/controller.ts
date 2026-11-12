// src/services/lanSync/controller.ts
// 局域网播放接续的控制器：平台后端（Android 原生插件 / Electron IPC）、对端发现轮询、
// 推送与接收接线。协议常量与纯逻辑在 ./protocol；原生插件见 android/.../FoliaLanPlugin.java；
// 桌面宿主见 electron/lanSyncHost.cjs。
//
// App.tsx 在启动时调用一次 initLanSync(deps)，由它完成：开广播+TCP 服务、每 2s 轮询对端、
// 收到对端 handoff 时回调 deps.onHandoff（App 负责搜本地曲库并播放）。
// 命令面板「推送到局域网设备」走 sendHandoffToPeer。

import { create } from 'zustand';
import { isAndroid, isElectronRuntime } from '../../mobile/platform';
import { FoliaLan } from '../../mobile/lanSync/lanPlugin';
import {
    LAN_BEACON_INTERVAL_MS,
    type LanHandoffPayload,
    type LanPeer,
} from './protocol';

export type LanBackendKind = 'android' | 'desktop' | 'none';

/** 平台后端抽象：安卓插件与 Electron preload 各实现一份。 */
export interface LanSyncBackend {
    start(options: { name: string; role: 'android' | 'desktop' }): Promise<void>;
    stop(): Promise<void>;
    peers(): Promise<LanPeer[]>;
    sendHandoff(target: { host: string; port: number }, payload: LanHandoffPayload): Promise<void>;
    /** 订阅对端推来的接续数据；返回解绑函数。 */
    onHandoff(listener: (payload: LanHandoffPayload) => void): () => void;
}

interface LanSyncStoreState {
    running: boolean;
    peers: LanPeer[];
    peersUpdatedAtMs: number;
}

export const useLanSyncStore = create<LanSyncStoreState>(() => ({
    running: false,
    peers: [],
    peersUpdatedAtMs: 0,
}));

export interface LanSyncDeps {
    /** 本机在信标里的显示名。 */
    deviceName: () => string;
    /** 组装要推出去的接续数据；返回 null 表示当前没有可推的曲目。 */
    buildHandoffPayload: () => LanHandoffPayload | null;
    /** 收到对端推送时的处理（App：搜本地曲库 → 播放 → 对进度）。 */
    onHandoff: (payload: LanHandoffPayload) => void;
}

let backend: LanSyncBackend | null = null;
let backendKind: LanBackendKind = 'none';
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeHandoff: (() => void) | null = null;
let depsRef: LanSyncDeps | null = null;

const createAndroidBackend = (): LanSyncBackend => {
    // 模块顶层 registerPlugin 在非原生环境返回 proxy；真正调用 method 时才需要原生实现，
    // 而本后端只在 isAndroid() 下创建。
    return {
        start: (options) => FoliaLan.startAdvertising({ name: options.name, role: options.role }),
        stop: () => FoliaLan.stop(),
        peers: async () => (await FoliaLan.peers()).peers,
        sendHandoff: (target, payload) => FoliaLan.sendHandoff({ host: target.host, port: target.port, payload }),
        onHandoff: (listener) => {
            let handle: { remove: () => void } | null = null;
            void FoliaLan.addListener('handoffReceived', (event) => {
                listener({
                    title: event.title ?? '',
                    artist: event.artist ?? '',
                    album: event.album ?? '',
                    position: typeof event.position === 'number' ? event.position : 0,
                    duration: typeof event.duration === 'number' ? event.duration : 0,
                    playing: event.playing === true,
                });
            }).then((h) => { handle = h; });
            return () => { try { handle?.remove(); } catch { /* 未就绪就解绑 */ } };
        },
    };
};

const createElectronBackend = (): LanSyncBackend | null => {
    const electron = (window as any).electron;
    if (!electron?.lan) return null;
    return {
        start: (options) => electron.lan.start(options.name, options.role),
        stop: () => electron.lan.stop(),
        peers: () => electron.lan.peers(),
        sendHandoff: (target, payload) => electron.lan.sendHandoff(target.host, target.port, payload),
        onHandoff: (listener) => electron.lan.onHandoff((payload: LanHandoffPayload) => listener(payload)),
    };
};

const resolveBackend = (): LanBackendKind => {
    if (isAndroid()) return 'android';
    if (isElectronRuntime()) return 'desktop';
    return 'none';
};

/** 原生 start/stop 的串行队列：shutdown 后立刻 init 时，保证 stop 先执行完再 start。 */
let lifecycleChain: Promise<void> = Promise.resolve();

/** App 启动时调一次；重复调用是空操作。 */
export function initLanSync(deps: LanSyncDeps): LanBackendKind {
    depsRef = deps;
    if (backend) return backendKind;
    backendKind = resolveBackend();
    if (backendKind === 'android') {
        backend = createAndroidBackend();
    } else if (backendKind === 'desktop') {
        backend = createElectronBackend();
    }
    if (!backend) {
        backendKind = 'none';
        return 'none';
    }

    const kind = backendKind as 'android' | 'desktop';
    const activeBackend = backend;
    lifecycleChain = lifecycleChain.then(() => activeBackend.start({ name: deps.deviceName(), role: kind })).catch(() => {
        // 信标端口被占等情况：发现不可用，但 TCP 推送路径仍可手动用
    });
    unsubscribeHandoff = activeBackend.onHandoff((payload) => depsRef?.onHandoff(payload));
    pollTimer = setInterval(() => {
        activeBackend.peers().then((peers) => {
            useLanSyncStore.setState({ peers, peersUpdatedAtMs: Date.now(), running: true });
        }).catch(() => { /* 轮询失败保持旧列表 */ });
    }, LAN_BEACON_INTERVAL_MS);
    return backendKind;
}

export function shutdownLanSync(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    unsubscribeHandoff?.();
    unsubscribeHandoff = null;
    const stoppedBackend = backend;
    backend = null;
    backendKind = 'none';
    if (stoppedBackend) {
        lifecycleChain = lifecycleChain.then(() => stoppedBackend.stop()).catch(() => {});
    }
    useLanSyncStore.setState({ running: false, peers: [] });
}

export const getLanBackendKind = (): LanBackendKind => backendKind;

/** 命令面板与 surface 共用：把当前曲目推给指定对端。失败抛错，由调用方 toast。 */
export async function sendHandoffToPeer(peer: LanPeer): Promise<LanHandoffPayload> {
    if (!backend) throw new Error('lan-not-started');
    const payload = depsRef?.buildHandoffPayload();
    if (!payload) throw new Error('lan-nothing-playing');
    await backend.sendHandoff({ host: peer.host, port: peer.port }, payload);
    return payload;
}
