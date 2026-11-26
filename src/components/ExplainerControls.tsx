import { Check, Globe, Loader2, Mic, Play } from 'lucide-react';
import type {
  OutputLanguage,
  StudioControlsState,
  VoiceGender,
} from '../types/studio';

interface ExplainerControlsProps {
  controls: StudioControlsState;
  canGenerate: boolean;
  isRendering: boolean;
  onChange: (next: StudioControlsState) => void;
  onStartRender: () => void;
}

const LANGUAGE_OPTIONS: { id: OutputLanguage; label: string }[] = [
  { id: 'en', label: 'English (USA)' },
  { id: 'hi', label: 'Hindi' },
];

const VOICE_OPTIONS: { id: VoiceGender; label: string }[] = [
  { id: 'male', label: 'Male (Deep High-Energy)' },
  { id: 'female', label: 'Female (High-Energy)' },
];

export function ExplainerControls({
  controls,
  canGenerate,
  isRendering,
  onChange,
  onStartRender,
}: ExplainerControlsProps) {
  return (
    <section
      aria-label="Language, Voice and Custom Hook Controls"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-5"
    >
      {/* Output Language (Vivid Teal #00BFA5) */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-6 h-6 rounded-md bg-[#00BFA5] text-white flex items-center justify-center shrink-0">
            <Globe className="w-3.5 h-3.5" strokeWidth={2.5} />
          </span>
          <h2 className="text-sm font-extrabold text-[#0F172A]">
            3. Output Language
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {LANGUAGE_OPTIONS.map((opt) => {
            const active = controls.language === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={isRendering}
                aria-pressed={active}
                onClick={() => onChange({ ...controls, language: opt.id })}
                className={`flex items-center justify-between gap-2 px-4 py-2.5 rounded-full border-2 transition-colors cursor-pointer disabled:opacity-55 ${
                  active
                    ? 'bg-[#00BFA5] border-[#009E88] text-white'
                    : 'bg-white border-[#E2E8F0] text-[#0F172A] hover:border-[#00BFA5] hover:bg-[#E6FAF7]'
                }`}
              >
                <span className="text-xs font-extrabold whitespace-nowrap">
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

      {/* Voice Style (Vivid Teal #00BFA5) */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-6 h-6 rounded-md bg-[#00BFA5] text-white flex items-center justify-center shrink-0">
            <Mic className="w-3.5 h-3.5" strokeWidth={2.5} />
          </span>
          <h2 className="text-sm font-extrabold text-[#0F172A]">
            4. Voice Style
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {VOICE_OPTIONS.map((opt) => {
            const active = controls.voiceGender === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={isRendering}
                aria-pressed={active}
                onClick={() => onChange({ ...controls, voiceGender: opt.id })}
                className={`flex items-center justify-between gap-2 px-4 py-2.5 rounded-full border-2 transition-colors cursor-pointer disabled:opacity-55 ${
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

      {/* Custom Hook / Angle (Optional) */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <label
            htmlFor="custom-hook-angle"
            className="text-sm font-extrabold text-[#0F172A]"
          >
            5. Custom Suspense Hook / Angle (Optional)
          </label>
          <span className="font-mono-tabular text-xs font-semibold text-[#64748B]">
            {controls.customAngle.length}/320
          </span>
        </div>
        <textarea
          id="custom-hook-angle"
          rows={3}
          maxLength={320}
          disabled={isRendering}
          value={controls.customAngle}
          onChange={(e) => onChange({ ...controls, customAngle: e.target.value })}
          placeholder="Optional: Write a specific hook or story angle to steer the script. Leave blank and Gemini Vision will scan every second at 1 FPS automatically..."
          className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-sm font-medium text-[#0F172A] placeholder:text-[#64748B] focus:bg-white focus:border-[#3D5AFE] focus:outline-none disabled:opacity-55 resize-none transition-colors"
        />
      </div>

      {/* Primary CTA: Vibrant Coral Red (#FF1744) */}
      <button
        type="button"
        onClick={onStartRender}
        disabled={!canGenerate || isRendering}
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
            <span>Generate Production Video</span>
          </>
        )}
      </button>
    </section>
  );
}
