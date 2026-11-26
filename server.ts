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

const JSON_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
] as const;
const TTS_MODELS = [
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-2.5-flash-preview-tts',
] as const;
const IMAGE_EDIT_MODEL = 'gemini-3.1-flash-lite-image';

let cachedKey = '';
let cachedClient: GoogleGenAI | null = null;

function getGeminiClient(overrideKey?: string): GoogleGenAI {
  const apiKey = (
    overrideKey ||
    process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    ''
  ).trim();
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY is not configured. Enter your Gemini API Key in Engine & Keys at the top, or set GEMINI_API_KEY in Settings > Secrets.'
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
        : 'Gemini API request failed.';
    return { status, message };
  }
  return { status: 502, message: 'Unexpected server Gemini API error.' };
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

  // Non-sensitive health endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean((process.env.GEMINI_API_KEY ?? '').trim()),
    });
  });

  // Server-side Gemini structured JSON generation (text or JPEG contact sheet + text)
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

      const apiKey =
        typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const ai = getGeminiClient(apiKey);
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

      let lastErr: unknown = null;
      for (const model of JSON_MODELS) {
        try {
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
          res.json({ parsed, modelUsed: model });
          return;
        } catch (err) {
          lastErr = err;
          const info = extractErrorInfo(err);
          if (info.status === 400 || info.status === 401 || info.status === 403) {
            break;
          }
        }
      }

      const finalErr = extractErrorInfo(lastErr);
      res.status(finalErr.status).json({ error: finalErr.message });
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Server-side Gemini TTS (gemini-3.8-flash-tts / gemini-3.8-flash-lite-tts)
  app.post('/api/gemini/tts', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scriptText =
        typeof body.scriptText === 'string' ? body.scriptText.trim() : '';
      const styleDesc =
        typeof body.styleDesc === 'string' && body.styleDesc.trim()
          ? body.styleDesc.trim()
          : 'Commanding, punchy viral storyteller narration';
      const voiceName = body.voiceName === 'Kore' ? 'Kore' : 'Fenrir';

      if (!scriptText || scriptText.length > 8_000) {
        res.status(400).json({ error: 'Valid scriptText is required for TTS.' });
        return;
      }

      const apiKey =
        typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const ai = getGeminiClient(apiKey);
      let lastErr: unknown = null;

      for (const model of TTS_MODELS) {
        try {
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
              res.json({
                audioBase64: part.inlineData.data,
                mimeType: part.inlineData.mimeType ?? 'audio/wav',
                modelUsed: model,
              });
              return;
            }
          }
          lastErr = new Error(`No audio returned by ${model}.`);
        } catch (err) {
          lastErr = err;
          const info = extractErrorInfo(err);
          if (info.status === 400 || info.status === 401 || info.status === 403) {
            break;
          }
        }
      }

      const finalErr = extractErrorInfo(lastErr);
      res.status(finalErr.status).json({ error: finalErr.message });
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Server-side Face-Locked Portrait Outfit Editing
  app.post('/api/gemini/edit-portrait', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const imageBase64 =
        typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
      const rawMime =
        typeof body.mimeType === 'string' ? body.mimeType.trim() : 'image/jpeg';
      const mimeType =
        rawMime === 'image/png' ||
        rawMime === 'image/webp' ||
        rawMime === 'image/jpeg'
          ? rawMime
          : 'image/jpeg';
      const outfitPrompt =
        typeof body.outfitPrompt === 'string' ? body.outfitPrompt.trim() : '';

      if (!imageBase64 || imageBase64.length > 10_000_000) {
        res.status(400).json({ error: 'Valid portrait image is required.' });
        return;
      }
      if (!outfitPrompt || outfitPrompt.length > 300) {
        res.status(400).json({ error: 'Valid outfit prompt is required.' });
        return;
      }

      const apiKey =
        typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const ai = getGeminiClient(apiKey);
      const editPrompt =
        `Keep the person's exact face, facial structure, eyes, nose, mouth, skin tone, hair, and identity 100% locked and identical to the reference photo. ` +
        `Change ONLY their outfit/clothing to: ${outfitPrompt}. ` +
        `Clean studio portrait lighting, crisp edges, front-facing head-and-shoulders framing.`;

      const response = await ai.models.generateContent({
        model: IMAGE_EDIT_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: editPrompt },
          ],
        },
      });

      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          const outMime = part.inlineData.mimeType ?? 'image/png';
          res.json({
            imageDataUrl: `data:${outMime};base64,${part.inlineData.data}`,
            modelUsed: IMAGE_EDIT_MODEL,
          });
          return;
        }
      }

      res
        .status(502)
        .json({ error: 'Portrait outfit edit returned no image output.' });
    } catch (err) {
      const info = extractErrorInfo(err);
      res.status(info.status).json({ error: info.message });
    }
  });

  // Ensure API errors always return JSON rather than HTML fallback
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
