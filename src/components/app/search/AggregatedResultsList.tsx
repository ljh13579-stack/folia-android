import React from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UnifiedSong } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import type { AggregatedSearchGroup, SearchSource } from '../../../stores/useSearchNavigationStore';
import SearchResultRow from './SearchResultRow';

// src/components/app/search/AggregatedResultsList.tsx
// 「全部」tab 的结果体：一个来源一组，组内最多 AGGREGATE_GROUP_LIMIT 行（store 已裁剪），
// 「查看全部」跳到该来源自己的 tab 做全量翻页。行复用 SearchResultRow，但不做虚拟列表 ——
// 每组就几行，平铺滚动更简单。

type AggregatedResultsListProps = {
    groups: AggregatedSearchGroup[];
    isDaylight: boolean;
    getSourceLabel: (source: SearchSource) => string;
    onViewAll: (source: SearchSource) => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
    resolveTrackDisplay?: (track: UnifiedSong) => UnifiedSong;
};

const AggregatedResultsList: React.FC<AggregatedResultsListProps> = ({
    groups,
    isDaylight,
    getSourceLabel,
    onViewAll,
    onPlayTrack,
    onAddTrackToQueue,
    onOpenArtist,
    onOpenAlbum,
    resolveTrackDisplay,
}) => {
    const { t } = useTranslation();

    return (
        <div className="pb-2">
            {groups.map(group => (
                <section key={group.source} className="mb-5">
                    <header className="mb-1.5 flex items-center justify-between px-2">
                        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-60">
                            {getSourceLabel(group.source)}
                            {group.status === 'pending' && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            )}
                        </h3>
                        {group.status === 'error' ? (
                            <span className="text-xs opacity-50">{t('search.error')}</span>
                        ) : group.results.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => onViewAll(group.source)}
                                className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors ${
                                    isDaylight
                                        ? 'bg-black/5 text-black/60 hover:bg-black/10'
                                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                                }`}
                            >
                                {t('search.viewAll')}
                                <ArrowRight className="h-3 w-3" />
                            </button>
                        ) : null}
                    </header>
                    {group.results.map((track, index) => {
                        const resolved = resolveTrackDisplay ? resolveTrackDisplay(track) : track;
                        return (
                            <SearchResultRow
                                key={`${group.source}-${resolved.id ?? `${resolved.name}-${index}`}`}
                                track={resolved}
                                style={{ height: 76 }}
                                isDaylight={isDaylight}
                                onPlayTrack={onPlayTrack}
                                onAddTrackToQueue={onAddTrackToQueue}
                                onOpenArtist={onOpenArtist}
                                onOpenAlbum={onOpenAlbum}
                            />
                        );
                    })}
                </section>
            ))}
        </div>
    );
};

export default AggregatedResultsList;
