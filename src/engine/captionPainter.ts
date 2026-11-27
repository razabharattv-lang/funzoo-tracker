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
  let i = 0;
  while (i < formatted.length) {
    const w1 = formatted[i];
    const w2 = formatted[i + 1];
    const w3 = formatted[i + 2];
    // Punchy 2-word viral bursts (or 3 only when all words are very short) for big mobile impact
    if (w2 && w3 && w1.length + w2.length + w3.length <= 13) {
      groups.push([w1, w2, w3]);
      i += 3;
    } else if (w2 && w1.length + w2.length <= 16) {
      groups.push([w1, w2]);
      i += 2;
    } else {
      groups.push([w1]);
      i += 1;
    }
  }
  return groups;
}

function normalizeNonOverlappingChunks(
  chunks: CaptionChunk[],
  totalDurationSec: number
): CaptionChunk[] {
  const maxDur = Math.max(0.5, totalDurationSec);
  const valid = chunks
    .filter((c) => c.words.length > 0 && Number.isFinite(c.startSec) && Number.isFinite(c.endSec))
    .sort((a, b) => a.startSec - b.startSec);

  const normalized: CaptionChunk[] = [];
  for (let i = 0; i < valid.length; i++) {
    const prevEnd = normalized.length > 0 ? normalized[normalized.length - 1].endSec : 0;
    const startSec = Math.max(prevEnd, Math.min(maxDur - 0.08, valid[i].startSec));
    const nextRawStart = i + 1 < valid.length ? valid[i + 1].startSec : maxDur;
    const rawEnd = Math.max(startSec + 0.08, Math.min(maxDur, valid[i].endSec));
    const endSec =
      i + 1 < valid.length
        ? Math.max(startSec + 0.06, Math.min(rawEnd, Math.max(startSec + 0.06, nextRawStart - 0.01)))
        : Math.min(maxDur, rawEnd);

    normalized.push({
      ...valid[i],
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
    });
  }
  return normalized;
}

/**
 * Builds kinetic viral creator caption chunks synced to offline-aligned word timings
 * (`AlignedWordTiming[]`) or chronological `ScriptBeat` timestamps with strictly
 * non-overlapping intervals so only ONE caption block can ever render per frame.
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
    let i = 0;
    while (i < wordTimings.length) {
      const w1 = wordTimings[i];
      const w2 = wordTimings[i + 1];
      const w3 = wordTimings[i + 2];
      let take = 1;
      if (w2 && w3 && w1.word.length + w2.word.length + w3.word.length <= 13) {
        take = 3;
      } else if (w2 && w1.word.length + w2.word.length <= 16) {
        take = 2;
      }
      const slice = wordTimings.slice(i, i + take);
      i += take;
      if (slice.length === 0) continue;
      const startSec = slice[0].startSec;
      const endSec = slice[slice.length - 1].endSec;
      const idx = chunks.length;
      chunks.push({
        words: slice.map((w) => (language === 'hi' ? w.word : w.word.toUpperCase())),
        wordTimings: slice,
        startSec,
        endSec,
        accentColor: idx % 2 === 0 ? '#FFE600' : '#00F0FF',
      });
    }
    if (chunks.length > 0) return normalizeNonOverlappingChunks(chunks, totalDurationSec);
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
          accentColor: colorIdx % 2 === 0 ? '#FFE600' : '#00F0FF',
        });
        colorIdx++;
      }
    }

    if (chunks.length > 0) return normalizeNonOverlappingChunks(chunks, totalDurationSec);
  }

  const groups = splitTextToWordGroups(scriptText, language);
  if (groups.length === 0) return [];

  const usableDur = Math.max(1, totalDurationSec - 0.35);
  const step = usableDur / groups.length;
  return normalizeNonOverlappingChunks(
    groups.map((words, idx) => ({
      words,
      startSec: idx * step,
      endSec: Math.min((idx + 1) * step, totalDurationSec),
      accentColor: idx % 2 === 0 ? '#FFE600' : '#00F0FF',
    })),
    totalDurationSec
  );
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
  // Strictly ONE active caption block per frame (no loose overlap window between adjacent chunks)
  let active: CaptionChunk | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const isLast = i === chunks.length - 1;
    if (timeSec >= c.startSec && (isLast ? timeSec <= c.endSec : timeSec < c.endSec)) {
      active = c;
      break;
    }
  }
  if (!active || active.words.length === 0) return;

  const scaleFactor = canvasWidth / 1080;
  const localT = Math.max(0, timeSec - active.startSec);
  const popScale =
    localT < 0.07
      ? 0.86 + (localT / 0.07) * 0.22
      : localT < 0.14
      ? 1.08 - ((localT - 0.07) / 0.07) * 0.08
      : 1.0;

  const fontSize = Math.round((language === 'hi' ? 68 : 76) * scaleFactor);
  const fontFamily =
    language === 'hi'
      ? '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif'
      : '"Plus Jakarta Sans", "Inter", system-ui, sans-serif';

  ctx.save();
  ctx.font = `900 ${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(7, Math.round(16 * scaleFactor));
  ctx.strokeStyle = '#050814';

  const spacing = Math.round(28 * scaleFactor);
  const widths = active.words.map((w) => ctx.measureText(w).width);
  const totalW =
    widths.reduce((acc, w) => acc + w, 0) +
    spacing * Math.max(0, active.words.length - 1);

  // Clean lower-safe anchor (78% height): clears main subject AND bottom video player controls
  const centerX = canvasWidth / 2;
  const centerY = Math.round(canvasHeight * 0.78);

  const safeHorizontalMargin = Math.round(128 * scaleFactor);
  const maxAllowedW = Math.max(120, canvasWidth - safeHorizontalMargin);
  const fitScale = totalW > maxAllowedW ? maxAllowedW / totalW : 1.0;
  const finalScale = popScale * fitScale;

  ctx.translate(centerX, centerY);
  ctx.scale(finalScale, finalScale);

  // Sleek dark high-contrast backing pill with subtle crisp rim so captions pop over bright/moving frames
  const padX = Math.round(30 * scaleFactor);
  const padY = Math.round(18 * scaleFactor);
  const boxW = totalW + padX * 2;
  const boxH = fontSize + padY * 2;
  const boxR = Math.round(22 * scaleFactor);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = Math.round(18 * scaleFactor);
  ctx.shadowOffsetY = Math.round(6 * scaleFactor);
  ctx.fillStyle = 'rgba(6, 10, 22, 0.76)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, boxR);
  } else {
    ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
  }
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = Math.max(1.5, Math.round(2.5 * scaleFactor));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, boxR);
  } else {
    ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
  }
  ctx.stroke();
  ctx.restore();

  // Determine currently spoken word for viral pop emphasis (strictly single active word)
  let activeWordIdx = active.words.length - 1;
  if (active.wordTimings && active.wordTimings.length === active.words.length) {
    const foundIdx = active.wordTimings.findIndex(
      (wt, idx) =>
        timeSec >= wt.startSec &&
        (idx === active.wordTimings!.length - 1 ? timeSec <= wt.endSec : timeSec < wt.endSec)
    );
    if (foundIdx !== -1) activeWordIdx = foundIdx;
  } else if (active.words.length > 1) {
    const frac = Math.max(
      0,
      Math.min(0.999, (timeSec - active.startSec) / Math.max(0.1, active.endSec - active.startSec))
    );
    activeWordIdx = Math.floor(frac * active.words.length);
  }

  let cursorX = -totalW / 2;
  active.words.forEach((word, idx) => {
    const isHighlight = idx === activeWordIdx;
    const wordW = widths[idx];
    const wordCenterX = cursorX + wordW / 2;

    ctx.save();
    ctx.translate(wordCenterX, 0);
    if (isHighlight) {
      ctx.scale(1.05, 1.05);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = Math.round(14 * scaleFactor);
      ctx.shadowOffsetY = Math.round(5 * scaleFactor);
    } else {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
      ctx.shadowBlur = Math.round(10 * scaleFactor);
      ctx.shadowOffsetY = Math.round(4 * scaleFactor);
    }
    ctx.lineWidth = Math.max(7, Math.round(16 * scaleFactor));
    ctx.strokeStyle = '#050814';
    ctx.strokeText(word, -wordW / 2, 0);
    ctx.fillStyle = isHighlight ? active.accentColor : '#FFFFFF';
    ctx.fillText(word, -wordW / 2, 0);
    ctx.restore();

    cursorX += wordW + spacing;
  });

  ctx.restore();
}
