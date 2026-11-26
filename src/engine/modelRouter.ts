import { getBuildRuntimeEnv } from '../lib/env';
import type { AiEnginePreference, YouTubeTrendVideo } from '../types/studio';

export interface AiEngineOption {
  id: AiEnginePreference;
  label: string;
  provider: 'auto' | 'gemini' | 'nvidia';
  supportsVision: boolean;
  badge: string;
}

export const NVIDIA_MODEL_ROSTER = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'mistralai/mistral-large-4',
  'nvidia/riva-translate-4b-instruct-v2',
  'nvidia/nemotron-3.5-content-safety',
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
    label: 'NVIDIA Nemotron 3.5 Super VL 120B (Vision)',
    provider: 'nvidia',
    supportsVision: true,
    badge: 'NIM VL',
  },
  {
    id: 'nvidia/riva-translate-4b-instruct-v2',
    label: 'NVIDIA Riva Translate 4B v2 (Direct Translate)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'RIVA',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    label: 'NVIDIA Nemotron 3.5 Lightning 30B (Fast SEO)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'NIM FAST',
  },
  {
    id: 'mistralai/mistral-large-4',
    label: 'Mistral Large 4 via NVIDIA NIM (Deep Script)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'MISTRAL',
  },
  {
    id: 'nvidia/nemotron-3.5-content-safety',
    label: 'NVIDIA Nemotron 3.5 Content Safety (Brand-Safe)',
    provider: 'nvidia',
    supportsVision: false,
    badge: 'SAFETY',
  },
];

export interface ServerHealthSnapshot {
  backendAvailable: boolean;
  geminiConfigured: boolean;
  nvidiaConfigured: boolean;
  youtubeConfigured: boolean;
}

let cachedHealth: ServerHealthSnapshot | null = null;

export async function probeStudioApiHealth(): Promise<ServerHealthSnapshot> {
  if (cachedHealth) return cachedHealth;
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
        geminiConfigured: Boolean(data.geminiConfigured),
        nvidiaConfigured:
          Boolean(data.nvidiaConfigured) || Boolean(staticEnv.nvidiaApiKey),
        youtubeConfigured:
          Boolean(data.youtubeConfigured) || Boolean(staticEnv.youtubeApiKey),
      };
      return cachedHealth;
    }
  } catch {
    // Static GitHub Pages deployment (no Express backend)
  }

  cachedHealth = {
    backendAvailable: false,
    geminiConfigured: false,
    nvidiaConfigured: Boolean(staticEnv.nvidiaApiKey),
    youtubeConfigured: Boolean(staticEnv.youtubeApiKey),
  };
  return cachedHealth;
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
  quotaExhausted?: boolean;
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

  // Resolve the single target model to call (1 call max, no waterfall loop)
  let targetModel: AiEnginePreference = preference;
  if (targetModel === 'auto') {
    if (health.backendAvailable && health.geminiConfigured) {
      targetModel = 'gemini-3.8-flash';
    } else if (health.nvidiaConfigured) {
      targetModel = imageBase64Jpeg
        ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
        : 'nvidia/nemotron-3.5-lightning-30b-a3b';
    } else {
      return null;
    }
  }

  // PATH A: Gemini 3.8 Flash via server-side `/api/gemini/json` (single call, zero 429 retries)
  if (targetModel === 'gemini-3.8-flash') {
    if (!health.backendAvailable || !health.geminiConfigured) {
      return {
        rawText: '',
        modelUsed: 'gemini-3.8-flash',
        errorReason: 'Gemini backend unavailable',
      };
    }

    try {
      const resp = await fetch('/api/gemini/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          imageBase64Jpeg,
          maxOutputTokens: 1600,
          temperature: 0.4,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const quota = isQuotaOrRateLimitStatus(resp.status, errText);
        return {
          rawText: '',
          modelUsed: 'gemini-3.8-flash',
          quotaExhausted: quota,
          errorReason: quota ? 'Gemini 429 quota limit' : `Gemini HTTP ${resp.status}`,
        };
      }

      const payload = (await resp.json()) as { text?: string; model?: string };
      return {
        rawText: payload.text ?? '',
        modelUsed: payload.model ?? 'gemini-3.8-flash',
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      return {
        rawText: '',
        modelUsed: 'gemini-3.8-flash',
        errorReason: 'Gemini network unreachable',
      };
    }
  }

  // PATH B: Configured NVIDIA NIM model (single call, zero 429 retries)
  const isVisionModel = targetModel === 'nvidia/nemotron-3.5-super-vl-120b-a12b';
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

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  // Prefer server proxy `/api/nvidia/chat` when Express backend is running
  if (health.backendAvailable) {
    try {
      const resp = await fetch('/api/nvidia/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: targetModel,
          messages,
          temperature: 0.35,
          max_tokens: 1500,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const quota = isQuotaOrRateLimitStatus(resp.status, errText);
        return {
          rawText: '',
          modelUsed: targetModel,
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
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      return {
        rawText: '',
        modelUsed: targetModel,
        errorReason: 'NVIDIA NIM proxy unreachable',
      };
    }
  }

  // Static GitHub Pages fallback when `VITE_NVIDIA_API_KEY` was injected at build time
  if (!staticEnv.nvidiaApiKey) {
    return {
      rawText: '',
      modelUsed: targetModel,
      errorReason: 'NVIDIA API key not configured',
    };
  }

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
        messages,
        temperature: 0.35,
        max_tokens: 1500,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const quota = isQuotaOrRateLimitStatus(resp.status, errText);
      return {
        rawText: '',
        modelUsed: targetModel,
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
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return {
      rawText: '',
      modelUsed: targetModel,
      errorReason: 'NVIDIA NIM network/CORS blocked',
    };
  }
}

/**
 * Queries live US YouTube Data API v3 (`regionCode=US`) via server `/api/youtube/trends`
 * (or build-time `VITE_YOUTUBE_API_KEY` on static GitHub Pages). Single call, zero retries.
 */
export async function fetchYouTubeTrendsFromApi(
  topicQuery: string,
  signal?: AbortSignal
): Promise<YouTubeTrendVideo[]> {
  const cleanQ = topicQuery.trim().slice(0, 70) || 'explained viral shorts';
  const health = await probeStudioApiHealth();
  const staticEnv = getBuildRuntimeEnv();

  if (health.backendAvailable) {
    try {
      const resp = await fetch(`/api/youtube/trends?q=${encodeURIComponent(cleanQ)}`, {
        signal,
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { items?: YouTubeTrendVideo[] };
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  if (!staticEnv.youtubeApiKey) return [];

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('videoDuration', 'short');
    searchUrl.searchParams.set('regionCode', 'US');
    searchUrl.searchParams.set('relevanceLanguage', 'en');
    searchUrl.searchParams.set('order', 'viewCount');
    searchUrl.searchParams.set('maxResults', '6');
    searchUrl.searchParams.set('q', cleanQ);
    searchUrl.searchParams.set('key', staticEnv.youtubeApiKey);

    const sResp = await fetch(searchUrl.toString(), { signal });
    if (!sResp.ok) return [];
    const sJson = (await sResp.json()) as {
      items?: {
        id?: { videoId?: string };
        snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
      }[];
    };
    const items = sJson.items ?? [];
    if (items.length === 0) return [];

    return items.map((item) => ({
      title: item.snippet?.title ?? '',
      channel: item.snippet?.channelTitle ?? '',
      publishedAt: item.snippet?.publishedAt ?? '',
      viewCount: 0,
      likeCount: 0,
      tags: [],
    }));
  } catch {
    return [];
  }
}
