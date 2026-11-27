import { analyzeVideoTimelineLocally } from './offlineModels';
import { PIPELINE_15_WORKER_MODELS } from './modelRouter';
import type {
  PacingBeat,
  PacingBeatKind,
  PreparedVisualClip,
  SafeCropInsets,
  SourceMediaItem,
  TrimRange,
  ViralSegment,
  WatermarkZone,
} from '../types/studio';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clampSafeCrop(crop: SafeCropInsets): SafeCropInsets {
  // Enforce subject-safe anti-copyright edge crop (4.5%–7.0%) to strip raw borders & watermarks
  return {
    top: Number(clamp(Math.max(0.045, crop.top || 0), 0.045, 0.07).toFixed(4)),
    bottom: Number(clamp(Math.max(0.045, crop.bottom || 0), 0.045, 0.07).toFixed(4)),
    left: Number(clamp(Math.max(0.045, crop.left || 0), 0.045, 0.07).toFixed(4)),
    right: Number(clamp(Math.max(0.045, crop.right || 0), 0.045, 0.07).toFixed(4)),
  };
}

function ensureTopCornerMasks(
  existing: WatermarkZone[],
  clipDur: number
): WatermarkZone[] {
  const dur = Number(Math.max(1, clipDur).toFixed(2));
  const outroStart = Number(Math.max(0, dur - 1.8).toFixed(2));
  const defaults: WatermarkZone[] = [
    {
      id: 'wm_top_left_cover',
      startSec: 0,
      endSec: dur,
      box: [0.0, 0.0, 0.28, 0.11],
      action: 'gpu_delogo_patch',
      label: 'Top-left corner delogo patch',
    },
    {
      id: 'wm_top_right_cover',
      startSec: 0,
      endSec: dur,
      box: [0.72, 0.0, 1.0, 0.11],
      action: 'gpu_delogo_patch',
      label: 'Top-right corner delogo patch',
    },
    {
      id: 'wm_bottom_right_badge',
      startSec: 0,
      endSec: dur,
      box: [0.64, 0.85, 1.0, 1.0],
      action: 'gpu_delogo_patch',
      label: 'Bottom-right creator badge patch',
    },
    {
      id: 'wm_outro_tail_badge',
      startSec: outroStart,
      endSec: dur,
      box: [0.0, 0.85, 0.38, 1.0],
      action: 'gpu_delogo_patch',
      label: 'Outro tail bottom-left badge patch',
    },
    {
      id: 'wm_outro_top_tag',
      startSec: outroStart,
      endSec: dur,
      box: [0.24, 0.0, 0.76, 0.11],
      action: 'gpu_delogo_patch',
      label: 'Outro tail top creator tag patch',
    },
    {
      id: 'wm_outro_bottom_center_id',
      startSec: outroStart,
      endSec: dur,
      box: [0.24, 0.88, 0.76, 1.0],
      action: 'gpu_delogo_patch',
      label: 'Outro tail bottom-center creator ID patch',
    },
  ];

  // Guarantee all 6 corner & outro-tail delogo zones fit inside the GPU shader's 6-zone array
  const extraNonTop = existing.filter((z) => {
    const cy = (z.box[1] + z.box[3]) / 2;
    return cy >= 0.5 && z.action === 'gpu_delogo_patch';
  });
  return [...defaults, ...extraNonTop].slice(0, 6);
}

function sanitizeWatermarkZones(
  zones: WatermarkZone[],
  clipStartSec: number,
  clipEndSec: number
): WatermarkZone[] {
  const clipDur = Math.max(1, clipEndSec - clipStartSec);
  return zones
    .map((z, idx) => {
      const x1 = clamp(z.box[0], 0, 0.95);
      const y1 = clamp(z.box[1], 0, 0.95);
      const x2 = clamp(z.box[2], x1 + 0.02, 1);
      const y2 = clamp(z.box[3], y1 + 0.02, 1);
      const relStart = clamp(z.startSec - clipStartSec, 0, clipDur);
      const relEnd = clamp(
        z.endSec > clipStartSec ? z.endSec - clipStartSec : clipDur,
        relStart + 0.25,
        clipDur
      );
      return {
        id: z.id || `wm_${idx + 1}`,
        startSec: Number(relStart.toFixed(2)),
        endSec: Number(relEnd.toFixed(2)),
        box: [x1, y1, x2, y2] as [number, number, number, number],
        action: z.action,
        label: z.label || 'Corner watermark',
      };
    })
    .filter((z) => {
      // Only keep zones near edges/corners so center subject is untouched
      const cx = (z.box[0] + z.box[2]) / 2;
      const cy = (z.box[1] + z.box[3]) / 2;
      const nearEdge = cx < 0.28 || cx > 0.72 || cy < 0.16 || cy > 0.84;
      const boxArea = (z.box[2] - z.box[0]) * (z.box[3] - z.box[1]);
      return nearEdge && boxArea <= 0.12;
    });
}

function normalizePacingBeats(
  rawBeats: PacingBeat[] | undefined,
  clipDur: number,
  climaxRelSec: number
): PacingBeat[] {
  const safeDur = Number(Math.max(1.5, clipDur).toFixed(2));
  const chainContinuity = (beats: PacingBeat[]): PacingBeat[] => {
    const out: PacingBeat[] = [];
    for (let i = 0; i < beats.length; i++) {
      const curr = { ...beats[i] };
      if (i > 0) {
        const prev = out[i - 1];
        curr.startSec = prev.endSec;
        // Preserve visual continuity across connected narrative beats while allowing crisp motivated framing shifts on cuts
        const isHardCut =
          curr.kind === 'clean_cut' ||
          curr.kind === 'jump_trim_pause' ||
          curr.kind === 'twist_transition';
        const maxZoomStep = isHardCut ? 0.045 : 0.022;
        curr.zoomFrom = Number(
          clamp(
            curr.zoomFrom,
            Math.max(1.03, prev.zoomTo - maxZoomStep),
            Math.min(1.12, prev.zoomTo + maxZoomStep)
          ).toFixed(3)
        );
        curr.zoomTo = Number(clamp(curr.zoomTo, 1.03, 1.13).toFixed(3));
        // Keep consecutive pans gentle and alternating smoothly through frame center
        curr.panX = Number(clamp(curr.panX, -0.009, 0.009).toFixed(4));
        curr.panY = Number(clamp(curr.panY, -0.007, 0.006).toFixed(4));
      }
      out.push(curr);
    }
    if (out.length > 0) {
      out[0].startSec = 0;
      out[out.length - 1].endSec = safeDur;
    }
    return out;
  };

  if (Array.isArray(rawBeats) && rawBeats.length >= 2) {
    const bounded: PacingBeat[] = [];
    let cursor = 0;
    for (let i = 0; i < rawBeats.length; i++) {
      const b = rawBeats[i];
      const startSec = Number(Math.max(cursor, clamp(b.startSec, 0, safeDur - 0.3)).toFixed(2));
      const endSec =
        i === rawBeats.length - 1
          ? safeDur
          : Number(clamp(b.endSec, startSec + 0.35, safeDur).toFixed(2));
      if (endSec - startSec < 0.2) continue;
      bounded.push({
        ...b,
        startSec,
        endSec,
        zoomFrom: clamp(b.zoomFrom, 1.03, 1.12),
        zoomTo: clamp(b.zoomTo, 1.03, 1.13),
        panX: clamp(b.panX, -0.009, 0.009),
        panY: clamp(b.panY, -0.007, 0.006),
        transitionFlash: clamp(b.transitionFlash, 0, 0.14),
      });
      cursor = endSec;
      if (cursor >= safeDur - 0.05) break;
    }
    if (bounded.length >= 2) {
      return chainContinuity(bounded);
    }
  }

  // Synthesize varied multi-beat scene plan preserving full duration when scan beats are unavailable
  const beatCount =
    safeDur <= 16
      ? 3
      : safeDur <= 45
      ? 5
      : Math.max(7, Math.min(18, Math.round(safeDur / 9.5)));
  const hookEnd = Number(Math.min(safeDur * 0.3, safeDur > 45 ? 3.0 : 2.2).toFixed(2));
  const payoffStart = Number(
    Math.max(hookEnd + 0.8, safeDur - Math.min(9.0, Math.max(2.2, safeDur * 0.13))).toFixed(2)
  );
  const middleCount = Math.max(1, beatCount - 2);
  const middleSpan = (payoffStart - hookEnd) / middleCount;
  const cycleKinds: PacingBeatKind[] = ['clean_cut', 'zoom_accent', 'jump_trim_pause'];

  const out: PacingBeat[] = [
    {
      startSec: 0,
      endSec: hookEnd,
      kind: 'hook_impact',
      zoomFrom: 1.09,
      zoomTo: 1.045,
      panX: 0,
      panY: -0.005,
      transitionFlash: 0.11,
      motionIntensity: 0.75,
    },
  ];

  for (let m = 0; m < middleCount; m++) {
    const bStart = Number((hookEnd + m * middleSpan).toFixed(2));
    const bEnd = Number((m === middleCount - 1 ? payoffStart : hookEnd + (m + 1) * middleSpan).toFixed(2));
    const isClimax = climaxRelSec >= bStart && climaxRelSec <= bEnd;
    const kind: PacingBeatKind = isClimax
      ? 'twist_transition'
      : cycleKinds[m % cycleKinds.length];
    const pullOut = kind === 'zoom_accent' && m % 2 === 1;
    out.push({
      startSec: bStart,
      endSec: bEnd,
      kind,
      zoomFrom: kind === 'jump_trim_pause' ? 1.075 : pullOut ? 1.095 : 1.045,
      zoomTo: kind === 'twist_transition' ? 1.125 : kind === 'jump_trim_pause' ? 1.11 : pullOut ? 1.045 : 1.095,
      panX: m % 2 === 0 ? 0.008 : -0.008,
      panY: m % 3 === 0 ? 0.004 : -0.004,
      transitionFlash: kind === 'twist_transition' ? 0.13 : kind === 'clean_cut' ? 0.06 : 0.04,
      motionIntensity: isClimax ? 0.9 : 0.45,
    });
  }

  out.push({
    startSec: payoffStart,
    endSec: safeDur,
    kind: 'payoff_reveal',
    zoomFrom: 1.055,
    zoomTo: 1.115,
    panX: 0,
    panY: 0.004,
    transitionFlash: 0.12,
    motionIntensity: 0.8,
  });

  return chainContinuity(out);
}

async function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const maxT = Math.max(0, (video.duration || timeSec + 0.1) - 0.06);
  const clamped = clamp(timeSec, 0, maxT);
  if (
    Math.abs(video.currentTime - clamped) < 0.01 &&
    video.readyState >= 2 &&
    video.videoWidth > 0
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      video.onseeked = null;
      resolve();
    };
    const timer = window.setTimeout(done, 4500);
    video.onseeked = () => {
      window.clearTimeout(timer);
      done();
    };
    try {
      video.currentTime = clamped;
    } catch {
      window.clearTimeout(timer);
      done();
    }
  });
  if (video.readyState < 2 || video.videoWidth <= 0) {
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 2000;
      const poll = window.setInterval(() => {
        if ((video.readyState >= 2 && video.videoWidth > 0) || Date.now() >= deadline) {
          window.clearInterval(poll);
          resolve();
        }
      }, 35);
    });
  }
}

/**
 * Conservatively detects dark/blank or frozen intro dead-air (up to 0.85s) at the start
 * of clips >= 6s so videos hook immediately without truncating real visual action.
 */
async function detectLeadingDeadAirSec(
  source: SourceMediaItem,
  totalDur: number
): Promise<number> {
  if (totalDur < 6 || typeof document === 'undefined') return 0;
  const probeTimes = [0.02, 0.25, 0.5, 0.78];
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';
  if (document.body) document.body.appendChild(video);
  video.src = source.objectUrl;

  try {
    if (video.readyState < 2 || video.videoWidth <= 0) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 4000);
        const ready = () => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            window.clearTimeout(timer);
            resolve();
          }
        };
        video.onloadeddata = ready;
        video.oncanplay = ready;
        video.onerror = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.load();
      });
    }
    if (video.readyState < 2 || video.videoWidth <= 0) return 0;

    const cw = 48;
    const ch = 48;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;

    let trimTo = 0;
    for (let i = 0; i < probeTimes.length; i++) {
      await seekVideo(video, probeTimes[i]);
      if (video.readyState < 2 || video.videoWidth <= 0) break;
      ctx.drawImage(video, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      let sumLuma = 0;
      let sumSq = 0;
      const n = cw * ch;
      for (let p = 0; p < data.length; p += 4) {
        const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        sumLuma += l;
        sumSq += l * l;
      }
      const meanLuma = sumLuma / n;
      const stdLuma = Math.sqrt(Math.max(0, sumSq / n - meanLuma * meanLuma));
      // Blank/black fade-in or flat solid card has very low brightness or near-zero texture variance
      if (meanLuma < 14 || stdLuma < 4.5) {
        trimTo = Math.min(0.85, probeTimes[i] + 0.14);
      } else {
        break;
      }
    }
    return Number(trimTo.toFixed(2));
  } catch {
    return 0;
  } finally {
    video.onloadeddata = null;
    video.oncanplay = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.parentNode) video.parentNode.removeChild(video);
  }
}

/**
 * Probes the final 0.2s..3.0s tail of a clip to detect dark/solid/static social end-cards
 * or creator-logo outro screens so they are cleanly trimmed without truncating real action.
 */
async function detectTrailingOutroSec(
  source: SourceMediaItem,
  totalDur: number
): Promise<number> {
  if (totalDur < 6 || typeof document === 'undefined') return 0;
  const maxDetectTrim = totalDur >= 10 ? 2.65 : 1.75;
  const offsetsFromEnd = [0.15, 0.55, 1.0, 1.5, 2.05, 2.55].filter((o) => o <= maxDetectTrim);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';
  if (document.body) document.body.appendChild(video);
  video.src = source.objectUrl;

  try {
    if (video.readyState < 2 || video.videoWidth <= 0) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 4000);
        const ready = () => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            window.clearTimeout(timer);
            resolve();
          }
        };
        video.onloadeddata = ready;
        video.oncanplay = ready;
        video.onerror = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.load();
      });
    }
    if (video.readyState < 2 || video.videoWidth <= 0) return 0;

    const cw = 48;
    const ch = 48;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;

    let trimFromEnd = 0;
    let prevPixels: Uint8ClampedArray | null = null;
    for (let i = 0; i < offsetsFromEnd.length; i++) {
      const off = offsetsFromEnd[i];
      const probeT = Math.max(0.5, totalDur - off);
      await seekVideo(video, probeT);
      if (video.readyState < 2 || video.videoWidth <= 0) break;
      ctx.drawImage(video, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;

      let sumLuma = 0;
      let sumSq = 0;
      let borderLumaSum = 0;
      let borderLumaSq = 0;
      let borderCount = 0;
      let diffSum = 0;
      const n = cw * ch;

      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const p = (y * cw + x) * 4;
          const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
          sumLuma += l;
          sumSq += l * l;
          if (x < 6 || x >= cw - 6 || y < 6 || y >= ch - 6) {
            borderLumaSum += l;
            borderLumaSq += l * l;
            borderCount++;
          }
          if (prevPixels) {
            diffSum +=
              Math.abs(data[p] - prevPixels[p]) +
              Math.abs(data[p + 1] - prevPixels[p + 1]) +
              Math.abs(data[p + 2] - prevPixels[p + 2]);
          }
        }
      }
      const meanLuma = sumLuma / n;
      const stdLuma = Math.sqrt(Math.max(0, sumSq / n - meanLuma * meanLuma));
      const borderMean = borderLumaSum / Math.max(1, borderCount);
      const borderStd = Math.sqrt(
        Math.max(0, borderLumaSq / Math.max(1, borderCount) - borderMean * borderMean)
      );
      const meanDiff = prevPixels ? diffSum / (n * 3) : 99;

      // Dark, white, colored-gradient, or static TikTok/Reels/Shorts end-cards have uniform borders or near-zero motion
      const isOutroCard =
        meanLuma < 24 ||
        meanLuma > 236 ||
        stdLuma < 11 ||
        (borderMean < 18 && stdLuma < 36) ||
        (borderStd < 15 && stdLuma < 42) ||
        (prevPixels !== null && meanDiff < 3.4) ||
        (prevPixels !== null && meanDiff < 5.5 && (borderMean < 32 || borderMean > 224 || borderStd < 22));

      if (isOutroCard) {
        trimFromEnd = Math.min(maxDetectTrim, off + 0.2);
        prevPixels = new Uint8ClampedArray(data);
      } else {
        break;
      }
    }
    return Number(trimFromEnd.toFixed(2));
  } catch {
    return 0;
  } finally {
    video.onloadeddata = null;
    video.oncanplay = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.parentNode) video.parentNode.removeChild(video);
  }
}

async function buildStampedContactSheet(params: {
  source: SourceMediaItem;
  startSec: number;
  endSec: number;
  crop: SafeCropInsets;
}): Promise<{
  jpegBase64: string;
  timestampsSec: number[];
  framesRendered: number;
  contactSheetBytes: number;
}> {
  const { source, startSec, endSec, crop } = params;
  const clipDur = Math.max(1, endSec - startSec);
  // Sample 12 frames (4x3) for 1-2+ minute explainers and 9 frames (3x3) for shorter clips
  const cols = clipDur > 45 ? 4 : 3;
  const rows = 3;
  const totalTiles = cols * rows;
  const timestampsSec: number[] = [];

  for (let i = 0; i < totalTiles; i++) {
    const frac = totalTiles === 1 ? 0.5 : i / (totalTiles - 1);
    const localSec = Number(
      clamp(frac * Math.max(0.5, clipDur - 0.15) + 0.05, 0, clipDur).toFixed(2)
    );
    timestampsSec.push(localSec);
  }

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

  try {
    if (video.readyState < 2 || video.videoWidth <= 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('Timed out extracting keyframes for contact sheet.')),
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
          reject(new Error('Unable to decode source video keyframes.'));
        };
        video.load();
      });
    }

    const vw = video.videoWidth || source.width || 1080;
    const vh = video.videoHeight || source.height || 1920;
    // Match exact 9:16 edited vertical framing (3x3 or 4x3) so Step 3 sees full scene progression
    const tileW = cols === 4 ? 192 : 216;
    const tileH = cols === 4 ? 340 : 384;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileW;
    canvas.height = rows * tileH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error(
        'Step 2 failed: browser 2D Canvas is unavailable to clean & grade video frames.'
      );
    }

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sx = Math.round(vw * crop.left);
    const sy = Math.round(vh * crop.top);
    const sw = Math.max(16, Math.round(vw * (1 - crop.left - crop.right)));
    const sh = Math.max(16, Math.round(vh * (1 - crop.top - crop.bottom)));
    const srcAspect = sw / Math.max(1, sh);
    const dstAspect = tileW / tileH;
    let coverSx = sx;
    let coverSy = sy;
    let coverSw = sw;
    let coverSh = sh;
    if (srcAspect > dstAspect) {
      coverSw = Math.round(sh * dstAspect);
      coverSx = sx + Math.round((sw - coverSw) / 2);
    } else {
      coverSh = Math.round(sw / dstAspect);
      coverSy = sy + Math.round((sh - coverSh) * 0.45);
    }

    let framesRendered = 0;
    for (let i = 0; i < totalTiles; i++) {
      const localSec = timestampsSec[i];
      const absSec = startSec + localSec;

      await seekVideo(video, absSec);

      const col = i % cols;
      const row = Math.floor(i / cols);
      const dx = col * tileW;
      const dy = row * tileH;

      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          ctx.save();
          ctx.filter = 'contrast(1.12) saturate(1.14) brightness(1.035)';
          ctx.drawImage(video, coverSx, coverSy, coverSw, coverSh, dx, dy, tileW, tileH);
          ctx.restore();
          framesRendered += 1;
        } catch {
          // Skip individual tile failure; verified below via framesRendered check
        }
      }

      // Timestamp stamp for exact second-by-second action alignment in Step 3
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(dx + 8, dy + 8, 86, 24);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 13px "JetBrains Mono", monospace';
      ctx.fillText(`T=${localSec.toFixed(1)}s`, dx + 15, dy + 24);
    }

    if (framesRendered === 0) {
      throw new Error(
        'Step 2 could not render any readable video frames onto the canvas. Please upload a standard H.264 MP4 or WebM file.'
      );
    }

    // Verify rendered contact sheet actually contains non-uniform pixel content (not a solid blank frame)
    try {
      const probeData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minLuma = 255;
      let maxLuma = 0;
      for (let p = 0; p < probeData.length; p += 256) {
        const l = probeData[p] * 0.299 + probeData[p + 1] * 0.587 + probeData[p + 2] * 0.114;
        if (l < minLuma) minLuma = l;
        if (l > maxLuma) maxLuma = l;
      }
      if (maxLuma - minLuma < 2) {
        throw new Error(
          'Step 2 rendered only blank solid frames from this video. Check that the uploaded video file plays normally.'
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Step 2')) {
        throw err;
      }
      throw new Error(
        'Step 2 canvas pixels were blocked by cross-origin security (CORS). Upload the video file locally instead of using a protected URL.'
      );
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    const jpegBase64 = dataUrl.split(',')[1] ?? '';
    const contactSheetBytes = Math.round((jpegBase64.length * 3) / 4);
    if (jpegBase64.length <= 500 || contactSheetBytes <= 500) {
      throw new Error(
        'Step 2 generated an empty contact sheet JPEG. Please re-upload a standard MP4 or WebM video.'
      );
    }
    return { jpegBase64, timestampsSec, framesRendered, contactSheetBytes };
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
}

/**
 * STEP 1 (Fetch & Smart Clipping):
 * Inspects real duration & keyframes locally (0 cloud AI calls so Step 3 keeps full quota)
 * and slices segments cleanly without hardcoded short-duration limits.
 */
export async function inspectAndSliceSegmentsStep1(params: {
  source: SourceMediaItem;
  onProgress?: (detail: string) => void;
}): Promise<{ segments: ViralSegment[]; inspectorModel: string; framesSampled: number }> {
  const { source, onProgress } = params;
  if (
    !source ||
    !source.objectUrl ||
    !Number.isFinite(source.durationSec) ||
    source.durationSec <= 0 ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    throw new Error(
      'Step 1 failed: source video metadata is incomplete or unreadable. Please upload a valid local MP4/MOV/WebM video file.'
    );
  }

  onProgress?.('Scanning real source duration, scene cuts, and corner marks locally...');

  const scan = await analyzeVideoTimelineLocally(source, onProgress);
  if (scan.framesSampled <= 0) {
    throw new Error(
      'Step 1 failed: zero video frames could be decoded from this source. Please upload a standard H.264 MP4 or WebM file directly.'
    );
  }

  const totalDur = Math.max(1, source.durationSec);
  // Trim trailing outro/creator-logo end-card cleanly while preserving full main clip duration
  const detectedOutroTail = await detectTrailingOutroSec(source, totalDur);
  const baseOutroTrim =
    totalDur >= 6
      ? scan.hasOutroBumper || source.trimSocialEndCard
        ? 1.75
        : totalDur <= 45
        ? 1.55
        : 1.45
      : totalDur >= 3.5
      ? Number(Math.min(1.0, totalDur * 0.18).toFixed(2))
      : 0;
  const outroTrim = Number(
    Math.min(totalDur >= 10 ? 2.65 : 1.8, Math.max(baseOutroTrim, detectedOutroTail)).toFixed(2)
  );
  const usableEnd = Number(Math.max(2, totalDur - outroTrim).toFixed(2));
  const safeCrop = clampSafeCrop(scan.suggestedSafeCropInsets);

  // Preserve the full intended edited duration (short clips OR 1-2+ minute explainers)
  // while cleanly trimming leading black/blank intro dead-air (capped at 0.85s) so hooks hit immediately.
  const primaryWin = scan.highActionWindows[0];
  const detectedIntroDeadAir = await detectLeadingDeadAirSec(source, totalDur);
  const rawStartSec = Math.max(primaryWin?.startSec ?? 0, detectedIntroDeadAir);
  const startSec = Number(clamp(rawStartSec, 0, Math.max(0, usableEnd - 1.2)).toFixed(2));
  const endSec = Number(clamp(usableEnd, startSec + 1.2, totalDur).toFixed(2));
  const climaxSec = Number(
    clamp(primaryWin?.climaxSec ?? startSec + (endSec - startSec) * 0.45, startSec, endSec).toFixed(2)
  );
  const clipZones = sanitizeWatermarkZones(
    scan.detectedWatermarkZones,
    startSec,
    endSec
  );

  const editedDur = Math.max(1.2, endSec - startSec);
  const relSceneCuts = scan.sceneCutTimestampsSec
    .map((t) => Number((t - startSec).toFixed(2)))
    .filter((t) => t > 0.5 && t < editedDur - 0.5);
  const pacingBeats = normalizePacingBeats(
    scan.pacingBeats,
    editedDur,
    Math.max(0, climaxSec - startSec)
  );

  const segments: ViralSegment[] = [
    {
      clipIndex: 1,
      startSec,
      endSec,
      climaxSec,
      reason: `Full edited explainer (${editedDur.toFixed(1)}s, ${pacingBeats.length} pacing beats, outro trimmed ${outroTrim.toFixed(1)}s) with peak action at ${climaxSec.toFixed(1)}s`,
      trimRange: { startSec, endSec },
      safeCropInsets: safeCrop,
      watermarkZones: clipZones,
      visualSummary: scan.visualSummary,
      sceneCutTimestampsSec: relSceneCuts,
      pacingBeats,
    },
  ];

  return {
    segments,
    inspectorModel: `Browser Canvas Scanner (${scan.framesSampled} frames · ${PIPELINE_15_WORKER_MODELS.step1[0]} role)`,
    framesSampled: scan.framesSampled,
  };
}

/**
 * STEP 2 (Visual Clean & Grade):
 * Locks subject-safe edge crop + time-windowed corner delogo masks + cinema color grade,
 * and builds a timestamp-stamped 3x2 contact sheet for Step 3's single AI translation call.
 */
export async function cleanAndGradeClipsStep2(params: {
  source: SourceMediaItem;
  segments: ViralSegment[];
  inspectorModel: string;
  onProgress?: (detail: string) => void;
}): Promise<PreparedVisualClip[]> {
  const { source, segments, inspectorModel, onProgress } = params;
  const prepared: PreparedVisualClip[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    onProgress?.(
      `Cleaning & grading clip ${i + 1}/${segments.length} (WebGL2 fallback for ${PIPELINE_15_WORKER_MODELS.step2[2]})...`
    );

    const safeCrop = clampSafeCrop(seg.safeCropInsets);
    const safeCropApplied =
      safeCrop.top > 0 ||
      safeCrop.bottom > 0 ||
      safeCrop.left > 0 ||
      safeCrop.right > 0;

    const startSec = Number(Math.max(0, seg.trimRange.startSec).toFixed(2));
    const endSec = Number(
      Math.max(startSec + 1, Math.min(source.durationSec, seg.trimRange.endSec)).toFixed(2)
    );
    const lockedVisualDurationSec = Number(Math.max(1, endSec - startSec).toFixed(2));

    const usableIntervals: TrimRange[] = [{ startSec, endSec }];
    const delogoZones = ensureTopCornerMasks(
      seg.watermarkZones.filter((z) => z.action === 'gpu_delogo_patch'),
      lockedVisualDurationSec
    );
    const bumperTrimmedSec =
      i === segments.length - 1
        ? Number(Math.max(0, source.durationSec - endSec).toFixed(2))
        : 0;

    const { jpegBase64, timestampsSec, framesRendered, contactSheetBytes } =
      await buildStampedContactSheet({
        source,
        startSec,
        endSec,
        crop: safeCrop,
      });

    const relClimaxSec = Number(clamp(seg.climaxSec - startSec, 0, lockedVisualDurationSec).toFixed(2));
    const pacingBeats = normalizePacingBeats(
      seg.pacingBeats,
      lockedVisualDurationSec,
      relClimaxSec
    );

    prepared.push({
      clipIndex: seg.clipIndex,
      totalClips: segments.length,
      sourceStartSec: seg.startSec,
      sourceEndSec: seg.endSec,
      trimRange: { startSec, endSec },
      usableIntervals,
      lockedVisualDurationSec,
      climaxSec: relClimaxSec,
      reason: seg.reason,
      safeCropInsets: safeCrop,
      watermarkZones: delogoZones,
      bumperTrimmedSec,
      safeCropApplied,
      delogoZoneCount: delogoZones.length,
      stampedContactSheetJpeg: jpegBase64,
      stampedTimestampsSec: timestampsSec,
      framesSampled: framesRendered,
      contactSheetBytes,
      inspectorModel,
      visualSummary: seg.visualSummary,
      sceneCutTimestampsSec: seg.sceneCutTimestampsSec ?? [],
      pacingBeats,
    });
  }

  return prepared;
}
