import type { OutputLanguage, StudioConfig } from '../types/studio';

export interface VisionTimelineBeat {
  second: number;
  timestamp: string;
  action: string;
}

export interface ClipVisionAnalysis {
  core_topic: string;
  climax_second: number;
  timeline: VisionTimelineBeat[];
  watermark_boxes: number[][];
  search_queries: string[];
}

export interface YouTubeTrendItem {
  title: string;
  channel: string;
  published_at: string;
  view_count: number;
  like_count: number;
  tags: string[];
}

export interface GeneratedClipPack {
  voiceover: string;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  posting_time: string;
  scriptEngine: string;
}

const GEMINI_VISION_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
];

const GEMINI_IMAGE_EDIT_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-lite-image',
];

const NVIDIA_NIM_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_NIM_MODEL = 'meta/llama-3.3-70b-instruct';

function stripJsonFences(raw: string): string {
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

function formatSecLabel(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed encoding contact sheet.'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(',')[1] ?? '';
}

/**
 * Samples 9 evenly spaced keyframes onto a single lightweight JPEG contact sheet
 * (<= 800px wide) using OffscreenCanvas (with DOM canvas fallback), strictly
 * releasing every frame immediately so mobile RAM stays minimal.
 */
export async function buildContactSheetJpeg(
  videoObjectUrl: string,
  startSec: number,
  endSec: number,
  signal?: AbortSignal
): Promise<{ base64Jpeg: string; tileCount: number }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = videoObjectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Video keyframe load timed out.')),
        15_000
      );
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not decode video for keyframe contact sheet.'));
      };
    });

    const clipDur = Math.max(2, endSec - startSec);
    const tileCount = 9;
    const cols = 3;
    const rows = 3;
    const pad = 4;

    // Strictly <= 800px total width for fast, low-memory Gemini Vision calls
    const srcW = video.videoWidth || 720;
    const srcH = video.videoHeight || 1280;
    const tileW = 256; // 3 * 256 + 4 * 4 = 784px <= 800px
    const tileH = Math.max(
      144,
      Math.min(340, Math.round((tileW * srcH) / Math.max(srcW, 1)))
    );
    const sheetW = cols * tileW + (cols + 1) * pad;
    const sheetH = rows * tileH + (rows + 1) * pad;

    const useOffscreen =
      typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function';

    const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
      ? new OffscreenCanvas(sheetW, sheetH)
      : Object.assign(document.createElement('canvas'), {
          width: sheetW,
          height: sheetH,
        });

    const ctx = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) {
      throw new Error('2D context unavailable for contact sheet.');
    }

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, sheetW, sheetH);

    for (let i = 0; i < tileCount; i++) {
      if (signal?.aborted) {
        throw new DOMException('Cancelled', 'AbortError');
      }
      const relSec = (clipDur * (i + 0.5)) / tileCount;
      const seekSec = Math.min(
        Math.max(0.05, startSec + relSec),
        Math.max(0.1, (video.duration || endSec) - 0.1)
      );

      await new Promise<void>((resolve) => {
        const done = () => {
          video.onseeked = null;
          resolve();
        };
        const fallback = window.setTimeout(done, 1100);
        video.onseeked = () => {
          window.clearTimeout(fallback);
          done();
        };
        try {
          video.currentTime = seekSec;
        } catch {
          window.clearTimeout(fallback);
          resolve();
        }
      });

      const r = Math.floor(i / cols);
      const c = i % cols;
      const dx = pad + c * (tileW + pad);
      const dy = pad + r * (tileH + pad);

      ctx.drawImage(video, 0, 0, srcW, srcH, dx, dy, tileW, tileH);

      const label = formatSecLabel(relSec);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(dx + 5, dy + 5, 52, 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(label, dx + 10, dy + 19);
    }

    let base64Jpeg = '';
    if (canvas instanceof OffscreenCanvas) {
      const jpegBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: 0.72,
      });
      base64Jpeg = await blobToBase64(jpegBlob);
    } else {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      base64Jpeg = dataUrl.split(',')[1] ?? '';
    }

    return { base64Jpeg, tileCount };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

async function callGeminiJson(
  apiKey: string,
  parts: Record<string, unknown>[],
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  if (!apiKey) {
    throw new Error(
      'Missing Gemini API Key. Open Studio API Config above and paste your Gemini API Key.'
    );
  }

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  let lastError = 'Gemini API request failed.';
  for (const model of GEMINI_VISION_MODELS) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          apiKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        }
      );

      if (resp.status === 404) {
        lastError = `${model} unavailable (404)`;
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        lastError = `${model} HTTP ${resp.status}: ${text.slice(0, 180)}`;
        if (resp.status === 429 || resp.status >= 500) continue;
        throw new Error(lastError);
      }

      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) {
        lastError = `${model} returned empty content.`;
        continue;
      }
      return JSON.parse(stripJsonFences(text)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      lastError = (err as Error).message;
    }
  }

  throw new Error(`Gemini Vision/JSON error: ${lastError}`);
}

export async function analyzeContactSheetOneCall(params: {
  base64Jpeg: string;
  clipDurationSec: number;
  customAngle: string;
  geminiApiKey: string;
  signal?: AbortSignal;
}): Promise<ClipVisionAnalysis> {
  const { base64Jpeg, clipDurationSec, customAngle, geminiApiKey, signal } =
    params;

  const prompt = `
You are a precision short-form video analyst and computer-vision inspector.
This single image is a 3x3 chronological contact-sheet grid of 9 keyframes sampled evenly across a ${clipDurationSec.toFixed(
    1
  )}-second clip (each tile has a top-left timestamp 00:XX).
${customAngle ? `Creator custom suspense angle: "${customAngle}"` : ''}

Return ONLY valid JSON:
{
  "core_topic": "Exact specific object, action, or product in this clip",
  "climax_second": ${(clipDurationSec * 0.52).toFixed(1)},
  "timeline": [
    {"second": 1, "timestamp": "00:01", "action": "..."},
    {"second": 5, "timestamp": "00:05", "action": "..."}
  ],
  "watermark_boxes": [[15, 20, 95, 280]],
  "search_queries": [
    "specific US Shorts search query 1",
    "specific US Shorts search query 2",
    "specific US Shorts search query 3"
  ]
}

Rules:
- climax_second: exact second between 3.0 and ${Math.max(
    3.5,
    clipDurationSec - 2.5
  ).toFixed(1)} of the biggest visual reveal or twist.
- watermark_boxes: normalized [ymin, xmin, ymax, xmax] (0-1000) coordinates RELATIVE TO AN INDIVIDUAL VIDEO FRAME TILE (NOT the entire 3x3 grid!) for every visible platform watermark, logo, handle, or floating text. Ignore our dark 00:XX timestamp box in the top-left. Return [] if clean.
`.trim();

  const parsed = await callGeminiJson(
    geminiApiKey,
    [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Jpeg,
        },
      },
    ],
    signal
  );

  const climaxNum = Number(parsed.climax_second);
  const safeClimax =
    Number.isFinite(climaxNum) &&
    climaxNum > 2.8 &&
    climaxNum < clipDurationSec - 1.5
      ? climaxNum
      : clipDurationSec * 0.52;

  return {
    core_topic: String(parsed.core_topic || 'Viral short clip'),
    climax_second: Number(safeClimax.toFixed(2)),
    timeline: Array.isArray(parsed.timeline)
      ? (parsed.timeline as VisionTimelineBeat[])
      : [],
    watermark_boxes: Array.isArray(parsed.watermark_boxes)
      ? (parsed.watermark_boxes as number[][])
      : [],
    search_queries: Array.isArray(parsed.search_queries)
      ? (parsed.search_queries as string[]).filter(Boolean).slice(0, 3)
      : [String(parsed.core_topic || 'viral gadget short')],
  };
}

export async function fetchLiveYouTubeTrends(
  queries: string[],
  youtubeApiKey: string,
  signal?: AbortSignal
): Promise<YouTubeTrendItem[]> {
  if (!youtubeApiKey) return [];

  const publishedAfter = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const videoIds: string[] = [];
  const seen = new Set<string>();

  await Promise.all(
    queries.slice(0, 3).map(async (rawQ) => {
      const q = rawQ.trim();
      if (!q) return;
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', q);
      url.searchParams.set('regionCode', 'US');
      url.searchParams.set('type', 'video');
      url.searchParams.set('videoDuration', 'short');
      url.searchParams.set('order', 'viewCount');
      url.searchParams.set('publishedAfter', publishedAfter);
      url.searchParams.set('maxResults', '6');
      url.searchParams.set('key', youtubeApiKey);

      try {
        const resp = await fetch(url.toString(), { signal });
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          items?: { id?: { videoId?: string } }[];
        };
        for (const item of data.items ?? []) {
          const vid = item.id?.videoId;
          if (vid && !seen.has(vid)) {
            seen.add(vid);
            videoIds.push(vid);
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
      }
    })
  );

  if (videoIds.length === 0) return [];

  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.searchParams.set('part', 'snippet,statistics');
  detailsUrl.searchParams.set('id', videoIds.slice(0, 18).join(','));
  detailsUrl.searchParams.set('key', youtubeApiKey);

  const detailsResp = await fetch(detailsUrl.toString(), { signal });
  if (!detailsResp.ok) return [];

  const detailsData = (await detailsResp.json()) as {
    items?: {
      snippet?: {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        tags?: string[];
      };
      statistics?: {
        viewCount?: string;
        likeCount?: string;
      };
    }[];
  };

  const trends: YouTubeTrendItem[] = (detailsData.items ?? []).map((item) => ({
    title: item.snippet?.title ?? '',
    channel: item.snippet?.channelTitle ?? '',
    published_at: item.snippet?.publishedAt ?? '',
    view_count: parseInt(item.statistics?.viewCount ?? '0', 10) || 0,
    like_count: parseInt(item.statistics?.likeCount ?? '0', 10) || 0,
    tags: (item.snippet?.tags ?? []).slice(0, 15),
  }));

  trends.sort((a, b) => b.view_count - a.view_count);
  return trends.slice(0, 12);
}

async function tryNvidiaNimJson(
  prompt: string,
  nvidiaApiKey: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  if (!nvidiaApiKey) return null;
  try {
    const resp = await fetch(NVIDIA_NIM_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nvidiaApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: NVIDIA_NIM_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an elite viral US YouTube Shorts suspense scriptwriter and SEO strategist. Output strictly valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.65,
        top_p: 0.9,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) return null;
    const parsed = JSON.parse(stripJsonFences(content)) as Record<
      string,
      unknown
    >;
    if (parsed.voiceover && parsed.title) {
      return parsed;
    }
    return null;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return null;
  }
}

export async function generateViralScriptAndMetadata(params: {
  vision: ClipVisionAnalysis;
  trends: YouTubeTrendItem[];
  clipDurationSec: number;
  language: OutputLanguage;
  customAngle: string;
  config: StudioConfig;
  signal?: AbortSignal;
}): Promise<GeneratedClipPack> {
  const {
    vision,
    trends,
    clipDurationSec,
    language,
    customAngle,
    config,
    signal,
  } = params;

  const langLabel =
    language === 'hi'
      ? 'Hindi (natural high-energy conversational Hindi written in Devanagari script)'
      : 'American English (high-retention US suspense narrator)';

  const targetWords = Math.max(
    28,
    Math.min(135, Math.round(clipDurationSec * 2.85))
  );
  const customNote = customAngle
    ? `CREATOR CUSTOM SUSPENSE HOOK / ANGLE:\n"${customAngle}"\nBuild the narration around this exact angle while staying synced to the visual beats.`
    : 'Build a maximum-suspense curiosity-gap hook automatically from the visual timeline.';

  const trendsBlock =
    trends.length > 0
      ? `LIVE YOUTUBE DATA API v3 TOP US SHORTS (real view counts, titles, tags & publish timestamps):\n${JSON.stringify(
          trends
        )}`
      : 'No YouTube API trends returned; derive US Shorts SEO titles, tags, and peak US EST + India IST timing from the visual topic.';

  const prompt = `
You are an elite viral short-form suspense scriptwriter and YouTube Shorts SEO strategist.

CORE TOPIC: ${vision.core_topic}
VISUAL TIMELINE (${clipDurationSec.toFixed(1)}s clip):
${JSON.stringify(vision.timeline)}
MID-VIDEO CLIMAX SECOND: ${vision.climax_second}s

${trendsBlock}

OUTPUT LANGUAGE: ${langLabel}
${customNote}

SCRIPT RULES (ZERO DEAD AIR):
1. Write roughly ${targetWords} spoken words (~2.85 words/sec).
2. 0.0s-2.5s OPENING HOOK: Scroll-stopping suspense hook immediately on frame 1.
3. EVERY 2-3 SECONDS: Trigger fresh curiosity/tension synced to the visual timeline.
4. SEAMLESS LOOP ENDING: The final phrase flows seamlessly back into the opening hook and provokes comments.
5. Plain spoken words ONLY inside "voiceover" (no brackets, no emojis, no timestamps).

METADATA RULES:
- "title": High-CTR title modeled on top-performing US Shorts titles (max 68 chars).
- "description": 2-line SEO description with high-retention keywords.
- "tags": 15 specific comma-separated trending tags.
- "hashtags": 7 targeted hashtags starting with # separated by spaces.
- "posting_time": Best Upload Time explicitly formatted with BOTH USA EST + India IST (e.g., "6:30 PM EST / 5:00 AM IST — Peak US Evening & Early India Feed").

Return ONLY valid JSON:
{
  "voiceover": "...",
  "title": "...",
  "description": "...",
  "tags": "...",
  "hashtags": "...",
  "posting_time": "..."
}
`.trim();

  let scriptEngine = 'NVIDIA Llama-3.3-70B';
  let parsed = await tryNvidiaNimJson(prompt, config.nvidiaApiKey, signal);

  if (!parsed) {
    scriptEngine = 'Gemini 2.5 Flash';
    parsed = await callGeminiJson(config.geminiApiKey, [{ text: prompt }], signal);
  }

  return {
    voiceover: String(parsed.voiceover || '').trim(),
    title: String(parsed.title || vision.core_topic).trim(),
    description: String(parsed.description || '').trim(),
    tags: String(parsed.tags || '').trim(),
    hashtags: String(parsed.hashtags || '').trim(),
    posting_time: String(
      parsed.posting_time || '6:30 PM EST / 5:00 AM IST — Peak US Evening Feed'
    ).trim(),
    scriptEngine,
  };
}

async function fetchImageAsBase64(
  imageUrl: string,
  signal?: AbortSignal
): Promise<{ mimeType: string; base64: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1], base64: match[2] };
    }
  }
  const resp = await fetch(imageUrl, { signal });
  if (!resp.ok) throw new Error('Could not download character portrait image.');
  const blob = await resp.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed reading portrait blob.'));
    reader.readAsDataURL(blob);
  });
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return {
    mimeType: match?.[1] || 'image/jpeg',
    base64: match?.[2] || '',
  };
}

export async function applyFaceLockedOutfitChange(params: {
  portraitUrl: string;
  outfitPrompt: string;
  geminiApiKey: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { portraitUrl, outfitPrompt, geminiApiKey, signal } = params;
  if (!outfitPrompt.trim() || !geminiApiKey) {
    return portraitUrl;
  }

  try {
    const { mimeType, base64 } = await fetchImageAsBase64(portraitUrl, signal);
    if (!base64) return portraitUrl;

    const editPrompt =
      `Keep the person's exact face, facial structure, eyes, nose, mouth, skin tone, hair, and identity 100% locked and identical to the reference photo. ` +
      `Change ONLY their outfit/clothing to: ${outfitPrompt.trim()}. ` +
      `Clean studio portrait lighting, crisp edges, front-facing head-and-shoulders framing.`;

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: editPrompt },
          ],
        },
      ],
    };

    for (const model of GEMINI_IMAGE_EDIT_MODELS) {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
          geminiApiKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        }
      );
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        candidates?: {
          content?: {
            parts?: { inlineData?: { mimeType?: string; data?: string } }[];
          };
        }[];
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const outMime = part.inlineData.mimeType || 'image/png';
          return `data:${outMime};base64,${part.inlineData.data}`;
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
  }

  return portraitUrl;
}
