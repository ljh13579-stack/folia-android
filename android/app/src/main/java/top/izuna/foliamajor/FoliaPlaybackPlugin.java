package top.izuna.foliamajor;

// Folia Android 适配层：后台播放 Capacitor 插件（FoliaPlayback）
// JS 侧接口见 src/mobile/playback/playbackServicePlugin.ts。
//   start       —— 拉起前台服务并注册系统媒体按键监听
//   updateState —— 推送曲目元数据 / 播放状态 / 进度到前台服务
//   stop        —— 停止服务并撤下通知
// 事件 remoteAction：系统媒体控件或蓝牙按键触发的 play/pause/next/previous。

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FoliaPlayback")
public class FoliaPlaybackPlugin extends Plugin {

    @Override
    public void load() {
        FoliaPlaybackService.setListener(this::emitRemoteAction);
    }

    private void emitRemoteAction(String action) {
        JSObject payload = new JSObject();
        payload.put("action", action);
        notifyListeners("remoteAction", payload);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), FoliaPlaybackService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        FoliaPlaybackService.setListener(this::emitRemoteAction);
        call.resolve();
    }

    @PluginMethod
    public void updateState(PluginCall call) {
        FoliaPlaybackService service = FoliaPlaybackService.getInstance();
        if (service != null) {
            String title = call.getString("title");
            String artist = call.getString("artist");
            String album = call.getString("album");
            String artworkUrl = call.getString("artworkUrl");
            Boolean playing = call.getBoolean("playing");
            Long positionMs = call.getLong("positionMs");
            Long durationMs = call.getLong("durationMs");
            service.update(
                title,
                artist,
                album,
                artworkUrl,
                playing != null && playing,
                positionMs != null ? positionMs : 0L,
                durationMs != null ? durationMs : 0L
            );
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        FoliaPlaybackService service = FoliaPlaybackService.getInstance();
        if (service != null) {
            service.stopPlayback();
        }
        getContext().stopService(new Intent(getContext(), FoliaPlaybackService.class));
        call.resolve();
    }
}
