import {
  extractJsonObject,
  fetchYouTubeTrendsFromApi,
  runSingleClipAiRequest,
} from './modelRouter';
import {
  extractReadableTopicFromLabel,
  generateOfflineDirectTranslationAndMetadata,
} from './offlineModels';
import type {
  AiEnginePreference,
  ConnectionStatusState,
  OutputLanguage,
  PreparedVisualClip,
  ScriptBeat,
  TrendMetadata,
  YouTubeTrendVideo,
} from '../types/studio';

interface AiTranslationSeoPayload {
  detected_topic?: string;
  youtube_search_query?: string;
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
): Promise<{ items: YouTubeTrendVideo[]; connected: boolean }> {
  return fetchYouTubeTrendsFromApi(topicQuery, signal);
}

function normalizeBeats(
  rawBeats: AiTranslationSeoPayload['beats'],
  voiceover: string,
  lockedDurationSec: number
): ScriptBeat[] {
  const safeDur = Math.max(1.5, lockedDurationSec - 0.3);

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

function formatHour12(hour24: number): string {
  const h = ((hour24 % 24) + 24) % 24;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
}

function customizeSeoWithNicheYouTubeTrends(params: {
  detectedTopic: string;
  language: OutputLanguage;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  postingTime: string;
  trends: YouTubeTrendVideo[];
}): {
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  postingTime: string;
} {
  const { detectedTopic, language, trends } = params;
  if (trends.length === 0) {
    return {
      title: params.title,
      description: params.description,
      tags: params.tags,
      hashtags: params.hashtags,
      postingTime: params.postingTime,
    };
  }

  let postingTime = params.postingTime;
  const validPubDates = trends
    .map((t) => (t.publishedAt ? new Date(t.publishedAt) : null))
    .filter((d): d is Date => Boolean(d && !Number.isNaN(d.getTime())));
  if (validPubDates.length > 0) {
    const avgUtcHour = Math.round(
      validPubDates.reduce((acc, d) => acc + d.getUTCHours(), 0) / validPubDates.length
    );
    const estStart = (avgUtcHour - 5 + 24) % 24;
    const estEnd = (estStart + 2) % 24;
    const istStart = (avgUtcHour + 5) % 24;
    const istEnd = (istStart + 2) % 24;
    postingTime =
      language === 'hi'
        ? `यूट्यूब ट्रेंड पीक (${trends.length} लाइव शॉर्ट्स): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`
        : `YouTube US Niche Peak (${trends.length} live Shorts · ${detectedTopic || 'Topic'}): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`;
  }

  // Keep Hindi Title, Description, Tags, Hashtags, and Upload Time strictly in Hindi (no English tag injection)
  if (language === 'hi') {
    return {
      title: params.title,
      description: params.description.trim(),
      tags: params.tags,
      hashtags: params.hashtags,
      postingTime,
    };
  }

  // Extract real niche keywords from top-viewed US Shorts returned by YouTube Data API v3
  const nicheKeywords: string[] = [];
  for (const t of trends) {
    for (const tg of t.tags ?? []) {
      const clean = tg.trim().toLowerCase();
      if (clean.length >= 3 && clean.length <= 32 && !nicheKeywords.includes(clean)) {
        nicheKeywords.push(clean);
      }
    }
  }

  const existingTags = params.tags
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const mergedTags = [
    ...(detectedTopic ? [detectedTopic.toLowerCase()] : []),
    ...existingTags,
    ...nicheKeywords.slice(0, 6),
  ]
    .filter((v, i, arr) => v.length > 1 && arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
    .slice(0, 14)
    .join(', ');

  const existingHashtags = params.hashtags
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nicheHashtags = nicheKeywords
    .slice(0, 3)
    .map((kw) => `#${kw.replace(/[^\p{L}\p{N}]+/gu, '')}`)
    .filter((h) => h.length > 3);
  const mergedHashtags = [...existingHashtags, ...nicheHashtags]
    .filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
    .slice(0, 7)
    .join(' ');

  const topTrendRef = trends[0]?.title?.trim();
  const description =
    topTrendRef && nicheKeywords.length > 0 && !params.description.toLowerCase().includes(nicheKeywords[0])
      ? `${params.description}\n\nTrending niche keywords: ${nicheKeywords.slice(0, 4).join(' • ')}`
      : params.description;

  return {
    title: params.title,
    description: description.trim(),
    tags: mergedTags,
    hashtags: mergedHashtags,
    postingTime,
  };
}

/**
 * STEP 3 (Real Vision-to-Action + Live Niche YouTube Trend Customization):
 * 1) Sends the 6-frame aspect-preserving JPEG contact sheet to the vision worker
 *    (`gemini-4-hydrogen` / `nvidia/nemotron-3.5-super-vl-120b-a12b`) to identify the real
 *    objects and step-by-step physical actions on screen (never generic filler).
 * 2) Passes the detected real topic into YouTube Data API v3 (`regionCode=US`,
 *    `videoDuration=short`, `order=viewCount`, 1 single API call) to fetch real trending
 *    US Shorts for that exact niche and customize Title, Description, Tags, Hashtags, and EST/IST Upload Time.
 */
export async function translateClipAndBuildSeoStep3(params: {
  clip: PreparedVisualClip;
  sourceLabel: string;
  language: OutputLanguage;
  aiEngine: AiEnginePreference;
  customAngle: string;
  trends: YouTubeTrendVideo[];
  allowYouTubeLookup?: boolean;
  signal?: AbortSignal;
  onStatus?: (detail: string) => void;
  onConnectionPatch?: (patch: Partial<ConnectionStatusState>) => void;
}): Promise<TrendMetadata & { fetchedTrends?: YouTubeTrendVideo[] }> {
  const {
    clip,
    sourceLabel,
    language,
    aiEngine,
    customAngle,
    trends: preloadedTrends,
    allowYouTubeLookup = true,
    signal,
    onStatus,
    onConnectionPatch,
  } = params;

  const targetDurSec = clip.lockedVisualDurationSec;
  const maxSpeechSec = Math.max(2, targetDurSec - 0.35);
  // Energetic, crisp explainer pacing (~2.45 words/sec) fitted cleanly inside exact clip duration
  const targetWordCount = Math.max(12, Math.round(maxSpeechSec * 2.45));
  const safeTopicHint =
    extractReadableTopicFromLabel(sourceLabel, customAngle) ||
    'Identify directly from the 6 video frames (ignore numeric filename)';

  const languageName =
    language === 'hi'
      ? 'Hindi (pure, punchy, dramatic Devanagari Hindi)'
      : 'English (USA — sharp, dramatic, high-emotion American Shorts storytelling English)';
  const strictLanguageRule =
    language === 'hi'
      ? 'Write voiceover, beats, title, description, tags, hashtags, and posting_time STRICTLY in Devanagari Hindi (keeping only EST/IST timezone abbreviations).'
      : 'Write voiceover, beats, title, description, tags, hashtags, and posting_time STRICTLY in natural American English (USA).';
  const hookEndSec = Number(Math.min(1.6, Math.max(1.1, maxSpeechSec * 0.18)).toFixed(1));
  const targetBeatCount = Math.max(3, Math.min(6, Math.round(maxSpeechSec / 3.5)));
  const beatSpanSec = Number(((maxSpeechSec - hookEndSec) / Math.max(1, targetBeatCount - 1)).toFixed(1));
  const beat2EndSec = Number(Math.min(maxSpeechSec - 0.8, hookEndSec + beatSpanSec).toFixed(1));
  const beat3EndSec = Number(Math.min(maxSpeechSec - 0.4, beat2EndSec + beatSpanSec).toFixed(1));

  const systemPrompt = `You are a top on-camera YouTube Shorts & Reels creator and viral SEO strategist speaking directly to viewers to maximize 100%+ retention.
You are inspecting a 3x2 contact sheet of 6 evenly spaced frames (timestamps T=0.0s to T=${targetDurSec.toFixed(1)}s) taken directly from the user's real video.

TOP-CREATOR HIGH-RETENTION RULES:
1. 1.5-SECOND PATTERN-INTERRUPT HOOK: Beat 1 (0.0s to ${hookEndSec}s) MUST hit immediately with a sharp curiosity trigger or pattern-interrupt directly tied to Frame 1—speak directly to the viewer so nobody scrolls past!
2. MICRO-TWISTS EVERY 3–4 SECONDS: Break the narration into ${targetBeatCount} fast, punchy, crystal-clear beats spaced every ~3–4 seconds—each beat drops a fresh visual reveal, tension spike, or micro-twist strictly explaining what is happening on screen in Frames 1–6.
3. ZERO FILLER OR CANNED TEXT: Strictly FORBIDDEN phrases include "opening frame", "turning point", "second mark", "core detail", "wasted motion", "contact sheet", "crayon", or raw filenames like "1000179945".
4. EXACT DURATION FIT: Write ~${targetWordCount} energetic, crystal-clear spoken words so delivery finishes cleanly before ${maxSpeechSec.toFixed(1)}s with zero cutoffs.
5. STRICT LANGUAGE LOCK: ${strictLanguageRule} Return non-empty values for ALL JSON fields. Return ONLY valid JSON.`;

  const userPrompt = `CLIP HINT: ${safeTopicHint}
CLIP SEGMENT: Clip ${clip.clipIndex} of ${clip.totalClips} (locked duration: ${targetDurSec.toFixed(1)}s, frame timestamps: ${clip.stampedTimestampsSec.map((t) => `${t.toFixed(1)}s`).join(', ')})
OUTPUT LANGUAGE: ${languageName}
KEY POINTS TO KEEP: ${customAngle.trim() || 'Speak like a top creator: hit a sharp 1.5s curiosity pattern-interrupt, drop micro-twists every 3-4 seconds matching the exact real action across frames 1-6, and end on a punchy payoff.'}

RETURN STRICT JSON ONLY:
{
  "detected_topic": "Exact real subject/action visible on screen (2-5 words)",
  "youtube_search_query": "2-4 clean English YouTube Shorts search words for this exact niche",
  "voiceover": "Top-creator direct-to-viewer narration starting with a 1.5s pattern-interrupt hook, micro-twists every 3-4s, and crystal-clear on-screen explanation (~${targetWordCount} words, finishes before ${maxSpeechSec.toFixed(1)}s) in ${languageName}",
  "beats": [
    { "start_sec": 0.0, "end_sec": ${hookEndSec}, "text": "Sharp 1.5s curiosity trigger / pattern-interrupt referencing frame 1 directly" },
    { "start_sec": ${hookEndSec}, "end_sec": ${beat2EndSec}, "text": "Micro-twist 1 (~3-4s): crisp, energetic explanation of the action in frames 2-3" },
    { "start_sec": ${beat2EndSec}, "end_sec": ${beat3EndSec}, "text": "Micro-twist 2 (~3-4s): rising tension & unexpected shift in frames 4-5" },
    { "start_sec": ${beat3EndSec}, "end_sec": ${maxSpeechSec.toFixed(1)}, "text": "Final punchy payoff/reveal shown in frame 6" }
  ],
  "title": "Curiosity-gap high-CTR title (<= 75 chars) strictly in ${languageName}",
  "description": "High-retention creator SEO description summarizing the hook/twist + CTA strictly in ${languageName}",
  "tags": "8-12 comma-separated niche tags strictly in ${languageName}",
  "hashtags": "5-6 niche hashtags starting with # strictly in ${languageName}",
  "posting_time": "Best Upload Window with both USA EST and India IST peak hours strictly in ${languageName}"
}`;

  onStatus?.(
    `Analyzing 6 video frames for real objects & actions (Clip ${clip.clipIndex}/${clip.totalClips})...`
  );

  const aiResponse = await runSingleClipAiRequest({
    preference: aiEngine,
    systemPrompt,
    userPrompt,
    imageBase64Jpeg: clip.stampedContactSheetJpeg || undefined,
    signal,
  });

  if (!aiResponse || !aiResponse.rawText.trim()) {
    if (aiResponse?.provider === 'gemini') {
      onConnectionPatch?.({
        gemini: aiResponse.quotaExhausted ? 'Quota-Limit' : 'Fallback',
      });
    } else if (aiResponse?.provider === 'nvidia') {
      onConnectionPatch?.({
        nvidia: aiResponse.corsBlocked
          ? 'Static-Skip'
          : aiResponse.keyMissing
          ? 'Key-Missing'
          : aiResponse.quotaExhausted
          ? 'Quota-Limit'
          : 'Fallback',
      });
    }

    let fallbackTrends = preloadedTrends;
    if (allowYouTubeLookup && fallbackTrends.length === 0) {
      const fallbackQuery =
        extractReadableTopicFromLabel(sourceLabel, customAngle) ||
        (language === 'hi' ? 'viral shorts explainer hindi' : 'viral shorts explained');
      const ytRes = await fetchYouTubeTrendsFromApi(fallbackQuery, signal);
      fallbackTrends = ytRes.items;
      onConnectionPatch?.({ youtube: ytRes.connected ? 'Connected' : 'Fallback' });
    }

    const offlineOut = generateOfflineDirectTranslationAndMetadata({
      clip,
      sourceLabel,
      language,
      customAngle,
      trends: fallbackTrends,
      fallbackReason: aiResponse?.errorReason ?? 'Local mode',
    });
    return { ...offlineOut, fetchedTrends: fallbackTrends };
  }

  const parsed = extractJsonObject<AiTranslationSeoPayload>(aiResponse.rawText);
  if (!parsed || !parsed.voiceover || parsed.voiceover.trim().length < 8) {
    const offlineOut = generateOfflineDirectTranslationAndMetadata({
      clip,
      sourceLabel,
      language,
      customAngle,
      trends: preloadedTrends,
      fallbackReason: `${aiResponse.modelUsed} returned non-JSON`,
    });
    return { ...offlineOut, fetchedTrends: preloadedTrends };
  }

  if (aiResponse.provider === 'gemini') {
    onConnectionPatch?.({ gemini: 'Connected' });
  } else if (aiResponse.provider === 'nvidia') {
    onConnectionPatch?.({ nvidia: 'Connected' });
  }

  // Pass the REAL vision-detected topic into YouTube Data API v3 (1 single API call)
  const detectedTopic = (parsed.detected_topic ?? '').trim();
  const nicheQuery =
    (parsed.youtube_search_query ?? '').trim() ||
    detectedTopic ||
    extractReadableTopicFromLabel(sourceLabel, customAngle) ||
    'viral shorts explained';

  let activeTrends = preloadedTrends;
  if (allowYouTubeLookup && activeTrends.length === 0) {
    onStatus?.(
      `Fetching live US YouTube Shorts trends for "${nicheQuery}" (1 API call)...`
    );
    const ytRes = await fetchYouTubeTrendsFromApi(nicheQuery, signal);
    activeTrends = ytRes.items;
    onConnectionPatch?.({ youtube: ytRes.connected ? 'Connected' : 'Fallback' });
  }

  const offlineDefaults = generateOfflineDirectTranslationAndMetadata({
    clip,
    sourceLabel,
    language,
    customAngle: detectedTopic || customAngle,
    trends: activeTrends,
  });

  const voiceover = parsed.voiceover.trim();
  const beats = normalizeBeats(parsed.beats, voiceover, targetDurSec);

  const customizedSeo = customizeSeoWithNicheYouTubeTrends({
    detectedTopic,
    language,
    title: (parsed.title?.trim() || offlineDefaults.title).slice(0, 100),
    description: parsed.description?.trim() || offlineDefaults.description,
    tags: normalizeCommaList(parsed.tags, offlineDefaults.tags),
    hashtags: normalizeHashtags(parsed.hashtags, offlineDefaults.hashtags),
    postingTime: parsed.posting_time?.trim() || offlineDefaults.postingTime,
    trends: activeTrends,
  });

  return {
    voiceover,
    beats,
    title: customizedSeo.title.slice(0, 100),
    description: customizedSeo.description,
    tags: customizedSeo.tags,
    hashtags: customizedSeo.hashtags,
    postingTime: customizedSeo.postingTime,
    scriptEngine: `${aiResponse.modelUsed}${detectedTopic ? ` · Topic: ${detectedTopic}` : ''}${activeTrends.length > 0 ? ` + YouTube US (${activeTrends.length})` : ''}`,
    youtubeTrendsCount: activeTrends.length,
    fetchedTrends: activeTrends,
  };
}
