import type {
  AlignedWordTiming,
  ClipVisualSummary,
  LocalSceneScanResult,
  OfflineModelStatus,
  OutputLanguage,
  PacingBeat,
  PacingBeatKind,
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
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';
  video.style.pointerEvents = 'none';
  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(video);
  }
  video.src = source.objectUrl;

  const frames: Uint8ClampedArray[] = [];
  const motionScores: { timeSec: number; score: number; luma: number }[] = [];
  const sampleW = 160;
  const sampleH = 90;

  try {
    if (video.readyState < 2 || video.videoWidth <= 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Timed out while loading video frames for local inspection.')),
          45000
        );
        const onReady = () => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            window.clearTimeout(timer);
            video.onloadeddata = null;
            video.oncanplay = null;
            resolve();
          }
        };
        video.onloadeddata = onReady;
        video.oncanplay = onReady;
        video.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error('Browser could not decode this video file for frame inspection.'));
        };
        video.load();
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error(
        'Browser 2D Canvas is unavailable for video frame inspection. Try Chrome, Edge, or Safari with hardware acceleration enabled.'
      );
    }

    const sampleCount =
      duration <= 30 ? 12 : duration <= 90 ? 18 : duration <= 180 ? 24 : 30;
    const timestamps: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const frac = i / Math.max(1, sampleCount - 1);
      const t = Math.min(Math.max(0.12, frac * (duration - 0.2)), Math.max(0.12, duration - 0.12));
      timestamps.push(Number(t.toFixed(2)));
    }

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
        const timer = window.setTimeout(done, 2200);
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

      if (video.readyState < 2 || video.videoWidth <= 0) continue;

      try {
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
      } catch {
        // Skip unreadable frame without crashing timeline scan
      }
    }
  } finally {
    video.onloadeddata = null;
    video.oncanplay = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.parentNode) {
      video.parentNode.removeChild(video);
    }
  }

  if (frames.length === 0 || motionScores.length === 0) {
    throw new Error(
      'Could not extract any readable video frames from this source (codec unsupported or CORS-restricted). Please upload a standard local H.264 MP4 or WebM video file directly.'
    );
  }

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

  // Trim leading dead-air / black-or-white fade-in if the very first frame is blank & static
  const firstFrame = motionScores[0];
  const secondFrame = motionScores[1];
  const isBlankFirst = Boolean(firstFrame && (firstFrame.luma < 14 || firstFrame.luma > 242));
  const isNormalSecond = Boolean(secondFrame && secondFrame.luma >= 24 && secondFrame.luma <= 232);
  const leadTrimSec =
    duration >= 7 && isBlankFirst && isNormalSecond
      ? Math.min(0.85, Math.max(0.22, secondFrame.timeSec * 0.65))
      : 0;
  const usableStart = Number(leadTrimSec.toFixed(2));
  const effectiveDuration = Math.max(1.5, duration - usableStart);

  const highActionWindows: LocalSceneScanResult['highActionWindows'] = [];
  // Preserve full intended duration for any video length (short clips AND 1-2+ minute explainers)
  const peak = motionScores.reduce(
    (best, cur) => (cur.score > best.score ? cur : best),
    motionScores[0] ?? { timeSec: usableStart + effectiveDuration * 0.45, score: 0.25, luma: 120 }
  );
  highActionWindows.push({
    startSec: usableStart,
    endSec: Number(duration.toFixed(2)),
    climaxSec: Number(Math.max(usableStart, peak.timeSec).toFixed(2)),
    motionScore: Number(peak.score.toFixed(3)),
  });

  // Build varied multi-beat visual pacing plan from real motion/scene changes (without shortening duration)
  const relDuration = Math.max(1.5, duration - usableStart);
  const hookEnd = Number(
    Math.min(relDuration * 0.35, relDuration > 45 ? 3.0 : Math.max(1.8, relDuration * 0.2)).toFixed(2)
  );
  const payoffStart = Number(
    Math.max(hookEnd + 0.8, relDuration - Math.min(9.5, Math.max(2.2, relDuration * 0.13))).toFixed(2)
  );
  const targetInteriorCuts =
    relDuration <= 15
      ? 2
      : relDuration <= 45
      ? 4
      : Math.max(6, Math.min(18, Math.round(relDuration / 9.5)));

  // Gather candidate cut anchors from real scene cuts and motion shifts
  const relSceneCuts = sceneCutTimestampsSec
    .map((t) => Number((t - usableStart).toFixed(2)))
    .filter((t) => t > hookEnd + 1.5 && t < payoffStart - 1.5);

  const anchors: number[] = [0, hookEnd];
  const minGap = relDuration > 45 ? 5.0 : 2.2;
  for (const cutT of relSceneCuts) {
    if (cutT - anchors[anchors.length - 1] >= minGap && anchors.length < targetInteriorCuts + 1) {
      anchors.push(cutT);
    }
  }

  // Fill any long stretch (>12s on long explainers or >6s on short clips) with balanced beat cuts
  const maxSpan = relDuration > 45 ? 11.5 : 5.5;
  anchors.push(payoffStart, Number(relDuration.toFixed(2)));
  anchors.sort((a, b) => a - b);

  const boundaries: number[] = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) {
    const prev = boundaries[boundaries.length - 1];
    const next = anchors[i];
    if (next - prev < 0.8 && i < anchors.length - 1) continue;
    if (next - prev > maxSpan && next < relDuration - 0.5) {
      const steps = Math.ceil((next - prev) / maxSpan);
      const stepLen = (next - prev) / steps;
      for (let s = 1; s < steps; s++) {
        boundaries.push(Number((prev + s * stepLen).toFixed(2)));
      }
    }
    boundaries.push(Number(next.toFixed(2)));
  }

  const relClimax = Math.max(0, peak.timeSec - usableStart);
  const pacingBeats: PacingBeat[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const bStart = boundaries[i];
    const bEnd = boundaries[i + 1];
    if (bEnd - bStart < 0.4) continue;
    const midAbs = usableStart + (bStart + bEnd) * 0.5;
    const localSamples = motionScores.filter(
      (m) => m.timeSec >= usableStart + bStart - 1.5 && m.timeSec <= usableStart + bEnd + 1.5
    );
    const localMotion =
      localSamples.length > 0
        ? localSamples.reduce((acc, m) => acc + m.score, 0) / localSamples.length
        : avgMotion;
    const isNearSceneCut = relSceneCuts.some((ct) => Math.abs(ct - bStart) < 1.2);
    const isClimaxBeat =
      i > 0 &&
      i < boundaries.length - 2 &&
      relClimax >= bStart &&
      relClimax <= bEnd;

    let kind: PacingBeatKind;
    let zoomFrom = 1.04;
    let zoomTo = 1.09;
    let panX = i % 2 === 0 ? 0.008 : -0.008;
    let panY = i % 3 === 0 ? 0.006 : -0.005;
    let transitionFlash = 0;

    if (i === 0) {
      kind = 'hook_impact';
      zoomFrom = 1.09;
      zoomTo = 1.045;
      panX = 0;
      panY = -0.005;
      transitionFlash = 0.11;
    } else if (i === boundaries.length - 2) {
      kind = 'payoff_reveal';
      zoomFrom = 1.055;
      zoomTo = 1.115;
      panX = 0;
      panY = 0.004;
      transitionFlash = 0.12;
    } else if (isClimaxBeat || (relDuration > 45 && i === Math.floor((boundaries.length - 1) * 0.6))) {
      kind = 'twist_transition';
      zoomFrom = 1.05;
      zoomTo = 1.125;
      panX = i % 2 === 0 ? 0.008 : -0.008;
      panY = -0.005;
      transitionFlash = 0.13;
    } else if (localMotion < 0.09) {
      kind = 'jump_trim_pause';
      zoomFrom = 1.075;
      zoomTo = 1.11;
      panX = i % 2 === 0 ? -0.008 : 0.008;
      panY = 0.004;
      transitionFlash = 0.05;
    } else if (isNearSceneCut || i % 3 === 1) {
      kind = 'clean_cut';
      zoomFrom = 1.045;
      zoomTo = 1.09;
      panX = i % 2 === 0 ? 0.008 : -0.008;
      panY = -0.004;
      transitionFlash = 0.06;
    } else {
      kind = 'zoom_accent';
      const pullOut = i % 2 === 0;
      zoomFrom = pullOut ? 1.095 : 1.045;
      zoomTo = pullOut ? 1.045 : 1.105;
      panX = pullOut ? -0.007 : 0.007;
      panY = 0.004;
      transitionFlash = 0.04;
    }

    pacingBeats.push({
      startSec: bStart,
      endSec: bEnd,
      kind,
      zoomFrom,
      zoomTo,
      panX,
      panY,
      transitionFlash,
      motionIntensity: Number(Math.min(1, Math.max(0.05, localMotion * 2.6 + (midAbs > 0 ? 0 : 0))).toFixed(3)),
    });
  }

  return {
    sceneCutTimestampsSec,
    highActionWindows,
    detectedWatermarkZones,
    suggestedSafeCropInsets,
    hasOutroBumper,
    visualSummary,
    pacingBeats,
    framesSampled: frames.length,
  };
}

let fallbackScriptRunCounter = 0;
let lastUsedFallbackVariant = -1;

function pickNonRepeatingVariant(seed: number, poolLength: number): number {
  if (poolLength <= 1) return 0;
  let idx = Math.abs(seed) % poolLength;
  if (idx === lastUsedFallbackVariant) {
    idx = (idx + 1) % poolLength;
  }
  lastUsedFallbackVariant = idx;
  return idx;
}

/**
 * Clean, dynamic, duration-calibrated local fallback when cloud AI is blocked or offline.
 * Varies phrasing across runs using clip duration, framing, pacing, lighting, and language
 * so consecutive videos NEVER receive the same canned script or raw camera IDs.
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
  const roundedDur = Math.round(dur);
  const safeSpeechEnd = Math.max(2.5, dur - 0.35);

  const readableTopic = extractReadableTopicFromLabel(sourceLabel, customAngle);
  const visual = clip.visualSummary;
  const climaxSecRounded = Math.max(1, Math.round(clip.climaxSec));
  const sceneCuts = visual?.sceneCutCount ?? 0;
  const isFast = visual?.pacing === 'fast-cut';
  const isSteady = visual?.pacing === 'steady';
  const orientation = visual?.orientation ?? 'vertical';
  const formatWord =
    orientation === 'landscape'
      ? 'widescreen'
      : orientation === 'square'
      ? 'square'
      : 'vertical';
  const lightingNote =
    visual?.lighting === 'bright'
      ? 'bright, crisp'
      : visual?.lighting === 'high-contrast'
      ? 'high-contrast'
      : 'cinematic';

  // Mine live YouTube Data API v3 tags, keywords, and upload-hour signals when available
  const liveTrendTags: string[] = [];
  for (const t of trends) {
    if (Array.isArray(t.tags)) {
      for (const tg of t.tags) {
        const clean = tg.trim().toLowerCase();
        if (clean.length >= 3 && clean.length <= 32 && !liveTrendTags.includes(clean)) {
          liveTrendTags.push(clean);
        }
      }
    }
  }
  const trendKeyword =
    liveTrendTags[0] ||
    trends[0]?.title
      ?.replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(' ') ||
    'Spotlight';

  // Derive EST/IST peak window from real YouTube top-video publish hours when available
  const formatHour12 = (hour24: number): string => {
    const h = ((hour24 % 24) + 24) % 24;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:00 ${suffix}`;
  };
  let liveUploadWindow: string | null = null;
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
    liveUploadWindow =
      language === 'hi'
        ? `यूट्यूब ट्रेंड पीक (${trends.length} लाइव वीडियो): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`
        : `YouTube Trend Peak (${trends.length} live videos): ${formatHour12(estStart)} – ${formatHour12(estEnd)} EST | ${formatHour12(istStart)} – ${formatHour12(istEnd)} IST`;
  }

  // Compute non-repeating variant seed from clip metrics + session counter
  fallbackScriptRunCounter += 1;
  let labelHash = 0;
  for (let i = 0; i < sourceLabel.length; i++) {
    labelHash = (labelHash * 31 + sourceLabel.charCodeAt(i)) | 0;
  }
  const variantSeed =
    Math.abs(labelHash) +
    roundedDur * 7 +
    climaxSecRounded * 13 +
    clip.clipIndex * 17 +
    sceneCuts * 5 +
    fallbackScriptRunCounter * 23;

  // Combinatoric suspense/explainer composer scaling smoothly from short clips up to 1-2+ minute explainers
  const sentenceCount =
    dur <= 10
      ? 2
      : dur <= 22
      ? 3
      : dur <= 40
      ? 4
      : Math.max(5, Math.min(18, Math.round(dur / 10)));
  const pickFrom = (pool: string[], salt: number): string => {
    const idx = Math.abs(variantSeed + salt * 37 + fallbackScriptRunCounter * 11) % pool.length;
    return pool[idx];
  };

  let chosenLines: string[];
  let titleVariant = '';

  if (language === 'hi') {
    const subjectHi = readableTopic ? `${readableTopic}` : 'यह दृश्य';
    const paceCueHi = isFast
      ? 'तेज़ी से बदलते इन शॉट्स के बीच'
      : isSteady
      ? 'इस शांत दिखने वाले पल के ठीक पीछे'
      : 'इन लगातार आगे बढ़ते फ्रेम्स के बीच';
    const cutCueHi =
      sceneCuts >= 2
        ? `${sceneCuts} अचानक कट्स के ठीक बाद`
        : `${climaxSecRounded} सेकंड पूरे होते ही`;

    const hiHooks = [
      `पहली नज़र में ${subjectHi} बिल्कुल सामान्य लगता है, लेकिन अगले कुछ सेकंड सब कुछ पलट देने वाले हैं।`,
      `ज़्यादातर लोग पहले दो सेकंड में ही हार मान लेते हैं, पर ${subjectHi} का असली खेल अभी शुरू हुआ है।`,
      `ज़रा रुकिए, क्योंकि ${roundedDur} सेकंड के इस क्लिप में जो होने वाला है उसका अंदाज़ा किसी को नहीं था।`,
      `${subjectHi} की यह शुरुआत जितनी शांत दिख रही है, इसका अंजाम उतना ही चौंकाने वाला है।`,
      `आँखें स्क्रीन से मत हटाइए, क्योंकि यहाँ हर एक सेकंड के साथ सस्पेंस और गहरा होता जा रहा है।`,
    ];
    const hiEscalations = [
      `${paceCueHi} दबाव लगातार बढ़ता जाता है और ${cutCueHi} पूरा माहौल अचानक बदल जाता है।`,
      `जैसे ही घड़ी ${climaxSecRounded} सेकंड के करीब पहुँचती है, असली मोड़ सीधे सामने आकर सबको हैरान कर देता है।`,
      `ठीक ${climaxSecRounded} सेकंड पर वह अनोखी चाल दिखती है जिसने इस पूरे सीक्वेंस की दिशा ही बदल दी।`,
      `${cutCueHi} अचानक एक ऐसा ट्विस्ट आता है जिसे पहली बार में पकड़ पाना लगभग नामुमकिन है।`,
      `हर अगले फ्रेम में तनाव बढ़ता है, और ${climaxSecRounded} सेकंड पर असली राज़ से पर्दा उठ जाता है।`,
    ];
    const hiExplainerDepth = [
      `यहाँ सबसे बारीक बात यह है कि हर छोटा कदम आगे आने वाले बड़े बदलाव की नींव रख रहा है।`,
      `अगर आप इस पल को ध्यान से देखें तो साफ समझ आता है कि समय और सटीकता यहाँ सबसे बड़ी भूमिका निभाते हैं।`,
      `अब कहानी दूसरे चरण में प्रवेश करती है, जहाँ एक छोटी सी चूक भी पूरा परिणाम बदल सकती है।`,
      `लेकिन रुकिए—यह अभी सिर्फ़ आधी तस्वीर है, क्योंकि असली चुनौती अब ठीक सामने आने वाली है।`,
      `जैसे-जैसे दृश्य आगे बढ़ता है, पहले जो अंदाज़ा लगाया गया था वह पूरी तरह उल्टा साबित होने लगता है।`,
      `यही कारण है कि दर्शक इस हिस्से को बार-बार रोककर देखते हैं ताकि कोई भी ज़रूरी संकेत छूट न जाए।`,
      `अब हर सेकंड पहले से ज़्यादा निर्णायक हो जाता है और पूरा ध्यान सीधे अगले कदम पर टिक जाता है।`,
      `इस मोड़ पर आकर पूरी प्रक्रिया की असली वजह एकदम शीशे की तरह साफ हो जाती है।`,
      `तनाव अपने चरम पर पहुँच चुका है, और अब वही पल आ रहा है जिसका सबको इंतज़ार था।`,
      `आखिरी हिस्से में सारी कड़ियाँ आपस में जुड़ती हैं और पूरा रहस्य सामने खुलकर आ जाता है।`,
    ];
    const hiTwists = [
      `जिस नतीजे की उम्मीद थी वह बिल्कुल नहीं हुआ, बल्कि आखिरी पल में पूरा सीन ही पलट गया।`,
      `यही वह चौंकाने वाला ट्विस्ट है जिसकी वजह से लोग इस ${roundedDur} सेकंड के वीडियो को दोबारा देख रहे हैं।`,
      `आखिरी सेकंड तक पहुँचते ही पूरा सस्पेंस खत्म होता है और असली कमाल साफ दिखाई देता है।`,
      `नज़दीकी वर्टिकल एंगल की वजह से वह अनदेखा ट्विस्ट आखिरी पल में बिल्कुल साफ उभर कर सामने आता है।`,
    ];
    const hiClosers = [
      `क्या आपने इस ट्विस्ट का अंदाज़ा पहले ही लगा लिया था, कमेंट में सच बताइए।`,
      `ऐसे ही रोंगटे खड़े कर देने वाले ट्विस्ट वीडियो के लिए चैनल को अभी फॉलो करें।`,
      `इस ${roundedDur} सेकंड के सस्पेंस को सेव करें और दोस्तों को चौंकाने के लिए शेयर करें।`,
    ];

    const vIdx = pickNonRepeatingVariant(variantSeed, hiHooks.length);
    if (sentenceCount <= 4) {
      const fullStory = [
        hiHooks[vIdx],
        pickFrom(hiEscalations, vIdx + 2),
        pickFrom(hiTwists, vIdx + 5),
        pickFrom(hiClosers, vIdx + 7),
      ];
      chosenLines = fullStory.slice(0, sentenceCount);
    } else {
      const midCount = Math.max(1, sentenceCount - 4);
      const midLines: string[] = [];
      for (let m = 0; m < midCount; m++) {
        midLines.push(hiExplainerDepth[(vIdx + m) % hiExplainerDepth.length]);
      }
      chosenLines = [
        hiHooks[vIdx],
        pickFrom(hiEscalations, vIdx + 2),
        ...midLines,
        pickFrom(hiTwists, vIdx + 5),
        pickFrom(hiClosers, vIdx + 7),
      ];
    }

    const hiTitles = readableTopic
      ? [
          `${readableTopic} में ऐसा ट्विस्ट किसी ने नहीं सोचा था!`,
          `${readableTopic}: ${climaxSecRounded} सेकंड पर पलटा पूरा खेल`,
          `आखिरी पल तक देखिए — ${readableTopic} का चौंकाने वाला अंत`,
          `${readableTopic} का वह सस्पेंस जो सबको हैरान कर दे (${roundedDur}s)`,
        ]
      : [
          `${climaxSecRounded} सेकंड पर अचानक पलट गया पूरा सीन!`,
          `शुरुआत शांत थी, लेकिन आखिरी ${roundedDur} सेकंड का ट्विस्ट चौंका देगा`,
          `किसी ने इस मोड़ की उम्मीद नहीं की थी (${roundedDur}s सस्पेंस)`,
          `अंत तक रुकिए — इस क्लिप का असली ट्विस्ट अभी बाकी है`,
          `सिर्फ ${roundedDur} सेकंड में सबसे चौंकाने वाला मोड़!`,
        ];
    titleVariant = hiTitles[(vIdx + fallbackScriptRunCounter) % hiTitles.length];
  } else {
    const subjectEn = readableTopic ? readableTopic : 'this scene';
    const paceCueEn = isFast
      ? 'through these rapid cuts'
      : isSteady
      ? 'beneath this deceptively calm buildup'
      : 'as the momentum tightens';
    const cutCueEn =
      sceneCuts >= 2
        ? `right after ${sceneCuts} sharp cuts`
        : `the instant we hit ${climaxSecRounded} seconds`;

    const enHooks = [
      `At first glance, ${subjectEn} looks completely ordinary, until the tension snaps seconds later.`,
      `Almost everyone scrolls past too early and misses the exact twist hiding inside ${subjectEn}.`,
      `Hold on, because nothing in the first three seconds prepares you for where this ${roundedDur}-second clip goes next.`,
      `What starts out calm in ${subjectEn} is actually setting up a twist nobody saw coming.`,
      `Don't blink for the next ${roundedDur} seconds, because the real story isn't what it looks like at the start.`,
      `Watch how fast everything changes once ${subjectEn} stops playing by the rules.`,
    ];
    const enEscalations = [
      `Stay locked in ${paceCueEn}, because ${cutCueEn}, the entire situation flips upside down.`,
      `Right around ${climaxSecRounded} seconds, the buildup cracks open and reveals what was really happening all along.`,
      `Every second raises the stakes until ${cutCueEn} delivers the shock move at the heart of the clip.`,
      `Just when you think you've figured out the outcome, ${climaxSecRounded} seconds hits and changes the whole story.`,
      `Tension builds frame by frame until ${cutCueEn} exposes the sudden twist right in front of the lens.`,
    ];
    const enExplainerDepth = [
      `What most viewers miss here is how every small move quietly sets up the bigger shift ahead.`,
      `Watch the timing closely, because precision in this exact stretch decides how the entire moment plays out.`,
      `Now the stakes climb fast, and a single hesitation would completely break the rhythm you are seeing.`,
      `Wait—do not look away yet, because what happens in the next phase flips the early assumption upside down.`,
      `Look how the pressure builds step by step while the real objective stays hidden right in plain sight.`,
      `This is the stretch that makes viewers rewind twice just to catch the subtle clue before the reveal.`,
      `Every frame tightens the tension as the sequence moves closer to its make-or-break turning point.`,
      `Once you see how these pieces lock together, the entire strategy behind the scene suddenly makes total sense.`,
      `With the climax right around the corner, the momentum shifts into overdrive and leaves zero room for error.`,
      `In the final stretch, every earlier detail pays off at once and brings the whole story into crystal focus.`,
    ];
    const enTwists = [
      `The payoff lands out of nowhere, turning a ${roundedDur}-second moment into an instant replay.`,
      `That single twist flips the whole ${formatWord} sequence and explains why viewers keep watching twice.`,
      `In crisp, ${lightingNote} close-up detail, the final seconds deliver the exact shock nobody expected.`,
      `By the closing beat, the real reveal hits hard and leaves zero doubt why this moment stands out.`,
    ];
    const enClosers = [
      `Did you call that twist before ${climaxSecRounded} seconds, or did it catch you off guard?`,
      `Follow for more gripping ${roundedDur}-second stories that hit harder every time.`,
      `Save this video and send it to someone who never sees the ending coming.`,
    ];

    const vIdx = pickNonRepeatingVariant(variantSeed, enHooks.length);
    if (sentenceCount <= 4) {
      const fullStory = [
        enHooks[vIdx],
        pickFrom(enEscalations, vIdx + 3),
        pickFrom(enTwists, vIdx + 6),
        pickFrom(enClosers, vIdx + 9),
      ];
      chosenLines = fullStory.slice(0, sentenceCount);
    } else {
      const midCount = Math.max(1, sentenceCount - 4);
      const midLines: string[] = [];
      for (let m = 0; m < midCount; m++) {
        midLines.push(enExplainerDepth[(vIdx + m) % enExplainerDepth.length]);
      }
      chosenLines = [
        enHooks[vIdx],
        pickFrom(enEscalations, vIdx + 3),
        ...midLines,
        pickFrom(enTwists, vIdx + 6),
        pickFrom(enClosers, vIdx + 9),
      ];
    }

    const enTitles = readableTopic
      ? [
          `Nobody Saw This ${readableTopic} Twist Coming!`,
          `${readableTopic} Flips Everything at ${climaxSecRounded}s`,
          `Wait Until the End of This ${readableTopic} Story`,
          `The ${roundedDur}-Second ${readableTopic} Twist Everyone Missed`,
        ]
      : [
          `Wait for the ${climaxSecRounded}-Second Twist Nobody Expected${trends.length > 0 ? ` (${trendKeyword})` : ''}`,
          `It Looked Normal Until ${climaxSecRounded}s Changed Everything`,
          `Don't Blink — This ${roundedDur}s Ending Hits Hard${trends.length > 0 ? ` | ${trendKeyword}` : ''}`,
          `You Won't Guess How This ${roundedDur}-Second Story Ends`,
          `The Sudden ${climaxSecRounded}s Twist That Stops Every Scroll`,
        ];
    titleVariant = enTitles[(vIdx + fallbackScriptRunCounter) % enTitles.length];
  }

  // Align offline script beat timings monotonically to pacingBeats (zero overlap even when lines > beats)
  const pacing = clip.pacingBeats ?? [];
  let beats: ScriptBeat[];
  if (pacing.length >= 2 && chosenLines.length >= 2) {
    const lineCount = chosenLines.length;
    const rawStarts: number[] = chosenLines.map((_, idx) => {
      if (idx === 0) return 0.05;
      const pos = (idx / lineCount) * pacing.length;
      const baseIdx = Math.min(pacing.length - 1, Math.floor(pos));
      const frac = pos - baseIdx;
      const b = pacing[baseIdx];
      return Math.min(safeSpeechEnd - 0.25, b.startSec + frac * Math.max(0.2, b.endSec - b.startSec));
    });
    beats = [];
    let prevEnd = 0.05;
    for (let idx = 0; idx < lineCount; idx++) {
      const startSec = Number(
        (idx === 0 ? 0.05 : Math.max(prevEnd, Math.min(safeSpeechEnd - 0.2, rawStarts[idx]))).toFixed(2)
      );
      const nextTarget =
        idx === lineCount - 1 ? safeSpeechEnd : Math.max(startSec + 0.35, rawStarts[idx + 1]);
      const endSec = Number(Math.max(startSec + 0.2, Math.min(safeSpeechEnd, nextTarget)).toFixed(2));
      beats.push({ startSec, endSec, text: chosenLines[idx] });
      prevEnd = endSec;
    }
  } else {
    const wordCounts = chosenLines.map((l) => l.split(/\s+/).filter(Boolean).length);
    const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;
    let cursor = 0.05;
    beats = chosenLines.map((text, idx) => {
      const share = (wordCounts[idx] / totalWords) * (safeSpeechEnd - 0.1);
      const startSec = Number(cursor.toFixed(2));
      const endSec = Number(
        (idx === chosenLines.length - 1 ? safeSpeechEnd : Math.min(safeSpeechEnd, cursor + share)).toFixed(2)
      );
      cursor = endSec;
      return { startSec, endSec, text };
    });
  }

  const voiceover = beats.map((b) => b.text).join(' ');
  const displayTitleSubject = readableTopic || titleVariant;
  const title = titleVariant;

  const description =
    language === 'hi'
      ? `${displayTitleSubject}\n\nइस ${roundedDur} सेकंड की सस्पेंस क्लिप में:\n• तेज़ हुक और ${climaxSecRounded} सेकंड पर अनपेक्षित ट्विस्ट\n• फुल वर्टिकल फ्रेमिंग, सिनेमा कलर ग्रेड और दमदार हिंदी वॉइसओवर\n\nऐसे ही सस्पेंस और ट्विस्ट शॉर्ट्स के लिए सब्सक्राइब करें।`
      : `${displayTitleSubject}\n\nInside this ${roundedDur}-second suspense clip:\n• Dramatic hook building straight into the ${climaxSecRounded}s twist\n• Full-bleed vertical framing, ${lightingNote} cinema color grade, and powerful narration\n\nSubscribe for daily ${trendKeyword} twists and high-retention stories.`;

  const tagList =
    language === 'hi'
      ? [
          ...(readableTopic ? [readableTopic] : []),
          'सस्पेंस शॉर्ट्स',
          'हिंदी कहानी',
          'ट्विस्ट वीडियो',
          'वायरल शॉर्ट्स हिंदी',
          'रोमांचक क्लिप',
          'हिंदी वॉइसओवर',
          'यूट्यूब शॉर्ट्स हिंदी',
          'ट्रेंडिंग वीडियो',
        ]
          .filter((v, i, arr) => v.length > 1 && arr.indexOf(v) === i)
          .slice(0, 10)
      : [
          ...(readableTopic ? [readableTopic.toLowerCase()] : []),
          ...liveTrendTags.slice(0, 6),
          'suspense shorts',
          'plot twist story',
          'viral shorts explained',
          'shorts',
          'reels',
          'storytelling',
          trendKeyword.toLowerCase(),
        ]
          .filter((v, i, arr) => v.length > 1 && arr.indexOf(v) === i)
          .slice(0, 12);

  const dynamicHashtags =
    language === 'hi'
      ? []
      : liveTrendTags
          .slice(0, 3)
          .map((tg) => `#${tg.replace(/[^\p{L}\p{N}]+/gu, '')}`)
          .filter((h) => h.length > 3);

  const baseHashtags =
    language === 'hi'
      ? ['#सस्पेंस', '#हिंदीशॉर्ट्स', '#ट्विस्ट', '#वायरलवीडियो', '#रोमांचककहानी']
      : ['#Shorts', '#Suspense', '#PlotTwist', '#ViralClip', '#Storytelling'];
  const hashtags = [...baseHashtags, ...dynamicHashtags]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 6)
    .join(' ');

  const postingTime =
    liveUploadWindow ||
    (language === 'hi'
      ? 'सबसे अच्छा अपलोड समय: 6:30 PM – 9:00 PM IST (भारत पीक) | 9:00 AM – 11:30 AM EST (अमेरिका मॉर्निंग)'
      : 'Best Upload Window: 11:30 AM – 2:00 PM EST & 6:00 PM – 8:30 PM EST (USA Peak) | 9:00 PM – 11:30 PM IST (India Peak)');

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
    aiSourceMode: 'fallback',
    aiFallbackReason: fallbackReason ?? 'Local fallback engine (no external API response)',
    youtubeTrendsCount: trends.length,
  };
}
