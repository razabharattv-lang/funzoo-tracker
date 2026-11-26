import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const GEMINI_PRIMARY_JSON_MODEL = 'gemini-4-hydrogen';
const GEMINI_FALLBACK_JSON_MODEL = 'gemini-3.1-flash-lite';

const GEMINI_PRIMARY_TTS_MODEL = 'gemini-3.8-flash-tts';
const GEMINI_FALLBACK_TTS_MODEL = 'gemini-3.8-flash-lite-tts';

const ALLOWED_NVIDIA_MODELS = new Set([
  // Step 1 (Fetch & Clip)
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/nemotron-ocr-v1',
  // Step 2 (Clean & Grade)
  'nvidia/nemotron-3.5-parse',
  'nvidia/cosmos3-nano-reasoner',
  'nvidia/video-super-resolution-nim',
  // Step 3 (Direct Translation & SEO)
  'nvidia/riva-translate-4b-instruct-v2',
  'mistralai/mistral-large-4',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3.5-content-safety',
  // Step 4 (Voiceover DSP / TTS workers)
  'nvidia/magpie-tts-zeroshot',
  'nvidia/studio-voice',
  'nvidia/background-noise-removal',
  // Step 5 (Mux & Sequence Timing Check)
  'z-ai/glm-5-3-flash',
]);

const NVIDIA_NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

let cachedKey = '';
let cachedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY is not configured on the server.'
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

function getNvidiaApiKey(): string {
  return (
    process.env.NVIDIA_API_KEY ||
    process.env.VITE_NVIDIA_API_KEY ||
    ''
  ).trim();
}

function getYoutubeApiKey(): string {
  return (
    process.env.YOUTUBE_API_KEY ||
    process.env.VITE_YOUTUBE_API_KEY ||
    ''
  ).trim();
}

function extractErrorInfo(err: unknown): { status: number; message: string } {
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const rawStatus = Number(rec.statusCode ?? rec.status ?? rec.code);
    const status =
      Number.isFinite(rawStatus) && rawStatus >= 400 && rawStatus <= 599
        ? rawStatus
        : 502;
    const message =
      typeof rec.message === 'string' && rec.message.trim()
        ? rec.message.trim()
        : 'Upstream AI API request failed.';
    return { status, message };
  }
  return { status: 502, message: 'Unexpected server API error.' };
}

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

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean((process.env.GEMINI_API_KEY ?? '').trim()),
      nvidiaConfigured: Boolean(getNvidiaApiKey()),
      youtubeConfigured: Boolean(getYoutubeApiKey()),
    });
  });

  // Server-side Gemini structured JSON generation (strict 1-call quota guardrail, zero 429 retries)
  app.post('/api/gemini/json', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const systemInstruction =
        typeof body.systemInstruction === 'string'
          ? body.systemInstruction.trim()
          : '';
      const imageBase64Jpeg =
        typeof body.imageBase64Jpeg === 'string'
          ? body.imageBase64Jpeg.trim()
          : '';

      if (!prompt || prompt.length > 50_000) {
        res.status(400).json({ error: 'Valid prompt is required.' });
        return;
      }
      if (imageBase64Jpeg && imageBase64Jpeg.length > 12_000_000) {
        res.status(413).json({ error: 'Contact sheet image payload too large.' });
        return;
      }

      const ai = getGeminiClient();
      const contents = imageBase64Jpeg
        ? {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: imageBase64Jpeg,
                },
              },
            ],
          }
        : prompt;

      const callModel = async (model: string) => {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            responseMimeType: 'application/json',
            ...(systemInstruction ? { systemInstruction } : {}),
          },
        });
        const rawText = (response.text ?? '').trim();
        if (!rawText) {
          throw new Error(`Empty JSON response from ${model}.`);
        }
        const parsed = JSON.parse(stripJsonFences(rawText)) as Record<
          string,
          unknown
        >;
        return { parsed, modelUsed: model };
      };

      try {
        const out = await callModel(GEMINI_PRIMARY_JSON_MODEL);
        res.json(out);
        return;
      } catch (err) {
        const info = extractErrorInfo(err);
        // Never retry 429 quota or auth errors; only resolve 404 model alias once
        if (info.status === 404) {
          try {
            const fallbackOut = await callModel(GEMINI_FALLBACK_JSON_MODEL);
            res.json(fallbackOut);
            return;
          } catch (fbErr) {
            const fbInfo = extractErrorInfo(fbErr);
            res.status(fbInfo.status).json({ error: fbInfo.message });
            return;
          }
        }
        res.status(info.status).json({ error: info.message });
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Server-side Gemini TTS (gemini-3.8-flash-tts, Fenrir/Kore, zero 429 retries)
  app.post('/api/gemini/tts', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scriptText =
        typeof body.scriptText === 'string' ? body.scriptText.trim() : '';
      const styleDesc =
        typeof body.styleDesc === 'string' && body.styleDesc.trim()
          ? body.styleDesc.trim().slice(0, 400)
          : 'Commanding, punchy, high-authority broadcast narration';
      const voiceName = body.voiceName === 'Kore' ? 'Kore' : 'Fenrir';

      if (!scriptText || scriptText.length > 8_000) {
        res.status(400).json({ error: 'Valid scriptText is required for TTS.' });
        return;
      }

      const ai = getGeminiClient();

      const callTts = async (model: string) => {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: scriptText,
                  speechMetadata: { style: styleDesc },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        });

        const parts = response.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            return {
              audioBase64: part.inlineData.data,
              mimeType: part.inlineData.mimeType ?? 'audio/wav',
              modelUsed: model,
            };
          }
        }
        throw new Error(`No audio returned by ${model}.`);
      };

      try {
        const out = await callTts(GEMINI_PRIMARY_TTS_MODEL);
        res.json(out);
        return;
      } catch (err) {
        const info = extractErrorInfo(err);
        if (info.status === 404) {
          try {
            const fallbackOut = await callTts(GEMINI_FALLBACK_TTS_MODEL);
            res.json(fallbackOut);
            return;
          } catch (fbErr) {
            const fbInfo = extractErrorInfo(fbErr);
            res.status(fbInfo.status).json({ error: fbInfo.message });
            return;
          }
        }
        res.status(info.status).json({ error: info.message });
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Server-side NVIDIA NIM proxy (strict model allowlist, 1 call, zero 429 retries)
  app.post('/api/nvidia/chat', async (req: Request, res: Response) => {
    try {
      const nvidiaKey = getNvidiaApiKey();
      if (!nvidiaKey) {
        res
          .status(503)
          .json({ error: 'NVIDIA_API_KEY is not configured on the server.' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      const systemPrompt =
        typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
      const userPrompt =
        typeof body.userPrompt === 'string' ? body.userPrompt.trim() : '';
      const imageBase64Jpeg =
        typeof body.imageBase64Jpeg === 'string'
          ? body.imageBase64Jpeg.trim()
          : '';

      if (!ALLOWED_NVIDIA_MODELS.has(model)) {
        res.status(400).json({ error: 'Requested NVIDIA model is not allowed.' });
        return;
      }
      if (!userPrompt || userPrompt.length > 50_000) {
        res.status(400).json({ error: 'Valid userPrompt is required.' });
        return;
      }
      if (imageBase64Jpeg && imageBase64Jpeg.length > 12_000_000) {
        res.status(413).json({ error: 'Image payload too large.' });
        return;
      }

      const supportsVision =
        model === 'nvidia/nemotron-3.5-super-vl-120b-a12b' ||
        model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' ||
        model === 'nvidia/nemotron-ocr-v1' ||
        model === 'nvidia/nemotron-3.5-parse' ||
        model === 'nvidia/cosmos3-nano-reasoner';
      const userContent =
        supportsVision && imageBase64Jpeg
          ? [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64Jpeg}` },
              },
            ]
          : userPrompt;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 14_000);

      try {
        const resp = await fetch(NVIDIA_NIM_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${nvidiaKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(systemPrompt
                ? [{ role: 'system', content: systemPrompt }]
                : []),
              { role: 'user', content: userContent },
            ],
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: 1400,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          res.status(resp.status).json({
            error: `NVIDIA NIM returned HTTP ${resp.status}.`,
          });
          return;
        }

        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const rawContent = data.choices?.[0]?.message?.content?.trim() ?? '';
        if (!rawContent) {
          res.status(502).json({ error: 'NVIDIA NIM returned empty content.' });
          return;
        }

        const parsed = JSON.parse(stripJsonFences(rawContent)) as Record<
          string,
          unknown
        >;
        res.json({ parsed, modelUsed: model });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Server-side YouTube Data API v3 proxy (regionCode=US)
  app.post('/api/youtube/trends', async (req: Request, res: Response) => {
    try {
      const ytKey = getYoutubeApiKey();
      if (!ytKey) {
        res.json({ trends: [], configured: false });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawQueries = Array.isArray(body.queries) ? body.queries : [];
      const queries = rawQueries
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 2);

      if (queries.length === 0) {
        res.json({ trends: [], configured: true });
        return;
      }

      const videoIds: string[] = [];
      const snippetFallback: {
        title: string;
        channel: string;
        publishedAt: string;
        viewCount: number;
        likeCount: number;
        tags: string[];
      }[] = [];
      const seen = new Set<string>();

      await Promise.all(
        queries.slice(0, 1).map(async (q) => {
          const searchUrl = new URL(
            'https://www.googleapis.com/youtube/v3/search'
          );
          searchUrl.searchParams.set('part', 'snippet');
          searchUrl.searchParams.set('q', q);
          searchUrl.searchParams.set('regionCode', 'US');
          searchUrl.searchParams.set('type', 'video');
          searchUrl.searchParams.set('videoDuration', 'short');
          searchUrl.searchParams.set('order', 'viewCount');
          searchUrl.searchParams.set('maxResults', '8');
          searchUrl.searchParams.set('key', ytKey);

          try {
            const resp = await fetch(searchUrl.toString());
            if (!resp.ok) return;
            const data = (await resp.json()) as {
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
            for (const item of data.items ?? []) {
              const vid = item.id?.videoId;
              if (vid && !seen.has(vid)) {
                seen.add(vid);
                videoIds.push(vid);
                const descTags = (item.snippet?.description ?? '')
                  .match(/#[\p{L}\p{N}_]{2,28}/gu)
                  ?.map((h) => h.slice(1).toLowerCase()) ?? [];
                snippetFallback.push({
                  title: item.snippet?.title ?? '',
                  channel: item.snippet?.channelTitle ?? '',
                  publishedAt: item.snippet?.publishedAt ?? '',
                  viewCount: 0,
                  likeCount: 0,
                  tags: descTags.slice(0, 10),
                });
              }
            }
          } catch {
            // Skip failed search query without retrying
          }
        })
      );

      if (videoIds.length === 0) {
        res.json({ trends: [], configured: true });
        return;
      }

      const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      detailsUrl.searchParams.set('part', 'snippet,statistics');
      detailsUrl.searchParams.set('id', videoIds.slice(0, 8).join(','));
      detailsUrl.searchParams.set('key', ytKey);

      const detailsResp = await fetch(detailsUrl.toString());
      if (!detailsResp.ok) {
        res.json({ trends: snippetFallback, configured: true });
        return;
      }

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

      const trends = (detailsData.items ?? [])
        .map((item) => ({
          title: item.snippet?.title ?? '',
          channel: item.snippet?.channelTitle ?? '',
          publishedAt: item.snippet?.publishedAt ?? '',
          viewCount: parseInt(item.statistics?.viewCount ?? '0', 10) || 0,
          likeCount: parseInt(item.statistics?.likeCount ?? '0', 10) || 0,
          tags: (item.snippet?.tags ?? []).slice(0, 15),
        }))
        .sort((a, b) => b.viewCount - a.viewCount)
        .slice(0, 10);

      res.json({ trends, configured: true });
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message, trends: [] });
    }
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  );

  if (IS_PRODUCTION) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((_req: Request, res: Response) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Production bundle not built.');
      }
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`US Explainer Video Studio server listening on port ${PORT}`);
  });
}

void startServer();
