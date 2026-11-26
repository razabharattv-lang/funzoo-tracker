import type {
  AlignedWordTiming,
  OutputLanguage,
  ScriptBeat,
} from '../types/studio';

export interface CaptionChunk {
  words: string[];
  wordTimings?: AlignedWordTiming[];
  startSec: number;
  endSec: number;
  accentColor: string;
}

function splitTextToWordGroups(
  text: string,
  language: OutputLanguage
): string[][] {
  const cleaned = text
    .replace(/["“”\n\r]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (cleaned.length === 0) return [];
  const formatted =
    language === 'hi' ? cleaned : cleaned.map((w) => w.toUpperCase());

  const groups: string[][] = [];
  for (let i = 0; i < formatted.length; i += 3) {
    groups.push(formatted.slice(i, i + 3));
  }
  return groups;
}

/**
 * Builds kinetic CapCut-style caption chunks synced to offline-aligned word timings
 * (`AlignedWordTiming[]`) or chronological `ScriptBeat` timestamps.
 */
export function buildCaptionChunks(
  scriptText: string,
  totalDurationSec: number,
  language: OutputLanguage,
  beats?: ScriptBeat[],
  wordTimings?: AlignedWordTiming[]
): CaptionChunk[] {
  if (Array.isArray(wordTimings) && wordTimings.length > 0) {
    const chunks: CaptionChunk[] = [];
    for (let i = 0; i < wordTimings.length; i += 3) {
      const slice = wordTimings.slice(i, i + 3);
      if (slice.length === 0) continue;
      const startSec = slice[0].startSec;
      const endSec = slice[slice.length - 1].endSec;
      const idx = chunks.length;
      chunks.push({
        words: slice.map((w) => w.word),
        wordTimings: slice,
        startSec,
        endSec,
        accentColor: idx % 2 === 0 ? '#FFAB00' : '#00E5FF',
      });
    }
    if (chunks.length > 0) return chunks;
  }

  if (Array.isArray(beats) && beats.length > 0) {
    const chunks: CaptionChunk[] = [];
    let colorIdx = 0;

    for (const beat of beats) {
      const groups = splitTextToWordGroups(beat.text, language);
      if (groups.length === 0) continue;

      const bStart = Math.max(0, Math.min(totalDurationSec - 0.1, beat.startSec));
      const bEnd = Math.max(
        bStart + 0.25,
        Math.min(totalDurationSec, beat.endSec)
      );
      const step = (bEnd - bStart) / groups.length;

      for (let g = 0; g < groups.length; g++) {
        chunks.push({
          words: groups[g],
          startSec: bStart + g * step,
          endSec: Math.min(bEnd, bStart + (g + 1) * step),
          accentColor: colorIdx % 2 === 0 ? '#FFAB00' : '#00E5FF',
        });
        colorIdx++;
      }
    }

    if (chunks.length > 0) return chunks;
  }

  const groups = splitTextToWordGroups(scriptText, language);
  if (groups.length === 0) return [];

  const usableDur = Math.max(1, totalDurationSec - 0.35);
  const step = usableDur / groups.length;
  return groups.map((words, idx) => ({
    words,
    startSec: idx * step,
    endSec: Math.min((idx + 1) * step, totalDurationSec),
    accentColor: idx % 2 === 0 ? '#FFAB00' : '#00E5FF',
  }));
}

export function drawCapCutPopCaption(params: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  chunks: CaptionChunk[];
  timeSec: number;
  language: OutputLanguage;
  canvasWidth: number;
  canvasHeight: number;
}): void {
  const { ctx, chunks, timeSec, language, canvasWidth, canvasHeight } = params;
  const active =
    chunks.find((c) => timeSec >= c.startSec && timeSec < c.endSec) ??
    chunks.find((c) => timeSec >= c.startSec - 0.04 && timeSec <= c.endSec + 0.06);
  if (!active || active.words.length === 0) return;

  const scaleFactor = canvasWidth / 1080;
  const localT = Math.max(0, timeSec - active.startSec);
  const popScale =
    localT < 0.08
      ? 0.88 + (localT / 0.08) * 0.18
      : localT < 0.14
      ? 1.06 - ((localT - 0.08) / 0.06) * 0.06
      : 1.0;

  const fontSize = Math.round((language === 'hi' ? 62 : 68) * scaleFactor);
  const fontFamily =
    language === 'hi'
      ? '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif'
      : '"Plus Jakarta Sans", "Inter", system-ui, sans-serif';

  ctx.save();
  ctx.font = `900 ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(6, Math.round(14 * scaleFactor));
  ctx.strokeStyle = '#090E1A';

  const spacing = Math.round(20 * scaleFactor);
  const widths = active.words.map((w) => ctx.measureText(w).width);
  const totalW =
    widths.reduce((acc, w) => acc + w, 0) +
    spacing * Math.max(0, active.words.length - 1);

  // Safe vertical margin (74% height keeps captions well above Shorts/Reels bottom UI and right icons)
  const centerX = canvasWidth / 2;
  const centerY = Math.round(canvasHeight * 0.74);

  const safeHorizontalMargin = Math.round(136 * scaleFactor);
  const maxAllowedW = Math.max(120, canvasWidth - safeHorizontalMargin);
  const fitScale = totalW > maxAllowedW ? maxAllowedW / totalW : 1.0;
  const finalScale = popScale * fitScale;

  ctx.translate(centerX, centerY);
  ctx.scale(finalScale, finalScale);

  // Clean high-contrast translucent backing pill so text pops over bright/busy frames
  const padX = Math.round(26 * scaleFactor);
  const padY = Math.round(16 * scaleFactor);
  const boxW = totalW + padX * 2;
  const boxH = fontSize + padY * 2;
  const boxR = Math.round(20 * scaleFactor);
  ctx.fillStyle = 'rgba(9, 14, 26, 0.64)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, boxR);
  } else {
    ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
  }
  ctx.fill();

  // Highlight active word based on exact offline word timing if available
  let activeWordIdx = active.words.length - 1;
  if (active.wordTimings && active.wordTimings.length === active.words.length) {
    const foundIdx = active.wordTimings.findIndex(
      (wt) => timeSec >= wt.startSec - 0.03 && timeSec <= wt.endSec + 0.05
    );
    if (foundIdx !== -1) activeWordIdx = foundIdx;
  }

  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = Math.round(12 * scaleFactor);
  ctx.shadowOffsetY = Math.round(4 * scaleFactor);

  let cursorX = -totalW / 2;
  active.words.forEach((word, idx) => {
    const isHighlight = idx === activeWordIdx;
    ctx.strokeText(word, cursorX, 0);
    ctx.fillStyle = isHighlight ? active.accentColor : '#FFFFFF';
    ctx.fillText(word, cursorX, 0);
    cursorX += widths[idx] + spacing;
  });

  ctx.restore();
}
