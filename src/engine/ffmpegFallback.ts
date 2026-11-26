import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type {
  DocumentaryChapter,
  OutputLanguage,
  SafeCropInsets,
  ScriptBeat,
  TrimRange,
  WatermarkZone,
} from '../types/studio';
import {
  encodeFloat32ToWavBytes,
  type ProcessedStudioAudio,
} from './audioEngine';
import {
  buildCharacterPopInSchedule,
  computeSquarePortraitCrop,
  drawTalkingCharacterOverlay,
  loadPortraitBitmap,
  type PortraitSource,
} from './characterAnimator';
import { buildCaptionChunks, drawCapCutPopCaption } from './captionPainter';

export interface FallbackRenderOptions {
  sourceVideoBlob: Blob;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  trimRange: TrimRange;
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
  bumperTrimmedSec: number;
  lockedDurationSec: number;
  audio: ProcessedStudioAudio;
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  climaxSecond: number;
  characterEnabled: boolean;
  characterPortraitUrl: string;
  onStatus: (msg: string) => void;
  onProgressPct: (pct: number) => void;
  signal?: AbortSignal;
}

export interface FallbackRenderResult {
  blob: Blob;
  blobUrl: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  delogoCount: number;
  bumperTrimmedSec: number;
  safeCropApplied: boolean;
  characterMode: string;
  renderEngine: string;
}

let sharedFFmpeg: FFmpeg | null = null;
let ffmpegLoaded = false;

const FFMPEG_CORE_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
];

async function getLazyFFmpeg(onStatus: (msg: string) => void): Promise<FFmpeg> {
  if (sharedFFmpeg && ffmpegLoaded) return sharedFFmpeg;
  const ffmpeg = new FFmpeg();
  let lastErr = '';
  for (const baseURL of FFMPEG_CORE_BASES) {
    try {
      onStatus('WebCodecs unavailable — lazy-loading FFmpeg.wasm fallback...');
      const coreURL = await toBlobURL(
        `${baseURL}/ffmpeg-core.js`,
        'text/javascript'
      );
      const wasmURL = await toBlobURL(
        `${baseURL}/ffmpeg-core.wasm`,
        'application/wasm'
      );
      await ffmpeg.load({ coreURL, wasmURL });
      sharedFFmpeg = ffmpeg;
      ffmpegLoaded = true;
      return ffmpeg;
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  throw new Error(`FFmpeg.wasm fallback load failed: ${lastErr}`);
}

function buildTimeWindowedDelogoFilters(
  zones: WatermarkZone[],
  srcW: number,
  srcH: number,
  clipStartSec: number
): string[] {
  const filters: string[] = [];
  for (const z of (zones || []).filter((x) => x.action === 'gpu_delogo_patch').slice(0, 8)) {
    const [ymin, xmin, ymax, xmax] = z.box.map((v) => Number(v));
    if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) continue;
    const scale = Math.max(ymin, xmin, ymax, xmax) > 1.5 ? 1000 : 1;
    const x = Math.max(2, Math.floor((xmin / scale) * srcW) - 8);
    const y = Math.max(2, Math.floor((ymin / scale) * srcH) - 8);
    let w = Math.floor(((xmax - xmin) / scale) * srcW) + 16;
    let h = Math.floor(((ymax - ymin) / scale) * srcH) + 16;
    w = Math.max(8, Math.min(w, srcW - x - 2));
    h = Math.max(8, Math.min(h, srcH - y - 2));
    if (w >= 10 && h >= 10 && w < srcW * 0.75 && h < srcH * 0.5) {
      const relStart = Math.max(0, z.startSec - clipStartSec).toFixed(2);
      const relEnd = Math.max(0.2, z.endSec - clipStartSec).toFixed(2);
      filters.push(
        `delogo=x=${x}:y=${y}:w=${w}:h=${h}:enable='between(t,${relStart},${relEnd})'`
      );
    }
  }
  return filters;
}

async function safeDelete(ffmpeg: FFmpeg, file: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(file);
  } catch {
    // ignore
  }
}

export async function renderWithLazyFFmpegFallback(
  opts: FallbackRenderOptions
): Promise<FallbackRenderResult> {
  const {
    sourceVideoBlob,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    targetFps,
    trimRange,
    safeCropInsets,
    watermarkZones,
    bumperTrimmedSec,
    lockedDurationSec,
    audio,
    scriptText,
    beats,
    language,
    climaxSecond,
    characterEnabled,
    characterPortraitUrl,
    onStatus,
    onProgressPct,
    signal,
  } = opts;

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  const ffmpeg = await getLazyFFmpeg(onStatus);
  onProgressPct(12);

  let portraitBitmap: ImageBitmap | null = null;
  let portraitSource: PortraitSource | null = null;
  let characterMode = 'disabled';

  if (characterEnabled && characterPortraitUrl) {
    try {
      portraitBitmap = await loadPortraitBitmap(characterPortraitUrl);
      const crop = computeSquarePortraitCrop(
        portraitBitmap.width,
        portraitBitmap.height
      );
      portraitSource = { source: portraitBitmap, ...crop };
      characterMode = 'webaudio-reactive-popin';
    } catch {
      portraitBitmap = null;
    }
  }

  const startSec = Math.max(0, trimRange.startSec);
  const clipSourceDur = Math.max(3, trimRange.endSec - startSec);
  const tempFiles = [
    'input.mp4',
    'vo_master.wav',
    'clean_base.mp4',
    'composited.webm',
    'final_output.mp4',
  ];
  for (const f of tempFiles) await safeDelete(ffmpeg, f);

  const paddedSamples = Math.ceil(lockedDurationSec * audio.sampleRate);
  const paddedPcm = new Float32Array(paddedSamples);
  paddedPcm.set(
    audio.pcmMono.subarray(0, Math.min(paddedSamples, audio.pcmMono.length)),
    0
  );

  const wavBytes = encodeFloat32ToWavBytes(paddedPcm, audio.sampleRate);
  await ffmpeg.writeFile('input.mp4', await fetchFile(sourceVideoBlob));
  await ffmpeg.writeFile('vo_master.wav', wavBytes);
  onProgressPct(25);

  const delogoFilters = buildTimeWindowedDelogoFilters(
    watermarkZones,
    sourceWidth,
    sourceHeight,
    startSec
  );

  const leftPx = Math.round(
    sourceWidth * Math.max(0, Math.min(0.14, safeCropInsets.left))
  );
  const rightPx = Math.round(
    sourceWidth * Math.max(0, Math.min(0.14, safeCropInsets.right))
  );
  const topPx = Math.round(
    sourceHeight * Math.max(0, Math.min(0.14, safeCropInsets.top))
  );
  const bottomPx = Math.round(
    sourceHeight * Math.max(0, Math.min(0.14, safeCropInsets.bottom))
  );
  const safeW = Math.max(64, sourceWidth - leftPx - rightPx);
  const safeH = Math.max(64, sourceHeight - topPx - bottomPx);
  const safeCropApplied = leftPx > 0 || rightPx > 0 || topPx > 0 || bottomPx > 0;

  const vFilters = [
    ...delogoFilters,
    ...(safeCropApplied
      ? [`crop=${safeW}:${safeH}:${leftPx}:${topPx}`]
      : []),
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase`,
    `crop=${targetWidth}:${targetHeight}`,
    'eq=contrast=1.22:saturation=1.36:brightness=0.03',
  ];

  onStatus(
    'FFmpeg.wasm fallback pass 1: time-windowed delogo, subject-safe crop & cinema grade...'
  );
  await ffmpeg.exec([
    '-y',
    '-ss',
    startSec.toFixed(2),
    '-t',
    clipSourceDur.toFixed(2),
    '-i',
    'input.mp4',
    '-vf',
    vFilters.join(','),
    '-an',
    '-r',
    String(targetFps),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-map_metadata',
    '-1',
    'clean_base.mp4',
  ]);
  onProgressPct(55);

  let compositedWebM: Blob | null = null;
  if (typeof MediaRecorder !== 'undefined') {
    const chosenMime = ['video/webm;codecs=vp8', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    );
    if (chosenMime) {
      const cleanData = (await ffmpeg.readFile('clean_base.mp4')) as Uint8Array;
      const cleanUrl = URL.createObjectURL(
        new Blob([cleanData.slice().buffer], { type: 'video/mp4' })
      );
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = cleanUrl;

      try {
        if (ctx) {
          await new Promise<void>((res, rej) => {
            video.onloadeddata = () => res();
            video.onerror = () => rej(new Error('Base video decode failed'));
          });
          const schedule = buildCharacterPopInSchedule(
            climaxSecond,
            lockedDurationSec
          );
          const chunks = buildCaptionChunks(
            scriptText,
            lockedDurationSec,
            language,
            beats
          );
          const stream = canvas.captureStream(targetFps);
          const recorder = new MediaRecorder(stream, {
            mimeType: chosenMime,
            videoBitsPerSecond: targetWidth >= 1000 ? 4_500_000 : 3_200_000,
          });
          const parts: BlobPart[] = [];
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) parts.push(e.data);
          };
          const stopDone = new Promise<Blob>((res) => {
            recorder.onstop = () => res(new Blob(parts, { type: chosenMime }));
          });

          onStatus('Compositing beat-synced captions & character pop-ins...');
          await video.play();
          recorder.start(250);
          const startPerf = performance.now();
          const totalMs = lockedDurationSec * 1000;

          await new Promise<void>((res, rej) => {
            const tick = () => {
              if (signal?.aborted) {
                try {
                  recorder.stop();
                } catch {
                  // ignore
                }
                rej(new DOMException('Cancelled', 'AbortError'));
                return;
              }
              const elapsed = performance.now() - startPerf;
              const t = elapsed / 1000;
              // Subtle 1.02x -> 1.06x micro-zoom
              const zoom = 1.02 + 0.04 * Math.abs(Math.sin(t * 0.58));
              const dw = targetWidth * zoom;
              const dh = targetHeight * zoom;
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, targetWidth, targetHeight);
              ctx.drawImage(
                video,
                (targetWidth - dw) / 2,
                (targetHeight - dh) / 2,
                dw,
                dh
              );
              if (portraitSource) {
                drawTalkingCharacterOverlay({
                  ctx,
                  portrait: portraitSource,
                  timeSec: t,
                  schedule,
                  amplitudeEnvelope: audio.amplitudeEnvelope,
                  mouthOpenEnvelope: audio.mouthOpenEnvelope,
                  envelopeFps: audio.envelopeFps,
                  canvasWidth: targetWidth,
                  canvasHeight: targetHeight,
                });
              }
              drawCapCutPopCaption({
                ctx,
                chunks,
                timeSec: t,
                language,
                canvasWidth: targetWidth,
                canvasHeight: targetHeight,
              });
              onProgressPct(Math.round(55 + (elapsed / totalMs) * 28));
              if (elapsed >= totalMs) {
                res();
                return;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });

          video.pause();
          recorder.stop();
          const recorded = await stopDone;
          if (recorded.size > 15_000) compositedWebM = recorded;
        }
      } finally {
        video.pause();
        video.removeAttribute('src');
        URL.revokeObjectURL(cleanUrl);
      }
    }
  }

  portraitBitmap?.close();

  onStatus('FFmpeg.wasm fallback final MP4 mux...');
  if (compositedWebM) {
    await ffmpeg.writeFile('composited.webm', await fetchFile(compositedWebM));
    await ffmpeg.exec([
      '-y',
      '-i',
      'composited.webm',
      '-i',
      'vo_master.wav',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      lockedDurationSec.toFixed(2),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      'final_output.mp4',
    ]);
  } else {
    await ffmpeg.exec([
      '-y',
      '-stream_loop',
      '-1',
      '-i',
      'clean_base.mp4',
      '-i',
      'vo_master.wav',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      lockedDurationSec.toFixed(2),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      'final_output.mp4',
    ]);
  }

  const outBytes = (await ffmpeg.readFile('final_output.mp4')) as Uint8Array;
  const finalBlob = new Blob([outBytes.slice().buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(finalBlob);

  for (const f of tempFiles) await safeDelete(ffmpeg, f);
  onProgressPct(100);

  return {
    blob: finalBlob,
    blobUrl,
    sizeBytes: finalBlob.size,
    durationSec: Number(lockedDurationSec.toFixed(2)),
    width: targetWidth,
    height: targetHeight,
    fps: targetFps,
    delogoCount: delogoFilters.length,
    bumperTrimmedSec,
    safeCropApplied,
    characterMode,
    renderEngine: `FFmpeg.wasm Fallback (${targetWidth}×${targetHeight} @ ${targetFps}fps)`,
  };
}

export async function renderDocumentarySceneFallback(opts: {
  chapter: DocumentaryChapter;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  audio: ProcessedStudioAudio;
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  characterEnabled: boolean;
  characterPortraitUrl: string;
  onStatus: (msg: string) => void;
  onProgressPct: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<FallbackRenderResult> {
  const {
    chapter,
    targetWidth,
    targetHeight,
    targetFps,
    audio,
    scriptText,
    beats,
    language,
    characterEnabled,
    characterPortraitUrl,
    onStatus,
    onProgressPct,
    signal,
  } = opts;

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const ffmpeg = await getLazyFFmpeg(onStatus);
  onProgressPct(15);

  const lockedDurationSec = chapter.targetDurationSec;
  let portraitBitmap: ImageBitmap | null = null;
  let portraitSource: PortraitSource | null = null;
  let characterMode = 'disabled';

  if (characterEnabled && characterPortraitUrl) {
    try {
      portraitBitmap = await loadPortraitBitmap(characterPortraitUrl);
      const crop = computeSquarePortraitCrop(
        portraitBitmap.width,
        portraitBitmap.height
      );
      portraitSource = { source: portraitBitmap, ...crop };
      characterMode = 'webaudio-reactive-popin';
    } catch {
      portraitBitmap = null;
    }
  }

  let bgBitmap: ImageBitmap | null = null;
  if (chapter.externalVisualDataUrl) {
    try {
      const resp = await fetch(chapter.externalVisualDataUrl, { signal });
      if (resp.ok) bgBitmap = await createImageBitmap(await resp.blob());
    } catch {
      bgBitmap = null;
    }
  }

  const tempFiles = ['scene_vo.wav', 'scene_raw.webm', 'scene_out.mp4'];
  for (const f of tempFiles) await safeDelete(ffmpeg, f);

  const paddedSamples = Math.ceil(lockedDurationSec * audio.sampleRate);
  const paddedPcm = new Float32Array(paddedSamples);
  paddedPcm.set(
    audio.pcmMono.subarray(0, Math.min(paddedSamples, audio.pcmMono.length)),
    0
  );
  await ffmpeg.writeFile(
    'scene_vo.wav',
    encodeFloat32ToWavBytes(paddedPcm, audio.sampleRate)
  );

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  const chosenMime =
    typeof MediaRecorder !== 'undefined'
      ? ['video/webm;codecs=vp8', 'video/webm'].find((m) =>
          MediaRecorder.isTypeSupported(m)
        )
      : undefined;

  if (ctx && chosenMime) {
    const schedule = buildCharacterPopInSchedule(
      chapter.climaxSec,
      lockedDurationSec
    );
    const chunks = buildCaptionChunks(
      scriptText,
      lockedDurationSec,
      language,
      beats
    );
    const stream = canvas.captureStream(targetFps);
    const recorder = new MediaRecorder(stream, {
      mimeType: chosenMime,
      videoBitsPerSecond: targetWidth >= 1000 ? 4_500_000 : 3_200_000,
    });
    const parts: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    const stopDone = new Promise<Blob>((res) => {
      recorder.onstop = () => res(new Blob(parts, { type: chosenMime }));
    });

    onStatus('Rendering procedural documentary canvas scene...');
    recorder.start(250);
    const startPerf = performance.now();
    const totalMs = lockedDurationSec * 1000;

    await new Promise<void>((res, rej) => {
      const tick = () => {
        if (signal?.aborted) {
          try {
            recorder.stop();
          } catch {
            // ignore
          }
          rej(new DOMException('Cancelled', 'AbortError'));
          return;
        }
        const elapsed = performance.now() - startPerf;
        const t = elapsed / 1000;

        ctx.fillStyle = '#0B1120';
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        if (bgBitmap) {
          const z = 1.03 + 0.06 * (elapsed / totalMs);
          const dw = targetWidth * z;
          const dh = targetHeight * z;
          ctx.drawImage(
            bgBitmap,
            (targetWidth - dw) / 2,
            (targetHeight - dh) / 2,
            dw,
            dh
          );
          ctx.fillStyle = 'rgba(11, 17, 32, 0.35)';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
        } else {
          ctx.strokeStyle = chapter.accentHex;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(
            targetWidth / 2,
            targetHeight * 0.44,
            targetWidth * (0.22 + 0.03 * Math.sin(t * 2)),
            0,
            Math.PI * 2
          );
          ctx.stroke();
        }

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `900 ${Math.round(targetWidth * 0.055)}px "Plus Jakarta Sans", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(
          chapter.captionCallout.slice(0, 26),
          targetWidth / 2,
          targetHeight * 0.22
        );

        if (portraitSource) {
          drawTalkingCharacterOverlay({
            ctx,
            portrait: portraitSource,
            timeSec: t,
            schedule,
            amplitudeEnvelope: audio.amplitudeEnvelope,
            mouthOpenEnvelope: audio.mouthOpenEnvelope,
            envelopeFps: audio.envelopeFps,
            canvasWidth: targetWidth,
            canvasHeight: targetHeight,
          });
        }
        drawCapCutPopCaption({
          ctx,
          chunks,
          timeSec: t,
          language,
          canvasWidth: targetWidth,
          canvasHeight: targetHeight,
        });

        onProgressPct(Math.round(20 + (elapsed / totalMs) * 58));
        if (elapsed >= totalMs) {
          res();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    recorder.stop();
    const recorded = await stopDone;
    await ffmpeg.writeFile('scene_raw.webm', await fetchFile(recorded));
    await ffmpeg.exec([
      '-y',
      '-i',
      'scene_raw.webm',
      '-i',
      'scene_vo.wav',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      lockedDurationSec.toFixed(2),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      'scene_out.mp4',
    ]);
  } else {
    await ffmpeg.exec([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x0B1120:s=${targetWidth}x${targetHeight}:r=${targetFps}:d=${lockedDurationSec.toFixed(2)}`,
      '-i',
      'scene_vo.wav',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      'scene_out.mp4',
    ]);
  }

  portraitBitmap?.close();
  bgBitmap?.close();

  const outBytes = (await ffmpeg.readFile('scene_out.mp4')) as Uint8Array;
  const finalBlob = new Blob([outBytes.slice().buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(finalBlob);
  for (const f of tempFiles) await safeDelete(ffmpeg, f);
  onProgressPct(100);

  return {
    blob: finalBlob,
    blobUrl,
    sizeBytes: finalBlob.size,
    durationSec: Number(lockedDurationSec.toFixed(2)),
    width: targetWidth,
    height: targetHeight,
    fps: targetFps,
    delogoCount: 0,
    bumperTrimmedSec: 0,
    safeCropApplied: false,
    characterMode,
    renderEngine: `FFmpeg.wasm Scene Fallback (${targetWidth}×${targetHeight} @ ${targetFps}fps)`,
  };
}
