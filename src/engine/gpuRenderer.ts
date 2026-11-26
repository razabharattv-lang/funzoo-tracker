import { buildCaptionChunks, drawCapCutPopCaption } from './captionPainter';
import type {
  OutputLanguage,
  PreparedVisualClip,
  SourceMediaItem,
  TrendMetadata,
} from '../types/studio';
import type { SynthesizedVoiceResult } from './audioEngine';

export interface DeviceRenderProfile {
  isMobile: boolean;
  fps: number;
  bitrate: number;
  supportsWebCodecs: boolean;
}

export interface RenderedVideoBlobResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  renderEngine: string;
}

export function detectDeviceRenderProfile(): DeviceRenderProfile {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const supportsWebCodecs =
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof Worker !== 'undefined';

  return {
    isMobile,
    fps: isMobile ? 24 : 30,
    bitrate: isMobile ? 2_600_000 : 4_200_000,
    supportsWebCodecs,
  };
}

function computeTargetDimensions(
  source: SourceMediaItem,
  isMobile: boolean
): { width: number; height: number } {
  const srcW = Math.max(160, source.width || 1080);
  const srcH = Math.max(160, source.height || 1920);
  const isLandscape = srcW > srcH * 1.05;
  const isSquare = Math.abs(srcW - srcH) / Math.max(srcW, srcH) <= 0.12;

  if (isSquare) {
    return isMobile ? { width: 720, height: 720 } : { width: 1080, height: 1080 };
  }
  if (isLandscape) {
    return isMobile ? { width: 960, height: 540 } : { width: 1280, height: 720 };
  }
  return isMobile ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
}

async function seekVideoPrecise(
  video: HTMLVideoElement,
  targetSec: number
): Promise<void> {
  const clamped = Math.max(
    0,
    Math.min(targetSec, Math.max(0, (video.duration || targetSec + 0.1) - 0.04))
  );
  if (Math.abs(video.currentTime - clamped) < 0.008 && video.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      video.onseeked = null;
      resolve();
    };
    const timer = window.setTimeout(done, 1000);
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
}

async function renderSinglePassWebCodecsWorker(params: {
  source: SourceMediaItem;
  clip: PreparedVisualClip;
  metadata: TrendMetadata;
  voice: SynthesizedVoiceResult;
  language: OutputLanguage;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  signal?: AbortSignal;
  onProgress?: (pct: number, detail: string) => void;
}): Promise<RenderedVideoBlobResult> {
  const {
    source,
    clip,
    metadata,
    voice,
    language,
    width,
    height,
    fps,
    bitrate,
    signal,
    onProgress,
  } = params;

  const durationSec = Math.max(
    1.5,
    Math.min(clip.lockedVisualDurationSec, voice.durationSec)
  );
  const totalFrames = Math.max(1, Math.round(durationSec * fps));

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out loading source video for GPU render.')),
      15000
    );
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Failed to decode source video for GPU render.'));
    };
    video.load();
  });

  const worker = new Worker(new URL('./renderWorker.ts', import.meta.url), {
    type: 'module',
  });

  const cleanup = () => {
    try {
      worker.terminate();
    } catch {
      // ignore
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  try {
    let waitResolver: ((msg: Record<string, unknown>) => void) | null = null;
    let waitRejecter: ((err: Error) => void) | null = null;

    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const data = event.data;
      if (data.type === 'error') {
        const err = new Error(String(data.message || 'Render worker error'));
        if (waitRejecter) {
          const rej = waitRejecter;
          waitResolver = null;
          waitRejecter = null;
          rej(err);
        }
        return;
      }
      if (waitResolver) {
        const res = waitResolver;
        waitResolver = null;
        waitRejecter = null;
        res(data);
      }
    };

    worker.onerror = (event) => {
      const err = new Error(event.message || 'Render worker crashed.');
      if (waitRejecter) {
        const rej = waitRejecter;
        waitResolver = null;
        waitRejecter = null;
        rej(err);
      }
    };

    const nextWorkerReply = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        waitResolver = resolve;
        waitRejecter = reject;
      });

    // Copy PCM buffer for zero-copy transfer into worker
    const pcmCopy = new Float32Array(voice.pcmSamples);
    const readyPromise = nextWorkerReply();
    worker.postMessage(
      {
        type: 'init',
        width,
        height,
        fps,
        durationSec,
        bitrate,
        language,
        scriptText: metadata.voiceover,
        beats: metadata.beats,
        wordTimings: voice.wordTimings,
        safeCropInsets: clip.safeCropInsets,
        watermarkZones: clip.watermarkZones,
        sampleRate: voice.sampleRate,
        pcmSamples: pcmCopy.buffer,
      },
      [pcmCopy.buffer]
    );
    await readyPromise;

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) {
        throw new DOMException('Render cancelled', 'AbortError');
      }

      const timeSec = i / fps;
      const sourceTimeSec = clip.trimRange.startSec + timeSec;
      await seekVideoPrecise(video, sourceTimeSec);

      const bitmap = await createImageBitmap(video);
      const ackPromise = nextWorkerReply();
      worker.postMessage(
        {
          type: 'frame',
          frameIndex: i,
          timestampUs: Math.round(timeSec * 1_000_000),
          timeSec,
          bitmap,
        },
        [bitmap]
      );
      await ackPromise;

      if (onProgress && (i % Math.max(1, Math.floor(fps / 2)) === 0 || i === totalFrames - 1)) {
        const pct = Math.min(96, Math.round(((i + 1) / totalFrames) * 95));
        onProgress(
          pct,
          `Encoding Clip ${clip.clipIndex}/${clip.totalClips} (${i + 1}/${totalFrames} frames · WebGL2/WebCodecs)...`
        );
      }
    }

    onProgress?.(98, `Finalizing MP4 container for Clip ${clip.clipIndex}/${clip.totalClips}...`);
    const donePromise = nextWorkerReply();
    worker.postMessage({ type: 'finish' });
    const doneMsg = await donePromise;
    const mp4Buffer = doneMsg.mp4Buffer as ArrayBuffer;

    if (!mp4Buffer || mp4Buffer.byteLength < 1024) {
      throw new Error('WebCodecs worker produced an empty MP4 buffer.');
    }

    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    return {
      blob,
      mimeType: 'video/mp4',
      width,
      height,
      fps,
      durationSec: Number(durationSec.toFixed(2)),
      renderEngine: 'WebGL2 + WebCodecs H.264/AAC MP4',
    };
  } finally {
    cleanup();
  }
}

/**
 * Fast, phone-safe fallback when WebCodecs H.264 is unavailable on a browser.
 * Uses real-time Canvas 2D + WebAudio MediaStreamAudioDestinationNode + MediaRecorder
 * (zero 5-minute mobile FFmpeg.wasm stalls).
 */
async function renderCanvasMediaRecorderFallback(params: {
  source: SourceMediaItem;
  clip: PreparedVisualClip;
  metadata: TrendMetadata;
  voice: SynthesizedVoiceResult;
  language: OutputLanguage;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  signal?: AbortSignal;
  onProgress?: (pct: number, detail: string) => void;
}): Promise<RenderedVideoBlobResult> {
  const {
    source,
    clip,
    metadata,
    voice,
    language,
    width,
    height,
    fps,
    bitrate,
    signal,
    onProgress,
  } = params;

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser supports neither WebCodecs nor MediaRecorder video export.');
  }

  const durationSec = Math.max(
    1.5,
    Math.min(clip.lockedVisualDurationSec, voice.durationSec)
  );

  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const chosenMime =
    mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out loading video for Canvas MediaRecorder export.')),
      15000
    );
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Unable to decode video for Canvas MediaRecorder export.'));
    };
    video.load();
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const captionChunks = buildCaptionChunks(
    metadata.voiceover,
    durationSec,
    language,
    metadata.beats,
    voice.wordTimings
  );

  // Build real-time audio stream from mastered AudioBuffer
  const audioCtx = new AudioContext({ sampleRate: voice.sampleRate });
  const audioDest = audioCtx.createMediaStreamDestination();
  const audioSource = audioCtx.createBufferSource();
  const playBuf = audioCtx.createBuffer(
    1,
    voice.pcmSamples.length,
    voice.sampleRate
  );
  playBuf.copyToChannel(new Float32Array(voice.pcmSamples), 0);
  audioSource.buffer = playBuf;
  audioSource.connect(audioDest);

  const canvasStream = canvas.captureStream(fps);
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks(),
  ]);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(combinedStream, {
    mimeType: chosenMime,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000,
  });
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const crop = clip.safeCropInsets;
  const vw = video.videoWidth || source.width || width;
  const vh = video.videoHeight || source.height || height;
  const sx = Math.round(vw * crop.left);
  const sy = Math.round(vh * crop.top);
  const sw = Math.max(16, Math.round(vw * (1 - crop.left - crop.right)));
  const sh = Math.max(16, Math.round(vh * (1 - crop.top - crop.bottom)));

  // Cover-fit rectangle calculation
  const srcAspect = sw / Math.max(1, sh);
  const dstAspect = width / Math.max(1, height);
  let drawSx = sx;
  let drawSy = sy;
  let drawSw = sw;
  let drawSh = sh;
  if (srcAspect > dstAspect) {
    drawSw = Math.round(sh * dstAspect);
    drawSx = sx + Math.round((sw - drawSw) / 2);
  } else {
    drawSh = Math.round(sw / dstAspect);
    drawSy = sy + Math.round((sh - drawSh) / 2);
  }

  let rafId = 0;

  try {
    await seekVideoPrecise(video, clip.trimRange.startSec);
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const stoppedPromise = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start(250);
    audioSource.start();
    await video.play();

    const startWallMs = performance.now();

    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (signal?.aborted) {
          reject(new DOMException('Render cancelled', 'AbortError'));
          return;
        }
        const elapsedSec = (performance.now() - startWallMs) / 1000;
        if (elapsedSec >= durationSec) {
          resolve();
          return;
        }

        ctx.save();
        ctx.filter = 'contrast(1.07) saturate(1.12)';
        ctx.drawImage(video, drawSx, drawSy, drawSw, drawSh, 0, 0, width, height);
        ctx.restore();

        // Time-windowed corner delogo patch
        for (const z of clip.watermarkZones) {
          if (elapsedSec >= z.startSec && elapsedSec <= z.endSec) {
            const zx = Math.round(z.box[0] * width);
            const zy = Math.round(z.box[1] * height);
            const zw = Math.max(8, Math.round((z.box[2] - z.box[0]) * width));
            const zh = Math.max(8, Math.round((z.box[3] - z.box[1]) * height));
            ctx.save();
            ctx.beginPath();
            ctx.rect(zx, zy, zw, zh);
            ctx.clip();
            ctx.filter = 'blur(12px)';
            ctx.drawImage(video, drawSx, drawSy, drawSw, drawSh, 0, 0, width, height);
            ctx.restore();
          }
        }

        drawCapCutPopCaption({
          ctx,
          chunks: captionChunks,
          timeSec: elapsedSec,
          language,
          canvasWidth: width,
          canvasHeight: height,
        });

        const pct = Math.min(96, Math.round((elapsedSec / durationSec) * 96));
        onProgress?.(
          pct,
          `Recording Clip ${clip.clipIndex}/${clip.totalClips} (${elapsedSec.toFixed(1)}s/${durationSec.toFixed(1)}s · Canvas MediaRecorder)...`
        );

        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    await stoppedPromise;

    const cleanMime = chosenMime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm';
    const blob = new Blob(chunks, { type: cleanMime });
    if (blob.size < 1024) {
      throw new Error('MediaRecorder produced an empty video file.');
    }

    return {
      blob,
      mimeType: cleanMime,
      width,
      height,
      fps,
      durationSec: Number(durationSec.toFixed(2)),
      renderEngine:
        cleanMime === 'video/mp4'
          ? 'Canvas + MediaRecorder MP4'
          : 'Canvas + MediaRecorder WebM',
    };
  } finally {
    if (rafId) cancelAnimationFrame(rafId);
    try {
      audioSource.stop();
    } catch {
      // ignore
    }
    combinedStream.getTracks().forEach((t) => t.stop());
    try {
      await audioCtx.close();
    } catch {
      // ignore
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * STEP 5 (Fast, Phone-Safe Mux & Output):
 * Uses WebGL2 + WebCodecs H.264/AAC MP4 worker as primary path, falling back instantly
 * to real-time Canvas + MediaRecorder + WebAudio (zero mobile FFmpeg.wasm stalls).
 */
export async function renderProductionMp4Gpu(params: {
  source: SourceMediaItem;
  clip: PreparedVisualClip;
  metadata: TrendMetadata;
  voice: SynthesizedVoiceResult;
  language: OutputLanguage;
  signal?: AbortSignal;
  onProgress?: (pct: number, detail: string) => void;
}): Promise<RenderedVideoBlobResult> {
  const profile = detectDeviceRenderProfile();
  const { width, height } = computeTargetDimensions(params.source, profile.isMobile);

  if (profile.supportsWebCodecs) {
    try {
      return await renderSinglePassWebCodecsWorker({
        ...params,
        width,
        height,
        fps: profile.fps,
        bitrate: profile.bitrate,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      params.onProgress?.(
        5,
        'Switching to fast Canvas MediaRecorder fallback for this device...'
      );
    }
  }

  return renderCanvasMediaRecorderFallback({
    ...params,
    width,
    height,
    fps: profile.fps,
    bitrate: profile.bitrate,
  });
}
