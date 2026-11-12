// src/mobile/androidAi/fetchImpl.ts
// 给 shared/ 的 AI 服务模块（sendOpenAICompatibleRequest / segmentLyricLines）用的 fetch 适配器。
// Capacitor 原生容器里直接调原生 CapacitorHttp 插件：
//  - WebView 的 fetch 补丁（native-bridge.js）经 new Headers() 构造请求，会静默丢头，且
//    安卓 WebView 对 Gemini / OpenAI 这类跨域响应的 CORS 校验不受我们控制；
//  - 原生 CapacitorHttp 由 OkHttp 直发，无 CORS 限制，请求头普通对象原样透传。
// 非原生环境（浏览器预览、单测）回落到全局 fetch，保持同一接口。

import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface AiFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<unknown>;
    text(): Promise<string>;
    clone(): AiFetchResponse;
}

export type AiFetchInit = {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: unknown;
    signal?: AbortSignal | null;
};

export type AiFetch = (url: string, init?: AiFetchInit) => Promise<AiFetchResponse>;

/** 应用级总超时：覆盖 DNS 挂起等插件超时管不到的情况（如墙内直连 Gemini）。 */
const REQUEST_DEADLINE_MS = 60_000;

const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`AI request timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
    );
});

const normalizeHeaders = (headers?: Record<string, string> | Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!headers) {
        return out;
    }
    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    return { ...headers };
};

/** 文本可重读的最小 Response：shared 模块里 sendOpenAICompatibleRequest 会 clone() 读错误体。 */
const makeResponse = (status: number, text: string): AiFetchResponse => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => JSON.parse(text),
    text: async () => text,
    clone: () => makeResponse(status, text),
});

const nativeFetch: AiFetch = async (url, init) => {
    const headers = normalizeHeaders(init?.headers);
    // Android WebView 传递途中会丢 User-Agent（与音乐请求同一处 x-cap-user-agent 变通）。
    if (headers['User-Agent']) {
        headers['x-cap-user-agent'] = headers['User-Agent'];
    }

    // 原生插件不接 AbortSignal，插件自带的 connect/read 超时也不覆盖 DNS 挂起这类情况
    // （墙内访问 Gemini 会把请求永远吊住）；再兜一层应用级总超时，到点报错而不是让 UI 一直转圈。
    const response = await withDeadline(
        CapacitorHttp.request({
            url,
            method: (init?.method ?? 'GET').toUpperCase(),
            headers,
            // 与 fetch 语义一致：body 已是 JSON.stringify 后的字符串，原样写出。
            data: typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : JSON.stringify(init.body),
            connectTimeout: 20_000,
            readTimeout: 120_000,
        }),
        REQUEST_DEADLINE_MS,
    );

    const { data } = response;
    // 原生层在 Content-Type 为 JSON 时已把 data 解析成对象，这里还原成文本，与 fetch 路径一致。
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    return makeResponse(response.status, text);
};

const webFetch: AiFetch = async (url, init) => {
    const response = await fetch(url, {
        method: init?.method,
        headers: init?.headers ? normalizeHeaders(init.headers) : undefined,
        body: typeof init?.body === 'string' ? init.body : init?.body == null ? undefined : JSON.stringify(init.body),
        signal: init?.signal ?? undefined,
    });
    const text = await response.text();
    return makeResponse(response.status, text);
};

/** shared 模块要的 fetch 实现：原生走 CapacitorHttp，其余走全局 fetch。 */
export const androidAiFetch: AiFetch = (url, init) => (
    Capacitor.isNativePlatform() && typeof CapacitorHttp?.request === 'function'
        ? nativeFetch(url, init)
        : webFetch(url, init)
);

// shared/*.mjs 的 fetchImpl 形参以默认值为 typeof fetch 推导，这里是结构化等价的窄实现。
export const androidAiFetchForShared = androidAiFetch as unknown as typeof fetch;
