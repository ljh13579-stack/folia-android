// src/mobile/orientationRepaintKick.ts
// 旋转后重绘兜底（配合 MainActivity 的强制重排）：
// 部分 ROM 上旋转后系统会冻结应用 surface，等应用在新尺寸下产出新帧才解除；
// 页面几何虽然已正确，但若渲染器空闲不产帧，画面就会停留在旧方向。
// 这里的做法：每次 orientationchange / 宽度变化的 resize 后，用一枚 1px 覆盖层
// 周期性产生微小的绘制损伤，逼合成器持续出帧，直到冻结解除（最长 ~10 秒）。
// 覆盖层透明度变化肉眼不可见，不影响布局（position:fixed、pointer-events:none）。

const KICK_WINDOW_MS = 10_000;
const KICK_INTERVAL_MS = 250;

let overlay: HTMLDivElement | null = null;
let timer: number | null = null;
let kicked = false;

const ensureOverlay = (): HTMLDivElement => {
    if (overlay && document.documentElement.contains(overlay)) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText =
        'position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;'
        + 'z-index:2147483647;background:rgba(0,0,0,0.004);';
    document.documentElement.appendChild(overlay);
    return overlay;
};

const stop = () => {
    if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
    }
    if (overlay) overlay.style.background = 'rgba(0,0,0,0.004)';
};

const start = () => {
    if (timer !== null) window.clearInterval(timer);
    const el = ensureOverlay();
    let flip = false;
    const deadline = Date.now() + KICK_WINDOW_MS;
    timer = window.setInterval(() => {
        if (Date.now() > deadline) {
            stop();
            return;
        }
        flip = !flip;
        el.style.background = flip ? 'rgba(0,0,0,0.005)' : 'rgba(0,0,0,0.004)';
    }, KICK_INTERVAL_MS);
};

/** Android 上才有旋转滞留问题；其它平台此模块是空操作。 */
export const installOrientationRepaintKick = (): void => {
    if (kicked) return;
    kicked = true;
    if (typeof window === 'undefined') return;
    let lastWidth = window.innerWidth;
    window.addEventListener('orientationchange', start);
    window.addEventListener('resize', () => {
        if (window.innerWidth !== lastWidth) {
            lastWidth = window.innerWidth;
            start();
        }
    });
};
