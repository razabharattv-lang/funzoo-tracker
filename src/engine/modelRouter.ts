import { getBuildRuntimeEnv } from '../lib/env';
import type {
  AiEnginePreference,
  ConnectionStatusState,
  YouTubeTrendVideo,
} from '../types/studio';

export interface AiEngineOption {
  id: AiEnginePreference;
  label: string;
  provider: 'auto' | 'gemini' | 'nvidia';
  supportsVision: boolean;
  badge: string;
}

export const PIPELINE_15_WORKER_MODELS = {
  step1: [
    'nvidia/nemotron-3.5-super-vl-120b-a12b',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'nvidia/nemotron-ocr-v1',
  ],
  step2: [
    'nvidia/nemotron-3.5-parse',
    'nvidia/cosmos3-nano-reasoner',
    'nvidia/video-super-resolution-nim',
  ],
  step3: [
    'nvidia/riva-translate-4b-instruct-v2',
    'mistralai/mistral-large-4',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'nvidia/nemotron-3.5-content-safety',
  ],
  step4: [
    'gemini-3.8-flash-tts',
    'nvidia/magpie-tts-zeroshot',
    'nvidia/studio-voice',
    'nvidia/background-noise-removal',
  ],
  step5: ['z-ai/glm-5-3-flash'],
} as const;

export const NVIDIA_MODEL_ROSTER = [
  ...PIPELINE_15_WORKER_MODELS.step1,
  ...PIPELINE_15_WORKER_MODELS.step2,
  ...PIPELINE_15_WORKER_MODELS.step3,
  'nvidia/magpie-tts-zeroshot',
  'nvidia/studio-voice',
  'nvidia/background-noise-removal',
  ...PIPELINE_15_WORKER_MODELS.step5,
] as const;

export type NvidiaModelId = (typeof NVIDIA_MODEL_ROSTER)[number];

export const AI_ENGINE_OPTIONS: AiEngineOption[] = [
  {
    id: 'auto',
    label: 'Auto (Best Configured — 1 Call/Clip)',
    provider: 'auto',
    supportsVision: true,
    badge: 'AUTO',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (Vision + Direct Translation)',
    provider: 'gemini',
    supportsVision: true,
    badge: 'GEMINI',
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    label: 'Nemotron 3.5 Super VL 120B (Step 1 Vision)',
    provider: 'nvidia',
    supportsVision: true,
    badge: 'VL 120B',
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    label: 'Nemotron 3 Nano Omni 30B (Step 1 Reasoning)',
    provider: 'nvidia',
    supportsVision: true,
    badge: 'OMNI',
  },
  {
    id: 'nvidia/cosmos3-nano-reasoner',
    label: 'Cosmos 3 Nano Reasoner (Step 2 Scene Check)',
    provider: 'nvidia',
    supportsVision: true,
    badge: 'COSMOS',
  },
  {
    id: 'nvidia/riva-translate-4b-instruct-v2',
    label: 'Riva Translate 4B v2 (Step 3 Direct Translate)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'RIVA',
  },
  {
    id: 'mistralai/mistral-large-4',
    label: 'Mistral Large 4 (Step 3 Translation & SEO)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'MISTRAL',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    label: 'Nemotron 3.5 Lightning 30B (Step 3 Fast SEO)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'FAST',
  },
  {
    id: 'nvidia/nemotron-3.5-content-safety',
    label: 'Nemotron 3.5 Content Safety (Step 3 Brand-Safe)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'SAFETY',
  },
  {
    id: 'z-ai/glm-5-3-flash',
    label: 'GLM 5.3 Flash (Step 5 Timing & Sequence)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'GLM',
  },
];

export interface ServerHealthSnapshot {
  backendAvailable: boolean;
  geminiConfigured: boolean;
  nvidiaConfigured: boolean;
  youtubeConfigured: boolean;
  nvidiaStaticKeyOnly: boolean;
}

let cachedHealth: ServerHealthSnapshot | null = null;

export async function probeStudioApiHealth(
  forceRefresh = false
): Promise<ServerHealthSnapshot> {
  if (cachedHealth && !forceRefresh) return cachedHealth;
  const staticEnv = getBuildRuntimeEnv();

  try {
    const resp = await fetch('/api/health', { method: 'GET' });
    const contentType = resp.headers.get('content-type') ?? '';
    if (resp.ok && contentType.includes('application/json')) {
      const data = (await resp.json()) as {
        geminiConfigured?: boolean;
        nvidiaConfigured?: boolean;
        youtubeConfigured?: boolean;
      };
      cachedHealth = {
        backendAvailable: true,
        geminiConfigured:
          Boolean(data.geminiConfigured) || Boolean(staticEnv.geminiApiKey),
        nvidiaConfigured:
          Boolean(data.nvidiaConfigured) || Boolean(staticEnv.nvidiaApiKey),
        youtubeConfigured:
          Boolean(data.youtubeConfigured) || Boolean(staticEnv.youtubeApiKey),
        nvidiaStaticKeyOnly:
          !Boolean(data.nvidiaConfigured) && Boolean(staticEnv.nvidiaApiKey),
      };
      return cachedHealth;
    }
  } catch {
    // Static GitHub Pages deployment (no Express backend)
  }

  cachedHealth = {
    backendAvailable: false,
    geminiConfigured: Boolean(staticEnv.geminiApiKey),
    nvidiaConfigured: Boolean(staticEnv.nvidiaApiKey),
    youtubeConfigured: Boolean(staticEnv.youtubeApiKey),
    nvidiaStaticKeyOnly: Boolean(staticEnv.nvidiaApiKey),
  };
  return cachedHealth;
}

export async function probeInitialConnectionStatus(): Promise<ConnectionStatusState> {
  const health = await probeStudioApiHealth(true);
  return {
    gemini: health.geminiConfigured ? 'Connected' : 'Fallback',
    nvidia: !health.nvidiaConfigured
      ? 'Key-Missing'
      : health.backendAvailable && !health.nvidiaStaticKeyOnly
      ? 'Connected'
      : 'CORS-Blocked',
    youtube: health.youtubeConfigured ? 'Connected' : 'Fallback',
    voice: health.geminiConfigured ? 'Gemini-TTS' : 'Browser-Speech',
    backendAvailable: health.backendAvailable,
  };
}

export function isQuotaOrRateLimitStatus(status: number, message: string): boolean {
  if (status === 429) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  );
}

export function extractJsonObject<T>(rawText: string): T | null {
  const cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface SingleClipAiResult {
  rawText: string;
  modelUsed: string;
  provider: 'gemini' | 'nvidia' | 'none';
  quotaExhausted?: boolean;
  corsBlocked?: boolean;
  keyMissing?: boolean;
  errorReason?: string;
}

/**
 * STRICT 1-CALL QUOTA GUARDRAIL:
 * Makes at most ONE primary AI request per clip.
 * Never loops across multiple models and never auto-retries HTTP 429 errors.
 */
export async function runSingleClipAiRequest(params: {
  preference: AiEnginePreference;
  systemPrompt: string;
  userPrompt: string;
  imageBase64Jpeg?: string;
  signal?: AbortSignal;
}): Promise<SingleClipAiResult | null> {
  const { preference, systemPrompt, userPrompt, imageBase64Jpeg, signal } = params;
  const health = await probeStudioApiHealth();
  const staticEnv = getBuildRuntimeEnv();

  let targetModel: AiEnginePreference = preference;
  const allowCrossProviderFallback = preference === 'auto';
  if (targetModel === 'auto') {
    if (health.geminiConfigured) {
      targetModel = 'gemini-3.8-flash';
    } else if (health.nvidiaConfigured) {
      targetModel = imageBase64Jpeg
        ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
        : 'nvidia/nemotron-3.5-lightning-30b-a3b';
    } else {
      return null;
    }
  }

  // PATH A: Gemini 3.8 Flash (server `/api/gemini/json` primary, or static GitHub Pages key when backend absent; 1 call max, zero 429 retries)
  if (targetModel === 'gemini-3.8-flash') {
    if (!health.geminiConfigured) {
      return {
        rawText: '',
        modelUsed: 'gemini-3.8-flash',
        provider: 'gemini',
        keyMissing: true,
        errorReason: 'GEMINI_API_KEY not configured',
      };
    }

    if (!health.backendAvailable && staticEnv.geminiApiKey) {
      try {
        const parts: Record<string, unknown>[] = [{ text: userPrompt }];
        if (imageBase64Jpeg) {
          parts.push({
            inlineData: { mimeType: 'image/jpeg', data: imageBase64Jpeg },
          });
        }

        const callStaticGemini = (modelId: string) =>
          fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(
              staticEnv.geminiApiKey
            )}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal,
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts }],
                generationConfig: {
                  responseMimeType: 'application/json',
                },
              }),
            }
          );

        let usedStaticModel = 'gemini-4-hydrogen';
        let resp = await callStaticGemini(usedStaticModel);
        if (resp.status === 404) {
          usedStaticModel = 'gemini-3.1-flash-lite';
          resp = await callStaticGemini(usedStaticModel);
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          const quota = isQuotaOrRateLimitStatus(resp.status, errText);
          return {
            rawText: '',
            modelUsed: usedStaticModel,
            provider: 'gemini',
            quotaExhausted: quota,
            errorReason: quota
              ? 'Gemini 429 quota limit'
              : `Gemini HTTP ${resp.status}`,
          };
        }

        const data = (await resp.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const rawText =
          data.candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? '')
            .join('') ?? '';
        return {
          rawText,
          modelUsed: usedStaticModel,
          provider: 'gemini',
        };
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        return {
          rawText: '',
          modelUsed: 'gemini-4-hydrogen',
          provider: 'gemini',
          errorReason: 'Gemini network unreachable',
        };
      }
    }

    try {
      const resp = await fetch('/api/gemini/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          prompt: userPrompt,
          systemInstruction: systemPrompt,
          imageBase64Jpeg,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const quota = isQuotaOrRateLimitStatus(resp.status, errText);
        if (allowCrossProviderFallback && health.nvidiaConfigured && health.backendAvailable && !health.nvidiaStaticKeyOnly) {
          targetModel = imageBase64Jpeg
            ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
            : 'nvidia/nemotron-3.5-lightning-30b-a3b';
        } else {
          return {
            rawText: '',
            modelUsed: 'gemini-3.8-flash',
            provider: 'gemini',
            quotaExhausted: quota,
            errorReason: quota ? 'Gemini 429 quota limit' : `Gemini HTTP ${resp.status}`,
          };
        }
      } else {
        const payload = (await resp.json()) as {
          parsed?: Record<string, unknown>;
          text?: string;
          modelUsed?: string;
        };
        const rawText = payload.parsed
          ? JSON.stringify(payload.parsed)
          : payload.text ?? '';

        return {
          rawText,
          modelUsed: payload.modelUsed ?? 'gemini-3.8-flash',
          provider: 'gemini',
        };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      if (allowCrossProviderFallback && health.nvidiaConfigured && health.backendAvailable && !health.nvidiaStaticKeyOnly) {
        targetModel = imageBase64Jpeg
          ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
          : 'nvidia/nemotron-3.5-lightning-30b-a3b';
      } else {
        return {
          rawText: '',
          modelUsed: 'gemini-3.8-flash',
          provider: 'gemini',
          errorReason: 'Gemini network unreachable',
        };
      }
    }
  }

  // PATH B: Configured NVIDIA NIM model (single call, zero 429 retries)
  if (health.backendAvailable && !health.nvidiaStaticKeyOnly) {
    try {
      const resp = await fetch('/api/nvidia/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: targetModel,
          systemPrompt,
          userPrompt,
          imageBase64Jpeg,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const quota = isQuotaOrRateLimitStatus(resp.status, errText);
        return {
          rawText: '',
          modelUsed: targetModel,
          provider: 'nvidia',
          quotaExhausted: quota,
          keyMissing: resp.status === 503,
          errorReason:
            resp.status === 503
              ? 'NVIDIA_API_KEY missing on server'
              : quota
              ? 'NVIDIA NIM 429 quota limit'
              : `NVIDIA NIM HTTP ${resp.status}`,
        };
      }

      const data = (await resp.json()) as {
        parsed?: Record<string, unknown>;
        modelUsed?: string;
      };
      return {
        rawText: data.parsed ? JSON.stringify(data.parsed) : '',
        modelUsed: data.modelUsed ?? targetModel,
        provider: 'nvidia',
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      return {
        rawText: '',
        modelUsed: targetModel,
        provider: 'nvidia',
        errorReason: 'NVIDIA NIM proxy unreachable',
      };
    }
  }

  // Static GitHub Pages path when `VITE_NVIDIA_API_KEY` was injected at build time
  if (!staticEnv.nvidiaApiKey) {
    return {
      rawText: '',
      modelUsed: targetModel,
      provider: 'nvidia',
      keyMissing: true,
      errorReason: 'NVIDIA API key missing',
    };
  }

  const isVisionModel =
    targetModel === 'nvidia/nemotron-3.5-super-vl-120b-a12b' ||
    targetModel === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' ||
    targetModel === 'nvidia/cosmos3-nano-reasoner';
  const userContent: unknown =
    isVisionModel && imageBase64Jpeg
      ? [
          { type: 'text', text: userPrompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64Jpeg}` },
          },
        ]
      : userPrompt;

  try {
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staticEnv.nvidiaApiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.35,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const quota = isQuotaOrRateLimitStatus(resp.status, errText);
      return {
        rawText: '',
        modelUsed: targetModel,
        provider: 'nvidia',
        quotaExhausted: quota,
        errorReason: quota ? 'NVIDIA NIM 429 quota limit' : `NVIDIA NIM HTTP ${resp.status}`,
      };
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return {
      rawText: data.choices?.[0]?.message?.content ?? '',
      modelUsed: targetModel,
      provider: 'nvidia',
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return {
      rawText: '',
      modelUsed: targetModel,
      provider: 'nvidia',
      corsBlocked: true,
      errorReason: 'NVIDIA NIM CORS blocked in static browser',
    };
  }
}

/**
 * Queries live US YouTube Data API v3 (`regionCode=US`) via server `POST /api/youtube/trends`
 * (or build-time `VITE_YOUTUBE_API_KEY` on static GitHub Pages). Single call, zero retries.
 */
export async function fetchYouTubeTrendsFromApi(
  topicQuery: string,
  signal?: AbortSignal
): Promise<{ items: YouTubeTrendVideo[]; connected: boolean }> {
  const cleanQ = topicQuery.trim().slice(0, 70) || 'explained viral shorts';
  const health = await probeStudioApiHealth();
  const staticEnv = getBuildRuntimeEnv();

  if (health.backendAvailable) {
    try {
      const resp = await fetch('/api/youtube/trends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ queries: [cleanQ] }),
      });
      if (!resp.ok) return { items: [], connected: false };
      const data = (await resp.json()) as {
        trends?: YouTubeTrendVideo[];
        configured?: boolean;
      };
      const items = Array.isArray(data.trends) ? data.trends : [];
      return { items, connected: Boolean(data.configured) && items.length > 0 };
    } catch {
      return { items: [], connected: false };
    }
  }

  if (!staticEnv.youtubeApiKey) return { items: [], connected: false };

  try {
    // Strictly 1 single YouTube Data API v3 call (regionCode=US, videoDuration=short, order=viewCount)
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('videoDuration', 'short');
    searchUrl.searchParams.set('regionCode', 'US');
    searchUrl.searchParams.set('relevanceLanguage', 'en');
    searchUrl.searchParams.set('order', 'viewCount');
    searchUrl.searchParams.set('maxResults', '8');
    searchUrl.searchParams.set('q', cleanQ);
    searchUrl.searchParams.set('key', staticEnv.youtubeApiKey);

    const sResp = await fetch(searchUrl.toString(), { signal });
    if (!sResp.ok) return { items: [], connected: false };
    const sJson = (await sResp.json()) as {
      items?: {
        id?: { videoId?: string };
        snippet?: {
          title?: string;
          channelTitle?: string;
          publishedAt?: string;
          description?: string;
        };
      }[];
    };
    const rawItems = sJson.items ?? [];
    const stopWords = new Set([
      'the', 'and', 'for', 'this', 'that', 'with', 'from', 'your', 'about',
      'have', 'what', 'when', 'how', 'why', 'you', 'are', 'was', 'were',
      'shorts', 'short', 'video', 'viral', 'trending', 'subscribe',
    ]);

    const items: YouTubeTrendVideo[] = rawItems.map((item) => {
      const title = item.snippet?.title ?? '';
      const desc = item.snippet?.description ?? '';
      const hashTags = (title + ' ' + desc)
        .match(/#[\p{L}\p{N}_]{2,28}/gu)
        ?.map((h) => h.slice(1).toLowerCase()) ?? [];
      const titleTerms = title
        .replace(/#[\p{L}\p{N}_]+/gu, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopWords.has(w));
      const tags = [...hashTags, ...titleTerms]
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .slice(0, 10);

      return {
        title,
        channel: item.snippet?.channelTitle ?? '',
        publishedAt: item.snippet?.publishedAt ?? '',
        viewCount: 0,
        likeCount: 0,
        tags,
      };
    });
    return { items, connected: items.length > 0 };
  } catch {
    return { items: [], connected: false };
  }
}
