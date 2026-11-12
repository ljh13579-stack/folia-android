// src/mobile/androidAi/settings.ts
// 安卓端 AI 设置的本地持久化。安卓没有主进程也没有部署方的服务端：密钥与配置都存在
// 本机 localStorage（WebView 的 app 私有存储），AI 请求由应用直连 Gemini / OpenAI 兼容端点。
// 字段名与桌面端 settings 保持一致，方便与 shared/ 下的服务模块对接。

export type AndroidAiProvider = 'gemini' | 'openai';

/** 非敏感的 AI 设置（与设置表单一一对应）。 */
export interface AndroidAiSettings {
    AI_PROVIDER: AndroidAiProvider;
    OPENAI_API_URL: string;
    OPENAI_API_MODEL: string;
    OPENAI_API_TEMPERATURE: string;
    /** 安卓端忽略流式（始终非流式），仅保持表单结构一致。 */
    OPENAI_API_STREAM: boolean;
    /** 安卓端无系统代理概念，仅保持表单结构一致。 */
    USE_SYSTEM_PROXY_FOR_AI: boolean;
}

/** 密钥存储；OPENAI_API_KEY_ENDPOINT 记录 key 绑定的端点（保存 key 那一刻的 URL）。 */
export interface AndroidAiKeys {
    GEMINI_API_KEY: string;
    OPENAI_API_KEY: string;
    OPENAI_API_KEY_ENDPOINT: string | null;
}

/** 设置表单需要的「哪些 key 已保存」视图（key 本身永远不回显）。 */
export interface AndroidAiCredentials {
    AI_PROVIDER: AndroidAiProvider;
    GEMINI_API_KEY: boolean;
    OPENAI_API_KEY: boolean;
    OPENAI_API_KEY_ENDPOINT: string | null;
}

/** shared/lyricSegmentationService.mjs 需要的环境变量形态。 */
export type AndroidAiEnv = AndroidAiSettings & {
    GEMINI_API_KEY: string;
    OPENAI_API_KEY: string;
};

const SETTINGS_KEY = 'folia.mobile.ai.settings';
const KEYS_KEY = 'folia.mobile.ai.keys';

const DEFAULT_SETTINGS: AndroidAiSettings = {
    AI_PROVIDER: 'gemini',
    OPENAI_API_URL: '',
    OPENAI_API_MODEL: '',
    OPENAI_API_TEMPERATURE: '0.7',
    OPENAI_API_STREAM: false,
    USE_SYSTEM_PROXY_FOR_AI: false,
};

const DEFAULT_KEYS: AndroidAiKeys = {
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENAI_API_KEY_ENDPOINT: null,
};

// —— 内置默认密钥（测试分发用）——
// 发给测试者的包可以内置一把密钥，免去每人注册配置的麻烦；用户在设置里保存自己的
// 密钥后内置密钥自动失效。注意：APK 可被反编译提取密钥，只能配免费额度模型
// （如智谱 GLM-4-Flash），并作好被平台限流/禁用后随时换 key 的准备。
// apiKey 留空 = 无内置密钥，一切走用户自己保存的配置。
export const builtInOpenAiConfig = {
    apiKey: '136c598ad4df4135bbb6750535e77def.6fpC2oRbnZ8ssQ90',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
};

export const hasBuiltInOpenAiKey = (): boolean => builtInOpenAiConfig.apiKey.trim().length > 0;

/** 内置密钥兜底后的有效 OpenAI 兼容配置：用户自己保存的优先。 */
const resolveOpenAiCompat = (settings: AndroidAiSettings, savedKey: string): { url: string; model: string; key: string } => ({
    url: settings.OPENAI_API_URL.trim() || (hasBuiltInOpenAiKey() ? builtInOpenAiConfig.apiUrl : ''),
    model: settings.OPENAI_API_MODEL.trim() || (hasBuiltInOpenAiKey() ? builtInOpenAiConfig.model : ''),
    key: savedKey.trim() || (hasBuiltInOpenAiKey() ? builtInOpenAiConfig.apiKey : ''),
});

const readJson = <T>(key: string, fallback: T): T => {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) {
            return { ...fallback };
        }
        const parsed = JSON.parse(raw);
        return { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
        return { ...fallback };
    }
};

const writeJson = (key: string, value: unknown): void => {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // 存储满或被禁用时静默失败：AI 功能退回「未配置」，不拖垮设置面板。
    }
};

export const loadAndroidAiSettings = (): AndroidAiSettings => readJson(SETTINGS_KEY, DEFAULT_SETTINGS);

export const saveAndroidAiSettings = (patch: Partial<AndroidAiSettings>): AndroidAiSettings => {
    const next = { ...loadAndroidAiSettings(), ...patch };
    const typed: AndroidAiSettings = {
        ...next,
        AI_PROVIDER: next.AI_PROVIDER === 'openai' ? 'openai' : 'gemini',
    };
    writeJson(SETTINGS_KEY, typed);
    return typed;
};

const loadAndroidAiKeys = (): AndroidAiKeys => readJson(KEYS_KEY, DEFAULT_KEYS);

export const saveAndroidAiKey = (
    name: 'GEMINI_API_KEY' | 'OPENAI_API_KEY',
    value: string,
    openaiUrlAtSave?: string,
): AndroidAiCredentials => {
    const keys = loadAndroidAiKeys();
    keys[name] = value;
    if (name === 'OPENAI_API_KEY') {
        // 与桌面端一致：新 key 绑定到保存那一刻的端点，用于跨端点提示。
        keys.OPENAI_API_KEY_ENDPOINT = (openaiUrlAtSave ?? '').trim() || null;
    }
    writeJson(KEYS_KEY, keys);
    return getAndroidAiCredentials();
};

export const clearAndroidAiKey = (name: 'GEMINI_API_KEY' | 'OPENAI_API_KEY'): AndroidAiCredentials => {
    const keys = loadAndroidAiKeys();
    keys[name] = '';
    if (name === 'OPENAI_API_KEY') {
        keys.OPENAI_API_KEY_ENDPOINT = null;
    }
    writeJson(KEYS_KEY, keys);
    return getAndroidAiCredentials();
};

export const getAndroidAiCredentials = (): AndroidAiCredentials => {
    const settings = loadAndroidAiSettings();
    const keys = loadAndroidAiKeys();
    const openai = resolveOpenAiCompat(settings, keys.OPENAI_API_KEY);
    return {
        AI_PROVIDER: settings.AI_PROVIDER,
        GEMINI_API_KEY: keys.GEMINI_API_KEY.trim().length > 0,
        OPENAI_API_KEY: openai.key.trim().length > 0,
        OPENAI_API_KEY_ENDPOINT: keys.OPENAI_API_KEY_ENDPOINT,
    };
};

/** AI 请求真正用的完整环境：设置 + 明文密钥（内置密钥兜底），只在本文件与 client.ts 之间传递。 */
export const loadAndroidAiEnv = (): AndroidAiEnv => {
    const settings = loadAndroidAiSettings();
    const keys = loadAndroidAiKeys();
    const openai = resolveOpenAiCompat(settings, keys.OPENAI_API_KEY);
    return {
        ...settings,
        OPENAI_API_URL: openai.url,
        OPENAI_API_MODEL: openai.model,
        OPENAI_API_KEY: openai.key,
        GEMINI_API_KEY: keys.GEMINI_API_KEY,
    };
};
