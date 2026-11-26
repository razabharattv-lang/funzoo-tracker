import type {
  DocumentaryChapter,
  DocumentaryInputKind,
  DocumentaryOutline,
  DocumentaryStyle,
  MotionShaderPreset,
  OutputLanguage,
  StudioConfig,
} from '../types/studio';
import { enforceStrictWordBudgetAndBeats } from './intelligenceEngine';
import {
  requestExternalGpuVisual,
  runStep1PlannerJson,
} from './modelRouter';
import { generateOfflineDocumentaryOutline } from './offlineModels';
import { formatRelSecondStamp } from './visualClipper';

const STYLE_ACCENTS: Record<DocumentaryStyle, string[]> = {
  documentary: ['#FFAB00', '#3D5AFE', '#00BFA5', '#FF1744'],
  motion_graphics: ['#00E5FF', '#FF1744', '#FFAB00', '#00C853'],
  '3d_blender': ['#3D5AFE', '#00BFA5', '#FFAB00', '#FF1744'],
};

function defaultShaderForStyle(
  style: DocumentaryStyle,
  idx: number
): MotionShaderPreset {
  if (style === '3d_blender') {
    return idx % 2 === 0 ? 'blender_3d_extrude' : 'orbital_nebula';
  }
  if (style === 'motion_graphics') {
    return idx % 2 === 0 ? 'neon_motion_hud' : 'cinema_grid';
  }
  return idx % 2 === 0 ? 'cinema_grid' : 'orbital_nebula';
}

function splitScriptIntoDeterministicChapters(params: {
  rawInput: string;
  inputKind: DocumentaryInputKind;
  style: DocumentaryStyle;
  language: OutputLanguage;
}): {
  title: string;
  chapters: {
    title: string;
    rawNarration: string;
    visualPrompt: string;
    captionCallout: string;
    targetDurationSec: number;
  }[];
} {
  const { rawInput, inputKind, style, language } = params;
  const cleaned = rawInput.trim();

  if (inputKind === 'script' && cleaned.length > 0) {
    const blocks = cleaned
      .split(/\n\s*\n+/)
      .map((b) => b.trim())
      .filter(Boolean);

    const paragraphs =
      blocks.length >= 2
        ? blocks
        : cleaned
            .split(/(?<=[.!?।])\s+/)
            .reduce<string[]>((acc, sent, idx) => {
              const bucket = Math.floor(idx / 3);
              acc[bucket] = acc[bucket] ? `${acc[bucket]} ${sent}` : sent;
              return acc;
            }, []);

    const sliced = paragraphs.slice(0, 5).map((text, idx) => {
      const words = text.split(/\s+/).filter(Boolean).length;
      const rate = language === 'hi' ? 1.85 : 2.05;
      const targetDurationSec = Number(
        Math.max(12, Math.min(45, words / rate + 1.2)).toFixed(1)
      );
      return {
        title: `Chapter ${idx + 1}`,
        rawNarration: text,
        visualPrompt: `Cinematic ${style.replace('_', ' ')} scene illustrating: ${text.slice(
          0,
          140
        )}`,
        captionCallout: text.split(/\s+/).slice(0, 5).join(' ').toUpperCase(),
        targetDurationSec,
      };
    });

    return {
      title: sliced[0]?.captionCallout || 'Script Production',
      chapters: sliced,
    };
  }

  const topic = cleaned || 'Why Modern Megastructures Never Collapse';
  const templates =
    language === 'hi'
      ? [
          {
            title: 'हुक और रहस्य',
            rawNarration: `रुकिए—${topic} के पीछे एक ऐसा सच छिपा है जिसे बहुत कम लोग जानते हैं। पहली नज़र में यह सामान्य लगता है, लेकिन इसके अंदर की इंजीनियरिंग सबको चौंका देती है।`,
            captionCallout: 'असली रहस्य',
            targetDurationSec: 18,
          },
          {
            title: 'मुख्य विज्ञान और मोड़',
            rawNarration: `जब दबाव अपने चरम पर पहुँचता है, तब ${topic} की असली ताकत सामने आती है। यही वह पल है जहाँ सारा समीकरण पलट जाता है।`,
            captionCallout: 'मुख्य मोड़',
            targetDurationSec: 20,
          },
          {
            title: 'अंतिम खुलासा',
            rawNarration: `और यही वजह है कि ${topic} पूरी दुनिया में मिसाल बन गया है। अब आप इस पूरी कहानी को नए नज़रिए से देख पाएँगे।`,
            captionCallout: 'पूरा सच',
            targetDurationSec: 16,
          },
        ]
      : [
          {
            title: 'The Opening Hook',
            rawNarration: `Stop scrolling—most people completely miss the real engineering behind ${topic}. On the surface it looks effortless, yet one hidden force drives the entire system.`,
            captionCallout: 'THE HIDDEN FORCE',
            targetDurationSec: 18,
          },
          {
            title: 'Inside the Mechanism',
            rawNarration: `Watch what happens the moment pressure peaks inside ${topic}. Every layer shifts in exact sequence so the whole structure locks into place without failing.`,
            captionCallout: 'CRITICAL SHIFT',
            targetDurationSec: 20,
          },
          {
            title: 'The Final Payoff',
            rawNarration: `That single design choice explains why ${topic} changed everything. Once you notice it, you will spot the pattern everywhere.`,
            captionCallout: 'FINAL REVEAL',
            targetDurationSec: 16,
          },
        ];

  return {
    title: topic.slice(0, 72),
    chapters: templates.map((t) => ({
      ...t,
      visualPrompt: `High-contrast ${style.replace(
        '_',
        ' '
      )} visualization of ${topic}: ${t.title}`,
    })),
  };
}

/**
 * Step 1 (Documentary / Motion Graphics / 3D-Blender Mode):
 * Splits user script OR expands topic/idea into structured multi-chapter production plan
 * using nemotron-3-ultra-550b-a55b / Step 5 Preview / kimi-k3.1-pro / nemotron-3.5-parse -> gemini-3.8-flash.
 */
export async function planDocumentaryOutlineStep1(params: {
  rawInput: string;
  inputKind: DocumentaryInputKind;
  style: DocumentaryStyle;
  language: OutputLanguage;
  customAngle: string;
  config: StudioConfig;
  signal?: AbortSignal;
}): Promise<DocumentaryOutline> {
  const {
    rawInput,
    inputKind,
    style,
    language,
    customAngle,
    config,
    signal,
  } = params;

  const trimmed = rawInput.trim();
  const fallback = splitScriptIntoDeterministicChapters({
    rawInput: trimmed,
    inputKind,
    style,
    language,
  });

  const styleDesc =
    style === '3d_blender'
      ? '3D-Blender isometric procedural studio lighting & sculpted geometry'
      : style === 'motion_graphics'
      ? 'high-contrast vector motion-graphics HUD explainer'
      : 'cinematic investigative documentary visual storytelling';

  const langDesc =
    language === 'hi'
      ? 'conversational punchy Hindi (Devanagari script)'
      : 'commanding American English storytelling';

  const systemPrompt =
    'You are an executive documentary & 3D motion-graphics showrunner. Break inputs into tight chronological chapters synced to strict spoken word limits (~2.0 words/sec). Output strictly valid JSON.';

  const userPrompt = `
INPUT MODE: ${inputKind === 'script' ? 'USER FULL SCRIPT (split cleanly into chapters preserving intent)' : 'TOPIC / IDEA (architect a gripping 3-chapter mini-series)'}
VISUAL STYLE: ${styleDesc}
LANGUAGE: ${langDesc}
${customAngle ? `SUSPENSE HOOK / ANGLE: "${customAngle}"` : ''}

INPUT CONTENT:
"""
${trimmed.slice(0, 4500)}
"""

Return ONLY valid JSON:
{
  "title": "Concise compelling series title",
  "chapters": [
    {
      "title": "Chapter 1: Short Title",
      "targetDurationSec": 18,
      "visualPrompt": "Concrete scene art-direction prompt for FLUX/TRELLIS/3D shader",
      "captionCallout": "3-WORD VISUAL HEADLINE",
      "narration": "Crisp spoken script for this chapter (max ~2.0 words per second so it finishes 0.5s early).",
      "searchQueries": ["US YouTube Shorts trend query 1", "US query 2"]
    }
  ]
}
(Produce 2 to 4 balanced chapters, each 14s to 35s long.)
`.trim();

  let planned: { parsed: Record<string, unknown>; modelUsed: string } | null =
    null;
  try {
    planned = await runStep1PlannerJson({
      nvidiaApiKey: config.nvidiaApiKey,
      systemPrompt,
      userPrompt,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return generateOfflineDocumentaryOutline({
      rawInput: trimmed,
      inputKind,
      style,
      language,
      customAngle,
    });
  }

  const rawChapters = Array.isArray(planned?.parsed?.chapters)
    ? (planned!.parsed.chapters as Record<string, unknown>[])
    : [];

  const sourceList =
    rawChapters.length > 0
      ? rawChapters.slice(0, 4).map((ch, idx) => {
          const targetDur = Math.max(
            12,
            Math.min(40, Number(ch.targetDurationSec ?? 18) || 18)
          );
          return {
            title: String(ch.title || `Chapter ${idx + 1}`).trim(),
            rawNarration: String(
              ch.narration || fallback.chapters[idx]?.rawNarration || ''
            ).trim(),
            visualPrompt: String(
              ch.visualPrompt ||
                fallback.chapters[idx]?.visualPrompt ||
                trimmed
            ).trim(),
            captionCallout: String(
              ch.captionCallout || `SCENE ${idx + 1}`
            )
              .trim()
              .slice(0, 42),
            targetDurationSec: Number(targetDur.toFixed(1)),
            searchQueries: Array.isArray(ch.searchQueries)
              ? (ch.searchQueries as string[]).filter(Boolean).slice(0, 3)
              : [trimmed.slice(0, 40) || 'documentary shorts'],
          };
        })
      : fallback.chapters.map((c) => ({
          ...c,
          searchQueries: [fallback.title, 'explainer documentary'],
        }));

  const accents = STYLE_ACCENTS[style];
  const chapters: DocumentaryChapter[] = sourceList.map((ch, idx) => {
    const enforced = enforceStrictWordBudgetAndBeats({
      rawBeats: [],
      fallbackVoiceover: ch.rawNarration,
      lockedVisualDurationSec: ch.targetDurationSec,
      language,
    });
    return {
      chapterIndex: idx + 1,
      totalChapters: sourceList.length,
      title: ch.title,
      style,
      targetDurationSec: ch.targetDurationSec,
      climaxSec: Number((ch.targetDurationSec * 0.54).toFixed(2)),
      visualPrompt: ch.visualPrompt,
      captionCallout: ch.captionCallout,
      shaderPreset: defaultShaderForStyle(style, idx),
      accentHex: accents[idx % accents.length],
      rawNarration: enforced.voiceover,
      beats: enforced.beats,
      searchQueries: ch.searchQueries,
      stampedTimestampsSec: [
        1,
        Math.round(ch.targetDurationSec * 0.5),
        Math.max(2, Math.round(ch.targetDurationSec - 1)),
      ],
      visualEngineLabel: 'Browser WebGL2 3D/Motion Shader',
    };
  });

  const totalDurationSec = Number(
    chapters.reduce((sum, c) => sum + c.targetDurationSec, 0).toFixed(1)
  );

  return {
    id: `doc_${Date.now()}`,
    topicOrTitle: String(planned?.parsed?.title || fallback.title).trim(),
    style,
    inputKind,
    chapters,
    totalDurationSec,
    plannerModel: planned?.modelUsed || 'Deterministic Chapter Planner',
  };
}

function drawProceduralScenePreviewTile(params: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  dx: number;
  dy: number;
  w: number;
  h: number;
  chapter: DocumentaryChapter;
  timeSec: number;
  bgImage?: CanvasImageSource | null;
}): void {
  const { ctx, dx, dy, w, h, chapter, timeSec, bgImage } = params;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, w, h);
  ctx.clip();

  if (bgImage) {
    ctx.drawImage(bgImage, dx, dy, w, h);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
    ctx.fillRect(dx, dy, w, h);
  } else {
    ctx.fillStyle =
      chapter.style === '3d_blender'
        ? '#0B1120'
        : chapter.style === 'motion_graphics'
        ? '#090D16'
        : '#111827';
    ctx.fillRect(dx, dy, w, h);

    // Subtle geometric motion/3D motif for Vision inspection
    ctx.strokeStyle = chapter.accentHex;
    ctx.lineWidth = 1.5;
    const cx = dx + w / 2;
    const cy = dy + h * 0.45;
    const r = Math.min(w, h) * (0.22 + 0.04 * Math.sin(timeSec));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = chapter.accentHex;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(dx + w * 0.14, dy + h * 0.25, w * 0.72, h * 0.36);
    ctx.globalAlpha = 1;
  }

  // Callout label inside frame
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '800 10px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(chapter.captionCallout.slice(0, 22), dx + w / 2, dy + h * 0.56);
  ctx.restore();
}

/**
 * Step 2 (Documentary / Motion Graphics / 3D-Blender Mode):
 * Optionally calls external GPU endpoint (flux-3-image-klein, FLUX.1-schnell, TRELLIS, Relighting),
 * otherwise prepares Browser WebGL2 3D/Motion shader visuals, and stamps a 9-frame contact sheet
 * (`00:01s`..`00:{dur}s`) so Step 3 scripts sync tightly to the scene visuals.
 */
export async function prepareDocumentaryChapterVisualsStep2(params: {
  chapter: DocumentaryChapter;
  config: StudioConfig;
  useExternalGpu: boolean;
  targetWidth: number;
  targetHeight: number;
  signal?: AbortSignal;
}): Promise<DocumentaryChapter> {
  const {
    chapter,
    config,
    useExternalGpu,
    targetWidth,
    targetHeight,
    signal,
  } = params;

  const externalRes = await requestExternalGpuVisual({
    config,
    useExternalGpu,
    style: chapter.style,
    visualPrompt: chapter.visualPrompt,
    width: targetWidth,
    height: targetHeight,
    signal,
  });

  let bgBitmap: ImageBitmap | null = null;
  if (externalRes?.dataUrl) {
    try {
      const resp = await fetch(externalRes.dataUrl, { signal });
      if (resp.ok) {
        const blob = await resp.blob();
        bgBitmap = await createImageBitmap(blob);
      }
    } catch {
      bgBitmap = null;
    }
  }

  // Stamp 3x3 contact sheet for Step 3 alignment
  const cols = 3;
  const rows = 3;
  const pad = 4;
  const tileW = 216;
  const tileH = 384;
  const sheetW = cols * tileW + (cols + 1) * pad;
  const sheetH = rows * tileH + (rows + 1) * pad;

  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d');
  const stampedTimestampsSec: number[] = [];

  try {
    if (ctx) {
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(0, 0, sheetW, sheetH);

      for (let i = 0; i < 9; i++) {
        const relSec = Number(
          Math.max(
            0.2,
            Math.min(
              chapter.targetDurationSec - 0.1,
              (chapter.targetDurationSec * i) / 8
            )
          ).toFixed(1)
        );
        stampedTimestampsSec.push(relSec);
        const r = Math.floor(i / cols);
        const c = i % cols;
        const dx = pad + c * (tileW + pad);
        const dy = pad + r * (tileH + pad);

        drawProceduralScenePreviewTile({
          ctx,
          dx,
          dy,
          w: tileW,
          h: tileH,
          chapter,
          timeSec: relSec,
          bgImage: bgBitmap,
        });

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(dx + 4, dy + 4, 72, 19);
        ctx.fillStyle = '#FFAB00';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(formatRelSecondStamp(relSec), dx + 8, dy + 17);
      }
    }
  } finally {
    bgBitmap?.close();
  }

  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob((b) => res(b), 'image/jpeg', 0.72)
  );
  let stampedContactSheetJpeg = '';
  if (blob) {
    stampedContactSheetJpeg = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(String(reader.result || '').split(',')[1] ?? '');
      reader.readAsDataURL(blob);
    });
  }

  return {
    ...chapter,
    externalVisualDataUrl: externalRes?.dataUrl,
    stampedContactSheetJpeg,
    stampedTimestampsSec,
    visualEngineLabel:
      externalRes?.engineLabel ||
      (chapter.style === '3d_blender'
        ? 'Browser WebGL2 3D-Blender Shader'
        : chapter.style === 'motion_graphics'
        ? 'Browser WebGL2 Motion Graphics'
        : 'Browser WebGL2 Cinema Documentary'),
  };
}
