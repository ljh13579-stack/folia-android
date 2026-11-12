// src/mobile/androidAi/client.ts
// 安卓端 AI 客户端：应用持用户自己的密钥，直连 Gemini / OpenAI 兼容端点。
// 桌面端走主进程（electron/aiTextClient.cjs），Web 端走部署方的 serverless 函数（api-ts/），
// 安卓端没有这两者，这里按同一套输出契约（api-ts/generate-theme*.ts、shared/lyricSegmentationService.mjs）
// 在本机复刻请求拼装，传输层用 ./fetchImpl 的 CapacitorHttp 适配器。

import { sanitizeDualTheme } from '../../services/themeSanitizer';
import { detectOpenAICompatibleProvider, sendOpenAICompatibleRequest } from '../../../shared/openAICompatibleRequest.mjs';
import { segmentLyricLines } from '../../../shared/lyricSegmentationService.mjs';
import { androidAiFetch, androidAiFetchForShared } from './fetchImpl';
import { loadAndroidAiEnv, saveAndroidAiKey, type AndroidAiProvider } from './settings';
import type { DualTheme } from '../../types';

const GEMINI_THEME_MODEL = 'gemini-3-flash-preview';
const GEMINI_GENERATE_CONTENT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_THEME_MODEL}:generateContent`;
const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_OPENAI_TEMPERATURE = 0.7;
const THEME_JSON_SCHEMA_NAME = 'dual_theme';
const THEME_MAX_OUTPUT_TOKENS = 4096;

// —— Gemini 主题生成（移植自 api-ts/generate-theme.ts，走 REST 而非 SDK）——

const THEME_GENERATION_PROMPT_PREFIX = `Analyze the mood of the provided song source text and generate TWO visual theme configurations for a music player - one for LIGHT mode and one for DARK mode.

DUAL THEME REQUIREMENTS:
1. Generate TWO complete themes: one optimized for LIGHT/DAYLIGHT mode, one optimized for DARK/MIDNIGHT mode.
2. Both themes should capture the SAME emotional essence of the source text, but with appropriate color palettes for their respective modes.
3. The theme names must be in Chinese and strictly limited to 10 characters or less. They should reflect both the mood AND the mode (e.g., "忧郁破晓" for light, "忧郁子夜" for dark).
4. The theme description must be a brief, emotional sentence in Chinese (strictly limited to 15 to 30 Chinese characters) reflecting a stream-of-consciousness style with youth and literary characteristics, capturing a listener's immediate emotional reaction to this song. Do not write formal analytical text. Must be written from a first-person listener perspective.
   GUIDELINES FOR THE EXPRESSIVE STYLE:
   - Stream of Consciousness & Literary Vibe: Emphasize poetic, reflective, or introspective thoughts (e.g., emotional connection, existential thoughts, quiet solitude).
   - Youth & Nostalgia: Associate the mood with nostalgic memories of youth, dreams, seasons, or romantic longing.
   - Spatial & Situational Synesthesia: Translate the music's vibe into a vivid situation, atmosphere, weather, or imagery (e.g., summer breeze, starry sky, quiet room).
   Examples for reference: "戴上耳机的那一刻，喧嚣的世界瞬间消失了。", "然后，这份爱编织了太阳和所有星星", "你的世界，也包括我在内吗？", "微醺的夏夜吹拂过一阵海风。", "青春是一种眺望的姿态！", "仿佛回到了那个满是汽水味和单车后座的夏天。"。

SOURCE MODE:
1. If 'Pure instrumental' is yes, the source text below is the song title of a pure instrumental track, not lyrics.
2. If 'Pure instrumental' is no, the source text below is a lyrics snippet.
3. Base your mood inference only on the provided source text.

COLOR & THEME GENERATION WORKFLOW:
1. First, identify 10-20 key emotional standalone words from the source text that represent the core mood and atmosphere of the song.
2. Assign a specific, representative color to each of these key emotional standalone words under 'wordColors'.
3. Based on the emotional direction and colors of these identified words, construct the overall color palettes (backgroundColor, primaryColor, secondaryColor, accentColor) for the light and dark themes.
4. Coordinated Colors: The colors assigned in 'wordColors' must be designed in coordination and harmony with the overall color schemes of the themes.

LIGHT THEME RULES:
- Use LIGHT backgrounds. Avoid defaulting to pure white background for every light theme. Generate diverse and rich light-colored backgrounds (e.g., warm creams, soft pastel blues, pale sage greens, gentle peach, warm sands, pale lavenders) that directly match the song's mood.
- Ensure text/icons are dark enough for contrast, but avoid defaulting to pure black (#000000). Generate a very dark tone that coordinates with the background color's hue (e.g., deep navy, dark charcoal, dark plum).
- 'accentColor' must be visible against the light background.

DARK THEME RULES:
- Use DARK backgrounds. Avoid generic pure black backgrounds; use rich, diverse dark colors (e.g., deep midnight blue, dark forest green, charcoal gray, dark plum, deep chocolate, burgundy) matching the song's mood.
- Ensure text/icons are light enough for contrast, but avoid defaulting to pure white (#ffffff). Generate a very bright, soft tone that coordinates with the background color's hue (e.g., soft sky blue, pale mint green, light warm cream).
- 'accentColor' must contrast with the dark background and should be creatively derived from the song's specific mood (e.g., soft blues, mint greens, warm corals, lavender, pale gold) rather than defaulting to generic bright yellow.

SHARED RULES FOR BOTH THEMES:
1. CRITICAL for 'secondaryColor': This color is used for secondary TEXT (e.g., album name, artist name).
   - It MUST have sufficient contrast against 'backgroundColor' to be easily readable.
   - Aim for a contrast ratio of at least 4.5:1 for accessibility.
2. 'wordColors' and 'lyricsIcons' should be the SAME for both themes (they represent the source text's meaning).

IMPORTANT for 'wordColors':
1. Extract 10-20 emotional standalone words. For Latin-script text, each 'word' MUST be one complete word only, not a phrase.
2. CRITICAL: Do NOT include punctuation, apostrophes, curly quotes, hyphens, or spaces in Latin-script 'word' values. Use clean whole words like "train", "gone", "hidden", "cities"; do NOT return "train’s gone", "well-hidden", "set me free", or "shun the light".
3. Avoid function words such as articles, prepositions, pronouns, particles, and auxiliaries (for example: the, a, an, to, me, and, of, in, on).
4. For CJK lyrics, short meaningful semantic terms may contain multiple CJK characters, but do not select single particles unless they are emotionally meaningful.
5. The 'word' field MUST match text from the source snippet after removing surrounding punctuation. If the pure-instrumental title is very short, using the exact full title as a phrase is allowed.

IMPORTANT for 'lyricsIcons':
1. Identify 3-5 visual concepts/objects mentioned in or strongly implied by the source text.
2. Return them as valid Lucide React icon names (PascalCase, e.g., 'CloudLightning', 'HeartHandshake').

OUTPUT CONTRACT:
Return one JSON object with required "light" and "dark" objects. Each theme object requires "name", "backgroundColor", "primaryColor", "accentColor", "secondaryColor", "wordColors", and "lyricsIcons".`;

const GEMINI_THEME_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        light: {
            type: 'OBJECT',
            description: 'Theme optimized for light/daylight mode',
            properties: {
                name: { type: 'STRING', description: 'A creative name for this light theme in Chinese, strictly limited to 10 characters or less' },
                description: { type: 'STRING', description: 'A creative 1-sentence description of the mood or visual concept in Chinese, strictly limited to 15 to 30 Chinese characters' },
                backgroundColor: { type: 'STRING', description: 'Hex code for light background (whites, creams, pastels)' },
                primaryColor: { type: 'STRING', description: 'Hex code for main text (dark color for contrast)' },
                accentColor: { type: 'STRING', description: 'Hex code for highlighted text/effects' },
                secondaryColor: { type: 'STRING', description: 'Hex code for secondary elements (must contrast with light bg)' },
                wordColors: {
                    type: 'ARRAY',
                    description: "List of exact emotional standalone words from the source text and their specific colors; Latin-script words must not contain punctuation or spaces",
                    items: {
                        type: 'OBJECT',
                        properties: {
                            word: { type: 'STRING' },
                            color: { type: 'STRING' },
                        },
                        required: ['word', 'color'],
                    },
                },
                lyricsIcons: {
                    type: 'ARRAY',
                    description: 'List of Lucide icon names related to the source text',
                    items: { type: 'STRING' },
                },
            },
            required: ['name', 'backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor'],
        },
        dark: {
            type: 'OBJECT',
            description: 'Theme optimized for dark/midnight mode',
            properties: {
                name: { type: 'STRING', description: 'A creative name for this dark theme in Chinese, strictly limited to 10 characters or less' },
                description: { type: 'STRING', description: 'A creative 1-sentence description of the mood or visual concept in Chinese, strictly limited to 15 to 30 Chinese characters' },
                backgroundColor: { type: 'STRING', description: 'Hex code for dark background (deep colors)' },
                primaryColor: { type: 'STRING', description: 'Hex code for main text (light color for contrast)' },
                accentColor: { type: 'STRING', description: 'Hex code for highlighted text/effects' },
                secondaryColor: { type: 'STRING', description: 'Hex code for secondary elements (must contrast with dark bg)' },
                wordColors: {
                    type: 'ARRAY',
                    description: "List of exact emotional standalone words from the source text and their specific colors; Latin-script words must not contain punctuation or spaces",
                    items: {
                        type: 'OBJECT',
                        properties: {
                            word: { type: 'STRING' },
                            color: { type: 'STRING' },
                        },
                        required: ['word', 'color'],
                    },
                },
                lyricsIcons: {
                    type: 'ARRAY',
                    description: 'List of Lucide icon names related to the source text',
                    items: { type: 'STRING' },
                },
            },
            required: ['name', 'backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor'],
        },
    },
    required: ['light', 'dark'],
};

const buildThemeSourcePrompt = (snippet: string, isPureMusic: boolean, songTitle?: string): string => `Pure instrumental: ${isPureMusic ? 'yes' : 'no'}
${isPureMusic && songTitle ? `Song title: ${songTitle}\n` : ''}Source snippet:
${snippet}`;

// —— OpenAI 兼容主题生成（移植自 api-ts/generate-theme_openai.ts）——

const THEME_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        light: {
            type: 'object',
            additionalProperties: false,
            description: 'Theme optimized for light/daylight mode',
            properties: {
                name: { type: 'string', description: 'A creative name for this light theme in Chinese, strictly limited to 10 characters or less' },
                description: { type: 'string', description: 'A creative 1-sentence description of the mood or visual concept in Chinese, strictly limited to 15 to 30 Chinese characters' },
                backgroundColor: { type: 'string', description: 'Hex code for light background' },
                primaryColor: { type: 'string', description: 'Hex code for main text (dark)' },
                accentColor: { type: 'string', description: 'Hex code for highlighted text/effects' },
                secondaryColor: { type: 'string', description: 'Hex code for secondary elements' },
                wordColors: {
                    type: 'array',
                    description: 'List of exact emotional standalone words from the source text and their specific colors; Latin-script words must not contain punctuation or spaces',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            word: { type: 'string' },
                            color: { type: 'string' },
                        },
                        required: ['word', 'color'],
                    },
                },
                lyricsIcons: {
                    type: 'array',
                    description: 'List of Lucide icon names related to the source text',
                    items: { type: 'string' },
                },
            },
            required: ['name', 'description', 'backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor', 'wordColors', 'lyricsIcons'],
        },
        dark: {
            type: 'object',
            additionalProperties: false,
            description: 'Theme optimized for dark/midnight mode',
            properties: {
                name: { type: 'string', description: 'A creative name for this dark theme in Chinese, strictly limited to 10 characters or less' },
                description: { type: 'string', description: 'A creative 1-sentence description of the mood or visual concept in Chinese, strictly limited to 15 to 30 Chinese characters' },
                backgroundColor: { type: 'string', description: 'Hex code for dark background' },
                primaryColor: { type: 'string', description: 'Hex code for main text (light)' },
                accentColor: { type: 'string', description: 'Hex code for highlighted text/effects' },
                secondaryColor: { type: 'string', description: 'Hex code for secondary elements' },
                wordColors: {
                    type: 'array',
                    description: 'List of exact emotional standalone words from the source text and their specific colors; Latin-script words must not contain punctuation or spaces',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            word: { type: 'string' },
                            color: { type: 'string' },
                        },
                        required: ['word', 'color'],
                    },
                },
                lyricsIcons: {
                    type: 'array',
                    description: 'List of Lucide icon names related to the source text',
                    items: { type: 'string' },
                },
            },
            required: ['name', 'description', 'backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor', 'wordColors', 'lyricsIcons'],
        },
    },
    required: ['light', 'dark'],
} as const;

type OpenAiCompatibleEndpointProvider = 'openai' | 'deepseek' | 'generic';

const normalizeOpenAIChatCompletionsUrl = (rawUrl?: string): string => {
    const trimmedUrl = rawUrl?.trim();
    if (!trimmedUrl) {
        return DEFAULT_OPENAI_CHAT_COMPLETIONS_URL;
    }
    try {
        const parsed = new URL(trimmedUrl);
        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        if (!normalizedPath || normalizedPath === '/') {
            parsed.pathname = '/v1/chat/completions';
            return parsed.toString();
        }
        if (/\/v\d+$/.test(normalizedPath)) {
            parsed.pathname = `${normalizedPath}/chat/completions`;
            return parsed.toString();
        }
        parsed.pathname = normalizedPath;
        return parsed.toString();
    } catch {
        return trimmedUrl.replace(/\/+$/, '');
    }
};

const resolveOpenAICompatibleModel = (apiUrl: string, configuredModel?: string): string => {
    const trimmedModel = configuredModel?.trim();
    if (trimmedModel) {
        return trimmedModel;
    }
    return detectOpenAICompatibleProvider(apiUrl) === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : DEFAULT_OPENAI_MODEL;
};

const buildThemeSystemPrompt = (): string => {
    // OpenAI 版的 system prompt 与 Gemini 版相同，只是结尾不带 OUTPUT CONTRACT 段
    // （schema 以原始 JSON 文本形式附在后面），api-ts 两处 prompt 的差异在此保留。
    const instructionPrompt = THEME_GENERATION_PROMPT_PREFIX.replace(/\n*OUTPUT CONTRACT:[\s\S]*$/, '');
    // OpenAI 版把 OUTPUT CONTRACT 换成原始 schema 文本（api-ts 两处 prompt 的差异在此保留）。
    return `${instructionPrompt}

Response MUST be a valid JSON object. Do not include markdown formatting like \`\`\`json. Just the raw JSON.

JSON Schema:
${JSON.stringify(THEME_JSON_SCHEMA, null, 2)}`;
};

const buildOpenAICompatibleRequestBody = (
    model: string,
    provider: OpenAiCompatibleEndpointProvider,
    systemPrompt: string,
    sourcePrompt: string,
    temperature: number,
): Record<string, unknown> => {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sourcePrompt },
    ];
    if (provider === 'openai') {
        return {
            model,
            messages,
            temperature,
            max_completion_tokens: THEME_MAX_OUTPUT_TOKENS,
            response_format: {
                type: 'json_schema',
                json_schema: { name: THEME_JSON_SCHEMA_NAME, strict: true, schema: THEME_JSON_SCHEMA },
            },
        };
    }
    return {
        model,
        messages,
        temperature,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
    };
};

const extractResponseContentText = (message: { content?: unknown; refusal?: unknown } | undefined): string | null => {
    if (!message) {
        return null;
    }
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new Error(`Model refused request: ${message.refusal}`);
    }
    if (typeof message.content === 'string') {
        return message.content;
    }
    if (Array.isArray(message.content)) {
        const text = message.content
            .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === 'object')
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('');
        return text || null;
    }
    return null;
};

const extractProviderErrorMessage = (payload: unknown): string | null => {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') {
            return message;
        }
    }
    const message = (payload as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
};

const formatOpenAICompatibleError = async (response: { status: number; statusText: string; text(): Promise<string> }): Promise<string> => {
    const rawText = await response.text();
    let detail = rawText.trim();
    try {
        detail = extractProviderErrorMessage(JSON.parse(rawText)) || detail;
    } catch {
        // 非 JSON 响应原样展示。
    }
    return detail
        ? `OpenAI compatible API error (${response.status}): ${detail}`
        : `OpenAI compatible API error (${response.status}): ${response.statusText || 'request failed'}`;
};

const parseThemeJson = (rawText: string): DualTheme => {
    let jsonStr = rawText.trim();
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
    }
    return sanitizeDualTheme(JSON.parse(jsonStr));
};

const resolveTemperature = (raw: string): number => {
    const value = Number.parseFloat(String(raw ?? '').trim());
    return Number.isFinite(value) && value >= 0 && value <= 2 ? value : DEFAULT_OPENAI_TEMPERATURE;
};

// —— 对外接口 ——

export const generateAndroidTheme = async (
    lyricsText: string,
    options?: { isPureMusic?: boolean; songTitle?: string },
): Promise<DualTheme> => {
    const env = loadAndroidAiEnv();
    const snippet = lyricsText.slice(0, 2000);
    const sourcePrompt = buildThemeSourcePrompt(snippet, options?.isPureMusic === true, options?.songTitle);
    let dualTheme: DualTheme;

    if (env.AI_PROVIDER === 'openai') {
        const apiKey = env.OPENAI_API_KEY.trim();
        if (!apiKey) {
            throw new Error('OpenAI API key is not configured');
        }
        const apiUrl = normalizeOpenAIChatCompletionsUrl(env.OPENAI_API_URL);
        const provider = detectOpenAICompatibleProvider(apiUrl) as OpenAiCompatibleEndpointProvider;
        const model = resolveOpenAICompatibleModel(apiUrl, env.OPENAI_API_MODEL);
        const response = await sendOpenAICompatibleRequest({
            apiUrl,
            provider,
            body: buildOpenAICompatibleRequestBody(model, provider, buildThemeSystemPrompt(), sourcePrompt, resolveTemperature(env.OPENAI_API_TEMPERATURE)),
            init: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
            },
            fetchImpl: androidAiFetchForShared,
        });
        if (!response.ok) {
            throw new Error(await formatOpenAICompatibleError(response));
        }
        const data = await response.json();
        const content = extractResponseContentText((data as { choices?: { message?: unknown }[] }).choices?.[0]?.message as never);
        if (!content) {
            throw new Error('Failed to generate theme JSON');
        }
        dualTheme = parseThemeJson(content);
        dualTheme.light.provider = 'OpenAI Compatible';
        dualTheme.dark.provider = 'OpenAI Compatible';
    } else {
        const apiKey = env.GEMINI_API_KEY.trim();
        if (!apiKey) {
            throw new Error('Gemini API key is not configured');
        }
        const response = await androidAiFetch(GEMINI_GENERATE_CONTENT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: THEME_GENERATION_PROMPT_PREFIX }] },
                contents: [{ role: 'user', parts: [{ text: sourcePrompt }] }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: GEMINI_THEME_RESPONSE_SCHEMA,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(`Gemini API error (${response.status}): ${(await response.text()).slice(0, 500)}`);
        }
        const data = await response.json();
        const parts = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts) ? parts.map(part => part?.text ?? '').join('') : '';
        if (!text.trim()) {
            throw new Error('Failed to generate theme JSON');
        }
        dualTheme = parseThemeJson(text);
        dualTheme.light.provider = 'Google Gemini';
        dualTheme.dark.provider = 'Google Gemini';
    }

    dualTheme.light.fontStyle = 'sans';
    dualTheme.dark.fontStyle = 'sans';
    return dualTheme;
};

/** 复用 shared 分词服务：prompt 阶梯、schema、参数降级重试全在 shared 里，只换传输层。 */
export const segmentLyricsOnAndroid = async (lines: string[]): Promise<unknown> => {
    const env = loadAndroidAiEnv();
    return segmentLyricLines(lines, env, androidAiFetchForShared);
};

const geminiTest = async (apiKey: string, startedAt: number): Promise<AiConnectionTestResult> => {
    const response = await androidAiFetch(GEMINI_GENERATE_CONTENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
            generationConfig: { maxOutputTokens: 16 },
        }),
    });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            durationMs,
            error: `Gemini API error (${response.status}): ${(await response.text()).slice(0, 300)}`,
            errorKind: response.status === 401 || response.status === 403 ? 'invalid' : 'http',
        };
    }
    const data = await response.json();
    const parts = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map(part => part?.text ?? '').join('').trim() : '';
    return { ok: true, status: response.status, durationMs, model: GEMINI_THEME_MODEL, text };
};

const openAiCompatibleTest = async (
    apiKey: string,
    apiUrlRaw: string | undefined,
    modelRaw: string | undefined,
    startedAt: number,
): Promise<AiConnectionTestResult> => {
    const apiUrl = normalizeOpenAIChatCompletionsUrl(apiUrlRaw);
    const provider = detectOpenAICompatibleProvider(apiUrl) as OpenAiCompatibleEndpointProvider;
    const model = resolveOpenAICompatibleModel(apiUrl, modelRaw);
    const response = await sendOpenAICompatibleRequest({
        apiUrl,
        provider,
        body: {
            model,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            max_tokens: 16,
        },
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        },
        fetchImpl: androidAiFetchForShared,
    });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            durationMs,
            error: await formatOpenAICompatibleError(response),
            errorKind: response.status === 401 || response.status === 403 ? 'invalid' : 'http',
        };
    }
    const data = await response.json();
    const text = extractResponseContentText((data as { choices?: { message?: unknown }[] }).choices?.[0]?.message as never)?.trim() ?? '';
    return { ok: true, status: response.status, durationMs, model, text };
};

export const testAndroidAiConnection = async (payload: AiConnectionTestPayload): Promise<AiConnectionTestResult> => {
    const env = loadAndroidAiEnv();
    const startedAt = Date.now();
    const provider: AndroidAiProvider = payload.provider === 'openai' ? 'openai' : 'gemini';
    // 表单里空 key = 测已保存的 key（与桌面端一致）。
    const apiKey = (payload.apiKey ?? '').trim() || (provider === 'openai' ? env.OPENAI_API_KEY : env.GEMINI_API_KEY).trim();
    if (!apiKey) {
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            error: provider === 'openai' ? 'OPENAI_API_KEY is not configured' : 'GEMINI_API_KEY is not configured',
            errorKind: 'config',
        };
    }
    // 测试前把表单里刚填的 key 暂存为「已保存」，连接测试与保存共用一份读取逻辑。
    if ((payload.apiKey ?? '').trim()) {
        saveAndroidAiKey(provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY', payload.apiKey.trim(), payload.apiUrl);
    }
    try {
        return provider === 'openai'
            ? await openAiCompatibleTest(apiKey, payload.apiUrl, payload.model, startedAt)
            : await geminiTest(apiKey, startedAt);
    } catch (error) {
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            errorKind: 'network',
        };
    }
};
