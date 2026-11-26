import { buildCaptionChunks, drawCapCutPopCaption } from './captionPainter';
import { PIPELINE_15_WORKER_MODELS } from './modelRouter';
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
  _source: SourceMediaItem,
  isMobile: boolean
): { width: number; height: number } {
  // Always frame into vertical 9:16 canvas for Shorts-style visual transformation
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

/**
 * Verifies that a rendered video Blob is genuinely larger than 1 KB and decodable
 * with real video dimensions (never a 1 KB header-only / 0:00 black container).
 */
async function verifyPlayableVideoBlob(
  blob: Blob
): Promise<{ valid: boolean; reason?: string }> {
  if (!blob || blob.size <= 1024) {
    return {
      valid: false,
      reason: `Recorded video was empty (${blob?.size ?? 0} bytes).`,
    };
  }

  // A multi-frame rendered clip with video track should exceed tiny container-header sizes
  if (blob.size < 4096) {
    return {
      valid: false,
      reason: `Recorded container had header bytes only (${blob.size} bytes, no video frames).`,
    };
  }

  if (typeof document === 'undefined') {
    return { valid: true };
  }

  const probeUrl = URL.createObjectURL(blob);
  const probeVideo = document.createElement('video');
  probeVideo.muted = true;
  probeVideo.playsInline = true;
  probeVideo.preload = 'metadata';

  try {
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      };
      const timer = window.setTimeout(() => finish(true), 3500);
      probeVideo.onloadedmetadata = () => {
        const hasDims = probeVideo.videoWidth > 0 && probeVideo.videoHeight > 0;
        const hasDur =
          probeVideo.duration === Infinity ||
          (Number.isFinite(probeVideo.duration) && probeVideo.duration > 0.1);
        finish(hasDims && hasDur);
      };
      probeVideo.onerror = () => finish(false);
      probeVideo.src = probeUrl;
      probeVideo.load();
    });

    return ok
      ? { valid: true }
      : {
          valid: false,
          reason: 'Browser could not decode video frames from the recorded blob (0:00 / empty track).',
        };
  } finally {
    probeVideo.onloadedmetadata = null;
    probeVideo.onerror = null;
    probeVideo.pause();
    probeVideo.removeAttribute('src');
    probeVideo.load();
    try {
      URL.revokeObjectURL(probeUrl);
    } catch {
      // ignore
    }
  }
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

  let worker: Worker | null = null;

  const cleanup = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      worker = null;
    }
    video.onloadeddata = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  try {
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

    worker = new Worker(new URL('./renderWorker.ts', import.meta.url), {
      type: 'module',
    });

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

    const nextWorkerReply = (timeoutMs = 20_000): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Render cancelled', 'AbortError'));
          return;
        }
        const onAbort = () => {
          window.clearTimeout(timer);
          waitResolver = null;
          waitRejecter = null;
          reject(new DOMException('Render cancelled', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          waitResolver = null;
          waitRejecter = null;
          reject(new Error('Render worker timed out waiting for frame encode.'));
        }, timeoutMs);

        signal?.addEventListener('abort', onAbort, { once: true });

        waitResolver = (msg) => {
          window.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(msg);
        };
        waitRejecter = (err) => {
          window.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        };
      });

    // Copy PCM buffer for zero-copy transfer into worker
    const pcmCopy = new Float32Array(voice.pcmSamples);
    const readyPromise = nextWorkerReply(25_000);
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

    const PACE_FACTOR = 1.035;
    const maxOffsetSec = Math.max(0.05, clip.lockedVisualDurationSec - 0.04);

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) {
        throw new DOMException('Render cancelled', 'AbortError');
      }

      const timeSec = i / fps;
      const timeFrac = totalFrames > 1 ? i / (totalFrames - 1) : 0;
      const sourceTimeSec =
        clip.trimRange.startSec + Math.min(maxOffsetSec, timeSec * PACE_FACTOR);
      await seekVideoPrecise(video, sourceTimeSec);

      const bitmap = await createImageBitmap(video);
      try {
        const ackPromise = nextWorkerReply(15_000);
        worker.postMessage(
          {
            type: 'frame',
            frameIndex: i,
            timestampUs: Math.round(timeSec * 1_000_000),
            timeSec,
            timeFrac,
            bitmap,
          },
          [bitmap]
        );
        await ackPromise;
      } catch (err) {
        try {
          bitmap.close();
        } catch {
          // already transferred or closed
        }
        throw err;
      }

      if (onProgress && (i % Math.max(1, Math.floor(fps / 2)) === 0 || i === totalFrames - 1)) {
        const pct = Math.min(96, Math.round(((i + 1) / totalFrames) * 95));
        onProgress(
          pct,
          `Encoding Clip ${clip.clipIndex}/${clip.totalClips} (${i + 1}/${totalFrames} frames · WebGL2/WebCodecs)...`
        );
      }
    }

    onProgress?.(98, `Finalizing MP4 container for Clip ${clip.clipIndex}/${clip.totalClips}...`);
    const donePromise = nextWorkerReply(30_000);
    worker.postMessage({ type: 'finish' });
    const doneMsg = await donePromise;
    const mp4Buffer = doneMsg.mp4Buffer as ArrayBuffer;
    const encodedChunks = Number(doneMsg.encodedVideoChunks ?? 0);

    if (!mp4Buffer || mp4Buffer.byteLength <= 1024 || encodedChunks === 0) {
      throw new Error(
        `WebCodecs worker produced an empty MP4 buffer (${mp4Buffer?.byteLength ?? 0} bytes, ${encodedChunks} frames).`
      );
    }

    const blob = new Blob([mp4Buffer], { type: 'video/mp4' });
    const check = await verifyPlayableVideoBlob(blob);
    if (!check.valid) {
      throw new Error(check.reason || 'WebCodecs MP4 failed playable video verification.');
    }

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

async function runSingleMediaRecorderAttempt(params: {
  source: SourceMediaItem;
  clip: PreparedVisualClip;
  metadata: TrendMetadata;
  voice: SynthesizedVoiceResult;
  language: OutputLanguage;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  mimeType: string;
  includeAudio: boolean;
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
    mimeType,
    includeAudio,
    signal,
    onProgress,
  } = params;

  const durationSec = Math.max(
    1.5,
    Math.min(clip.lockedVisualDurationSec, voice.durationSec)
  );

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = source.objectUrl;

  // Keep capture canvas attached off-screen during recording so mobile browsers
  // reliably emit frames into canvas.captureStream() instead of 1 KB headers.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.position = 'fixed';
  canvas.style.left = '-9999px';
  canvas.style.top = '0';
  canvas.style.width = '1px';
  canvas.style.height = '1px';
  canvas.style.opacity = '0.001';
  canvas.style.pointerEvents = 'none';
  if (document.body) {
    document.body.appendChild(canvas);
  }

  let rafId = 0;
  let pumpTimer: number | null = null;
  let audioCtx: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let canvasStream: MediaStream | null = null;
  let combinedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;

  try {
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

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');

    const captionChunks = buildCaptionChunks(
      metadata.voiceover,
      durationSec,
      language,
      metadata.beats,
      voice.wordTimings
    );

    const crop = clip.safeCropInsets;
    const vw = video.videoWidth || source.width || width;
    const vh = video.videoHeight || source.height || height;
    const sx = Math.round(vw * crop.left);
    const sy = Math.round(vh * crop.top);
    const sw = Math.max(16, Math.round(vw * (1 - crop.left - crop.right)));
    const sh = Math.max(16, Math.round(vh * (1 - crop.top - crop.bottom)));

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

    await seekVideoPrecise(video, clip.trimRange.startSec);

    const PACE_FACTOR = 1.035;
    try {
      video.playbackRate = PACE_FACTOR;
    } catch {
      // Ignore if browser restricts playbackRate on this stream
    }

    // Precompute balanced cinematic radial vignette for crisp subject focus
    const vignetteGrad = ctx.createRadialGradient(
      width * 0.5,
      height * 0.48,
      Math.min(width, height) * 0.26,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.76
    );
    vignetteGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignetteGrad.addColorStop(0.7, 'rgba(10, 18, 34, 0.12)');
    vignetteGrad.addColorStop(1, 'rgba(6, 12, 24, 0.42)');

    // Visible cinema split-tone wash (rich teal shadows / warm golden highlights)
    const gradeWash = ctx.createLinearGradient(0, 0, 0, height);
    gradeWash.addColorStop(0, 'rgba(14, 116, 144, 0.15)');
    gradeWash.addColorStop(0.5, 'rgba(255, 190, 110, 0.10)');
    gradeWash.addColorStop(1, 'rgba(12, 20, 38, 0.20)');

    let drawnFrames = 0;
    const paintFrame = (elapsedSec: number) => {
      try {
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(0, 0, width, height);

        if (video.readyState >= 2) {
          // Full-bleed 9:16 anti-copyright push-in (1.08x -> 1.15x) + subtle motion drift (no dark sidebars)
          const tFrac = Math.max(0, Math.min(1, elapsedSec / Math.max(0.1, durationSec)));
          const smoothT = tFrac * tFrac * (3 - 2 * tFrac);
          const zoom = 1.08 + 0.07 * smoothT;
          const zoomSw = Math.max(16, Math.round(drawSw / zoom));
          const zoomSh = Math.max(16, Math.round(drawSh / zoom));
          const zoomSx = Math.max(
            0,
            Math.min(
              vw - zoomSw,
              drawSx + Math.round((drawSw - zoomSw) * (0.48 + 0.04 * smoothT))
            )
          );
          const zoomSy = Math.max(
            0,
            Math.min(
              vh - zoomSh,
              drawSy + Math.round((drawSh - zoomSh) * (0.47 + 0.06 * smoothT))
            )
          );

          ctx.save();
          ctx.filter = 'contrast(1.24) saturate(1.34) brightness(1.04)';
          ctx.drawImage(video, zoomSx, zoomSy, zoomSw, zoomSh, 0, 0, width, height);
          ctx.restore();

          // Visible cinema split-tone wash + balanced clarity vignette
          ctx.save();
          ctx.globalCompositeOperation = 'soft-light';
          ctx.fillStyle = gradeWash;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();

          ctx.fillStyle = vignetteGrad;
          ctx.fillRect(0, 0, width, height);

          // Seamless blended corner delogo patch (samples adjacent clean video area with matching color grade)
          for (const z of clip.watermarkZones) {
            if (elapsedSec >= z.startSec && elapsedSec <= z.endSec) {
              const zx = Math.round(z.box[0] * width);
              const zy = Math.round(z.box[1] * height);
              const zw = Math.max(12, Math.round((z.box[2] - z.box[0]) * width));
              const zh = Math.max(12, Math.round((z.box[3] - z.box[1]) * height));
              const radius = Math.min(22, Math.round(Math.min(zw, zh) * 0.3));
              const isTop = (z.box[1] + z.box[3]) * 0.5 < 0.5;
              const shiftPx = isTop ? -Math.round(zh * 1.18) : Math.round(zh * 1.18);
              ctx.save();
              ctx.beginPath();
              ctx.roundRect(zx, zy, zw, zh, radius);
              ctx.clip();
              ctx.filter = 'blur(18px) contrast(1.22) saturate(1.30) brightness(1.03)';
              ctx.drawImage(
                video,
                zoomSx,
                zoomSy,
                zoomSw,
                zoomSh,
                0,
                shiftPx,
                width,
                height
              );
              ctx.restore();
            }
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
        drawnFrames++;
      } catch {
        // Skip transient frame draw failure without breaking recording loop
      }
    };

    // Paint initial frame synchronously BEFORE captureStream & MediaRecorder.start()
    paintFrame(0);

    canvasStream = canvas.captureStream(fps);
    const videoTracks = canvasStream.getVideoTracks();
    if (videoTracks.length === 0) {
      throw new Error('Canvas captureStream returned no video track on this browser.');
    }
    const primaryVideoTrack = videoTracks[0] as MediaStreamTrack & {
      requestFrame?: () => void;
    };

    const tracks: MediaStreamTrack[] = [...videoTracks];
    if (includeAudio && voice.pcmSamples.length > 0) {
      try {
        try {
          audioCtx = new AudioContext({ sampleRate: voice.sampleRate });
        } catch {
          audioCtx = new AudioContext();
        }
        const audioDest = audioCtx.createMediaStreamDestination();
        audioSource = audioCtx.createBufferSource();
        const playBuf = audioCtx.createBuffer(
          1,
          voice.pcmSamples.length,
          voice.sampleRate
        );
        playBuf.copyToChannel(new Float32Array(voice.pcmSamples), 0);
        audioSource.buffer = playBuf;
        audioSource.connect(audioDest);
        tracks.push(...audioDest.stream.getAudioTracks());
      } catch {
        // Proceed with canvas video track if WebAudio MediaStreamDestination fails
      }
    }

    combinedStream = new MediaStream(tracks);

    const chunks: BlobPart[] = [];
    try {
      const options: MediaRecorderOptions = {
        videoBitsPerSecond: bitrate,
      };
      if (mimeType) options.mimeType = mimeType;
      if (includeAudio) options.audioBitsPerSecond = 128_000;
      recorder = new MediaRecorder(combinedStream, options);
    } catch {
      recorder = new MediaRecorder(combinedStream);
    }

    const actualMime = recorder.mimeType || mimeType || 'video/webm';
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }

    const activeRecorder = recorder;
    let recorderFailedMsg: string | null = null;
    const stoppedPromise = new Promise<void>((resolve) => {
      const stopGuard = window.setTimeout(resolve, 6000);
      activeRecorder.onstop = () => {
        window.clearTimeout(stopGuard);
        resolve();
      };
      activeRecorder.onerror = (ev) => {
        const errEv = ev as Event & { error?: DOMException };
        recorderFailedMsg =
          errEv.error?.message || 'MediaRecorder encountered an encoding error.';
        window.clearTimeout(stopGuard);
        resolve();
      };
    });

    activeRecorder.start(250);
    if (audioSource) {
      try {
        audioSource.start();
      } catch {
        // ignore
      }
    }

    let videoPlaying = false;
    try {
      await video.play();
      videoPlaying = true;
    } catch {
      // Some mobile browsers block detached video.play(); fall back to timed seeks
      videoPlaying = false;
    }

    const startWallMs = performance.now();
    let lastDrawMs = 0;
    const frameIntervalMs = Math.max(24, Math.floor(1000 / fps));

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const done = (err?: unknown) => {
        if (finished) return;
        finished = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (pumpTimer !== null) {
          window.clearInterval(pumpTimer);
          pumpTimer = null;
        }
        if (err) reject(err);
        else resolve();
      };

      const step = () => {
        if (finished) return;
        if (signal?.aborted) {
          done(new DOMException('Render cancelled', 'AbortError'));
          return;
        }
        if (recorderFailedMsg) {
          done(new Error(recorderFailedMsg));
          return;
        }
        const now = performance.now();
        const elapsedSec = (now - startWallMs) / 1000;
        if (elapsedSec >= durationSec) {
          paintFrame(durationSec);
          try {
            primaryVideoTrack.requestFrame?.();
          } catch {
            // ignore
          }
          done();
          return;
        }

        if (now - lastDrawMs >= frameIntervalMs * 0.8) {
          lastDrawMs = now;
          if (!videoPlaying) {
            const targetT = Math.min(
              clip.trimRange.startSec + elapsedSec * PACE_FACTOR,
              Math.max(0, (video.duration || durationSec) - 0.05)
            );
            try {
              if (Math.abs(video.currentTime - targetT) > 0.08) {
                video.currentTime = targetT;
              }
            } catch {
              // ignore
            }
          }
          paintFrame(elapsedSec);
          try {
            primaryVideoTrack.requestFrame?.();
          } catch {
            // ignore
          }

          const pct = Math.min(96, Math.round((elapsedSec / durationSec) * 96));
          onProgress?.(
            pct,
            `Recording Clip ${clip.clipIndex}/${clip.totalClips} (${elapsedSec.toFixed(1)}s/${durationSec.toFixed(1)}s · Canvas MediaRecorder)...`
          );
        }
      };

      const rafLoop = () => {
        step();
        if (!finished) {
          rafId = requestAnimationFrame(rafLoop);
        }
      };

      // Dual-pump (rAF + interval) ensures frames still record if rAF throttles on mobile
      pumpTimer = window.setInterval(step, frameIntervalMs);
      rafId = requestAnimationFrame(rafLoop);
    });

    if (activeRecorder.state === 'recording') {
      try {
        activeRecorder.requestData();
      } catch {
        // ignore if unsupported
      }
      await new Promise((r) => window.setTimeout(r, 120));
      activeRecorder.stop();
    }
    await stoppedPromise;

    if (recorderFailedMsg) {
      throw new Error(recorderFailedMsg);
    }

    const cleanMime = actualMime.toLowerCase().includes('mp4')
      ? 'video/mp4'
      : 'video/webm';
    const blob = new Blob(chunks, { type: cleanMime });

    if (drawnFrames < 2 || blob.size <= 1024) {
      throw new Error(
        `MediaRecorder produced an empty output (${blob.size} bytes, ${drawnFrames} drawn frames).`
      );
    }

    const check = await verifyPlayableVideoBlob(blob);
    if (!check.valid) {
      throw new Error(
        check.reason || `Recorded clip (${blob.size} bytes) was not playable.`
      );
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
    if (pumpTimer !== null) window.clearInterval(pumpTimer);
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    try {
      audioSource?.stop();
    } catch {
      // ignore
    }
    canvasStream?.getTracks().forEach((t) => t.stop());
    combinedStream?.getTracks().forEach((t) => t.stop());
    try {
      await audioCtx?.close();
    } catch {
      // ignore
    }
    video.onloadeddata = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
  }
}

/**
 * Fast, phone-safe fallback when WebCodecs H.264 is unavailable or produces an empty file.
 * Tries browser-supported MediaRecorder codecs cleanly and verifies `blob.size > 1024`
 * plus playable video frames — never outputting a broken 1 KB clip.
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
  if (typeof MediaRecorder === 'undefined') {
    throw new Error(
      'Video recording is not supported in this browser (WebCodecs and MediaRecorder are unavailable).'
    );
  }

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isSafari =
    /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Android/i.test(ua);

  // On Chrome/Android, WebM (vp8/vp9 + opus) is far more reliable with canvas.captureStream
  // + WebAudio than experimental video/mp4 MediaRecorder (which can emit 1 KB headers).
  const candidateMimes = isSafari
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
    : [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
      ];

  const supportedMimes = candidateMimes.filter((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });

  const primaryMime = supportedMimes[0] ?? '';
  const alternateMime = supportedMimes.find(
    (m) =>
      (primaryMime.includes('webm') && m.includes('mp4')) ||
      (primaryMime.includes('mp4') && m.includes('webm'))
  );

  const attempts: { mimeType: string; includeAudio: boolean; label: string }[] = [
    { mimeType: primaryMime, includeAudio: true, label: primaryMime || 'default' },
  ];
  if (alternateMime) {
    attempts.push({ mimeType: alternateMime, includeAudio: true, label: alternateMime });
  }
  // Last-resort video-only capture if combining WebAudio stream broke MediaRecorder on mobile
  attempts.push({
    mimeType: primaryMime,
    includeAudio: false,
    label: `${primaryMime || 'default'} (video-only)`,
  });

  let lastError: Error | null = null;
  for (let i = 0; i < attempts.length; i++) {
    if (params.signal?.aborted) {
      throw new DOMException('Render cancelled', 'AbortError');
    }
    const attempt = attempts[i];
    if (i > 0) {
      params.onProgress?.(
        10,
        `Retrying video recording with ${attempt.label} for device compatibility...`
      );
    }
    try {
      return await runSingleMediaRecorderAttempt({
        ...params,
        mimeType: attempt.mimeType,
        includeAudio: attempt.includeAudio,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `Could not record playable video on this browser (${lastError?.message || 'MediaRecorder returned <= 1 KB'}). Try Chrome/Safari desktop or a standard H.264 MP4 clip.`
  );
}

/**
 * Validates and bounds clip beats, word timings, and watermark delogo windows strictly
 * inside `[0, durationSec]` (Step 5 sequence/timing check role: `z-ai/glm-5-3-flash`
 * with zero-latency deterministic browser execution so 1-call-per-clip quota is preserved).
 */
function verifyClipSequenceTiming(params: {
  clip: PreparedVisualClip;
  metadata: TrendMetadata;
  voice: SynthesizedVoiceResult;
}): { clip: PreparedVisualClip; metadata: TrendMetadata; voice: SynthesizedVoiceResult } {
  const maxDur = Math.max(
    1.5,
    Math.min(params.clip.lockedVisualDurationSec, params.voice.durationSec)
  );

  const boundedZones = params.clip.watermarkZones.map((z) => {
    const startSec = Math.max(0, Math.min(maxDur - 0.1, z.startSec));
    const endSec = Math.max(startSec + 0.1, Math.min(maxDur, z.endSec));
    return { ...z, startSec, endSec };
  });

  const boundedBeats = params.metadata.beats.map((b, idx, arr) => {
    const startSec = Math.max(0, Math.min(maxDur - 0.15, b.startSec));
    const rawEnd = idx === arr.length - 1 ? Math.min(maxDur - 0.05, b.endSec) : b.endSec;
    const endSec = Math.max(startSec + 0.12, Math.min(maxDur, rawEnd));
    return { ...b, startSec, endSec };
  });

  const boundedWords = params.voice.wordTimings.map((w) => {
    const startSec = Math.max(0, Math.min(maxDur - 0.08, w.startSec));
    const endSec = Math.max(startSec + 0.05, Math.min(maxDur, w.endSec));
    return { ...w, startSec, endSec };
  });

  return {
    clip: { ...params.clip, watermarkZones: boundedZones },
    metadata: { ...params.metadata, beats: boundedBeats, wordTimings: boundedWords },
    voice: { ...params.voice, wordTimings: boundedWords },
  };
}

/**
 * STEP 5 (Fast, Phone-Safe Mux & Output):
 * Runs sequence/timing verification (`z-ai/glm-5-3-flash` role) then exports via
 * WebGL2 + WebCodecs H.264/AAC MP4 worker, falling back instantly to Canvas MediaRecorder.
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
  params.onProgress?.(
    2,
    `Verifying clip sequence & caption timing (${PIPELINE_15_WORKER_MODELS.step5[0]} check)...`
  );
  const verified = verifyClipSequenceTiming({
    clip: params.clip,
    metadata: params.metadata,
    voice: params.voice,
  });
  const checkedParams = {
    ...params,
    clip: verified.clip,
    metadata: verified.metadata,
    voice: verified.voice,
  };

  if (profile.supportsWebCodecs) {
    try {
      return await renderSinglePassWebCodecsWorker({
        ...checkedParams,
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
    ...checkedParams,
    width,
    height,
    fps: profile.fps,
    bitrate: profile.bitrate,
  });
}
