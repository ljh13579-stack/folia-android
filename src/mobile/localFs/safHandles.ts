import { FoliaFs, type SafTreeEntry } from './safPlugin';

// src/mobile/localFs/safHandles.ts
// 在 Capacitor 容器中模拟浏览器 File System Access API：
//   SafDirectoryHandle ≈ FileSystemDirectoryHandle（values/getDirectoryHandle/getFileHandle/
//     queryPermission/requestPermission/isSameEntry），
//   SafFileHandle      ≈ FileSystemFileHandle（getFile），
//   SafLazyFile        ≈ File（slice/arrayBuffer/text 走原生按需区间读取，不全量加载）。
// 这样 localMusicService 的导入/快照/恢复逻辑几乎不用改动。
// 目录句柄的持久化不走 IndexedDB（结构化克隆会丢方法），而是把 SAF tree URI 描述符
// 存进 localStorage，读取时重建句柄并懒扫描。

export interface SafDirDescriptor {
    treeUri: string;
    name: string;
}

const SAF_DIR_STORAGE_KEY = 'folia.mobile.safDirHandles';

/** base64 → Uint8Array（分块避免字符串参数过长） */
function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** 单次桥读取上限（插件侧硬上限 32 MiB，这里留足余量并控制 base64 内存峰值） */
const SAF_READ_CHUNK_SIZE = 8 * 1024 * 1024;

/** 读取 SAF 文件字节区间；超过分块大小时自动分段拼接（整文件物化场景） */
async function readSafRange(uri: string, offset: number, length: number): Promise<Uint8Array> {
    if (length <= SAF_READ_CHUNK_SIZE) {
        const { data } = await FoliaFs.readFileRange({ uri, offset, length });
        return decodeBase64(data);
    }
    const result = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
        const chunkLength = Math.min(SAF_READ_CHUNK_SIZE, length - filled);
        const { data } = await FoliaFs.readFileRange({ uri, offset: offset + filled, length: chunkLength });
        const chunk = decodeBase64(data);
        result.set(chunk, filled);
        filled += chunk.length;
        if (chunk.length < chunkLength) break; // EOF
    }
    // EOF 提前结束时裁掉未填充尾部，保证 arrayBuffer() 长度与实际字节一致
    return filled === length ? result : result.slice(0, filled);
}

/** 按扩展名猜 MIME，供懒文件携带正确的 type */
function guessMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        mp3: 'audio/mpeg',
        flac: 'audio/flac',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        opus: 'audio/ogg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        wma: 'audio/x-ms-wma',
        ape: 'audio/x-ape',
        lrc: 'text/plain',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
    };
    return map[ext] || '';
}

/** 规范化 slice 的 start/end（支持负数，相对 size） */
function normalizeSliceRange(size: number, start?: number, end?: number): [number, number] {
    let s = start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
    let e = end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
    if (e < s) e = s;
    return [s, e];
}

/**
 * 懒加载 Blob：不持有真实字节，slice 仍返回懒 Blob，arrayBuffer/text 才触发原生区间读取。
 * music-metadata（strtok3）只通过 blob.slice(...).arrayBuffer() 读取，因此元数据解析
 * 可以全程按需读，导入大曲库时不必整文件过桥。
 */
export class SafLazyBlob extends Blob {
    protected readonly safUri: string;
    protected readonly safStart: number;
    protected readonly safEnd: number;

    constructor(uri: string, start: number, end: number, type = '') {
        super([], { type });
        this.safUri = uri;
        this.safStart = start;
        this.safEnd = end;
        Object.defineProperty(this, 'size', { get: () => this.safEnd - this.safStart });
    }

    override slice(start?: number, end?: number, contentType?: string): Blob {
        const [s, e] = normalizeSliceRange(this.size, start, end);
        return new SafLazyBlob(this.safUri, this.safStart + s, this.safStart + e, contentType ?? this.type);
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await readSafRange(this.safUri, this.safStart, this.size);
        return bytes.buffer as ArrayBuffer;
    }

    override async text(): Promise<string> {
        return new TextDecoder().decode(await this.arrayBuffer());
    }

    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        const source = this;
        return new ReadableStream({
            async start(controller) {
                controller.enqueue(new Uint8Array(await source.arrayBuffer()));
                controller.close();
            },
        });
    }
}

/**
 * 懒加载 File：语义同 SafLazyBlob，额外携带 name/lastModified。
 * 注意不可结构化克隆（不能 postMessage 进 worker）；需要真实字节时调 materialize()。
 */
export class SafLazyFile extends File {
    private readonly lazy: { uri: string; start: number; end: number };

    constructor(uri: string, name: string, size: number, lastModified: number, type = '') {
        super([], name, { lastModified, type: type || guessMimeType(name) });
        this.lazy = { uri, start: 0, end: size };
        Object.defineProperty(this, 'size', { get: () => this.lazy.end - this.lazy.start });
    }

    override slice(start?: number, end?: number, contentType?: string): Blob {
        const [s, e] = normalizeSliceRange(this.size, start, end);
        return new SafLazyBlob(this.lazy.uri, this.lazy.start + s, this.lazy.start + e, contentType ?? this.type);
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await readSafRange(this.lazy.uri, this.lazy.start, this.size);
        return bytes.buffer as ArrayBuffer;
    }

    override async text(): Promise<string> {
        return new TextDecoder().decode(await this.arrayBuffer());
    }

    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        const source = this;
        return new ReadableStream({
            async start(controller) {
                controller.enqueue(new Uint8Array(await source.arrayBuffer()));
                controller.close();
            },
        });
    }

    /** 读取全部字节，返回真实 File（播放建 blob URL、FLAC 封面修复等场景使用） */
    async materialize(): Promise<File> {
        const buffer = await this.arrayBuffer();
        return new File([buffer], this.name, { type: this.type, lastModified: this.lastModified });
    }
}

type SafChildHandle = SafDirectoryHandle | SafFileHandle;

/** SAF 文件句柄：getFile() 返回懒文件 */
export class SafFileHandle {
    readonly kind = 'file' as const;
    readonly name: string;

    constructor(private readonly entry: SafTreeEntry) {
        this.name = entry.name;
    }

    async getFile(): Promise<File> {
        return new SafLazyFile(this.entry.uri, this.entry.name, this.entry.size, this.entry.lastModified);
    }

    async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        return (other as unknown as SafFileHandle)?.entry?.uri === this.entry.uri;
    }
}

/** 树扫描结果缓存：一次 scanTree，按父路径分桶，供各层目录句柄共享 */
class SafTreeScanner {
    private childrenByDir: Map<string, SafTreeEntry[]> | null = null;

    constructor(private readonly treeUri: string) {}

    async childrenOf(relativeDir: string): Promise<SafTreeEntry[]> {
        if (!this.childrenByDir) {
            const { entries } = await FoliaFs.scanTree({ treeUri: this.treeUri });
            const buckets = new Map<string, SafTreeEntry[]>();
            for (const entry of entries) {
                const slash = entry.path.lastIndexOf('/');
                const parent = slash === -1 ? '' : entry.path.slice(0, slash);
                const bucket = buckets.get(parent);
                if (bucket) bucket.push(entry);
                else buckets.set(parent, [entry]);
            }
            this.childrenByDir = buckets;
        }
        return this.childrenByDir.get(relativeDir) ?? [];
    }
}

/** SAF 目录句柄：首次访问子项时才触发（共享的）整树扫描 */
export class SafDirectoryHandle {
    readonly kind = 'directory' as const;
    readonly name: string;
    /** db.ts 持久化分支凭此标记取回描述符 */
    readonly __safDescriptor: SafDirDescriptor;
    private readonly relativePath: string;
    private readonly scanner: SafTreeScanner;
    private children: Map<string, SafChildHandle> | null = null;

    constructor(descriptor: SafDirDescriptor, relativePath: string, scanner: SafTreeScanner, name: string) {
        this.__safDescriptor = descriptor;
        this.relativePath = relativePath;
        this.scanner = scanner;
        this.name = name;
    }

    private async ensureChildren(): Promise<Map<string, SafChildHandle>> {
        if (!this.children) {
            const entries = await this.scanner.childrenOf(this.relativePath);
            const children = new Map<string, SafChildHandle>();
            for (const entry of entries) {
                if (entry.isDir) {
                    children.set(entry.name, new SafDirectoryHandle(this.__safDescriptor, entry.path, this.scanner, entry.name));
                } else {
                    children.set(entry.name, new SafFileHandle(entry));
                }
            }
            this.children = children;
        }
        return this.children;
    }

    async *values(): AsyncIterableIterator<SafChildHandle> {
        const children = await this.ensureChildren();
        yield* children.values();
    }

    async *entries(): AsyncIterableIterator<[string, SafChildHandle]> {
        const children = await this.ensureChildren();
        yield* children.entries();
    }

    async *keys(): AsyncIterableIterator<string> {
        const children = await this.ensureChildren();
        yield* children.keys();
    }

    async getDirectoryHandle(name: string): Promise<SafDirectoryHandle> {
        const child = (await this.ensureChildren()).get(name);
        if (!child || child.kind !== 'directory') {
            throw new DOMException(`Directory not found: ${name}`, 'NotFoundError');
        }
        return child;
    }

    async getFileHandle(name: string): Promise<SafFileHandle> {
        const child = (await this.ensureChildren()).get(name);
        if (!child || child.kind !== 'file') {
            throw new DOMException(`File not found: ${name}`, 'NotFoundError');
        }
        return child;
    }

    async queryPermission(_descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState> {
        try {
            const { granted } = await FoliaFs.checkPermission({ treeUri: this.__safDescriptor.treeUri });
            return granted ? 'granted' : 'denied';
        } catch {
            return 'denied';
        }
    }

    /** SAF 权限随选择器一次性授予并持久化；request 与 query 等价（无法在前台静默重授） */
    async requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState> {
        return this.queryPermission(descriptor);
    }

    async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        const otherDir = other as unknown as SafDirectoryHandle;
        return otherDir?.__safDescriptor?.treeUri === this.__safDescriptor.treeUri
            && otherDir?.relativePath === this.relativePath;
    }
}

/** 由描述符重建根目录句柄（扫描懒触发） */
export function buildSafDirectoryHandle(descriptor: SafDirDescriptor): SafDirectoryHandle {
    return new SafDirectoryHandle(descriptor, '', new SafTreeScanner(descriptor.treeUri), descriptor.name);
}

export function getSafDirDescriptors(): Record<string, SafDirDescriptor> {
    try {
        return JSON.parse(window.localStorage.getItem(SAF_DIR_STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

export function saveSafDirDescriptors(map: Record<string, SafDirDescriptor>): void {
    try {
        window.localStorage.setItem(SAF_DIR_STORAGE_KEY, JSON.stringify(map));
    } catch (error) {
        console.error('[SafHandles] Failed to persist directory descriptors:', error);
    }
}
