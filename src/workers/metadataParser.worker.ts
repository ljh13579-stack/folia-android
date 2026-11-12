import { extractEmbeddedMetadata, hashCoverBytes } from './metadataParserCore';

self.onmessage = async (e: MessageEvent) => {
    const { type, file, cover, includeCover, requestId } = e.data as {
        type: string;
        file?: File;
        cover?: Blob;
        includeCover?: boolean;
        requestId: string;
    };

    if (type !== 'parse-metadata' && type !== 'hash-cover') {
        self.postMessage({ type: 'error', message: 'Unknown message type', requestId });
        return;
    }

    try {
        if (type === 'hash-cover') {
            if (!(cover instanceof Blob) || cover.size === 0 || !cover.type.startsWith('image/')) {
                throw new Error('Invalid local cover payload');
            }
            const coverAssetId = await hashCoverBytes(await cover.arrayBuffer());
            if (!coverAssetId) throw new Error('Web Crypto SHA-256 is unavailable');
            self.postMessage({ type: 'result', data: { cover, coverAssetId }, requestId });
            return;
        }

        if (!(file instanceof File)) throw new Error('Missing metadata file');
        const data = await extractEmbeddedMetadata(file, Boolean(includeCover));
        self.postMessage({ type: 'result', data, requestId });
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err), requestId });
    }
};
