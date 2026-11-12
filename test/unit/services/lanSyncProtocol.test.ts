// test/unit/services/lanSyncProtocol.test.ts
import { describe, it, expect } from 'vitest';
import {
    LAN_PROTOCOL_VERSION,
    LanPeerTable,
    decodeLanBeacon,
    decodeLanLine,
    encodeLanBeacon,
    encodeLanMessage,
    normalizeTrackKey,
    type LanBeacon,
} from '../../../src/services/lanSync/protocol';

describe('lanSync 协议', () => {
    it('handoff 编解码往返', () => {
        const original = {
            v: LAN_PROTOCOL_VERSION,
            type: 'handoff' as const,
            payload: {
                title: '晴天',
                artist: '周杰伦',
                album: '叶惠美',
                position: 83.5,
                duration: 269,
                playing: true,
            },
        };
        expect(decodeLanLine(encodeLanMessage(original))).toEqual(original);
    });

    it('ack 编解码往返', () => {
        expect(decodeLanLine(encodeLanMessage({ v: LAN_PROTOCOL_VERSION, type: 'ack' }))).toEqual({
            v: LAN_PROTOCOL_VERSION,
            type: 'ack',
        });
    });

    it('版本不符 / 坏 JSON / 未知 type 全部丢弃', () => {
        expect(decodeLanLine('{"v":99,"type":"ack"}\n')).toBeNull();
        expect(decodeLanLine('not json\n')).toBeNull();
        expect(decodeLanLine('{"v":1,"type":"mystery"}\n')).toBeNull();
        expect(decodeLanLine('\n')).toBeNull();
    });

    it('handoff 缺字段时补默认值而不是丢包', () => {
        const msg = decodeLanLine(
            '{"v":1,"type":"handoff","payload":{"title":"A","artist":"B"}}\n',
        );
        expect(msg).toMatchObject({
            type: 'handoff',
            payload: { title: 'A', artist: 'B', album: '', position: 0, duration: 0, playing: false },
        });
    });

    it('信标解析 + 非法信标丢弃', () => {
        const beacon: LanBeacon = { v: 1, type: 'folia-lan', name: '书房PC', role: 'desktop', port: 45714 };
        expect(decodeLanBeacon(encodeLanBeacon(beacon))).toEqual(beacon);
        expect(decodeLanBeacon('{"v":1,"type":"folia-lan","name":"x","role":"toaster","port":1}')).toBeNull();
        expect(decodeLanBeacon('{"v":2,"type":"folia-lan"}')).toBeNull();
        expect(decodeLanBeacon('hello')).toBeNull();
    });

    it('PeerTable：upsert / 列表排序 / 换端口挤旧 / 过期清理', () => {
        const table = new LanPeerTable();
        const b1: LanBeacon = { v: 1, type: 'folia-lan', name: 'B机', role: 'android', port: 46000 };
        const b2: LanBeacon = { v: 1, type: 'folia-lan', name: 'A机', role: 'desktop', port: 46001 };
        table.upsert(b1, '192.168.1.10', 1000);
        table.upsert(b2, '192.168.1.11', 2000);
        expect(table.list().map((p) => p.name)).toEqual(['A机', 'B机']);

        // 同 host 换端口：旧端口条目被挤掉
        const b1New: LanBeacon = { ...b1, port: 46002 };
        table.upsert(b1New, '192.168.1.10', 3000);
        const list = table.list();
        expect(list).toHaveLength(2);
        expect(list.find((p) => p.host === '192.168.1.10')?.port).toBe(46002);

        // 6s 无信标过期
        table.expire(3000 + 6000 + 1);
        expect(table.list()).toHaveLength(0);

        table.upsert(b1, '192.168.1.10', 0);
        table.clear();
        expect(table.list()).toHaveLength(0);
    });

    it('normalizeTrackKey：大小写/空白/标点/Remaster 后缀', () => {
        expect(normalizeTrackKey('晴天')).toBe(normalizeTrackKey(' 晴天 '));
        expect(normalizeTrackKey('晴天')).toBe(normalizeTrackKey('晴天 (Live)'));
        expect(normalizeTrackKey('晴天')).toBe(normalizeTrackKey('晴天 - Remastered'));
        expect(normalizeTrackKey('晴天')).toBe(normalizeTrackKey('晴天·Remaster'));
        expect(normalizeTrackKey('晴天')).not.toBe(normalizeTrackKey('阴天'));
        // 空格分隔的英文版本后缀
        expect(normalizeTrackKey('Song Name')).toBe(normalizeTrackKey('song name - remaster'));
    });
});
