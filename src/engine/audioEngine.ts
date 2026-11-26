import type {
  AlignedWordTiming,
  OutputLanguage,
  ScriptBeat,
  StudioConfig,
  VoiceGender,
} from '../types/studio';
import { fetchWithTimeout, requestExternalGpuVoice } from './modelRouter';
import { alignCaptionsOffline } from './offlineModels';

export interface ProcessedStudioAudio {
  /** Broadcast-mastered mono Float32 PCM (1.07x pace) ready for WebCodecs AudioEncoder */
  pcmMono: Float32Array;
  sampleRate: number;
  /** Exact duration of the mastered voiceover in seconds (used to lock clip duration to voDuration + 0.5s) */
  voDuration: number;
  engineLabel: string;
  envelopeFps: number;
  amplitudeEnvelope: Float32Array;
  mouthOpenEnvelope: Float32Array;
  /** Frame-accurate word timings produced by Local Caption & Word-Timing Aligner */
  wordTimings: AlignedWordTiming[];
  alignedBeats: ScriptBeat[];
}

const SERVER_TTS_TIMEOUT_MS = 35_000;
const ENERGETIC_PACE_RATE = 1.07;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return (
    bytes.length > 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  );
}

export function encodeFloat32ToWavBytes(
  pcmMono: Float32Array,
  sampleRate: number
): Uint8Array {
  const numSamples = pcmMono.length;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcmMono[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function wrapPcm16AsWav(
  pcmBytes: Uint8Array,
  sampleRate = 24000,
  numChannels = 1
): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Uint8Array(buffer);
}

/**
 * Offline Pre-Embedded Formant-Harmonic Vocal Cadence Synthesizer:
 * Used when cloud TTS APIs are offline, skipped, or rate-limited so the 5-step pipeline
 * always produces mastered audio and realistic lip-sync / word alignment with zero network load.
 */
function buildOfflineFormantVocalPcm(
  text: string,
  isMale: boolean,
  sampleRate = 44100,
  maxAllowedVoDurationSec?: number
): Float32Array {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const rawEst = Math.max(3.5, Math.min(56, words.length / 2.15));
  const estDuration =
    maxAllowedVoDurationSec && maxAllowedVoDurationSec > 3
      ? Math.min(rawEst, maxAllowedVoDurationSec)
      : rawEst;
  const totalSamples = Math.floor(estDuration * sampleRate);
  const pcm = new Float32Array(totalSamples);
  const baseFreq = isMale ? 104 : 194;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const pitchMod = 1 + 0.06 * Math.sin(t * 3.4) + 0.03 * Math.cos(t * 7.1);
    const f0 = baseFreq * pitchMod;
    const syllableGate = Math.max(0, Math.sin(t * 14.8)) ** 1.4;
    const phraseGate = Math.sin(t * 2.1) > -0.78 ? 1.0 : 0.06;
    const env = syllableGate * phraseGate * 0.22;
    const wave =
      Math.sin(2 * Math.PI * f0 * t) * 0.56 +
      Math.sin(2 * Math.PI * f0 * 2.0 * t) * 0.27 +
      Math.sin(2 * Math.PI * f0 * 3.01 * t) * 0.14;
    pcm[i] = wave * env;
  }

  return pcm;
}

/**
 * Broadcast-Heavy OfflineAudioContext Studio DSP:
 *  - 85Hz high-pass filter
 *  - +4dB chest bass boost @ 120Hz
 *  - +5dB crisp vocal presence boost @ 3.2kHz
 *  - DynamicsCompressorNode (-18dB threshold, 6:1 ratio)
 *  - 1.07x energetic pace
 *  - Exact voDuration measurement + 30-FPS RMS lip-sync envelope
 */
async function masterBroadcastVocalDsp(rawInput: {
  wavBytes?: Uint8Array;
  rawPcm?: Float32Array;
  rawSampleRate?: number;
  maxAllowedVoDurationSec?: number;
}): Promise<{
  pcmMono: Float32Array;
  sampleRate: number;
  voDuration: number;
  amplitudeEnvelope: Float32Array;
  mouthOpenEnvelope: Float32Array;
}> {
  const targetSampleRate = 44100;
  let decodedBuffer: AudioBuffer;

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  const tempCtx = new AudioCtx({ sampleRate: targetSampleRate });
  try {
    if (rawInput.wavBytes) {
      decodedBuffer = await tempCtx.decodeAudioData(
        rawInput.wavBytes.slice().buffer
      );
    } else {
      const srcPcm = new Float32Array(
        rawInput.rawPcm ?? new Float32Array(targetSampleRate * 4)
      );
      const srcSr = rawInput.rawSampleRate ?? targetSampleRate;
      decodedBuffer = tempCtx.createBuffer(1, srcPcm.length, srcSr);
      decodedBuffer.copyToChannel(srcPcm, 0);
    }
  } finally {
    await tempCtx.close().catch(() => {});
  }

  let effectiveRate = ENERGETIC_PACE_RATE;
  const naturalPacedDur = decodedBuffer.duration / ENERGETIC_PACE_RATE;
  if (
    rawInput.maxAllowedVoDurationSec &&
    rawInput.maxAllowedVoDurationSec >= 3.0 &&
    naturalPacedDur > rawInput.maxAllowedVoDurationSec
  ) {
    effectiveRate = Math.min(
      1.35,
      Math.max(
        ENERGETIC_PACE_RATE,
        decodedBuffer.duration / rawInput.maxAllowedVoDurationSec
      )
    );
  }

  const pacedDurationSec = Math.max(
    1.5,
    decodedBuffer.duration / effectiveRate
  );
  const targetLength = Math.max(
    targetSampleRate,
    Math.ceil(pacedDurationSec * targetSampleRate)
  );

  const offline = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = decodedBuffer;
  srcNode.playbackRate.value = effectiveRate;

  // 1) 85Hz High-Pass Filter
  const highpass = offline.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 85;
  highpass.Q.value = 0.75;

  // 2) +4dB Chest Bass @ 120Hz
  const chestBass = offline.createBiquadFilter();
  chestBass.type = 'peaking';
  chestBass.frequency.value = 120;
  chestBass.Q.value = 0.9;
  chestBass.gain.value = 4.0;

  // 3) +5dB Crisp Vocal Presence @ 3.2kHz
  const vocalPresence = offline.createBiquadFilter();
  vocalPresence.type = 'peaking';
  vocalPresence.frequency.value = 3200;
  vocalPresence.Q.value = 1.2;
  vocalPresence.gain.value = 5.0;

  // 4) Heavy Broadcast Compression (-18dB threshold, 6:1 ratio)
  const compressor = offline.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 8;
  compressor.ratio.value = 6.0;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.045;

  const makeupGain = offline.createGain();
  makeupGain.gain.value = 1.35;

  srcNode.connect(highpass);
  highpass.connect(chestBass);
  chestBass.connect(vocalPresence);
  vocalPresence.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(offline.destination);

  srcNode.start(0);
  const rendered = await offline.startRendering();
  const channelData = rendered.getChannelData(0);

  let peak = 0.001;
  for (let i = 0; i < channelData.length; i++) {
    const a = Math.abs(channelData[i]);
    if (a > peak) peak = a;
  }
  const pcmMono = new Float32Array(channelData.length);
  const normGain = Math.min(1.8, 0.95 / peak);
  for (let i = 0; i < channelData.length; i++) {
    pcmMono[i] = Math.max(-0.98, Math.min(0.98, channelData[i] * normGain));
  }

  const voDuration = Number((pcmMono.length / targetSampleRate).toFixed(2));

  // Lightweight 30-FPS RMS amplitude & vowel-weighted mouth-open envelope
  const fps = 30;
  const numFrames = Math.max(15, Math.ceil(voDuration * fps));
  const samplesPerFrame = Math.max(1, Math.floor(targetSampleRate / fps));
  const amp = new Float32Array(numFrames);
  const mouth = new Float32Array(numFrames);

  let maxRms = 0.001;
  for (let f = 0; f < numFrames; f++) {
    const start = f * samplesPerFrame;
    const end = Math.min(pcmMono.length, start + samplesPerFrame);
    let sumSq = 0;
    let zeroCross = 0;
    let prev = 0;
    for (let i = start; i < end; i++) {
      const s = pcmMono[i];
      sumSq += s * s;
      if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) zeroCross++;
      prev = s;
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(sumSq / count);
    const zcr = zeroCross / count;
    amp[f] = rms;
    mouth[f] = rms * (1.25 - Math.min(0.6, zcr * 2.0));
    if (rms > maxRms) maxRms = rms;
  }

  const envScale = 1 / Math.max(maxRms * 0.85, 0.001);
  for (let f = 0; f < numFrames; f++) {
    const prevA = f > 0 ? amp[f - 1] : amp[f];
    const nextA = f < numFrames - 1 ? amp[f + 1] : amp[f];
    amp[f] = Math.min(1, ((prevA + amp[f] * 2 + nextA) / 4) * envScale);
    mouth[f] = Math.min(1, mouth[f] * envScale * 1.12);
  }

  return {
    pcmMono,
    sampleRate: targetSampleRate,
    voDuration,
    amplitudeEnvelope: amp,
    mouthOpenEnvelope: mouth,
  };
}

async function fetchServerGeminiTts(params: {
  voiceName: 'Fenrir' | 'Kore';
  styleDesc: string;
  scriptText: string;
  signal?: AbortSignal;
}): Promise<{ wavBytes: Uint8Array; modelUsed: string } | null> {
  const { voiceName, styleDesc, scriptText, signal } = params;

  try {
    const resp = await fetchWithTimeout(
      '/api/gemini/tts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptText,
          styleDesc,
          voiceName,
        }),
      },
      signal,
      SERVER_TTS_TIMEOUT_MS
    );

    const payload = (await resp.json().catch(() => ({}))) as {
      audioBase64?: string;
      mimeType?: string;
      modelUsed?: string;
      error?: string;
    };

    if (!resp.ok || !payload.audioBase64) {
      return null;
    }

    const decoded = base64ToUint8Array(payload.audioBase64);
    const wavBytes = isRiffWav(decoded)
      ? decoded
      : wrapPcm16AsWav(decoded, 24000, 1);

    return {
      wavBytes,
      modelUsed: payload.modelUsed || 'gemini-3.8-flash-tts',
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError' && signal?.aborted) throw err;
    return null;
  }
}

export async function synthesizeCommandingVoiceover(params: {
  scriptText: string;
  beats?: ScriptBeat[];
  language: OutputLanguage;
  voiceGender: VoiceGender;
  config?: StudioConfig;
  useExternalGpu?: boolean;
  lockedVisualDurationSec?: number;
  onStatus: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<ProcessedStudioAudio> {
  const {
    scriptText,
    beats = [],
    language,
    voiceGender,
    config,
    useExternalGpu = false,
    lockedVisualDurationSec,
    onStatus,
    signal,
  } = params;

  const maxAllowedVoDurationSec =
    lockedVisualDurationSec && lockedVisualDurationSec > 3.5
      ? Number(Math.max(3.0, lockedVisualDurationSec - 0.3).toFixed(2))
      : undefined;

  const isMale = voiceGender === 'male';
  const voiceName = isMale ? 'Fenrir' : 'Kore';
  const styleDesc =
    (isMale
      ? 'Deep, heavy, commanding, urgent, authoritative viral-storyteller male voice with punchy chest resonance and intense drama—never soft or gentle'
      : 'Commanding, sharp, urgent, high-impact viral-storyteller female voice with punchy authority and intense drama—never soft or gentle') +
    (language === 'hi'
      ? ', speaking crisp high-energy Hindi'
      : ', speaking crisp high-energy American English');

  let wavBytes: Uint8Array | null = null;
  let engineLabel = '';

  if (useExternalGpu && config?.externalGpuEndpoint) {
    onStatus(
      'Step 4: Synthesizing voice via External GPU (magpie-tts-zeroshot + Studio Voice + Noise Removal)...'
    );
    const ext = await requestExternalGpuVoice({
      config,
      useExternalGpu,
      scriptText,
      language,
      voiceGender,
      signal,
    });
    if (ext) {
      wavBytes = ext.wavBytes;
      engineLabel = ext.engineLabel;
    }
  }

  if (!wavBytes) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStatus(
      `Step 4: Synthesizing commanding ${
        isMale ? 'Fenrir Male' : 'Kore Female'
      } narration via server Gemini TTS...`
    );
    const ttsResult = await fetchServerGeminiTts({
      voiceName,
      styleDesc,
      scriptText,
      signal,
    });
    if (ttsResult) {
      wavBytes = ttsResult.wavBytes;
      engineLabel = `${ttsResult.modelUsed} (${voiceName})`;
    }
  }

  onStatus(
    'Step 4: Mastering OfflineAudioContext EQ (+4dB bass, +5dB presence) & running Local Caption Aligner...'
  );

  let mastered: {
    pcmMono: Float32Array;
    sampleRate: number;
    voDuration: number;
    amplitudeEnvelope: Float32Array;
    mouthOpenEnvelope: Float32Array;
  } | null = null;

  if (wavBytes) {
    try {
      mastered = await masterBroadcastVocalDsp({
        wavBytes,
        maxAllowedVoDurationSec,
      });
    } catch {
      mastered = null;
    }
  }

  if (!mastered) {
    const fallbackPcm = buildOfflineFormantVocalPcm(
      scriptText,
      isMale,
      44100,
      maxAllowedVoDurationSec
    );
    mastered = await masterBroadcastVocalDsp({
      rawPcm: fallbackPcm,
      rawSampleRate: 44100,
      maxAllowedVoDurationSec,
    });
    engineLabel = 'Offline Pre-Embedded Vocal Cadence DSP';
  }

  const alignment = await alignCaptionsOffline({
    scriptText,
    beats,
    pcmMono: mastered.pcmMono,
    sampleRate: mastered.sampleRate,
    amplitudeEnvelope: mastered.amplitudeEnvelope,
    mouthOpenEnvelope: mastered.mouthOpenEnvelope,
    envelopeFps: 30,
    totalDurationSec: lockedVisualDurationSec ?? mastered.voDuration,
    language,
  });

  return {
    ...mastered,
    engineLabel,
    envelopeFps: 30,
    wordTimings: alignment.wordTimings,
    alignedBeats: alignment.alignedBeats,
  };
}
