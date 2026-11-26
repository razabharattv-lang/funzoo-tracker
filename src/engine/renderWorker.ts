/// <reference lib="webworker" />
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type {
  OutputLanguage,
  SafeCropInsets,
  ScriptBeat,
  WatermarkZone,
} from '../types/studio';
import {
  buildCharacterPopInSchedule,
  computeSquarePortraitCrop,
  drawTalkingCharacterOverlay,
  type CharacterPopInSchedule,
  type PortraitSource,
} from './characterAnimator';
import {
  buildCaptionChunks,
  drawCapCutPopCaption,
  type CaptionChunk,
} from './captionPainter';

interface InitMessage {
  type: 'init';
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  durationSec: number;
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
  climaxSecond: number;
  portraitBitmap: ImageBitmap | null;
  pcmMono: Float32Array;
  sampleRate: number;
  amplitudeEnvelope: Float32Array;
  mouthOpenEnvelope: Float32Array;
  envelopeFps: number;
}

interface FrameMessage {
  type: 'frame';
  frameIndex: number;
  timeSec: number;
  sourceTimeSec: number;
  bitmap: ImageBitmap;
  sourceWidth: number;
  sourceHeight: number;
}

interface FinishMessage {
  type: 'finish';
}

interface AbortMessage {
  type: 'abort';
}

type WorkerInMessage = InitMessage | FrameMessage | FinishMessage | AbortMessage;

interface NormalizedDelogoZone {
  startSec: number;
  endSec: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_ACTIVE_BOXES = 8;

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform vec2 u_safeMin;       // (leftInset, topInset) in 0..1
uniform vec2 u_safeSize;      // (1 - left - right, 1 - top - bottom)
uniform vec2 u_aspectScale;   // aspect-fill scale within safe rect
uniform float u_zoom;         // gentle 1.00x -> 1.03x micro-drift
uniform vec2 u_texelSize;     // (1.0 / srcW, 1.0 / srcH)
uniform int u_boxCount;
uniform vec4 u_boxes[8];      // (xmin, ymin, xmax, ymax) in 0..1 source UV

in vec2 v_uv;
out vec4 outColor;

vec3 multiPassDirectionalDelogo(vec2 uv, vec4 b, vec2 featherUv) {
  // Multi-radius directional taps strictly outside the watermark perimeter
  vec2 r1 = featherUv * 1.15;
  vec2 r2 = featherUv * 2.35;
  vec2 r3 = featherUv * 3.60;

  float tx = clamp((uv.x - b.x) / max(b.z - b.x, 0.001), 0.0, 1.0);
  float ty = clamp((uv.y - b.y) / max(b.w - b.y, 0.001), 0.0, 1.0);

  vec3 accum = vec3(0.0);
  float totalW = 0.0;

  // Pass 1: near ring (weight 0.50)
  {
    float lx = clamp(b.x - r1.x, 0.002, 0.998);
    float rx = clamp(b.z + r1.x, 0.002, 0.998);
    float tyY = clamp(b.y - r1.y, 0.002, 0.998);
    float byY = clamp(b.w + r1.y, 0.002, 0.998);

    vec3 h = mix(texture(u_tex, vec2(lx, uv.y)).rgb, texture(u_tex, vec2(rx, uv.y)).rgb, tx);
    vec3 v = mix(texture(u_tex, vec2(uv.x, tyY)).rgb, texture(u_tex, vec2(uv.x, byY)).rgb, ty);
    accum += 0.50 * (0.5 * (h + v));
    totalW += 0.50;
  }

  // Pass 2: medium directional ring + diagonals (weight 0.32)
  {
    float lx = clamp(b.x - r2.x, 0.002, 0.998);
    float rx = clamp(b.z + r2.x, 0.002, 0.998);
    float tyY = clamp(b.y - r2.y, 0.002, 0.998);
    float byY = clamp(b.w + r2.y, 0.002, 0.998);

    vec3 h = mix(texture(u_tex, vec2(lx, uv.y)).rgb, texture(u_tex, vec2(rx, uv.y)).rgb, tx);
    vec3 v = mix(texture(u_tex, vec2(uv.x, tyY)).rgb, texture(u_tex, vec2(uv.x, byY)).rgb, ty);
    vec3 diagTop = mix(texture(u_tex, vec2(lx, tyY)).rgb, texture(u_tex, vec2(rx, tyY)).rgb, tx);
    vec3 diagBot = mix(texture(u_tex, vec2(lx, byY)).rgb, texture(u_tex, vec2(rx, byY)).rgb, tx);
    vec3 diag = mix(diagTop, diagBot, ty);
    accum += 0.32 * mix(0.5 * (h + v), diag, 0.35);
    totalW += 0.32;
  }

  // Pass 3: wide ambient feather ring (weight 0.18)
  {
    float lx = clamp(b.x - r3.x, 0.002, 0.998);
    float rx = clamp(b.z + r3.x, 0.002, 0.998);
    float tyY = clamp(b.y - r3.y, 0.002, 0.998);
    float byY = clamp(b.w + r3.y, 0.002, 0.998);

    vec3 h = mix(texture(u_tex, vec2(lx, uv.y)).rgb, texture(u_tex, vec2(rx, uv.y)).rgb, tx);
    vec3 v = mix(texture(u_tex, vec2(uv.x, tyY)).rgb, texture(u_tex, vec2(uv.x, byY)).rgb, ty);
    accum += 0.18 * (0.5 * (h + v));
    totalW += 0.18;
  }

  return accum / max(totalW, 0.001);
}

vec3 sampleWithSurgicalDelogo(vec2 uv) {
  vec3 baseCol = texture(u_tex, uv).rgb;
  if (u_boxCount <= 0) return baseCol;

  // Exact 8px feather padding around each active watermark box
  vec2 featherUv = max(u_texelSize * 8.0, vec2(0.004));
  vec3 col = baseCol;

  for (int i = 0; i < 8; i++) {
    if (i >= u_boxCount) break;
    vec4 b = u_boxes[i];
    vec2 expMin = b.xy - featherUv;
    vec2 expMax = b.zw + featherUv;

    if (uv.x >= expMin.x && uv.x <= expMax.x && uv.y >= expMin.y && uv.y <= expMax.y) {
      // Smooth 8px edge-color feather mask (1.0 inside core box, 0.0 at outer 8px boundary)
      float fx = smoothstep(expMin.x, b.x, uv.x) * (1.0 - smoothstep(b.z, expMax.x, uv.x));
      float fy = smoothstep(expMin.y, b.y, uv.y) * (1.0 - smoothstep(b.w, expMax.y, uv.y));
      float mask = clamp(fx * fy, 0.0, 1.0);

      if (mask > 0.001) {
        vec3 patched = multiPassDirectionalDelogo(uv, b, featherUv);
        col = mix(col, patched, mask);
      }
    }
  }
  return col;
}

void main() {
  // Subject-Safe Cropping: strictly apply safeCropInsets + subtle micro-zoom (1.02x -> 1.06x)
  vec2 safeCenter = u_safeMin + u_safeSize * 0.5;
  vec2 span = u_safeSize * u_aspectScale / u_zoom;
  vec2 sourceUv = safeCenter + (v_uv - 0.5) * span;
  vec2 minBound = u_safeMin + vec2(0.001);
  vec2 maxBound = u_safeMin + u_safeSize - vec2(0.001);
  vec2 clampedUv = clamp(sourceUv, minBound, maxBound);

  vec3 col = sampleWithSurgicalDelogo(clampedUv);

  // Rich cinema color grade: brightness(1.03) contrast(1.22) saturate(1.36)
  col *= 1.03;
  col = (col - 0.5) * 1.22 + 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.36);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

interface GlPipeline {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vbo: WebGLBuffer | null;
  texture: WebGLTexture;
  uSafeMin: WebGLUniformLocation | null;
  uSafeSize: WebGLUniformLocation | null;
  uAspectScale: WebGLUniformLocation | null;
  uZoom: WebGLUniformLocation | null;
  uTexelSize: WebGLUniformLocation | null;
  uBoxCount: WebGLUniformLocation | null;
  uBoxes: WebGLUniformLocation | null;
}

let glPipe: GlPipeline | null = null;
let compositeCanvas: OffscreenCanvas | null = null;
let compositeCtx: OffscreenCanvasRenderingContext2D | null = null;
let muxer: Muxer<ArrayBufferTarget> | null = null;
let target: ArrayBufferTarget | null = null;
let videoEncoder: VideoEncoder | null = null;
let audioEncoder: AudioEncoder | null = null;
let portraitBitmapRef: ImageBitmap | null = null;
let portraitSource: PortraitSource | null = null;
let popInSchedule: CharacterPopInSchedule | null = null;
let captionChunks: CaptionChunk[] = [];
let ampEnv: Float32Array<ArrayBuffer> = new Float32Array(0);
let mouthEnv: Float32Array<ArrayBuffer> = new Float32Array(0);
let envFps = 30;
let outWidth = 720;
let outHeight = 1280;
let outFps = 24;
let outLanguage: OutputLanguage = 'en';
let safeInsets: SafeCropInsets = { top: 0, bottom: 0, left: 0, right: 0 };
let delogoZones: NormalizedDelogoZone[] = [];
const activeBoxBuffer: Float32Array<ArrayBuffer> = new Float32Array(
  MAX_ACTIVE_BOXES * 4
);
let encoderError: Error | null = null;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Shader compile error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function initWebGl2(width: number, height: number): GlPipeline {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new Error('WebGL2 context unavailable inside renderWorker.');
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL2 createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'WebGL2 link error');
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(program);

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  if (!texture) throw new Error('WebGL2 createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.viewport(0, 0, width, height);

  return {
    canvas,
    gl,
    program,
    vbo,
    texture,
    uSafeMin: gl.getUniformLocation(program, 'u_safeMin'),
    uSafeSize: gl.getUniformLocation(program, 'u_safeSize'),
    uAspectScale: gl.getUniformLocation(program, 'u_aspectScale'),
    uZoom: gl.getUniformLocation(program, 'u_zoom'),
    uTexelSize: gl.getUniformLocation(program, 'u_texelSize'),
    uBoxCount: gl.getUniformLocation(program, 'u_boxCount'),
    uBoxes: gl.getUniformLocation(program, 'u_boxes'),
  };
}

function clampInset014(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(0, Math.min(0.14, v));
}

function parseDelogoZones(zones: WatermarkZone[]): NormalizedDelogoZone[] {
  const result: NormalizedDelogoZone[] = [];
  for (const z of zones || []) {
    if (z.action !== 'gpu_delogo_patch') continue;
    if (!Array.isArray(z.box) || z.box.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = z.box.map((v) => Number(v));
    if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) continue;
    const scale = Math.max(ymin, xmin, ymax, xmax) > 1.5 ? 1000 : 1;
    const x0 = Math.max(0, Math.min(1, xmin / scale));
    const y0 = Math.max(0, Math.min(1, ymin / scale));
    const x1 = Math.max(0, Math.min(1, xmax / scale));
    const y1 = Math.max(0, Math.min(1, ymax / scale));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw >= 0.01 && bh >= 0.01 && bw < 0.75 && bh < 0.5) {
      result.push({
        startSec: Number.isFinite(z.startSec) ? z.startSec : 0,
        endSec: Number.isFinite(z.endSec) ? z.endSec : 1e9,
        x0,
        y0,
        x1,
        y1,
      });
    }
  }
  return result;
}

function packActiveBoxesForTimestamp(sourceTimeSec: number): number {
  activeBoxBuffer.fill(0);
  let count = 0;
  for (let i = 0; i < delogoZones.length && count < MAX_ACTIVE_BOXES; i++) {
    const z = delogoZones[i];
    if (sourceTimeSec >= z.startSec - 0.15 && sourceTimeSec <= z.endSec + 0.15) {
      activeBoxBuffer[count * 4] = z.x0;
      activeBoxBuffer[count * 4 + 1] = z.y0;
      activeBoxBuffer[count * 4 + 2] = z.x1;
      activeBoxBuffer[count * 4 + 3] = z.y1;
      count++;
    }
  }
  return count;
}

async function selectSupportedVideoConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig> {
  const codecs = ['avc1.4d002a', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f'];
  const accelModes: HardwareAcceleration[] = [
    'prefer-hardware',
    'no-preference',
  ];

  for (const hardwareAcceleration of accelModes) {
    for (const codec of codecs) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      try {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (support.supported) return cfg;
      } catch {
        // try next codec profile
      }
    }
  }
  throw new Error('No supported H.264 WebCodecs VideoEncoder profile found.');
}

async function waitForVideoEncoderDrain(): Promise<void> {
  while (videoEncoder && videoEncoder.encodeQueueSize > 3) {
    if (encoderError) throw encoderError;
    await new Promise((r) => setTimeout(r, 8));
  }
}

function cleanupResources(): void {
  try {
    if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
  } catch {
    // ignore
  }
  try {
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
  } catch {
    // ignore
  }
  try {
    portraitBitmapRef?.close();
  } catch {
    // ignore
  }
  if (glPipe) {
    try {
      glPipe.gl.deleteTexture(glPipe.texture);
      if (glPipe.vbo) glPipe.gl.deleteBuffer(glPipe.vbo);
      glPipe.gl.deleteProgram(glPipe.program);
      glPipe.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // ignore
    }
  }
  videoEncoder = null;
  audioEncoder = null;
  portraitBitmapRef = null;
  portraitSource = null;
  glPipe = null;
  compositeCanvas = null;
  compositeCtx = null;
  muxer = null;
  target = null;
  delogoZones = [];
}

async function handleInit(msg: InitMessage): Promise<void> {
  encoderError = null;
  outWidth = msg.width;
  outHeight = msg.height;
  outFps = msg.fps;
  outLanguage = msg.language;
  ampEnv = new Float32Array(msg.amplitudeEnvelope);
  mouthEnv = new Float32Array(msg.mouthOpenEnvelope);
  envFps = msg.envelopeFps;

  safeInsets = {
    top: clampInset014(msg.safeCropInsets?.top ?? 0),
    bottom: clampInset014(msg.safeCropInsets?.bottom ?? 0),
    left: clampInset014(msg.safeCropInsets?.left ?? 0),
    right: clampInset014(msg.safeCropInsets?.right ?? 0),
  };

  if (
    typeof VideoEncoder === 'undefined' ||
    typeof AudioEncoder === 'undefined'
  ) {
    throw new Error('WebCodecs VideoEncoder/AudioEncoder unavailable.');
  }

  const audioCfg: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    numberOfChannels: 1,
    sampleRate: msg.sampleRate,
    bitrate: 128_000,
  };
  const audioSupport = await AudioEncoder.isConfigSupported(audioCfg);
  if (!audioSupport.supported) {
    throw new Error('AAC WebCodecs AudioEncoder unsupported on this browser.');
  }

  const videoCfg = await selectSupportedVideoConfig(
    outWidth,
    outHeight,
    outFps,
    msg.bitrate
  );

  glPipe = initWebGl2(outWidth, outHeight);
  compositeCanvas = new OffscreenCanvas(outWidth, outHeight);
  compositeCtx = compositeCanvas.getContext('2d');
  if (!compositeCtx) {
    throw new Error('OffscreenCanvas 2D context unavailable inside worker.');
  }

  delogoZones = parseDelogoZones(msg.watermarkZones);

  if (msg.portraitBitmap) {
    portraitBitmapRef = msg.portraitBitmap;
    const crop = computeSquarePortraitCrop(
      msg.portraitBitmap.width,
      msg.portraitBitmap.height
    );
    portraitSource = { source: msg.portraitBitmap, ...crop };
  } else {
    portraitBitmapRef = null;
    portraitSource = null;
  }

  popInSchedule = buildCharacterPopInSchedule(
    msg.climaxSecond,
    msg.durationSec
  );
  captionChunks = buildCaptionChunks(
    msg.scriptText,
    msg.durationSec,
    msg.language,
    msg.beats
  );

  target = new ArrayBufferTarget();
  muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: outWidth,
      height: outHeight,
    },
    audio: {
      codec: 'aac',
      numberOfChannels: 1,
      sampleRate: msg.sampleRate,
    },
    fastStart: 'in-memory',
  });

  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer?.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });
  videoEncoder.configure(videoCfg);

  audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer?.addAudioChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });
  audioEncoder.configure(audioCfg);

  const totalOutSamples = Math.ceil(msg.durationSec * msg.sampleRate);
  const chunkSize = 1024;
  for (let offset = 0; offset < totalOutSamples; offset += chunkSize) {
    if (encoderError) throw encoderError;
    while (audioEncoder.encodeQueueSize > 16) {
      if (encoderError) throw encoderError;
      await new Promise((r) => setTimeout(r, 4));
    }
    const len = Math.min(chunkSize, totalOutSamples - offset);
    const slice = new Float32Array(len);
    if (offset < msg.pcmMono.length) {
      const avail = Math.min(len, msg.pcmMono.length - offset);
      slice.set(msg.pcmMono.subarray(offset, offset + avail), 0);
    }
    const audioData = new AudioData({
      format: 'f32',
      sampleRate: msg.sampleRate,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: Math.round((offset / msg.sampleRate) * 1_000_000),
      data: slice,
    });
    audioEncoder.encode(audioData);
    audioData.close();
  }

  self.postMessage({
    type: 'ready',
    codec: videoCfg.codec,
    hardwareAcceleration: videoCfg.hardwareAcceleration,
    delogoCount: delogoZones.length,
  });
}

async function handleFrame(msg: FrameMessage): Promise<void> {
  const {
    frameIndex,
    timeSec,
    sourceTimeSec,
    bitmap,
    sourceWidth,
    sourceHeight,
  } = msg;
  try {
    if (encoderError) throw encoderError;
    if (!glPipe || !compositeCanvas || !compositeCtx || !videoEncoder) {
      throw new Error('renderWorker not initialized.');
    }

    await waitForVideoEncoderDrain();

    // 1) WebGL2 Surgical GPU Pass:
    //    - Subject-safe crop using ONLY safeCropInsets (0.0..0.14)
    //    - Gentle 1.00x -> 1.03x micro-drift
    //    - Time-windowed multi-pass directional delogo with 8px feather padding
    const { gl } = glPipe;
    gl.bindTexture(gl.TEXTURE_2D, glPipe.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    const safeMinX = safeInsets.left;
    const safeMinY = safeInsets.top;
    const safeSizeX = Math.max(0.7, 1.0 - safeInsets.left - safeInsets.right);
    const safeSizeY = Math.max(0.7, 1.0 - safeInsets.top - safeInsets.bottom);

    const effectiveSrcW = Math.max(1, sourceWidth * safeSizeX);
    const effectiveSrcH = Math.max(1, sourceHeight * safeSizeY);
    const safeAspect = Math.max(0.1, effectiveSrcW / effectiveSrcH);
    const dstAspect = outWidth / outHeight;

    let aspectScaleX = 1.0;
    let aspectScaleY = 1.0;
    if (safeAspect > dstAspect) {
      aspectScaleX = dstAspect / safeAspect;
    } else {
      aspectScaleY = safeAspect / dstAspect;
    }

    // Subtle dynamic micro-zoom (1.02x -> 1.06x) inside subject-safe crop bounds
    const microZoom = 1.02 + 0.04 * Math.abs(Math.sin(timeSec * 0.58));
    const activeCount = packActiveBoxesForTimestamp(sourceTimeSec);

    gl.uniform2f(glPipe.uSafeMin, safeMinX, safeMinY);
    gl.uniform2f(glPipe.uSafeSize, safeSizeX, safeSizeY);
    gl.uniform2f(glPipe.uAspectScale, aspectScaleX, aspectScaleY);
    gl.uniform1f(glPipe.uZoom, microZoom);
    gl.uniform2f(
      glPipe.uTexelSize,
      1.0 / Math.max(1, sourceWidth),
      1.0 / Math.max(1, sourceHeight)
    );
    gl.uniform1i(glPipe.uBoxCount, activeCount);
    gl.uniform4fv(glPipe.uBoxes, activeBoxBuffer);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } finally {
    // Strictly close frame bitmap immediately to keep mobile RAM flat
    bitmap.close();
  }

  if (!glPipe || !compositeCanvas || !compositeCtx || !videoEncoder) return;

  // 2) Composite GPU frame + Talking Character Pop-Ins + CapCut Kinetic Pop Captions
  compositeCtx.drawImage(glPipe.canvas, 0, 0);

  if (portraitSource && popInSchedule) {
    drawTalkingCharacterOverlay({
      ctx: compositeCtx,
      portrait: portraitSource,
      timeSec,
      schedule: popInSchedule,
      amplitudeEnvelope: ampEnv,
      mouthOpenEnvelope: mouthEnv,
      envelopeFps: envFps,
      canvasWidth: outWidth,
      canvasHeight: outHeight,
    });
  }

  drawCapCutPopCaption({
    ctx: compositeCtx,
    chunks: captionChunks,
    timeSec,
    language: outLanguage,
    canvasWidth: outWidth,
    canvasHeight: outHeight,
  });

  // 3) Hardware H.264 encode strictly 1 VideoFrame and immediately call frame.close()
  const frameDurationUs = Math.round(1_000_000 / outFps);
  const timestampUs = frameIndex * frameDurationUs;
  const videoFrame = new VideoFrame(compositeCanvas, {
    timestamp: timestampUs,
    duration: frameDurationUs,
  });

  try {
    videoEncoder.encode(videoFrame, { keyFrame: frameIndex % (outFps * 2) === 0 });
  } finally {
    videoFrame.close();
  }

  self.postMessage({ type: 'frame_done', frameIndex });
}

async function handleFinish(): Promise<void> {
  if (encoderError) throw encoderError;
  if (!videoEncoder || !audioEncoder || !muxer || !target) {
    throw new Error('renderWorker cannot finalize before initialization.');
  }

  await videoEncoder.flush();
  await audioEncoder.flush();
  muxer.finalize();

  const buffer = target.buffer;
  cleanupResources();
  self.postMessage({ type: 'complete', buffer }, [buffer]);
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      await handleInit(msg);
    } else if (msg.type === 'frame') {
      await handleFrame(msg);
    } else if (msg.type === 'finish') {
      await handleFinish();
    } else if (msg.type === 'abort') {
      cleanupResources();
    }
  } catch (err) {
    cleanupResources();
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
