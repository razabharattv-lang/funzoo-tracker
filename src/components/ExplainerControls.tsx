import {
  Check,
  Mic,
  Play,
  ShieldCheck,
  Subtitles,
  Loader2,
} from 'lucide-react';
import type {
  CaptionTheme,
  ShieldFlag,
  StudioControlsState,
  VoiceGender,
} from '../types/studio';

interface ExplainerControlsProps {
  controls: StudioControlsState;
  hasClip: boolean;
  isRendering: boolean;
  onChange: (next: StudioControlsState) => void;
  onStartRender: () => void;
}

const VOICE_OPTIONS: { id: VoiceGender; label: string; engine: string }[] = [
  { id: 'female', label: 'Female — Aoede / Ava', engine: 'US Bright Narrator' },
  { id: 'male', label: 'Male — Puck / Andrew', engine: 'US Punchy Host' },
];

const SHIELD_OPTIONS: { id: ShieldFlag; label: string }[] = [
  { id: 'crop_watermark', label: '15% Watermark Crop' },
  { id: 'micro_zoom', label: 'Dynamic Micro-Zoom' },
  { id: 'color_grade', label: 'Vibrant Color Grade' },
  { id: 'strip_metadata', label: 'Metadata Strip' },
];

const CAPTION_OPTIONS: { id: CaptionTheme; label: string }[] = [
  { id: 'capcut_yellow_white', label: 'CapCut Pop Yellow/White' },
  { id: 'clean_white', label: 'Clean Bold White' },
  { id: 'coral_pop', label: 'Coral Pop Highlight' },
  { id: 'none', label: 'No Captions' },
];

export function ExplainerControls({
  controls,
  hasClip,
  isRendering,
  onChange,
  onStartRender,
}: ExplainerControlsProps) {
  const toggleShield = (flag: ShieldFlag) => {
    onChange({
      ...controls,
      shieldFlags: {
        ...controls.shieldFlags,
        [flag]: !controls.shieldFlags[flag],
      },
    });
  };

  const activeShieldCount = Object.values(controls.shieldFlags).filter(Boolean).length;

  return (
    <section
      aria-label="Explainer Script and Render Controls"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-5"
    >
      {/* Custom Explanation / Angle */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <label
            htmlFor="custom-explanation-angle"
            className="text-base font-extrabold text-[#0F172A]"
          >
            2. Custom Explanation / Angle
          </label>
          <span className="font-mono-tabular text-xs font-semibold text-[#64748B]">
            {controls.customPrompt.length}/320
          </span>
        </div>
        <textarea
          id="custom-explanation-angle"
          rows={3}
          maxLength={320}
          disabled={isRendering}
          value={controls.customPrompt}
          onChange={(e) => onChange({ ...controls, customPrompt: e.target.value })}
          placeholder="Optional: Type your hook or explanation angle and Gemini will expand it into a punchy US script. Leave blank for automatic Gemini Vision analysis..."
          className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-3 text-sm font-medium text-[#0F172A] placeholder:text-[#64748B] focus:bg-white focus:border-[#3D5AFE] focus:outline-none disabled:opacity-55 resize-none transition-colors"
        />
        <p className="text-xs font-medium text-[#64748B] mt-1.5">
          {controls.customPrompt.trim().length > 0
            ? 'Custom Angle Mode: Gemini will expand your hook while grounding it to the video frames.'
            : 'Auto Vision Mode: Gemini Vision will inspect frames and write a curiosity-driven US explainer script.'}
        </p>
      </div>

      <div className="border-t-2 border-[#F1F5F9] pt-5 space-y-5">
        {/* Voice Gender (Vivid Teal #00BFA5) */}
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="w-6 h-6 rounded-md bg-[#00BFA5] text-white flex items-center justify-center shrink-0">
              <Mic className="w-3.5 h-3.5" strokeWidth={2.5} />
            </span>
            <h3 className="text-sm font-extrabold text-[#0F172A]">
              American Voiceover
            </h3>
            <span className="text-xs font-semibold text-[#64748B]">
              Gemini TTS + Edge-TTS fallback
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {VOICE_OPTIONS.map((opt) => {
              const active = controls.voiceGender === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isRendering}
                  aria-pressed={active}
                  onClick={() => onChange({ ...controls, voiceGender: opt.id })}
                  className={`flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-full border-2 text-left transition-colors cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-[#00BFA5] border-[#009E88] text-white'
                      : 'bg-white border-[#E2E8F0] text-[#0F172A] hover:border-[#00BFA5] hover:bg-[#E6FAF7]'
                  }`}
                >
                  <span className="text-xs font-extrabold whitespace-nowrap truncate">
                    {opt.label}
                  </span>
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                      active ? 'bg-white text-[#009E88]' : 'bg-[#F1F5F9] text-transparent'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={3} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Anti-Copyright Shield (Warm Amber #FFAB00) */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-[#FFAB00] text-[#0F172A] flex items-center justify-center shrink-0">
                <ShieldCheck className="w-3.5 h-3.5" strokeWidth={2.5} />
              </span>
              <h3 className="text-sm font-extrabold text-[#0F172A]">
                Anti-Copyright Shield
              </h3>
            </div>
            <span className="font-mono-tabular text-xs font-bold text-[#B45309]">
              {activeShieldCount}/4 Active
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {SHIELD_OPTIONS.map((opt) => {
              const active = controls.shieldFlags[opt.id];
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isRendering}
                  aria-pressed={active}
                  onClick={() => toggleShield(opt.id)}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-[#FFAB00] border-[#D98E00] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:border-[#FFAB00] hover:bg-[#FFF8E1]'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center ${
                      active ? 'bg-[#0F172A] text-[#FFAB00]' : 'bg-[#E2E8F0] text-transparent'
                    }`}
                  >
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Caption Theme (Electric Indigo #3D5AFE) */}
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="w-6 h-6 rounded-md bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
              <Subtitles className="w-3.5 h-3.5" strokeWidth={2.5} />
            </span>
            <h3 className="text-sm font-extrabold text-[#0F172A]">
              Caption Theme
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {CAPTION_OPTIONS.map((opt) => {
              const active = controls.captionTheme === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isRendering}
                  aria-pressed={active}
                  onClick={() => onChange({ ...controls, captionTheme: opt.id })}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-[#3D5AFE] border-[#2A44D8] text-white'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:border-[#3D5AFE] hover:bg-[#EEF2FF]'
                  }`}
                >
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Primary Action / Render CTA: Vibrant Coral Red (#FF1744) */}
      <div className="pt-2">
        <button
          type="button"
          onClick={onStartRender}
          disabled={!hasClip || isRendering}
          className="w-full py-3.5 px-6 rounded-xl border-2 border-[#D5002B] bg-[#FF1744] hover:bg-[#E5123B] active:bg-[#CC0F34] text-white font-extrabold text-sm tracking-tight flex items-center justify-center gap-2.5 transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
        >
          {isRendering ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" strokeWidth={2.5} />
              <span>Rendering on 7GB Cloud Engine...</span>
            </>
          ) : (
            <>
              <Play className="w-5 h-5 fill-current" strokeWidth={2.25} />
              <span>Render 1080×1920 US Explainer Video</span>
            </>
          )}
        </button>
      </div>
    </section>
  );
}
