import { PlayerState, type PlaybackContext, type SongResult, type StagePlayerSnapshot } from '../types';
import type { VideoExportState } from '../types/videoExport';
import { getPlaybackSongKey } from './appPlaybackGuards';
import { buildStagePlayerSnapshot } from './stagePlayerSnapshot';
import { resolvePlaybackSongArtist, resolvePlaybackSongCoverUrl } from './playbackSongMeta';

// src/utils/playbackSyncBridge.ts
// Derives shared playback publisher models before adapting them to Electron-facing protocols.

export interface PlaybackSyncBridgeModel {
    activePlaybackContext: PlaybackContext;
    currentSong: SongResult | null;
    playQueue: SongResult[];
    hasTrack: boolean;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    currentIndex: number;
    currentTimeSec: number;
    stagePositionSec: number;
    durationSec: number;
    stageDurationSec: number;
    playerState: PlayerState;
    loopMode: 'off' | 'all' | 'one';
    isFmMode: boolean;
    canGoPrevious: boolean;
    canGoNext: boolean;
    controlsDisabled: boolean;
    isStageActive: boolean;
    transparentModeEnabled: boolean;
    mainWindowClickThroughEnabled: boolean;
    mainWindowAlwaysOnTop: boolean;
    mainWindowBorderVisible: boolean;
    playerChromeHidden: boolean;
    exportState: VideoExportState;
    isDaylight: boolean;
    mainWindowWidth: number;
    mainWindowHeight: number;
    lyricOffsetMs?: number;
    sampledAt: number;
}

export interface BuildPlaybackSyncBridgeModelArgs {
    activePlaybackContext: PlaybackContext;
    currentSong: SongResult | null;
    playQueue: SongResult[];
    currentTimeSec: number;
    stagePositionSec?: number;
    durationSec: number;
    stageDurationSec?: number;
    playerState: PlayerState;
    coverUrl: string | null;
    cachedCoverUrl?: string | null;
    effectiveLoopMode: 'off' | 'all' | 'one';
    isFmMode: boolean;
    isStageActive: boolean;
    controlsDisabled: boolean;
    transparentModeEnabled: boolean;
    mainWindowClickThroughEnabled: boolean;
    mainWindowAlwaysOnTop?: boolean;
    mainWindowBorderVisible: boolean;
    playerChromeHidden: boolean;
    exportState: VideoExportState;
    isDaylight: boolean;
    mainWindowWidth: number;
    mainWindowHeight: number;
    lyricOffsetMs?: number;
    sampledAt?: number;
}

export interface DiscordPresenceSnapshot {
    hasTrack: boolean;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    currentTime: number;
    duration: number;
    playerState: PlayerState;
    updatedAt: number;
}

const clampFiniteNumber = (value: number, fallback = 0): number => {
    return Number.isFinite(value) ? value : fallback;
};

const getPlaybackSyncBridgeCoverUrl = (
    song: SongResult | null,
    coverUrl: string | null,
    cachedCoverUrl: string | null | undefined,
): string | null => {
    return coverUrl || cachedCoverUrl || resolvePlaybackSongCoverUrl(song);
};

// Builds the single playback model used by Electron publishers with protocol-specific adapters.
export const buildPlaybackSyncBridgeModel = ({
    activePlaybackContext,
    currentSong,
    playQueue,
    currentTimeSec,
    stagePositionSec,
    durationSec,
    stageDurationSec,
    playerState,
    coverUrl,
    cachedCoverUrl,
    effectiveLoopMode,
    isFmMode,
    isStageActive,
    controlsDisabled,
    transparentModeEnabled,
    mainWindowClickThroughEnabled,
    mainWindowAlwaysOnTop = false,
    mainWindowBorderVisible,
    playerChromeHidden,
    exportState,
    isDaylight,
    mainWindowWidth,
    mainWindowHeight,
    lyricOffsetMs,
    sampledAt = Date.now(),
}: BuildPlaybackSyncBridgeModelArgs): PlaybackSyncBridgeModel => {
    const hasTrack = !isStageActive && Boolean(currentSong);
    const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    const currentIndex = currentSongKey
        ? playQueue.findIndex(song => getPlaybackSongKey(song) === currentSongKey)
        : -1;
    const hasQueueNeighbors = playQueue.length > 1;
    const canGoPrevious = hasTrack && (currentIndex > 0 || (effectiveLoopMode === 'all' && hasQueueNeighbors));
    const canGoNext = hasTrack && (
        isFmMode ||
        currentIndex >= 0 && currentIndex < playQueue.length - 1 ||
        (effectiveLoopMode === 'all' && hasQueueNeighbors)
    );
    const safeCurrentTimeSec = Math.max(0, clampFiniteNumber(currentTimeSec));
    const safeDurationSec = Math.max(0, clampFiniteNumber(durationSec));

    return {
        activePlaybackContext,
        currentSong,
        playQueue,
        hasTrack,
        title: currentSong?.name ?? null,
        artist: resolvePlaybackSongArtist(currentSong),
        coverUrl: getPlaybackSyncBridgeCoverUrl(currentSong, coverUrl, cachedCoverUrl),
        currentIndex,
        currentTimeSec: safeCurrentTimeSec,
        stagePositionSec: Math.max(0, clampFiniteNumber(stagePositionSec ?? safeCurrentTimeSec)),
        durationSec: safeDurationSec,
        stageDurationSec: Math.max(0, clampFiniteNumber(stageDurationSec ?? safeDurationSec)),
        playerState,
        loopMode: effectiveLoopMode,
        isFmMode,
        canGoPrevious,
        canGoNext,
        controlsDisabled: controlsDisabled || !hasTrack,
        isStageActive,
        transparentModeEnabled,
        mainWindowClickThroughEnabled,
        mainWindowAlwaysOnTop,
        mainWindowBorderVisible,
        playerChromeHidden,
        exportState,
        isDaylight,
        mainWindowWidth,
        mainWindowHeight,
        lyricOffsetMs,
        sampledAt,
    };
};

export const buildStagePlayerSnapshotFromPlaybackSyncBridge = (
    model: PlaybackSyncBridgeModel,
): StagePlayerSnapshot => buildStagePlayerSnapshot({
    activePlaybackContext: model.activePlaybackContext,
    isExternalPlaybackSourceActive: model.isStageActive,
    currentSong: model.currentSong,
    playQueue: model.playQueue,
    playerState: model.playerState,
    positionMs: model.stagePositionSec * 1000,
    durationMs: model.stageDurationSec * 1000,
    canGoPrevious: model.canGoPrevious,
    canGoNext: model.canGoNext,
    coverUrl: model.coverUrl,
});

export const buildDiscordPresenceSnapshotFromPlaybackSyncBridge = (
    model: PlaybackSyncBridgeModel,
): DiscordPresenceSnapshot => ({
    hasTrack: model.hasTrack,
    title: model.title,
    artist: model.artist,
    coverUrl: model.coverUrl,
    currentTime: model.currentTimeSec,
    duration: model.durationSec,
    playerState: model.playerState,
    updatedAt: model.sampledAt,
});

export const buildTaskbarControlsFromPlaybackSyncBridge = (model: PlaybackSyncBridgeModel) => ({
    hasActiveTrack: model.hasTrack,
    canGoPrevious: model.canGoPrevious,
    canGoNext: model.canGoNext,
    isPlaying: model.hasTrack && model.playerState === PlayerState.PLAYING,
});
