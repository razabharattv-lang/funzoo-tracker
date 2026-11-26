import type { OutputLanguage } from '../types/studio';
import type { ProcessedStudioAudio } from './audioEngine';
import { loadPortraitBitmap } from './characterAnimator';

export interface GpuRenderOptions {
  sourceVideoBlob: Blob;
  sourceWidth: number;
  sourceHeight: number;
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

export interface RenderedHardwareMp4 {
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

export interface DeviceRenderProfile {
  isMobile: boolean;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  label: string;
}

/**
 * Mobile Resource Guardrail:
 * Auto-detects phones and low-RAM devices (deviceMemory <= 4GB) to render crisp
 * 720x1280 @ 30fps (~3.8 Mbps) on mobile vs 1080x1920 @ 30fps (~6.0 Mbps) on desktop.
 */
export function detectDeviceRenderProfile(): DeviceRenderProfile {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const deviceMemory =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
  const isMobileUa =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
      ua
    );
  const isLowRam = typeof deviceMemory === 'number' && deviceMemory <= 4;
  const isMobile = isMobileUa || isLowRam;

  if (isMobile) {
    return {
      isMobile: true,
      width: 720,
      height: 1280,
      fps: 30,
      bitrate: 3_800_000,
      label: '720p Mobile GPU',
    };
  }

  return {
    isMobile: false,
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 6_000_000,
    label: '1080p Desktop GPU',
  };
}

function supportsWebCodecsWorkerPipeline(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

async function seekVideoToTime(
  video: HTMLVideoElement,
  targetTime: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const clamped = Math.max(
    0.01,
    Math.min(targetTime, Math.max(0.05, (video.duration || targetTime + 1) - 0.04))
  );
  if (Math.abs(video.currentTime - clamped) < 0.008 && video.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onseeked = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);

    video.onseeked = () => {
      cleanup();
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      video.currentTime = clamped;
    } catch {
      cleanup();
      resolve();
    }
  });
}

async function renderViaWebCodecsWorker(
  opts: GpuRenderOptions,
  profile: DeviceRenderProfile
): Promise<RenderedHardwareMp4> {
  const {
    sourceVideoBlob,
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

  const clipSourceDur = Math.max(3, endSec - startSec);
  const finalDurationSec = Math.max(
    4.0,
    Math.min(Math.max(audio.durationSec + 0.15, clipSourceDur / 1.03), 60.0)
  );
  const totalFrames = Math.max(30, Math.round(finalDurationSec * profile.fps));

  let portraitBitmap: ImageBitmap | null = null;
  let characterMode = 'disabled';
  if (characterEnabled && characterPortraitUrl) {
    try {
      portraitBitmap = await loadPortraitBitmap(characterPortraitUrl);
      characterMode = 'webaudio-reactive-popin';
    } catch {
      portraitBitmap = null;
      characterMode = 'disabled';
    }
  }

  const videoUrl = URL.createObjectURL(sourceVideoBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  const worker = new Worker(new URL('./gpuWorker.ts', import.meta.url), {
    type: 'module',
  });

  let delogoCount = 0;
  let activeCodecLabel = profile.label;

  const onAbort = () => {
    try {
      worker.postMessage({ type: 'abort' });
    } catch {
      // ignore
    }
    worker.terminate();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Source video load timed out.')),
        15_000
      );
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not decode source video for GPU pipeline.'));
      };
    });

    const srcW = video.videoWidth || opts.sourceWidth || 1080;
    const srcH = video.videoHeight || opts.sourceHeight || 1920;

    let pendingResolve: ((data: Record<string, unknown>) => void) | null = null;
    let pendingReject: ((err: Error) => void) | null = null;

    worker.onmessage = (ev: MessageEvent<Record<string, unknown>>) => {
      const data = ev.data;
      if (data.type === 'error') {
        const err = new Error(String(data.message || 'GPU Worker error'));
        pendingReject?.(err);
        pendingResolve = null;
        pendingReject = null;
        return;
      }
      pendingResolve?.(data);
      pendingResolve = null;
      pendingReject = null;
    };

    worker.onerror = (ev) => {
      const err = new Error(ev.message || 'GPU Worker crashed');
      pendingReject?.(err);
      pendingResolve = null;
      pendingReject = null;
    };

    const awaitWorkerReply = (expectedType: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Cancelled', 'AbortError'));
          return;
        }
        pendingResolve = (data) => {
          if (data.type === expectedType) {
            resolve(data);
          } else {
            reject(
              new Error(
                `Unexpected worker reply "${String(data.type)}" (expected "${expectedType}")`
              )
            );
          }
        };
        pendingReject = reject;
      });

    onStatus(
      `Initializing WebGL2 GPU Worker + WebCodecs H.264 (${profile.width}×${profile.height})...`
    );

    const pcmCopy = new Float32Array(audio.pcmMono);
    const ampCopy = new Float32Array(audio.amplitudeEnvelope);
    const mouthCopy = new Float32Array(audio.mouthOpenEnvelope);
    const initTransfer: Transferable[] = [
      pcmCopy.buffer,
      ampCopy.buffer,
      mouthCopy.buffer,
    ];
    if (portraitBitmap) initTransfer.push(portraitBitmap);

    const readyPromise = awaitWorkerReply('ready');
    worker.postMessage(
      {
        type: 'init',
        width: profile.width,
        height: profile.height,
        fps: profile.fps,
        bitrate: profile.bitrate,
        durationSec: finalDurationSec,
        scriptText,
        language,
        watermarkBoxes,
        climaxSecond,
        portraitBitmap,
        pcmMono: pcmCopy,
        sampleRate: audio.sampleRate,
        amplitudeEnvelope: ampCopy,
        mouthOpenEnvelope: mouthCopy,
        envelopeFps: audio.envelopeFps,
      },
      initTransfer
    );
    // portraitBitmap was transferred to worker
    portraitBitmap = null;

    const readyData = await readyPromise;
    delogoCount = Number(readyData.delogoCount ?? 0);
    const hwAccel = String(readyData.hardwareAcceleration ?? 'prefer-hardware');
    activeCodecLabel =
      hwAccel === 'prefer-hardware'
        ? `WebCodecs Hardware GPU (${profile.width}×${profile.height})`
        : `WebCodecs WebGL2 (${profile.width}×${profile.height})`;
    onProgressPct(10);

    onStatus(
      `Hardware GPU rendering ${totalFrames} frames (1 frame at a time · ${profile.width}×${profile.height})...`
    );

    // Strictly process ONE frame at a time — never buffer decoded frames into arrays
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const timeSec = f / profile.fps;
      // 1.03x anti-copyright pace adjustment
      const sourceRelSec = (timeSec * 1.03) % clipSourceDur;
      const seekSec = startSec + sourceRelSec;

      await seekVideoToTime(video, seekSec, signal);
      const frameBitmap = await createImageBitmap(video);

      const frameAck = awaitWorkerReply('frame_done');
      // Ownership of frameBitmap transfers zero-copy to Worker and is closed immediately after draw
      worker.postMessage(
        {
          type: 'frame',
          frameIndex: f,
          timeSec,
          bitmap: frameBitmap,
          sourceWidth: srcW,
          sourceHeight: srcH,
        },
        [frameBitmap]
      );
      await frameAck;

      if (f % 8 === 0 || f === totalFrames - 1) {
        const pct = 10 + Math.round(((f + 1) / totalFrames) * 84);
        onProgressPct(pct);
      }
    }

    onStatus('Finalizing hardware H.264 + AAC MP4 container (stripping metadata)...');
    const finishPromise = awaitWorkerReply('complete');
    worker.postMessage({ type: 'finish' });
    const completeData = await finishPromise;

    const mp4Buffer = completeData.buffer as ArrayBuffer;
    const finalBlob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(finalBlob);
    onProgressPct(100);

    return {
      blob: finalBlob,
      blobUrl,
      sizeBytes: finalBlob.size,
      durationSec: Number(finalDurationSec.toFixed(2)),
      width: profile.width,
      height: profile.height,
      delogoCount,
      characterMode,
      renderEngine: activeCodecLabel,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    portraitBitmap?.close();
    worker.terminate();
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(videoUrl);
  }
}

/**
 * Core 4 Entrypoint:
 * Uses Off-Main-Thread WebWorker + WebGL2 Shaders + Hardware WebCodecs + mp4-muxer
 * by default, and lazy-loads @ffmpeg/ffmpeg ONLY if WebCodecs is unavailable.
 */
export async function renderProductionMp4Gpu(
  opts: GpuRenderOptions
): Promise<RenderedHardwareMp4> {
  const profile = detectDeviceRenderProfile();

  if (supportsWebCodecsWorkerPipeline()) {
    try {
      return await renderViaWebCodecsWorker(opts, profile);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      opts.onStatus(
        'WebCodecs hardware pass unavailable on this browser — switching to lazy FFmpeg.wasm fallback...'
      );
    }
  }

  // Strictly lazy-loaded fallback so mobile WebCodecs devices never download FFmpeg WASM
  const { renderWithLazyFFmpegFallback } = await import('./ffmpegFallback');
  return renderWithLazyFFmpegFallback({
    sourceVideoBlob: opts.sourceVideoBlob,
    sourceWidth: opts.sourceWidth,
    sourceHeight: opts.sourceHeight,
    targetWidth: profile.width,
    targetHeight: profile.height,
    startSec: opts.startSec,
    endSec: opts.endSec,
    audio: opts.audio,
    scriptText: opts.scriptText,
    language: opts.language,
    watermarkBoxes: opts.watermarkBoxes,
    climaxSecond: opts.climaxSecond,
    characterEnabled: opts.characterEnabled,
    characterPortraitUrl: opts.characterPortraitUrl,
    onStatus: opts.onStatus,
    onProgressPct: opts.onProgressPct,
    signal: opts.signal,
  });
}
