// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/mobile/androidAi.test.ts
// 安卓端 AI 链路：本机设置持久化 + aiText 的安卓分支（应用持密钥直连 Gemini / OpenAI 兼容端点）。
// Capacitor 打桩为安卓 WebView（非原生插件路径），HTTP 走全局 fetch 桩。

const capState = vi.hoisted(() => ({ platform: 'android' as string, native: false as boolean }));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => capState.native,
        getPlatform: () => capState.platform,
    },
    CapacitorHttp: { request: undefined },
}));

import {
    builtInOpenAiConfig,
    clearAndroidAiKey,
    getAndroidAiCredentials,
    loadAndroidAiEnv,
    loadAndroidAiSettings,
    saveAndroidAiKey,
    saveAndroidAiSettings,
} from '../../../src/mobile/androidAi/settings';
import { canRunAiConnectionTest, generateThemeFromLyrics, requestLyricSegmentation, runAiConnectionTest } from '../../../src/services/aiText';

const DUAL_THEME_JSON = {
    light: {
        name: '暖光',
        description: '像午后阳光落在旧书页上。',
        backgroundColor: '#FFF4E6',
        primaryColor: '#3D2C29',
        accentColor: '#E56B6F',
        secondaryColor: '#6B5653',
        wordColors: [{ word: '阳光', color: '#F2C14E' }],
        lyricsIcons: ['Sun'],
    },
    dark: {
        name: '暖夜',
        description: '像深夜台灯下未写完的信。',
        backgroundColor: '#241E1C',
        primaryColor: '#F5E9E2',
        accentColor: '#E56B6F',
        secondaryColor: '#B8A6A0',
        wordColors: [{ word: '阳光', color: '#F2C14E' }],
        lyricsIcons: ['Moon'],
    },
};

const geminiAnswer = (text: string) => JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
});

const fetchStub = () => {
    const stub = vi.fn();
    vi.stubGlobal('fetch', stub);
    return stub;
};

const jsonResponse = (status: number, body: string) => ({ status, text: async () => body });

beforeEach(() => {
    window.localStorage.clear();
    capState.platform = 'android';
    capState.native = false;
    builtInOpenAiConfig.apiKey = '';
    vi.unstubAllGlobals();
});

describe('androidAi settings persistence', () => {
    it('round-trips non-secret settings with defaults', () => {
        expect(loadAndroidAiSettings().AI_PROVIDER).toBe('gemini');
        saveAndroidAiSettings({ AI_PROVIDER: 'openai', OPENAI_API_URL: 'https://api.deepseek.com/v1', OPENAI_API_MODEL: 'deepseek-chat' });
        const loaded = loadAndroidAiSettings();
        expect(loaded.AI_PROVIDER).toBe('openai');
        expect(loaded.OPENAI_API_URL).toBe('https://api.deepseek.com/v1');
        expect(loaded.OPENAI_API_TEMPERATURE).toBe('0.7');
    });

    it('keeps keys in the keys store, reports credentials and binds the OpenAI key to its endpoint', () => {
        saveAndroidAiKey('GEMINI_API_KEY', 'g-key');
        saveAndroidAiKey('OPENAI_API_KEY', 'o-key', 'https://api.deepseek.com/v1');
        const credentials = getAndroidAiCredentials();
        expect(credentials.GEMINI_API_KEY).toBe(true);
        expect(credentials.OPENAI_API_KEY).toBe(true);
        expect(credentials.OPENAI_API_KEY_ENDPOINT).toBe('https://api.deepseek.com/v1');
        // 密钥不混进设置存储。
        expect(loadAndroidAiSettings()).not.toHaveProperty('GEMINI_API_KEY');
        const env = loadAndroidAiEnv();
        expect(env.GEMINI_API_KEY).toBe('g-key');
        expect(env.OPENAI_API_KEY).toBe('o-key');
        // 清除后 credentials 回落。
        expect(clearAndroidAiKey('OPENAI_API_KEY').OPENAI_API_KEY).toBe(false);
        expect(getAndroidAiCredentials().OPENAI_API_KEY_ENDPOINT).toBeNull();
    });

    it('lets the built-in test key stand in until the user saves their own', () => {
        builtInOpenAiConfig.apiKey = 'built-in-key';
        // 什么都没保存：内置密钥兜底地址、模型、密钥，credentials 报告已配置。
        let env = loadAndroidAiEnv();
        expect(env.OPENAI_API_KEY).toBe('built-in-key');
        expect(env.OPENAI_API_URL).toBe('https://open.bigmodel.cn/api/paas/v4');
        expect(env.OPENAI_API_MODEL).toBe('glm-4-flash');
        expect(getAndroidAiCredentials().OPENAI_API_KEY).toBe(true);
        // 用户保存自己的密钥后，内置密钥彻底让位（地址仍保留用户保存的）。
        saveAndroidAiKey('OPENAI_API_KEY', 'own-key', 'https://api.siliconflow.cn/v1');
        saveAndroidAiSettings({ OPENAI_API_URL: 'https://api.siliconflow.cn/v1' });
        env = loadAndroidAiEnv();
        expect(env.OPENAI_API_KEY).toBe('own-key');
        expect(env.OPENAI_API_URL).toBe('https://api.siliconflow.cn/v1');
        // 用户清空自己的密钥：回落到内置密钥，而不是无密钥可用。
        clearAndroidAiKey('OPENAI_API_KEY');
        expect(loadAndroidAiEnv().OPENAI_API_KEY).toBe('built-in-key');
    });
});

describe('aiText android branch', () => {
    it('enables the connection test on Android', () => {
        expect(canRunAiConnectionTest()).toBe(true);
        capState.platform = 'web';
        expect(canRunAiConnectionTest()).toBe(false);
        capState.platform = 'android';
    });

    it('generates a theme through the Gemini REST endpoint with the saved key', async () => {
        saveAndroidAiKey('GEMINI_API_KEY', 'g-key');
        const stub = fetchStub();
        stub.mockResolvedValue(jsonResponse(200, geminiAnswer(JSON.stringify(DUAL_THEME_JSON))));

        const theme = await generateThemeFromLyrics('some lyrics');

        expect(stub).toHaveBeenCalledTimes(1);
        const [url, init] = stub.mock.calls[0];
        expect(String(url)).toContain('generativelanguage.googleapis.com');
        expect(init.headers['x-goog-api-key']).toBe('g-key');
        expect(theme.light.provider).toBe('Google Gemini');
        expect(theme.light.fontStyle).toBe('sans');
        expect(theme.dark.name).toBe('暖夜');
    });

    it('generates a theme through the OpenAI-compatible endpoint when that provider is chosen', async () => {
        saveAndroidAiSettings({ AI_PROVIDER: 'openai', OPENAI_API_URL: 'https://api.deepseek.com/v1' });
        saveAndroidAiKey('OPENAI_API_KEY', 'o-key');
        const stub = fetchStub();
        stub.mockResolvedValue(jsonResponse(200, JSON.stringify({
            choices: [{ message: { content: JSON.stringify(DUAL_THEME_JSON) } }],
        })));

        const theme = await generateThemeFromLyrics('some lyrics');

        const [url, init] = stub.mock.calls[0];
        expect(String(url)).toBe('https://api.deepseek.com/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer o-key');
        expect(theme.light.provider).toBe('OpenAI Compatible');
    });

    it('fails the theme ask with a clear message when no key is saved', async () => {
        fetchStub();
        await expect(generateThemeFromLyrics('lyrics')).rejects.toThrow(/not configured/);
    });

    it('segments lyrics through the shared service with the saved Gemini key', async () => {
        saveAndroidAiKey('GEMINI_API_KEY', 'g-key');
        const stub = fetchStub();
        stub.mockResolvedValue(jsonResponse(200, geminiAnswer('{"lines":[["hello"," world"]]}')));

        const result = await requestLyricSegmentation(['hello world']);

        const [url, init] = stub.mock.calls[0];
        expect(String(url)).toContain('generativelanguage.googleapis.com');
        expect(init.headers['x-goog-api-key']).toBe('g-key');
        expect(result).toEqual([['hello', ' world']]);
    });

    it('runs the connection test and maps an auth failure to the invalid kind', async () => {
        saveAndroidAiKey('GEMINI_API_KEY', 'bad-key');
        const stub = fetchStub();
        stub.mockResolvedValue(jsonResponse(401, JSON.stringify({ error: { message: 'invalid key' } })));

        const result = await runAiConnectionTest({ provider: 'gemini', apiKey: '' });

        expect(result.ok).toBe(false);
        expect(result.errorKind).toBe('invalid');
        expect(result.status).toBe(401);
    });

    it('answers ok for a working OpenAI-compatible endpoint', async () => {
        const stub = fetchStub();
        stub.mockResolvedValue(jsonResponse(200, JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            model: 'deepseek-chat',
        })));

        const result = await runAiConnectionTest({
            provider: 'openai',
            apiKey: 'live-key',
            apiUrl: 'https://api.deepseek.com/v1',
            model: '',
        });

        expect(result.ok).toBe(true);
        expect(result.model).toBe('deepseek-v4-flash');
        expect(result.text).toBe('ok');
    });
});
