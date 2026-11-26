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
  voiceGender: VoiceGender;
}): Promise<AudioBuffer> {
  const { rawBuffer, targetDurationSec, voiceGender } = params;
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

  // Keep playbackRate smoothly bounded (0.95x–1.12x) so narration fits the exact edited clip
  // duration without squeaky chipmunk pitch shift or overflowing past visual end.
  let playbackRate = 0.99;
  if (trimmedDurSec > speechBudgetSec) {
    playbackRate = Math.min(1.12, trimmedDurSec / speechBudgetSec);
  } else if (trimmedDurSec < speechBudgetSec * 0.72) {
    playbackRate = Math.max(0.95, trimmedDurSec / (speechBudgetSec * 0.88));
  }

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

  // 2) Warm low-end chest body (+5.0dB Male / +4.2dB Female @ 175Hz)
  const chestBody = offlineCtx.createBiquadFilter();
  chestBody.type = 'lowshelf';
  chestBody.frequency.value = 175;
  chestBody.gain.value = voiceGender === 'male' ? 5.0 : 4.2;

  // 3) Crisp top-creator vocal authority presence (+3.0dB @ 2.6kHz)
  const presencePeak = offlineCtx.createBiquadFilter();
  presencePeak.type = 'peaking';
  presencePeak.frequency.value = 2600;
  presencePeak.Q.value = 1.05;
  presencePeak.gain.value = 3.0;

  // 4) Remove thin/squeaky high-mid childlike resonance (-3.0dB @ 4.8kHz)
  const deSqueakCut = offlineCtx.createBiquadFilter();
  deSqueakCut.type = 'peaking';
  deSqueakCut.frequency.value = 4800;
  deSqueakCut.Q.value = 1.4;
  deSqueakCut.gain.value = -3.0;

  // 5) Gentle top-end silk roll-off (-2.2dB @ 7.8kHz) to remove harsh sibilance
  const smoothTop = offlineCtx.createBiquadFilter();
  smoothTop.type = 'highshelf';
  smoothTop.frequency.value = 7800;
  smoothTop.gain.value = -2.2;

  // 6) Smooth broadcast dynamic leveling
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 4.0;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.14;

  const makeup = offlineCtx.createGain();
  makeup.gain.value = 1.24;

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

let cachedSpeechVoices: SpeechSynthesisVoice[] = [];
let speechVoiceListenerBound = false;

function getLoadedSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  try {
    if (!speechVoiceListenerBound) {
      speechVoiceListenerBound = true;
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        try {
          cachedSpeechVoices = window.speechSynthesis.getVoices() || [];
        } catch {
          // ignore
        }
      });
    }
    const live = window.speechSynthesis.getVoices() || [];
    if (live.length > 0) {
      cachedSpeechVoices = live;
    }
    return cachedSpeechVoices;
  } catch {
    return [];
  }
}

/**
 * Selects the most natural, human-sounding OS SpeechSynthesisVoice matching language
 * (`en-US` / `hi-IN`) and gender (`male` / `female`), prioritizing neural/enhanced voices
 * over legacy robotic desktop voices.
 */
export function pickBestBrowserSpeechVoice(
  language: OutputLanguage,
  voiceGender: VoiceGender
): SpeechSynthesisVoice | null {
  const voices = getLoadedSpeechVoices();
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
    'allison',
    'samantha',
    'siri',
    'swara',
    'lekha',
    'neerja',
    'google us english',
    'google हिन्दी',
    'victoria',
    'karen',
    'moira',
    'tessa',
    'heera',
    'kalpana',
    'zira',
    'female',
    'kore',
  ];
  const maleHints = [
    'andrew',
    'brian',
    'guy',
    'steffan',
    'ryan',
    'eric',
    'christopher',
    'matthew',
    'daniel',
    'alex',
    'madhur',
    'prabhat',
    'aaron',
    'arthur',
    'mark',
    'david',
    'hemant',
    'ravi',
    'male',
    'fenrir',
  ];
  const naturalBonusHints = [
    'natural',
    'neural',
    'online',
    'enhanced',
    'premium',
    'siri',
    'google',
    'wavenet',
    'studio',
  ];
  const roboticPenaltyHints = [
    'child',
    'kid',
    'boy',
    'girl',
    'baby',
    'princess',
    'bubbles',
    'squeak',
    'chipmunk',
    'espeak',
    'compact',
    'festival',
    'pico',
    'desktop',
    'sapi',
    'whisper',
    'bad news',
    'good news',
    'zarvox',
    'trinoids',
    'bells',
    'boing',
    'fred',
    'albert',
    'ralph',
    'kathy',
    'junior',
    'cellos',
    'hysterical',
    'bahh',
    'superstar',
    'organ',
    'grandma',
    'sandy',
    'shelley',
    'flo',
  ];
  const preferredHints = voiceGender === 'female' ? femaleHints : maleHints;
  const oppositeHints = voiceGender === 'female' ? maleHints : femaleHints;

  const scored = pool.map((v) => {
    const name = v.name.toLowerCase();
    const lang = v.lang.toLowerCase();
    let score = 0;

    if (language === 'en' && (lang === 'en-us' || lang.startsWith('en-us'))) score += 20;
    else if (language === 'en' && lang.includes('gb')) score += 12;
    if (language === 'hi' && lang.includes('in')) score += 22;

    if (naturalBonusHints.some((h) => name.includes(h))) score += 42;
    if (!v.localService) score += 14; // Cloud/neural OS voices avoid metallic local DSP
    if (preferredHints.some((h) => name.includes(h))) score += 22;
    if (oppositeHints.some((h) => name.includes(h))) score -= 12;
    if (roboticPenaltyHints.some((h) => name.includes(h))) score -= 60;

    return { voice: v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.voice ?? null;
}

/**
 * Speaks the narration with `window.speechSynthesis` using dramatic suspense/twist cadence:
 * mature resonant pitch (never childish/thin > 1.0), smooth controlled rate (0.95–1.12),
 * and beat-by-beat pacing across hook, rising suspense, and twist payoff.
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
    const voice = pickBestBrowserSpeechVoice(params.language, params.voiceGender);

    // Replace harsh dashes/symbols with natural comma pauses so TTS reads dramatically
    const normalizedText = params.scriptText
      .replace(/[—–]+/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalizedText) return false;

    const sentences = normalizedText
      .split(/(?<=[.!?।])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const segments = sentences.length > 0 ? sentences : [normalizedText];

    const words = normalizedText.split(/\s+/).filter(Boolean).length;
    const estBaseSec = Math.max(1.5, words / 2.3);
    const budgetSec = Math.max(1.5, params.targetDurationSec - 0.35);
    const baseRate = Math.max(0.93, Math.min(1.07, estBaseSec / budgetSec));
    // Deep, mature, resonant pitch (never thin, squeaky, or childlike)
    const basePitch = params.voiceGender === 'female' ? 0.94 : 0.88;

    segments.forEach((sentence, idx) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = params.language === 'hi' ? 'hi-IN' : 'en-US';
      if (voice) utterance.voice = voice;

      const isHook = idx === 0;
      const isTwistPayoff = idx === segments.length - 1 && segments.length > 1;
      const beatRate = isHook
        ? Math.min(1.08, baseRate * 1.02)
        : isTwistPayoff
        ? Math.min(1.06, baseRate * 1.0)
        : Math.max(0.92, baseRate * 0.96);

      utterance.rate = Number(beatRate.toFixed(2));
      utterance.pitch = isTwistPayoff ? Math.max(0.84, basePitch - 0.02) : basePitch;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    });
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
      ? voiceGender === 'female'
        ? 'Top on-camera adult female Hindi YouTube & Reels creator (age 30-42). Commanding, crisp, energetic deep alto tone; hit an instant 1.5-second pattern-interrupt hook, punch micro-twists every 3-4 seconds with sharp vocal dynamics and clear authority. Strictly mature powerful voice — never thin, childlike, squeaky, or monotonous.'
        : 'Top on-camera adult male Hindi YouTube & Reels creator (age 32-44). Deep, commanding, crisp energetic baritone; hit an explosive 1.5-second curiosity hook, drive momentum with crisp micro-twist inflections every 3-4 seconds and authoritative clarity. Strictly deep adult voice — never thin, childlike, squeaky, or monotonous.'
      : voiceGender === 'female'
      ? 'Top on-camera adult American female YouTube & Reels creator (age 30-42). Commanding, crisp, energetic resonant alto; hit an instant 1.5-second pattern-interrupt opener, deliver lively vocal shifts on every 3-4 second micro-twist with confident authority. Strictly mature resonant voice — never thin, childlike, squeaky, or monotonous.'
      : 'Top on-camera adult American male YouTube & Reels creator (age 32-44). Commanding, crisp, energetic deep baritone; punch the first 1.5 seconds with a sharp pattern-interrupt hook, vary energy on every 3-4 second micro-twist with studio broadcast authority. Strictly deep mature voice — never thin, childlike, squeaky, or monotonous.';

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
      'Applying Deep Broadcast EQ (75Hz HPF, warm chest body, de-squeak filter & smooth leveling)...'
    );
    try {
      masteredBuffer = await masterAndFitVoiceover({
        rawBuffer,
        targetDurationSec,
        voiceGender,
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
