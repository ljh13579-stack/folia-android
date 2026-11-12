package top.izuna.foliamajor;

// Folia Android 局域网播放接续插件（FoliaLan）
// JS 侧接口见 src/mobile/lanSync/lanPlugin.ts。
//   startAdvertising(name) —— 开启 UDP 广播信标（发现用）+ TCP 服务（接收接续）
//   stop()                 —— 全部停止
//   peers()                —— 当前局域网内发现到的对端列表
//   sendHandoff(host, port, payload) —— 把当前曲目接续推给指定对端
// 事件 handoffReceived：收到对端推来的接续数据（payload 同发送侧）。

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "FoliaLan")
public class FoliaLanPlugin extends Plugin {

    private static final int BEACON_PORT = 45713;
    private static final int PROTOCOL_VERSION = 1;
    private static final long BEACON_INTERVAL_MS = 2000;
    private static final long PEER_TIMEOUT_MS = 6000;
    private static final long HANDOFF_TIMEOUT_MS = 3000;

    private volatile boolean running = false;
    private final String instanceId = java.util.UUID.randomUUID().toString();
    private Thread beaconTxThread;
    private Thread beaconRxThread;
    private Thread serverThread;
    private ServerSocket serverSocket;
    private DatagramSocket beaconSocket;
    private String deviceName = "Folia 设备";
    private int tcpPort = 0;

    /** host -> 对端条目；同 host 新端口覆盖旧条目。 */
    private static class PeerEntry {
        String name;
        String role;
        int port;
        long lastSeenMs;
    }
    private final Map<String, PeerEntry> peersByHost = new ConcurrentHashMap<>();

    @PluginMethod
    public synchronized void startAdvertising(PluginCall call) {
        String name = call.getString("name");
        if (name != null && !name.isEmpty()) deviceName = name;
        // synchronized：Capacitor 插件方法跑在线程池上，两个 start 并发会双双通过 running 检查，
        // 产生两个广播线程+一个被 GC 的失联 ServerSocket（幽灵端口）。
        if (running) { call.resolve(); return; }
        try {
            serverSocket = new ServerSocket(0);
            tcpPort = serverSocket.getLocalPort();
        } catch (Exception e) {
            call.reject("lan-server-failed", e);
            return;
        }
        running = true;
        final int myPort = tcpPort;
        beaconTxThread = new Thread(() -> beaconTxLoop(myPort), "folia-lan-beacon-tx");
        beaconRxThread = new Thread(() -> beaconRxLoop(myPort), "folia-lan-beacon-rx");
        serverThread = new Thread(() -> serverLoop(myPort), "folia-lan-server");
        beaconTxThread.setDaemon(true);
        beaconRxThread.setDaemon(true);
        serverThread.setDaemon(true);
        beaconTxThread.start();
        beaconRxThread.start();
        serverThread.start();
        call.resolve();
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        stopAll();
        call.resolve();
    }

    /** 调试/诊断：本机接续服务状态（TCP 端口给 adb forward 穿透测试用）。 */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", running);
        ret.put("port", tcpPort);
        ret.put("name", deviceName);
        call.resolve(ret);
    }

    @PluginMethod
    public void peers(PluginCall call) {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, PeerEntry>> it = peersByHost.entrySet().iterator();
        JSArray arr = new JSArray();
        List<JSObject> out = new ArrayList<>();
        while (it.hasNext()) {
            Map.Entry<String, PeerEntry> e = it.next();
            PeerEntry p = e.getValue();
            if (now - p.lastSeenMs > PEER_TIMEOUT_MS) { it.remove(); continue; }
            JSObject o = new JSObject();
            o.put("name", p.name);
            o.put("role", p.role);
            o.put("host", e.getKey());
            o.put("port", p.port);
            o.put("lastSeenMs", p.lastSeenMs);
            out.add(o);
        }
        out.sort((a, b) -> a.getString("name", "").compareTo(b.getString("name", "")));
        for (JSObject o : out) arr.put(o);
        JSObject ret = new JSObject();
        ret.put("peers", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void sendHandoff(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port");
        JSObject payload = call.getObject("payload");
        if (host == null || port == null || payload == null) {
            call.reject("lan-bad-args");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject msg = new JSONObject();
                msg.put("v", PROTOCOL_VERSION);
                msg.put("type", "handoff");
                msg.put("payload", payload);
                Socket socket = new Socket();
                socket.connect(new java.net.InetSocketAddress(host, port), (int) HANDOFF_TIMEOUT_MS);
                socket.setSoTimeout((int) HANDOFF_TIMEOUT_MS);
                BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), "UTF-8"));
                writer.write(msg.toString());
                writer.write("\n");
                writer.flush();
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), "UTF-8"));
                String line = reader.readLine();
                socket.close();
                if (line != null && line.contains("\"type\":\"ack\"")) {
                    call.resolve();
                } else {
                    call.reject("lan-no-ack");
                }
            } catch (Exception e) {
                call.reject("lan-send-failed", e);
            }
        }, "folia-lan-handoff").start();
    }

    @Override
    protected void handleOnDestroy() {
        stopAll();
        super.handleOnDestroy();
    }

    private void stopAll() {
        running = false;
        if (beaconSocket != null) beaconSocket.close();
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (Exception ignored) {}
        }
        peersByHost.clear();
    }

    private String beaconJson(int port) {
        return "{\"v\":" + PROTOCOL_VERSION
            + ",\"type\":\"folia-lan\""
            + ",\"name\":" + JSONObject.quote(deviceName)
            + ",\"role\":\"android\""
            + ",\"port\":" + port
            + ",\"iid\":" + JSONObject.quote(instanceId) + "}";
    }

    private void beaconTxLoop(int myPort) {
        while (running && tcpPort == myPort) {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                byte[] data = beaconJson(myPort).getBytes("UTF-8");
                while (running && tcpPort == myPort) {
                    // 每个 IPv4 网卡的广播地址各发一份 + 全局广播；手机热点/多网卡下
                    // 255.255.255.255 只走默认路由，对端可能收不到。
                    for (InetAddress target : collectBroadcastTargets()) {
                        try {
                            socket.send(new DatagramPacket(data, data.length, target, BEACON_PORT));
                        } catch (Exception ignored) {}
                    }
                    Thread.sleep(BEACON_INTERVAL_MS);
                }
            } catch (Exception ignored) {
                if (running && tcpPort == myPort) {
                    try { Thread.sleep(BEACON_INTERVAL_MS); } catch (InterruptedException ie) { return; }
                }
            } finally {
                if (socket != null) socket.close();
            }
        }
    }

    /** 收集本网卡集合的广播地址（含全局广播）；失败时退化为只发 255.255.255.255。 */
    private java.util.List<InetAddress> collectBroadcastTargets() {
        java.util.List<InetAddress> targets = new java.util.ArrayList<>();
        try {
            targets.add(InetAddress.getByName("255.255.255.255"));
            for (java.net.NetworkInterface ni : java.util.Collections.list(
                    java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isPointToPoint()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress broadcast = ia.getBroadcast();
                    if (broadcast != null && !targets.contains(broadcast)) targets.add(broadcast);
                }
            }
        } catch (Exception ignored) {}
        return targets;
    }

    private void beaconRxLoop(int myPort) {
        DatagramSocket socket;
        try {
            socket = new DatagramSocket(BEACON_PORT);
            socket.setBroadcast(true);
        } catch (Exception e) {
            return; // 端口被占（另一台设备同开/多开）——发现不了别人，但推送仍可手动
        }
        beaconSocket = socket;
        byte[] buffer = new byte[2048];
        while (running && tcpPort == myPort) {
            try {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), "UTF-8");
                JSONObject b = new JSONObject(text);
                if (b.optInt("v") != PROTOCOL_VERSION) continue;
                if (!"folia-lan".equals(b.optString("type"))) continue;
                String name = b.optString("name");
                String role = b.optString("role");
                int port = b.optInt("port");
                if (name.isEmpty() || port <= 0) continue;
                if (!"android".equals(role) && !"desktop".equals(role)) continue;
                // 忽略自己的信标（按实例 ID，回环广播在某些机型上会收到自己那份）
                if (instanceId.equals(b.optString("iid"))) continue;
                PeerEntry entry = new PeerEntry();
                entry.name = name;
                entry.role = role;
                entry.port = port;
                entry.lastSeenMs = System.currentTimeMillis();
                peersByHost.put(packet.getAddress().getHostAddress(), entry);
            } catch (Exception e) {
                if (!running || tcpPort != myPort) return;
            }
        }
    }

    private void serverLoop(int myPort) {
        while (running && tcpPort == myPort) {
            try {
                Socket client = serverSocket.accept();
                new Thread(() -> handleClient(client), "folia-lan-client").start();
            } catch (Exception e) {
                if (!running || tcpPort != myPort) return;
            }
        }
    }

    private void handleClient(Socket client) {
        try {
            client.setSoTimeout((int) HANDOFF_TIMEOUT_MS);
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), "UTF-8"));
            String line = reader.readLine();
            if (line == null) return;
            JSONObject msg = new JSONObject(line);
            if (msg.optInt("v") != PROTOCOL_VERSION) return;
            if (!"handoff".equals(msg.optString("type"))) return;
            JSONObject payload = msg.optJSONObject("payload");
            if (payload == null) return;
            BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(client.getOutputStream(), "UTF-8"));
            writer.write("{\"v\":" + PROTOCOL_VERSION + ",\"type\":\"ack\"}\n");
            writer.flush();
            JSObject eventPayload = new JSObject();
            eventPayload.put("title", payload.optString("title"));
            eventPayload.put("artist", payload.optString("artist"));
            eventPayload.put("album", payload.optString("album"));
            eventPayload.put("position", payload.optDouble("position", 0));
            eventPayload.put("duration", payload.optDouble("duration", 0));
            eventPayload.put("playing", payload.optBoolean("playing", false));
            notifyListeners("handoffReceived", eventPayload);
        } catch (Exception ignored) {
        } finally {
            try { client.close(); } catch (Exception ignored) {}
        }
    }
}
