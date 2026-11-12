import type { CommandPaletteSurface } from './types';

// src/components/command-palette/surfaces/lanPushSurface.ts
// 「推送到局域网设备」命令的 surface：列出发现到的对端，点选即推送当前曲目接续。

export const lanPushSurface: CommandPaletteSurface = {
    load: () => import('./LanPushSurfaceView'),
    mapProps: ({ isDaylight, close }) => ({ isDaylight, close }),
};
