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
  PacingBeat,
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
  lockedDurationSec: number,
  pacingBeats?: PacingBeat[]
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
        const startSec = i === 0 ? 0 : Math.max(prevEnd, Math.min(safeDur - 0.3, valid[i].startSec));
        const endSec =
          i === valid.length - 1
            ? safeDur
            : Math.max(startSec + 0.35, Math.min(safeDur - 0.15, valid[i].endSec));
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

  // When timeline pacingBeats exist, align fallback sentence boundaries directly to visual cuts
  if (pacingBeats && pacingBeats.length >= 2 && parts.length >= 2) {
    return parts.map((text, idx) => {
      const pIdx = Math.min(pacingBeats.length - 1, Math.floor((idx / parts.length) * pacingBeats.length));
      const nextPIdx = Math.min(
        pacingBeats.length - 1,
        Math.floor(((idx + 1) / parts.length) * pacingBeats.length)
      );
      const startSec = idx === 0 ? 0 : Math.min(safeDur - 0.3, pacingBeats[pIdx].startSec);
      const rawEnd =
        idx === parts.length - 1
          ? safeDur
          : nextPIdx > pIdx
          ? pacingBeats[nextPIdx].startSec
          : pacingBeats[pIdx].endSec;
      const endSec = Math.max(startSec + 0.35, Math.min(safeDur, rawEnd));
      return {
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        text,
      };
    });
  }

  const weights = parts.map((p) => Math.max(2, p.split(/\s+/).filter(Boolean).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return parts.map((text, idx) => {
    const span = (weights[idx] / totalWeight) * safeDur;
    const startSec = cursor;
    const endSec = idx === parts.length - 1 ? safeDur : Math.min(safeDur, cursor + span);
    cursor = endSec;
    return {
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      text,
    };
  });
}

function isPlaceholderSeoText(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower || lower.length < 3) return true;
  return (
    /^(n\/a|na|none|null|undefined|tbd|placeholder|title|description|tags|hashtags|unknown|\.{2,})$/i.test(
      lower
    ) ||
    lower.includes('#nichetag') ||
    lower.includes('comma-separated niche tags') ||
    lower.includes('best upload window with both usa est')
  );
}

const WEAK_OPENER_REGEX =
  /^(in this video|today we|welcome back|hey guys|watch this clip|this video shows|here we see|let'?s take a look|look at this video|आज के वीडियो में|इस वीडियो में|दोस्तों आज हम|आज हम देखेंगे)/i;

function enforcePunchyOpeningHook(params: {
  voiceover: string;
  beats: ScriptBeat[];
  detectedTopic: string | null;
  language: OutputLanguage;
  targetDurationSec: number;
}): { voiceover: string; beats: ScriptBeat[] } {
  const { language, targetDurationSec } = params;
  const trimmedVo = params.voiceover.trim();
  const sentences = trimmedVo
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const firstSentence = sentences[0] ?? trimmedVo;
  const needsUpgrade =
    !firstSentence ||
    WEAK_OPENER_REGEX.test(firstSentence) ||
    firstSentence.length < 14;

  if (!needsUpgrade) {
    return { voiceover: trimmedVo, beats: params.beats };
  }

  const cleanTopic =
    (params.detectedTopic ?? '')
      .replace(/["'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || (language === 'hi' ? 'इस सीन' : 'this exact moment');

  const upgradedHook =
    language === 'hi'
      ? `रुकिए—${cleanTopic} में अभी जो होने वाला है, देखकर यकीन नहीं होगा!`
      : `Stop scrolling—what happens to ${cleanTopic} next is unreal!`;

  const restSentences = sentences.slice(1);
  const nextVoiceover =
    restSentences.length > 0 ? `${upgradedHook} ${restSentences.join(' ')}` : upgradedHook;

  const hookEnd = Number(Math.min(2.8, Math.max(1.8, targetDurationSec * 0.22)).toFixed(2));
  const nextBeats: ScriptBeat[] =
    params.beats.length > 0
      ? params.beats.map((b, idx) => {
          if (idx === 0) {
            return {
              startSec: 0,
              endSec: Math.min(hookEnd, Math.max(1.2, b.endSec || hookEnd)),
              text: upgradedHook,
            };
          }
          if (idx === 1) {
            const prevEnd = Math.min(hookEnd, Math.max(1.2, params.beats[0].endSec || hookEnd));
            return {
              ...b,
              startSec: Number(Math.max(prevEnd, b.startSec).toFixed(2)),
            };
          }
          return b;
        })
      : normalizeBeats(undefined, nextVoiceover, targetDurationSec);

  return { voiceover: nextVoiceover, beats: nextBeats };
}

function ensurePopulatedField(
  candidate: string | undefined,
  fallback: string,
  minLen = 4
): string {
  const clean = (candidate ?? '').trim();
  if (clean.length < minLen || isPlaceholderSeoText(clean)) {
    return fallback;
  }
  return clean;
}

function normalizeCommaList(value: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(value)
    ? value.map((s) => String(s).trim()).filter((s) => !isPlaceholderSeoText(s))
    : typeof value === 'string' && !isPlaceholderSeoText(value)
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !isPlaceholderSeoText(s))
    : [];

  if (raw.length < 3) return fallback;
  return raw.slice(0, 12).join(', ');
}

function normalizeHashtags(value: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(value)
    ? value.map((s) => String(s).trim()).filter((s) => !isPlaceholderSeoText(s))
    : typeof value === 'string' && !isPlaceholderSeoText(value)
    ? value
        .trim()
        .split(/[\s,]+/)
        .filter((s) => s.length >= 2 && !isPlaceholderSeoText(s))
    : [];

  const cleaned = raw
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`))
    .filter((tag) => tag.length >= 3 && !/^#nichetag\d*$/i.test(tag))
    .slice(0, 8);
  if (cleaned.length < 2) return fallback;
  return cleaned.join(' ');
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
        ? `यूट्यूब ट्रेंड पीक (${trends.length} लाइव वीडियो): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`
        : `YouTube US Niche Peak (${trends.length} live videos · ${detectedTopic || 'Topic'}): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`;
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
 * 1) Sends the 9-frame (3x3) edited vertical contact sheet to the vision worker
 *    (`gemini-4-hydrogen` / `nvidia/nemotron-3.5-super-vl-120b-a12b`) to identify the real
 *    objects and step-by-step physical actions on screen (never generic or hallucinated filler).
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
  const maxSpeechSec = Math.max(2, targetDurSec - 0.3);
  const isLongExplainer = targetDurSec > 45;
  // Scale spoken word budget cleanly for both short clips and 1-2+ minute deep explainers
  const wordsPerSec = isLongExplainer
    ? language === 'hi'
      ? 2.25
      : 2.5
    : language === 'hi'
    ? 2.45
    : 2.75;
  const targetWordCount = Math.max(14, Math.min(950, Math.round(maxSpeechSec * wordsPerSec)));
  const frameCount = Math.max(6, clip.stampedTimestampsSec.length);
  const safeTopicHint =
    extractReadableTopicFromLabel(sourceLabel, customAngle) ||
    `Identify strictly from the ${frameCount} sampled video frames (ignore numeric filename)`;

  const languageName =
    language === 'hi'
      ? 'Hindi (pure, punchy, dramatic Devanagari Hindi)'
      : 'English (USA — sharp, dramatic, high-emotion American storytelling English)';
  const strictLanguageRule =
    language === 'hi'
      ? 'Write voiceover, beats, title, description, tags, hashtags, and posting_time STRICTLY in Devanagari Hindi (keeping only EST/IST timezone abbreviations).'
      : 'Write voiceover, beats, title, description, tags, hashtags, and posting_time STRICTLY in natural American English (USA).';
  const pacingBeats = clip.pacingBeats ?? [];
  const hookEndSec = Number(
    pacingBeats[0]
      ? Math.min(3.2, Math.max(1.6, pacingBeats[0].endSec)).toFixed(1)
      : isLongExplainer
      ? 3.0
      : Math.min(2.6, Math.max(1.6, maxSpeechSec * 0.22)).toFixed(1)
  );
  const targetBeatCount =
    pacingBeats.length >= 3
      ? pacingBeats.length
      : isLongExplainer
      ? Math.max(8, Math.min(24, Math.round(maxSpeechSec / 8)))
      : Math.max(3, Math.min(8, Math.round(maxSpeechSec / 3.5)));

  const pacingRoleDesc: Record<PacingBeat['kind'], string> = {
    hook_impact: 'High-tension 0-3s curiosity hook / pattern-interrupt tied strictly to Frame 1',
    clean_cut: 'Clean scene-cut explanation beat: describe the new visible shift and raise stakes',
    jump_trim_pause: 'Fast punchy micro-explanation keeping momentum tight through a quieter beat',
    zoom_accent: 'Focused close-up detail explanation: highlight why this visible move matters',
    twist_transition: 'Dramatic suspense turning point / retention re-hook before the twist lands',
    payoff_reveal: 'Sharp final payoff, reveal, and memorable takeaway shown in the closing frames',
  };

  const pacingCameraFocus: Record<PacingBeat['kind'], string> = {
    hook_impact: 'centered hook close-up push-in',
    clean_cut: 'motivated scene-cut wide-to-medium frame',
    jump_trim_pause: 'tightened punch-in beat cut',
    zoom_accent: 'subject detail zoom-in accent',
    twist_transition: 'dramatic tension push-in reveal',
    payoff_reveal: 'steady centered payoff framing',
  };

  const pacingSummaryCue =
    pacingBeats.length > 0
      ? pacingBeats
          .map(
            (b, idx) =>
              `Scene ${idx + 1} (${b.startSec.toFixed(1)}s-${Math.min(maxSpeechSec, b.endSec).toFixed(1)}s · ${b.kind} · ${pacingCameraFocus[b.kind]})`
          )
          .join(' -> ')
      : 'Auto-paced ordered timeline';

  const exampleBeatsJson =
    pacingBeats.length >= 3
      ? pacingBeats
          .slice(0, 10)
          .map((b, idx, arr) => {
            const endClamped =
              idx === arr.length - 1
                ? Number(maxSpeechSec.toFixed(1))
                : Number(Math.min(maxSpeechSec - 0.3, b.endSec).toFixed(1));
            return `    { "start_sec": ${b.startSec.toFixed(1)}, "end_sec": ${endClamped.toFixed(1)}, "text": "Scene ${idx + 1} (${pacingCameraFocus[b.kind]}): ${pacingRoleDesc[b.kind]}" }`;
          })
          .join(',\n')
      : (() => {
          const exampleBeatCount = isLongExplainer ? Math.min(6, targetBeatCount) : 4;
          const exampleStepSec = (maxSpeechSec - hookEndSec) / Math.max(1, exampleBeatCount - 1);
          return Array.from({ length: exampleBeatCount }, (_, idx) => {
            const bStart =
              idx === 0 ? 0.0 : Number((hookEndSec + (idx - 1) * exampleStepSec).toFixed(1));
            const bEnd =
              idx === 0
                ? hookEndSec
                : idx === exampleBeatCount - 1
                ? Number(maxSpeechSec.toFixed(1))
                : Number((hookEndSec + idx * exampleStepSec).toFixed(1));
            const desc =
              idx === 0
                ? pacingRoleDesc.hook_impact
                : idx === exampleBeatCount - 1
                ? pacingRoleDesc.payoff_reveal
                : isLongExplainer && idx === Math.floor(exampleBeatCount / 2)
                ? pacingRoleDesc.twist_transition
                : `Scene ${idx + 1} action beat: describe the visible progression and bridge naturally into Scene ${idx + 2}`;
            return `    { "start_sec": ${bStart.toFixed(1)}, "end_sec": ${bEnd.toFixed(1)}, "text": "${desc}" }`;
          }).join(',\n');
        })();

  const formatLabel = isLongExplainer
    ? `long-form ${Math.round(targetDurSec)}-second deep-dive explainer video`
    : 'viral YouTube Shorts & Reels explainer';
  const gridLabel = frameCount >= 12 ? '4x3' : '3x3';

  const systemPrompt = `You are a top viral YouTube ${isLongExplainer ? 'Explainer & Shorts' : 'Shorts & Reels'} creator and SEO strategist known for bold, fast, suspenseful, scroll-stopping storytelling.
You are inspecting a ${gridLabel} contact sheet of ${frameCount} evenly spaced edited frames (timestamps T=0.0s to T=${targetDurSec.toFixed(1)}s) taken directly from the user's trimmed ${formatLabel}.

MANDATORY SCROLL-STOPPING HOOK, SCENE-BY-SCENE BREAKDOWN & VISUAL CONTINUITY RULES:
1. STRICT VISUAL GROUNDING: Describe ONLY real people, animals, objects, locations, and physical actions unmistakably visible in the ${frameCount} frames. NEVER invent unseen props (never say "basket", "टोकरी", "box", "crayon", or random items unless clearly visible).
2. EXPLOSIVE 0–3s SUSPENSE HOOK: Scene 1 / Beat 1 (0.0s to ${hookEndSec}s) MUST make viewers stop scrolling immediately—a bold, urgent, high-tension curiosity hook tied directly to Frame 1. NEVER use slow intros like "In this video", "Watch this clip", "Here we see", or "इस वीडियो में".
3. ${isLongExplainer ? `ORDERED SCENE-BY-SCENE ARC & CONTINUITY (${targetBeatCount} SCENES): Break the narration into ordered chronological scenes matching the ORDERED SCENE & CAMERA PLAN below (hook_impact -> clean_cut / zoom_accent / jump_trim_pause -> twist_transition -> payoff_reveal) across ALL ${frameCount} frames. Keep causal continuity so every scene flows naturally into the next camera focus without abrupt topic resets.` : `ORDERED SCENE-BY-SCENE CONTINUITY (${targetBeatCount} SCENES): Align each crisp, emotional narration beat with the ORDERED SCENE & CAMERA PLAN across Frames 1–${frameCount} so each scene's visible action naturally leads into the next cut, escalating tension into a sharp final payoff.`}
4. ZERO FILLER OR CANNED TEXT: Strictly FORBIDDEN phrases include "opening frame", "turning point", "second mark", "core detail", "wasted motion", "contact sheet", or raw filenames like "1000179945".
5. FULL-DURATION PACING FIT: Write ~${targetWordCount} crisp, energetic spoken words tailored for confident, engaging delivery so narration covers the entire ${targetDurSec.toFixed(1)}s timeline smoothly and finishes cleanly before ${maxSpeechSec.toFixed(1)}s.
6. STRICT LANGUAGE LOCK: ${strictLanguageRule} Return complete, non-empty values for Title, Description, Tags, Hashtags, and Upload Time (EST/IST). Return ONLY valid JSON.`;

  const userPrompt = `CLIP HINT: ${safeTopicHint}
CLIP SEGMENT: Clip ${clip.clipIndex} of ${clip.totalClips} (edited duration: ${targetDurSec.toFixed(1)}s, ${frameCount} frame timestamps: ${clip.stampedTimestampsSec.map((t) => `${t.toFixed(1)}s`).join(', ')})
ORDERED SCENE & CAMERA PLAN: ${pacingSummaryCue}
DETECTED VISUAL PACING: ${clip.visualSummary}
OUTPUT LANGUAGE: ${languageName}
KEY POINTS TO KEEP: ${customAngle.trim() || `Open 0-${hookEndSec}s with a sharp suspense curiosity hook tied strictly to Frame 1, follow the ORDERED SCENE & CAMERA PLAN with smooth visual continuity from scene to scene across all ${frameCount} frames, and land a crisp payoff at ${maxSpeechSec.toFixed(1)}s.`}

RETURN STRICT JSON ONLY:
{
  "detected_topic": "Exact real subject/action clearly visible on screen (2-5 words)",
  "youtube_search_query": "2-4 clean English YouTube search words for this exact niche",
  "voiceover": "Direct-to-viewer narration strictly grounded in the ${frameCount} frames: punchy 0-${hookEndSec}s Frame-1 curiosity hook + full-length beat-aligned explanation across Frames 2-${frameCount} (~${targetWordCount} words, finishes before ${maxSpeechSec.toFixed(1)}s) in ${languageName}",
  "beats": [
${exampleBeatsJson}
  ],
  "title": "Curiosity-gap high-CTR title (<= 75 chars) strictly in ${languageName}",
  "description": "High-retention creator SEO description summarizing the real visual hook/explanation/twist + CTA strictly in ${languageName}",
  "tags": "8-12 comma-separated niche tags strictly in ${languageName}",
  "hashtags": "5-6 niche hashtags starting with # strictly in ${languageName}",
  "posting_time": "Best Upload Window with both USA EST and India IST peak hours strictly in ${languageName}"
}`;

  onStatus?.(
    `Analyzing ${frameCount} edited video frames for real objects & action beats (Clip ${clip.clipIndex}/${clip.totalClips})...`
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
          ? 'CORS-Blocked'
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
    const hookedOffline = enforcePunchyOpeningHook({
      voiceover: offlineOut.voiceover,
      beats: offlineOut.beats,
      detectedTopic: extractReadableTopicFromLabel(sourceLabel, customAngle),
      language,
      targetDurationSec: targetDurSec,
    });
    return {
      ...offlineOut,
      voiceover: hookedOffline.voiceover,
      beats: hookedOffline.beats,
      fetchedTrends: fallbackTrends,
    };
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
    const hookedOffline = enforcePunchyOpeningHook({
      voiceover: offlineOut.voiceover,
      beats: offlineOut.beats,
      detectedTopic: extractReadableTopicFromLabel(sourceLabel, customAngle),
      language,
      targetDurationSec: targetDurSec,
    });
    return {
      ...offlineOut,
      voiceover: hookedOffline.voiceover,
      beats: hookedOffline.beats,
      fetchedTrends: preloadedTrends,
    };
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

  const rawVoiceover = parsed.voiceover.trim();
  const rawBeats = normalizeBeats(
    parsed.beats,
    rawVoiceover,
    targetDurSec,
    clip.pacingBeats
  );
  const { voiceover, beats } = enforcePunchyOpeningHook({
    voiceover: rawVoiceover,
    beats: rawBeats,
    detectedTopic: detectedTopic || extractReadableTopicFromLabel(sourceLabel, customAngle),
    language,
    targetDurationSec: targetDurSec,
  });

  const rawPostingTime = ensurePopulatedField(
    parsed.posting_time,
    offlineDefaults.postingTime,
    8
  );
  const safePostingTime =
    rawPostingTime.includes('EST') && rawPostingTime.includes('IST')
      ? rawPostingTime
      : offlineDefaults.postingTime;

  const customizedSeo = customizeSeoWithNicheYouTubeTrends({
    detectedTopic,
    language,
    title: ensurePopulatedField(parsed.title, offlineDefaults.title, 6).slice(0, 100),
    description: ensurePopulatedField(parsed.description, offlineDefaults.description, 16),
    tags: normalizeCommaList(parsed.tags, offlineDefaults.tags),
    hashtags: normalizeHashtags(parsed.hashtags, offlineDefaults.hashtags),
    postingTime: safePostingTime,
    trends: activeTrends,
  });

  return {
    voiceover,
    beats,
    title: ensurePopulatedField(customizedSeo.title, offlineDefaults.title, 6).slice(0, 100),
    description: ensurePopulatedField(customizedSeo.description, offlineDefaults.description, 16),
    tags: normalizeCommaList(customizedSeo.tags, offlineDefaults.tags),
    hashtags: normalizeHashtags(customizedSeo.hashtags, offlineDefaults.hashtags),
    postingTime: ensurePopulatedField(customizedSeo.postingTime, offlineDefaults.postingTime, 8),
    scriptEngine: `${aiResponse.modelUsed}${detectedTopic ? ` · Topic: ${detectedTopic}` : ''}${activeTrends.length > 0 ? ` + YouTube US (${activeTrends.length})` : ''}`,
    youtubeTrendsCount: activeTrends.length,
    fetchedTrends: activeTrends,
  };
}
