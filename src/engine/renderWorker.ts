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
  bumperTrimmedSec?: number;
  sampleRate: number;
  pcmSamples: ArrayBuffer;
}

interface FrameMessage {
  type: 'frame';
  frameIndex: number;
  timestampUs: number;
  timeSec: number;
  timeFrac?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  transitionPulse?: number;
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
uniform float u_zoom; // per-beat zoom accent (1.03 -> 1.14)
uniform vec2 u_drift; // per-beat subtle center-safe pan shift
uniform float u_pulse; // brief dramatic transition pulse (0.0 -> 0.18)
uniform int u_zoneCount;
uniform vec4 u_zones[6]; // x1, y1, x2, y2 in normalized frame coords

vec3 gradeCinema(vec3 c, vec2 uv) {
  // Rich clean shadow detail: gentle deep-shadow lift without washing out blacks
  float rawLuma = dot(c, vec3(0.299, 0.587, 0.114));
  float shadowLift = 0.014 * (1.0 - rawLuma) * (1.0 - rawLuma);
  c = clamp(c + vec3(shadowLift), 0.0, 1.0);

  // Balanced lighting: slight brightness lift + controlled brilliance midtone clarity
  c = clamp(c + 0.036 * c * (1.0 - c) + vec3(0.020 + u_pulse * 0.035), 0.0, 1.0);
  c = clamp((c - 0.5) * (1.12 + u_pulse * 0.22) + 0.5, 0.0, 1.0);

  // Smooth highlight shoulder roll-off keeps bright skies, lamps, and lit faces crisp without blowing out
  vec3 overHi = max(vec3(0.0), c - vec3(0.84));
  c = min(c, vec3(0.84)) + overHi / (vec3(1.0) + overHi * 1.45);

  // Natural skin-safe vibrance & saturation without harsh color shifts
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float satEst = maxC - minC;
  float skinMask = smoothstep(0.04, 0.16, c.r - c.b) * smoothstep(0.0, 0.10, c.r - c.g) * smoothstep(0.0, 0.08, c.g - c.b);
  float satBoost = mix(1.14 + (1.0 - satEst) * 0.09, 1.06, skinMask) + u_pulse * 0.12;
  c = clamp(mix(vec3(luma), c, satBoost), 0.0, 1.0);

  // Ultra-subtle neutral cinema polish (clean shadows, natural daylight highlights — no heavy color cast)
  vec3 neutralPolish = vec3(0.005, 0.003, -0.002) * luma + vec3(-0.004, 0.001, 0.006) * (1.0 - luma);
  c = clamp(c + neutralPolish, 0.0, 1.0);

  // Gentle balanced vignette for centered subject/face focus
  float dist = distance(uv, vec2(0.5, 0.45));
  float vig = 1.0 - smoothstep(0.48, 0.96, dist) * (0.18 + u_pulse * 0.24);
  return clamp(c * vig, 0.0, 1.0);
}

void main() {
  // Full-bleed 9:16 vertical cover-fit keeping subject/face centered with natural headroom
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
    // Upper-center headroom bias (0.455) keeps faces centered well above lower captions
    uv.y = (uv.y - 0.5) * scale + 0.455;
  }

  // Per-beat dynamic zoom & center-safe framing drift (clamped strictly to protect faces)
  float tSmooth = smoothstep(0.0, 1.0, clamp(u_timeFrac, 0.0, 1.0));
  float zoom = (u_zoom > 0.5) ? clamp(u_zoom, 1.02, 1.14) : (1.04 + 0.06 * tSmooth);
  vec2 drift = (u_zoom > 0.5)
    ? clamp(u_drift, vec2(-0.010, -0.008), vec2(0.010, 0.006))
    : vec2((tSmooth - 0.5) * 0.007, (tSmooth - 0.5) * 0.006);
  uv = clamp((uv - vec2(0.5, 0.45)) / zoom + vec2(0.5, 0.45) + drift, vec2(0.002), vec2(0.998));

  vec2 srcUv = vec2(
    u_crop.x + uv.x * cropW,
    u_crop.y + uv.y * cropH
  );

  // Seamless blended corner delogo patch (full coverage flush to frame borders, feathered interior edges)
  float maskStrength = 0.0;
  vec2 patchShift = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= u_zoneCount) break;
    vec4 z = u_zones[i];
    if (v_uv.x >= z.x && v_uv.x <= z.z && v_uv.y >= z.y && v_uv.y <= z.w) {
      float fL = (z.x <= 0.01) ? 1.0 : smoothstep(0.0, 0.025, v_uv.x - z.x);
      float fR = (z.z >= 0.99) ? 1.0 : smoothstep(0.0, 0.025, z.z - v_uv.x);
      float fT = (z.y <= 0.01) ? 1.0 : smoothstep(0.0, 0.02, v_uv.y - z.y);
      float fB = (z.w >= 0.99) ? 1.0 : smoothstep(0.0, 0.02, z.w - v_uv.y);
      float inside = fL * fR * fT * fB;
      if (inside > maskStrength) {
        maskStrength = inside;
        float dirY = ((z.y + z.w) * 0.5 < 0.5) ? 1.0 : -1.0;
        patchShift = vec2(0.0, dirY * (z.w - z.y) * 1.18 * cropH);
      }
    }
  }

  vec2 texel = vec2(1.0) / max(u_srcSize, vec2(1.0));
  vec2 clampedUv = clamp(srcUv, vec2(0.002), vec2(0.998));
  vec3 baseCol = texture(u_tex, clampedUv).rgb;

  // 8-tap Gaussian neighborhood for combined subtle edge-preserving denoise + controlled clarity sharpening
  vec3 cardBlur =
    (texture(u_tex, clamp(clampedUv + vec2(texel.x, 0.0), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv - vec2(texel.x, 0.0), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv + vec2(0.0, texel.y), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv - vec2(0.0, texel.y), vec2(0.002), vec2(0.998))).rgb) * 0.16;
  vec3 diagBlur =
    (texture(u_tex, clamp(clampedUv + vec2(texel.x, texel.y), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv + vec2(-texel.x, texel.y), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv + vec2(texel.x, -texel.y), vec2(0.002), vec2(0.998))).rgb +
     texture(u_tex, clamp(clampedUv - vec2(texel.x, texel.y), vec2(0.002), vec2(0.998))).rgb) * 0.09;
  vec3 blurNeighbors = cardBlur + diagBlur;
  float baseLuma = dot(baseCol, vec3(0.299, 0.587, 0.114));
  float lumaDetail = dot(baseCol - blurNeighbors, vec3(0.299, 0.587, 0.114));
  float absDetail = abs(lumaDetail);

  // 1) Subtle denoising on low-variance flat/shadow areas without blurring real edges
  float denoiseBlend = (1.0 - smoothstep(0.012, 0.038, absDetail)) * (0.28 + 0.14 * (1.0 - baseLuma));
  vec3 denoised = mix(baseCol, blurNeighbors, denoiseBlend);

  // 2) Controlled non-harsh sharpening: noise-cored & midtone-weighted to avoid grainy shadows or halos
  float sharpCore = smoothstep(0.016, 0.055, absDetail);
  float midtoneWeight = smoothstep(0.06, 0.24, baseLuma) * smoothstep(0.98, 0.82, baseLuma);
  float clampedDetail = clamp(lumaDetail * 0.68 * sharpCore * midtoneWeight, -0.10, 0.10);
  vec3 col = clamp(denoised + vec3(clampedDetail), 0.0, 1.0);

  if (maskStrength > 0.01) {
    vec2 cleanCenterUv = clamp(srcUv + patchShift, vec2(0.005), vec2(0.995));
    vec2 px = vec2(11.0) * texel;
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
let clipDurationSec = 10;
let bumperTrimmedSec = 0;
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

    // Prevent audio queue pressure on low-RAM phones & keep long 1-2+ min encodes responsive
    let waitSteps = 0;
    while (audioEncoder.encodeQueueSize > 8) {
      if (encoderError) throw encoderError;
      await new Promise((r) => setTimeout(r, 4));
      waitSteps++;
      if (waitSteps > 2500) {
        throw new Error('AudioEncoder queue stalled during long-form AAC encoding.');
      }
    }
    if ((offset / chunkSize) % 32 === 31) {
      await new Promise((r) => setTimeout(r, 0));
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
  clipDurationSec = Math.max(1.5, msg.durationSec);
  bumperTrimmedSec = Math.max(0, msg.bumperTrimmedSec ?? 0);
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
    gl.uniform1f(
      gl.getUniformLocation(program, 'u_zoom'),
      typeof msg.zoom === 'number' && Number.isFinite(msg.zoom) ? msg.zoom : 0
    );
    gl.uniform2f(
      gl.getUniformLocation(program, 'u_drift'),
      typeof msg.panX === 'number' && Number.isFinite(msg.panX) ? msg.panX : 0,
      typeof msg.panY === 'number' && Number.isFinite(msg.panY) ? msg.panY : 0
    );
    gl.uniform1f(
      gl.getUniformLocation(program, 'u_pulse'),
      typeof msg.transitionPulse === 'number' && Number.isFinite(msg.transitionPulse)
        ? Math.max(0, Math.min(0.2, msg.transitionPulse))
        : 0
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

    // Clear previous frame & caption state completely before compositing fresh GPU frame + single caption
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.globalAlpha = 1;
    overlayCtx.globalCompositeOperation = 'source-over';
    overlayCtx.shadowColor = 'transparent';
    overlayCtx.shadowBlur = 0;
    overlayCtx.shadowOffsetX = 0;
    overlayCtx.shadowOffsetY = 0;
    overlayCtx.clearRect(0, 0, width, height);
    overlayCtx.drawImage(glCanvas, 0, 0, width, height);
    const outroWindow = bumperTrimmedSec > 0 ? 0.45 : 0.28;
    if (clipDurationSec - msg.timeSec < outroWindow) {
      const outroProg = Math.max(
        0,
        Math.min(1, (outroWindow - (clipDurationSec - msg.timeSec)) / outroWindow)
      );
      const fadeAlpha = outroProg * outroProg * (bumperTrimmedSec > 0 ? 0.98 : 0.85);
      overlayCtx.fillStyle = `rgba(7, 11, 22, ${fadeAlpha.toFixed(3)})`;
      overlayCtx.fillRect(0, 0, width, height);
    }
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.globalAlpha = 1;
    overlayCtx.globalCompositeOperation = 'source-over';
    drawCapCutPopCaption({
      ctx: overlayCtx,
      chunks: captionChunks,
      timeSec: msg.timeSec,
      language,
      canvasWidth: width,
      canvasHeight: height,
    });
    overlayCtx.restore();

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
      if (encoderError) throw encoderError;
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
