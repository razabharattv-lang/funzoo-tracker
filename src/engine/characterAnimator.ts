export interface CharacterPopInSchedule {
  hookEndSec: number;
  climaxStartSec: number;
  climaxEndSec: number;
  outroStartSec: number;
  totalDurationSec: number;
}

export interface PortraitSource {
  source: CanvasImageSource;
  cropX: number;
  cropY: number;
  cropSize: number;
}

export function computeSquarePortraitCrop(
  width: number,
  height: number
): { cropX: number; cropY: number; cropSize: number } {
  const cropSize = Math.max(1, Math.min(width, height));
  const cropX = Math.floor((width - cropSize) / 2);
  const cropY = Math.max(0, Math.floor((height - cropSize) * 0.22));
  return { cropX, cropY, cropSize };
}

export function buildCharacterPopInSchedule(
  climaxSec: number,
  totalDurationSec: number
): CharacterPopInSchedule {
  const hookEndSec = Math.min(2.5, totalDurationSec * 0.4);
  const safeClimaxStart = Math.max(
    3.2,
    Math.min(climaxSec, Math.max(3.5, totalDurationSec - 3.6))
  );
  const safeClimaxEnd = Math.min(totalDurationSec - 2.1, safeClimaxStart + 1.5);
  const outroStartSec =
    totalDurationSec >= 7.0 && safeClimaxEnd > safeClimaxStart + 0.4
      ? Math.max(safeClimaxEnd + 0.35, totalDurationSec - 1.8)
      : Math.max(hookEndSec + 0.4, totalDurationSec - 1.8);

  return {
    hookEndSec,
    climaxStartSec: safeClimaxStart,
    climaxEndSec:
      totalDurationSec >= 7.0 && safeClimaxEnd > safeClimaxStart + 0.4
        ? safeClimaxEnd
        : -1,
    outroStartSec: outroStartSec < totalDurationSec - 0.3 ? outroStartSec : -1,
    totalDurationSec,
  };
}

export function isCharacterActiveAtTime(
  t: number,
  schedule: CharacterPopInSchedule
): { active: boolean; phase: 'hook' | 'climax' | 'outro' | null; localT: number } {
  // 1. Opening Hook (0.0s–2.5s)
  if (t >= 0 && t <= schedule.hookEndSec) {
    return { active: true, phase: 'hook', localT: t };
  }
  // 2. Mid-Video Climax (1.5s burst)
  if (
    schedule.climaxEndSec > 0 &&
    t >= schedule.climaxStartSec &&
    t <= schedule.climaxEndSec
  ) {
    return { active: true, phase: 'climax', localT: t - schedule.climaxStartSec };
  }
  // 3. Loop Outro (last 1.8s)
  if (
    schedule.outroStartSec > 0 &&
    t >= schedule.outroStartSec &&
    t <= schedule.totalDurationSec
  ) {
    return { active: true, phase: 'outro', localT: t - schedule.outroStartSec };
  }
  return { active: false, phase: null, localT: 0 };
}

export async function loadPortraitBitmap(
  portraitUrl: string
): Promise<ImageBitmap> {
  const resp = await fetch(portraitUrl);
  if (!resp.ok) {
    throw new Error('Could not fetch talking character portrait.');
  }
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Resolution-independent WebAudio-reactive Talking Character renderer.
 * Works on both OffscreenCanvas (inside WebWorker) and DOM Canvas (720x1280 or 1080x1920).
 * Appears ONLY during Opening Hook (0–2.5s), Mid-Video Climax (1.5s), and Loop Outro (last 1.8s).
 */
export function drawTalkingCharacterOverlay(params: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  portrait: PortraitSource;
  timeSec: number;
  schedule: CharacterPopInSchedule;
  amplitudeEnvelope: Float32Array;
  mouthOpenEnvelope: Float32Array;
  envelopeFps: number;
  canvasWidth: number;
  canvasHeight: number;
}): boolean {
  const {
    ctx,
    portrait,
    timeSec,
    schedule,
    amplitudeEnvelope,
    mouthOpenEnvelope,
    envelopeFps,
    canvasWidth,
    canvasHeight,
  } = params;

  const state = isCharacterActiveAtTime(timeSec, schedule);
  if (!state.active) return false;

  const scaleFactor = canvasWidth / 1080;
  const frameIdx = Math.min(
    amplitudeEnvelope.length - 1,
    Math.max(0, Math.floor(timeSec * envelopeFps))
  );
  const amp = amplitudeEnvelope[frameIdx] ?? 0;
  const mouthOpen = mouthOpenEnvelope[frameIdx] ?? amp;

  const popProgress = Math.min(1, state.localT / 0.16);
  const springScale =
    popProgress < 1
      ? 0.72 + 0.34 * Math.sin(popProgress * Math.PI * 0.65)
      : 1.0;

  const baseSize = (state.phase === 'hook' ? 430 : 380) * scaleFactor;
  const boxSize = Math.round(baseSize * springScale);
  const centerX = canvasWidth / 2;
  const centerY = Math.round(canvasHeight * 0.64);
  const boxX = Math.round(centerX - boxSize / 2);
  const boxY = Math.round(centerY - boxSize / 2);
  const radius = Math.round(30 * scaleFactor);

  const headZoom = 1.02 + amp * 0.045 + Math.sin(timeSec * 4.5) * 0.008;
  const tiltRad = ((amp * 2.2 * Math.sin(timeSec * 8.5)) * Math.PI) / 180;
  const bobY = -amp * 6 * scaleFactor;

  ctx.save();

  drawRoundedRectPath(ctx, boxX, boxY + bobY, boxSize, boxSize, radius);
  ctx.save();
  ctx.clip();

  ctx.translate(centerX, centerY + bobY);
  ctx.rotate(tiltRad);
  ctx.scale(headZoom, headZoom);

  ctx.drawImage(
    portrait.source,
    portrait.cropX,
    portrait.cropY,
    portrait.cropSize,
    portrait.cropSize,
    -boxSize / 2,
    -boxSize / 2,
    boxSize,
    boxSize
  );

  // Subtle phoneme-driven jaw/lower-face articulation
  if (mouthOpen > 0.12) {
    const jawSrcY = portrait.cropY + portrait.cropSize * 0.58;
    const jawSrcH = portrait.cropSize * 0.24;
    const jawDstY = -boxSize / 2 + boxSize * 0.58;
    const stretchH = boxSize * 0.24 * (1 + mouthOpen * 0.12);
    ctx.drawImage(
      portrait.source,
      portrait.cropX + portrait.cropSize * 0.22,
      jawSrcY,
      portrait.cropSize * 0.56,
      jawSrcH,
      -boxSize * 0.28,
      jawDstY,
      boxSize * 0.56,
      stretchH
    );
  }

  ctx.restore();

  // Flat Material active border (#FFAB00 amber speaking burst, #3D5AFE indigo resting)
  drawRoundedRectPath(ctx, boxX, boxY + bobY, boxSize, boxSize, radius);
  ctx.lineWidth = Math.max(4, Math.round(10 * scaleFactor));
  ctx.strokeStyle = amp > 0.3 ? '#FFAB00' : '#3D5AFE';
  ctx.stroke();

  // Speaking equalizer bars
  const barCount = 7;
  const barW = Math.max(4, Math.round(10 * scaleFactor));
  const barGap = Math.max(3, Math.round(8 * scaleFactor));
  const totalBarsW = barCount * barW + (barCount - 1) * barGap;
  const barsStartX = centerX - totalBarsW / 2;
  const barsBaseY = boxY + bobY + boxSize - Math.round(16 * scaleFactor);
  ctx.fillStyle = '#FFAB00';
  for (let b = 0; b < barCount; b++) {
    const waveMod = 0.45 + 0.55 * Math.abs(Math.sin(timeSec * 14 + b * 1.1));
    const h = Math.max(
      Math.round(7 * scaleFactor),
      Math.round((8 + amp * 34 * waveMod) * scaleFactor)
    );
    ctx.fillRect(barsStartX + b * (barW + barGap), barsBaseY - h, barW, h);
  }

  ctx.restore();
  return true;
}
