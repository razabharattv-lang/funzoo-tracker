import type {
  PreparedVisualClip,
  SafeCropInsets,
  SourceMediaItem,
  TrimRange,
  ViralSegment,
  WatermarkAction,
  WatermarkZone,
} from '../types/studio';
import {
  buildDefaultViralSegments,
  getUsableSourceDuration,
} from './streamResolver';
import { runStep1VisionJson } from './modelRouter';
import { analyzeVideoTimelineLocally } from './offlineModels';

export const MAX_SAFE_CROP_INSET = 0.14;
export const MAX_AUTO_EDGE_CROP = 0.12;

export const ZERO_CROP_INSETS: SafeCropInsets = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
};

export function clampInset(raw: unknown, maxCap = MAX_SAFE_CROP_INSET): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const frac = n > 1.0 && n <= 20 ? n / 100 : n;
  return Number(Math.max(0, Math.min(maxCap, frac)).toFixed(3));
}

export function sanitizeSafeCropInsets(
  raw: unknown,
  maxCap = MAX_SAFE_CROP_INSET
): SafeCropInsets {
  if (!raw || typeof raw !== 'object') return { ...ZERO_CROP_INSETS };
  const obj = raw as Record<string, unknown>;
  return {
    top: clampInset(obj.top, maxCap),
    bottom: clampInset(obj.bottom, maxCap),
    left: clampInset(obj.left, maxCap),
    right: clampInset(obj.right, maxCap),
  };
}

export function hasNonZeroInsets(insets: SafeCropInsets | undefined): boolean {
  if (!insets) return false;
  return (
    insets.top > 0.002 ||
    insets.bottom > 0.002 ||
    insets.left > 0.002 ||
    insets.right > 0.002
  );
}

function normalizeBox1000(
  rawBox: unknown
): [number, number, number, number] | null {
  if (!Array.isArray(rawBox) || rawBox.length !== 4) return null;
  const nums = rawBox.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const scale = Math.max(...nums) <= 1.5 ? 1000 : 1;
  const ymin = Math.max(0, Math.min(1000, Math.round(nums[0] * scale)));
  const xmin = Math.max(0, Math.min(1000, Math.round(nums[1] * scale)));
  const ymax = Math.max(0, Math.min(1000, Math.round(nums[2] * scale)));
  const xmax = Math.max(0, Math.min(1000, Math.round(nums[3] * scale)));
  if (ymax <= ymin + 5 || xmax <= xmin + 5) return null;
  return [ymin, xmin, ymax, xmax];
}

function isStrictlyPerimeterEdgeBox(
  box: [number, number, number, number]
): boolean {
  const [ymin, xmin, ymax, xmax] = box;
  const edgeLimit = Math.round(MAX_AUTO_EDGE_CROP * 1000); // 120 (12%)
  return (
    ymax <= edgeLimit ||
    ymin >= 1000 - edgeLimit ||
    xmax <= edgeLimit ||
    xmin >= 1000 - edgeLimit
  );
}

export function sanitizeWatermarkZones(
  rawZones: unknown,
  fallbackLegacyBoxes: unknown,
  totalDurationSec: number,
  windowStartSec: number,
  windowEndSec: number
): WatermarkZone[] {
  const zones: WatermarkZone[] = [];

  if (Array.isArray(rawZones)) {
    for (let i = 0; i < rawZones.length && zones.length < 16; i++) {
      const item = rawZones[i];
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;

      const rawAction = String(obj.action ?? '').trim();
      let action: WatermarkAction =
        rawAction === 'safe_edge_crop' ||
        rawAction === 'gpu_delogo_patch' ||
        rawAction === 'trim_bumper'
          ? rawAction
          : 'gpu_delogo_patch';

      const parsedBox = normalizeBox1000(obj.box);
      const box: [number, number, number, number] =
        parsedBox ??
        (action === 'trim_bumper' ? [0, 0, 1000, 1000] : [0, 0, 0, 0]);
      if (action !== 'trim_bumper' && !parsedBox) continue;

      if (action === 'safe_edge_crop' && !isStrictlyPerimeterEdgeBox(box)) {
        action = 'gpu_delogo_patch';
      }

      const rawStart = Number(obj.startSec ?? obj.start_sec ?? windowStartSec);
      const rawEnd = Number(obj.endSec ?? obj.end_sec ?? windowEndSec);
      const startSec = Number(
        Math.max(
          0,
          Math.min(
            totalDurationSec,
            Number.isFinite(rawStart) ? rawStart : windowStartSec
          )
        ).toFixed(2)
      );
      const endSec = Number(
        Math.max(
          startSec + 0.2,
          Math.min(
            totalDurationSec,
            Number.isFinite(rawEnd) ? rawEnd : windowEndSec
          )
        ).toFixed(2)
      );

      zones.push({
        id: String(obj.id || `wm_${zones.length + 1}`).slice(0, 40),
        startSec,
        endSec,
        box,
        action,
        label: String(obj.label || 'Detected Watermark').slice(0, 64),
      });
    }
  }

  if (zones.length === 0 && Array.isArray(fallbackLegacyBoxes)) {
    for (let i = 0; i < fallbackLegacyBoxes.length && zones.length < 8; i++) {
      const box = normalizeBox1000(fallbackLegacyBoxes[i]);
      if (!box) continue;
      zones.push({
        id: `wm_legacy_${i + 1}`,
        startSec: Number(windowStartSec.toFixed(2)),
        endSec: Number(windowEndSec.toFixed(2)),
        box,
        action: 'gpu_delogo_patch',
        label: 'Detected Overlay Watermark',
      });
    }
  }

  return zones;
}

export function finalizeCropAndTrimDecision(params: {
  rawSafeInsets: unknown;
  rawTrimRange: unknown;
  zones: WatermarkZone[];
  windowStartSec: number;
  windowEndSec: number;
  totalDurationSec: number;
  enforceSocialEndCard: boolean;
  platform: string;
}): {
  safeCropInsets: SafeCropInsets;
  trimRange: TrimRange;
  zones: WatermarkZone[];
} {
  const {
    rawSafeInsets,
    rawTrimRange,
    windowStartSec,
    windowEndSec,
    totalDurationSec,
    enforceSocialEndCard,
    platform,
  } = params;
  const zones = [...params.zones];

  let trimStart = windowStartSec;
  let trimEnd = windowEndSec;

  if (rawTrimRange && typeof rawTrimRange === 'object') {
    const tr = rawTrimRange as Record<string, unknown>;
    const rs = Number(tr.startSec ?? tr.start_sec);
    const re = Number(tr.endSec ?? tr.end_sec);
    if (Number.isFinite(rs) && rs >= windowStartSec && rs < windowEndSec - 3) {
      trimStart = rs;
    }
    if (Number.isFinite(re) && re <= windowEndSec && re > trimStart + 3) {
      trimEnd = re;
    }
  }

  const windowSpan = Math.max(1, windowEndSec - windowStartSec);
  for (const z of zones) {
    if (z.action !== 'trim_bumper') continue;
    if (
      z.startSec <= windowStartSec + 1.0 &&
      z.endSec > trimStart &&
      z.endSec <= windowStartSec + Math.min(8, windowSpan * 0.28)
    ) {
      trimStart = Math.max(trimStart, z.endSec);
    }
    if (
      z.endSec >= windowEndSec - 1.0 &&
      z.startSec < trimEnd &&
      z.startSec >= windowEndSec - Math.min(8, windowSpan * 0.28)
    ) {
      trimEnd = Math.min(trimEnd, z.startSec);
    }
  }

  if (
    enforceSocialEndCard &&
    windowEndSec >= totalDurationSec - 0.5 &&
    totalDurationSec > 6.5
  ) {
    const socialCutoff = Number(
      Math.max(trimStart + 3.5, totalDurationSec - 2.6).toFixed(2)
    );
    if (trimEnd > socialCutoff) {
      trimEnd = socialCutoff;
      const alreadyHasOutro = zones.some(
        (z) => z.action === 'trim_bumper' && z.endSec >= totalDurationSec - 1.0
      );
      if (!alreadyHasOutro) {
        zones.push({
          id: 'social_outro_bumper',
          startSec: socialCutoff,
          endSec: Number(totalDurationSec.toFixed(2)),
          box: [0, 0, 1000, 1000],
          action: 'trim_bumper',
          label: `${platform} Creator Outro Bumper`,
        });
      }
    }
  }

  if (trimEnd <= trimStart + 3) {
    trimStart = windowStartSec;
    trimEnd = windowEndSec;
  }

  const edgeCropZones = zones.filter((z) => z.action === 'safe_edge_crop');
  const parsedInsets = sanitizeSafeCropInsets(rawSafeInsets, MAX_SAFE_CROP_INSET);
  const safeCropInsets: SafeCropInsets = { ...ZERO_CROP_INSETS };

  if (edgeCropZones.length > 0) {
    safeCropInsets.top = parsedInsets.top;
    safeCropInsets.bottom = parsedInsets.bottom;
    safeCropInsets.left = parsedInsets.left;
    safeCropInsets.right = parsedInsets.right;

    for (const z of edgeCropZones) {
      const [ymin, xmin, ymax, xmax] = z.box;
      if (ymax <= MAX_AUTO_EDGE_CROP * 1000) {
        safeCropInsets.top = Math.max(
          safeCropInsets.top,
          clampInset(ymax / 1000 + 0.008, MAX_AUTO_EDGE_CROP)
        );
      } else if (ymin >= (1 - MAX_AUTO_EDGE_CROP) * 1000) {
        safeCropInsets.bottom = Math.max(
          safeCropInsets.bottom,
          clampInset((1000 - ymin) / 1000 + 0.008, MAX_AUTO_EDGE_CROP)
        );
      } else if (xmax <= MAX_AUTO_EDGE_CROP * 1000) {
        safeCropInsets.left = Math.max(
          safeCropInsets.left,
          clampInset(xmax / 1000 + 0.008, MAX_AUTO_EDGE_CROP)
        );
      } else if (xmin >= (1 - MAX_AUTO_EDGE_CROP) * 1000) {
        safeCropInsets.right = Math.max(
          safeCropInsets.right,
          clampInset((1000 - xmin) / 1000 + 0.008, MAX_AUTO_EDGE_CROP)
        );
      }
    }
  } else {
    const hasInnerDelogo = zones.some((z) => z.action === 'gpu_delogo_patch');
    if (!hasInnerDelogo) {
      safeCropInsets.top = Math.min(parsedInsets.top, MAX_AUTO_EDGE_CROP);
      safeCropInsets.bottom = Math.min(parsedInsets.bottom, MAX_AUTO_EDGE_CROP);
      safeCropInsets.left = Math.min(parsedInsets.left, MAX_AUTO_EDGE_CROP);
      safeCropInsets.right = Math.min(parsedInsets.right, MAX_AUTO_EDGE_CROP);
    }
  }

  return {
    safeCropInsets,
    trimRange: {
      startSec: Number(trimStart.toFixed(2)),
      endSec: Number(trimEnd.toFixed(2)),
    },
    zones,
  };
}

export function buildUsableIntervals(
  trimRange: TrimRange,
  watermarkZones: WatermarkZone[],
  sourceDurationSec: number
): {
  usableIntervals: TrimRange[];
  lockedVisualDurationSec: number;
  bumperTrimmedSec: number;
} {
  const baseStart = Math.max(0, Math.min(sourceDurationSec, trimRange.startSec));
  const baseEnd = Math.max(
    baseStart + 0.5,
    Math.min(sourceDurationSec, trimRange.endSec)
  );

  const bumpers = (watermarkZones || [])
    .filter((z) => z.action === 'trim_bumper' && z.endSec > z.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  let intervals: TrimRange[] = [{ startSec: baseStart, endSec: baseEnd }];
  for (const b of bumpers) {
    const next: TrimRange[] = [];
    for (const iv of intervals) {
      if (b.endSec <= iv.startSec || b.startSec >= iv.endSec) {
        next.push(iv);
      } else {
        if (b.startSec > iv.startSec + 0.15) {
          next.push({ startSec: iv.startSec, endSec: b.startSec });
        }
        if (b.endSec < iv.endSec - 0.15) {
          next.push({ startSec: b.endSec, endSec: iv.endSec });
        }
      }
    }
    intervals = next;
  }

  let totalSec = intervals.reduce(
    (sum, iv) => sum + Math.max(0, iv.endSec - iv.startSec),
    0
  );
  if (totalSec < 2.0) {
    intervals = [{ startSec: baseStart, endSec: baseEnd }];
    totalSec = Math.max(2.0, baseEnd - baseStart);
  }

  const rawBumperSum = bumpers.reduce(
    (sum, b) => sum + Math.max(0, b.endSec - b.startSec),
    0
  );

  return {
    usableIntervals: intervals,
    lockedVisualDurationSec: Number(Math.max(4.0, Math.min(62.0, totalSec)).toFixed(2)),
    bumperTrimmedSec: Number(rawBumperSum.toFixed(1)),
  };
}

export function mapClipTimeToSourceSec(
  clipOffsetSec: number,
  usableIntervals: TrimRange[],
  totalUsableSec: number
): number {
  const safeTotal = Math.max(0.5, totalUsableSec);
  let rem = Math.max(0, Math.min(safeTotal - 0.02, clipOffsetSec));
  for (const iv of usableIntervals) {
    const len = iv.endSec - iv.startSec;
    if (rem <= len) {
      return iv.startSec + rem;
    }
    rem -= len;
  }
  const last = usableIntervals[usableIntervals.length - 1];
  return last ? last.endSec - 0.05 : 0.05;
}

export function formatRelSecondStamp(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const mins = Math.floor(whole / 60);
  const rem = whole % 60;
  return `${mins.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}s`;
}

function formatClockStamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${rem
      .toString()
      .padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed encoding contact sheet.'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(',')[1] ?? '';
}

async function seekVideoOnce(
  video: HTMLVideoElement,
  seekSec: number
): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      video.onseeked = null;
      resolve();
    };
    const fallback = window.setTimeout(done, 1100);
    video.onseeked = () => {
      window.clearTimeout(fallback);
      done();
    };
    try {
      video.currentTime = seekSec;
    } catch {
      window.clearTimeout(fallback);
      resolve();
    }
  });
}

/**
 * Step 1 (Long Video > 65s):
 * Seeks across 18 proportional timestamps (4% to 96%) without buffering the whole
 * file in RAM, builds ONE 6x3 contact sheet (<= 768px wide), and makes strictly ONE
 * Vision call (Nemotron 3.5 VL / Cosmos 3 / OCR -> Gemini 3.8 Flash) to identify
 * top 3-5 viral windows + bumper/watermark decisions.
 */
async function scanLongVideo18FramesOnce(params: {
  source: SourceMediaItem;
  customAngle: string;
  geminiApiKey?: string;
  nvidiaApiKey: string;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<{ segments: ViralSegment[]; inspectorModel: string }> {
  const {
    source,
    customAngle,
    geminiApiKey = '',
    nvidiaApiKey,
    onStatus,
    signal,
  } = params;
  const totalDurationSec = Math.max(10, source.durationSec);
  const { usableDurationSec } = getUsableSourceDuration(source);
  const fallbackSegments = buildDefaultViralSegments(source);

  const sampleCount = 18;
  const cols = 6;
  const rows = 3;
  const pad = 3;
  const tileW = 124; // 6 * 124 + 7 * 3 = 765px <= 768px

  const timestampsSec: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const frac = 0.04 + (0.92 * i) / (sampleCount - 1);
    timestampsSec.push(
      Number(
        Math.min(
          Math.max(0.2, totalDurationSec * frac),
          totalDurationSec - 0.15
        ).toFixed(2)
      )
    );
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  let base64Jpeg = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Long video metadata load timed out.')),
        12_000
      );
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not decode long video for 18-frame scan.'));
      };
    });

    const srcW = video.videoWidth || source.width || 1280;
    const srcH = video.videoHeight || source.height || 720;
    const tileH = Math.max(
      82,
      Math.min(220, Math.round((tileW * srcH) / Math.max(srcW, 1)))
    );
    const sheetW = cols * tileW + (cols + 1) * pad;
    const sheetH = rows * tileH + (rows + 1) * pad;

    const useOffscreen =
      typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function';
    const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
      ? new OffscreenCanvas(sheetW, sheetH)
      : Object.assign(document.createElement('canvas'), {
          width: sheetW,
          height: sheetH,
        });
    const ctx = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('2D context unavailable for 18-frame scan.');

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, sheetW, sheetH);

    for (let i = 0; i < timestampsSec.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const seekSec = timestampsSec[i];
      if (i % 3 === 0 || i === timestampsSec.length - 1) {
        onStatus?.(
          `Stage 1A: Scanning full long timeline (frame ${i + 1}/${sampleCount} · ${formatClockStamp(
            seekSec
          )})...`
        );
      }
      await seekVideoOnce(video, seekSec);
      const r = Math.floor(i / cols);
      const c = i % cols;
      const dx = pad + c * (tileW + pad);
      const dy = pad + r * (tileH + pad);
      ctx.drawImage(video, 0, 0, srcW, srcH, dx, dy, tileW, tileH);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(dx + 2, dy + 2, 50, 15);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(formatClockStamp(seekSec), dx + 5, dy + 13);
    }

    if (canvas instanceof OffscreenCanvas) {
      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: 0.72,
      });
      base64Jpeg = await blobToBase64(blob);
    } else {
      base64Jpeg = canvas.toDataURL('image/jpeg', 0.72).split(',')[1] ?? '';
    }
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  onStatus?.(
    'Step 1: Pinpointing top 3–5 viral moments, OCR text & watermark zones...'
  );

  const prompt = `
You are an elite viral short-form video clipper and computer-vision inspector.
This single 6x3 contact sheet contains 18 chronological keyframes sampled proportionally from 4% to 96% of a ${totalDurationSec.toFixed(
    1
  )}-second long video (exact clock timestamp shown top-left of each tile).
${customAngle ? `Creator angle: "${customAngle}"` : ''}

Inspect both main subject framing AND every visible logo/watermark/creator handle/outro bumper across timestamps. Ignore our dark timestamp badge.
Classify each watermark strictly as:
- "trim_bumper": intro/outro creator logo bumper to cut completely.
- "safe_edge_crop": ONLY if logo is <= 12% from an outer edge AND cropping will NOT cut the main subject (compute safe_crop_insets 0.00..0.12).
- "gpu_delogo_patch": inner logo over active scene or moving handle (set safe_crop_insets to 0 on that side; provide box [ymin, xmin, ymax, xmax] 0-1000 + startSec/endSec).

Return ONLY valid JSON:
{
  "trim_range": { "startSec": 0, "endSec": ${usableDurationSec.toFixed(1)} },
  "safe_crop_insets": { "top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0 },
  "watermark_zones": [],
  "viral_segments": [
    {
      "start_sec": 35,
      "duration_sec": 30,
      "climax_sec": 15,
      "reason": "Opening shock reveal",
      "safe_crop_insets": { "top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0 },
      "watermark_zones": []
    }
  ]
}

Rules:
- Extract top 3 to 5 non-overlapping viral_segments using 30s, 40s, or 60s durations within 0 to ${totalDurationSec.toFixed(
    0
  )}s.
`.trim();

  const localScan = await analyzeVideoTimelineLocally({
    source,
    sampleCount: 12,
    signal,
  });

  let res: { parsed: Record<string, unknown>; modelUsed: string } | null = null;
  try {
    res = await runStep1VisionJson({
      geminiApiKey,
      nvidiaApiKey,
      systemPrompt:
        'You are an expert computer-vision video clipper and watermark inspector. Output strictly valid JSON.',
      userPrompt: prompt,
      imageBase64Jpeg: base64Jpeg,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    res = null;
  }

  if (!res) {
    const localSegments: ViralSegment[] =
      localScan.highActionWindows.length >= 2
        ? localScan.highActionWindows.map((win, idx) => ({
            clipIndex: idx + 1,
            startSec: win.startSec,
            endSec: win.endSec,
            climaxSec: win.climaxSec,
            reason: `Segment #${idx + 1} (${Math.round(
              win.endSec - win.startSec
            )}s)`,
            trimRange: { startSec: win.startSec, endSec: win.endSec },
            safeCropInsets: { ...localScan.suggestedSafeCropInsets },
            watermarkZones: localScan.detectedWatermarkZones.filter(
              (z) => z.endSec > win.startSec && z.startSec < win.endSec
            ),
          }))
        : fallbackSegments.map((seg) => ({
            ...seg,
            safeCropInsets: { ...localScan.suggestedSafeCropInsets },
            watermarkZones: localScan.detectedWatermarkZones.filter(
              (z) => z.endSec > seg.startSec && z.startSec < seg.endSec
            ),
          }));

    return {
      segments: localSegments,
      inspectorModel: 'Offline Embedded Scene & Logo Scanner',
    };
  }

  const { parsed, modelUsed } = res;
  const globalZones = sanitizeWatermarkZones(
    parsed.watermark_zones ?? parsed.watermarkZones,
    parsed.watermark_boxes,
    totalDurationSec,
    0,
    totalDurationSec
  );
  const globalDecision = finalizeCropAndTrimDecision({
    rawSafeInsets: parsed.safe_crop_insets ?? parsed.safeCropInsets,
    rawTrimRange: parsed.trim_range ?? parsed.trimRange,
    zones: globalZones,
    windowStartSec: 0,
    windowEndSec: totalDurationSec,
    totalDurationSec,
    enforceSocialEndCard: source.trimSocialEndCard,
    platform: source.platform,
  });

  const rawSegments = parsed.viral_segments;
  if (!Array.isArray(rawSegments)) {
    return {
      segments: fallbackSegments.map((seg) => ({
        ...seg,
        safeCropInsets: { ...globalDecision.safeCropInsets },
        watermarkZones: globalDecision.zones.filter(
          (z) => z.endSec > seg.startSec && z.startSec < seg.endSec
        ),
      })),
      inspectorModel: modelUsed,
    };
  }

  const cleaned: ViralSegment[] = [];
  const maxUsableEnd = globalDecision.trimRange.endSec;

  for (const item of rawSegments.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const startRaw = Number(obj.start_sec ?? obj.startSec);
    const lenRaw = Number(obj.duration_sec ?? obj.durationSec ?? 40);
    const endRaw = Number(obj.end_sec ?? obj.endSec);

    if (!Number.isFinite(startRaw)) continue;
    const targetLen = [30, 40, 60].includes(Math.round(lenRaw))
      ? Math.round(lenRaw)
      : Number.isFinite(endRaw) && endRaw > startRaw
      ? Math.max(20, Math.min(60, Math.round(endRaw - startRaw)))
      : 40;

    const startSec = Number(
      Math.max(
        globalDecision.trimRange.startSec,
        Math.min(maxUsableEnd - 18, startRaw)
      ).toFixed(2)
    );
    const endSec = Number(
      Math.min(maxUsableEnd, startSec + targetLen).toFixed(2)
    );
    if (endSec - startSec < 16) continue;

    const overlaps = cleaned.some(
      (existing) =>
        !(endSec <= existing.startSec + 1 || startSec >= existing.endSec - 1)
    );
    if (overlaps) continue;

    const segDur = endSec - startSec;
    const climaxRel = Number(obj.climax_sec ?? obj.climaxSec);
    const climaxSec =
      Number.isFinite(climaxRel) && climaxRel > 3 && climaxRel < segDur - 2
        ? climaxRel
        : Number((segDur * 0.52).toFixed(2));

    const segZones = sanitizeWatermarkZones(
      obj.watermark_zones ?? obj.watermarkZones,
      undefined,
      totalDurationSec,
      startSec,
      endSec
    );
    const overlappingGlobal = globalDecision.zones.filter(
      (z) => z.endSec > startSec && z.startSec < endSec
    );
    const mergedZones = segZones.length > 0 ? segZones : overlappingGlobal;

    const segDecision = finalizeCropAndTrimDecision({
      rawSafeInsets:
        obj.safe_crop_insets ?? obj.safeCropInsets ?? globalDecision.safeCropInsets,
      rawTrimRange: obj.trim_range ?? obj.trimRange,
      zones: mergedZones,
      windowStartSec: startSec,
      windowEndSec: endSec,
      totalDurationSec,
      enforceSocialEndCard: source.trimSocialEndCard,
      platform: source.platform,
    });

    cleaned.push({
      clipIndex: cleaned.length + 1,
      startSec: segDecision.trimRange.startSec,
      endSec: segDecision.trimRange.endSec,
      climaxSec,
      reason: String(
        obj.reason || `High-Tension Highlight (${Math.round(segDur)}s)`
      ).slice(0, 72),
      trimRange: segDecision.trimRange,
      safeCropInsets: segDecision.safeCropInsets,
      watermarkZones: segDecision.zones,
    });
  }

  if (cleaned.length < 2) {
    return {
      segments: fallbackSegments.map((seg) => ({
        ...seg,
        safeCropInsets: { ...globalDecision.safeCropInsets },
        watermarkZones: globalDecision.zones.filter(
          (z) => z.endSec > seg.startSec && z.startSec < seg.endSec
        ),
      })),
      inspectorModel: modelUsed,
    };
  }

  cleaned.sort((a, b) => a.startSec - b.startSec);
  return {
    segments: cleaned.map((seg, idx) => ({ ...seg, clipIndex: idx + 1 })),
    inspectorModel: modelUsed,
  };
}

/**
 * Stage 1B:
 * Extracts 6 evenly spaced frames from the locked visual clip timeline into a single
 * compact, cinema-graded (`contrast(1.22) saturate(1.36) brightness(1.03)`),
 * relative-second stamped 3x2 JPEG contact sheet (max 640px wide) for direct Gemini inspection.
 */
async function buildCleanedStampedContactSheet(params: {
  video: HTMLVideoElement;
  sourceWidth: number;
  sourceHeight: number;
  usableIntervals: TrimRange[];
  lockedVisualDurationSec: number;
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
  signal?: AbortSignal;
}): Promise<{ base64Jpeg: string; stampedTimestampsSec: number[] }> {
  const {
    video,
    sourceWidth,
    sourceHeight,
    usableIntervals,
    lockedVisualDurationSec,
    safeCropInsets,
    watermarkZones,
    signal,
  } = params;

  const sampleCount = 6; // 6 evenly spaced frames in a 3x2 grid (max 640px wide)
  const cols = 3;
  const rows = 2;
  const pad = 4;
  const tileW = 208; // 3 * 208 + 4 * 4 = 640px max width

  const cropLeft = Math.round(sourceWidth * safeCropInsets.left);
  const cropTop = Math.round(sourceHeight * safeCropInsets.top);
  const cropW = Math.max(
    64,
    Math.round(sourceWidth * (1 - safeCropInsets.left - safeCropInsets.right))
  );
  const cropH = Math.max(
    64,
    Math.round(sourceHeight * (1 - safeCropInsets.top - safeCropInsets.bottom))
  );

  const tileH = Math.max(
    120,
    Math.min(280, Math.round((tileW * cropH) / Math.max(cropW, 1)))
  );
  const sheetW = cols * tileW + (cols + 1) * pad;
  const sheetH = rows * tileH + (rows + 1) * pad;

  const useOffscreen =
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function';
  const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
    ? new OffscreenCanvas(sheetW, sheetH)
    : Object.assign(document.createElement('canvas'), {
        width: sheetW,
        height: sheetH,
      });
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D context unavailable for cleaned contact sheet.');

  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, sheetW, sheetH);

  const stampedTimestampsSec: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const frac = (i + 0.5) / sampleCount;
    const relSec = Number(
      Math.max(
        0.2,
        Math.min(lockedVisualDurationSec - 0.2, frac * lockedVisualDurationSec)
      ).toFixed(2)
    );
    stampedTimestampsSec.push(relSec);
  }

  const delogoZones = watermarkZones.filter(
    (z) => z.action === 'gpu_delogo_patch'
  );

  for (let i = 0; i < stampedTimestampsSec.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const relSec = stampedTimestampsSec[i];
    const sourceSeekSec = mapClipTimeToSourceSec(
      relSec,
      usableIntervals,
      lockedVisualDurationSec
    );

    await seekVideoOnce(video, sourceSeekSec);

    const r = Math.floor(i / cols);
    const c = i % cols;
    const dx = pad + c * (tileW + pad);
    const dy = pad + r * (tileH + pad);

    // Apply rich cinema grade matching Stage 3 WebGL2 shader
    ctx.save();
    ctx.filter = 'contrast(1.22) saturate(1.36) brightness(1.03)';
    ctx.drawImage(video, cropLeft, cropTop, cropW, cropH, dx, dy, tileW, tileH);
    ctx.restore();

    // Soft patch any already-known inner delogo boxes active at this second
    for (const z of delogoZones) {
      if (sourceSeekSec < z.startSec - 0.15 || sourceSeekSec > z.endSec + 0.15) {
        continue;
      }
      const [ymin, xmin, ymax, xmax] = z.box;
      const sx0 = (xmin / 1000) * sourceWidth - cropLeft;
      const sy0 = (ymin / 1000) * sourceHeight - cropTop;
      const sw = ((xmax - xmin) / 1000) * sourceWidth;
      const sh = ((ymax - ymin) / 1000) * sourceHeight;
      const bx = dx + Math.max(0, (sx0 / cropW) * tileW);
      const by = dy + Math.max(0, (sy0 / cropH) * tileH);
      const bw = Math.min(tileW, (sw / cropW) * tileW);
      const bh = Math.min(tileH, (sh / cropH) * tileH);
      if (bw > 4 && bh > 4) {
        ctx.save();
        ctx.filter = 'blur(8px)';
        ctx.drawImage(
          canvas,
          Math.max(dx, bx - 6),
          Math.max(dy, by - 6),
          Math.min(tileW, bw + 12),
          Math.min(tileH, bh + 12),
          bx,
          by,
          bw,
          bh
        );
        ctx.restore();
      }
    }

    // Crisp stamped relative second badge (00:01s, 00:04s, ...)
    const stamp = formatRelSecondStamp(relSec);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(dx + 4, dy + 4, 62, 18);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(stamp, dx + 8, dy + 17);
  }

  let base64Jpeg = '';
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.74,
    });
    base64Jpeg = await blobToBase64(blob);
  } else {
    base64Jpeg = canvas.toDataURL('image/jpeg', 0.74).split(',')[1] ?? '';
  }

  return { base64Jpeg, stampedTimestampsSec };
}

/**
 * STEP 1 — Fetch & Smart Inspector:
 * - Short (<= 65s): trims creator outro bumper (-2.6s) and locks peak action timeline (12s-45s).
 * - Long (> 65s): scans 18 proportional keyframes (4%-96%) via Step 1 Vision router to slice top 3-5 viral windows.
 */
export async function inspectAndSliceSegmentsStep1(params: {
  source: SourceMediaItem;
  customAngle: string;
  geminiApiKey?: string;
  nvidiaApiKey: string;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<{ segments: ViralSegment[]; inspectorModel: string }> {
  const {
    source,
    customAngle,
    geminiApiKey = '',
    nvidiaApiKey,
    onStatus,
    signal,
  } = params;

  if (source.mode === 'long') {
    return scanLongVideo18FramesOnce({
      source,
      customAngle,
      geminiApiKey,
      nvidiaApiKey,
      onStatus,
      signal,
    });
  }

  onStatus?.(
    'Step 1: Scanning timeline for scene cuts, logos & outer bumpers...'
  );
  const localScan = await analyzeVideoTimelineLocally({
    source,
    sampleCount: 8,
    signal,
  });

  const { usableDurationSec, endCardTrimmedSec } =
    getUsableSourceDuration(source);
  const clipLen =
    usableDurationSec <= 45
      ? usableDurationSec
      : Math.min(45, Math.max(12, usableDurationSec));
  const startSec =
    usableDurationSec > 45
      ? Number(((usableDurationSec - clipLen) * 0.25).toFixed(2))
      : 0;
  const endSec = Number(Math.min(usableDurationSec, startSec + clipLen).toFixed(2));
  const bumperZones: WatermarkZone[] =
    endCardTrimmedSec > 0
      ? [
          {
            id: 'social_outro_bumper',
            startSec: usableDurationSec,
            endSec: Number(source.durationSec.toFixed(2)),
            box: [0, 0, 1000, 1000],
            action: 'trim_bumper',
            label: `${source.platform} Creator Outro Bumper`,
          },
        ]
      : [];

  const mergedZones = [
    ...bumperZones,
    ...localScan.detectedWatermarkZones.filter(
      (z) => z.action !== 'trim_bumper'
    ),
  ];

  const cleanSourceLabel = (source.label || 'Uploaded Video')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .trim();

  return {
    inspectorModel: 'Local Scene, Bumper & Logo Scanner',
    segments: [
      {
        clipIndex: 1,
        startSec,
        endSec,
        climaxSec: Number(((endSec - startSec) * 0.52).toFixed(2)),
        reason: cleanSourceLabel || `Short Clip (${Math.round(endSec - startSec)}s)`,
        trimRange: { startSec, endSec },
        safeCropInsets: { ...localScan.suggestedSafeCropInsets },
        watermarkZones: mergedZones,
      },
    ],
  };
}

/**
 * STEP 2 — Anti-Copyright & Motion Grade:
 * Locks usable intervals, trims bumpers, prepares GPU delogo/safe-crop masks,
 * and builds the cinema-graded 9-frame relative-second stamped contact sheet
 * ready for Step 3 beat-synced script generation.
 */
export async function cleanAndGradeClipsStep2(params: {
  source: SourceMediaItem;
  segments: ViralSegment[];
  inspectorModel: string;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<PreparedVisualClip[]> {
  const { source, segments, inspectorModel, onStatus, signal } = params;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Source video load timed out in Step 2.')),
        12_000
      );
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not decode source video in Step 2.'));
      };
    });

    const srcW = video.videoWidth || source.width || 720;
    const srcH = video.videoHeight || source.height || 1280;
    const prepared: PreparedVisualClip[] = [];

    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const seg = segments[i];
      const { usableIntervals, lockedVisualDurationSec, bumperTrimmedSec } =
        buildUsableIntervals(
          seg.trimRange,
          seg.watermarkZones,
          source.durationSec
        );

      onStatus?.(
        segments.length > 1
          ? `Step 2: Applying anti-copyright cleanups & cinema grade to Clip ${i + 1}/${segments.length} (${lockedVisualDurationSec.toFixed(
              1
            )}s)...`
          : `Step 2: Locking clean visual timeline (${lockedVisualDurationSec.toFixed(
              1
            )}s) & cinema grade...`
      );

      const { base64Jpeg, stampedTimestampsSec } =
        await buildCleanedStampedContactSheet({
          video,
          sourceWidth: srcW,
          sourceHeight: srcH,
          usableIntervals,
          lockedVisualDurationSec,
          safeCropInsets: seg.safeCropInsets,
          watermarkZones: seg.watermarkZones,
          signal,
        });

      const delogoZoneCount = seg.watermarkZones.filter(
        (z) => z.action === 'gpu_delogo_patch'
      ).length;

      prepared.push({
        clipIndex: i + 1,
        totalClips: segments.length,
        sourceStartSec: seg.startSec,
        sourceEndSec: seg.endSec,
        trimRange: seg.trimRange,
        usableIntervals,
        lockedVisualDurationSec,
        climaxSec: Number(
          Math.min(
            lockedVisualDurationSec - 1.8,
            Math.max(2.6, seg.climaxSec)
          ).toFixed(2)
        ),
        reason: seg.reason,
        safeCropInsets: seg.safeCropInsets,
        watermarkZones: seg.watermarkZones,
        bumperTrimmedSec,
        safeCropApplied: hasNonZeroInsets(seg.safeCropInsets),
        delogoZoneCount,
        stampedContactSheetJpeg: base64Jpeg,
        stampedTimestampsSec,
        inspectorModel,
      });
    }

    return prepared;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
