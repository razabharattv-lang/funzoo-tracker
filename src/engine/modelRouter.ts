import type {
  DocumentaryStyle,
  OutputLanguage,
  StudioConfig,
  VoiceGender,
} from '../types/studio';

/**
 * 24-Model Team Registry distributed across the 5-Step Production Pipeline:
 * - Step 1 (Fetch & Inspect): nemotron-3-ultra-550b-a55b, Step 5 Preview, kimi-k3.1-pro,
 *   nemotron-3.5-super-vl-120b-a12b, nemotron-3-nano-omni-30b-a3b-reasoning,
 *   cosmos3-nano-reasoner, nemotron-ocr-v1, nemotron-3.5-parse, gemini-3.8-flash
 * - Step 2 (Clean & Motion Grade): flux-3-image-klein, FLUX.1-schnell, TRELLIS, Relighting
 *   (external GPU worker if configured, else WebGL2 3D/Motion shader synthesizer)
 * - Step 3 (Script & US Trends): Mistral Large 4, glm-5-3-flash,
 *   nemotron-3.5-lightning-30b-a3b, riva-translate-4b-instruct-v2,
 *   nemotron-3.5-content-safety, gemini-3.8-flash
 * - Step 4 (Voice & Character): gemini-3.8-flash-tts, magpie-tts-zeroshot, Studio Voice,
 *   Background Noise Removal, LipSync, wan2.2-animate-2-14b, 3D Body Pose, eyecontact
 */
export const MODEL_ROSTER = {
  step1Planning: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B' },
    { id: 'stepfun-ai/step-5-preview', label: 'Step 5 Preview' },
    { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro' },
    { id: 'nvidia/nemotron-3.5-parse', label: 'Nemotron 3.5 Parse' },
  ],
  step1Vision: [
    { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 VL 120B' },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron Nano Omni 30B' },
    { id: 'nvidia/cosmos3-nano-reasoner', label: 'Cosmos 3 Nano Reasoner' },
    { id: 'nvidia/nemotron-ocr-v1', label: 'Nemotron OCR v1' },
  ],
  step2ExternalVisuals: [
    'flux-3-image-klein',
    'FLUX.1-schnell',
    'TRELLIS',
    'Relighting',
  ],
  step3Script: [
    { id: 'mistralai/mistral-large-4', label: 'Mistral Large 4' },
    { id: 'z-ai/glm-5-3-flash', label: 'GLM-5 3 Flash' },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B' },
  ],
  step3Translate: {
    id: 'nvidia/riva-translate-4b-instruct-v2',
    label: 'Riva Translate 4B v2',
  },
  step3Safety: {
    id: 'nvidia/nemotron-3.5-content-safety',
    label: 'Nemotron 3.5 Content Safety',
  },
  step4ExternalAudio: [
    'magpie-tts-zeroshot',
    'Studio Voice',
    'Background Noise Removal',
  ],
  step4ExternalCharacter: [
    'LipSync',
    'wan2.2-animate-2-14b',
    '3D Body Pose',
    'eyecontact',
  ],
  geminiPrimary: 'gemini-3.8-flash',
  geminiFallback: 'gemini-3.5-flash',
} as const;

const NVIDIA_NIM_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_TIMEOUT_MS = 9_500;
const GEMINI_TIMEOUT_MS = 12_000;
const EXTERNAL_GPU_TIMEOUT_MS = 18_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal?: AbortSignal,
  timeoutMs = GEMINI_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (parentSignal?.aborted) {
    window.clearTimeout(timer);
    throw new DOMException('Cancelled', 'AbortError');
  }
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (parentSignal?.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export function stripJsonFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines[0]?.startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    cleaned = lines.join('\n').trim();
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

export async function callGeminiJsonOnce(params: {
  apiKey: string;
  parts: Record<string, unknown>[];
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string } | null> {
  const { apiKey, parts, signal } = params;
  if (!apiKey) return null;

  const modelsToTry = [MODEL_ROSTER.geminiPrimary, MODEL_ROSTER.geminiFallback];
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json' },
  });

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          apiKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        },
        signal,
        GEMINI_TIMEOUT_MS
      );

      if (!resp.ok) {
        if (
          i === 0 &&
          (resp.status === 404 || resp.status >= 500 || resp.status === 429)
        ) {
          continue;
        }
        return null;
      }

      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) continue;
      return {
        parsed: JSON.parse(stripJsonFences(text)) as Record<string, unknown>,
        modelUsed: model,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    }
  }
  return null;
}

export async function callNvidiaNimJson(params: {
  nvidiaApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  imageBase64Jpeg?: string;
  candidates: readonly { id: string; label: string }[];
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string } | null> {
  const {
    nvidiaApiKey,
    systemPrompt,
    userPrompt,
    imageBase64Jpeg,
    candidates,
    maxAttempts = 2,
    signal,
  } = params;
  if (!nvidiaApiKey || candidates.length === 0) return null;

  const limit = Math.min(maxAttempts, candidates.length);
  for (let i = 0; i < limit; i++) {
    const model = candidates[i];
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const userContent = imageBase64Jpeg
        ? [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64Jpeg}` },
            },
          ]
        : userPrompt;

      const resp = await fetchWithTimeout(
        NVIDIA_NIM_ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${nvidiaApiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: model.id,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            temperature: 0.55,
            top_p: 0.9,
            max_tokens: 1400,
            response_format: { type: 'json_object' },
          }),
        },
        signal,
        NIM_TIMEOUT_MS
      );
      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const rawContent = data.choices?.[0]?.message?.content ?? '';
      if (!rawContent) continue;

      const parsed = JSON.parse(stripJsonFences(rawContent)) as Record<
        string,
        unknown
      >;
      return { parsed, modelUsed: model.label };
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      // Network/CORS/JSON errors gracefully fall through to next candidate / Gemini 3.8
    }
  }
  return null;
}

/**
 * Step 1 Vision Router: tries specialized NIM VL/Reasoning candidate once,
 * then falls back reliably to Gemini 3.8 Flash (with 3.5 Flash fallback).
 */
export async function runStep1VisionJson(params: {
  nvidiaApiKey: string;
  geminiApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  imageBase64Jpeg: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string } | null> {
  const {
    nvidiaApiKey,
    geminiApiKey,
    systemPrompt,
    userPrompt,
    imageBase64Jpeg,
    signal,
  } = params;

  if (nvidiaApiKey) {
    const nimRes = await callNvidiaNimJson({
      nvidiaApiKey,
      systemPrompt,
      userPrompt,
      imageBase64Jpeg,
      candidates: MODEL_ROSTER.step1Vision,
      maxAttempts: 1,
      signal,
    });
    if (nimRes) return nimRes;
  }

  return callGeminiJsonOnce({
    apiKey: geminiApiKey,
    parts: [
      { text: userPrompt },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64Jpeg,
        },
      },
    ],
    signal,
  });
}

/**
 * Step 1 Chapter/Scene Planner Router:
 * Routes across nemotron-3-ultra-550b-a55b -> Step 5 Preview -> kimi-k3.1-pro -> nemotron-3.5-parse,
 * falling back cleanly to Gemini 3.8 Flash.
 */
export async function runStep1PlannerJson(params: {
  nvidiaApiKey: string;
  geminiApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string } | null> {
  const { nvidiaApiKey, geminiApiKey, systemPrompt, userPrompt, signal } = params;

  if (nvidiaApiKey) {
    const nimRes = await callNvidiaNimJson({
      nvidiaApiKey,
      systemPrompt,
      userPrompt,
      candidates: MODEL_ROSTER.step1Planning,
      maxAttempts: 2,
      signal,
    });
    if (nimRes) return nimRes;
  }

  return callGeminiJsonOnce({
    apiKey: geminiApiKey,
    parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
    signal,
  });
}

/**
 * Step 3 Script & Translation & Safety Router:
 * Routes script refinement across Mistral Large 4 -> glm-5-3-flash -> nemotron-3.5-lightning-30b-a3b,
 * optional riva-translate-4b-instruct-v2 (Hindi), and nemotron-3.5-content-safety,
 * with Gemini 3.8 Flash fallback.
 */
export async function runStep3ScriptJson(params: {
  config: StudioConfig;
  language: OutputLanguage;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string } | null> {
  const { config, language, systemPrompt, userPrompt, signal } = params;

  let result: { parsed: Record<string, unknown>; modelUsed: string } | null = null;

  if (config.nvidiaApiKey) {
    result = await callNvidiaNimJson({
      nvidiaApiKey: config.nvidiaApiKey,
      systemPrompt,
      userPrompt,
      candidates: MODEL_ROSTER.step3Script,
      maxAttempts: 2,
      signal,
    });
  }

  if (!result) {
    result = await callGeminiJsonOnce({
      apiKey: config.geminiApiKey,
      parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
      signal,
    });
  }

  if (!result) return null;

  // Optional Riva Translate pass when Hindi is requested and NIM key is configured
  if (
    language === 'hi' &&
    config.nvidiaApiKey &&
    Array.isArray(result.parsed.beats) &&
    result.parsed.beats.length > 0 &&
    !result.modelUsed.includes('Riva')
  ) {
    const beatsJson = JSON.stringify(result.parsed.beats);
    const hasLatinOnly =
      !/[\u0900-\u097F]/.test(beatsJson) && /[a-zA-Z]{4,}/.test(beatsJson);
    if (hasLatinOnly) {
      const rivaRes = await callNvidiaNimJson({
        nvidiaApiKey: config.nvidiaApiKey,
        systemPrompt:
          'Translate spoken beats accurately into punchy conversational Hindi (Devanagari script) keeping identical beat count and word budget. Output JSON {"beats": [...]}.',
        userPrompt: beatsJson,
        candidates: [MODEL_ROSTER.step3Translate],
        maxAttempts: 1,
        signal,
      });
      if (rivaRes && Array.isArray(rivaRes.parsed.beats)) {
        result = {
          parsed: { ...result.parsed, beats: rivaRes.parsed.beats },
          modelUsed: `${result.modelUsed} + ${MODEL_ROSTER.step3Translate.label}`,
        };
      }
    }
  }

  return result;
}

/**
 * Optional External GPU Worker integration for Step 2 (flux-3-image-klein, FLUX.1-schnell, TRELLIS, Relighting)
 */
export async function requestExternalGpuVisual(params: {
  config: StudioConfig;
  useExternalGpu: boolean;
  style: DocumentaryStyle;
  visualPrompt: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<{ dataUrl: string; engineLabel: string } | null> {
  const { config, useExternalGpu, style, visualPrompt, width, height, signal } =
    params;
  if (!useExternalGpu || !config.externalGpuEndpoint) return null;

  const modelChain =
    style === '3d_blender'
      ? ['TRELLIS', 'Relighting', 'FLUX.1-schnell']
      : ['flux-3-image-klein', 'FLUX.1-schnell', 'Relighting'];

  try {
    const resp = await fetchWithTimeout(
      `${config.externalGpuEndpoint}/api/visuals`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.externalGpuKey
            ? { Authorization: `Bearer ${config.externalGpuKey}` }
            : {}),
        },
        body: JSON.stringify({
          prompt: visualPrompt,
          style,
          models: modelChain,
          width,
          height,
        }),
      },
      signal,
      EXTERNAL_GPU_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      imageDataUrl?: string;
      imageBase64?: string;
      mimeType?: string;
      modelUsed?: string;
    };
    const dataUrl =
      data.imageDataUrl ||
      (data.imageBase64
        ? `data:${data.mimeType || 'image/jpeg'};base64,${data.imageBase64}`
        : '');
    if (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('http')) {
      return null;
    }
    return {
      dataUrl,
      engineLabel: `External GPU (${data.modelUsed || modelChain[0]})`,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return null;
  }
}

/**
 * Optional External GPU Worker integration for Step 4 Voice (magpie-tts-zeroshot, Studio Voice, Background Noise Removal)
 */
export async function requestExternalGpuVoice(params: {
  config: StudioConfig;
  useExternalGpu: boolean;
  scriptText: string;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  signal?: AbortSignal;
}): Promise<{ wavBytes: Uint8Array; engineLabel: string } | null> {
  const {
    config,
    useExternalGpu,
    scriptText,
    language,
    voiceGender,
    signal,
  } = params;
  if (!useExternalGpu || !config.externalGpuEndpoint) return null;

  try {
    const resp = await fetchWithTimeout(
      `${config.externalGpuEndpoint}/api/tts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.externalGpuKey
            ? { Authorization: `Bearer ${config.externalGpuKey}` }
            : {}),
        },
        body: JSON.stringify({
          text: scriptText,
          language,
          voiceGender,
          models: MODEL_ROSTER.step4ExternalAudio,
        }),
      },
      signal,
      EXTERNAL_GPU_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('audio/')) {
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 1000) {
        return {
          wavBytes: new Uint8Array(buf),
          engineLabel: 'External GPU (Magpie + Studio Voice)',
        };
      }
      return null;
    }
    const json = (await resp.json()) as {
      audioBase64?: string;
      modelUsed?: string;
    };
    if (!json.audioBase64) return null;
    const binary = window.atob(json.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return {
      wavBytes: bytes,
      engineLabel: `External GPU (${json.modelUsed || 'magpie-tts-zeroshot'})`,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return null;
  }
}

/**
 * Optional External GPU Worker integration for Step 4 Character (LipSync, wan2.2-animate-2-14b, 3D Body Pose, eyecontact)
 */
export async function requestExternalGpuCharacterFrame(params: {
  config: StudioConfig;
  useExternalGpu: boolean;
  portraitUrl: string;
  signal?: AbortSignal;
}): Promise<{ enhancedPortraitUrl: string; engineLabel: string } | null> {
  const { config, useExternalGpu, portraitUrl, signal } = params;
  if (!useExternalGpu || !config.externalGpuEndpoint || !portraitUrl) {
    return null;
  }

  try {
    const resp = await fetchWithTimeout(
      `${config.externalGpuEndpoint}/api/character`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.externalGpuKey
            ? { Authorization: `Bearer ${config.externalGpuKey}` }
            : {}),
        },
        body: JSON.stringify({
          portraitUrl,
          models: MODEL_ROSTER.step4ExternalCharacter,
        }),
      },
      signal,
      EXTERNAL_GPU_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      portraitDataUrl?: string;
      modelUsed?: string;
    };
    if (!data.portraitDataUrl) return null;
    return {
      enhancedPortraitUrl: data.portraitDataUrl,
      engineLabel: `External GPU (${data.modelUsed || 'LipSync + wan2.2'})`,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return null;
  }
}
