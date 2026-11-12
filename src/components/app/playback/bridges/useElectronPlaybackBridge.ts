import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../../../../types';
import type { SongResult } from '../../../../types';
import type { VideoExportState } from '../../../../types/videoExport';
import {
    buildDiscordPresenceSnapshotFromPlaybackSyncBridge,
    buildPlaybackSyncBridgeModel,
    buildStagePlayerSnapshotFromPlaybackSyncBridge,
    buildTaskbarControlsFromPlaybackSyncBridge,
} from '../../../../utils/playbackSyncBridge';
import { resolveStagePlayerPositionSec } from '../../../../utils/stagePlayerSnapshot';
import { useStableActionSurface } from '../../../../hooks/useStableCallbacks';
import { selectDisplayCoverUrl, selectDisplayDuration, selectDisplayPlayerState, selectDisplaySong, usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { useAppChromeStore } from '../../../../stores/useAppChromeStore';
import { useThemeSettingsStore } from '../../../../stores/useThemeSettingsStore';
import { usePlayerChromeSettingsStore } from '../../../../stores/usePlayerChromeSettingsStore';
import { currentTime } from '../../../../stores/motionSignals';

// Bridges Electron-specific shell features without coupling to UI components.
const DISCORD_PRESENCE_SNAPSHOT_INTERVAL_MS = 1000;

type UseElectronPlaybackBridgeOptions = {

    isElectronWindow: boolean;
    isStagePlayerSnapshotEnabled: boolean;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
    audioRef: RefObject<HTMLAudioElement | null>;
    /**
     * The deck whose clock the now-playing picture belongs to, or null when the picture is live.
     *
     * During an automix blend `audioRef` already names the INCOMING deck - the track arriving,
     * seconds before the listener hears it - while everything the panels should show still belongs
     * to the outgoing track. `currentSong`/`duration`/`coverUrl` are passed as the held picture by
     * the caller; this is the matching clock, so the panels read the outgoing deck rather than
     * snapping to zero the moment a blend arms.
     */
    getDisplayAudioElement?: () => HTMLAudioElement | null;
    effectiveLoopMode: 'off' | 'all' | 'one';
    isNowPlayingStageActive: boolean;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    getSyntheticStageLyricsTime?: () => number;
    syncStageLyricsClock?: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    taskbarHasTrackRef: RefObject<boolean>;
    taskbarPlayerStateRef: RefObject<PlayerState>;
    exportState: VideoExportState;
    lyricTimelineOffsetMs?: number;
    onExternalPlayRequest?: (request: any) => Promise<void>;
    /**
     * Handles a seek that lands during an automix blend, returning true when it did.
     *
     * Mid-blend `audioRef` names the incoming deck, silent and holding a different track, so a
     * plain `currentTime =` would move a track nobody can see. This routes such a seek through
     * the same cancel-and-resume the window's bar uses. Returns false (and the ordinary seek
     * runs) when no blend is in flight.
     */
    onTransitionSeek?: (time: number) => boolean;
};

const emptyPlaybackSyncBridgeStatus = (): ElectronPlaybackSyncBridgeStatus => ({
    discordPresenceEnabled: false,
});

export const useElectronPlaybackBridge = ({
    isElectronWindow,
    isStagePlayerSnapshotEnabled,
    isNowPlayingControlDisabledRef,
    audioRef,
    getDisplayAudioElement,
    effectiveLoopMode,
    isNowPlayingStageActive,
    mediaSessionPlayRef,
    mediaSessionPauseRef,
    mediaSessionPrevRef,
    mediaSessionNextRef,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    taskbarHasTrackRef,
    taskbarPlayerStateRef,
    exportState,
    lyricTimelineOffsetMs,
    onExternalPlayRequest,
    onTransitionSeek,
}: UseElectronPlaybackBridgeOptions) => {
    // Read here rather than passed in: all store fields or a module-level motion signal.
    const setIsTitlebarRevealed = useAppChromeStore(state => state.setIsTitlebarRevealed);
    const isPlayerChromeHidden = useAppChromeStore(state => state.isPlayerChromeHidden);
    const setIsPlayerChromeHidden = useAppChromeStore(state => state.setIsPlayerChromeHidden);
    const showTransparentWindowBorder = useAppChromeStore(state => state.showTransparentWindowBorder);
    const mainWindowClickThroughEnabled = useAppChromeStore(state => state.isMainWindowClickThroughEnabled);
    const transparentPlayerBackground = usePlayerChromeSettingsStore(state => state.transparentPlayerBackground);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const cachedCoverUrl = usePlaybackStore(state => state.cachedCoverUrl);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    // The HELD picture and its clock, so Discord and the taskbar switch song when a
    // blend settles rather than when it arms - the same thing useMediaSessionBridge publishes.
    const currentSong = usePlaybackStore(selectDisplaySong);
    const coverUrl = usePlaybackStore(selectDisplayCoverUrl);
    const duration = usePlaybackStore(selectDisplayDuration);
    const playerState = usePlaybackStore(selectDisplayPlayerState);

    const [playbackSyncBridgeStatus, setPlaybackSyncBridgeStatus] = useState<ElectronPlaybackSyncBridgeStatus>(() => emptyPlaybackSyncBridgeStatus());
    const pausedByVoiceInputRef = useRef(false);
    const stageSnapshotCacheRef = useRef<{
        playQueue: SongResult[];
        currentSong: SongResult | null;
        activePlaybackContext: 'main' | 'stage';
        isStageActive: boolean;
        canGoPrevious: boolean;
        canGoNext: boolean;
        coverUrl: string | null;
        snapshot: ReturnType<typeof buildStagePlayerSnapshotFromPlaybackSyncBridge>;
    } | null>(null);

    const resolveAudioSourceHref = (source: string | null | undefined) => {
        if (!source) {
            return '';
        }

        try {
            return new URL(source, window.location.href).href;
        } catch {
            return source;
        }
    };

    const isAudioElementUsingCurrentSource = () => {
        const audioElement = audioRef.current;
        if (!audioElement || !audioSrc) {
            return false;
        }

        const expectedSource = resolveAudioSourceHref(audioSrc);
        const currentSource = resolveAudioSourceHref(audioElement.currentSrc || audioElement.src);
        return Boolean(expectedSource && currentSource && expectedSource === currentSource);
    };

    const buildPlaybackSyncBridgeModelFromCurrentState = () => {
        // The clock the picture belongs to: the outgoing deck during a blend, the active deck the
        // rest of the time. The metadata below is already the held picture (the caller passes
        // `currentSong`/`duration`/`coverUrl` as the displayed track), so reading the active deck's
        // position here would show the outgoing song's title against the incoming song's clock.
        const audioElement = getDisplayAudioElement?.() ?? audioRef.current;
        const isCurrentAudioSource = isAudioElementUsingCurrentSource();
        const currentTimeSec = audioElement?.currentTime ?? currentTime.get();
        const stagePositionSec = resolveStagePlayerPositionSec({
            activePlaybackContext,
            isExternalPlaybackSourceActive: isNowPlayingStageActive,
            audioCurrentTimeSec: isCurrentAudioSource ? audioElement?.currentTime : undefined,
            motionCurrentTimeSec: currentTime.get(),
            syntheticStageLyricsTimeSec: getSyntheticStageLyricsTime?.(),
        });
        const audioDurationSec = isCurrentAudioSource && Number.isFinite(audioElement?.duration) && (audioElement?.duration ?? 0) > 0
            ? audioElement?.duration ?? 0
            : 0;
        const stageDurationSec = audioDurationSec > 0 || activePlaybackContext === 'main'
            ? audioDurationSec
            : duration;

        return buildPlaybackSyncBridgeModel({
            activePlaybackContext,
            currentSong,
            playQueue,
            currentTimeSec,
            stagePositionSec,
            durationSec: duration,
            stageDurationSec,
            playerState,
            coverUrl,
            cachedCoverUrl,
            effectiveLoopMode,
            isFmMode,
            isStageActive: isNowPlayingStageActive,
            controlsDisabled: isNowPlayingControlDisabledRef.current,
            transparentModeEnabled: transparentPlayerBackground,
            mainWindowClickThroughEnabled,
            mainWindowBorderVisible: showTransparentWindowBorder,
            playerChromeHidden: isPlayerChromeHidden,
            exportState,
            isDaylight,
            lyricOffsetMs: lyricTimelineOffsetMs,
            mainWindowWidth: window.innerWidth,
            mainWindowHeight: window.innerHeight,
        });
    };

    const buildDiscordPresenceSnapshot = () => {
        return buildDiscordPresenceSnapshotFromPlaybackSyncBridge(buildPlaybackSyncBridgeModelFromCurrentState());
    };

    const buildCurrentStagePlayerSnapshot = () => {
        const model = buildPlaybackSyncBridgeModelFromCurrentState();
        const cache = stageSnapshotCacheRef.current;
        if (
            cache &&
            cache.playQueue === model.playQueue &&
            cache.currentSong === model.currentSong &&
            cache.activePlaybackContext === model.activePlaybackContext &&
            cache.isStageActive === model.isStageActive &&
            cache.canGoPrevious === model.canGoPrevious &&
            cache.canGoNext === model.canGoNext &&
            cache.coverUrl === model.coverUrl
        ) {
            const now = Date.now();
            const positionMs = Math.max(0, Math.floor(model.stagePositionSec * 1000));
            const durationMs = Math.max(0, Math.floor(model.stageDurationSec * 1000));
            const snapshot = {
                ...cache.snapshot,
                playerState: model.playerState,
                positionMs,
                durationMs,
                sampledAtMs: now,
                updatedAt: now,
                current: cache.snapshot.current
                    ? { ...cache.snapshot.current, durationMs, coverUrl: model.coverUrl || cache.snapshot.current.coverUrl }
                    : null,
            };
            stageSnapshotCacheRef.current = { ...cache, snapshot };
            return snapshot;
        }

        const snapshot = buildStagePlayerSnapshotFromPlaybackSyncBridge(model);
        stageSnapshotCacheRef.current = {
            playQueue: model.playQueue,
            currentSong: model.currentSong,
            activePlaybackContext: model.activePlaybackContext,
            isStageActive: model.isStageActive,
            canGoPrevious: model.canGoPrevious,
            canGoNext: model.canGoNext,
            coverUrl: model.coverUrl,
            snapshot,
        };
        return snapshot;
    };

    const publishDiscordPresenceSnapshot = () => {
        if (!window.electron?.publishDiscordPresenceSnapshot) {
            return;
        }

        void window.electron.publishDiscordPresenceSnapshot(buildDiscordPresenceSnapshot()).catch((error) => {
            console.warn('[Discord] Failed to publish presence snapshot', error);
        });
    };

    const publishStagePlayerPlaybackUpdate = () => {
        if (!isStagePlayerSnapshotEnabled) {
            return Promise.resolve(null);
        }

        const publishStageSnapshot = window.electron?.publishStagePlayerSnapshot;
        if (!publishStageSnapshot) {
            return Promise.resolve(null);
        }

        return publishStageSnapshot(buildCurrentStagePlayerSnapshot(), { forcePlaybackEvent: true });
    };

    useEffect(() => {
        // Click-through keeps forwarding mouse-move into the renderer, so the titlebar would keep
        // revealing itself on a window the cursor cannot actually reach. Stop tracking while it is on.
        if (!isElectronWindow || mainWindowClickThroughEnabled) {
            setIsTitlebarRevealed(false);
            return;
        }

        const revealThreshold = 56;
        const handleMouseMove = (event: MouseEvent) => {
            const nextVisible = event.clientY <= revealThreshold;
            setIsTitlebarRevealed(prev => (prev === nextVisible ? prev : nextVisible));
        };
        const handleMouseLeave = () => setIsTitlebarRevealed(false);

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseleave', handleMouseLeave);
        };
    }, [isElectronWindow, mainWindowClickThroughEnabled, setIsTitlebarRevealed]);

    useEffect(() => {
        if (!window.electron?.onTaskbarControl) {
            return;
        }

        return window.electron.onTaskbarControl((action) => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current || !taskbarHasTrackRef.current) {
                return;
            }

            if (action === 'previous') {
                mediaSessionPrevRef.current();
                return;
            }

            if (action === 'next') {
                void mediaSessionNextRef.current();
                return;
            }

            if (taskbarPlayerStateRef.current === PlayerState.PLAYING) {
                mediaSessionPauseRef.current();
            } else {
                void mediaSessionPlayRef.current();
            }
        });
    }, [audioRef, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, taskbarHasTrackRef, taskbarPlayerStateRef]);

    useEffect(() => {
        if (!window.electron?.updateTaskbarControls) {
            return;
        }

        void window.electron.updateTaskbarControls(
            buildTaskbarControlsFromPlaybackSyncBridge(buildPlaybackSyncBridgeModelFromCurrentState())
        ).catch((error) => {
            console.warn('[Electron] Failed to update Windows taskbar controls', error);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSong, effectiveLoopMode, isFmMode, isNowPlayingStageActive, playQueue, playerState]);

    // System/IME voice input pauses playback and resumes it afterwards. Resume only
    // fires when this bridge caused the pause and the track is still paused, so a
    // manual user pause during dictation is never overridden.
    useEffect(() => {
        if (!isElectronWindow || !window.electron?.onVoiceInputStateChanged) {
            return;
        }

        return window.electron.onVoiceInputStateChanged((state) => {
            if (state?.active) {
                pausedByVoiceInputRef.current = false;
                if (
                    taskbarPlayerStateRef.current === PlayerState.PLAYING
                    && taskbarHasTrackRef.current
                    && !isNowPlayingControlDisabledRef.current
                ) {
                    pausedByVoiceInputRef.current = true;
                    mediaSessionPauseRef.current();
                }
                return;
            }

            if (!pausedByVoiceInputRef.current) {
                return;
            }

            pausedByVoiceInputRef.current = false;
            if (taskbarPlayerStateRef.current === PlayerState.PAUSED && !isNowPlayingControlDisabledRef.current) {
                void mediaSessionPlayRef.current();
            }
        });
    }, [isElectronWindow, isNowPlayingControlDisabledRef, mediaSessionPauseRef, mediaSessionPlayRef, taskbarHasTrackRef, taskbarPlayerStateRef]);

    useEffect(() => {
        if (!isElectronWindow) {
            setPlaybackSyncBridgeStatus(emptyPlaybackSyncBridgeStatus());
            return;
        }

        void window.electron?.getPlaybackSyncBridgeStatus?.().then(status => {
            setPlaybackSyncBridgeStatus(status);
        }).catch((error) => {
            console.warn('[Electron] Failed to read playback sync bridge status', error);
        });

        return window.electron?.onPlaybackSyncBridgeStatusChanged?.(status => {
            setPlaybackSyncBridgeStatus(status);
        });
    }, [isElectronWindow]);

    useEffect(() => {
        if (!playbackSyncBridgeStatus.discordPresenceEnabled || !window.electron?.publishDiscordPresenceSnapshot) {
            return;
        }

        publishDiscordPresenceSnapshot();
        const intervalId = window.setInterval(publishDiscordPresenceSnapshot, DISCORD_PRESENCE_SNAPSHOT_INTERVAL_MS);
        return () => window.clearInterval(intervalId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cachedCoverUrl, coverUrl, currentSong, duration, isNowPlayingStageActive, playbackSyncBridgeStatus.discordPresenceEnabled, playerState]);

    useEffect(() => {
        if (!isStagePlayerSnapshotEnabled || !window.electron?.publishStagePlayerSnapshot) {
            return;
        }

        const publish = () => {
            void window.electron?.publishStagePlayerSnapshot(buildCurrentStagePlayerSnapshot()).catch((error) => {
                console.warn('[Stage] Failed to publish player snapshot', error);
            });
        };

        publish();
        const intervalId = window.setInterval(publish, 1000);

        return () => {
            window.clearInterval(intervalId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlaybackContext, audioSrc, cachedCoverUrl, coverUrl, currentSong, duration, effectiveLoopMode, getSyntheticStageLyricsTime, isFmMode, isNowPlayingStageActive, isStagePlayerSnapshotEnabled, playQueue, playerState]);

    useEffect(() => {
        if (!window.electron?.onStagePlayerControlRequest) {
            return;
        }

        const complete = (requestId: string, ok: boolean, error?: unknown) => {
            void window.electron?.completeStagePlayerControlRequest?.({
                requestId,
                ok,
                error: ok ? null : error instanceof Error ? error.message : String(error),
            });
        };

        return window.electron.onStagePlayerControlRequest((request) => {
            try {
                if (isNowPlayingControlDisabledRef.current || !taskbarHasTrackRef.current) {
                    throw new Error('Player controls are disabled in the current context.');
                }

                if (request.action === 'prev') {
                    mediaSessionPrevRef.current();
                    complete(request.requestId, true);
                    return;
                }

                if (request.action === 'next') {
                    void Promise.resolve(mediaSessionNextRef.current()).then(() => complete(request.requestId, true)).catch(error => complete(request.requestId, false, error));
                    return;
                }

                if (request.action === 'pause') {
                    mediaSessionPauseRef.current();
                    complete(request.requestId, true);
                    return;
                }

                if (request.action === 'resume') {
                    void mediaSessionPlayRef.current().then(() => complete(request.requestId, true)).catch(error => complete(request.requestId, false, error));
                    return;
                }

                if (request.action === 'seek') {
                    const nextTime = Math.max(0, (request.positionMs ?? 0) / 1000);
                    // Same order as the window's own seek: mid-blend `audioRef` names the
                    // INCOMING deck, silent and holding a different track, so moving it moves
                    // nothing the listener can hear. The transition-aware path cancels the blend
                    // back onto the track on screen and seeks that instead.
                    if (onTransitionSeek?.(nextTime)) {
                        // Handled: that path seeks the deck it kept.
                    } else if (audioRef.current) {
                        audioRef.current.currentTime = nextTime;
                    } else if (activePlaybackContext === 'stage') {
                        syncStageLyricsClock?.(nextTime, duration, taskbarPlayerStateRef.current);
                    }
                    currentTime.set(nextTime);
                    void publishStagePlayerPlaybackUpdate()
                        .then(() => complete(request.requestId, true))
                        .catch(error => complete(request.requestId, false, error));
                    return;
                }

                throw new Error(`Unsupported Stage player control action: ${request.action}`);
            } catch (error) {
                complete(request.requestId, false, error);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlaybackContext, audioRef, currentTime, duration, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, onTransitionSeek, syncStageLyricsClock, taskbarHasTrackRef, taskbarPlayerStateRef]);

    useEffect(() => {
        if (!window.electron?.onStageExternalPlayRequest || !onExternalPlayRequest) {
            return;
        }

        return window.electron.onStageExternalPlayRequest((request) => {
            void onExternalPlayRequest(request);
        });
    }, [onExternalPlayRequest]);

    // Wrapped so the callbacks this hook hands back keep one identity for the app's lifetime. They
    // are all invoked from events or effects, and their churn was what kept every build*Model memo
    // in App.tsx from ever holding - see useStableCallbacks.ts.
    return useStableActionSurface({
        publishStagePlayerPlaybackUpdate,
    });
};
