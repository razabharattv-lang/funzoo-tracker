import { alignCaptionsOffline } from './offlineModels';
import { probeStudioApiHealth } from './modelRouter';
import type {
  AlignedWordTiming,
  OutputLanguage,
  ScriptBeat,
  VoiceGender,
} from '../types/studio';

export interface SynthesizedVoiceResult {
  audioBuffer: AudioBuffer;
  pcmSamples: Float32Array;
  sampleRate: number;
  durationSec: number;
  voiceEngine: string;
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

  // Gemini TTS returns raw audio/L16;codec=pcm;rate=24000 by default
  if (
    lowerMime.includes('l16') ||
    lowerMime.includes('pcm') ||
    lowerMime === 'audio/raw'
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

  // Container format (WAV / MP3 / OGG)
  const tempCtx = new OfflineAudioContext(1, 48000, 48000);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return tempCtx.decodeAudioData(arrayBuffer);
}

/**
 * Applies broadcast commanding EQ + dynamics compression and time-fits speech cleanly
 * so the narration never gets cut off mid-sentence before `targetDurationSec`.
 */
async function masterAndFitVoiceover(params: {
  rawBuffer: AudioBuffer;
  targetDurationSec: number;
}): Promise<AudioBuffer> {
  const { rawBuffer, targetDurationSec } = params;
  const outSampleRate = 48000;
  const safeTargetDur = Math.max(1.5, targetDurationSec);
  const speechBudgetSec = Math.max(1.2, safeTargetDur - 0.25);

  // Trim leading/trailing dead silence from raw TTS so time-fitting is accurate
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

  // Compute natural playback rate to fit speech cleanly without mid-sentence truncation
  let playbackRate = 1.0;
  if (trimmedDurSec > speechBudgetSec) {
    // Allow up to 1.32x speedup if needed so the final sentence ALWAYS completes cleanly
    playbackRate = Math.min(1.32, trimmedDurSec / speechBudgetSec);
  } else if (trimmedDurSec < speechBudgetSec * 0.72) {
    // Gentle slowdown down to 0.94x for extra gravitas when script is short
    playbackRate = Math.max(0.94, trimmedDurSec / (speechBudgetSec * 0.85));
  }

  const fittedSpeechDur = trimmedDurSec / playbackRate;
  const finalDurSec = Math.max(safeTargetDur, fittedSpeechDur + 0.15);
  const totalOutSamples = Math.ceil(finalDurSec * outSampleRate);

  const offlineCtx = new OfflineAudioContext(1, totalOutSamples, outSampleRate);
  const trimmedBuf = offlineCtx.createBuffer(1, trimmedLen, rawBuffer.sampleRate);
  trimmedBuf.copyToChannel(rawCh.subarray(firstActive, lastActive + 1), 0);

  const src = offlineCtx.createBufferSource();
  src.buffer = trimmedBuf;
  src.playbackRate.value = playbackRate;

  // Commanding broadcast EQ chain:
  // 1) 85Hz high-pass to clean sub-rumble
  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 85;
  highPass.Q.value = 0.7;

  // 2) +4dB bass warmth at 120Hz
  const bassShelf = offlineCtx.createBiquadFilter();
  bassShelf.type = 'lowshelf';
  bassShelf.frequency.value = 120;
  bassShelf.gain.value = 4.0;

  // 3) +5dB vocal presence punch at 3.2kHz
  const presencePeak = offlineCtx.createBiquadFilter();
  presencePeak.type = 'peaking';
  presencePeak.frequency.value = 3200;
  presencePeak.Q.value = 1.1;
  presencePeak.gain.value = 5.0;

  // 4) Broadcast compressor for punchy, consistent loudness
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.14;

  // 5) Clean makeup gain with soft ceiling
  const makeup = offlineCtx.createGain();
  makeup.gain.value = 1.25;

  src.connect(highPass);
  highPass.connect(bassShelf);
  bassShelf.connect(presencePeak);
  presencePeak.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(offlineCtx.destination);

  src.start(0.05);
  const rendered = await offlineCtx.startRendering();

  // Normalize peak to -1.0 dBFS (~0.89) so AAC encoder never clips
  const data = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.001) {
    const scale = Math.min(2.2, 0.89 / peak);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.max(-0.98, Math.min(0.98, data[i] * scale));
    }
  }

  return rendered;
}

/**
 * Clean local fallback audio track when Gemini TTS is unavailable or quota-limited.
 * Generates a subtle, broadcast-mastered cinematic pulse bed synced to the script beats
 * so Step 5 MP4/WebM muxing always produces a valid playable audio track with 0 errors.
 */
async function synthesizeFallbackBroadcastTrack(params: {
  targetDurationSec: number;
  beats: ScriptBeat[];
  voiceGender: VoiceGender;
}): Promise<AudioBuffer> {
  const { targetDurationSec, beats, voiceGender } = params;
  const sampleRate = 48000;
  const dur = Math.max(1.5, targetDurationSec);
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(dur * sampleRate),
    sampleRate
  );

  // Subtle low-volume broadcast cadence bed aligned to beat boundaries
  const baseFreq = voiceGender === 'male' ? 110 : 146.83;
  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = 0.14;
  masterGain.connect(offlineCtx.destination);

  const triggers =
    beats.length > 0
      ? beats.map((b) => b.startSec)
      : Array.from({ length: Math.max(2, Math.floor(dur / 3)) }, (_, i) => i * 3);

  triggers.forEach((t, idx) => {
    if (t >= dur - 0.15) return;
    const osc = offlineCtx.createOscillator();
    const env = offlineCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(idx === 0 ? baseFreq * 1.25 : baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.72, Math.min(dur, t + 0.35));

    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.45, Math.min(dur, t + 0.03));
    env.gain.exponentialRampToValueAtTime(0.0001, Math.min(dur, t + 0.42));

    osc.connect(env);
    env.connect(masterGain);
    osc.start(t);
    osc.stop(Math.min(dur, t + 0.45));
  });

  return offlineCtx.startRendering();
}

/**
 * STEP 4 (Commanding Voiceover):
 * Synthesizes bold Male (`Fenrir`) or Female (`Kore`) voiceover via `/api/gemini/tts`
 * (`gemini-3.8-flash-tts`, zero 429 retries), applies broadcast EQ (`+4dB` bass, `+5dB` presence,
 * compression), fits cleanly to `targetDurationSec` so speech never cuts off mid-sentence,
 * and computes locked word timings for kinetic captions.
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

  let rawBuffer: AudioBuffer | null = null;
  let voiceEngine = '';

  if (health.backendAvailable && health.geminiConfigured) {
    onStatus?.(
      `Synthesizing commanding ${voiceGender === 'female' ? 'Female (Kore)' : 'Male (Fenrir)'} voiceover via Gemini 3.8 Flash TTS...`
    );

    try {
      const resp = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          text: scriptText,
          voiceName,
          language,
        }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as {
          audioBase64?: string;
          mimeType?: string;
          model?: string;
          voiceName?: string;
        };
        if (data.audioBase64) {
          rawBuffer = await decodeTtsAudioToBuffer({
            audioBase64: data.audioBase64,
            mimeType: data.mimeType || 'audio/L16;codec=pcm;rate=24000',
          });
          voiceEngine = `${data.model || 'gemini-3.8-flash-tts'} (${data.voiceName || voiceName}) + Broadcast EQ`;
        }
      } else {
        // Strict zero-retry policy on 429 or any error: fall back cleanly immediately
        voiceEngine =
          resp.status === 429
            ? 'Local Audio Bed Fallback (Gemini TTS 429 Quota Limit)'
            : `Local Audio Bed Fallback (TTS HTTP ${resp.status})`;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      voiceEngine = 'Local Audio Bed Fallback (TTS Network Unavailable)';
    }
  } else {
    voiceEngine = 'Local Audio Bed Fallback (Static Mode — Connect Server for Gemini TTS)';
  }

  let masteredBuffer: AudioBuffer;
  if (rawBuffer) {
    onStatus?.('Mastering broadcast EQ (+4dB bass, +5dB presence) & fitting to clip duration...');
    masteredBuffer = await masterAndFitVoiceover({
      rawBuffer,
      targetDurationSec,
    });
  } else {
    onStatus?.('Building local fallback audio track synced to script beats...');
    masteredBuffer = await synthesizeFallbackBroadcastTrack({
      targetDurationSec,
      beats,
      voiceGender,
    });
  }

  const pcmSamples = new Float32Array(masteredBuffer.getChannelData(0));
  const wordTimings = alignCaptionsOffline({
    audioBuffer: masteredBuffer,
    scriptText,
    beats,
    language,
    targetDurationSec: masteredBuffer.duration,
  });

  return {
    audioBuffer: masteredBuffer,
    pcmSamples,
    sampleRate: masteredBuffer.sampleRate,
    durationSec: Number(masteredBuffer.duration.toFixed(2)),
    voiceEngine,
    wordTimings,
  };
}
