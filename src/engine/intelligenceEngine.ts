import {
  extractJsonObject,
  fetchYouTubeTrendsFromApi,
  runSingleClipAiRequest,
} from './modelRouter';
import { generateOfflineDirectTranslationAndMetadata } from './offlineModels';
import type {
  AiEnginePreference,
  OutputLanguage,
  PreparedVisualClip,
  ScriptBeat,
  TrendMetadata,
  YouTubeTrendVideo,
} from '../types/studio';

interface AiTranslationSeoPayload {
  voiceover?: string;
  beats?: { start_sec?: number; end_sec?: number; text?: string }[];
  title?: string;
  description?: string;
  tags?: string | string[];
  hashtags?: string | string[];
  posting_time?: string;
}

export async function fetchLiveYouTubeTrends(
  topicQuery: string,
  signal?: AbortSignal
): Promise<YouTubeTrendVideo[]> {
  return fetchYouTubeTrendsFromApi(topicQuery, signal);
}

function normalizeBeats(
  rawBeats: AiTranslationSeoPayload['beats'],
  voiceover: string,
  lockedDurationSec: number
): ScriptBeat[] {
  const safeDur = Math.max(1.5, lockedDurationSec - 0.25);

  if (Array.isArray(rawBeats) && rawBeats.length > 0) {
    const valid = rawBeats
      .map((b) => ({
        startSec: Number(b.start_sec ?? 0),
        endSec: Number(b.end_sec ?? 0),
        text: (b.text ?? '').trim(),
      }))
      .filter((b) => b.text.length > 0 && Number.isFinite(b.startSec) && Number.isFinite(b.endSec));

    if (valid.length > 0) {
      const clamped: ScriptBeat[] = [];
      let prevEnd = 0;
      for (let i = 0; i < valid.length; i++) {
        const startSec = Math.max(prevEnd, Math.min(safeDur - 0.3, valid[i].startSec));
        const endSec =
          i === valid.length - 1
            ? safeDur
            : Math.max(startSec + 0.35, Math.min(safeDur, valid[i].endSec));
        clamped.push({
          startSec: Number(startSec.toFixed(2)),
          endSec: Number(endSec.toFixed(2)),
          text: valid[i].text,
        });
        prevEnd = endSec;
      }
      return clamped;
    }
  }

  // Split voiceover cleanly into sentences if AI omitted explicit beat timings
  const sentences = voiceover
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = sentences.length > 0 ? sentences : [voiceover.trim()];
  const step = safeDur / parts.length;
  return parts.map((text, idx) => ({
    startSec: Number((idx * step).toFixed(2)),
    endSec: Number(Math.min(safeDur, (idx + 1) * step).toFixed(2)),
    text,
  }));
}

function normalizeCommaList(value: string | string[] | undefined, fallback: string): string {
  if (Array.isArray(value)) {
    const joined = value.map((s) => String(s).trim()).filter(Boolean).join(', ');
    return joined || fallback;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function normalizeHashtags(value: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(value)
    ? value.map((s) => String(s).trim()).filter(Boolean)
    : typeof value === 'string'
    ? value.trim().split(/[\s,]+/).filter(Boolean)
    : [];

  if (raw.length === 0) return fallback;
  return raw
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`))
    .slice(0, 8)
    .join(' ');
}

/**
 * STEP 3 (Direct Translation & SEO):
 * Makes STRICTLY ONE primary AI request per clip (using Gemini 3.8 Flash or the selected
 * NVIDIA NIM model) combined with live US YouTube Data API v3 trend signals.
 * Zero retry loops on 429 — falls back immediately to local direct-translation SEO if quota fails.
 */
export async function translateClipAndBuildSeoStep3(params: {
  clip: PreparedVisualClip;
  sourceLabel: string;
  language: OutputLanguage;
  aiEngine: AiEnginePreference;
  customAngle: string;
  trends: YouTubeTrendVideo[];
  signal?: AbortSignal;
  onStatus?: (detail: string) => void;
}): Promise<TrendMetadata> {
  const {
    clip,
    sourceLabel,
    language,
    aiEngine,
    customAngle,
    trends,
    signal,
    onStatus,
  } = params;

  const targetDurSec = clip.lockedVisualDurationSec;
  const maxSpeechSec = Math.max(2, targetDurSec - 0.35);
  // ~2.35 words/sec for bold commanding delivery so speech fits comfortably without mid-sentence cutoff
  const targetWordCount = Math.max(10, Math.round(maxSpeechSec * 2.35));

  const languageName =
    language === 'hi'
      ? 'Hindi (clear, natural Devanagari Hindi — direct faithful translation)'
      : 'English (USA — crisp, direct, commanding American broadcast English)';

  const trendSummary =
    trends.length > 0
      ? trends
          .slice(0, 5)
          .map(
            (t, idx) =>
              `${idx + 1}. "${t.title}" (${t.channel}${t.viewCount ? `, ${t.viewCount.toLocaleString()} views` : ''})`
          )
          .join('\n')
      : 'No live US YouTube trend rows returned — optimize for high-retention US Shorts / Reels search intent.';

  const systemPrompt = `You are a precision Direct Translation & Video SEO Producer.
Your job is to inspect the stamped 3x2 keyframe contact sheet (timestamps T=0.0s to T=${targetDurSec.toFixed(1)}s) and deliver a DIRECT, FAITHFUL translation/narration of the clip's actual on-screen/spoken main points into ${languageName}.
RULES:
1. Do NOT invent unrelated clickbait stories. Preserve every visible action, on-screen text, and core point faithfully in ${languageName}.
2. Keep the narration bold, clear, and commanding, sized to ~${targetWordCount} words so it finishes cleanly before ${maxSpeechSec.toFixed(1)}s with zero mid-sentence cutoff.
3. Return ONLY valid JSON matching the exact schema below. No markdown fences or commentary.`;

  const userPrompt = `SOURCE FILE / LABEL: ${sourceLabel}
CLIP SEGMENT: Clip ${clip.clipIndex} of ${clip.totalClips} (${clip.sourceStartSec.toFixed(1)}s–${clip.sourceEndSec.toFixed(1)}s, locked duration: ${targetDurSec.toFixed(1)}s, keyframe stamps: ${clip.stampedTimestampsSec.map((t) => `${t.toFixed(1)}s`).join(', ')})
OUTPUT LANGUAGE: ${languageName}
USER CONTEXT / SPOKEN NOTES (if provided, translate and preserve these exact points): ${customAngle.trim() || 'Translate and narrate the main visual/spoken points directly from the stamped frames.'}

LIVE US YOUTUBE TRENDS (regionCode=US):
${trendSummary}

RETURN STRICT JSON ONLY:
{
  "voiceover": "Complete direct-translation commanding narration (~${targetWordCount} words, finishes cleanly by ${maxSpeechSec.toFixed(1)}s)",
  "beats": [
    { "start_sec": 0.0, "end_sec": ${(maxSpeechSec * 0.33).toFixed(1)}, "text": "Opening beat directly translating first scene" },
    { "start_sec": ${(maxSpeechSec * 0.33).toFixed(1)}, "end_sec": ${(maxSpeechSec * 0.68).toFixed(1)}, "text": "Middle beat directly translating main turning point" },
    { "start_sec": ${(maxSpeechSec * 0.68).toFixed(1)}, "end_sec": ${maxSpeechSec.toFixed(1)}, "text": "Closing beat delivering the exact takeaway" }
  ],
  "title": "High-CTR SEO title (<= 78 chars) matching ${languageName}",
  "description": "Concise SEO description summarizing the clip's real key points + call to action",
  "tags": "comma, separated, 8-12, targeted, youtube, tags",
  "hashtags": "#Tag1 #Tag2 #Tag3 #Tag4 #Tag5",
  "posting_time": "Best Upload Window with both USA EST and India IST peak hours (e.g., 12:00 PM – 2:30 PM EST / 9:30 PM – 11:30 PM IST)"
}`;

  onStatus?.(
    `Running single-call direct translation & SEO for Clip ${clip.clipIndex}/${clip.totalClips}...`
  );

  // STRICT 1-CALL QUOTA GUARDRAIL: exactly one primary AI call per clip, zero 429 retries
  const aiResponse = await runSingleClipAiRequest({
    preference: aiEngine,
    systemPrompt,
    userPrompt,
    imageBase64Jpeg: clip.stampedContactSheetJpeg || undefined,
    signal,
  });

  if (!aiResponse || !aiResponse.rawText.trim()) {
    return generateOfflineDirectTranslationAndMetadata({
      clip,
      sourceLabel,
      language,
      customAngle,
      trends,
      fallbackReason: aiResponse?.errorReason ?? 'Local mode',
    });
  }

  const parsed = extractJsonObject<AiTranslationSeoPayload>(aiResponse.rawText);
  if (!parsed || !parsed.voiceover || parsed.voiceover.trim().length < 8) {
    return generateOfflineDirectTranslationAndMetadata({
      clip,
      sourceLabel,
      language,
      customAngle,
      trends,
      fallbackReason: `${aiResponse.modelUsed} returned non-JSON`,
    });
  }

  const offlineDefaults = generateOfflineDirectTranslationAndMetadata({
    clip,
    sourceLabel,
    language,
    customAngle,
    trends,
  });

  const voiceover = parsed.voiceover.trim();
  const beats = normalizeBeats(parsed.beats, voiceover, targetDurSec);

  return {
    voiceover,
    beats,
    title: (parsed.title?.trim() || offlineDefaults.title).slice(0, 100),
    description: parsed.description?.trim() || offlineDefaults.description,
    tags: normalizeCommaList(parsed.tags, offlineDefaults.tags),
    hashtags: normalizeHashtags(parsed.hashtags, offlineDefaults.hashtags),
    postingTime: parsed.posting_time?.trim() || offlineDefaults.postingTime,
    scriptEngine: `${aiResponse.modelUsed} (1-Call Direct Translation)`,
    youtubeTrendsCount: trends.length,
  };
}
