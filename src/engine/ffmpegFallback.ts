import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { OutputLanguage } from '../types/studio';
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
  startSec: number;
  endSec: number;
  audio: ProcessedStudioAudio;
  scriptText: string;
  language: OutputLanguage;
  watermarkBoxes: number[][];
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
  delogoCount: number;
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

function buildDelogoFilters(
  boxes: number[][],
  srcW: number,
  srcH: number
): string[] {
  const filters: string[] = [];
  for (const box of (boxes || []).slice(0, 6)) {
    if (!Array.isArray(box) || box.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = box.map((v) => Number(v));
    if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) continue;
    const scale = Math.max(ymin, xmin, ymax, xmax) > 1.5 ? 1000 : 1;
    const x = Math.max(2, Math.floor((xmin / scale) * srcW) - 4);
    const y = Math.max(2, Math.floor((ymin / scale) * srcH) - 4);
    let w = Math.floor(((xmax - xmin) / scale) * srcW) + 8;
    let h = Math.floor(((ymax - ymin) / scale) * srcH) + 8;
    w = Math.max(8, Math.min(w, srcW - x - 2));
    h = Math.max(8, Math.min(h, srcH - y - 2));
    if (w >= 10 && h >= 10 && w < srcW * 0.75 && h < srcH * 0.5) {
      filters.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
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
    startSec,
    endSec,
    audio,
    scriptText,
    language,
    watermarkBoxes,
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

  const clipSourceDur = Math.max(3, endSec - startSec);
  const finalDurationSec = Math.max(
    4.0,
    Math.min(Math.max(audio.durationSec + 0.15, clipSourceDur / 1.03), 60.0)
  );

  const tempFiles = [
    'input.mp4',
    'vo_master.wav',
    'clean_base.mp4',
    'composited.webm',
    'final_output.mp4',
  ];
  for (const f of tempFiles) await safeDelete(ffmpeg, f);

  const wavBytes = encodeFloat32ToWavBytes(audio.pcmMono, audio.sampleRate);
  await ffmpeg.writeFile('input.mp4', await fetchFile(sourceVideoBlob));
  await ffmpeg.writeFile('vo_master.wav', wavBytes);
  onProgressPct(25);

  const delogoFilters = buildDelogoFilters(
    watermarkBoxes,
    sourceWidth,
    sourceHeight
  );
  const cropW = Math.round(targetWidth * 1.15);
  const cropH = Math.round(targetHeight * 1.15);

  const vFilters = [
    ...delogoFilters,
    'setpts=PTS/1.03',
    `scale=${cropW}:${cropH}:force_original_aspect_ratio=increase`,
    `crop=${targetWidth}:${targetHeight}`,
    'eq=contrast=1.14:saturation=1.32:brightness=0.02:gamma=1.04',
  ];

  onStatus('FFmpeg.wasm fallback pass 1: delogo, crop & color grade...');
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
    '30',
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

  // Optional Canvas 2D overlay pass for captions + character pop-ins
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
            climaxSecond / 1.03,
            finalDurationSec
          );
          const chunks = buildCaptionChunks(
            scriptText,
            finalDurationSec,
            language
          );
          const stream = canvas.captureStream(30);
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

          onStatus('Compositing kinetic captions & character pop-ins...');
          await video.play();
          recorder.start(250);
          const startPerf = performance.now();
          const totalMs = finalDurationSec * 1000;

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
              const zoom = 1.0 + 0.05 * Math.abs(Math.sin(t * 0.65));
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
      finalDurationSec.toFixed(2),
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
      finalDurationSec.toFixed(2),
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
    durationSec: Number(finalDurationSec.toFixed(2)),
    width: targetWidth,
    height: targetHeight,
    delogoCount: delogoFilters.length,
    characterMode,
    renderEngine: `FFmpeg.wasm Fallback (${targetWidth}×${targetHeight})`,
  };
}
