// src/components/app/presentation/buildPlayerViewFlags.ts

// Builds top-level player-view booleans used by the shell, overlays, and floating controls.
export const buildPlayerViewFlags = ({
    currentView,
    disableHomeDynamicBackground,
    hidePlayerProgressBar,
    hidePlayerTranslationSubtitle,
    hidePlayerUpcomingSubtitle,
    hidePlayerRightPanelButton,
    isNowPlayingControlDisabled,
    activePlaybackContext,
    stageActiveEntryKind,
    audioSrc,
    duration,
}: {
    currentView: string;
    disableHomeDynamicBackground: boolean;
    hidePlayerProgressBar: boolean;
    hidePlayerTranslationSubtitle: boolean;
    hidePlayerUpcomingSubtitle: boolean;
    hidePlayerRightPanelButton: boolean;
    isNowPlayingControlDisabled: boolean;
    activePlaybackContext: 'main' | 'stage';
    stageActiveEntryKind: string | null;
    audioSrc: string | null;
    duration: number;
}) => {
    const isPlayerView = currentView === 'player';
    return {
        isPlayerView,
        shouldPauseVisualizerBackground: currentView !== 'player' && disableHomeDynamicBackground,
        shouldHidePlayerProgressBar: isPlayerView && hidePlayerProgressBar,
        shouldHidePlayerTranslationSubtitle: isPlayerView && hidePlayerTranslationSubtitle,
        shouldHidePlayerUpcomingSubtitle: isPlayerView && hidePlayerUpcomingSubtitle,
        shouldHidePlayerRightPanelButton: isPlayerView && hidePlayerRightPanelButton,
        canToggleCurrentPlayback: !isNowPlayingControlDisabled && Boolean(
            audioSrc || (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && duration > 0),
        ),
    };
};
