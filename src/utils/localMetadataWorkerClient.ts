import { SafLazyFile } from '../mobile/localFs/safHandles';

export interface EmbeddedMetadataResult {
    title?: string;
    artist?: string;
    artists?: string[];
    album?: string;
    trackNumber?: number;
    discNumber?: number;
    cover?: Blob;
    coverAssetId?: string;
    bitrate?: number;
    lyrics?: string;
    translationLyrics?: string;
    replayGain?: number;
    replayGainTrackGain?: number;
    replayGainTrackPeak?: number;
    replayGainAlbumGain?: number;
    replayGainAlbumPeak?: number;
    duration?: number;
}

export interface HashedLocalCoverResult {
    cover: Blob;
    coverAssetId: string;
}

let metadataWorker: Worker | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, (result: unknown | null) => void>();

export const initMetadataWorker = (): Worker => {
    if (!metadataWorker) {
        metadataWorker = new Worker(
            new URL('../workers/metadataParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        metadataWorker.onmessage = (e) => {
            const { type, data, requestId, message } = e.data;
            const callback = workerCallbacks.get(requestId);
            if (callback) {
                workerCallbacks.delete(requestId);
                if (type === 'result') {
                    callback(data);
                } else {
                    console.warn('[MetadataWorker] parsing error:', message);
                    callback(null);
                }
            }
        };
    }

    return metadataWorker;
};

export const parseEmbeddedMetadataAsync = (
    file: File,
    includeCover = false
): Promise<EmbeddedMetadataResult | null> => {
    // SAF 懒文件无法结构化克隆进 worker，改在主线程解析（其 slice/arrayBuffer 走原生按需读取）。
    // FLAC 带封面解析时 repairFlacMetadata 可能把 slice 结果重新拼成新 Blob，懒 Blob 无真实字节
    // 会导致拼出空数据，因此先 materialize 成全量 File。
    if (file instanceof SafLazyFile) {
        return (async () => {
            try {
                const input = includeCover && /\.flac$/i.test(file.name) ? await file.materialize() : file;
                const { extractEmbeddedMetadata } = await import('../workers/metadataParserCore');
                return await extractEmbeddedMetadata(input as File, includeCover);
            } catch (error) {
                console.warn('[MetadataWorker] SAF main-thread parsing error:', error);
                return null;
            }
        })();
    }
    return new Promise((resolve) => {
        const worker = initMetadataWorker();
        const requestId = `meta_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, result => resolve(result as EmbeddedMetadataResult | null));
        worker.postMessage({ type: 'parse-metadata', file, includeCover, requestId });
    });
};

export const hashLocalCoverBlobAsync = (cover: Blob): Promise<HashedLocalCoverResult | null> => {
    return new Promise((resolve) => {
        const worker = initMetadataWorker();
        const requestId = `cover_hash_req_${++workerRequestId}`;
        workerCallbacks.set(requestId, result => resolve(result as HashedLocalCoverResult | null));
        worker.postMessage({ type: 'hash-cover', cover, requestId });
    });
};
