import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { isNativeMobile } from './mobile/platform';
import { installMobileShims } from './mobile/neteaseShim';
import { syncBottomBarBaselineWithSafeArea } from './stores/motionSignals';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// Capacitor 原生容器中，本地 API shim（网易云内嵌后端 + 歌词代理直连）必须先于一切
// 网络请求安装；对 Electron/Web 是纯 no-op。
if (isNativeMobile()) {
  installMobileShims();
}
// DOM 就绪后同步底部基线的安全区偏移（Android 竖屏下避开手势导航条）。
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncBottomBarBaselineWithSafeArea, { once: true });
  } else {
    syncBottomBarBaselineWithSafeArea();
  }
}
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();

void import('./bootstrap');
