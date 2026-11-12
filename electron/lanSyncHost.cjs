// electron/lanSyncHost.cjs
// 桌面端局域网播放接续宿主：UDP 广播信标做设备发现，TCP 单行 JSON 推接续数据。
// 协议与 android/app/src/main/java/top/izuna/foliamajor/FoliaLanPlugin.java 保持一致
// （字段名/常量一一对应，改一边必须同步另一边）。

const dgram = require('dgram');
const net = require('net');
const os = require('os');

const BEACON_PORT = 45713;
const PROTOCOL_VERSION = 1;
const BEACON_INTERVAL_MS = 2000;
const PEER_TIMEOUT_MS = 6000;
const HANDOFF_TIMEOUT_MS = 3000;

const createLanSyncHost = ({ onHandoff }) => {
    const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let running = false;
    let beaconTxSocket = null;
    let beaconRxSocket = null;
    let server = null;
    let beaconTxTimer = null;
    let deviceName = 'Folia Desktop';
    let role = 'desktop';
    let tcpPort = 0;
    let expireTimer = null;
    /** host -> { name, role, port, lastSeenMs } */
    const peersByHost = new Map();

    /** 每个 IPv4 网卡的广播地址 + 全局广播：多网卡/虚拟网卡环境下 255.255.255.255 会走错接口。 */
    const broadcastTargets = (() => {
        const targets = new Set(['255.255.255.255']);
        for (const infos of Object.values(os.networkInterfaces())) {
            for (const info of infos ?? []) {
                if (info.family !== 'IPv4' || info.internal) continue;
                const address = info.address.split('.').map(Number);
                const mask = info.netmask.split('.').map(Number);
                if (address.length !== 4 || mask.length !== 4 || mask[0] === 0) continue;
                targets.add(address.map((octet, i) => (octet | (~mask[i] & 255))).join('.'));
            }
        }
        return [...targets];
    })();

    const beaconJson = () => JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'folia-lan',
        name: deviceName,
        role,
        port: tcpPort,
        iid: instanceId,
    });

    const listPeers = () => {
        const now = Date.now();
        const out = [];
        for (const [host, peer] of peersByHost) {
            if (now - peer.lastSeenMs > PEER_TIMEOUT_MS) {
                peersByHost.delete(host);
                continue;
            }
            out.push({ name: peer.name, role: peer.role, host, port: peer.port, lastSeenMs: peer.lastSeenMs });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    };

    const start = (name, nextRole) => {
        if (running) return;
        if (typeof name === 'string' && name) deviceName = name;
        if (nextRole === 'android' || nextRole === 'desktop') role = nextRole;
        running = true;

        server = net.createServer((socket) => {
            let buffer = '';
            socket.setTimeout(HANDOFF_TIMEOUT_MS);
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex < 0) return;
                const line = buffer.slice(0, newlineIndex);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    socket.end();
                    return;
                }
                if (msg?.v !== PROTOCOL_VERSION || msg?.type !== 'handoff' || !msg.payload) {
                    socket.end();
                    return;
                }
                socket.write(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack' }) + '\n');
                socket.end();
                onHandoff?.({
                    title: String(msg.payload.title ?? ''),
                    artist: String(msg.payload.artist ?? ''),
                    album: String(msg.payload.album ?? ''),
                    position: Number.isFinite(msg.payload.position) ? msg.payload.position : 0,
                    duration: Number.isFinite(msg.payload.duration) ? msg.payload.duration : 0,
                    playing: msg.payload.playing === true,
                });
            });
            socket.on('error', () => {});
        });
        server.on('error', () => {});
        server.listen(0, () => {
            tcpPort = server.address().port;
        });

        // 发送：广播信标
        try {
            beaconTxSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            beaconTxSocket.bind(() => {
                try { beaconTxSocket.setBroadcast(true); } catch { /* 部分网卡不允许广播 */ }
            });
            beaconTxSocket.on('error', () => {});
            beaconTxTimer = setInterval(() => {
                if (!running || !tcpPort) return;
                const packet = Buffer.from(beaconJson(), 'utf8');
                for (const target of broadcastTargets) {
                    beaconTxSocket.send(packet, BEACON_PORT, target, () => {});
                }
            }, BEACON_INTERVAL_MS);
        } catch {
            beaconTxSocket = null;
        }

        // 接收：维护对端表
        try {
            beaconRxSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            beaconRxSocket.on('error', () => {});
            beaconRxSocket.on('message', (data, rinfo) => {
                if (rinfo.address === '127.0.0.1') {
                    // 本机回环：桌面自己也会收到自己的信标，忽略
                    return;
                }
                let beacon;
                try {
                    beacon = JSON.parse(data.toString('utf8'));
                } catch {
                    return;
                }
                if (beacon?.v !== PROTOCOL_VERSION || beacon?.type !== 'folia-lan') return;
                if (typeof beacon.name !== 'string' || !Number.isFinite(beacon.port)) return;
                if (beacon.role !== 'android' && beacon.role !== 'desktop') return;
                if (beacon.iid === instanceId) return; // 自己的信标
                peersByHost.set(rinfo.address, {
                    name: beacon.name,
                    role: beacon.role,
                    port: beacon.port,
                    lastSeenMs: Date.now(),
                });
            });
            beaconRxSocket.bind(BEACON_PORT, () => {});
        } catch {
            beaconRxSocket = null;
        }

        expireTimer = setInterval(() => listPeers(), PEER_TIMEOUT_MS);
    };

    const stop = () => {
        running = false;
        if (beaconTxTimer) { clearInterval(beaconTxTimer); beaconTxTimer = null; }
        if (expireTimer) { clearInterval(expireTimer); expireTimer = null; }
        for (const socket of [beaconTxSocket, beaconRxSocket]) {
            if (socket) {
                try { socket.close(); } catch { /* already closed */ }
            }
        }
        beaconTxSocket = null;
        beaconRxSocket = null;
        if (server) {
            try { server.close(); } catch { /* already closed */ }
            server = null;
        }
        peersByHost.clear();
        tcpPort = 0;
    };

    const sendHandoff = (host, port, payload) => new Promise((resolve, reject) => {
        if (!host || !Number.isFinite(port) || !payload) {
            reject(new Error('lan-bad-args'));
            return;
        }
        const socket = new net.Socket();
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };
        socket.setTimeout(HANDOFF_TIMEOUT_MS);
        socket.on('timeout', () => fail(new Error('lan-timeout')));
        socket.on('error', fail);
        socket.connect(port, host, () => {
            socket.write(JSON.stringify({ v: PROTOCOL_VERSION, type: 'handoff', payload }) + '\n');
        });
        let received = '';
        socket.on('data', (chunk) => {
            received += chunk.toString('utf8');
            if (received.includes('"type":"ack"') && !settled) {
                settled = true;
                socket.end();
                resolve();
            }
        });
        socket.on('close', () => {
            if (!settled) fail(new Error('lan-no-ack'));
        });
    });

    return { start, stop, listPeers, sendHandoff, isRunning: () => running };
};

module.exports = { createLanSyncHost };
