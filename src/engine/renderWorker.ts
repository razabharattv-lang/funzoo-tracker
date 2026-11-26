import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  buildCaptionChunks,
  drawCapCutPopCaption,
  type CaptionChunk,
} from './captionPainter';
import type {
  AlignedWordTiming,
  OutputLanguage,
  SafeCropInsets,
  ScriptBeat,
  WatermarkZone,
} from '../types/studio';

interface InitMessage {
  type: 'init';
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  bitrate: number;
  language: OutputLanguage;
  scriptText: string;
  beats: ScriptBeat[];
  wordTimings?: AlignedWordTiming[];
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
  sampleRate: number;
  pcmSamples: ArrayBuffer;
}

interface FrameMessage {
  type: 'frame';
  frameIndex: number;
  timestampUs: number;
  timeSec: number;
  timeFrac?: number;
  bitmap: ImageBitmap;
}

interface FinishMessage {
  type: 'finish';
}

type WorkerInboundMessage = InitMessage | FrameMessage | FinishMessage;

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_srcSize;
uniform vec2 u_dstSize;
uniform vec4 u_crop; // left, top, right, bottom
uniform float u_timeFrac; // 0.0 -> 1.0 clip progress for subtle Ken-Burns motion
uniform int u_zoneCount;
uniform vec4 u_zones[6]; // x1, y1, x2, y2 in normalized frame coords

vec3 gradeCinema(vec3 c, vec2 uv) {
  // High-retention cinema S-curve contrast + vibrance/saturation boost
  c = clamp((c - 0.5) * 1.18 + 0.515, 0.0, 1.0);
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, 1.28);
  // Subtle teal-shadow / warm-highlight cinematic split tone
  vec3 shadowTint = vec3(-0.014, 0.008, 0.022) * (1.0 - luma);
  vec3 highlightTint = vec3(0.022, 0.011, -0.011) * luma;
  c = clamp(c + shadowTint + highlightTint, 0.0, 1.0);
  // Soft cinema vignette around outer borders
  float dist = distance(uv, vec2(0.5, 0.5));
  float vig = 1.0 - smoothstep(0.48, 0.94, dist) * 0.22;
  return clamp(c * vig, 0.0, 1.0);
}

void main() {
  // Full-bleed 9:16 vertical cover-fit inside safe crop + dynamic motion push-in (1.07x -> 1.14x)
  float cropW = max(0.2, 1.0 - u_crop.x - u_crop.z);
  float cropH = max(0.2, 1.0 - u_crop.y - u_crop.w);
  float effSrcW = u_srcSize.x * cropW;
  float effSrcH = u_srcSize.y * cropH;

  float srcAspect = effSrcW / max(1.0, effSrcH);
  float dstAspect = u_dstSize.x / max(1.0, u_dstSize.y);

  vec2 uv = v_uv;
  if (srcAspect > dstAspect) {
    float scale = dstAspect / srcAspect;
    uv.x = (uv.x - 0.5) * scale + 0.5;
  } else {
    float scale = srcAspect / dstAspect;
    uv.y = (uv.y - 0.5) * scale + 0.5;
  }

  // Smooth full-bleed anti-copyright push-in + gentle motion drift (eliminates dark sidebars)
  float tSmooth = smoothstep(0.0, 1.0, clamp(u_timeFrac, 0.0, 1.0));
  float zoom = 1.07 + 0.07 * tSmooth;
  vec2 drift = vec2((tSmooth - 0.5) * 0.012, (tSmooth - 0.5) * 0.016);
  uv = (uv - 0.5) / zoom + 0.5 + drift;

  vec2 srcUv = vec2(
    u_crop.x + uv.x * cropW,
    u_crop.y + uv.y * cropH
  );

  // Seamless blended corner delogo patch (samples clean adjacent interior texture)
  float maskStrength = 0.0;
  vec2 patchShift = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= u_zoneCount) break;
    vec4 z = u_zones[i];
    float edgeX = min(v_uv.x - z.x, z.z - v_uv.x);
    float edgeY = min(v_uv.y - z.y, z.w - v_uv.y);
    float inside = smoothstep(0.0, 0.03, edgeX) * smoothstep(0.0, 0.025, edgeY);
    if (inside > maskStrength) {
      maskStrength = inside;
      float dirY = ((z.y + z.w) * 0.5 < 0.5) ? 1.0 : -1.0;
      patchShift = vec2(0.0, dirY * (z.w - z.y) * 1.15 * cropH);
    }
  }

  vec2 texel = vec2(1.0) / max(u_srcSize, vec2(1.0));
  vec2 clampedUv = clamp(srcUv, vec2(0.002), vec2(0.998));
  vec3 baseCol = texture(u_tex, clampedUv).rgb;

  // Crisp unsharp-mask sharpness pass for Reels/Shorts clarity
  vec3 blurNeighbors =
    (texture(u_tex, clamp(clampedUv + vec2(texel.x, 0.0), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv - vec2(texel.x, 0.0), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv + vec2(0.0, texel.y), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv - vec2(0.0, texel.y), vec2(0.002), vec2(0.998))).rgb) * 0.25;
  vec3 col = clamp(baseCol + (baseCol - blurNeighbors) * 0.45, 0.0, 1.0);

  if (maskStrength > 0.01) {
    vec2 cleanCenterUv = clamp(srcUv + patchShift, vec2(0.005), vec2(0.995));
    vec2 px = vec2(8.0) * texel;
    vec3 acc = vec3(0.0);
    float total = 0.0;
    for (int ox = -2; ox <= 2; ox++) {
      for (int oy = -2; oy <= 2; oy++) {
        vec2 sampleUv = clamp(cleanCenterUv + vec2(float(ox), float(oy)) * px, vec2(0.002), vec2(0.998));
        acc += texture(u_tex, sampleUv).rgb;
        total += 1.0;
      }
    }
    vec3 patched = acc / total;
    col = mix(col, patched, maskStrength);
  }

  outColor = vec4(gradeCinema(col, v_uv), 1.0);
}`;

let glCanvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let quadVbo: WebGLBuffer | null = null;
let videoTex: WebGLTexture | null = null;
let overlayCanvas: OffscreenCanvas | null = null;
let overlayCtx: OffscreenCanvasRenderingContext2D | null = null;

let muxer: Muxer<ArrayBufferTarget> | null = null;
let videoEncoder: VideoEncoder | null = null;
let audioEncoder: AudioEncoder | null = null;

function releaseWorkerResources(): void {
  try {
    if (videoEncoder && videoEncoder.state !== 'closed') {
      videoEncoder.close();
    }
  } catch {
    // ignore
  }
  videoEncoder = null;

  try {
    if (audioEncoder && audioEncoder.state !== 'closed') {
      audioEncoder.close();
    }
  } catch {
    // ignore
  }
  audioEncoder = null;
  muxer = null;

  try {
    if (gl && videoTex) gl.deleteTexture(videoTex);
    if (gl && quadVbo) gl.deleteBuffer(quadVbo);
    if (gl && program) gl.deleteProgram(program);
  } catch {
    // ignore
  }
  videoTex = null;
  quadVbo = null;
  program = null;
  gl = null;
  glCanvas = null;
  overlayCanvas = null;
  overlayCtx = null;
}

let width = 720;
let height = 1280;
let fps = 30;
let language: OutputLanguage = 'en';
let safeCrop: SafeCropInsets = { top: 0, bottom: 0, left: 0, right: 0 };
let watermarkZones: WatermarkZone[] = [];
let captionChunks: CaptionChunk[] = [];
let encoderError: Error | null = null;
let encodedVideoChunks = 0;
let encodedAudioChunks = 0;

function compileShader(
  ctx: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = ctx.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL2 shader.');
  ctx.shaderSource(shader, source);
  ctx.compileShader(shader);
  if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
    const log = ctx.getShaderInfoLog(shader) || 'Unknown shader compile error';
    ctx.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function initWebGL2(w: number, h: number): void {
  glCanvas = new OffscreenCanvas(w, h);
  gl = glCanvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL2 unavailable inside render worker.');

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  program = gl.createProgram();
  if (!program) throw new Error('Failed to link WebGL2 program.');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'WebGL2 program link error');
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  gl.useProgram(program);
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  quadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  videoTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  overlayCanvas = new OffscreenCanvas(w, h);
  overlayCtx = overlayCanvas.getContext('2d');
  if (!overlayCtx) throw new Error('2D OffscreenCanvas unavailable in worker.');
}

async function selectSupportedVideoConfig(
  w: number,
  h: number,
  targetFps: number,
  bitrate: number
): Promise<VideoEncoderConfig> {
  const highRes = w * h > 921_600;
  const candidates = highRes
    ? ['avc1.640028', 'avc1.4d002a', 'avc1.420028', 'avc1.640032']
    : ['avc1.4d002a', 'avc1.640028', 'avc1.42001f', 'avc1.42E01E'];

  for (const codec of candidates) {
    const cfg: VideoEncoderConfig = {
      codec,
      width: w,
      height: h,
      bitrate,
      framerate: targetFps,
      avc: { format: 'avc' },
      hardwareAcceleration: 'prefer-hardware',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) return cfg;
    } catch {
      // Try next profile
    }
  }

  // Retry without hardware preference (software H.264 is often more reliable on mobile)
  for (const codec of candidates) {
    const cfg: VideoEncoderConfig = {
      codec,
      width: w,
      height: h,
      bitrate,
      framerate: targetFps,
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) return cfg;
    } catch {
      // Next
    }
  }

  throw new Error('H.264 WebCodecs VideoEncoder is not supported on this device.');
}

async function encodeAudioPcm(
  pcmSamples: Float32Array,
  sampleRate: number
): Promise<void> {
  if (!audioEncoder) return;
  const chunkSize = 1024;
  for (let offset = 0; offset < pcmSamples.length; offset += chunkSize) {
    if (encoderError) throw encoderError;
    const len = Math.min(chunkSize, pcmSamples.length - offset);
    const slice = new Float32Array(new ArrayBuffer(len * 4));
    slice.set(pcmSamples.subarray(offset, offset + len));
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: slice,
    });
    try {
      audioEncoder.encode(audioData);
    } finally {
      audioData.close();
    }

    // Prevent audio queue pressure on low-RAM phones
    while (audioEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }
  }
}

async function handleInit(msg: InitMessage): Promise<void> {
  encoderError = null;
  encodedVideoChunks = 0;
  encodedAudioChunks = 0;
  width = msg.width;
  height = msg.height;
  fps = msg.fps;
  language = msg.language;
  safeCrop = msg.safeCropInsets;
  watermarkZones = msg.watermarkZones;

  captionChunks = buildCaptionChunks(
    msg.scriptText,
    msg.durationSec,
    msg.language,
    msg.beats,
    msg.wordTimings
  );

  initWebGL2(width, height);

  const videoConfig = await selectSupportedVideoConfig(
    width,
    height,
    fps,
    msg.bitrate
  );

  const audioSupported =
    typeof AudioEncoder !== 'undefined' &&
    (await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate: msg.sampleRate,
      numberOfChannels: 1,
      bitrate: 128_000,
    }).then((r) => Boolean(r.supported)).catch(() => false));

  muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: audioSupported
      ? {
          codec: 'aac',
          sampleRate: msg.sampleRate,
          numberOfChannels: 1,
        }
      : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (chunk.byteLength > 0) encodedVideoChunks++;
      muxer?.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });
  videoEncoder.configure(videoConfig);

  if (audioSupported) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (chunk.byteLength > 0) encodedAudioChunks++;
        muxer?.addAudioChunk(chunk, meta);
      },
      error: (err) => {
        encoderError = err instanceof Error ? err : new Error(String(err));
      },
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: msg.sampleRate,
      numberOfChannels: 1,
      bitrate: 128_000,
    });

    const pcm = new Float32Array(msg.pcmSamples);
    await encodeAudioPcm(pcm, msg.sampleRate);
  }

  self.postMessage({ type: 'ready' });
}

async function handleFrame(msg: FrameMessage): Promise<void> {
  try {
    if (encoderError) throw encoderError;
    if (!gl || !program || !videoTex || !glCanvas || !overlayCanvas || !overlayCtx || !videoEncoder) {
      throw new Error('Render worker not initialized.');
    }

    gl.viewport(0, 0, width, height);
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, msg.bitmap);

    const srcW = msg.bitmap.width;
    const srcH = msg.bitmap.height;
    // Free source bitmap immediately after GPU texture upload
    msg.bitmap.close();

    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_srcSize'), srcW, srcH);
    gl.uniform2f(gl.getUniformLocation(program, 'u_dstSize'), width, height);
    gl.uniform4f(
      gl.getUniformLocation(program, 'u_crop'),
      safeCrop.left,
      safeCrop.top,
      safeCrop.right,
      safeCrop.bottom
    );
    gl.uniform1f(
      gl.getUniformLocation(program, 'u_timeFrac'),
      Math.max(0, Math.min(1, msg.timeFrac ?? 0))
    );

    const activeZones = watermarkZones
      .filter((z) => msg.timeSec >= z.startSec && msg.timeSec <= z.endSec)
      .slice(0, 6);

    gl.uniform1i(gl.getUniformLocation(program, 'u_zoneCount'), activeZones.length);
    const zoneFloats = new Float32Array(6 * 4);
    activeZones.forEach((z, idx) => {
      zoneFloats[idx * 4] = z.box[0];
      zoneFloats[idx * 4 + 1] = z.box[1];
      zoneFloats[idx * 4 + 2] = z.box[2];
      zoneFloats[idx * 4 + 3] = z.box[3];
    });
    gl.uniform4fv(gl.getUniformLocation(program, 'u_zones'), zoneFloats);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.flush();

    // Composite cinema-graded GPU frame + kinetic captions onto output OffscreenCanvas
    overlayCtx.drawImage(glCanvas, 0, 0, width, height);
    drawCapCutPopCaption({
      ctx: overlayCtx,
      chunks: captionChunks,
      timeSec: msg.timeSec,
      language,
      canvasWidth: width,
      canvasHeight: height,
    });

    const durationUs = Math.round(1_000_000 / fps);
    const videoFrame = new VideoFrame(overlayCanvas, {
      timestamp: msg.timestampUs,
      duration: durationUs,
    });

    const isKeyFrame = msg.frameIndex % Math.max(1, fps * 2) === 0;
    try {
      videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame });
    } finally {
      // Strict immediate memory cleanup for phone safety
      videoFrame.close();
    }

    while (videoEncoder.encodeQueueSize > 2) {
      await new Promise((r) => setTimeout(r, 4));
    }

    self.postMessage({ type: 'ack', frameIndex: msg.frameIndex });
  } catch (err) {
    try {
      msg.bitmap.close();
    } catch {
      // already closed
    }
    throw err;
  }
}

async function handleFinish(): Promise<void> {
  try {
    if (encoderError) throw encoderError;
    if (!videoEncoder || !muxer) {
      throw new Error('Render worker has no active muxer.');
    }

    await videoEncoder.flush();
    videoEncoder.close();
    videoEncoder = null;

    if (audioEncoder) {
      await audioEncoder.flush();
      audioEncoder.close();
      audioEncoder = null;
    }

    muxer.finalize();
    const buffer = muxer.target.buffer;
    muxer = null;

    if (encodedVideoChunks === 0 || !buffer || buffer.byteLength <= 1024) {
      throw new Error(
        `WebCodecs MP4 encoder produced no playable video frames (${encodedVideoChunks} video chunks, ${encodedAudioChunks} audio chunks, ${buffer?.byteLength ?? 0} bytes).`
      );
    }

    const videoChunkCount = encodedVideoChunks;
    releaseWorkerResources();

    (
      self as unknown as {
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
      }
    ).postMessage(
      { type: 'done', mp4Buffer: buffer, encodedVideoChunks: videoChunkCount },
      [buffer]
    );
  } catch (err) {
    releaseWorkerResources();
    throw err;
  }
}

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  try {
    const msg = event.data;
    if (msg.type === 'init') {
      await handleInit(msg);
    } else if (msg.type === 'frame') {
      await handleFrame(msg);
    } else if (msg.type === 'finish') {
      await handleFinish();
    }
  } catch (err) {
    releaseWorkerResources();
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', message });
  }
};
