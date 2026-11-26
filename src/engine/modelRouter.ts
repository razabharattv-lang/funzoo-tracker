import type {
  DocumentaryStyle,
  OutputLanguage,
  StudioConfig,
  VoiceGender,
} from '../types/studio';

/**
 * Multi-Model Studio Router:
 * - Server-side Gemini endpoints (`/api/gemini/*`) execute all Gemini Vision, JSON planning,
 *   TTS voiceover, and face-locked outfit editing safely on the backend server.
 * - Optional NVIDIA NIM endpoints and optional External GPU endpoints run when configured.
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
} as const;

const NVIDIA_NIM_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_TIMEOUT_MS = 9_500;
const SERVER_GEMINI_TIMEOUT_MS = 35_000;
const EXTERNAL_GPU_TIMEOUT_MS = 18_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal?: AbortSignal,
  timeoutMs = SERVER_GEMINI_TIMEOUT_MS
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

const DIRECT_GEMINI_JSON_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

async function callDirectGeminiJsonFallback(params: {
  apiKey: string;
  prompt: string;
  systemInstruction?: string;
  imageBase64Jpeg?: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string }> {
  const { apiKey, prompt, systemInstruction, imageBase64Jpeg, signal } = params;
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error(
      'Gemini API Key is missing. Open "Engine & Keys" at the top and paste your Gemini API Key (or configure VITE_GEMINI_API_KEY in GitHub Secrets).'
    );
  }

  let lastErrorMsg = '';
  for (const model of DIRECT_GEMINI_JSON_MODELS) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const parts: Record<string, unknown>[] = [{ text: prompt }];
      if (imageBase64Jpeg) {
        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: imageBase64Jpeg,
          },
        });
      }

      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          trimmedKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(systemInstruction
              ? {
                  system_instruction: {
                    parts: [{ text: systemInstruction }],
                  },
                }
              : {}),
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.45,
            },
          }),
        },
        signal,
        SERVER_GEMINI_TIMEOUT_MS
      );

      const data = (await resp.json().catch(() => ({}))) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
        }[];
        error?: { message?: string; status?: string };
      };

      if (!resp.ok) {
        lastErrorMsg =
          data.error?.message || `Gemini API ${model} returned HTTP ${resp.status}.`;
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
          if (model === DIRECT_GEMINI_JSON_MODELS[DIRECT_GEMINI_JSON_MODELS.length - 1]) {
            throw new Error(`Gemini API error: ${lastErrorMsg}`);
          }
        }
        continue;
      }

      const rawText =
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('\n')
          .trim() ?? '';

      if (!rawText) {
        lastErrorMsg = `Gemini ${model} returned an empty response.`;
        continue;
      }

      const parsed = JSON.parse(stripJsonFences(rawText)) as Record<
        string,
        unknown
      >;
      return { parsed, modelUsed: model };
    } catch (err) {
      if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      lastErrorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    lastErrorMsg ||
      'Gemini video analysis failed. Please verify your Gemini API Key in Engine & Keys.'
  );
}

export async function callServerGeminiJson(params: {
  prompt: string;
  systemInstruction?: string;
  imageBase64Jpeg?: string;
  geminiApiKey?: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string }> {
  const {
    prompt,
    systemInstruction,
    imageBase64Jpeg,
    geminiApiKey = '',
    signal,
  } = params;

  const effectiveKey = (
    geminiApiKey ||
    (import.meta.env.VITE_GEMINI_API_KEY ?? '')
  ).trim();

  try {
    const resp = await fetchWithTimeout(
      '/api/gemini/json',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(imageBase64Jpeg ? { imageBase64Jpeg } : {}),
          ...(effectiveKey ? { apiKey: effectiveKey } : {}),
        }),
      },
      signal,
      SERVER_GEMINI_TIMEOUT_MS
    );

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const isJson = contentType.includes('application/json');
    const payload = isJson
      ? ((await resp.json().catch(() => ({}))) as {
          parsed?: Record<string, unknown>;
          modelUsed?: string;
          error?: string;
        })
      : {};

    if (resp.ok && payload.parsed) {
      return {
        parsed: payload.parsed,
        modelUsed: payload.modelUsed || 'gemini-2.5-flash',
      };
    }

    // If hosted on static GitHub Pages (404/405/HTML response) or server lacks env key, try direct Gemini key if available
    if (effectiveKey) {
      return await callDirectGeminiJsonFallback({
        apiKey: effectiveKey,
        prompt,
        systemInstruction,
        imageBase64Jpeg,
        signal,
      });
    }

    throw new Error(
      payload.error ||
        `Gemini API Key is not configured (HTTP ${resp.status}). Open "Engine & Keys" at the top and paste your Gemini API Key.`
    );
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    if (effectiveKey) {
      return await callDirectGeminiJsonFallback({
        apiKey: effectiveKey,
        prompt,
        systemInstruction,
        imageBase64Jpeg,
        signal,
      });
    }
    throw err instanceof Error
      ? err
      : new Error(
          'Gemini API request failed. Open "Engine & Keys" and enter a valid Gemini API Key.'
        );
  }
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
    }
  }
  return null;
}

/**
 * Step 1 Vision Router: tries Gemini (gemini-2.5-flash -> gemini-2.0-flash) first for fast 6-frame contact sheet inspection,
 * with fallback to NVIDIA NIM Vision if configured.
 */
export async function runStep1VisionJson(params: {
  geminiApiKey?: string;
  nvidiaApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  imageBase64Jpeg: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string }> {
  const {
    geminiApiKey = '',
    nvidiaApiKey,
    systemPrompt,
    userPrompt,
    imageBase64Jpeg,
    signal,
  } = params;

  let geminiError: unknown = null;
  try {
    return await callServerGeminiJson({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
      imageBase64Jpeg,
      geminiApiKey,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    geminiError = err;
  }

  if (nvidiaApiKey) {
    const nimRes = await callNvidiaNimJson({
      nvidiaApiKey,
      systemPrompt,
      userPrompt,
      imageBase64Jpeg,
      candidates: MODEL_ROSTER.step1Vision,
      maxAttempts: 2,
      signal,
    });
    if (nimRes) return nimRes;
  }

  throw geminiError instanceof Error
    ? geminiError
    : new Error(
        'Vision analysis failed: Please enter a valid Gemini API Key or NVIDIA NIM Key in "Engine & Keys".'
      );
}

/**
 * Step 1 Chapter/Scene Planner Router:
 * Routes through Gemini (`gemini-2.5-flash` -> `gemini-2.0-flash`) or NVIDIA NIM planning models.
 */
export async function runStep1PlannerJson(params: {
  geminiApiKey?: string;
  nvidiaApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string }> {
  const {
    geminiApiKey = '',
    nvidiaApiKey,
    systemPrompt,
    userPrompt,
    signal,
  } = params;

  let geminiError: unknown = null;
  try {
    return await callServerGeminiJson({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
      geminiApiKey,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    geminiError = err;
  }

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

  throw geminiError instanceof Error
    ? geminiError
    : new Error(
        'Planner failed: Please enter a valid Gemini API Key or NVIDIA NIM Key in "Engine & Keys".'
      );
}

/**
 * Step 3 Script & Translation Router:
 * Routes script generation through Gemini (`gemini-2.5-flash` -> `gemini-2.0-flash`) with fallback to NVIDIA NIM.
 */
export async function runStep3ScriptJson(params: {
  config: StudioConfig;
  language: OutputLanguage;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<{ parsed: Record<string, unknown>; modelUsed: string }> {
  const { config, language, systemPrompt, userPrompt, signal } = params;

  let result: { parsed: Record<string, unknown>; modelUsed: string } | null = null;
  let geminiError: unknown = null;

  try {
    result = await callServerGeminiJson({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
      geminiApiKey: config.geminiApiKey,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    geminiError = err;
  }

  if (!result && config.nvidiaApiKey) {
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
    throw geminiError instanceof Error
      ? geminiError
      : new Error(
          'Script generation failed: Please configure your Gemini API Key in "Engine & Keys".'
        );
  }

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
