// src/services/lanSync/protocol.ts
// 局域网播放接续的线协议：UDP 广播信标做设备发现，TCP 单行 JSON 推接续数据。
// 纯模块、零依赖，安卓插件与桌面 main.cjs 共用同一套消息形状（桌面侧用 cjs 复写一遍，
// 字段名保持一致）。不在这里 import 任何运行时，方便单测。
//
// 设计取舍：
// - 发现用 255.255.255.255 广播而不是 mDNS：零依赖、两边实现都小；家庭/宿舍单网段够用。
// - 信标只含设备名/角色/TCP 端口，不含曲目——曲目只在用户点「推送」那一刻走 TCP，
//   不会在局域网里持续广播自己在听什么。
// - 全部消息单行 JSON、\n 结尾；版本字段 v 不匹配的包直接丢。

export const LAN_BEACON_PORT = 45713;
export const LAN_PROTOCOL_VERSION = 1;
/** 信标间隔：2s 广播一次，对端 6s 没收到就视作离线。 */
export const LAN_BEACON_INTERVAL_MS = 2000;
export const LAN_PEER_TIMEOUT_MS = 6000;
/** 推送超时：局域网内 3s 足够，超时按失败 toast。 */
export const LAN_HANDOFF_TIMEOUT_MS = 3000;

export type LanRole = 'android' | 'desktop';

export interface LanBeacon {
    v: number;
    type: 'folia-lan';
    name: string;
    role: LanRole;
    /** 接续数据要连的 TCP 端口。 */
    port: number;
}

export interface LanHandoffPayload {
    title: string;
    artist: string;
    album: string;
    /** 秒。 */
    position: number;
    /** 秒。 */
    duration: number;
    playing: boolean;
}

export interface LanHandoffMessage {
    v: number;
    type: 'handoff';
    payload: LanHandoffPayload;
}

export interface LanAckMessage {
    v: number;
    type: 'ack';
}

export type LanMessage = LanHandoffMessage | LanAckMessage;

/** 序列化为单行（换行符结尾）。 */
export const encodeLanMessage = (message: LanMessage): string => `${JSON.stringify(message)}\n`;

/** 解析一行；版本不符/形状不对返回 null，调用方丢弃。 */
export const decodeLanLine = (line: string): LanMessage | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const msg = parsed as Record<string, unknown>;
    if (msg.v !== LAN_PROTOCOL_VERSION) return null;
    if (msg.type === 'ack') return { v: LAN_PROTOCOL_VERSION, type: 'ack' };
    if (msg.type === 'handoff') {
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p || typeof p.title !== 'string' || typeof p.artist !== 'string') return null;
        return {
            v: LAN_PROTOCOL_VERSION,
            type: 'handoff',
            payload: {
                title: p.title,
                artist: p.artist,
                album: typeof p.album === 'string' ? p.album : '',
                position: typeof p.position === 'number' && Number.isFinite(p.position) ? p.position : 0,
                duration: typeof p.duration === 'number' && Number.isFinite(p.duration) ? p.duration : 0,
                playing: p.playing === true,
            },
        };
    }
    return null;
};

/** 解析信标；不符返回 null。 */
export const decodeLanBeacon = (datagram: string): LanBeacon | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(datagram);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const b = parsed as Record<string, unknown>;
    if (b.v !== LAN_PROTOCOL_VERSION || b.type !== 'folia-lan') return null;
    if (typeof b.name !== 'string' || typeof b.port !== 'number') return null;
    if (b.role !== 'android' && b.role !== 'desktop') return null;
    return { v: LAN_PROTOCOL_VERSION, type: 'folia-lan', name: b.name, role: b.role, port: b.port };
};

export const encodeLanBeacon = (beacon: LanBeacon): string => JSON.stringify(beacon);

/** 对端条目：controller 与原生插件都用这个形状。 */
export interface LanPeer {
    name: string;
    role: LanRole;
    host: string;
    port: number;
    /** 最后一次收到信标的时间戳（ms）。 */
    lastSeenMs: number;
}

/**
 * 信标驱动的对端表：upsert 收包、expire 定时清。纯逻辑抽出来给原生/JS 两侧单测。
 * 同一 host:port 视为同一台设备（改名就更新名）；同 host 新端口会先挤掉旧端口条目
 * （DHCP 重绑后端口变了的情况）。
 */
export class LanPeerTable {
    private peers = new Map<string, LanPeer>();

    upsert(beacon: LanBeacon, host: string, nowMs: number): void {
        // 同 host 不同端口：旧条目失效。
        for (const [key, peer] of this.peers) {
            if (peer.host === host && peer.port !== beacon.port) this.peers.delete(key);
        }
        this.peers.set(`${host}:${beacon.port}`, {
            name: beacon.name,
            role: beacon.role,
            host,
            port: beacon.port,
            lastSeenMs: nowMs,
        });
    }

    expire(nowMs: number): void {
        for (const [key, peer] of this.peers) {
            if (nowMs - peer.lastSeenMs > LAN_PEER_TIMEOUT_MS) this.peers.delete(key);
        }
    }

    list(): LanPeer[] {
        return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    clear(): void {
        this.peers.clear();
    }
}

/** 曲目匹配用的归一化：小写、去空白和常见标点，「晴天」≈「 晴天 」≈「晴天 - Remaster」。 */
export const normalizeTrackKey = (value: string): string =>
    value
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[\s\-–—_·.・'"''""()（）\[\]【】]+/g, '')
        .replace(/(remaster(ed)?|live|acoustic|instrumental|vip|edit|version|版)$/i, '');
