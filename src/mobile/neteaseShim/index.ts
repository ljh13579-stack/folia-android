// Folia Android 适配层：本地 API shim 的 fetch 拦截器
// 在 Capacitor 容器中，本模块替代三类原本依赖服务器的能力：
//  1. 网易云封装后端（NeteaseCloudMusicApi）—— 假 origin `https://folia-ncm.local` 下的
//     全部路径由 neteaseShim/routes.ts 在本地实现，上游请求经 CapacitorHttp 直连网易。
//  2. `/api/lyric-proxy?url=...` 白名单代理 —— 直接转发到目标 URL（原生 HTTP 无 CORS），
//     白名单与自定义头转发规则同 api/lyric-proxy.js。
//  3. `/api/generate-theme*`、`/api/segment-lyrics` 等 AI 端点 —— 若在设置中配置了
//     远程 API Origin（自部署的 Vercel/CF 后端）则转发，否则返回 503，前端按失败降级。
// 拦截器在 src/index.tsx 中最先安装，早于一切网络请求。
import QRCode from 'qrcode';
import { ncmRoutes } from './routes';
import type { NcmAnswer } from './request';

export const NETEASE_SHIM_ORIGIN = 'https://folia-ncm.local';

// 与 api/lyric-proxy.js 相同的白名单（域名后缀匹配）
const LYRIC_PROXY_ALLOWED_HOSTS = ['.qq.com', 'y.gtimg.cn', '.kugou.com', '.kgimg.com'];

// lyric-proxy 需要原样转发的自定义请求头（同 api/lyric-proxy.js）
const LYRIC_PROXY_FORWARD_HEADERS = [
  'kg-rec',
  'kg-rc',
  'kg-clienttimems',
  'kg-thash',
  'kg-mid',
  'kg-dfid',
  'kg-uid',
  'mid',
  'dfid',
  'clienttime',
  'x-router',
  'signature',
  'appid',
  'clientver',
  'userid',
  'token',
  'kg-tid',
  'kg-v',
];

const REMOTE_API_STORAGE_KEY = 'folia.mobile.remoteApiOrigin';

/** 读取用户配置的远程 API Origin（用于可选的 AI 端点转发），未配置返回 null */
export const getRemoteApiOrigin = (): string | null => {
  try {
    const v = window.localStorage.getItem(REMOTE_API_STORAGE_KEY);
    return v && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
};

export const setRemoteApiOrigin = (origin: string) => {
  try {
    window.localStorage.setItem(REMOTE_API_STORAGE_KEY, origin.trim());
  } catch {
    /* 忽略持久化失败 */
  }
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const isHostAllowed = (hostname: string): boolean =>
  LYRIC_PROXY_ALLOWED_HOSTS.some(
    (suffix) => hostname === suffix.replace(/^\./, '') || hostname.endsWith(suffix),
  );

// u.y.qq.com 需要伪装成 Android QQ 音乐客户端（同 api/lyric-proxy.js）
const applyQqClientSpoof = (url: URL, headers: Record<string, string>) => {
  if (url.hostname === 'u.y.qq.com') {
    headers['Cookie'] = 'tmeLoginType=-1;';
    headers['User-Agent'] = 'okhttp/3.14.9';
  }
};

/** 处理网易云 shim 路由，返回与官方服务器一致的 JSON Response */
const handleNeteaseShim = async (url: URL): Promise<Response> => {
  const route = ncmRoutes[url.pathname];
  if (!route) {
    return jsonResponse(404, { code: 404, msg: `[folia-mobile] unknown netease route: ${url.pathname}` });
  }
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  let answer: NcmAnswer;
  try {
    answer = await route(query);
  } catch (error: any) {
    // createNcmRequest 在非 200 时抛出 answer 对象本身
    if (error && typeof error.status === 'number') {
      answer = error as NcmAnswer;
    } else {
      return jsonResponse(502, { code: 502, msg: String(error?.message || error) });
    }
  }

  // /login/qr/create?qrimg=true 需要在本地生成二维码 data URL（官方用 qrcode 包）
  if (url.pathname === '/login/qr/create' && query.qrimg && answer.body?.data?.qrurl) {
    try {
      answer.body.data.qrimg = await QRCode.toDataURL(answer.body.data.qrurl);
    } catch {
      answer.body.data.qrimg = '';
    }
  }

  return jsonResponse(answer.status, answer.body);
};

/** 处理 /api/lyric-proxy：白名单校验后直连目标 URL */
const handleLyricProxy = async (url: URL, request: Request, originalFetch: typeof fetch): Promise<Response> => {
  const target = url.searchParams.get('url');
  if (!target) {
    return jsonResponse(400, { error: 'Missing url parameter' });
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse(400, { error: 'Invalid url parameter' });
  }
  if (!isHostAllowed(targetUrl.hostname)) {
    return jsonResponse(403, { error: 'Host not allowed', host: targetUrl.hostname });
  }

  const headers: Record<string, string> = {};
  for (const name of LYRIC_PROXY_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  applyQqClientSpoof(targetUrl, headers);

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }
  return originalFetch(targetUrl.toString(), init);
};

// 需要远程 AI 后端的前缀；未配置远程时返回 503 让前端走“AI 不可用”的既有降级路径
const REMOTE_API_PREFIXES = ['/api/generate-theme', '/api/generate-theme_openai', '/api/segment-lyrics', '/api/qq', '/api/navidrome-preset'];

let installed = false;

/** 安装全部移动端 shim。必须在应用任何网络请求之前调用。 */
export const installMobileShims = (): void => {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return originalFetch(input as any, init);
    }

    // 1. 网易云 shim origin
    if (url.origin === NETEASE_SHIM_ORIGIN) {
      return handleNeteaseShim(url);
    }

    // 2. 白名单歌词代理
    if (url.pathname === '/api/lyric-proxy') {
      return handleLyricProxy(url, request, originalFetch);
    }

    // 3. 可选远程 API（AI 主题 / 歌词分词 / QQ / Navidrome 预置）
    if (REMOTE_API_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const remote = getRemoteApiOrigin();
      if (remote) {
        const target = remote + url.pathname + url.search;
        const proxyInit: RequestInit = { method: request.method, headers: request.headers };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          proxyInit.body = await request.text();
        }
        return originalFetch(target, proxyInit);
      }
      return jsonResponse(503, { code: 503, msg: 'Remote API origin not configured on this mobile build' });
    }

    return originalFetch(input as any, init);
  };
};
