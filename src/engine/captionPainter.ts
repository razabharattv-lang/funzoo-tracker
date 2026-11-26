import type { OutputLanguage } from '../types/studio';

export interface CaptionChunk {
  words: string[];
  startSec: number;
  endSec: number;
  accentColor: string;
}

export function buildCaptionChunks(
  scriptText: string,
  totalDurationSec: number,
  language: OutputLanguage
): CaptionChunk[] {
  const cleaned = scriptText
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

  const step = totalDurationSec / Math.max(groups.length, 1);
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
  const active = chunks.find((c) => timeSec >= c.startSec && timeSec < c.endSec);
  if (!active || active.words.length === 0) return;

  const scaleFactor = canvasWidth / 1080;
  const localT = timeSec - active.startSec;
  const popScale =
    localT < 0.08
      ? 0.85 + (localT / 0.08) * 0.22
      : localT < 0.14
      ? 1.07 - ((localT - 0.08) / 0.06) * 0.07
      : 1.0;

  const fontSize = Math.round((language === 'hi' ? 66 : 72) * scaleFactor);
  const fontFamily =
    language === 'hi'
      ? '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif'
      : '"Plus Jakarta Sans", "Inter", system-ui, sans-serif';

  ctx.save();
  ctx.font = `900 ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(6, Math.round(14 * scaleFactor));
  ctx.strokeStyle = '#0F172A';

  const spacing = Math.round(20 * scaleFactor);
  const widths = active.words.map((w) => ctx.measureText(w).width);
  const totalW =
    widths.reduce((acc, w) => acc + w, 0) +
    spacing * Math.max(0, active.words.length - 1);

  const centerX = canvasWidth / 2;
  const centerY = Math.round(canvasHeight * 0.82);

  const maxAllowedW = canvasWidth - Math.round(84 * scaleFactor);
  const fitScale = totalW > maxAllowedW ? maxAllowedW / totalW : 1.0;
  const finalScale = popScale * fitScale;

  ctx.translate(centerX, centerY);
  ctx.scale(finalScale, finalScale);

  let cursorX = -totalW / 2;
  active.words.forEach((word, idx) => {
    const isHighlight = idx === active.words.length - 1;
    ctx.strokeText(word, cursorX, 0);
    ctx.fillStyle = isHighlight ? active.accentColor : '#FFFFFF';
    ctx.fillText(word, cursorX, 0);
    cursorX += widths[idx] + spacing;
  });

  ctx.restore();
}
