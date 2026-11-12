import React, { useState } from 'react';
import { MonitorSmartphone, RefreshCw, Smartphone } from 'lucide-react';
import { useLanSyncStore, sendHandoffToPeer, getLanBackendKind } from '../../../services/lanSync/controller';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { useTranslation } from 'react-i18next';
import type { LanPeer } from '../../../services/lanSync/protocol';

// src/components/command-palette/surfaces/LanPushSurfaceView.tsx
// 「推送到局域网设备」surface：列出信标发现到的对端，点选即把当前曲目的接续数据推过去。

type LanPushSurfaceViewProps = {
    isDaylight: boolean;
    close: () => void;
};

const formatPosition = (seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const LanPushSurfaceView: React.FC<LanPushSurfaceViewProps> = ({ isDaylight, close }) => {
    const { t } = useTranslation();
    const peers = useLanSyncStore((state) => state.peers);
    const updatedAt = useLanSyncStore((state) => state.peersUpdatedAtMs);
    const [pushingTo, setPushingTo] = useState<string | null>(null);

    const idleBg = isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/5';
    const subText = isDaylight ? 'text-black/50' : 'text-white/50';

    if (getLanBackendKind() === 'none') {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center opacity-60 text-sm">
                {t('lanSync.unavailable', '局域网接续在此平台不可用')}
            </div>
        );
    }

    const push = async (peer: LanPeer) => {
        if (pushingTo) return;
        setPushingTo(peer.host);
        try {
            const payload = await sendHandoffToPeer(peer);
            setStatusMessage({
                type: 'success',
                text: t('lanSync.pushed', '已推送到 {{name}}（{{title}} · {{position}}）', {
                    name: peer.name,
                    title: payload.title,
                    position: formatPosition(payload.position),
                }),
            });
            close();
        } catch {
            setStatusMessage({
                type: 'error',
                text: t('lanSync.pushFailed', '推送到 {{name}} 失败', { name: peer.name }),
            });
        } finally {
            setPushingTo(null);
        }
    };

    return (
        <div className="flex h-full flex-col gap-1 overflow-y-auto p-2">
            {peers.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center opacity-60">
                    <RefreshCw size={22} className="animate-spin" style={{ animationDuration: '3s' }} />
                    <div className="text-sm">
                        {t('lanSync.searching', '正在搜索同一 WiFi 下的设备…')}
                    </div>
                    <div className={`text-xs ${subText}`}>
                        {t('lanSync.searchingHint', '电脑端也需要打开 Folia 才会被发现（约 2 秒刷新一次）')}
                        {updatedAt > 0 ? '' : ''}
                    </div>
                </div>
            ) : (
                peers.map((peer) => {
                    const Icon = peer.role === 'desktop' ? MonitorSmartphone : Smartphone;
                    const busy = pushingTo === peer.host;
                    return (
                        <button
                            key={`${peer.host}:${peer.port}`}
                            type="button"
                            disabled={Boolean(pushingTo)}
                            onClick={() => void push(peer)}
                            className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${idleBg} disabled:opacity-50`}
                        >
                            <Icon size={20} className="shrink-0 opacity-70" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{peer.name}</div>
                                <div className={`truncate text-xs ${subText}`}>
                                    {peer.role === 'desktop'
                                        ? t('lanSync.kindDesktop', '电脑')
                                        : t('lanSync.kindAndroid', '手机')}
                                    {' · '}{peer.host}
                                </div>
                            </div>
                            {busy && <RefreshCw size={16} className="animate-spin opacity-60" />}
                        </button>
                    );
                })
            )}
        </div>
    );
};

export default LanPushSurfaceView;
