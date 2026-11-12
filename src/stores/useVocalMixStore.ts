import { create } from 'zustand';
import { applyVocalMixPosition } from '../services/vocalMixGraph';

// src/stores/useVocalMixStore.ts
// 播放页「人声 / 伴奏」滑块的会话级状态。不持久化：切歌、重开应用都回到原声，
// 用户没要求记住位置。position 为 null 表示收起（按钮态），非 null 是展开中的滑块值。
//
// store 是唯一写入口：组件拖滑块 -> setPosition -> 这里同步调 applyVocalMixPosition，
// 音频侧通过模块级注册表拿到值，两边不互相 import UI。

type VocalMixState = {
    /** null = 收起；0 底端（伴奏）.. 1 顶端（人声）。 */
    position: number | null;
    setPosition: (position: number | null) => void;
};

export const useVocalMixStore = create<VocalMixState>((set) => ({
    position: null,
    setPosition: (position) => {
        applyVocalMixPosition(position);
        set({ position });
    },
}));
