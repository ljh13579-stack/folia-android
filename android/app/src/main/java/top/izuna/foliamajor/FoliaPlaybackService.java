package top.izuna.foliamajor;

// Folia Android 适配层：后台播放前台服务
// JS 侧入口见 src/mobile/playback/playbackServicePlugin.ts，桥接逻辑见同目录 useAndroidPlaybackService.ts。
// 职责：
//   1. 以前台服务保活进程，使 WebView 内的 HTMLAudioElement 退到后台仍可继续播放；
//   2. 持有 MediaSessionCompat，向系统媒体控件 / 锁屏 / 蓝牙耳机暴露标题、封面与播放状态；
//   3. 把系统媒体按键（播放/暂停/上一首/下一首）通过 ActionListener 回传给 Capacitor 插件，
//      再由插件以事件形式转发给 Web 层（见 FoliaPlaybackPlugin）。

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class FoliaPlaybackService extends Service {

    /** 系统媒体按键回传到插件（进而到 Web 层）的回调。 */
    public interface ActionListener {
        void onRemoteAction(String action);
    }

    public static final String ACTION_PLAY = "top.izuna.foliamajor.playback.PLAY";
    public static final String ACTION_PAUSE = "top.izuna.foliamajor.playback.PAUSE";
    public static final String ACTION_NEXT = "top.izuna.foliamajor.playback.NEXT";
    public static final String ACTION_PREVIOUS = "top.izuna.foliamajor.playback.PREVIOUS";

    private static final String CHANNEL_ID = "folia_playback";
    private static final int NOTIFICATION_ID = 0x10A1;

    private static FoliaPlaybackService instance;
    private static ActionListener listener;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private MediaSessionCompat session;
    private String title = "Folia";
    private String artist = "";
    private String album = "";
    private String artworkUrl = "";
    private Bitmap artwork;
    private boolean playing = false;
    private long positionMs = 0;
    private long durationMs = 0;

    /** 插件在 load()/start() 时注册监听；服务持有静态引用以便动作直接回传。 */
    public static void setListener(ActionListener newListener) {
        listener = newListener;
        if (instance != null && instance.session != null) {
            instance.session.setActive(true);
        }
    }

    public static FoliaPlaybackService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        session = new MediaSessionCompat(this, "FoliaPlayback");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { dispatch("play"); }
            @Override public void onPause() { dispatch("pause"); }
            @Override public void onSkipToNext() { dispatch("next"); }
            @Override public void onSkipToPrevious() { dispatch("previous"); }
            @Override public void onStop() { stopPlayback(); }
        });
        session.setActive(true);
        startInForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 通知栏按钮以显式 action 拉起本服务，避免额外注册 BroadcastReceiver
        if (intent != null && intent.getAction() != null) {
            switch (intent.getAction()) {
                case ACTION_PLAY: dispatch("play"); break;
                case ACTION_PAUSE: dispatch("pause"); break;
                case ACTION_NEXT: dispatch("next"); break;
                case ACTION_PREVIOUS: dispatch("previous"); break;
                default: break;
            }
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        instance = null;
        super.onDestroy();
    }

    /** Web 层推送当前的曲目元数据与播放状态。 */
    public void update(String newTitle, String newArtist, String newAlbum, String newArtworkUrl,
                       boolean newPlaying, long newPositionMs, long newDurationMs) {
        this.title = newTitle != null && !newTitle.isEmpty() ? newTitle : "Folia";
        this.artist = newArtist != null ? newArtist : "";
        this.album = newAlbum != null ? newAlbum : "";
        this.playing = newPlaying;
        this.positionMs = Math.max(newPositionMs, 0);
        this.durationMs = Math.max(newDurationMs, 0);

        if (newArtworkUrl != null && !newArtworkUrl.equals(this.artworkUrl)) {
            this.artworkUrl = newArtworkUrl;
            this.artwork = null;
            loadArtworkAsync(newArtworkUrl);
        }
        applySessionState();
        refreshNotification();
    }

    /** 停止播放并撤下前台通知。 */
    public void stopPlayback() {
        if (session != null) {
            session.setActive(false);
        }
        stopForeground(true);
        stopSelf();
    }

    private void dispatch(String action) {
        ActionListener current = listener;
        if (current != null) {
            current.onRemoteAction(action);
        }
    }

    private void applySessionState() {
        if (session == null) return;

        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        }
        session.setMetadata(metadata.build());

        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_STOP;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                positionMs, playing ? 1f : 0f)
            .build());
    }

    private void refreshNotification() {
        mainHandler.post(() -> {
            NotificationManagerCompat manager = NotificationManagerCompat.from(this);
            manager.notify(NOTIFICATION_ID, buildNotification());
        });
    }

    private void startInForeground() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album.isEmpty() ? null : album)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setStyle(new MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        if (artwork != null) {
            builder.setLargeIcon(artwork);
        }

        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_previous, "Previous", actionPendingIntent(ACTION_PREVIOUS)));
        builder.addAction(playing
            ? new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause", actionPendingIntent(ACTION_PAUSE))
            : new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play", actionPendingIntent(ACTION_PLAY)));
        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_next, "Next", actionPendingIntent(ACTION_NEXT)));

        return builder.build();
    }

    private PendingIntent actionPendingIntent(String action) {
        Intent intent = new Intent(this, FoliaPlaybackService.class);
        intent.setAction(action);
        return PendingIntent.getService(this, action.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /**
     * 通知封面：Web 层传的是可直接访问的图片 URL（本地曲库的 blob URL 无法被原生读取，
     * 因此 JS 侧只会上报 http(s) 封面）。获取失败时静默降级为无封面。
     */
    private void loadArtworkAsync(final String url) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
        new Thread(() -> {
            Bitmap bitmap = null;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setInstanceFollowRedirects(true);
                try (InputStream stream = connection.getInputStream()) {
                    bitmap = BitmapFactory.decodeStream(stream);
                }
            } catch (Exception ignored) {
                // 无封面不阻塞播放
            } finally {
                if (connection != null) connection.disconnect();
            }
            final Bitmap result = bitmap;
            if (result != null) {
                mainHandler.post(() -> {
                    artwork = result;
                    applySessionState();
                    refreshNotification();
                });
            }
        }).start();
    }
}
