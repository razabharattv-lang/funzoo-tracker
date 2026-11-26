import type { OutputLanguage, VoiceGender } from '../types/studio';

export interface ProcessedStudioAudio {
  /** Studio-EQ'd, compressed mono Float32 PCM ready for WebCodecs AudioEncoder */
  pcmMono: Float32Array;
  sampleRate: number;
  durationSec: number;
  engineLabel: string;
  envelopeFps: number;
  amplitudeEnvelope: Float32Array;
  mouthOpenEnvelope: Float32Array;
}

const GEMINI_TTS_MODELS = [
  'gemini-3.8-flash-lite-tts',
  'gemini-2.5-flash-preview-tts',
  'gemini-3.8-flash-tts',
];

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

function buildFallbackPacedPcm(
  text: string,
  isMale: boolean,
  sampleRate = 44100
): Float32Array {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const estDuration = Math.max(4.5, Math.min(58, words.length / 2.85));
  const totalSamples = Math.floor(estDuration * sampleRate);
  const pcm = new Float32Array(totalSamples);
  const baseFreq = isMale ? 115 : 210;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const syllableGate = Math.max(0, Math.sin(t * 14.5)) ** 1.6;
    const phraseGate = Math.sin(t * 2.1) > -0.75 ? 1.0 : 0.08;
    const env = syllableGate * phraseGate * 0.16;
    const wave =
      Math.sin(2 * Math.PI * baseFreq * t) * 0.55 +
      Math.sin(2 * Math.PI * baseFreq * 2.02 * t) * 0.25 +
      Math.sin(2 * Math.PI * baseFreq * 3.01 * t) * 0.12;
    pcm[i] = wave * env;
  }

  return pcm;
}

/**
 * Runs the voiceover through WebAudio OfflineAudioContext Studio DSP:
 *  - Highpass filter @ 75Hz (cleans rumble)
 *  - Peaking vocal-presence EQ (+3.0dB @ 3000Hz, Q=1.2)
 *  - Broadcast DynamicsCompressorNode (-17dB threshold, 3.2:1 ratio)
 *  - Peak normalization + lightweight 30-FPS RMS amplitude & mouth-open envelope
 */
async function masterWithOfflineStudioDsp(rawInput: {
  wavBytes?: Uint8Array;
  rawPcm?: Float32Array;
  rawSampleRate?: number;
}): Promise<{
  pcmMono: Float32Array;
  sampleRate: number;
  durationSec: number;
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

  const durationSec = Math.max(1.5, decodedBuffer.duration);
  const targetLength = Math.max(
    targetSampleRate,
    Math.ceil(durationSec * targetSampleRate)
  );

  // OfflineAudioContext broadcast vocal DSP chain
  const offline = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = decodedBuffer;

  const highpass = offline.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 75;
  highpass.Q.value = 0.7;

  const presenceEq = offline.createBiquadFilter();
  presenceEq.type = 'peaking';
  presenceEq.frequency.value = 3000;
  presenceEq.Q.value = 1.2;
  presenceEq.gain.value = 3.0;

  const compressor = offline.createDynamicsCompressor();
  compressor.threshold.value = -17;
  compressor.knee.value = 12;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.05;

  const makeupGain = offline.createGain();
  makeupGain.gain.value = 1.25;

  srcNode.connect(highpass);
  highpass.connect(presenceEq);
  presenceEq.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(offline.destination);

  srcNode.start(0);
  const rendered = await offline.startRendering();
  const channelData = rendered.getChannelData(0);

  // Soft-clip peak normalization to prevent AAC distortion
  let peak = 0.001;
  for (let i = 0; i < channelData.length; i++) {
    const a = Math.abs(channelData[i]);
    if (a > peak) peak = a;
  }
  const pcmMono = new Float32Array(channelData.length);
  const normGain = Math.min(1.6, 0.92 / peak);
  for (let i = 0; i < channelData.length; i++) {
    pcmMono[i] = Math.max(-0.98, Math.min(0.98, channelData[i] * normGain));
  }

  // Lightweight 30-FPS RMS amplitude & vowel-weighted mouth-open envelope
  const fps = 30;
  const numFrames = Math.max(15, Math.ceil(durationSec * fps));
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
    mouth[f] = Math.min(1, mouth[f] * envScale * 1.1);
  }

  return {
    pcmMono,
    sampleRate: targetSampleRate,
    durationSec,
    amplitudeEnvelope: amp,
    mouthOpenEnvelope: mouth,
  };
}

export async function synthesizeStudioVoiceover(params: {
  scriptText: string;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  geminiApiKey: string;
  onStatus: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<ProcessedStudioAudio> {
  const { scriptText, language, voiceGender, geminiApiKey, onStatus, signal } =
    params;

  const isMale = voiceGender === 'male';
  const voiceNames = isMale ? ['Fenrir', 'Charon'] : ['Aoede'];
  const styleDesc =
    (isMale
      ? 'Deep, authoritative, fast-paced, high-energy suspense narrator with zero dead air'
      : 'Bright, sharp, fast-paced, high-energy suspense narrator with zero dead air') +
    (language === 'hi'
      ? ' speaking natural energetic Hindi'
      : ' speaking natural punchy American English');

  let wavBytes: Uint8Array | null = null;
  let engineLabel = '';

  if (geminiApiKey) {
    for (const voiceName of voiceNames) {
      for (const model of GEMINI_TTS_MODELS) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        try {
          onStatus(
            `Synthesizing ${
              isMale ? 'deep male' : 'high-energy female'
            } narration (${voiceName})...`
          );
          const is38 = model.includes('3.8');
          const partPayload = is38
            ? { text: scriptText, speechMetadata: { style: styleDesc } }
            : { text: `Speak in this style: ${styleDesc}.\n\n${scriptText}` };

          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
              geminiApiKey
            )}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [partPayload] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName },
                    },
                  },
                },
              }),
              signal,
            }
          );

          if (!resp.ok) continue;

          const data = (await resp.json()) as {
            candidates?: {
              content?: {
                parts?: { inlineData?: { data?: string; mimeType?: string } }[];
              };
            }[];
          };
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            const b64 = part.inlineData?.data;
            if (!b64) continue;
            const decoded = base64ToUint8Array(b64);
            wavBytes = isRiffWav(decoded)
              ? decoded
              : wrapPcm16AsWav(decoded, 24000, 1);
            engineLabel = `Gemini TTS (${voiceName})`;
            break;
          }
          if (wavBytes) break;
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
        }
      }
      if (wavBytes) break;
    }
  }

  onStatus(
    'Applying OfflineAudioContext studio EQ (+3dB @ 3kHz), compression & RMS lip-sync envelope...'
  );

  if (wavBytes) {
    const mastered = await masterWithOfflineStudioDsp({ wavBytes });
    return {
      ...mastered,
      engineLabel,
      envelopeFps: 30,
    };
  }

  // Fallback cadence synthesis if Gemini TTS is rate-limited
  const fallbackPcm = buildFallbackPacedPcm(scriptText, isMale, 44100);
  const mastered = await masterWithOfflineStudioDsp({
    rawPcm: fallbackPcm,
    rawSampleRate: 44100,
  });

  return {
    ...mastered,
    engineLabel: 'WebAudio DSP Fallback',
    envelopeFps: 30,
  };
}
