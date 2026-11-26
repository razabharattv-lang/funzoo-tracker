import {
  Cpu,
  Globe2,
  Mic,
  Play,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import type {
  AiEnginePreference,
  OutputLanguage,
  VoiceGender,
} from '../types/studio';

interface ExplainerControlsProps {
  language: OutputLanguage;
  voiceGender: VoiceGender;
  aiEngine: AiEnginePreference;
  customAngle: string;
  canRun: boolean;
  isRendering: boolean;
  onLanguageChange: (lang: OutputLanguage) => void;
  onVoiceGenderChange: (gender: VoiceGender) => void;
  onAiEngineChange: (engine: AiEnginePreference) => void;
  onCustomAngleChange: (value: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

const LOCKED_ENGINE_OPTIONS: { id: AiEnginePreference; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'gemini-3.8-flash', label: 'Gemini' },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'NVIDIA NIM' },
];

export function ExplainerControls({
  language,
  voiceGender,
  aiEngine,
  customAngle,
  canRun,
  isRendering,
  onLanguageChange,
  onVoiceGenderChange,
  onAiEngineChange,
  onCustomAngleChange,
  onGenerate,
  onCancel,
}: ExplainerControlsProps) {
  const selectedEngineValue: AiEnginePreference =
    aiEngine === 'auto' || aiEngine === 'gemini-3.8-flash'
      ? aiEngine
      : 'nvidia/nemotron-3.5-super-vl-120b-a12b';

  return (
    <section
      aria-label="2. Translation & Voiceover"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-4"
    >
      <div className="flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg bg-[#00BFA5] text-white flex items-center justify-center shrink-0">
          <SlidersHorizontal className="w-4 h-4" strokeWidth={2.5} />
        </span>
        <h2 className="text-base font-extrabold text-[#0F172A]">
          2. Translation &amp; Voiceover
        </h2>
      </div>

      {/* Output Language & Voice Gender Toggles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div className="space-y-2">
          <label className="text-xs font-extrabold text-[#334155] flex items-center gap-1.5">
            <Globe2 className="w-3.5 h-3.5 text-[#00BFA5]" strokeWidth={2.5} />
            <span>Language</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'en', label: 'English (USA)' },
                { id: 'hi', label: 'Hindi' },
              ] as const
            ).map((opt) => {
              const active = language === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isRendering}
                  onClick={() => onLanguageChange(opt.id)}
                  className={`px-3 py-2.5 rounded-xl border-2 text-xs font-extrabold transition-colors cursor-pointer disabled:opacity-55 whitespace-nowrap ${
                    active
                      ? 'border-[#00BFA5] bg-[#00BFA5] text-white'
                      : 'border-[#E2E8F0] bg-[#F4F6F9] text-[#334155] hover:border-[#00BFA5]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-extrabold text-[#334155] flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-[#00BFA5]" strokeWidth={2.5} />
            <span>Voice</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'male', label: 'Male' },
                { id: 'female', label: 'Female' },
              ] as const
            ).map((opt) => {
              const active = voiceGender === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isRendering}
                  onClick={() => onVoiceGenderChange(opt.id)}
                  className={`px-3 py-2.5 rounded-xl border-2 text-xs font-extrabold transition-colors cursor-pointer disabled:opacity-55 whitespace-nowrap ${
                    active
                      ? 'border-[#00BFA5] bg-[#00BFA5] text-white'
                      : 'border-[#E2E8F0] bg-[#F4F6F9] text-[#334155] hover:border-[#00BFA5]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Engine Selector */}
      <div className="space-y-1.5">
        <label
          htmlFor="ai-engine-select"
          className="text-xs font-extrabold text-[#334155] flex items-center gap-1.5"
        >
          <Cpu className="w-3.5 h-3.5 text-[#3D5AFE]" strokeWidth={2.5} />
          <span>Engine</span>
        </label>
        <select
          id="ai-engine-select"
          disabled={isRendering}
          value={selectedEngineValue}
          onChange={(e) => onAiEngineChange(e.target.value as AiEnginePreference)}
          className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2.5 text-xs font-bold text-[#0F172A] focus:border-[#3D5AFE] focus:bg-white focus:outline-none disabled:opacity-55 cursor-pointer"
        >
          {LOCKED_ENGINE_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Optional Key Points */}
      <div>
        <textarea
          id="translation-context-notes"
          aria-label="Key points to keep (optional)"
          rows={2}
          disabled={isRendering}
          value={customAngle}
          onChange={(e) => onCustomAngleChange(e.target.value)}
          placeholder="Key points to keep (optional)..."
          className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2 text-xs font-semibold text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#3D5AFE] focus:bg-white focus:outline-none disabled:opacity-55 resize-none"
        />
      </div>

      {/* Primary Coral CTA */}
      {isRendering ? (
        <button
          type="button"
          onClick={onCancel}
          className="w-full py-3.5 px-5 rounded-xl border-2 border-[#0F172A] bg-[#0F172A] hover:bg-[#1E293B] text-white text-sm font-extrabold flex items-center justify-center gap-2 transition-colors cursor-pointer"
        >
          <Square className="w-4 h-4 fill-current" />
          <span>Stop Pipeline</span>
        </button>
      ) : (
        <button
          type="button"
          disabled={!canRun}
          onClick={onGenerate}
          className="w-full py-3.5 px-5 rounded-xl border-2 border-[#FF1744] bg-[#FF1744] hover:bg-[#E0123A] text-white text-sm font-extrabold flex items-center justify-center gap-2 transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Run Pipeline</span>
        </button>
      )}
    </section>
  );
}
