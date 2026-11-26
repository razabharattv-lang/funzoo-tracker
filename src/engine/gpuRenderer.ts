import type {
  OutputLanguage,
  PreparedVisualClip,
  ScriptBeat,
  SourceMediaItem,
} from '../types/studio';
import type { ProcessedStudioAudio } from './audioEngine';
import { loadPortraitBitmap } from './characterAnimator';

export interface GpuRenderOptions {
  source: SourceMediaItem;
  clip: PreparedVisualClip;
  audio: ProcessedStudioAudio;
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
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
  fps: number;
  delogoCount: number;
  bumperTrimmedSec: number;
  safeCropApplied: boolean;
  characterMode: string;
  renderEngine: string;
}

export interface DeviceRenderProfile {
  isMobile: boolean;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  playbackRate: number;
  label: string;
}

interface VideoFrameCallbackMetadata {
  mediaTime: number;
}

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Mobile Resource Guardrail:
 * - Mobile / <= 4GB RAM: 720x1280 @ 24fps (~3.8 Mbps)
 * - Desktop: 1080x1920 @ 30fps (~6.0 Mbps)
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

  if (isMobileUa || isLowRam) {
    return {
      isMobile: true,
      width: 720,
      height: 1280,
      fps: 24,
      bitrate: 3_800_000,
      playbackRate: 1.25,
      label: '720p 24fps Mobile GPU',
    };
  }

  return {
    isMobile: false,
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 6_000_000,
    playbackRate: 1.5,
    label: '1080p 30fps Desktop GPU',
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

function describeSurgicalAction(clip: PreparedVisualClip): string {
  if (clip.delogoZoneCount > 0 && clip.safeCropApplied) {
    return 'Removing Inner Logo + Safe Edge Crop & Fast GPU Mux';
  }
  if (clip.delogoZoneCount > 0) {
    return 'Removing Inner Logo & Fast GPU Mux';
  }
  if (clip.safeCropApplied) {
    return 'Applying Subject-Safe Crop & Fast GPU Mux';
  }
  if (clip.bumperTrimmedSec > 0) {
    return 'Skipping Creator Bumper & Fast GPU Mux';
  }
  return 'Fast Single-Pass GPU Mux';
}

async function seekOnceForIntervalStart(
  video: HTMLVideoElement,
  targetSec: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const clamped = Math.max(
    0.01,
    Math.min(targetSec, Math.max(0.05, (video.duration || targetSec + 1) - 0.05))
  );
  if (Math.abs(video.currentTime - clamped) < 0.04 && video.readyState >= 2) {
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

function waitNextDecodedVideoFrame(
  video: VideoWithRVFC,
  signal?: AbortSignal
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }

    let settled = false;
    let rvfcId: number | null = null;
    let rafId: number | null = null;

    const cleanup = () => {
      window.clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
      if (rvfcId !== null && video.cancelVideoFrameCallback) {
        try {
          video.cancelVideoFrameCallback(rvfcId);
        } catch {
          // ignore
        }
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };

    const finish = (mediaTime: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(mediaTime);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    // Watchdog ensures playback stalls never hang the frame loop
    const watchdog = window.setTimeout(() => {
      finish(video.currentTime);
    }, 120);

    if (typeof video.requestVideoFrameCallback === 'function') {
      rvfcId = video.requestVideoFrameCallback((_now, meta) => {
        finish(Number.isFinite(meta?.mediaTime) ? meta.mediaTime : video.currentTime);
      });
    } else {
      rafId = window.requestAnimationFrame(() => {
        finish(video.currentTime);
      });
    }
  });
}

/**
 * Fast Single-Pass Continuous GPU Pipeline:
 * - Zero frame-by-frame `video.currentTime` seek loops!
 * - Streams continuous hardware-decoded frames via `requestVideoFrameCallback`
 *   into the background WebGL2 + WebCodecs Web Worker (`prefer-hardware`, `mp4-muxer`).
 * - Strictly <= 1 frame in memory at any instant (`bitmap.close()` + `videoFrame.close()`).
 */
async function renderSinglePassWebCodecsWorker(
  opts: GpuRenderOptions,
  profile: DeviceRenderProfile
): Promise<RenderedHardwareMp4> {
  const {
    source,
    clip,
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

  const lockedDurationSec = clip.lockedVisualDurationSec;
  const totalFrames = Math.max(
    profile.fps * 3,
    Math.round(lockedDurationSec * profile.fps)
  );
  const intervals =
    clip.usableIntervals.length > 0
      ? clip.usableIntervals
      : [{ startSec: clip.trimRange.startSec, endSec: clip.trimRange.endSec }];

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

  const videoUrl = URL.createObjectURL(source.blob);
  const video = document.createElement('video') as VideoWithRVFC;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  const worker = new Worker(new URL('./renderWorker.ts', import.meta.url), {
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

    const srcW = video.videoWidth || source.width || 1080;
    const srcH = video.videoHeight || source.height || 1920;

    let pendingResolve: ((data: Record<string, unknown>) => void) | null = null;
    let pendingReject: ((err: Error) => void) | null = null;

    worker.onmessage = (ev: MessageEvent<Record<string, unknown>>) => {
      const data = ev.data;
      if (data.type === 'error') {
        const err = new Error(String(data.message || 'renderWorker error'));
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
      const err = new Error(ev.message || 'renderWorker crashed');
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
                `Unexpected worker reply "${String(
                  data.type
                )}" (expected "${expectedType}")`
              )
            );
          }
        };
        pendingReject = reject;
      });

    const actionSummary = describeSurgicalAction(clip);
    onStatus(
      `${actionSummary} (${profile.width}×${profile.height} @ ${profile.fps}fps · locked ${lockedDurationSec.toFixed(
        1
      )}s)...`
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
        durationSec: lockedDurationSec,
        scriptText,
        beats,
        language,
        safeCropInsets: clip.safeCropInsets,
        watermarkZones: clip.watermarkZones,
        climaxSecond: clip.climaxSec,
        portraitBitmap,
        pcmMono: pcmCopy,
        sampleRate: audio.sampleRate,
        amplitudeEnvelope: ampCopy,
        mouthOpenEnvelope: mouthCopy,
        envelopeFps: audio.envelopeFps,
      },
      initTransfer
    );
    portraitBitmap = null;

    const readyData = await readyPromise;
    delogoCount = Number(readyData.delogoCount ?? 0);
    const hwAccel = String(readyData.hardwareAcceleration ?? 'prefer-hardware');
    activeCodecLabel =
      hwAccel === 'prefer-hardware'
        ? `Single-Pass Hardware GPU (${profile.width}×${profile.height} @ ${profile.fps}fps)`
        : `Single-Pass WebGL2 (${profile.width}×${profile.height} @ ${profile.fps}fps)`;
    onProgressPct(12);

    // Continuous playback capture across usable intervals (ZERO frame-by-frame seeking!)
    let intervalIdx = 0;
    let priorDurationSec = 0;
    let currentInterval = intervals[0];
    await seekOnceForIntervalStart(video, currentInterval.startSec, signal);
    video.playbackRate = profile.playbackRate;

    let continuousPlayActive = true;
    try {
      await video.play();
    } catch {
      continuousPlayActive = false;
    }

    let frameIndex = 0;
    const frameStepSec = 1 / profile.fps;
    let lastMediaTime = currentInterval.startSec;
    let stallTicks = 0;

    while (frameIndex < totalFrames) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const targetClipTimeSec = frameIndex * frameStepSec;
      let mediaTime = video.currentTime;

      if (continuousPlayActive) {
        mediaTime = await waitNextDecodedVideoFrame(video, signal);

        // If playback reached the end of current usable interval (skipping any trim_bumper), jump ONCE to next
        if (mediaTime >= currentInterval.endSec - 0.03 || video.ended) {
          priorDurationSec += Math.max(
            0.2,
            currentInterval.endSec - currentInterval.startSec
          );
          intervalIdx = (intervalIdx + 1) % intervals.length;
          currentInterval = intervals[intervalIdx];
          video.pause();
          await seekOnceForIntervalStart(video, currentInterval.startSec, signal);
          video.playbackRate = profile.playbackRate;
          await video.play().catch(() => {
            continuousPlayActive = false;
          });
          mediaTime = currentInterval.startSec;
          lastMediaTime = mediaTime;
          stallTicks = 0;
        }

        // Detect stalled media clock and step gently without hanging
        if (Math.abs(mediaTime - lastMediaTime) < 0.002) {
          stallTicks++;
          if (stallTicks > 8) {
            const nextSec = Math.min(
              currentInterval.endSec - 0.04,
              mediaTime + frameStepSec
            );
            await seekOnceForIntervalStart(video, nextSec, signal);
            mediaTime = nextSec;
            stallTicks = 0;
          }
        } else {
          stallTicks = 0;
        }
        lastMediaTime = mediaTime;
      } else {
        // Fallback only if browser policy blocked muted video.play()
        const relInClip = targetClipTimeSec;
        let rem = relInClip;
        let chosen = intervals[0];
        for (const iv of intervals) {
          const len = Math.max(0.2, iv.endSec - iv.startSec);
          if (rem <= len) {
            chosen = iv;
            break;
          }
          rem -= len;
        }
        const seekSec = Math.min(chosen.endSec - 0.04, chosen.startSec + rem);
        await seekOnceForIntervalStart(video, seekSec, signal);
        mediaTime = seekSec;
      }

      const elapsedInClipSec =
        priorDurationSec + Math.max(0, mediaTime - currentInterval.startSec);

      // Wait until continuous hardware playback advances to the next target CFR frame
      if (continuousPlayActive && elapsedInClipSec + 0.004 < targetClipTimeSec) {
        continue;
      }

      // Emit 1..2 CFR frames if playback advanced slightly faster than worker round-trip
      // while pausing briefly on backpressure to guarantee smooth 0-drop motion
      const framesToEmit = continuousPlayActive
        ? Math.max(
            1,
            Math.min(
              2,
              Math.floor((elapsedInClipSec - targetClipTimeSec) / frameStepSec) + 1
            )
          )
        : 1;

      if (continuousPlayActive && framesToEmit > 1) {
        video.pause();
      }

      for (let k = 0; k < framesToEmit && frameIndex < totalFrames; k++) {
        const emitTimeSec = frameIndex * frameStepSec;
        const frameBitmap = await createImageBitmap(video);
        const frameAck = awaitWorkerReply('frame_done');
        worker.postMessage(
          {
            type: 'frame',
            frameIndex,
            timeSec: emitTimeSec,
            sourceTimeSec: mediaTime,
            bitmap: frameBitmap,
            sourceWidth: srcW,
            sourceHeight: srcH,
          },
          [frameBitmap]
        );
        await frameAck;
        frameIndex++;

        if (frameIndex % 12 === 0 || frameIndex === totalFrames) {
          onProgressPct(12 + Math.round((frameIndex / totalFrames) * 82));
          if (frameIndex % 36 === 0) {
            onStatus(
              `${actionSummary} (${Math.round(
                (frameIndex / totalFrames) * 100
              )}% · ${frameIndex}/${totalFrames} frames)...`
            );
          }
        }
      }

      if (continuousPlayActive && video.paused && frameIndex < totalFrames) {
        video.playbackRate = profile.playbackRate;
        await video.play().catch(() => {
          continuousPlayActive = false;
        });
      }
    }

    video.pause();
    onStatus('Finalizing H.264 + AAC MP4 container...');
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
      durationSec: Number(lockedDurationSec.toFixed(2)),
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      delogoCount,
      bumperTrimmedSec: clip.bumperTrimmedSec,
      safeCropApplied: clip.safeCropApplied,
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
 * STAGE 3B ENTRYPOINT — Fast Single-Pass GPU Mux:
 * Locks MP4 output strictly to `clip.lockedVisualDurationSec` (built in Stage 1),
 * streams decoded frames continuously via `requestVideoFrameCallback` into WebGL2 + WebCodecs
 * Worker (`prefer-hardware`), and lazy-loads FFmpeg.wasm ONLY if WebCodecs is unavailable.
 */
export async function renderProductionMp4Gpu(
  opts: GpuRenderOptions
): Promise<RenderedHardwareMp4> {
  const profile = detectDeviceRenderProfile();

  if (supportsWebCodecsWorkerPipeline()) {
    try {
      return await renderSinglePassWebCodecsWorker(opts, profile);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      opts.onStatus(
        'WebCodecs hardware pass unavailable — lazy-loading FFmpeg.wasm fallback...'
      );
    }
  }

  const { renderWithLazyFFmpegFallback } = await import('./ffmpegFallback');
  return renderWithLazyFFmpegFallback({
    sourceVideoBlob: opts.source.blob,
    sourceWidth: opts.source.width,
    sourceHeight: opts.source.height,
    targetWidth: profile.width,
    targetHeight: profile.height,
    targetFps: profile.fps,
    trimRange: opts.clip.trimRange,
    safeCropInsets: opts.clip.safeCropInsets,
    watermarkZones: opts.clip.watermarkZones,
    bumperTrimmedSec: opts.clip.bumperTrimmedSec,
    lockedDurationSec: opts.clip.lockedVisualDurationSec,
    audio: opts.audio,
    scriptText: opts.scriptText,
    beats: opts.beats,
    language: opts.language,
    climaxSecond: opts.clip.climaxSec,
    characterEnabled: opts.characterEnabled,
    characterPortraitUrl: opts.characterPortraitUrl,
    onStatus: opts.onStatus,
    onProgressPct: opts.onProgressPct,
    signal: opts.signal,
  });
}
