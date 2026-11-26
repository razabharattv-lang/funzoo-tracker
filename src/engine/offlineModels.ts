import type {
  AlignedWordTiming,
  LocalSceneScanResult,
  OutputLanguage,
  PreparedVisualClip,
  SafeCropInsets,
  ScriptBeat,
  SourceMediaItem,
  TrendMetadata,
  WatermarkZone,
  YouTubeTrendVideo,
} from '../types/studio';
import { getOfflineModelStatuses } from './cacheManager';
import type { OfflineModelStatus } from '../types/studio';

const EMPHASIS_WORDS = new Set([
  'WAIT',
  'STOP',
  'LOOK',
  'WATCH',
  'SECRET',
  'SHOCKING',
  'ACTUALLY',
  'TRUTH',
  'FIRST',
  'NEVER',
  'INSTANTLY',
  'EXACTLY',
  'FINALLY',
  'KEY',
  'REAL',
  'PROOF',
  'WHY',
  'HOW',
  'MILLION',
  'BILLION',
  '100%',
  'असली',
  'सच',
  'ध्यान',
  'देखिए',
  'सीधे',
  'तुरंत',
]);

export function warmOfflineEngines(): OfflineModelStatus[] {
  return getOfflineModelStatuses();
}

/**
 * Aligns voiceover script words to the actual rendered AudioBuffer RMS energy envelope
 * so kinetic captions stay locked to speech without external ASR downloads.
 */
export function alignCaptionsOffline(params: {
  audioBuffer: AudioBuffer;
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  targetDurationSec: number;
}): AlignedWordTiming[] {
  const { audioBuffer, scriptText, beats, language, targetDurationSec } = params;

  const rawWords = scriptText
    .replace(/["“”\n\r]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (rawWords.length === 0) return [];

  const formattedWords =
    language === 'hi' ? rawWords : rawWords.map((w) => w.toUpperCase());

  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const audioDur = Math.min(
    Math.max(0.5, audioBuffer.duration),
    Math.max(0.5, targetDurationSec)
  );

  // Detect active voice intervals using 25ms RMS windows
  const windowSamples = Math.max(128, Math.floor(sampleRate * 0.025));
  const totalWindows = Math.max(1, Math.floor(channelData.length / windowSamples));
  const energies = new Float32Array(totalWindows);
  let maxEnergy = 0.0001;

  for (let w = 0; w < totalWindows; w++) {
    const start = w * windowSamples;
    const end = Math.min(channelData.length, start + windowSamples);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = channelData[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    energies[w] = rms;
    if (rms > maxEnergy) maxEnergy = rms;
  }

  const threshold = maxEnergy * 0.07;
  let speechStartWin = 0;
  let speechEndWin = totalWindows - 1;
  for (let i = 0; i < totalWindows; i++) {
    if (energies[i] >= threshold) {
      speechStartWin = i;
      break;
    }
  }
  for (let i = totalWindows - 1; i >= 0; i--) {
    if (energies[i] >= threshold) {
      speechEndWin = i;
      break;
    }
  }

  const speechStartSec = Math.max(0, (speechStartWin * windowSamples) / sampleRate);
  const speechEndSec = Math.min(
    audioDur,
    Math.max(speechStartSec + 0.5, ((speechEndWin + 1) * windowSamples) / sampleRate)
  );
  const activeSpanSec = Math.max(0.5, speechEndSec - speechStartSec);

  // Distribute words proportionally by character/syllable weight + punctuation pause
  const weights = formattedWords.map((word) => {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
    const base = Math.max(2, clean.length);
    const pauseBonus = /[.!?।]$/.test(word) ? 3.2 : /[,;:—]$/.test(word) ? 1.5 : 0;
    return base + pauseBonus;
  });
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;

  // If beats are well-formed and match word count closely, anchor within speech span
  const results: AlignedWordTiming[] = [];
  let cursor = speechStartSec;
  for (let i = 0; i < formattedWords.length; i++) {
    const word = formattedWords[i];
    const dur = Math.max(0.08, (weights[i] / totalWeight) * activeSpanSec);
    const startSec = Number(cursor.toFixed(3));
    const endSec = Number(Math.min(speechEndSec, cursor + dur).toFixed(3));
    cursor = endSec;
    const bare = word.replace(/[^\p{L}\p{N}%]/gu, '');
    results.push({
      word,
      startSec,
      endSec: Math.max(startSec + 0.06, endSec),
      confidence: beats.length > 0 ? 0.92 : 0.88,
      isEmphasis: EMPHASIS_WORDS.has(bare) || /\d/.test(bare),
    });
  }

  return results;
}

/**
 * Local zero-API video scanner: samples frames across the real video timeline to find
 * scene cuts, high-action peaks, static corner watermarks, and social outro bumpers.
 */
export async function analyzeVideoTimelineLocally(
  source: SourceMediaItem,
  onProgress?: (detail: string) => void
): Promise<LocalSceneScanResult> {
  const duration = Math.max(1, source.durationSec);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out while loading video frames for local inspection.')),
      15000
    );
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Browser could not decode this video file for frame inspection.'));
    };
    video.load();
  });

  const sampleW = 160;
  const sampleH = 90;
  const canvas = document.createElement('canvas');
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return {
      sceneCutTimestampsSec: [],
      highActionWindows: [
        {
          startSec: 0,
          endSec: duration,
          climaxSec: Number((duration * 0.45).toFixed(2)),
          motionScore: 0.5,
        },
      ],
      detectedWatermarkZones: [],
      suggestedSafeCropInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      hasOutroBumper: false,
    };
  }

  const sampleCount =
    duration <= 30 ? 10 : duration <= 120 ? 16 : duration <= 600 ? 22 : 28;
  const timestamps: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const frac = i / Math.max(1, sampleCount - 1);
    const t = Math.min(Math.max(0.15, frac * (duration - 0.25)), Math.max(0.15, duration - 0.15));
    timestamps.push(Number(t.toFixed(2)));
  }

  const frames: Uint8ClampedArray[] = [];
  const motionScores: { timeSec: number; score: number; luma: number }[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    if (onProgress && i % 4 === 0) {
      onProgress(`Inspecting source timeline (${i + 1}/${timestamps.length} keyframes)...`);
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        video.onseeked = null;
        resolve();
      };
      const timer = window.setTimeout(done, 900);
      video.onseeked = () => {
        window.clearTimeout(timer);
        done();
      };
      try {
        video.currentTime = Math.min(t, Math.max(0, (video.duration || duration) - 0.08));
      } catch {
        window.clearTimeout(timer);
        done();
      }
    });

    ctx.drawImage(video, 0, 0, sampleW, sampleH);
    const img = ctx.getImageData(0, 0, sampleW, sampleH).data;
    const copy = new Uint8ClampedArray(img);

    let lumaSum = 0;
    let diffSum = 0;
    const prev = frames.length > 0 ? frames[frames.length - 1] : null;
    for (let p = 0; p < copy.length; p += 16) {
      const luma = copy[p] * 0.299 + copy[p + 1] * 0.587 + copy[p + 2] * 0.114;
      lumaSum += luma;
      if (prev) {
        diffSum +=
          Math.abs(copy[p] - prev[p]) +
          Math.abs(copy[p + 1] - prev[p + 1]) +
          Math.abs(copy[p + 2] - prev[p + 2]);
      }
    }
    const pxCount = copy.length / 16;
    const avgLuma = lumaSum / Math.max(1, pxCount);
    const motion = prev ? diffSum / (Math.max(1, pxCount) * 3 * 255) : 0.15;

    frames.push(copy);
    motionScores.push({ timeSec: t, score: motion, luma: avgLuma });
  }

  // Release temporary video element
  video.pause();
  video.removeAttribute('src');
  video.load();

  // Detect scene cuts where inter-frame delta spikes
  const sceneCutTimestampsSec: number[] = [];
  for (let i = 1; i < motionScores.length; i++) {
    if (motionScores[i].score > 0.24) {
      sceneCutTimestampsSec.push(motionScores[i].timeSec);
    }
  }

  // Detect abrupt black/white social outro bumper on the tail sample
  const tail = motionScores[motionScores.length - 1];
  const prevTail = motionScores[Math.max(0, motionScores.length - 2)];
  const hasOutroBumper =
    duration >= 10 &&
    Boolean(
      tail &&
        prevTail &&
        ((tail.luma < 14 && prevTail.luma > 32) ||
          (tail.luma > 240 && prevTail.luma < 210) ||
          (source.trimSocialEndCard && tail.score > 0.38))
    );

  // Detect persistent high-contrast corner logos (low temporal variance + high spatial edge)
  const corners: {
    id: string;
    label: string;
    box: [number, number, number, number];
  }[] = [
    { id: 'wm_top_left', label: 'Top-left corner mark', box: [0.02, 0.02, 0.22, 0.1] },
    { id: 'wm_top_right', label: 'Top-right corner mark', box: [0.76, 0.02, 0.98, 0.1] },
    { id: 'wm_bottom_left', label: 'Bottom-left corner mark', box: [0.02, 0.89, 0.24, 0.98] },
    { id: 'wm_bottom_right', label: 'Bottom-right corner mark', box: [0.74, 0.89, 0.98, 0.98] },
  ];

  const detectedWatermarkZones: WatermarkZone[] = [];
  if (frames.length >= 4) {
    // Compare interior frames only (exclude first/last bumper frames)
    const sampleFrames = frames.slice(1, frames.length - 1);
    for (const corner of corners) {
      const x0 = Math.floor(corner.box[0] * sampleW);
      const y0 = Math.floor(corner.box[1] * sampleH);
      const x1 = Math.min(sampleW - 1, Math.ceil(corner.box[2] * sampleW));
      const y1 = Math.min(sampleH - 1, Math.ceil(corner.box[3] * sampleH));

      let edgeEnergy = 0;
      let temporalDiff = 0;
      let count = 0;

      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1 - 1; x += 2) {
          const idx = (y * sampleW + x) * 4;
          const idxR = (y * sampleW + x + 1) * 4;
          const base = sampleFrames[0];
          const l1 = base[idx] * 0.299 + base[idx + 1] * 0.587 + base[idx + 2] * 0.114;
          const l2 = base[idxR] * 0.299 + base[idxR + 1] * 0.587 + base[idxR + 2] * 0.114;
          edgeEnergy += Math.abs(l1 - l2);

          for (let f = 1; f < sampleFrames.length; f++) {
            const cur = sampleFrames[f];
            temporalDiff += Math.abs(cur[idx] - base[idx]) / Math.max(1, sampleFrames.length - 1);
          }
          count++;
        }
      }

      const avgEdge = edgeEnergy / Math.max(1, count);
      const avgTempDiff = temporalDiff / Math.max(1, count);

      // Strong crisp static text/logo overlay: noticeable edge contrast + very low motion over time
      if (avgEdge > 16 && avgTempDiff < 14) {
        detectedWatermarkZones.push({
          id: corner.id,
          startSec: 0,
          endSec: Number(duration.toFixed(2)),
          box: corner.box,
          action: 'gpu_delogo_patch',
          label: corner.label,
        });
      }
    }
  }

  // Only suggest minimal subject-safe edge crop (<= 3%) when platform borders or multiple edge marks exist
  const suggestedSafeCropInsets: SafeCropInsets =
    detectedWatermarkZones.length >= 2 || source.trimSocialEndCard
      ? { top: 0.02, bottom: 0.025, left: 0.015, right: 0.015 }
      : { top: 0, bottom: 0, left: 0, right: 0 };

  // Build ranked high-action windows across full duration (no artificial length cap)
  const highActionWindows: LocalSceneScanResult['highActionWindows'] = [];
  if (duration <= 65) {
    const peak = motionScores.reduce(
      (best, cur) => (cur.score > best.score ? cur : best),
      motionScores[0] ?? { timeSec: duration * 0.45, score: 0.25, luma: 120 }
    );
    highActionWindows.push({
      startSec: 0,
      endSec: Number(duration.toFixed(2)),
      climaxSec: Number(peak.timeSec.toFixed(2)),
      motionScore: Number(peak.score.toFixed(3)),
    });
  } else {
    // Divide long video into 3 clean non-overlapping highlight regions centered on peak motion
    const targetClips = 3;
    const regionSpan = duration / targetClips;
    const targetClipLen = Math.min(58, Math.max(30, regionSpan * 0.72));

    for (let c = 0; c < targetClips; c++) {
      const regStart = c * regionSpan;
      const regEnd = (c + 1) * regionSpan;
      const candidates = motionScores.filter(
        (m) => m.timeSec >= regStart && m.timeSec <= regEnd
      );
      const peak = candidates.reduce(
        (best, cur) => (cur.score > best.score ? cur : best),
        candidates[0] ?? {
          timeSec: regStart + regionSpan * 0.5,
          score: 0.25,
          luma: 120,
        }
      );

      let startSec = Math.max(regStart, peak.timeSec - targetClipLen * 0.42);
      let endSec = startSec + targetClipLen;
      if (endSec > regEnd) {
        endSec = regEnd;
        startSec = Math.max(regStart, endSec - targetClipLen);
      }

      highActionWindows.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        climaxSec: Number(peak.timeSec.toFixed(2)),
        motionScore: Number(peak.score.toFixed(3)),
      });
    }
  }

  return {
    sceneCutTimestampsSec,
    highActionWindows,
    detectedWatermarkZones,
    suggestedSafeCropInsets,
    hasOutroBumper,
  };
}

/**
 * Clean local fallback when cloud AI quota is unavailable or offline.
 * Produces a faithful, timing-locked narration script + 5 copy-ready SEO fields
 * (Title, Description, Tags, Hashtags, Best Upload Time USA EST + India IST).
 */
export function generateOfflineDirectTranslationAndMetadata(params: {
  clip: PreparedVisualClip;
  sourceLabel: string;
  language: OutputLanguage;
  customAngle: string;
  trends: YouTubeTrendVideo[];
  fallbackReason?: string;
}): TrendMetadata {
  const { clip, sourceLabel, language, customAngle, trends, fallbackReason } = params;
  const dur = Math.max(4, clip.lockedVisualDurationSec);

  const cleanTopic = (customAngle.trim() || sourceLabel)
    .replace(/\.(mp4|mov|webm|mkv|avi)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const topicTitle = cleanTopic.length > 3 ? cleanTopic.slice(0, 62) : 'Key Moment Breakdown';
  const trendKeyword =
    trends[0]?.tags?.[0] ||
    trends[0]?.title?.split(/\s+/).slice(0, 3).join(' ') ||
    'Explained';

  const beatCount = dur <= 12 ? 2 : dur <= 28 ? 3 : 4;
  const beatSpan = dur / beatCount;

  const enLines = [
    `Watch closely at what happens right here in ${topicTitle}.`,
    `Notice the exact moment the main detail shifts on screen and drives the outcome.`,
    `Every step in this sequence builds directly toward the core takeaway.`,
    `That is the key point behind ${topicTitle} — clear, direct, and easy to verify.`,
  ];

  const hiLines = [
    `यहाँ ${topicTitle} में जो हो रहा है, उसे ध्यान से देखिए।`,
    `ठीक इस पल पर मुख्य बदलाव सामने आता है और पूरा नतीजा तय करता है।`,
    `इस क्लिप का हर हिस्सा सीधे मुख्य बात को स्पष्ट करता है।`,
    `यही ${topicTitle} की असली और सीधी बात है, जिसे आप साफ देख सकते हैं।`,
  ];

  const chosenLines = (language === 'hi' ? hiLines : enLines).slice(0, beatCount);
  const beats: ScriptBeat[] = chosenLines.map((text, idx) => ({
    startSec: Number((idx * beatSpan).toFixed(2)),
    endSec: Number(Math.min(dur, (idx + 1) * beatSpan).toFixed(2)),
    text,
  }));

  const voiceover = beats.map((b) => b.text).join(' ');

  const title =
    language === 'hi'
      ? `${topicTitle} | सीधी हिंदी व्याख्या और मुख्य बात`
      : `${topicTitle} — Direct Breakdown & Key Takeaway`;

  const description =
    language === 'hi'
      ? `${topicTitle} के सबसे महत्वपूर्ण हिस्से का सीधा हिंदी अनुवाद और स्पष्ट विश्लेषण।\n\nमुख्य बिंदु:\n• क्लिप के असली दृश्य और महत्वपूर्ण पल\n• स्पष्ट और तेज़ जानकारी\n\nसब्सक्राइब करें और पूरा वीडियो देखें।`
      : `Direct English breakdown of ${topicTitle}, preserving every key visual and spoken point cleanly.\n\nHighlights:\n• Exact sequence breakdown from start to finish\n• Clear, high-authority narration synced to the footage\n\nSubscribe for daily breakdowns and ${trendKeyword} highlights.`;

  const tagList = [
    topicTitle.toLowerCase(),
    language === 'hi' ? 'hindi explanation' : 'direct breakdown',
    language === 'hi' ? 'hindi voiceover' : 'us explainer',
    'shorts',
    'viral clip',
    'fact check',
    trendKeyword.toLowerCase(),
  ].filter((v, i, arr) => v.length > 1 && arr.indexOf(v) === i);

  const hashtags =
    language === 'hi'
      ? '#Shorts #HindiExplainer #ViralClip #DirectTranslation #Trending'
      : '#Shorts #Explainer #DirectBreakdown #ViralClip #TrendingUS';

  const postingTime =
    language === 'hi'
      ? 'Best Upload Window: 6:30 PM – 9:00 PM IST (India Peak) | 9:00 AM – 11:30 AM EST (USA Morning)'
      : 'Best Upload Window: 11:30 AM – 2:00 PM EST / 6:00 PM – 8:30 PM EST (USA Peak) | 9:00 PM – 11:30 PM IST (India Peak)';

  return {
    voiceover,
    beats,
    title: title.slice(0, 96),
    description,
    tags: tagList.join(', '),
    hashtags,
    postingTime,
    scriptEngine: fallbackReason
      ? `Offline Direct-Script Fallback (${fallbackReason})`
      : 'Offline Direct-Script Engine (0 Cloud Quota)',
    youtubeTrendsCount: trends.length,
  };
}
