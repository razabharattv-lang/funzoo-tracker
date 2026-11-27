import { buildCaptionChunks, drawCapCutPopCaption } from './captionPainter';
import { PIPELINE_15_WORKER_MODELS } from './modelRouter';
import type {
  OutputLanguage,
  PacingBeat,
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

function evaluatePacingTransform(
  pacingBeats: PacingBeat[] | undefined,
  elapsedSec: number,
  durationSec: number
): { zoom: number; panX: number; panY: number; transitionPulse: number } {
  const safeDur = Math.max(0.1, durationSec);
  const tFrac = Math.max(0, Math.min(1, elapsedSec / safeDur));
  const smoothGlobal = tFrac * tFrac * (3 - 2 * tFrac);

  if (!pacingBeats || pacingBeats.length === 0) {
    return {
      zoom: 1.04 + 0.06 * smoothGlobal,
      panX: (smoothGlobal - 0.5) * 0.01,
      panY: (smoothGlobal - 0.5) * 0.012,
      transitionPulse: 0,
    };
  }

  let activeIdx = pacingBeats.length - 1;
  for (let i = 0; i < pacingBeats.length; i++) {
    const b = pacingBeats[i];
    if (elapsedSec >= b.startSec && (elapsedSec < b.endSec || i === pacingBeats.length - 1)) {
      activeIdx = i;
      break;
    }
  }
  const active = pacingBeats[activeIdx];
  const prevBeat = activeIdx > 0 ? pacingBeats[activeIdx - 1] : null;

  const span = Math.max(0.25, active.endSec - active.startSec);
  const localT = Math.max(0, Math.min(1, (elapsedSec - active.startSec) / span));
  // Punchy ease-out for hook/twist beats; silky Hermite S-curve for steady explanation beats
  const eased =
    active.kind === 'hook_impact' || active.kind === 'twist_transition'
      ? 1 - Math.pow(1 - localT, 3)
      : localT * localT * (3 - 2 * localT);
  const timeSinceStart = Math.max(0, elapsedSec - active.startSec);

  // Subtle speech/beat-synced cut & zoom accents without clipping subject headroom
  let cutAccent = 0;
  if (active.kind === 'jump_trim_pause' && localT >= 0.45) {
    cutAccent = 0.024;
  } else if (active.kind === 'hook_impact' && timeSinceStart < 0.24) {
    cutAccent = (1 - timeSinceStart / 0.24) * 0.026;
  } else if (active.kind === 'twist_transition' && timeSinceStart < 0.22) {
    cutAccent = (1 - timeSinceStart / 0.22) * 0.028;
  } else if (active.kind === 'clean_cut' && timeSinceStart < 0.16) {
    cutAccent = (1 - timeSinceStart / 0.16) * 0.016;
  }

  let zoom = active.zoomFrom + (active.zoomTo - active.zoomFrom) * eased + cutAccent;
  let panX = active.panX * (eased * 2 - 1);
  let panY = active.panY * (eased * 2 - 1);

  // Smooth 0.18s visual continuity bridge across connected scenes (prevents framing teleport on beat boundaries)
  if (prevBeat && timeSinceStart < 0.18 && active.kind !== 'jump_trim_pause') {
    const blendRaw = timeSinceStart / 0.18;
    const blend = blendRaw * blendRaw * (3 - 2 * blendRaw);
    const prevEndZoom = prevBeat.zoomTo;
    const prevEndPanX = prevBeat.panX;
    const prevEndPanY = prevBeat.panY;
    zoom = prevEndZoom + (zoom - prevEndZoom) * blend;
    panX = prevEndPanX + (panX - prevEndPanX) * blend;
    panY = prevEndPanY + (panY - prevEndPanY) * blend;
  }

  zoom = Math.max(1.03, Math.min(1.14, zoom));
  panX = Math.max(-0.009, Math.min(0.009, panX));
  panY = Math.max(-0.007, Math.min(0.006, panY));

  const pulseWindow =
    active.kind === 'twist_transition' ||
    active.kind === 'hook_impact' ||
    active.kind === 'payoff_reveal'
      ? 0.2
      : 0.11;
  const transitionPulse =
    active.transitionFlash > 0 && timeSinceStart < pulseWindow
      ? active.transitionFlash * (1 - timeSinceStart / pulseWindow)
      : 0;

  return { zoom, panX, panY, transitionPulse };
}

function ensureAudiblePcmBuffer(
  pcmSamples: Float32Array,
  sampleRate: number,
  durationSec: number
): Float32Array {
  const safeRate = Math.max(8000, Math.round(sampleRate || 48000));
  const targetLen = Math.max(
    pcmSamples.length,
    Math.ceil(Math.max(1.5, durationSec) * safeRate)
  );
  const out = new Float32Array(targetLen);
  if (pcmSamples.length > 0) {
    out.set(pcmSamples.subarray(0, targetLen), 0);
  }

  let peak = 0;
  for (let i = 0; i < out.length; i += 8) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }

  // If upstream voice track is completely silent, synthesize a subtle audible cinema bed
  if (peak < 0.002) {
    const fadeLen = Math.min(Math.floor(safeRate * 0.12), Math.floor(targetLen / 4));
    for (let i = 0; i < targetLen; i++) {
      const t = i / safeRate;
      const swell = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.45 * t);
      let sample =
        (Math.sin(2 * Math.PI * 110 * t) * 0.085 +
          Math.sin(2 * Math.PI * 164.81 * t) * 0.05 +
          Math.sin(2 * Math.PI * 220 * t) * 0.022) *
        swell;
      if (i < fadeLen) sample *= i / Math.max(1, fadeLen);
      else if (i > targetLen - fadeLen) sample *= (targetLen - i) / Math.max(1, fadeLen);
      out[i] = sample;
    }
  }
  return out;
}

function formatVideoDecodeError(
  video: HTMLVideoElement,
  sourceLabel: string,
  stage: string
): string {
  const code = video.error?.code;
  const mediaReason =
    video.error?.message ||
    (code === 3
      ? 'MEDIA_ERR_DECODE (corrupted or unsupported video stream)'
      : code === 4
      ? 'MEDIA_ERR_SRC_NOT_SUPPORTED (unsupported codec/container)'
      : 'browser could not decode video frames');
  return `${stage}: Failed to decode "${sourceLabel}" — ${mediaReason}. Try re-exporting as standard H.264 MP4.`;
}

async function loadVideoElementForRender(
  video: HTMLVideoElement,
  sourceLabel: string,
  stage: string,
  timeoutMs = 45000
): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadeddata = null;
      video.oncanplay = null;
      video.onerror = null;
      if (err) reject(err);
      else resolve();
    };
    const timer = window.setTimeout(
      () =>
        finish(
          new Error(
            `${stage}: Timed out waiting for decodable frames from "${sourceLabel}".`
          )
        ),
      timeoutMs
    );
    const onReady = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        finish();
      }
    };
    video.onloadeddata = onReady;
    video.oncanplay = onReady;
    video.onerror = () =>
      finish(new Error(formatVideoDecodeError(video, sourceLabel, stage)));
    video.load();
  });
}

async function waitForVideoFrameReady(
  video: HTMLVideoElement,
  timeoutMs = 3500
): Promise<boolean> {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('seeked', onReady);
      resolve(ok);
    };
    const onReady = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        finish(true);
      }
    };
    const timer = window.setTimeout(
      () => finish(video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0),
      timeoutMs
    );
    const poll = window.setInterval(onReady, 40);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('seeked', onReady);
  });
}

async function waitUntilTabVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVis);
      signal?.removeEventListener('abort', onAbort);
    };
    const onVis = () => {
      if (!document.hidden) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Render cancelled', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    document.addEventListener('visibilitychange', onVis);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function seekVideoPrecise(
  video: HTMLVideoElement,
  targetSec: number
): Promise<void> {
  const clamped = Math.max(
    0,
    Math.min(targetSec, Math.max(0, (video.duration || targetSec + 0.1) - 0.04))
  );
  if (
    Math.abs(video.currentTime - clamped) < 0.008 &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => {
      video.onseeked = null;
      resolve();
    };
    const timer = window.setTimeout(done, 4500);
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

  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    await waitForVideoFrameReady(video, 3500);
  }
}

/**
 * Verifies that a rendered video Blob is genuinely larger than 1 KB and decodable
 * with real video dimensions (never a 1 KB header-only / 0:00 black container).
 */
async function verifyPlayableVideoBlob(
  blob: Blob,
  expectedDurationSec = 0
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
    const check = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      };
      const timer = window.setTimeout(() => finish({ ok: true }), 15000);
      probeVideo.onloadedmetadata = () => {
        const hasDims = probeVideo.videoWidth > 0 && probeVideo.videoHeight > 0;
        if (!hasDims) {
          finish({
            ok: false,
            reason: 'Browser could not decode video frames from the recorded blob (0x0 track).',
          });
          return;
        }
        const rawDur = probeVideo.duration;
        if (rawDur === Infinity) {
          finish({ ok: true });
          return;
        }
        const minAcceptableDur =
          expectedDurationSec > 2.5
            ? Math.max(1.2, expectedDurationSec * 0.72)
            : 0.4;
        if (!Number.isFinite(rawDur) || rawDur < minAcceptableDur) {
          finish({
            ok: false,
            reason: `Recorded clip duration was truncated (${Number.isFinite(rawDur) ? rawDur.toFixed(1) : '0.0'}s vs expected ${expectedDurationSec.toFixed(1)}s).`,
          });
          return;
        }
        finish({ ok: true });
      };
      probeVideo.onerror = () =>
        finish({
          ok: false,
          reason: 'Browser could not decode video frames from the recorded blob (0:00 / empty track).',
        });
      probeVideo.src = probeUrl;
      probeVideo.load();
    });

    return check.ok
      ? { valid: true }
      : {
          valid: false,
          reason:
            check.reason ||
            'Browser could not decode video frames from the recorded blob (0:00 / empty track).',
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

  // Preserve full trimmed clip duration — never truncate a 15s clip down to shorter audio
  const durationSec = Math.max(1.5, clip.lockedVisualDurationSec);
  const totalFrames = Math.max(1, Math.round(durationSec * fps));

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';
  video.style.pointerEvents = 'none';
  if (document.body) {
    document.body.appendChild(video);
  }
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
    if (video.parentNode) {
      video.parentNode.removeChild(video);
    }
  };

  try {
    await loadVideoElementForRender(video, source.label, 'Step 5 WebCodecs');
    await waitForVideoFrameReady(video, 3500);
    if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error(formatVideoDecodeError(video, source.label, 'Step 5 WebCodecs'));
    }

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

    // Guarantee full-duration audible PCM buffer so exported MP4 always carries playable audio
    const pcmCopy = ensureAudiblePcmBuffer(
      voice.pcmSamples,
      voice.sampleRate,
      durationSec
    );
    const initTimeoutMs = Math.max(60_000, Math.round(durationSec * 1500));
    const readyPromise = nextWorkerReply(initTimeoutMs);
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
        bumperTrimmedSec: clip.bumperTrimmedSec,
        sampleRate: voice.sampleRate,
        pcmSamples: pcmCopy.buffer,
      },
      [pcmCopy.buffer]
    );
    await readyPromise;

    const PACE_FACTOR = 1.0;
    const maxOffsetSec = Math.max(0.05, clip.lockedVisualDurationSec - 0.04);

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) {
        throw new DOMException('Render cancelled', 'AbortError');
      }

      if (typeof document !== 'undefined' && document.hidden) {
        onProgress?.(
          Math.min(96, Math.round(((i + 1) / totalFrames) * 95)),
          `Paused in background (Clip ${clip.clipIndex}/${clip.totalClips}) — will resume automatically when tab returns...`
        );
        await waitUntilTabVisible(signal);
      }

      const timeSec = i / fps;
      const timeFrac = totalFrames > 1 ? i / (totalFrames - 1) : 0;
      const sourceTimeSec =
        clip.trimRange.startSec + Math.min(maxOffsetSec, timeSec * PACE_FACTOR);
      await seekVideoPrecise(video, sourceTimeSec);
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        if (typeof document !== 'undefined' && document.hidden) {
          onProgress?.(
            Math.min(96, Math.round(((i + 1) / totalFrames) * 95)),
            `Paused in background (Clip ${clip.clipIndex}/${clip.totalClips}) — will resume automatically when tab returns...`
          );
          await waitUntilTabVisible(signal);
          await seekVideoPrecise(video, sourceTimeSec);
        } else {
          await waitForVideoFrameReady(video, 3500);
          if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
            await seekVideoPrecise(video, Math.max(0, sourceTimeSec - 0.04));
            await waitForVideoFrameReady(video, 3000);
          }
        }
      }
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw new Error(formatVideoDecodeError(video, source.label, 'Step 5 WebCodecs'));
      }

      const bitmap = await createImageBitmap(video);
      const pacing = evaluatePacingTransform(clip.pacingBeats, timeSec, durationSec);
      try {
        const ackPromise = nextWorkerReply(45_000);
        worker.postMessage(
          {
            type: 'frame',
            frameIndex: i,
            timestampUs: Math.round(timeSec * 1_000_000),
            timeSec,
            timeFrac,
            zoom: pacing.zoom,
            panX: pacing.panX,
            panY: pacing.panY,
            transitionPulse: pacing.transitionPulse,
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
    const finishTimeoutMs = Math.max(120_000, Math.round(durationSec * 2500));
    const donePromise = nextWorkerReply(finishTimeoutMs);
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
    const check = await verifyPlayableVideoBlob(blob, durationSec);
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

  // Preserve full trimmed clip duration — never truncate a 15s clip down to shorter audio
  const durationSec = Math.max(1.5, clip.lockedVisualDurationSec);

  // Attach hidden off-screen video element so mobile browsers decode real hardware frames
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.001';
  video.style.pointerEvents = 'none';
  if (document.body) {
    document.body.appendChild(video);
  }
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
    await loadVideoElementForRender(video, source.label, 'Step 5 Canvas Render');

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
      // Upper-center headroom anchor (0.44) keeps faces centered well above lower captions
      drawSy = sy + Math.round((sh - drawSh) * 0.44);
    }

    await seekVideoPrecise(video, clip.trimRange.startSec);
    const frameReady = await waitForVideoFrameReady(video, 3500);
    if (!frameReady || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('Source video frames were not ready for canvas recording.');
    }

    const PACE_FACTOR = 1.0;
    try {
      video.playbackRate = PACE_FACTOR;
    } catch {
      // Ignore if browser restricts playbackRate on this stream
    }

    // Precompute balanced cinematic radial vignette for crisp subject focus
    const vignetteGrad = ctx.createRadialGradient(
      width * 0.5,
      height * 0.46,
      Math.min(width, height) * 0.28,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.78
    );
    vignetteGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignetteGrad.addColorStop(0.72, 'rgba(10, 16, 28, 0.09)');
    vignetteGrad.addColorStop(1, 'rgba(6, 11, 22, 0.34)');

    // Unified natural-skin brilliance & clean shadow wash (zero harsh color cast)
    const gradeWash = ctx.createLinearGradient(0, 0, 0, height);
    gradeWash.addColorStop(0, 'rgba(255, 250, 242, 0.045)');
    gradeWash.addColorStop(0.5, 'rgba(255, 248, 238, 0.035)');
    gradeWash.addColorStop(1, 'rgba(10, 16, 28, 0.09)');

    // Fast tiny scratch canvas for hardware-safe frosted corner delogo patching (<0.2ms/zone
    // instead of full-canvas CPU blur(16px) which throttles MediaRecorder to ~3fps / 2s clips)
    const delogoScratch = document.createElement('canvas');
    delogoScratch.width = 40;
    delogoScratch.height = 24;
    const delogoCtx = delogoScratch.getContext('2d', { alpha: false });

    let drawnRealVideoFrames = 0;
    const paintFrame = (elapsedSec: number) => {
      try {
        const hasValidFrame =
          video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;

        if (!hasValidFrame) {
          // Never overwrite an already-painted real video frame with a black rectangle during seeks
          if (drawnRealVideoFrames === 0) {
            ctx.fillStyle = '#0F172A';
            ctx.fillRect(0, 0, width, height);
          }
          return;
        }

        // Full-bleed 9:16 multi-beat pacing motion keeping subject/face centered with protected headroom
        const pacing = evaluatePacingTransform(clip.pacingBeats, elapsedSec, durationSec);
        const zoom = Math.min(1.14, pacing.zoom);
        const zoomSw = Math.max(16, Math.round(drawSw / zoom));
        const zoomSh = Math.max(16, Math.round(drawSh / zoom));
        const panShiftX = Math.round(drawSw * Math.max(-0.01, Math.min(0.01, pacing.panX)));
        const panShiftY = Math.round(drawSh * Math.max(-0.008, Math.min(0.006, pacing.panY)));
        const zoomSx = Math.max(
          0,
          Math.min(
            vw - zoomSw,
            drawSx + Math.round((drawSw - zoomSw) * 0.5) + panShiftX
          )
        );
        const zoomSy = Math.max(
          0,
          Math.min(
            vh - zoomSh,
            drawSy + Math.round((drawSh - zoomSh) * 0.45) + panShiftY
          )
        );

        // Reset canvas state and clear previous frame/captions cleanly before painting fresh frame
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.clearRect(0, 0, width, height);

        const dynContrast = (1.12 + pacing.transitionPulse * 0.28).toFixed(3);
        const dynSaturate = (1.14 + pacing.transitionPulse * 0.14).toFixed(3);
        const dynBright = (1.035 + pacing.transitionPulse * 0.045).toFixed(3);

        ctx.save();
        ctx.filter = `contrast(${dynContrast}) saturate(${dynSaturate}) brightness(${dynBright})`;
        ctx.drawImage(video, zoomSx, zoomSy, zoomSw, zoomSh, 0, 0, width, height);
        ctx.restore();

        // Unified natural-skin brilliance wash + balanced clarity vignette
        ctx.save();
        ctx.globalCompositeOperation = 'soft-light';
        ctx.fillStyle = gradeWash;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();

        ctx.fillStyle = vignetteGrad;
        ctx.fillRect(0, 0, width, height);

        if (pacing.transitionPulse > 0.03) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(pacing.transitionPulse * 0.16).toFixed(3)})`;
          ctx.fillRect(0, 0, width, height);
        }

        // Seamless blended corner delogo patch via downsampled clean-neighbor upscale (fast & Safari-safe)
        for (const z of clip.watermarkZones) {
          if (elapsedSec >= z.startSec && elapsedSec <= z.endSec) {
            const zx = Math.round(z.box[0] * width);
            const zy = Math.round(z.box[1] * height);
            const zw = Math.max(12, Math.round((z.box[2] - z.box[0]) * width));
            const zh = Math.max(12, Math.round((z.box[3] - z.box[1]) * height));
            const radius = Math.min(20, Math.round(Math.min(zw, zh) * 0.3));
            const isTop = (z.box[1] + z.box[3]) * 0.5 < 0.5;
            const srcZoneX = Math.max(
              0,
              Math.min(vw - 8, Math.round(zoomSx + z.box[0] * zoomSw))
            );
            const srcZoneW = Math.max(
              8,
              Math.min(vw - srcZoneX, Math.round((z.box[2] - z.box[0]) * zoomSw))
            );
            const srcZoneH = Math.max(8, Math.round((z.box[3] - z.box[1]) * zoomSh));
            const rawSampleY =
              zoomSy + z.box[1] * zoomSh + (isTop ? srcZoneH * 1.15 : -srcZoneH * 1.15);
            const sampleSrcY = Math.max(
              0,
              Math.min(Math.max(0, vh - srcZoneH), Math.round(rawSampleY))
            );

            ctx.save();
            ctx.beginPath();
            ctx.roundRect(zx, zy, zw, zh, radius);
            ctx.clip();
            if (delogoCtx) {
              delogoCtx.drawImage(
                video,
                srcZoneX,
                sampleSrcY,
                srcZoneW,
                Math.min(srcZoneH, vh - sampleSrcY),
                0,
                0,
                delogoScratch.width,
                delogoScratch.height
              );
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(delogoScratch, 0, 0, delogoScratch.width, delogoScratch.height, zx, zy, zw, zh);
            } else {
              ctx.fillStyle = 'rgba(12, 18, 30, 0.72)';
              ctx.fillRect(zx, zy, zw, zh);
            }
            ctx.fillStyle = 'rgba(10, 16, 28, 0.14)';
            ctx.fillRect(zx, zy, zw, zh);
            ctx.restore();
          }
        }

        // Clean, punchy outro/end-card mask finish in the final 0.40s when bumper trimming is active
        if (clip.bumperTrimmedSec > 0 && durationSec - elapsedSec < 0.4) {
          const outroProg = Math.max(
            0,
            Math.min(1, (0.4 - (durationSec - elapsedSec)) / 0.4)
          );
          const fadeAlpha = outroProg * outroProg * 0.96;
          ctx.fillStyle = `rgba(7, 11, 22, ${fadeAlpha.toFixed(3)})`;
          ctx.fillRect(0, 0, width, height);
        }

        // Paint strictly ONE crisp non-overlapping caption block with isolated canvas state
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.filter = 'none';
        drawCapCutPopCaption({
          ctx,
          chunks: captionChunks,
          timeSec: elapsedSec,
          language,
          canvasWidth: width,
          canvasHeight: height,
        });
        ctx.restore();
        drawnRealVideoFrames++;
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
    let hasAttachedAudio = false;
    if (includeAudio) {
      try {
        const audiblePcm = ensureAudiblePcmBuffer(
          voice.pcmSamples,
          voice.sampleRate,
          durationSec
        );
        audioCtx = new AudioContext();
        const targetRate = audioCtx.sampleRate || voice.sampleRate || 48000;
        const srcRate = voice.sampleRate || 48000;
        const outLen = Math.max(1, Math.round((audiblePcm.length / srcRate) * targetRate));
        const resampled = new Float32Array(outLen);
        if (srcRate === targetRate) {
          resampled.set(audiblePcm.subarray(0, outLen));
        } else {
          const ratio = srcRate / targetRate;
          for (let s = 0; s < outLen; s++) {
            const srcIdx = Math.min(audiblePcm.length - 1, Math.floor(s * ratio));
            resampled[s] = audiblePcm[srcIdx];
          }
        }
        const audioDest = audioCtx.createMediaStreamDestination();
        audioSource = audioCtx.createBufferSource();
        const playBuf = audioCtx.createBuffer(1, outLen, targetRate);
        playBuf.copyToChannel(resampled, 0);
        audioSource.buffer = playBuf;
        audioSource.connect(audioDest);
        const audioTracks = audioDest.stream.getAudioTracks();
        if (audioTracks.length > 0) {
          tracks.push(...audioTracks);
          hasAttachedAudio = true;
        }
      } catch {
        // Proceed with canvas video track if WebAudio MediaStreamDestination fails
      }
    }

    combinedStream = new MediaStream(tracks);

    const chunks: BlobPart[] = [];
    const safeMime =
      !hasAttachedAudio && mimeType.includes('codecs=')
        ? mimeType.split(';')[0]
        : mimeType;
    try {
      const options: MediaRecorderOptions = {
        videoBitsPerSecond: bitrate,
      };
      if (safeMime) options.mimeType = safeMime;
      if (hasAttachedAudio) options.audioBitsPerSecond = 128_000;
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
    const stopGuardMs = Math.max(15_000, Math.round(durationSec * 250));
    const stoppedPromise = new Promise<void>((resolve) => {
      const stopGuard = window.setTimeout(resolve, stopGuardMs);
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

    activeRecorder.start(durationSec > 45 ? 500 : 250);
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

    let renderedElapsedSec = 0;
    let lastTickMs = performance.now();
    let lastDrawMs = 0;
    let seekingInFlight = false;
    let pausedForBackground = typeof document !== 'undefined' && document.hidden;
    const frameIntervalMs = Math.max(24, Math.floor(1000 / fps));

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        pausedForBackground = true;
        try {
          video.pause();
        } catch {
          // ignore
        }
        try {
          if (activeRecorder.state === 'recording') activeRecorder.pause();
        } catch {
          // ignore if pause unsupported
        }
        audioCtx?.suspend().catch(() => {});
        onProgress?.(
          Math.min(96, Math.round((renderedElapsedSec / durationSec) * 96)),
          `Preserving Clip ${clip.clipIndex}/${clip.totalClips} (${renderedElapsedSec.toFixed(1)}s/${durationSec.toFixed(1)}s) while in background...`
        );
      } else {
        pausedForBackground = false;
        lastTickMs = performance.now();
        try {
          if (activeRecorder.state === 'paused') activeRecorder.resume();
        } catch {
          // ignore
        }
        audioCtx?.resume().catch(() => {});
        if (videoPlaying) {
          video.play().catch(() => {});
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    try {
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
          if (pausedForBackground || (typeof document !== 'undefined' && document.hidden)) {
            lastTickMs = now;
            return;
          }

          // Advance rendered timeline with capped delta so background timer stalls never skip ahead
          const dtSec = Math.max(0, Math.min(0.12, (now - lastTickMs) / 1000));
          lastTickMs = now;
          renderedElapsedSec += dtSec;

          if (renderedElapsedSec >= durationSec) {
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
            const maxSourceT = Math.max(
              0,
              (Number.isFinite(video.duration) && video.duration > 0
                ? video.duration
                : clip.trimRange.endSec) - 0.04
            );
            const expectedSourceT = Math.min(
              clip.trimRange.startSec + renderedElapsedSec * PACE_FACTOR,
              maxSourceT
            );
            const driftSec = Math.abs(video.currentTime - expectedSourceT);

            // Keep off-screen source <video> cleanly synchronized across the full edited duration
            if (
              (!videoPlaying || video.paused || video.ended || driftSec > 0.28) &&
              !seekingInFlight &&
              !video.seeking
            ) {
              if (videoPlaying && video.paused && !video.ended && driftSec <= 0.35) {
                video.play().catch(() => {});
              } else if (driftSec > 0.08) {
                seekingInFlight = true;
                const releaseSeek = () => {
                  seekingInFlight = false;
                  video.removeEventListener('seeked', releaseSeek);
                };
                video.addEventListener('seeked', releaseSeek, { once: true });
                window.setTimeout(releaseSeek, 180);
                try {
                  video.currentTime = expectedSourceT;
                } catch {
                  releaseSeek();
                }
              }
            }

            paintFrame(renderedElapsedSec);
            try {
              primaryVideoTrack.requestFrame?.();
            } catch {
              // ignore
            }

            const pct = Math.min(96, Math.round((renderedElapsedSec / durationSec) * 96));
            onProgress?.(
              pct,
              `Recording Clip ${clip.clipIndex}/${clip.totalClips} (${renderedElapsedSec.toFixed(1)}s/${durationSec.toFixed(1)}s · Canvas MediaRecorder)...`
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
    } finally {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    }

    if (activeRecorder.state === 'recording') {
      try {
        activeRecorder.requestData();
      } catch {
        // ignore if unsupported
      }
      await new Promise((r) => window.setTimeout(r, 140));
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

    const minExpectedFrames = Math.max(4, Math.floor(durationSec * 2));
    if (drawnRealVideoFrames < minExpectedFrames || blob.size <= 4096) {
      throw new Error(
        `MediaRecorder produced an incomplete output (${blob.size} bytes, ${drawnRealVideoFrames}/${minExpectedFrames} real video frames).`
      );
    }

    const check = await verifyPlayableVideoBlob(blob, durationSec);
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
    if (video.parentNode) {
      video.parentNode.removeChild(video);
    }
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

  // Cap MediaRecorder canvas size to crisp 720x1280 @ 24fps so real-time Canvas 2D capture
  // sustains full-duration frame throughput without dropping frames or truncating to ~2s
  const safeWidth = Math.min(params.width, 720);
  const safeHeight = Math.min(params.height, 1280);
  const safeFps = Math.min(params.fps, 24);
  const safeBitrate = Math.min(params.bitrate, 2_800_000);

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
        width: safeWidth,
        height: safeHeight,
        fps: safeFps,
        bitrate: safeBitrate,
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
  // Keep full trimmed visual clip duration intact so short clips are never cut prematurely
  const maxDur = Math.max(1.5, params.clip.lockedVisualDurationSec);

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

  // Snap interior visual pacingBeats boundaries onto nearby speech/clause/beat starts (±0.75s)
  // so cuts, zooms, and viral caption transitions land right on spoken hooks and reveals.
  const clauseWordAnchors: number[] = [];
  for (let i = 1; i < boundedWords.length; i++) {
    const prevWord = boundedWords[i - 1].word;
    if (/[.!?।,:;—-]$/.test(prevWord) || i % 4 === 0) {
      clauseWordAnchors.push(boundedWords[i].startSec);
    }
  }
  const speechAnchors = [
    ...boundedBeats.map((b) => b.startSec),
    ...clauseWordAnchors,
  ].filter((t) => t > 0.55 && t < maxDur - 0.55);

  const rawPacing = params.clip.pacingBeats ?? [];
  const alignedPacing = rawPacing.map((p, idx) => {
    if (idx === 0 || speechAnchors.length === 0) return { ...p };
    let closest = p.startSec;
    let bestDist = 0.75;
    for (const anchor of speechAnchors) {
      const d = Math.abs(anchor - p.startSec);
      if (d < bestDist) {
        bestDist = d;
        closest = anchor;
      }
    }
    return {
      ...p,
      startSec: Number(Math.max(0.4, Math.min(maxDur - 0.35, closest)).toFixed(2)),
    };
  });
  for (let i = 0; i < alignedPacing.length; i++) {
    if (i > 0 && alignedPacing[i].startSec < alignedPacing[i - 1].startSec + 0.35) {
      alignedPacing[i].startSec = Number(
        Math.min(maxDur - 0.25, alignedPacing[i - 1].startSec + 0.35).toFixed(2)
      );
    }
    if (i > 0) {
      alignedPacing[i - 1].endSec = alignedPacing[i].startSec;
    }
  }
  if (alignedPacing.length > 0) {
    alignedPacing[alignedPacing.length - 1].endSec = Number(maxDur.toFixed(2));
  }

  return {
    clip: {
      ...params.clip,
      watermarkZones: boundedZones,
      pacingBeats: alignedPacing.length > 0 ? alignedPacing : params.clip.pacingBeats,
    },
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
  const clipDurSec = Math.max(1.5, params.clip.lockedVisualDurationSec);
  const isLongForm = clipDurSec > 75;
  const targetFps = isLongForm ? 24 : profile.fps;
  const targetBitrate = isLongForm
    ? profile.isMobile
      ? 2_200_000
      : 3_200_000
    : profile.bitrate;

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
        fps: targetFps,
        bitrate: targetBitrate,
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
    fps: targetFps,
    bitrate: targetBitrate,
  });
}
