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
async function masterAndFitVoiceover(params: {
  rawBuffer: AudioBuffer;
  targetDurationSec: number;
}): Promise<AudioBuffer> {
  const { rawBuffer, targetDurationSec } = params;
  const outSampleRate = 48000;
  const safeTargetDur = Math.max(1.5, targetDurationSec);
  const speechBudgetSec = Math.max(1.2, safeTargetDur - 0.25);

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

  let playbackRate = 1.0;
  if (trimmedDurSec > speechBudgetSec) {
    playbackRate = Math.min(1.24, trimmedDurSec / speechBudgetSec);
  } else if (trimmedDurSec < speechBudgetSec * 0.72) {
    playbackRate = Math.max(0.96, trimmedDurSec / (speechBudgetSec * 0.88));
  }

  const fittedSpeechDur = trimmedDurSec / playbackRate;
  const finalDurSec = Math.max(safeTargetDur, fittedSpeechDur + 0.12);
  const totalOutSamples = Math.ceil(finalDurSec * outSampleRate);

  const offlineCtx = new OfflineAudioContext(1, totalOutSamples, outSampleRate);
  const trimmedBuf = offlineCtx.createBuffer(1, trimmedLen, rawBuffer.sampleRate);
  trimmedBuf.copyToChannel(rawCh.subarray(firstActive, lastActive + 1), 0);

  const src = offlineCtx.createBufferSource();
  src.buffer = trimmedBuf;
  src.playbackRate.value = playbackRate;

  // Balanced Studio EQ: 85Hz HPF, +3dB warmth, +4dB vocal clarity, smooth compression
  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 85;
  highPass.Q.value = 0.7;

  const bassShelf = offlineCtx.createBiquadFilter();
  bassShelf.type = 'lowshelf';
  bassShelf.frequency.value = 140;
  bassShelf.gain.value = 3.0;

  const presencePeak = offlineCtx.createBiquadFilter();
  presencePeak.type = 'peaking';
  presencePeak.frequency.value = 3100;
  presencePeak.Q.value = 1.0;
  presencePeak.gain.value = 4.0;

  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 14;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.15;

  const makeup = offlineCtx.createGain();
  makeup.gain.value = 1.18;

  src.connect(highPass);
  highPass.connect(bassShelf);
  bassShelf.connect(presencePeak);
  presencePeak.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(offlineCtx.destination);

  src.start(0.05);
  const rendered = await offlineCtx.startRendering();

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
 * Clean, zero-synth-tone silent AudioBuffer used ONLY when cloud Gemini TTS is unavailable
 * so the browser's natural human OS voice (`Natural`/`Enhanced`/`Google`) plays cleanly
 * without any robotic or humming synthetic oscillator underneath.
 */
function createCleanSilentTrack(targetDurationSec: number): AudioBuffer {
  const sampleRate = 48000;
  const safeTargetDur = Math.max(1.5, targetDurationSec);
  const totalSamples = Math.ceil(safeTargetDur * sampleRate);
  return new AudioBuffer({
    length: totalSamples,
    numberOfChannels: 1,
    sampleRate,
  });
}

/**
 * Selects the most natural, non-robotic OS SpeechSynthesisVoice matching language
 * (`en-US` / `hi-IN`) and gender (`male` / `female`) by preferring neural/enhanced voices.
 */
export function pickBestBrowserSpeechVoice(
  language: OutputLanguage,
  voiceGender: VoiceGender
): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = window.speechSynthesis.getVoices() || [];
  } catch {
    return null;
  }
  if (voices.length === 0) return null;

  const langPrefix = language === 'hi' ? 'hi' : 'en';
  const langMatches = voices.filter((v) =>
    v.lang.toLowerCase().startsWith(langPrefix)
  );
  const pool = langMatches.length > 0 ? langMatches : voices;

  const femaleHints = [
    'aria',
    'jenny',
    'emma',
    'ava',
    'samantha',
    'swara',
    'lekha',
    'google us english',
    'google हिन्दी',
    'zira',
    'victoria',
    'heera',
    'kalpana',
    'female',
    'kore',
  ];
  const maleHints = [
    'andrew',
    'brian',
    'guy',
    'christopher',
    'matthew',
    'daniel',
    'alex',
    'madhur',
    'david',
    'mark',
    'hemant',
    'ravi',
    'male',
    'fenrir',
  ];
  const naturalBonusHints = ['natural', 'neural', 'online', 'enhanced', 'premium', 'google'];
  const roboticPenaltyHints = ['espeak', 'compact', 'festival', 'pico', 'whisper', 'bad news', 'zarvox', 'trinoids', 'bells', 'boing'];
  const preferredHints = voiceGender === 'female' ? femaleHints : maleHints;

  const scored = pool.map((v) => {
    const name = v.name.toLowerCase();
    const lang = v.lang.toLowerCase();
    let score = 0;

    if (language === 'en' && lang.includes('us')) score += 18;
    if (language === 'hi' && lang.includes('in')) score += 18;
    if (preferredHints.some((h) => name.includes(h))) score += 26;
    if (naturalBonusHints.some((h) => name.includes(h))) score += 22;
    if (!v.localService) score += 8; // Cloud/neural OS voices usually sound much cleaner
    if (roboticPenaltyHints.some((h) => name.includes(h))) score -= 40;

    return { voice: v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.voice ?? null;
}

/**
 * Speaks the narration with `window.speechSynthesis` using smooth natural pacing
 * fitted cleanly inside `targetDurationSec`.
 */
export function speakWithBrowserSpeech(params: {
  scriptText: string;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  targetDurationSec: number;
}): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return false;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(params.scriptText);
    utterance.lang = params.language === 'hi' ? 'hi-IN' : 'en-US';
    const voice = pickBestBrowserSpeechVoice(params.language, params.voiceGender);
    if (voice) utterance.voice = voice;

    // Energetic, crisp explainer pacing (0.98x–1.22x) fitted cleanly inside exact clip duration
    const words = params.scriptText.trim().split(/\s+/).filter(Boolean).length;
    const estBaseSec = Math.max(1.5, words / 2.55);
    const budgetSec = Math.max(1.4, params.targetDurationSec - 0.35);
    const fittedRate = Math.max(0.98, Math.min(1.22, estBaseSec / budgetSec));

    utterance.rate = Number(fittedRate.toFixed(2));
    utterance.pitch = params.voiceGender === 'female' ? 1.02 : 0.95;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function stopBrowserSpeech(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

/**
 * STEP 4 (Commanding Voiceover):
 * Primary: `/api/gemini/tts` (`gemini-3.8-flash-tts`, `Fenrir`/`Kore`, zero 429 retries)
 * + Broadcast EQ (`+4dB` bass, `+5dB` presence, 6:1 compressor) + duration fitting.
 * Offline/Fallback: Real spoken Browser Speech Voiceover (WebAudio Formant Speech mixed
 * directly into the exported video audio track + synchronized `window.speechSynthesis`
 * OS narrator fitted cleanly to the clip's exact duration).
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
      ? 'Natural, powerful, energetic Hindi Shorts explainer voice. Crisp diction, warm human authority, lively engaging pacing, never robotic or flat.'
      : 'Natural, powerful, energetic American Shorts explainer voice. Crisp studio clarity, warm human confidence, lively engaging pacing, never robotic or metallic.';

  if (health.geminiConfigured) {
    onStatus?.(
      `Synthesizing powerful natural ${voiceGender === 'female' ? 'Female (Kore)' : 'Male (Fenrir)'} voiceover via Gemini 3.8 Flash TTS...`
    );

    try {
      if (health.backendAvailable) {
        const resp = await fetch('/api/gemini/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            scriptText,
            styleDesc,
            voiceName,
          }),
        });

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
              ? `Browser Speech (${voiceGender === 'female' ? 'Female' : 'Male'} · TTS Quota Fallback)`
              : `Browser Speech (${voiceGender === 'female' ? 'Female' : 'Male'} · TTS HTTP ${resp.status})`;
        }
      } else if (staticEnv.geminiApiKey) {
        // Static GitHub Pages direct Gemini TTS call (1 call, zero 429 retries)
        const requestStaticTts = (modelId: string) =>
          fetch(
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
                    parts: [{ text: `${styleDesc}\n\nSpeak naturally: ${scriptText}` }],
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
            }
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
              ? `Browser Speech (${voiceGender === 'female' ? 'Female' : 'Male'} · TTS Quota Fallback)`
              : `Browser Speech (${voiceGender === 'female' ? 'Female' : 'Male'} · TTS HTTP ${resp.status})`;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      voiceEngine = `Browser Speech (${voiceGender === 'female' ? 'Female' : 'Male'} · Offline Fallback)`;
    }
  } else {
    const osVoice = pickBestBrowserSpeechVoice(language, voiceGender);
    const osVoiceLabel = osVoice ? osVoice.name : voiceGender === 'female' ? 'Female' : 'Male';
    const primaryTtsModel = PIPELINE_15_WORKER_MODELS.step4[0];
    voiceEngine = `Browser Speech (${osVoiceLabel} · fallback for ${primaryTtsModel})`;
  }

  let masteredBuffer: AudioBuffer | null = null;
  if (rawBuffer) {
    onStatus?.(
      'Applying Studio EQ (85Hz HPF, +3dB warmth, +4dB vocal clarity) & fitting to clip duration...'
    );
    try {
      masteredBuffer = await masterAndFitVoiceover({
        rawBuffer,
        targetDurationSec,
      });
    } catch {
      masteredBuffer = rawBuffer;
    }
  }

  if (!masteredBuffer) {
    onStatus?.(
      `Ready for natural human device voiceover (${targetDurationSec.toFixed(1)}s · zero synth tones)...`
    );
    masteredBuffer = createCleanSilentTrack(targetDurationSec);
    voiceSource = 'Browser-Speech';
    if (!voiceEngine) {
      const osVoice = pickBestBrowserSpeechVoice(language, voiceGender);
      const osVoiceLabel = osVoice ? osVoice.name : voiceGender === 'female' ? 'Female' : 'Male';
      voiceEngine = `Browser Speech (${osVoiceLabel} · Natural Device Voice)`;
    }
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
    voiceSource,
    wordTimings,
  };
}
