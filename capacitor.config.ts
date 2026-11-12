// Folia Android 适配层：Capacitor 配置
// appId 沿用桌面端 electron-builder 的 appId（package.json -> build.appId）
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.izuna.foliamajor',
  appName: 'Folia',
  // Vite 构建输出目录
  webDir: 'dist',
  android: {
    // 允许 https 页面加载 http 资源（自建的网易云/酷狗 API 常是裸 http）
    allowMixedContent: true,
  },
  server: {
    // 使用 https scheme，保证 OPFS / IndexedDB / Service Worker 处于安全上下文
    androidScheme: 'https',
    // 允许明文 http 流量（自建 API 服务无证书的场景）
    cleartext: true,
  },
  plugins: {
    CapacitorHttp: {
      // 用原生 HTTP 替换 window.fetch / XHR，绕过 WebView 的 CORS 限制，
      // 使前端直连网易云/酷狗 API 实例成为可能
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#0b0b10',
      showSpinner: false,
    },
    StatusBar: {
      // 不叠加在 WebView 上：应用布局从状态栏下方开始，避免歌词/封面顶到系统栏
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#0b0b10',
    },
    // 注入 --safe-area-inset-* CSS 变量，用于竖屏下避开底部手势导航条
    SystemBars: {
      insetsHandling: 'css',
    },
  },
};

export default config;
