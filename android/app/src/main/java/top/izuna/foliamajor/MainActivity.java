package top.izuna.foliamajor;

import android.Manifest;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 0x10A2;

    /**
     * 旋转后 WebView 视口/重绘滞留修复：
     * 部分 ROM（MIUI 等）在应用自行处理 configChanges 时，旋转后系统窗口尺寸已变，
     * 但 WebView 可能很久不产出新尺寸的画面（实测可卡 2 分钟以上），屏幕停在旧方向的几何。
     * 单次 requestLayout 时机太早（窗口 surface 尚未完成切换）会落空，
     * 所以在多个时间点重试；若 WebView 实测尺寸与目标尺寸仍不一致，
     * 直接 measure+layout 强制它按新尺寸立即重排，并补发 resize 让页面侧重量。
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        forceWebViewRelayout(0);
        forceWebViewRelayout(300);
        forceWebViewRelayout(1000);
        forceWebViewRelayout(3000);
        forceWebViewRelayout(6000);
    }

    private void forceWebViewRelayout(long delayMs) {
        final View decor = getWindow().getDecorView();
        decor.postDelayed(() -> {
            decor.requestLayout();
            decor.invalidate();
            WebView webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView == null) return;
            Configuration cfg = getResources().getConfiguration();
            float density = getResources().getDisplayMetrics().density;
            int targetW = (int) (cfg.screenWidthDp * density + 0.5f);
            int targetH = (int) (cfg.screenHeightDp * density + 0.5f);
            if (targetW > 0 && targetH > 0
                    && (webView.getWidth() != targetW || webView.getHeight() != targetH)) {
                webView.measure(
                        View.MeasureSpec.makeMeasureSpec(targetW, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(targetH, View.MeasureSpec.EXACTLY));
                webView.layout(0, 0, targetW, targetH);
            }
            webView.requestLayout();
            webView.invalidate();
            webView.post(() -> webView.loadUrl(
                    "javascript:window.dispatchEvent(new Event('resize'))"));
        }, delayMs);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // SAF 文件访问插件、后台播放插件都必须在 bridge 初始化前注册
        registerPlugin(FoliaFsPlugin.class);
        registerPlugin(FoliaPlaybackPlugin.class);
        registerPlugin(FoliaLanPlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermissionIfNeeded();
    }

    /** Android 13+ 需要运行时授权，前台服务通知才会出现在通知栏 */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(
            new String[]{Manifest.permission.POST_NOTIFICATIONS},
            NOTIFICATION_PERMISSION_REQUEST);
    }
}
