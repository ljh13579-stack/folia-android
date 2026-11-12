// Folia Android 适配层：NeteaseCloudMusicApi 路由模块的浏览器端移植
// 逐条移植自 @neteasecloudmusicapienhanced/api/module/*.js（路由路径由文件名推导，
// 与官方 server.js 的 parseRoute 规则一致）。语义对齐说明：
//  - createOption(query, '') 的“默认加密”在官方配置下等价于 eapi（APP_CONF.encrypt=true）。
//  - song/url/v1 官方新版走 xeapi，这里用经典 eapi 请求同一上游（level 语义不变）。
//  - register/anonimous 官方走 xeapi，这里用 weapi 请求同一上游拿匿名 token。
//  - scrobble/v1 依赖 NCBL 客户端日志协议，移动端 v1 暂不上报，直接返回成功（见报告）。
//  - playlist/subscribe 的反作弊 checkToken 头省略，个别账号可能失败，属可接受降级。
import CryptoJS from 'crypto-js';
import {
  createNcmRequest,
  getDeviceId,
  setAnonymousToken,
  type NcmAnswer,
  type NcmRequestOptions,
} from './request';

export type NcmQuery = Record<string, string | undefined>;
export type NcmRouteHandler = (query: NcmQuery) => Promise<NcmAnswer>;

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

const call = async (
  uri: string,
  data: Record<string, any>,
  query: NcmQuery,
  crypto: NcmRequestOptions['crypto'] = '',
): Promise<NcmAnswer> =>
  createNcmRequest(uri, data, {
    crypto,
    cookie: query.cookie,
    ua: query.ua,
    realIP: query.realIP,
    randomCNIP: query.randomCNIP === 'true' || (query.randomCNIP as unknown) === true,
  });

// cloudmusic_dll_encode_id：deviceId 逐字符与固定 key XOR 后取 MD5 的 Base64
const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2';
const cloudmusicDllEncodeId = (someId: string): string => {
  let xored = '';
  for (let i = 0; i < someId.length; i++) {
    xored += String.fromCharCode(someId.charCodeAt(i) ^ ID_XOR_KEY.charCodeAt(i % ID_XOR_KEY.length));
  }
  return CryptoJS.enc.Base64.stringify(CryptoJS.MD5(CryptoJS.enc.Utf8.parse(xored)));
};

export const ncmRoutes: Record<string, NcmRouteHandler> = {
  // 游客登录：返回匿名 token（MUSIC_A），成功后写入 shim 缓存供后续未登录请求注入
  '/register/anonimous': async (query) => {
    const deviceId = getDeviceId();
    const encodedId = CryptoJS.enc.Base64.stringify(
      CryptoJS.enc.Utf8.parse(`${deviceId} ${cloudmusicDllEncodeId(deviceId)}`),
    );
    const result = await call('/api/register/anonimous', { username: encodedId }, query, 'weapi');
    if (result.body?.code === 200) {
      const cookieStr = result.cookie.join(';');
      const musicA = /MUSIC_A=([^;]+)/.exec(cookieStr)?.[1];
      if (musicA) setAnonymousToken(decodeURIComponent(musicA));
      return { status: 200, body: { ...result.body, cookie: cookieStr }, cookie: result.cookie };
    }
    return result;
  },

  '/login/qr/key': async (query) => {
    const result = await call('/api/login/qrcode/unikey', { type: 3 }, query);
    return { status: 200, body: { data: result.body, code: 200 }, cookie: result.cookie };
  },

  // 官方实现是本地逻辑（用 qrcode 包生成 qrimg），qrimg 生成在 shim 层补
  '/login/qr/create': async (query) => {
    const url = `https://music.163.com/login?codekey=${query.key}`;
    return {
      status: 200,
      body: { code: 200, data: { qrurl: url, qrimg: '' } },
      cookie: [],
    };
  },

  '/login/qr/check': async (query) => {
    try {
      const result = await call('/api/login/qrcode/client/login', { key: query.key, type: 3 }, query);
      return {
        status: 200,
        body: { ...result.body, cookie: result.cookie.join(';') },
        cookie: result.cookie,
      };
    } catch (error: any) {
      // 官方模块此处有 bug（引用了未定义变量），这里按合理语义返回空 cookie
      return { status: 200, body: error?.body ?? {}, cookie: [] };
    }
  },

  '/login/status': async (query) => {
    const result = await call('/api/w/nuser/account/get', {}, query, 'weapi');
    if (result.body?.code === 200) {
      return { status: 200, body: { data: { ...result.body } }, cookie: result.cookie };
    }
    return result;
  },

  '/logout': (query) => call('/api/logout', {}, query),

  '/user/account': (query) => call('/api/nuser/account/get', {}, query, 'weapi'),

  '/song/detail': (query) => {
    const ids = (query.ids ?? '').split(/\s*,\s*/);
    const c = '[' + ids.map((id) => '{"id":' + id + '}').join(',') + ']';
    return call('/api/v3/song/detail', { c }, query, 'weapi');
  },

  '/song/copyright/rcmd': (query) =>
    call('/api/song/copyright/rcmd', { songid: query.songid || query.id }, query, 'eapi'),

  '/like': (query) =>
    call(
      '/api/radio/like',
      { alg: 'itembased', trackId: query.id, like: query.like !== 'false', time: '3' },
      query,
      'weapi',
    ),

  // NCBL 日志上报未移植：直接返回成功，避免影响播放流程（听歌记录不会上报）
  '/scrobble/v1': async () => ({
    status: 200,
    body: { code: 200, data: 'scrobble skipped on mobile build' },
    cookie: [],
  }),

  '/likelist': (query) => call('/api/song/like/get', { uid: query.uid }, query),

  '/user/playlist': (query) =>
    call(
      '/api/user/playlist',
      { uid: query.uid, limit: query.limit || 30, offset: query.offset || 0, includeVideo: true },
      query,
      'weapi',
    ),

  // 歌单全部歌曲：先取 trackIds 再按 id 批量取详情
  '/playlist/track/all': async (query) => {
    const limit = parseInt(query.limit ?? '') || 1000;
    const offset = parseInt(query.offset ?? '') || 0;
    const first = await call('/api/v6/playlist/detail', { id: query.id, n: 100000, s: query.s || 8 }, query);
    const trackIds: Array<{ id: number }> = first.body?.playlist?.trackIds ?? [];
    const slice = trackIds.slice(offset, offset + limit);
    const c = '[' + slice.map((i) => '{"id":' + i.id + '}').join(',') + ']';
    return call('/api/v3/song/detail', { c }, query);
  },

  '/playlist/detail': (query) =>
    call('/api/v6/playlist/detail', { id: query.id, n: 100000, s: query.s || 8 }, query),

  '/playlist/tracks': async (query) => {
    const tracks = (query.tracks ?? '').split(',');
    const data = { op: query.op, pid: query.pid, trackIds: JSON.stringify(tracks), imme: 'true' };
    try {
      const res = await call('/api/playlist/manipulate/tracks', data, query);
      // 与官方模块一致：成功时展开整个响应对象
      return { status: 200, body: { ...res }, cookie: res.cookie };
    } catch (error: any) {
      if (error?.body?.code === 512) {
        // 官方的重试策略：trackIds 翻倍再试一次
        const retryData = { ...data, trackIds: JSON.stringify([...tracks, ...tracks]) };
        return call('/api/playlist/manipulate/tracks', retryData, query);
      }
      return { status: 200, body: error?.body ?? {}, cookie: [] };
    }
  },

  '/album': (query) => call(`/api/v1/album/${query.id}`, {}, query, 'weapi'),

  '/album/sublist': (query) =>
    call('/api/album/sublist', { limit: query.limit || 25, offset: query.offset || 0, total: true }, query, 'weapi'),

  '/artist/detail': (query) => call('/api/artist/head/info/get', { id: query.id }, query),

  '/artist/album': (query) =>
    call(
      `/api/artist/albums/${query.id}`,
      { limit: query.limit || 30, offset: query.offset || 0, total: true },
      query,
      'weapi',
    ),

  '/artist/top/song': (query) => call('/api/artist/top/song', { id: query.id }, query, 'weapi'),

  '/artist/songs': (query) =>
    call(
      '/api/v1/artist/songs',
      {
        id: query.id,
        private_cloud: 'true',
        work_type: 1,
        order: query.order || 'hot',
        offset: query.offset || 0,
        limit: query.limit || 100,
      },
      query,
    ),

  '/song/url/v1': (query) => {
    const data: Record<string, any> = {
      ids: '[' + query.id + ']',
      level: query.level,
      encodeType: 'flac',
    };
    if (query.level === 'sky') {
      data.immerseType = query.immerseType || 'c51';
    }
    if (query.level === 'vivid') {
      data.encodeType = 'mp3';
    }
    return call('/api/song/enhance/player/url/v1', data, query, 'eapi');
  },

  '/lyric/new': (query) =>
    call(
      '/api/song/lyric/v1',
      { id: query.id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
      query,
    ),

  '/song/chorus': (query) => call('/api/song/chorus', { ids: JSON.stringify([query.id]) }, query),

  '/cloud/lyric/get': (query) =>
    call('/api/cloud/lyric/get', { userId: query.uid, songId: query.sid, lv: -1, kv: -1 }, query, 'eapi'),

  '/user/cloud': (query) =>
    call('/api/v1/cloud/get', { limit: query.limit || 30, offset: query.offset || 0 }, query, 'weapi'),

  '/user/cloud/detail': (query) => {
    const songIds = (query.id ?? '').replace(/\s/g, '').split(',');
    return call('/api/v1/cloud/get/byids', { songIds }, query, 'weapi');
  },

  '/cloudsearch': (query) =>
    call(
      '/api/cloudsearch/pc',
      {
        s: query.keywords,
        type: num(query.type) ?? 1,
        limit: query.limit || 30,
        offset: query.offset || 0,
        total: true,
      },
      query,
    ),

  '/personal_fm': (query) => call('/api/v1/radio/get', {}, query, 'weapi'),

  '/personal/fm/mode': (query) =>
    call('/api/v1/radio/get', { mode: query.mode, subMode: query.submode, limit: query.limit || 3 }, query),

  '/recommend/songs': (query) => call('/api/v3/discovery/recommend/songs', { afresh: query.afresh }, query, 'weapi'),

  '/recommend/songs/dislike': (query) =>
    call('/api/v2/discovery/recommend/dislike', { resId: query.id, resType: 4, sceneType: 1 }, query, 'weapi'),

  '/history/recommend/songs': (query) =>
    call('/api/discovery/recommend/songs/history/recent', {}, query, 'weapi'),

  '/history/recommend/songs/detail': (query) =>
    call('/api/discovery/recommend/songs/history/detail', { date: query.date || '' }, query, 'weapi'),

  '/personalized': (query) =>
    call('/api/personalized/playlist', { limit: query.limit || 30, total: true, n: 1000 }, query, 'weapi'),

  '/fm_trash': (query) =>
    call('/api/radio/trash/add', { songId: query.id, alg: 'RT', time: query.time || 25 }, query, 'weapi'),

  '/playlist/subscribe': (query) => {
    const path = (query.t as unknown) == 1 ? 'subscribe' : 'unsubscribe';
    return call(`/api/playlist/${path}`, { id: query.id }, query, 'eapi');
  },

  '/album/sub': (query) => {
    const t = (query.t as unknown) == 1 ? 'sub' : 'unsub';
    return call(`/api/album/${t}`, { id: query.id }, query, 'weapi');
  },

  '/playlist/detail/dynamic': (query) =>
    call('/api/playlist/detail/dynamic', { id: query.id, n: 100000, s: query.s || 8 }, query),

  '/album/detail/dynamic': (query) =>
    call('/api/album/detail/dynamic', { id: query.id }, query, 'weapi'),
};
