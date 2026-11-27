import { analyzeVideoTimelineLocally } from './offlineModels';
import { PIPELINE_15_WORKER_MODELS } from './modelRouter';
import { buildDefaultViralSegments } from './streamResolver';
import type {
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
  const outroStart = Number(Math.max(0, dur - 0.8).toFixed(2));
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
      box: [0.68, 0.87, 1.0, 0.99],
      action: 'gpu_delogo_patch',
      label: 'Bottom-right creator badge patch',
    },
    {
      id: 'wm_outro_tail_badge',
      startSec: outroStart,
      endSec: dur,
      box: [0.0, 0.85, 0.36, 0.99],
      action: 'gpu_delogo_patch',
      label: 'Outro tail bottom-left badge patch',
    },
  ];

  // Keep detected bottom-corner zones while always guaranteeing clean corner & outro-tail delogo patches
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
    const timer = window.setTimeout(done, 2000);
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
      const deadline = Date.now() + 1000;
      const poll = window.setInterval(() => {
        if ((video.readyState >= 2 && video.videoWidth > 0) || Date.now() >= deadline) {
          window.clearInterval(poll);
          resolve();
        }
      }, 35);
    });
  }
}

async function buildStampedContactSheet(params: {
  source: SourceMediaItem;
  startSec: number;
  endSec: number;
  crop: SafeCropInsets;
}): Promise<{ jpegBase64: string; timestampsSec: number[] }> {
  const { source, startSec, endSec, crop } = params;
  const clipDur = Math.max(1, endSec - startSec);
  const cols = 3;
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
          22000
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
    // Match exact 9:16 edited vertical framing (3x3 = 9 frames) so Step 3 sees full scene progression
    const tileW = 216;
    const tileH = 384;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileW;
    canvas.height = rows * tileH;
    const ctx = canvas.getContext('2d');

    if (ctx) {
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
        coverSy = sy + Math.round((sh - coverSh) / 2);
      }

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
            ctx.filter = 'contrast(1.18) saturate(1.24) brightness(1.04)';
            ctx.drawImage(video, coverSx, coverSy, coverSw, coverSh, dx, dy, tileW, tileH);
            ctx.restore();
          } catch {
            // Keep solid dark tile if a single frame decode fails
          }
        }

        // Timestamp stamp for exact second-by-second action alignment in Step 3
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(dx + 8, dy + 8, 86, 24);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 13px "JetBrains Mono", monospace';
        ctx.fillText(`T=${localSec.toFixed(1)}s`, dx + 15, dy + 24);
      }
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    const jpegBase64 = dataUrl.split(',')[1] ?? '';
    return { jpegBase64, timestampsSec };
  } catch {
    return { jpegBase64: '', timestampsSec };
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
}): Promise<{ segments: ViralSegment[]; inspectorModel: string }> {
  const { source, onProgress } = params;
  onProgress?.('Scanning real source duration, scene cuts, and corner marks locally...');

  try {
    const scan = await analyzeVideoTimelineLocally(source, onProgress);
    const totalDur = Math.max(1, source.durationSec);
    // Trim final ~1.2s–1.5s outro/owner-badge tail on short/social clips while preserving full action body
    const outroTrim =
      totalDur >= 6
        ? scan.hasOutroBumper || source.trimSocialEndCard
          ? 1.5
          : totalDur <= 45
          ? 1.35
          : 1.25
        : totalDur >= 3.5
        ? Number(Math.min(1.0, totalDur * 0.18).toFixed(2))
        : 0;
    const usableEnd = Number(Math.max(2, totalDur - outroTrim).toFixed(2));
    const safeCrop = clampSafeCrop(scan.suggestedSafeCropInsets);

    const segments: ViralSegment[] = scan.highActionWindows.map((win, idx) => {
      const isShortSingleClip = totalDur <= 20 && scan.highActionWindows.length === 1;
      const rawStart = isShortSingleClip ? 0 : win.startSec;
      const rawEnd = isShortSingleClip ? usableEnd : win.endSec;
      const startSec = Number(clamp(rawStart, 0, usableEnd - 1.2).toFixed(2));
      const endSec = Number(clamp(rawEnd, startSec + 1.2, usableEnd).toFixed(2));
      const climaxSec = Number(clamp(win.climaxSec, startSec, endSec).toFixed(2));
      const clipZones = sanitizeWatermarkZones(
        scan.detectedWatermarkZones,
        startSec,
        endSec
      );

      return {
        clipIndex: idx + 1,
        startSec,
        endSec,
        climaxSec,
        reason:
          scan.highActionWindows.length === 1
            ? `Full edited clip (${(endSec - startSec).toFixed(1)}s, outro trimmed ${outroTrim.toFixed(1)}s) with peak action at ${climaxSec.toFixed(1)}s`
            : `High-retention clip ${idx + 1} (${(endSec - startSec).toFixed(1)}s) centered on peak action at ${climaxSec.toFixed(1)}s`,
        trimRange: { startSec, endSec },
        safeCropInsets: safeCrop,
        watermarkZones: clipZones,
        visualSummary: scan.visualSummary,
      };
    });

    if (segments.length > 0) {
      return {
        segments,
        inspectorModel: `Browser Canvas Fallback (${PIPELINE_15_WORKER_MODELS.step1[0]} / ${PIPELINE_15_WORKER_MODELS.step1[2]} role)`,
      };
    }
  } catch {
    // Fall back to clean multi-clip (>45s) or tight outro-trimmed single clip (<=45s)
  }

  const totalDur = Math.max(1, source.durationSec);
  const fallbackOutroTrim = totalDur >= 6 ? 1.35 : 0;
  const fallbackUsableEnd = Number(Math.max(2, totalDur - fallbackOutroTrim).toFixed(2));

  if (totalDur > 45) {
    const clipCount = totalDur <= 135 ? 2 : 3;
    const span = fallbackUsableEnd / clipCount;
    const targetLen =
      totalDur <= 135
        ? Math.min(65, Math.max(22, span * 0.9))
        : Math.min(120, Math.max(45, span * 0.85));
    const safeCrop = clampSafeCrop({ top: 0, bottom: 0, left: 0, right: 0 });
    return {
      segments: Array.from({ length: clipCount }, (_, i) => {
        const startSec = Number((i * span).toFixed(2));
        const endSec = Number(Math.min(fallbackUsableEnd, startSec + targetLen).toFixed(2));
        return {
          clipIndex: i + 1,
          startSec,
          endSec,
          climaxSec: Number((startSec + (endSec - startSec) * 0.45).toFixed(2)),
          reason: `High-retention story segment ${i + 1} of ${clipCount} (${(endSec - startSec).toFixed(1)}s)`,
          trimRange: { startSec, endSec },
          safeCropInsets: safeCrop,
          watermarkZones: [],
        };
      }),
      inspectorModel: `Direct Slicer (${PIPELINE_15_WORKER_MODELS.step1[1]} role)`,
    };
  }

  const defaultSegs = buildDefaultViralSegments(source).map((seg) => {
    const endSec = Number(Math.min(seg.endSec, fallbackUsableEnd).toFixed(2));
    return {
      ...seg,
      endSec,
      climaxSec: Number(Math.min(seg.climaxSec, endSec * 0.55).toFixed(2)),
      trimRange: { startSec: seg.startSec, endSec },
    };
  });

  return {
    segments: defaultSegs,
    inspectorModel: `Direct Slicer (${PIPELINE_15_WORKER_MODELS.step1[1]} role)`,
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

    const { jpegBase64, timestampsSec } = await buildStampedContactSheet({
      source,
      startSec,
      endSec,
      crop: safeCrop,
    });

    prepared.push({
      clipIndex: seg.clipIndex,
      totalClips: segments.length,
      sourceStartSec: seg.startSec,
      sourceEndSec: seg.endSec,
      trimRange: { startSec, endSec },
      usableIntervals,
      lockedVisualDurationSec,
      climaxSec: Number(clamp(seg.climaxSec - startSec, 0, lockedVisualDurationSec).toFixed(2)),
      reason: seg.reason,
      safeCropInsets: safeCrop,
      watermarkZones: delogoZones,
      bumperTrimmedSec,
      safeCropApplied,
      delogoZoneCount: delogoZones.length,
      stampedContactSheetJpeg: jpegBase64,
      stampedTimestampsSec: timestampsSec,
      inspectorModel,
      visualSummary: seg.visualSummary,
    });
  }

  return prepared;
}
