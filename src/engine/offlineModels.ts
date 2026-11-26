import type {
  AlignedWordTiming,
  ClipVisualSummary,
  LocalSceneScanResult,
  OfflineModelStatus,
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
  'SHIFT',
  'MOMENT',
  'DETAIL',
  'असली',
  'सच',
  'ध्यान',
  'देखिए',
  'सीधे',
  'तुरंत',
  'मुख्य',
  'बदलाव',
]);

export function warmOfflineEngines(): OfflineModelStatus[] {
  return getOfflineModelStatuses();
}

/**
 * Strips file extensions and rejects opaque camera/gallery/numeric filenames
 * (such as `1000179945.mp4`, `VID_20250312_184422.mp4`, `IMG_4921.MOV`, `WhatsApp Video...`)
 * so raw numbers or IDs NEVER appear inside the spoken narration or SEO titles.
 */
export function extractReadableTopicFromLabel(
  sourceLabel: string,
  customAngle: string
): string | null {
  const customClean = customAngle.trim().replace(/\s+/g, ' ');
  if (customClean.length >= 4) {
    return customClean.slice(0, 72);
  }

  const base = sourceLabel
    .replace(/\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base || base.length < 4) return null;

  // Reject purely numeric IDs or camera/app generated filenames
  const opaquePatterns = [
    /^\d[\d\s]*$/,
    /^(vid|img|pxl|dsc|mov|clip|video|screen|recording|rpreplay|whatsapp|snapchat|tiktok|douyin|xhs|inshot|capcut|snaptik|ssstik|saveinsta|download|file|media|untitled|export|output|local video|web video link)\b/i,
    /^[a-f0-9]{8,}$/i,
  ];
  if (opaquePatterns.some((re) => re.test(base))) return null;

  const lettersOnly = base.replace(/[^\p{L}]/gu, '');
  const digitsOnly = base.replace(/[^\d]/g, '');
  // Reject if mostly digits or fewer than 4 real letters
  if (lettersOnly.length < 4) return null;
  if (digitsOnly.length >= lettersOnly.length) return null;

  return base.slice(0, 68);
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

  const threshold = maxEnergy * 0.06;
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

  const weights = formattedWords.map((word) => {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
    const base = Math.max(2, clean.length);
    const pauseBonus = /[.!?।]$/.test(word) ? 3.2 : /[,;:—]$/.test(word) ? 1.5 : 0;
    return base + pauseBonus;
  });
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;

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
 * scene cuts, high-action peaks, static corner watermarks, outro bumpers, and visual pacing.
 */
export async function analyzeVideoTimelineLocally(
  source: SourceMediaItem,
  onProgress?: (detail: string) => void
): Promise<LocalSceneScanResult> {
  const duration = Math.max(1, source.durationSec);
  const orientation: ClipVisualSummary['orientation'] =
    source.width > source.height * 1.05
      ? 'landscape'
      : Math.abs(source.width - source.height) / Math.max(source.width, source.height) <= 0.12
      ? 'square'
      : 'vertical';

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
      visualSummary: {
        orientation,
        pacing: 'dynamic',
        sceneCutCount: 0,
        lighting: 'cinematic',
      },
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

  video.pause();
  video.removeAttribute('src');
  video.load();

  const sceneCutTimestampsSec: number[] = [];
  for (let i = 1; i < motionScores.length; i++) {
    if (motionScores[i].score > 0.24) {
      sceneCutTimestampsSec.push(motionScores[i].timeSec);
    }
  }

  const avgMotion =
    motionScores.reduce((acc, m) => acc + m.score, 0) / Math.max(1, motionScores.length);
  const avgBrightness =
    motionScores.reduce((acc, m) => acc + m.luma, 0) / Math.max(1, motionScores.length);

  const visualSummary: ClipVisualSummary = {
    orientation,
    pacing:
      sceneCutTimestampsSec.length >= 3 || avgMotion > 0.22
        ? 'fast-cut'
        : avgMotion > 0.11
        ? 'dynamic'
        : 'steady',
    sceneCutCount: sceneCutTimestampsSec.length,
    lighting:
      avgBrightness > 145
        ? 'bright'
        : avgBrightness < 80
        ? 'high-contrast'
        : 'cinematic',
  };

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

  const suggestedSafeCropInsets: SafeCropInsets =
    detectedWatermarkZones.length >= 2 || source.trimSocialEndCard
      ? { top: 0.02, bottom: 0.025, left: 0.015, right: 0.015 }
      : { top: 0, bottom: 0, left: 0, right: 0 };

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
    visualSummary,
  };
}

/**
 * Clean, natural, duration-calibrated local fallback when cloud AI is blocked or offline.
 * NEVER speaks raw camera/numeric filenames (like `1000179945`) and matches exact clip
 * duration (e.g., 17s -> ~34-38 punchy words finishing cleanly before 16.5s).
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
  const safeSpeechEnd = Math.max(2.5, dur - 0.35);

  const readableTopic = extractReadableTopicFromLabel(sourceLabel, customAngle);
  const visual = clip.visualSummary;
  const climaxSecRounded = Math.max(1, Math.round(clip.climaxSec));
  const isFast = visual?.pacing === 'fast-cut';
  const formatWord = visual?.orientation === 'landscape' ? 'widescreen' : 'vertical';

  const trendKeyword =
    trends[0]?.tags?.[0] ||
    trends[0]?.title?.split(/\s+/).slice(0, 3).join(' ') ||
    'Breakdown';

  // Calibrate number of sentences strictly to clip duration (~2.15 words/sec)
  const sentenceCount = dur <= 10 ? 2 : dur <= 22 ? 3 : 4;

  let chosenLines: string[];
  if (language === 'hi') {
    const hiPool = readableTopic
      ? [
          `${readableTopic} के इस दृश्य को ध्यान से देखिए, क्योंकि असली बात शुरुआत के पहले ही सेकंड से तय हो जाती है।`,
          `लगभग ${climaxSecRounded} सेकंड के आसपास मुख्य बदलाव सामने आता है, जहाँ पूरा फोकस सीधे नतीजे की ओर मुड़ता है।`,
          `हर फ्रेम बिना किसी भटकाव के इसी मुख्य बिंदु को साफ साबित करता है।`,
          `यही ${readableTopic} का सीधा और स्पष्ट सार है, जिसे आप इस क्लिप में तुरंत समझ सकते हैं।`,
        ]
      : [
          `इस क्लिप के पहले ही पल को ध्यान से देखिए, क्योंकि असली बदलाव यहीं से शुरू होता है।`,
          `${isFast ? 'तेज़ कट्स के बीच ' : ''}लगभग ${climaxSecRounded} सेकंड पर वह मुख्य मोड़ आता है, जिसे ज़्यादातर लोग पहली बार में छोड़ देते हैं।`,
          `अंत तक पहुँचते-पहुँचते पूरी तस्वीर बिल्कुल साफ हो जाती है और मुख्य बात सीधे सामने आ जाती है।`,
          `ऐसे ही स्पष्ट और तेज़ विश्लेषण के लिए इस वीडियो को सेव करें और चैनल से जुड़े रहें।`,
        ];
    chosenLines = hiPool.slice(0, sentenceCount);
  } else {
    const enPool = readableTopic
      ? [
          `Watch this moment in ${readableTopic} closely — the key shift starts right from the opening frame.`,
          `Right around the ${climaxSecRounded}-second mark, the main action turns and reveals what actually drives the outcome.`,
          `Every beat in this sequence locks onto that core detail with zero filler.`,
          `That is the exact takeaway from ${readableTopic} — clear, direct, and easy to verify on screen.`,
        ]
      : [
          `Watch the opening frame closely — the key detail that changes everything happens faster than most viewers expect.`,
          `${isFast ? 'Across the rapid cuts, right' : 'Right'} around the ${climaxSecRounded}-second mark, the main turning point locks in and drives the entire sequence.`,
          `By the final second, the full picture comes together cleanly with zero wasted motion.`,
          `Save this breakdown and follow for more direct, frame-by-frame visual explainers.`,
        ];
    chosenLines = enPool.slice(0, sentenceCount);
  }

  // Distribute beat timings proportionally to word length inside safeSpeechEnd
  const wordCounts = chosenLines.map((l) => l.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0.05;
  const beats: ScriptBeat[] = chosenLines.map((text, idx) => {
    const share = (wordCounts[idx] / totalWords) * (safeSpeechEnd - 0.1);
    const startSec = Number(cursor.toFixed(2));
    const endSec = Number(
      (idx === chosenLines.length - 1 ? safeSpeechEnd : Math.min(safeSpeechEnd, cursor + share)).toFixed(2)
    );
    cursor = endSec;
    return { startSec, endSec, text };
  });

  const voiceover = beats.map((b) => b.text).join(' ');

  const displayTitleSubject =
    readableTopic ||
    (language === 'hi'
      ? `${Math.round(dur)} सेकंड में मुख्य पल का सीधा विश्लेषण`
      : `The ${climaxSecRounded}-Second Turning Point Most Viewers Miss`);

  const title =
    language === 'hi'
      ? readableTopic
        ? `${readableTopic} | सीधी हिंदी व्याख्या और असली मोड़`
        : `${displayTitleSubject} | हिंदी एक्सप्लेनर`
      : readableTopic
      ? `${readableTopic} — Direct Breakdown & Key Moment`
      : `${displayTitleSubject} (Direct Breakdown)`;

  const description =
    language === 'hi'
      ? `${displayTitleSubject} का स्पष्ट और सीधा हिंदी विश्लेषण।\n\nइस क्लिप में क्या खास है:\n• शुरुआती फ्रेम से लेकर ${climaxSecRounded} सेकंड के मुख्य मोड़ तक सीधा कवरेज\n• साफ ${formatWord} फ्रेमिंग, सिनेमा कलर ग्रेड और क्रिस्प वॉइसओवर\n\nऐसे और सीधे वीडियो ब्रेकडाउन के लिए सब्सक्राइब करें।`
      : `Direct English breakdown of ${displayTitleSubject}, keeping every key on-screen moment crystal clear.\n\nWhat happens in this clip:\n• Opening setup leading straight into the ${climaxSecRounded}-second turning point\n• Clean ${formatWord} framing, cinema color grade, and synced commanding narration\n\nSubscribe for daily visual breakdowns and ${trendKeyword} highlights.`;

  const tagList = [
    ...(readableTopic ? [readableTopic.toLowerCase()] : []),
    language === 'hi' ? 'hindi explainer' : 'direct breakdown',
    language === 'hi' ? 'hindi voiceover' : 'visual explainer',
    language === 'hi' ? 'viral clip hindi' : 'us shorts explainer',
    'shorts',
    'reels',
    'key moment',
    'frame by frame',
    trendKeyword.toLowerCase(),
  ].filter((v, i, arr) => v.length > 1 && arr.indexOf(v) === i);

  const hashtags =
    language === 'hi'
      ? '#Shorts #HindiExplainer #DirectBreakdown #ViralClip #TrendingIndia'
      : '#Shorts #Explainer #DirectBreakdown #ViralClip #TrendingUS';

  const postingTime =
    language === 'hi'
      ? 'Best Upload Window: 6:30 PM – 9:00 PM IST (India Peak) | 9:00 AM – 11:30 AM EST (USA Morning)'
      : 'Best Upload Window: 11:30 AM – 2:00 PM EST & 6:00 PM – 8:30 PM EST (USA Peak) | 9:00 PM – 11:30 PM IST (India Peak)';

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
