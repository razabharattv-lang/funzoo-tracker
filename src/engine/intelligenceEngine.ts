import type {
  DocumentaryChapter,
  OutputLanguage,
  PreparedVisualClip,
  ScriptBeat,
  SourceMediaItem,
  StudioConfig,
  TrendMetadata,
  YouTubeTrendVideo,
} from '../types/studio';
import {
  buildUsableIntervals,
  finalizeCropAndTrimDecision,
  formatRelSecondStamp,
  hasNonZeroInsets,
  sanitizeWatermarkZones,
} from './visualClipper';
import {
  callServerGeminiJson,
  fetchWithTimeout,
  runStep1VisionJson,
  runStep3ScriptJson,
} from './modelRouter';
import {
  generateOfflineExplainerScriptAndMetadata,
  inspectClipOfflineFromContactSheet,
} from './offlineModels';

const API_TIMEOUT_MS = 12_000;
const SERVER_EDIT_TIMEOUT_MS = 35_000;

export interface Stage2ClipInspection {
  coreTopic: string;
  climaxSecond: number;
  beats: ScriptBeat[];
  searchQueries: string[];
  visionModel: string;
  /** Updated PreparedVisualClip with any newly detected short-clip watermark zones merged */
  updatedClip: PreparedVisualClip;
}

/**
 * Strict Video-First Spoken-Word Budget:
 * - English: Math.floor(lockedVisualDurationSec * 2.1)
 * - Hindi:   Math.floor(lockedVisualDurationSec * 1.9)
 * Guarantees narration finishes ~0.5s before clip end with zero mid-sentence cutoff.
 */
export function getStrictWordBudget(
  lockedVisualDurationSec: number,
  language: OutputLanguage
): number {
  const rate = language === 'hi' ? 1.9 : 2.1;
  return Math.max(12, Math.floor(lockedVisualDurationSec * rate));
}

// Shared API helpers now routed centrally via ./modelRouter

function cleanSpokenLine(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/["“”*#_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function trimTextToWordLimit(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  const sliced = words.slice(0, Math.max(4, maxWords));
  // Prefer ending cleanly on a sentence boundary if one exists in the last 35%
  for (let i = sliced.length - 1; i >= Math.floor(sliced.length * 0.65); i--) {
    if (/[.!?।]$/.test(sliced[i])) {
      return sliced.slice(0, i + 1).join(' ');
    }
  }
  const joined = sliced.join(' ').replace(/[,;:\-]+$/, '');
  return /[.!?।]$/.test(joined) ? joined : `${joined}.`;
}

/**
 * Guarantees chronological, monotonic ScriptBeats whose combined spoken words
 * stay strictly within maxWords and finish at least 0.5s before lockedVisualDurationSec.
 */
export function enforceStrictWordBudgetAndBeats(params: {
  rawBeats: unknown;
  fallbackVoiceover: string;
  lockedVisualDurationSec: number;
  language: OutputLanguage;
}): { beats: ScriptBeat[]; voiceover: string } {
  const { rawBeats, fallbackVoiceover, lockedVisualDurationSec, language } =
    params;
  const maxWords = getStrictWordBudget(lockedVisualDurationSec, language);
  const targetFinishSec = Number(
    Math.max(2.5, lockedVisualDurationSec - 0.5).toFixed(2)
  );

  const parsedBeats: ScriptBeat[] = [];
  if (Array.isArray(rawBeats)) {
    for (const item of rawBeats) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const text = cleanSpokenLine(String(obj.text ?? obj.line ?? ''));
      if (!text) continue;
      const startRaw = Number(obj.startSec ?? obj.start_sec);
      const endRaw = Number(obj.endSec ?? obj.end_sec);
      const startSec = Number.isFinite(startRaw) ? startRaw : 0;
      const endSec = Number.isFinite(endRaw) ? endRaw : startSec + 2.5;
      parsedBeats.push({ startSec, endSec, text });
    }
  }

  // If no structured beats returned, split fallbackVoiceover into clean chronological beats
  if (parsedBeats.length === 0) {
    const trimmedVo = trimTextToWordLimit(
      cleanSpokenLine(fallbackVoiceover),
      maxWords
    );
    const sentences = trimmedVo
      .split(/(?<=[.!?।])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const parts = sentences.length > 0 ? sentences : [trimmedVo];
    const totalW = Math.max(1, countWords(trimmedVo));
    let cursor = 0;
    const autoBeats: ScriptBeat[] = parts.map((sent, idx) => {
      const share = countWords(sent) / totalW;
      const dur = Math.max(0.8, targetFinishSec * share);
      const startSec = Number(cursor.toFixed(2));
      const endSec = Number(
        (idx === parts.length - 1
          ? targetFinishSec
          : Math.min(targetFinishSec, cursor + dur)
        ).toFixed(2)
      );
      cursor = endSec;
      return { startSec, endSec, text: sent };
    });
    return {
      beats: autoBeats,
      voiceover: autoBeats.map((b) => b.text).join(' '),
    };
  }

  // Sort strictly forward and enforce word budget across beats
  parsedBeats.sort((a, b) => a.startSec - b.startSec);
  const budgeted: ScriptBeat[] = [];
  let usedWords = 0;

  for (let i = 0; i < parsedBeats.length; i++) {
    const b = parsedBeats[i];
    const remaining = maxWords - usedWords;
    if (remaining <= 2) break;
    const lineWords = countWords(b.text);
    const finalLine =
      lineWords <= remaining ? b.text : trimTextToWordLimit(b.text, remaining);
    usedWords += countWords(finalLine);
    budgeted.push({
      startSec: b.startSec,
      endSec: b.endSec,
      text: finalLine,
    });
  }

  // Re-normalize beat timestamps proportionally inside [0, targetFinishSec]
  const totalBudgetWords = Math.max(
    1,
    budgeted.reduce((sum, b) => sum + countWords(b.text), 0)
  );
  let cursor = 0;
  const normalized: ScriptBeat[] = budgeted.map((b, idx) => {
    const wordShare = countWords(b.text) / totalBudgetWords;
    const span = Math.max(0.7, targetFinishSec * wordShare);
    const startSec = Number(cursor.toFixed(2));
    const endSec = Number(
      (idx === budgeted.length - 1
        ? targetFinishSec
        : Math.min(targetFinishSec, cursor + span)
      ).toFixed(2)
    );
    cursor = endSec;
    return { startSec, endSec, text: b.text };
  });

  return {
    beats: normalized,
    voiceover: normalized.map((b) => b.text).join(' '),
  };
}

function buildFallbackBeats(
  topic: string,
  lockedVisualDurationSec: number,
  language: OutputLanguage
): ScriptBeat[] {
  const cleanTopic = topic.trim() || 'this hidden moment';
  const rawVoiceover =
    language === 'hi'
      ? `रुकिए! पहले सेकंड में ${cleanTopic} बिल्कुल नॉर्मल लगता है। लेकिन ध्यान से देखिए बीच में सब कुछ कैसे बदलता है। निन्यानवे प्रतिशत लोग यहीं चूक जाते हैं। आखिरी ट्विस्ट देखकर आप दोबारा शुरू से देखेंगे!`
      : `Wait—at first glance ${cleanTopic} looks completely normal. Watch closely as everything shifts right on screen. Almost everyone misses this exact turn. And once you see the ending, you will immediately watch it again!`;

  return enforceStrictWordBudgetAndBeats({
    rawBeats: [],
    fallbackVoiceover: rawVoiceover,
    lockedVisualDurationSec,
    language,
  }).beats;
}

/**
 * STAGE 2A — Inspect the Already-Cut, Cleaned & Stamped Visual Clip (1-Call Quota Lock):
 * Sends the 9-frame relative-second stamped contact sheet (`00:01s`..`00:{lockedVisualDurationSec}s`)
 * in strictly ONE Gemini Vision (`gemini-3.8-flash`, fallback `gemini-3.5-flash`) call
 * to produce chronological timestamped visual beats strictly matching the finished frames.
 */
export async function inspectLockedVisualClipOneCall(params: {
  source: SourceMediaItem;
  preparedClip: PreparedVisualClip;
  language: OutputLanguage;
  customAngle: string;
  nvidiaApiKey?: string;
  signal?: AbortSignal;
}): Promise<Stage2ClipInspection> {
  const {
    source,
    preparedClip,
    language,
    customAngle,
    nvidiaApiKey = '',
    signal,
  } = params;

  const dur = preparedClip.lockedVisualDurationSec;
  const maxWords = getStrictWordBudget(dur, language);
  const finishSec = Number(Math.max(2.5, dur - 0.5).toFixed(1));
  const stampList = preparedClip.stampedTimestampsSec
    .map((s) => formatRelSecondStamp(s))
    .join(', ');

  const langRule =
    language === 'hi'
      ? 'Write spoken beats in urgent, punchy conversational Hindi (Devanagari script).'
      : 'Write spoken beats in punchy, commanding American English.';

  const includeShortWatermarkCheck = source.mode === 'short';
  const watermarkPromptBlock = includeShortWatermarkCheck
    ? `
Also inspect each frame tile for any remaining platform/creator watermark or handle (ignore our dark top-left timestamp badge):
- "safe_edge_crop": ONLY if <= 12% from an outer edge AND cropping will NOT cut the main subject (output safe_crop_insets 0.00..0.12).
- "gpu_delogo_patch": if watermark sits over inner scene or moves across timestamps (set safe_crop_insets to 0 on that side; output [ymin, xmin, ymax, xmax] 0-1000 + relative startSec/endSec).
- "trim_bumper": if an intro or outro creator logo bumper still appears at start/end.
`
    : '';

  const prompt = `
You are an elite viral short-form explainer director writing a tightly synced voiceover for an ALREADY-CUT, FINALIZED ${dur.toFixed(
    1
  )}-second visual clip.
This single 3x3 contact sheet shows 9 chronological frames from the finished clip stamped with exact relative seconds: [${stampList}] (total clip duration: ${dur.toFixed(
    1
  )}s).
${customAngle ? `Creator suspense angle: "${customAngle}"` : ''}

CRITICAL SYNC & WORD-BUDGET RULES:
1. ${langRule}
2. STRICT WORD BUDGET: Total words across ALL beats combined MUST BE <= ${maxWords} spoken words so narration finishes cleanly by ${finishSec}s (0.5s before the ${dur.toFixed(
    1
  )}s clip ends—NEVER run past the end).
3. STRICT CHRONOLOGICAL VISUAL SYNC: Describe ONLY what is visibly happening at each stamped second in exact forward order (0.0s immediate hook -> middle visual escalation -> payoff -> seamless loop ending).
4. Plain spoken words ONLY inside each beat's "text" (no stage directions, no brackets, no emojis).
${watermarkPromptBlock}

Return ONLY valid JSON:
{
  "core_topic": "Exact specific object, action, or story visible on screen",
  "climax_second": ${Math.min(finishSec - 1, Math.max(2.5, dur * 0.55)).toFixed(1)},
  "search_queries": ["US Shorts query 1", "US Shorts query 2", "US Shorts query 3"],
  "beats": [
    {"startSec": 0.0, "endSec": 2.5, "text": "Immediate scroll-stopping hook describing frame 1."},
    {"startSec": 2.5, "endSec": ${Math.min(finishSec, 7.0).toFixed(1)}, "text": "Next visible visual shift on screen."}
  ]${
    includeShortWatermarkCheck
      ? `,
  "safe_crop_insets": {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0},
  "watermark_zones": []`
      : ''
  }
}
`.trim();

  let res: { parsed: Record<string, unknown>; modelUsed: string } | null = null;
  try {
    res =
      source.mode === 'short'
        ? await runStep1VisionJson({
            nvidiaApiKey,
            systemPrompt:
              'You are a viral US Shorts director and watermark inspector. Output strictly valid JSON.',
            userPrompt: prompt,
            imageBase64Jpeg: preparedClip.stampedContactSheetJpeg,
            signal,
          })
        : await callServerGeminiJson({
            prompt,
            systemInstruction:
              'You are an elite viral short-form explainer director. Output strictly valid JSON.',
            imageBase64Jpeg: preparedClip.stampedContactSheetJpeg,
            signal,
          });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    res = null;
  }

  if (!res) {
    const offlineInspection = inspectClipOfflineFromContactSheet({
      source,
      preparedClip,
      language,
      customAngle,
    });
    const enforced = enforceStrictWordBudgetAndBeats({
      rawBeats: offlineInspection.beats,
      fallbackVoiceover: offlineInspection.beats.map((b) => b.text).join(' '),
      lockedVisualDurationSec: dur,
      language,
    });
    return {
      coreTopic: offlineInspection.coreTopic,
      climaxSecond: offlineInspection.climaxSecond,
      beats: enforced.beats,
      searchQueries: offlineInspection.searchQueries,
      visionModel: offlineInspection.visionModel,
      updatedClip: preparedClip,
    };
  }

  const { parsed, modelUsed } = res;
  const coreTopic = String(
    parsed.core_topic || customAngle || preparedClip.reason || 'Viral short moment'
  ).trim();

  // Merge newly detected adaptive watermark zones on short clips (offsetting relative sec to source sec)
  let updatedClip = preparedClip;
  if (includeShortWatermarkCheck) {
    const relZones = sanitizeWatermarkZones(
      parsed.watermark_zones ?? parsed.watermarkZones,
      parsed.watermark_boxes,
      dur,
      0,
      dur
    );
    const mappedToSourceZones = relZones.map((z) => ({
      ...z,
      startSec: Number(
        Math.min(source.durationSec, preparedClip.trimRange.startSec + z.startSec).toFixed(2)
      ),
      endSec: Number(
        Math.min(source.durationSec, preparedClip.trimRange.startSec + z.endSec).toFixed(2)
      ),
    }));

    const existingBumpers = preparedClip.watermarkZones.filter(
      (z) => z.action === 'trim_bumper'
    );
    const combinedZones = [...existingBumpers, ...mappedToSourceZones];

    const decision = finalizeCropAndTrimDecision({
      rawSafeInsets: parsed.safe_crop_insets ?? parsed.safeCropInsets,
      rawTrimRange: preparedClip.trimRange,
      zones: combinedZones,
      windowStartSec: preparedClip.trimRange.startSec,
      windowEndSec: preparedClip.trimRange.endSec,
      totalDurationSec: source.durationSec,
      enforceSocialEndCard: source.trimSocialEndCard,
      platform: source.platform,
    });

    const intervalInfo = buildUsableIntervals(
      decision.trimRange,
      decision.zones,
      source.durationSec
    );

    updatedClip = {
      ...preparedClip,
      trimRange: decision.trimRange,
      usableIntervals: intervalInfo.usableIntervals,
      lockedVisualDurationSec: intervalInfo.lockedVisualDurationSec,
      bumperTrimmedSec: intervalInfo.bumperTrimmedSec,
      safeCropInsets: decision.safeCropInsets,
      watermarkZones: decision.zones,
      safeCropApplied: hasNonZeroInsets(decision.safeCropInsets),
      delogoZoneCount: decision.zones.filter(
        (z) => z.action === 'gpu_delogo_patch'
      ).length,
    };
  }

  const effectiveDur = updatedClip.lockedVisualDurationSec;
  const climaxNum = Number(parsed.climax_second);
  const safeClimax =
    Number.isFinite(climaxNum) &&
    climaxNum > 2.5 &&
    climaxNum < effectiveDur - 1.5
      ? Number(climaxNum.toFixed(2))
      : Number((effectiveDur * 0.52).toFixed(2));

  updatedClip = { ...updatedClip, climaxSec: safeClimax };

  const fallbackVo = buildFallbackBeats(coreTopic, effectiveDur, language)
    .map((b) => b.text)
    .join(' ');
  const { beats } = enforceStrictWordBudgetAndBeats({
    rawBeats: parsed.beats,
    fallbackVoiceover: fallbackVo,
    lockedVisualDurationSec: effectiveDur,
    language,
  });

  const searchQueries = Array.isArray(parsed.search_queries)
    ? (parsed.search_queries as string[]).filter(Boolean).slice(0, 3)
    : [coreTopic];

  return {
    coreTopic,
    climaxSecond: safeClimax,
    beats,
    searchQueries,
    visionModel: modelUsed,
    updatedClip,
  };
}

export async function fetchLiveYouTubeTrends(
  queries: string[],
  youtubeApiKey: string,
  signal?: AbortSignal
): Promise<YouTubeTrendVideo[]> {
  if (!youtubeApiKey) return [];

  const publishedAfter = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const videoIds: string[] = [];
  const seen = new Set<string>();

  await Promise.all(
    queries.slice(0, 2).map(async (rawQ) => {
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
        const resp = await fetchWithTimeout(
          url.toString(),
          { method: 'GET' },
          signal,
          API_TIMEOUT_MS
        );
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
        if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
      }
    })
  );

  if (videoIds.length === 0) return [];

  try {
    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.searchParams.set('part', 'snippet,statistics');
    detailsUrl.searchParams.set('id', videoIds.slice(0, 12).join(','));
    detailsUrl.searchParams.set('key', youtubeApiKey);

    const detailsResp = await fetchWithTimeout(
      detailsUrl.toString(),
      { method: 'GET' },
      signal,
      API_TIMEOUT_MS
    );
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

    const trends: YouTubeTrendVideo[] = (detailsData.items ?? []).map(
      (item) => ({
        title: item.snippet?.title ?? '',
        channel: item.snippet?.channelTitle ?? '',
        publishedAt: item.snippet?.publishedAt ?? '',
        viewCount: parseInt(item.statistics?.viewCount ?? '0', 10) || 0,
        likeCount: parseInt(item.statistics?.likeCount ?? '0', 10) || 0,
        tags: (item.snippet?.tags ?? []).slice(0, 15),
      })
    );

    trends.sort((a, b) => b.viewCount - a.viewCount);
    return trends.slice(0, 10);
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return [];
  }
}

/**
 * STEP 3 — Beat-Synced Script & US Trends:
 * Routes across Mistral Large 4 / glm-5-3-flash / nemotron-3.5-lightning-30b-a3b /
 * riva-translate-4b-instruct-v2 / nemotron-3.5-content-safety / gemini-3.8-flash,
 * grounded in live US YouTube Shorts trends while strictly locking total spoken
 * words to <= maxWords so narration ALWAYS completes 0.5s before clip end.
 */
export async function refineBeatSyncedScriptAndMetadata(params: {
  inspection: Stage2ClipInspection;
  trends: YouTubeTrendVideo[];
  language: OutputLanguage;
  customAngle: string;
  config: StudioConfig;
  signal?: AbortSignal;
}): Promise<TrendMetadata> {
  const { inspection, trends, language, customAngle, config, signal } = params;
  const clip = inspection.updatedClip;
  const dur = clip.lockedVisualDurationSec;
  const maxWords = getStrictWordBudget(dur, language);
  const finishSec = Number(Math.max(2.5, dur - 0.5).toFixed(1));

  const langLabel =
    language === 'hi'
      ? 'Hindi (urgent, punchy conversational Hindi in Devanagari script)'
      : 'American English (commanding, high-retention US suspense storyteller)';

  const trendsBlock =
    trends.length > 0
      ? `LIVE YOUTUBE DATA API v3 TOP US SHORTS:\n${JSON.stringify(trends)}`
      : 'Derive high-CTR US Shorts titles, 15 tags, 7 hashtags, and peak USA EST + India IST upload time.';

  const prompt = `
You are an elite viral US YouTube Shorts script editor and SEO strategist.

LOCKED VISUAL CLIP DURATION: ${dur.toFixed(1)}s (narration MUST finish by ${finishSec}s)
STRICT MAXIMUM WORD BUDGET: <= ${maxWords} spoken words total (NEVER exceed ${maxWords} words!)
CORE TOPIC: ${inspection.coreTopic}
MID-CLIP CLIMAX SECOND: ${inspection.climaxSecond}s
CHRONOLOGICAL VISUAL BEATS OBSERVED ON SCREEN:
${JSON.stringify(inspection.beats)}
${customAngle ? `CREATOR ANGLE: "${customAngle}"` : ''}

${trendsBlock}

OUTPUT LANGUAGE: ${langLabel}

STRICT RULES:
1. Refine the chronological "beats" array so every timestamped beat explains what is visibly happening on screen at that exact second—opening with an immediate scroll-stopping hook and ending with a seamless loop line.
2. Total words across ALL beats combined MUST be <= ${maxWords} words so the voiceover finishes 0.5s before the ${dur.toFixed(
    1
  )}s clip ends.
3. Plain spoken words ONLY inside each beat's "text" (no brackets, no emojis, no stage directions).
4. "title": High-CTR US Shorts title (max 68 chars).
5. "description": 2-line SEO description with high-retention keywords.
6. "tags": 15 specific comma-separated trending tags.
7. "hashtags": 7 targeted hashtags starting with # separated by spaces.
8. "posting_time": Best Upload Time with BOTH USA EST + India IST.

Return ONLY valid JSON:
{
  "beats": [
    {"startSec": 0.0, "endSec": 2.5, "text": "..."}
  ],
  "title": "...",
  "description": "...",
  "tags": "...",
  "hashtags": "...",
  "posting_time": "..."
}
`.trim();

  let routed: { parsed: Record<string, unknown>; modelUsed: string } | null =
    null;
  try {
    routed = await runStep3ScriptJson({
      config,
      language,
      systemPrompt:
        'You are an elite viral US YouTube Shorts suspense scriptwriter and SEO strategist. Output strictly valid JSON only.',
      userPrompt: prompt,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    routed = null;
  }

  const parsed = routed?.parsed ?? null;
  const scriptEngine = routed?.modelUsed || `${inspection.visionModel} Beat Sync`;
  const visionFallbackVoiceover = inspection.beats.map((b) => b.text).join(' ');

  if (!parsed) {
    const enforced = enforceStrictWordBudgetAndBeats({
      rawBeats: inspection.beats,
      fallbackVoiceover: visionFallbackVoiceover,
      lockedVisualDurationSec: dur,
      language,
    });
    return generateOfflineExplainerScriptAndMetadata({
      coreTopic: inspection.coreTopic,
      beats: enforced.beats,
      lockedVisualDurationSec: dur,
      language,
      trends,
    });
  }

  const enforced = enforceStrictWordBudgetAndBeats({
    rawBeats: parsed.beats,
    fallbackVoiceover: String(parsed.voiceover || visionFallbackVoiceover),
    lockedVisualDurationSec: dur,
    language,
  });

  return {
    voiceover: enforced.voiceover,
    beats: enforced.beats,
    title: String(parsed.title || inspection.coreTopic).trim(),
    description: String(parsed.description || '').trim(),
    tags: String(parsed.tags || '').trim(),
    hashtags: String(parsed.hashtags || '').trim(),
    postingTime: String(
      parsed.posting_time ||
        '6:30 PM EST / 5:00 AM IST — Peak US Evening & Early India Feed'
    ).trim(),
    scriptEngine,
    youtubeTrendsCount: trends.length,
  };
}

/**
 * STEP 3 (Documentary / Motion Graphics / 3D-Blender Mode):
 * Refines each chapter's chronological beat-synced narration & US trend SEO deck
 * strictly within the chapter's word budget so voiceover finishes 0.5s before scene end.
 */
export async function refineDocumentaryChapterScriptAndMetadata(params: {
  chapter: DocumentaryChapter;
  seriesTitle: string;
  trends: YouTubeTrendVideo[];
  language: OutputLanguage;
  customAngle: string;
  config: StudioConfig;
  signal?: AbortSignal;
}): Promise<TrendMetadata> {
  const {
    chapter,
    seriesTitle,
    trends,
    language,
    customAngle,
    config,
    signal,
  } = params;

  const dur = chapter.targetDurationSec;
  const maxWords = getStrictWordBudget(dur, language);
  const finishSec = Number(Math.max(2.5, dur - 0.5).toFixed(1));
  const langLabel =
    language === 'hi'
      ? 'Hindi (authoritative punchy Devanagari script)'
      : 'American English (cinematic US documentary / explainer narrator)';

  const prompt = `
You are an executive YouTube Shorts documentary & motion-graphics writer.

SERIES TITLE: ${seriesTitle}
CHAPTER ${chapter.chapterIndex}/${chapter.totalChapters}: ${chapter.title}
VISUAL STYLE: ${chapter.style} (${chapter.visualPrompt})
LOCKED SCENE DURATION: ${dur.toFixed(1)}s (narration MUST finish by ${finishSec}s)
STRICT WORD BUDGET: <= ${maxWords} spoken words total!
DRAFT NARRATION: "${chapter.rawNarration}"
${customAngle ? `CUSTOM HOOK ANGLE: "${customAngle}"` : ''}
LIVE US TRENDS CONTEXT: ${
    trends.length > 0 ? JSON.stringify(trends.slice(0, 5)) : 'US Shorts Documentary/Science/Explainer'
  }
OUTPUT LANGUAGE: ${langLabel}

Return ONLY valid JSON:
{
  "beats": [{"startSec": 0.0, "endSec": 3.0, "text": "Punchy opening beat."}],
  "title": "High-CTR title (max 68 chars)",
  "description": "2-line SEO description",
  "tags": "15 comma-separated tags",
  "hashtags": "7 hashtags starting with #",
  "posting_time": "Best USA EST + India IST upload window"
}
`.trim();

  let routed: { parsed: Record<string, unknown>; modelUsed: string } | null =
    null;
  try {
    routed = await runStep3ScriptJson({
      config,
      language,
      systemPrompt:
        'You are a viral US YouTube Shorts documentary writer and SEO strategist. Output strictly valid JSON only.',
      userPrompt: prompt,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    routed = null;
  }

  const parsed = routed?.parsed ?? null;
  const scriptEngine = routed?.modelUsed || 'Documentary Beat Sync';

  if (!parsed) {
    const enforced = enforceStrictWordBudgetAndBeats({
      rawBeats: chapter.beats,
      fallbackVoiceover: chapter.rawNarration,
      lockedVisualDurationSec: dur,
      language,
    });
    return {
      voiceover: enforced.voiceover,
      beats: enforced.beats,
      title: `${seriesTitle.slice(0, 46)} — ${chapter.title}`.slice(0, 68),
      description: `${chapter.visualPrompt.slice(0, 140)}`,
      tags: `${seriesTitle}, documentary shorts, 3d explainer, motion graphics, us trending, breakdown`,
      hashtags:
        language === 'hi'
          ? '#shorts #documentary #facts #hindi #3danimation #explainer #viral'
          : '#shorts #documentary #3d #motiongraphics #explainer #facts #viral',
      postingTime:
        '6:30 PM EST / 5:00 AM IST — Peak US Evening & Early India Feed',
      scriptEngine,
      youtubeTrendsCount: trends.length,
    };
  }

  const enforced = enforceStrictWordBudgetAndBeats({
    rawBeats: parsed.beats,
    fallbackVoiceover: String(parsed.voiceover || chapter.rawNarration),
    lockedVisualDurationSec: dur,
    language,
  });

  return {
    voiceover: enforced.voiceover,
    beats: enforced.beats,
    title: String(parsed.title || `${seriesTitle} — ${chapter.title}`).trim(),
    description: String(parsed.description || chapter.visualPrompt).trim(),
    tags: String(parsed.tags || '').trim(),
    hashtags: String(parsed.hashtags || '').trim(),
    postingTime: String(
      parsed.posting_time ||
        '6:30 PM EST / 5:00 AM IST — Peak US Evening & Early India Feed'
    ).trim(),
    scriptEngine,
    youtubeTrendsCount: trends.length,
  };
}

async function fetchImageAsBase64(
  imageUrl: string,
  signal?: AbortSignal
): Promise<{ mimeType: string; base64: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) return { mimeType: match[1], base64: match[2] };
  }
  const resp = await fetchWithTimeout(imageUrl, { method: 'GET' }, signal, 10_000);
  if (!resp.ok) throw new Error('Could not load character portrait.');
  const blob = await resp.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed reading portrait blob.'));
    reader.readAsDataURL(blob);
  });
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return { mimeType: match?.[1] || 'image/jpeg', base64: match?.[2] || '' };
}

export async function applyFaceLockedOutfitChange(params: {
  portraitUrl: string;
  outfitPrompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { portraitUrl, outfitPrompt, signal } = params;
  const trimmedPrompt = outfitPrompt.trim();
  if (!trimmedPrompt) return portraitUrl;

  try {
    const { mimeType, base64 } = await fetchImageAsBase64(portraitUrl, signal);
    if (!base64) return portraitUrl;

    const resp = await fetchWithTimeout(
      '/api/gemini/edit-portrait',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType,
          outfitPrompt: trimmedPrompt,
        }),
      },
      signal,
      SERVER_EDIT_TIMEOUT_MS
    );

    const payload = (await resp.json().catch(() => ({}))) as {
      imageDataUrl?: string;
      error?: string;
    };

    if (resp.ok && payload.imageDataUrl) {
      return payload.imageDataUrl;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
  }

  return portraitUrl;
}
