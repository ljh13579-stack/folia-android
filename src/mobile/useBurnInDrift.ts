// src/mobile/useBurnInDrift.ts
// OLED 防烧屏：常驻按钮以很慢的节奏在小范围内随机漂移，避免同一批像素长期固定点亮。
// 只在 Android 启用（桌面显示器没有烧屏问题）。
//
// 用法：把返回的 style spread 到目标元素的「定位外层」上，而不是直接写到带
// transition/transform 类名的元素上 —— inline transition 会盖掉元素自身的
// transition 类（如 active:scale-95 的过渡），inline transform 会盖掉 Tailwind 的
// scale 变换。外层只管漂移，内层的交互样式互不干扰。
import { useEffect, useState } from 'react';
import type React from 'react';
import { isAndroid } from './platform';

/** 漂移一步的过渡时长：4 秒慢速滑动，肉眼几乎察觉不到在动。 */
const DRIFT_TRANSITION = 'transform 4000ms ease-in-out';

/**
 * @param rangePx 漂移半径（px），目标位置落在 ±rangePx 的方块内
 * @param enabled 外部开关（如按钮当前不可见时传 false，回到原点）
 */
export const useBurnInDrift = (rangePx = 6, enabled = true): React.CSSProperties => {
    const active = enabled && isAndroid();
    const [offset, setOffset] = useState({ x: 0, y: 0 });

    useEffect(() => {
        if (!active) {
            setOffset({ x: 0, y: 0 });
            return;
        }
        let timer = 0;
        const tick = () => {
            setOffset({
                x: Math.round((Math.random() * 2 - 1) * rangePx),
                y: Math.round((Math.random() * 2 - 1) * rangePx),
            });
            // 30~90s 随机间隔：节奏本身也不固定，避免可预测周期造成的二次均匀老化
            timer = window.setTimeout(tick, 30_000 + Math.random() * 60_000);
        };
        timer = window.setTimeout(tick, 30_000 + Math.random() * 60_000);
        return () => window.clearTimeout(timer);
    }, [active, rangePx]);

    if (!active) {
        return {};
    }
    return {
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        transition: DRIFT_TRANSITION,
    };
};

export default useBurnInDrift;
