/// <reference lib="webworker" />
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { OutputLanguage } from '../types/studio';
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
  language: OutputLanguage;
  watermarkBoxes: number[][];
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

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Map clip-space [-1,1] to top-left video UV [0,1]
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform vec2 u_uvScale;
uniform float u_zoom;
uniform int u_boxCount;
uniform vec4 u_boxes[6]; // (xmin, ymin, xmax, ymax) in 0..1 source UV

in vec2 v_uv;
out vec4 outColor;

vec3 sampleWithDelogo(vec2 uv) {
  for (int i = 0; i < 6; i++) {
    if (i >= u_boxCount) break;
    vec4 b = u_boxes[i];
    if (uv.x >= b.x && uv.x <= b.z && uv.y >= b.y && uv.y <= b.w) {
      // Smooth edge-ring delogo inpaint sampling strictly outside the watermark box
      float padX = max(0.012, (b.z - b.x) * 0.14);
      float padY = max(0.012, (b.w - b.y) * 0.14);
      float leftX = clamp(b.x - padX, 0.002, 0.998);
      float rightX = clamp(b.z + padX, 0.002, 0.998);
      float topY = clamp(b.y - padY, 0.002, 0.998);
      float botY = clamp(b.w + padY, 0.002, 0.998);

      float tx = clamp((uv.x - b.x) / max(b.z - b.x, 0.001), 0.0, 1.0);
      float ty = clamp((uv.y - b.y) / max(b.w - b.y, 0.001), 0.0, 1.0);

      vec3 cLeft = texture(u_tex, vec2(leftX, uv.y)).rgb;
      vec3 cRight = texture(u_tex, vec2(rightX, uv.y)).rgb;
      vec3 cTop = texture(u_tex, vec2(uv.x, topY)).rgb;
      vec3 cBot = texture(u_tex, vec2(uv.x, botY)).rgb;

      vec3 horiz = mix(cLeft, cRight, tx);
      vec3 vert = mix(cTop, cBot, ty);
      vec3 corners = 0.25 * (
        texture(u_tex, vec2(leftX, topY)).rgb +
        texture(u_tex, vec2(rightX, topY)).rgb +
        texture(u_tex, vec2(leftX, botY)).rgb +
        texture(u_tex, vec2(rightX, botY)).rgb
      );
      return mix(0.5 * (horiz + vert), corners, 0.22);
    }
  }
  return texture(u_tex, uv).rgb;
}

void main() {
  // Clean 15% framing crop + aspect-fill + dynamic micro-zoom (1.00x -> 1.05x)
  vec2 centered = (v_uv - 0.5) * u_uvScale / u_zoom + 0.5;
  vec2 clampedUv = clamp(centered, vec2(0.001), vec2(0.999));

  vec3 col = sampleWithDelogo(clampedUv);

  // Vibrant contrast, saturation & subtle brightness grade
  col = (col - 0.5) * 1.14 + 0.5 + vec3(0.02);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.32);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

interface GlPipeline {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uUvScale: WebGLUniformLocation | null;
  uZoom: WebGLUniformLocation | null;
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
let outFps = 30;
let outLanguage: OutputLanguage = 'en';
let normalizedBoxes = new Float32Array(24);
let normalizedBoxCount = 0;
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
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
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
    throw new Error('WebGL2 context unavailable inside Worker.');
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
    texture,
    uUvScale: gl.getUniformLocation(program, 'u_uvScale'),
    uZoom: gl.getUniformLocation(program, 'u_zoom'),
    uBoxCount: gl.getUniformLocation(program, 'u_boxCount'),
    uBoxes: gl.getUniformLocation(program, 'u_boxes'),
  };
}

function normalizeWatermarkBoxes(boxes: number[][]): {
  packed: Float32Array<ArrayBuffer>;
  count: number;
} {
  const packed = new Float32Array(24);
  let count = 0;
  for (const box of (boxes || []).slice(0, 6)) {
    if (!Array.isArray(box) || box.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = box.map((v) => Number(v));
    if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) continue;
    const scale = Math.max(ymin, xmin, ymax, xmax) > 1.5 ? 1000 : 1;
    const x0 = Math.max(0, Math.min(1, xmin / scale - 0.008));
    const y0 = Math.max(0, Math.min(1, ymin / scale - 0.008));
    const x1 = Math.max(0, Math.min(1, xmax / scale + 0.008));
    const y1 = Math.max(0, Math.min(1, ymax / scale + 0.008));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw >= 0.015 && bh >= 0.015 && bw < 0.72 && bh < 0.45) {
      packed[count * 4] = x0;
      packed[count * 4 + 1] = y0;
      packed[count * 4 + 2] = x1;
      packed[count * 4 + 3] = y1;
      count++;
    }
  }
  return { packed, count };
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
        if (support.supported) {
          return cfg;
        }
      } catch {
        // try next codec profile
      }
    }
  }
  throw new Error('No supported H.264 WebCodecs VideoEncoder profile found.');
}

async function waitForEncoderDrain(): Promise<void> {
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
      glPipe.gl.deleteProgram(glPipe.program);
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

  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
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

  // Initialize GPU WebGL2 shader pipeline + 2D overlay OffscreenCanvas
  glPipe = initWebGl2(outWidth, outHeight);
  compositeCanvas = new OffscreenCanvas(outWidth, outHeight);
  compositeCtx = compositeCanvas.getContext('2d');
  if (!compositeCtx) {
    throw new Error('OffscreenCanvas 2D context unavailable inside Worker.');
  }

  const norm = normalizeWatermarkBoxes(msg.watermarkBoxes);
  normalizedBoxes = norm.packed;
  normalizedBoxCount = norm.count;

  if (msg.portraitBitmap) {
    portraitBitmapRef = msg.portraitBitmap;
    const crop = computeSquarePortraitCrop(
      msg.portraitBitmap.width,
      msg.portraitBitmap.height
    );
    portraitSource = {
      source: msg.portraitBitmap,
      ...crop,
    };
  } else {
    portraitBitmapRef = null;
    portraitSource = null;
  }

  popInSchedule = buildCharacterPopInSchedule(
    msg.climaxSecond / 1.03,
    msg.durationSec
  );
  captionChunks = buildCaptionChunks(
    msg.scriptText,
    msg.durationSec,
    msg.language
  );

  // Fresh MP4 container via mp4-muxer (strips all old metadata automatically)
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

  // Stream Studio-DSP PCM audio in 1024-sample AudioData chunks and immediately close each chunk
  const totalAudioSamples = Math.min(
    msg.pcmMono.length,
    Math.ceil(msg.durationSec * msg.sampleRate)
  );
  const chunkSize = 1024;
  for (let offset = 0; offset < totalAudioSamples; offset += chunkSize) {
    if (encoderError) throw encoderError;
    const len = Math.min(chunkSize, totalAudioSamples - offset);
    const slice = new Float32Array(msg.pcmMono.subarray(offset, offset + len));
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
    delogoCount: normalizedBoxCount,
  });
}

async function handleFrame(msg: FrameMessage): Promise<void> {
  const { frameIndex, timeSec, bitmap, sourceWidth, sourceHeight } = msg;
  try {
    if (encoderError) throw encoderError;
    if (!glPipe || !compositeCanvas || !compositeCtx || !videoEncoder) {
      throw new Error('GPU Worker not initialized.');
    }

    await waitForEncoderDrain();

    // 1) WebGL2 GPU Pass: Delogo blur + 15% clean crop + aspect-fill + 1.00x->1.05x micro-zoom + vibrant grade
    const { gl } = glPipe;
    gl.bindTexture(gl.TEXTURE_2D, glPipe.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    // Compute aspect-fill UV scale with 15% clean anti-copyright framing crop
    const srcAspect = Math.max(0.1, sourceWidth / Math.max(sourceHeight, 1));
    const dstAspect = outWidth / outHeight;
    let uvScaleX = 1.0;
    let uvScaleY = 1.0;
    if (srcAspect > dstAspect) {
      uvScaleX = dstAspect / srcAspect;
    } else {
      uvScaleY = srcAspect / dstAspect;
    }
    const baseCropFactor = 1.0 / 1.15; // 15% clean framing crop
    uvScaleX *= baseCropFactor;
    uvScaleY *= baseCropFactor;

    // Smooth dynamic micro-zoom (1.00x -> 1.05x)
    const microZoom = 1.0 + 0.05 * Math.abs(Math.sin(timeSec * 0.65));

    gl.uniform2f(glPipe.uUvScale, uvScaleX, uvScaleY);
    gl.uniform1f(glPipe.uZoom, microZoom);
    gl.uniform1i(glPipe.uBoxCount, normalizedBoxCount);
    gl.uniform4fv(glPipe.uBoxes, normalizedBoxes);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } finally {
    // Strictly close incoming frame bitmap immediately to keep mobile RAM flat
    bitmap.close();
  }

  if (!glPipe || !compositeCanvas || !compositeCtx || !videoEncoder) return;

  // 2) Composite GPU output + Pattern-Interrupt Talking Character + CapCut Kinetic Pop-Up Captions
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

  // 3) Hardware H.264 encode strictly 1 VideoFrame and IMMEDIATELY call frame.close()
  const frameDurationUs = Math.round(1_000_000 / outFps);
  const timestampUs = frameIndex * frameDurationUs;
  const videoFrame = new VideoFrame(compositeCanvas, {
    timestamp: timestampUs,
    duration: frameDurationUs,
  });

  try {
    videoEncoder.encode(videoFrame, { keyFrame: frameIndex % 60 === 0 });
  } finally {
    videoFrame.close();
  }

  self.postMessage({ type: 'frame_done', frameIndex });
}

async function handleFinish(): Promise<void> {
  if (encoderError) throw encoderError;
  if (!videoEncoder || !audioEncoder || !muxer || !target) {
    throw new Error('GPU Worker cannot finalize before initialization.');
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
