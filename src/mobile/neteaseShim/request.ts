// Folia Android 适配层：createRequest 的浏览器端移植
// 移植自 @neteasecloudmusicapienhanced/api 的 util/request.js，保留 weapi/eapi/api 三种
// 加密通道与 cookie 处理语义；做了如下有文档说明的取舍：
//  - 不走 xeapi/neapi（需要 X25519 会话与动态密钥注册，移植成本过高）；
//    register/anonimous 改用 weapi 请求同一上游，song/url/v1 改用经典 eapi 请求。
//  - 响应加密（e_r）按官方默认配置恒为 false，响应均为明文 JSON。
//  - NMTID 直接使用随机值（Node 版前 3 次请求后也会退化为随机值）。
//  - 反作弊 checkToken 头不实现（影响 playlist/subscribe 等个别写接口，属可接受降级）。
//  HTTP 传输：Capacitor 原生容器里直接调用原生 CapacitorHttp 插件（见 postFormEncoded），
//  其余平台走 window.fetch。注意不能依赖内置的 fetch 补丁——它用 new Headers() 构造请求，
//  浏览器会把 Cookie / Referer 当作「禁止头」静默丢弃，设备指纹发不出去。
import CryptoJS from 'crypto-js';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { weapi, linuxapi, eapi } from './crypto';

const DOMAIN = 'https://music.163.com';
const API_DOMAIN = 'https://interface.music.163.com';
const EAPI_DOMAIN = 'https://interfacepc.music.163.com';

const OS_MAP: Record<string, { os: string; appver: string; osver: string; channel: string }> = {
  pc: {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
  },
  android: {
    os: 'android',
    appver: '8.20.20.231215173437',
    osver: '14',
    channel: 'xiaomi',
  },
  iphone: {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution',
  },
  osx: {
    os: 'osx',
    appver: '3.1.10.5100',
    osver: '15.5',
    channel: 'netease',
  },
};

const UA = {
  weapiPc:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  apiAndroid:
    'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)',
  apiIphone: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
  linuxapiLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
  osx: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// 与 Node 版一致：每次启动生成一次、全程复用的 WNMCID。
// 懒生成（首次请求时才求值）：模块求值期不能取 Date.now()，导入链在单测里会被
// 上游的 liked-songs 契约测试打桩（neteaseLikedSongs.test.ts 断言 likelist 地址里的
// timestamp 逐次递增，导入期的一次 Date.now() 就会吃掉第一个桩值）。
let wnmcidCache: string | null = null;
const getWNMCID = (): string => {
  if (!wnmcidCache) {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    wnmcidCache = `${s}.${Date.now()}.01.0`;
  }
  return wnmcidCache;
};

// 设备 ID：Node 版由 register/anonimous 生成并放入 global.deviceId，这里本地生成并持久化
const DEVICE_ID_STORAGE_KEY = 'folia.mobile.ncm.deviceId';
export const getDeviceId = (): string => {
  try {
    const cached = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (cached && cached.length === 52) return cached;
  } catch {
    /* localStorage 不可用时用临时值 */
  }
  const hex = '0123456789ABCDEF';
  let id = '';
  for (let i = 0; i < 52; i++) id += hex.charAt(Math.floor(Math.random() * 16));
  try {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  } catch {
    /* 忽略持久化失败 */
  }
  return id;
};

// 匿名 token（MUSIC_A）：通过 /register/anonimous 获得后缓存，未登录请求注入
let anonymousToken = '';
export const setAnonymousToken = (token: string) => {
  anonymousToken = token;
};
export const getAnonymousToken = () => anonymousToken;

export const cookieToJson = (cookie: string): Record<string, string> => {
  if (!cookie) return {};
  const obj: Record<string, string> = {};
  cookie.split(';').forEach((pair) => {
    const arr = pair.split('=');
    if (arr.length === 2) obj[arr[0].trim()] = arr[1].trim();
  });
  return obj;
};

export const cookieObjToString = (cookie: Record<string, string>): string =>
  Object.keys(cookie)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(cookie[key])}`)
    .join('; ');

const randomHex = (byteCount: number): string => {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

// generateRandomChineseIP 的简化版（Node 版从 CIDR 表加权随机，这里用其兜底公式）
export const generateRandomChineseIP = (): string => {
  const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  return `116.${rand(25, 94)}.${rand(1, 255)}.${rand(1, 255)}`;
};

const generateRequestId = () => `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`;

export type NcmCrypto = 'weapi' | 'eapi' | 'api' | 'linuxapi';

export interface NcmRequestOptions {
  crypto?: NcmCrypto | '';
  cookie?: string | Record<string, string>;
  ua?: string;
  realIP?: string;
  randomCNIP?: boolean;
  headers?: Record<string, string>;
}

export interface NcmAnswer {
  status: number;
  body: any;
  cookie: string[];
}

const toBoolean = (val: unknown): boolean | '' => {
  if (typeof val === 'boolean') return val;
  if (val === '') return '';
  return val === 'true' || (val as unknown) == '1';
};

const SPECIAL_STATUS_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803]);

// 多个 Set-Cookie 可能被逗号拼接，只在“逗号后紧跟 name=”的位置拆分，避免误切 Expires 里的日期。
const splitSetCookieHeader = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(/,\s*(?=[A-Za-z_][A-Za-z0-9_-]*=)/)
    .map((x) => x.replace(/\s*Domain=[^(;|$)]+;*/, '').trim())
    .filter(Boolean);
};

// 网易上游的 POST 传输。Capacitor 原生容器里绕开内置 fetch 补丁、直接调用原生 CapacitorHttp：
// 补丁（native-bridge.js）用 new Headers() 构造请求，其 guard 为 "request"，浏览器会把
// Cookie / Referer 这类「禁止头」静默丢弃，设备指纹（deviceId/os/appver/NMTID/MUSIC_A…）
// 于是根本发不出去。直接调插件时 headers 是普通对象，原样交给原生 OkHttp，
// 原生侧除 x-cap-user-agent 外不改动任何请求头，Cookie 才能真正到达网易。
const postFormEncoded = async (
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string; setCookie: string | null }> => {
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  };
  // Android WebView 会把 User-Agent 在传递途中丢掉（同 XHR 补丁里的 x-cap-user-agent 变通）；
  // 原生侧见到它会把 User-Agent 还原回来，避免网易看到 WebView 的默认 UA。
  if (requestHeaders['User-Agent']) {
    requestHeaders['x-cap-user-agent'] = requestHeaders['User-Agent'];
  }

  if (Capacitor.isNativePlatform() && typeof CapacitorHttp?.request === 'function') {
    const response = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: requestHeaders,
      // 与补丁路径一致：Content-Type 为 x-www-form-urlencoded 时，原生侧把该字符串原样写出
      data: body,
    });
    const { data, headers: responseHeaders } = response;
    return {
      status: response.status,
      // 原生层在 Content-Type 为 JSON 时已解析为对象，这里还原成文本，与 fetch 路径保持一致
      text: typeof data === 'string' ? data : JSON.stringify(data),
      setCookie: responseHeaders?.['Set-Cookie'] ?? responseHeaders?.['set-cookie'] ?? null,
    };
  }

  const response = await fetch(url, { method: 'POST', headers: requestHeaders, body });
  return {
    status: response.status,
    text: await response.text(),
    setCookie: response.headers.get('set-cookie'),
  };
};

/** 对应 Node 版 createRequest(uri, data, options) */
export const createNcmRequest = async (
  uri: string,
  data: Record<string, any>,
  options: NcmRequestOptions,
): Promise<NcmAnswer> => {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const ip = options.realIP || (options.randomCNIP ? generateRandomChineseIP() : '');
  if (ip) {
    headers['X-Real-IP'] = ip;
    headers['X-Forwarded-For'] = ip;
  }

  let cookieObj: Record<string, string> =
    typeof options.cookie === 'string' ? cookieToJson(options.cookie) : { ...(options.cookie ?? {}) };

  // processCookieObject：合并默认值
  const nuid = randomHex(32);
  const osPreset = OS_MAP[cookieObj.os] ?? OS_MAP.pc;
  cookieObj = {
    ...cookieObj,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookieObj._ntes_nuid || nuid,
    _ntes_nnid: cookieObj._ntes_nnid || `${nuid},${Date.now()}`,
    WNMCID: cookieObj.WNMCID || getWNMCID(),
    WEVNSM: cookieObj.WEVNSM || '1.0.0',
    osver: cookieObj.osver || osPreset.osver,
    deviceId: cookieObj.deviceId || getDeviceId(),
    os: cookieObj.os || osPreset.os,
    channel: cookieObj.channel || osPreset.channel,
    appver: cookieObj.appver || osPreset.appver,
  };

  const cryptoMode: NcmCrypto = options.crypto || 'eapi';
  if (cryptoMode === 'eapi' && !cookieObj.NMTID) {
    cookieObj.NMTID = '00O' + randomHex(19);
  }
  if (!cookieObj.MUSIC_U && anonymousToken) {
    cookieObj.MUSIC_A = cookieObj.MUSIC_A || anonymousToken;
  }
  // Node 版在此对所有加密方式先设置一次完整 Cookie 头；eapi/api 分支会用精简 header 覆盖
  headers['Cookie'] = cookieObjToString(cookieObj);

  const csrfToken = cookieObj['__csrf'] || '';
  let url = '';
  let encryptData: Record<string, string> = {};

  switch (cryptoMode) {
    case 'weapi': {
      headers['Referer'] = DOMAIN;
      headers['User-Agent'] = options.ua || UA.weapiPc;
      data.csrf_token = csrfToken;
      encryptData = weapi(data) as Record<string, string>;
      url = DOMAIN + '/weapi/' + uri.substring(5);
      break;
    }
    case 'linuxapi': {
      headers['User-Agent'] = options.ua || UA.linuxapiLinux;
      encryptData = linuxapi({
        method: 'POST',
        url: DOMAIN + uri,
        params: data,
      }) as Record<string, string>;
      url = DOMAIN + '/api/linux/forward';
      break;
    }
    case 'eapi':
    case 'api': {
      const header: Record<string, string> = {
        osver: cookieObj.osver,
        deviceId: cookieObj.deviceId,
        os: cookieObj.os,
        appver: cookieObj.appver,
        versioncode: cookieObj.versioncode || '140',
        mobilename: cookieObj.mobilename || '',
        buildver: cookieObj.buildver || Date.now().toString().substring(0, 10),
        resolution: cookieObj.resolution || '1920x1080',
        __csrf: csrfToken,
        channel: cookieObj.channel,
        requestId: generateRequestId(),
      };
      if (cookieObj.MUSIC_U) header['MUSIC_U'] = cookieObj.MUSIC_U;
      if (cookieObj.MUSIC_A) header['MUSIC_A'] = cookieObj.MUSIC_A;
      if (cryptoMode === 'eapi' && cookieObj.NMTID) header['NMTID'] = cookieObj.NMTID;

      headers['Cookie'] = cookieObjToString(header);
      headers['User-Agent'] = options.ua || (cookieObj.os === 'osx' ? UA.osx : UA.apiIphone);

      if (cryptoMode === 'eapi') {
        data.header = header;
        encryptData = eapi(uri, data) as Record<string, string>;
        url = EAPI_DOMAIN + '/eapi/' + uri.substring(5);
      } else {
        url = API_DOMAIN + uri;
        encryptData = data as Record<string, string>;
      }
      break;
    }
  }

  const answer: NcmAnswer = { status: 500, body: {}, cookie: [] };

  try {
    const { status, text, setCookie } = await postFormEncoded(
      url,
      headers,
      new URLSearchParams(encryptData).toString(),
    );
    answer.cookie = splitSetCookieHeader(setCookie);
    try {
      answer.body = JSON.parse(text);
    } catch {
      // 某些错误响应会把同一文档重复拼接，截到第一个完整 JSON 为止（同 Node 版 parseBody）
      const boundary = text.indexOf('}{');
      if (boundary >= 0) {
        answer.body = JSON.parse(text.slice(0, boundary + 1));
      } else {
        answer.body = text;
      }
    }
    if (answer.body && typeof answer.body === 'object' && answer.body.code) {
      answer.body.code = Number(answer.body.code);
    }
    answer.status = Number(answer.body?.code || status);
    if (SPECIAL_STATUS_CODES.has(answer.body?.code)) {
      answer.status = 200;
    }
  } catch (err: any) {
    answer.status = 502;
    answer.body = { code: 502, msg: err?.message || String(err) };
  }

  answer.status = answer.status > 100 && answer.status < 600 ? answer.status : 400;
  if (answer.status === 200) {
    return answer;
  }
  throw answer;
};
