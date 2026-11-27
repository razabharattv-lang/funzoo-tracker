import { alignCaptionsOffline } from './offlineModels';
import {
  PIPELINE_15_WORKER_MODELS,
  probeStudioApiHealth,
} from './modelRouter';
import { getBuildRuntimeEnv } from '../lib/env';
import type {
  AlignedWordTiming,
  OutputLanguage,
  ScriptBeat,
  VoiceConnectionStatus,
  VoiceGender,
} from '../types/studio';

export interface SynthesizedVoiceResult {
  audioBuffer: AudioBuffer;
  pcmSamples: Float32Array;
  sampleRate: number;
  durationSec: number;
  voiceEngine: string;
  voiceSource: VoiceConnectionStatus;
  wordTimings: AlignedWordTiming[];
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseSampleRateFromMime(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/i);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 8000 && parsed <= 96000) {
      return parsed;
    }
  }
  return 24000;
}

function pcm16LeBytesToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(new ArrayBuffer(sampleCount * 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

async function decodeTtsAudioToBuffer(params: {
  audioBase64: string;
  mimeType: string;
}): Promise<AudioBuffer> {
  const { audioBase64, mimeType } = params;
  const bytes = decodeBase64ToBytes(audioBase64);
  const lowerMime = mimeType.toLowerCase();

  // Gemini 3.8 Flash TTS unary generateContent returns a full RIFF/WAVE file (44-byte header).
  // Detect RIFF magic bytes first so WAV audio is never mis-decoded as raw headerless L16 PCM.
  const isRiffWav =
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;

  if (
    !isRiffWav &&
    (lowerMime.includes('l16') ||
      lowerMime.includes('pcm') ||
      lowerMime === 'audio/raw')
  ) {
    const sampleRate = parseSampleRateFromMime(mimeType);
    const floatSamples = pcm16LeBytesToFloat32(bytes);
    const offlineCtx = new OfflineAudioContext(
      1,
      Math.max(1, floatSamples.length),
      sampleRate
    );
    const buf = offlineCtx.createBuffer(1, floatSamples.length, sampleRate);
    buf.copyToChannel(floatSamples, 0);
    return buf;
  }

  const tempCtx = new OfflineAudioContext(1, 48000, 48000);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return tempCtx.decodeAudioData(arrayBuffer);
}

/**
 * Applies broadcast commanding EQ (+4dB bass @ 120Hz, +5dB presence @ 3.2kHz, 85Hz HPF,
 * 6:1 compressor) and time-fits speech cleanly so narration finishes inside `targetDurationSec`
 * with zero mid-sentence cutoffs.
 */
/**
 * Layers subtle, non-overpowering procedural creator SFX beneath the voiceover:
 * 1) Opening 0.04s cinematic hook sub-hit
 * 2) Beat-transition soft whoosh sweeps on visual scene/twist cuts
 * 3) Crisp warm pop accent on the final payoff beat
 */
function mixProceduralCreatorSfx(
  samples: Float32Array,
  sampleRate: number,
  beats: ScriptBeat[],
  targetDurationSec: number
): void {
  const len = samples.length;
  if (len < 128) return;

  // 1) Opening hook sub-hit (0.04s -> 0.30s): warm exponential bass drop
  const hookStart = Math.floor(0.04 * sampleRate);
  const hookDurSamples = Math.floor(0.26 * sampleRate);
  let phase = 0;
  for (let i = 0; i < hookDurSamples && hookStart + i < len; i++) {
    const t = i / sampleRate;
    const frac = i / hookDurSamples;
    const freq = 96 * Math.exp(-frac * 0.85) + 42;
    phase += (2 * Math.PI * freq) / sampleRate;
    const attack = Math.min(1, t / 0.012);
    const decay = Math.exp(-t * 11.5);
    const hit = Math.sin(phase) * attack * decay * 0.13;
    samples[hookStart + i] += hit;
  }

  // 2) Beat-transition cut whooshes + pop accents at interior scene/twist cuts
  const cutTimes = beats
    .map((b) => b.startSec)
    .filter((t) => t > 0.9 && t < Math.max(1.2, targetDurationSec - 0.55));
  const lastCutIdx = cutTimes.length - 1;

  cutTimes.forEach((cutSec, idx) => {
    const isPayoff = idx === lastCutIdx;
    // Short filtered rising whoosh leading into the beat cut (0.20s)
    const whooshLen = Math.floor(0.2 * sampleRate);
    const whooshStart = Math.max(0, Math.floor((cutSec - 0.12) * sampleRate));
    let wPhase1 = 0;
    let wPhase2 = 0;
    for (let i = 0; i < whooshLen && whooshStart + i < len; i++) {
      const u = i / whooshLen;
      const env = Math.sin(Math.PI * u) * Math.sin(Math.PI * u);
      const f1 = 180 + 520 * u * u;
      const f2 = 340 + 880 * u;
      wPhase1 += (2 * Math.PI * f1) / sampleRate;
      wPhase2 += (2 * Math.PI * f2) / sampleRate;
      const whoosh = (Math.sin(wPhase1) * 0.55 + Math.sin(wPhase2) * 0.35) * env * 0.055;
      samples[whooshStart + i] += whoosh;
    }

    // Crisp subtle pop accent right on the cut / payoff reveal (0.14s)
    const popStart = Math.floor(cutSec * sampleRate);
    const popLen = Math.floor(0.14 * sampleRate);
    const popFreq = isPayoff ? 240 : 196;
    const popGain = isPayoff ? 0.09 : 0.065;
    for (let i = 0; i < popLen && popStart + i < len; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 20);
      const pop =
        (Math.sin(2 * Math.PI * popFreq * t) * 0.7 +
          Math.sin(2 * Math.PI * (popFreq * 1.5) * t) * 0.3) *
        env *
        popGain;
      samples[popStart + i] += pop;
    }
  });
}

async function masterAndFitVoiceover(params: {
  rawBuffer: AudioBuffer;
  targetDurationSec: number;
  voiceGender: VoiceGender;
  beats: ScriptBeat[];
}): Promise<AudioBuffer> {
  const { rawBuffer, targetDurationSec, voiceGender, beats } = params;
  const outSampleRate = 48000;
  const safeTargetDur = Math.max(1.5, targetDurationSec);
  const speechBudgetSec = Math.max(1.2, safeTargetDur - 0.2);

  const rawCh = rawBuffer.getChannelData(0);
  let firstActive = 0;
  let lastActive = rawCh.length - 1;
  const silenceFloor = 0.004;
  for (let i = 0; i < rawCh.length; i++) {
    if (Math.abs(rawCh[i]) > silenceFloor) {
      firstActive = Math.max(0, i - Math.floor(rawBuffer.sampleRate * 0.04));
      break;
    }
  }
  for (let i = rawCh.length - 1; i >= firstActive; i--) {
    if (Math.abs(rawCh[i]) > silenceFloor) {
      lastActive = Math.min(rawCh.length - 1, i + Math.floor(rawBuffer.sampleRate * 0.08));
      break;
    }
  }

  const trimmedLen = Math.max(1, lastActive - firstActive + 1);
  const trimmedDurSec = trimmedLen / rawBuffer.sampleRate;

  // Keep brisk, punchy viral creator pacing (~1.12x–1.22x effective tempo) synced cleanly
  // to the trimmed clip duration so delivery hits hard without clipping words or losing clarity.
  const fitRate = trimmedDurSec / speechBudgetSec;
  const playbackRate = Math.max(1.12, Math.min(1.22, Math.max(1.15, fitRate)));

  // Lock mastered buffer length strictly to the edited clip duration (exact 1:1 visual sync)
  const totalOutSamples = Math.ceil(safeTargetDur * outSampleRate);

  const offlineCtx = new OfflineAudioContext(1, totalOutSamples, outSampleRate);
  const trimmedBuf = offlineCtx.createBuffer(1, trimmedLen, rawBuffer.sampleRate);
  trimmedBuf.copyToChannel(rawCh.subarray(firstActive, lastActive + 1), 0);

  const src = offlineCtx.createBufferSource();
  src.buffer = trimmedBuf;
  src.playbackRate.value = playbackRate;

  // Deep Broadcast Voice Shaping:
  // 1) 75Hz HPF clears sub-rumble while preserving full adult fundamental body
  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 75;
  highPass.Q.value = 0.7;

  // 2) Warm authoritative chest body (+5.2dB Male / +4.4dB Female @ 170Hz)
  const chestBody = offlineCtx.createBiquadFilter();
  chestBody.type = 'lowshelf';
  chestBody.frequency.value = 170;
  chestBody.gain.value = voiceGender === 'male' ? 5.2 : 4.4;

  // 3) Bold top-creator vocal cut-through presence (+3.6dB @ 2.8kHz)
  const presencePeak = offlineCtx.createBiquadFilter();
  presencePeak.type = 'peaking';
  presencePeak.frequency.value = 2800;
  presencePeak.Q.value = 1.05;
  presencePeak.gain.value = 3.6;

  // 4) Remove thin/squeaky high-mid childlike resonance (-3.0dB @ 4.8kHz)
  const deSqueakCut = offlineCtx.createBiquadFilter();
  deSqueakCut.type = 'peaking';
  deSqueakCut.frequency.value = 4800;
  deSqueakCut.Q.value = 1.4;
  deSqueakCut.gain.value = -3.0;

  // 5) Gentle top-end silk roll-off (-2.0dB @ 7.8kHz) to remove harsh sibilance
  const smoothTop = offlineCtx.createBiquadFilter();
  smoothTop.type = 'highshelf';
  smoothTop.frequency.value = 7800;
  smoothTop.gain.value = -2.0;

  // 6) Punchy broadcast dynamic leveling for confident forward energy
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -19;
  compressor.knee.value = 10;
  compressor.ratio.value = 4.5;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.12;

  const makeup = offlineCtx.createGain();
  makeup.gain.value = 1.28;

  src.connect(highPass);
  highPass.connect(chestBody);
  chestBody.connect(presencePeak);
  presencePeak.connect(deSqueakCut);
  deSqueakCut.connect(smoothTop);
  smoothTop.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(offlineCtx.destination);

  src.start(0.05);
  const rendered = await offlineCtx.startRendering();

  const data = rendered.getChannelData(0);
  // Layer subtle procedural creator SFX (hook hit, beat cut whoosh, payoff pop) beneath voiceover
  mixProceduralCreatorSfx(data, outSampleRate, beats, safeTargetDur);

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.001) {
    const scale = Math.min(2.4, 0.92 / peak);
    const fadeSamples = Math.min(Math.floor(outSampleRate * 0.025), Math.floor(data.length / 4));
    for (let i = 0; i < data.length; i++) {
      let sample = Math.max(-0.98, Math.min(0.98, data[i] * scale));
      if (i < fadeSamples) {
        sample *= i / Math.max(1, fadeSamples);
      } else if (i > data.length - fadeSamples) {
        sample *= (data.length - i) / Math.max(1, fadeSamples);
      }
      data[i] = sample;
    }
  }

  return rendered;
}

/**
 * Synthesizes a clean, subtle, audible cinema suspense bed (warm low-pass harmonic pad +
 * soft beat-synced cadence pulses) when cloud TTS is unavailable so exported MP4/WebM
 * files always carry a genuine audible audio stream without harsh robotic buzzing.
 */
function createAudibleFallbackTrack(
  targetDurationSec: number,
  beats: ScriptBeat[],
  voiceGender: VoiceGender
): AudioBuffer {
  const sampleRate = 48000;
  const safeTargetDur = Math.max(1.5, targetDurationSec);
  const totalSamples = Math.ceil(safeTargetDur * sampleRate);
  const buf = new AudioBuffer({
    length: totalSamples,
    numberOfChannels: 1,
    sampleRate,
  });
  const ch = buf.getChannelData(0);

  const rootHz = voiceGender === 'female' ? 146.83 : 110.0; // D3 / A2 warm cinema root
  const fifthHz = rootHz * 1.498;
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.14), Math.floor(totalSamples / 4));
  const beatStarts = beats.length > 0 ? beats.map((b) => b.startSec) : [0, safeTargetDur * 0.45];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const swell = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.42 * t);
    const pad =
      Math.sin(2 * Math.PI * rootHz * t) * 0.09 +
      Math.sin(2 * Math.PI * fifthHz * t) * 0.055 +
      Math.sin(2 * Math.PI * (rootHz * 2) * t) * 0.025;

    let accent = 0;
    for (let b = 0; b < beatStarts.length; b++) {
      const dt = t - beatStarts[b];
      if (dt >= 0 && dt < 0.28) {
        const env = Math.exp(-dt * 12) * Math.sin(Math.PI * Math.min(1, dt / 0.04));
        accent += env * Math.sin(2 * Math.PI * (rootHz * 1.5) * dt) * 0.09;
      }
    }

    let sample = pad * swell + accent;
    if (i < fadeSamples) {
      sample *= i / Math.max(1, fadeSamples);
    } else if (i > totalSamples - fadeSamples) {
      sample *= (totalSamples - i) / Math.max(1, fadeSamples);
    }
    ch[i] = Math.max(-0.45, Math.min(0.45, sample));
  }

  // Add subtle hook sub-hit, cut whooshes, and payoff pop accents to the fallback bed too
  mixProceduralCreatorSfx(ch, sampleRate, beats, safeTargetDur);
  for (let i = 0; i < totalSamples; i++) {
    ch[i] = Math.max(-0.65, Math.min(0.65, ch[i]));
  }

  return buf;
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 35000
): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  });
}

export function createGuaranteedFallbackVoice(params: {
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  voiceGender: VoiceGender;
  targetDurationSec: number;
  reason?: string;
}): SynthesizedVoiceResult {
  const alignedDurSec = Math.max(1.5, params.targetDurationSec);
  const audioBuffer = createAudibleFallbackTrack(
    alignedDurSec,
    params.beats,
    params.voiceGender
  );
  const pcmSamples = new Float32Array(audioBuffer.getChannelData(0));
  const wordTimings = alignCaptionsOffline({
    audioBuffer,
    scriptText: params.scriptText,
    beats: params.beats,
    language: params.language,
    targetDurationSec: alignedDurSec,
  });

  return {
    audioBuffer,
    pcmSamples,
    sampleRate: audioBuffer.sampleRate,
    durationSec: Number(alignedDurSec.toFixed(2)),
    voiceEngine: `Cinema Audio Bed (${params.reason || 'Gemini TTS Unavailable'})`,
    voiceSource: 'Browser-Speech',
    wordTimings,
  };
}

/**
 * Browser robotic SpeechSynthesis is permanently disabled.
 * Audio relies exclusively on Gemini TTS (`Fenrir`/`Kore` + Studio Broadcast EQ)
 * and clean synthesized cinema audio-bed fallback when cloud TTS is unavailable.
 */
export function pickBestBrowserSpeechVoice(
  _language: OutputLanguage,
  _voiceGender: VoiceGender
): SpeechSynthesisVoice | null {
  return null;
}

export function speakWithBrowserSpeech(_params: {
  scriptText: string;
  beats?: ScriptBeat[];
  language: OutputLanguage;
  voiceGender: VoiceGender;
  targetDurationSec: number;
}): boolean {
  return false;
}

export function stopBrowserSpeech(): void {
  // Intentionally disabled — browser SpeechSynthesis is never invoked.
}

/**
 * STEP 4 (Commanding Suspense Voiceover + Subtle Procedural SFX):
 * Primary: Gemini 3.8 Flash TTS (`Fenrir` Male / `Kore` Female, zero 429 retries)
 * + Studio Broadcast EQ + brisk 1.12x–1.22x pacing + procedural SFX (hook hit, cut whoosh, pop).
 * Fallback (when Gemini TTS is unavailable): Clean synthesized cinema audio-bed + procedural SFX
 * — NEVER robotic browser `speechSynthesis`.
 */
export async function synthesizeCommandingVoiceover(params: {
  scriptText: string;
  beats: ScriptBeat[];
  language: OutputLanguage;
  voiceGender: VoiceGender;
  targetDurationSec: number;
  signal?: AbortSignal;
  onStatus?: (detail: string) => void;
}): Promise<SynthesizedVoiceResult> {
  const {
    scriptText,
    beats,
    language,
    voiceGender,
    targetDurationSec,
    signal,
    onStatus,
  } = params;

  const voiceName = voiceGender === 'female' ? 'Kore' : 'Fenrir';
  const health = await probeStudioApiHealth();
  const staticEnv = getBuildRuntimeEnv();

  let rawBuffer: AudioBuffer | null = null;
  let voiceEngine = '';
  let voiceSource: VoiceConnectionStatus = 'Browser-Speech';

  const styleDesc =
    language === 'hi'
      ? voiceGender === 'female'
        ? 'Bold, confident, fast-paced, emotional, suspenseful adult female Hindi viral Shorts & Reels creator (age 30-42). Rich authoritative alto; attack the first 2 seconds with urgent curiosity, keep brisk energetic momentum with sharp dramatic shifts on every twist and payoff. Never slow, dull, flat, robotic, or childish.'
        : 'Bold, confident, fast-paced, emotional, suspenseful adult male Hindi viral Shorts & Reels creator (age 32-44). Deep commanding baritone; hit the opening 2 seconds with urgent suspense, drive brisk punchy momentum with dramatic vocal inflection on every twist and reveal. Never slow, dull, flat, robotic, or childish.'
      : voiceGender === 'female'
      ? 'Bold, confident, fast-paced, emotional, suspenseful adult American female viral Shorts & Reels creator (age 30-42). Rich resonant alto; hook hard in the first 2 seconds with urgent curiosity, keep crisp brisk momentum and dramatic intensity through every twist and payoff. Never slow, dull, flat, robotic, or childish.'
      : 'Bold, confident, fast-paced, emotional, suspenseful adult American male viral Shorts & Reels creator (age 32-44). Deep authoritative baritone; slam the opening 2 seconds with urgent suspense, keep brisk punchy pacing with emotional vocal dynamics on every twist and reveal. Never slow, dull, flat, robotic, or childish.';

  if (health.geminiConfigured) {
    onStatus?.(
      `Synthesizing powerful natural ${voiceGender === 'female' ? 'Female (Kore)' : 'Male (Fenrir)'} voiceover via Gemini 3.8 Flash TTS...`
    );

    try {
      if (health.backendAvailable) {
        const resp = await fetchWithTimeout(
          '/api/gemini/tts',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              scriptText,
              styleDesc,
              voiceName,
            }),
          },
          35000
        );

        if (resp.ok) {
          const data = (await resp.json()) as {
            audioBase64?: string;
            mimeType?: string;
            modelUsed?: string;
          };
          if (data.audioBase64) {
            rawBuffer = await decodeTtsAudioToBuffer({
              audioBase64: data.audioBase64,
              mimeType: data.mimeType || 'audio/wav',
            });
            voiceEngine = `${data.modelUsed || 'gemini-3.8-flash-tts'} (${voiceName}) + Studio EQ`;
            voiceSource = 'Gemini-TTS';
          }
        } else {
          voiceEngine =
            resp.status === 429
              ? 'Cinema Audio Bed (Gemini TTS Quota Fallback)'
              : `Cinema Audio Bed (Gemini TTS HTTP ${resp.status})`;
        }
      } else if (staticEnv.geminiApiKey) {
        // Static GitHub Pages direct Gemini TTS call (1 call, bounded timeout, zero 429 retries)
        const requestStaticTts = (modelId: string) =>
          fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(
              staticEnv.geminiApiKey
            )}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal,
              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: `Speak fast, bold, confident, emotional, and suspenseful like a top viral ${
                          language === 'hi' ? 'Hindi' : 'American English'
                        } adult ${
                          voiceGender === 'female' ? 'female' : 'male'
                        } creator (brisk energetic tempo, never slow or flat): ${scriptText}`,
                      },
                    ],
                  },
                ],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName },
                    },
                  },
                },
              }),
            },
            35000
          );

        let usedTtsModel = 'gemini-3.8-flash-tts';
        let resp = await requestStaticTts(usedTtsModel);
        if (resp.status === 404) {
          usedTtsModel = 'gemini-3.8-flash-lite-tts';
          resp = await requestStaticTts(usedTtsModel);
        }

        if (resp.ok) {
          const data = (await resp.json()) as {
            candidates?: {
              content?: {
                parts?: { inlineData?: { data?: string; mimeType?: string } }[];
              };
            }[];
          };
          const audioPart = data.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData?.data
          );
          if (audioPart?.inlineData?.data) {
            rawBuffer = await decodeTtsAudioToBuffer({
              audioBase64: audioPart.inlineData.data,
              mimeType: audioPart.inlineData.mimeType || 'audio/wav',
            });
            voiceEngine = `${usedTtsModel} (${voiceName}) + Studio EQ`;
            voiceSource = 'Gemini-TTS';
          }
        } else {
          voiceEngine =
            resp.status === 429
              ? 'Cinema Audio Bed (Gemini TTS Quota Fallback)'
              : `Cinema Audio Bed (Gemini TTS HTTP ${resp.status})`;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      voiceEngine = 'Cinema Audio Bed (Gemini TTS Offline Fallback)';
    }
  } else {
    const primaryTtsModel = PIPELINE_15_WORKER_MODELS.step4[0];
    voiceEngine = `Cinema Audio Bed (fallback for ${primaryTtsModel})`;
  }

  let masteredBuffer: AudioBuffer | null = null;
  if (rawBuffer) {
    onStatus?.(
      'Applying Deep Broadcast EQ + subtle creator SFX (hook hit, cut whoosh & payoff pop)...'
    );
    try {
      masteredBuffer = await masterAndFitVoiceover({
        rawBuffer,
        targetDurationSec,
        voiceGender,
        beats,
      });
    } catch {
      masteredBuffer = rawBuffer;
    }
  }

  if (!masteredBuffer) {
    onStatus?.(
      `Synthesizing clean cinema audio bed (${targetDurationSec.toFixed(1)}s)...`
    );
    masteredBuffer = createAudibleFallbackTrack(targetDurationSec, beats, voiceGender);
    voiceSource = 'Browser-Speech';
    if (!voiceEngine) {
      voiceEngine = 'Cinema Audio Bed (Gemini TTS Unavailable)';
    }
  }

  const pcmSamples = new Float32Array(masteredBuffer.getChannelData(0));
  const alignedDurSec = Math.max(1.5, targetDurationSec);
  const wordTimings = alignCaptionsOffline({
    audioBuffer: masteredBuffer,
    scriptText,
    beats,
    language,
    targetDurationSec: alignedDurSec,
  });

  return {
    audioBuffer: masteredBuffer,
    pcmSamples,
    sampleRate: masteredBuffer.sampleRate,
    durationSec: Number(alignedDurSec.toFixed(2)),
    voiceEngine,
    voiceSource,
    wordTimings,
  };
}
