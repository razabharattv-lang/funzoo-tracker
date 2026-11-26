import {
  Box,
  Check,
  Cpu,
  FileText,
  Film,
  Layers,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  DocumentaryInputKind,
  DocumentaryStyle,
} from '../types/studio';

interface DocumentaryInputCardProps {
  style: DocumentaryStyle;
  inputKind: DocumentaryInputKind;
  inputText: string;
  useExternalGpu: boolean;
  externalGpuAvailable: boolean;
  disabled: boolean;
  isPlanningOutline: boolean;
  error: string | null;
  onStyleChange: (style: DocumentaryStyle) => void;
  onInputKindChange: (kind: DocumentaryInputKind) => void;
  onInputTextChange: (text: string) => void;
  onToggleExternalGpu: (useExternal: boolean) => void;
  onPreviewOutline: () => void;
}

const STYLE_OPTIONS: {
  id: DocumentaryStyle;
  label: string;
  hint: string;
  icon: typeof Film;
}[] = [
  {
    id: 'documentary',
    label: 'Documentary',
    hint: 'Cinema grid & lighting',
    icon: Film,
  },
  {
    id: 'motion_graphics',
    label: 'Motion Graphics',
    hint: 'Neon vector HUD',
    icon: Layers,
  },
  {
    id: '3d_blender',
    label: '3D Blender',
    hint: 'Sculpted 3D shaders',
    icon: Box,
  },
];

export function DocumentaryInputCard({
  style,
  inputKind,
  inputText,
  useExternalGpu,
  externalGpuAvailable,
  disabled,
  isPlanningOutline,
  error,
  onStyleChange,
  onInputKindChange,
  onInputTextChange,
  onToggleExternalGpu,
  onPreviewOutline,
}: DocumentaryInputCardProps) {
  const hasContent = inputText.trim().length >= 6;

  return (
    <section
      aria-label="Documentary, Motion Graphics and 3D Blender Input"
      className={`rounded-2xl border-2 p-5 space-y-4 transition-colors ${
        hasContent ? 'border-[#3D5AFE] bg-white' : 'border-[#E2E8F0] bg-white'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-[#0F172A]">
              1. Script, Topic &amp; Visual Style
            </h2>
            <p className="text-xs font-medium text-[#64748B]">
              Auto-architected multi-chapter Documentary, Motion Graphics or 3D-Blender Shorts
            </p>
          </div>
        </div>
      </div>

      {/* Style Selector */}
      <div className="grid grid-cols-3 gap-2">
        {STYLE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = style === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={disabled || isPlanningOutline}
              aria-pressed={active}
              onClick={() => onStyleChange(opt.id)}
              className={`rounded-xl border-2 px-3 py-2.5 text-left transition-colors cursor-pointer disabled:opacity-55 ${
                active
                  ? 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]'
                  : 'border-[#E2E8F0] bg-[#F4F6F9] text-[#334155] hover:border-[#3D5AFE]'
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <Icon className="w-4 h-4 shrink-0" strokeWidth={2.5} />
                {active && (
                  <span className="w-4 h-4 rounded-full bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
                )}
              </div>
              <p className="text-xs font-extrabold mt-1.5 whitespace-nowrap truncate">
                {opt.label}
              </p>
              <p className="text-[10px] font-semibold opacity-80 truncate">
                {opt.hint}
              </p>
            </button>
          );
        })}
      </div>

      {/* Input Kind Switch (Topic / Idea vs Paste Full Script) */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || isPlanningOutline}
          aria-pressed={inputKind === 'topic'}
          onClick={() => onInputKindChange('topic')}
          className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-full border-2 text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap ${
            inputKind === 'topic'
              ? 'bg-[#00BFA5] border-[#009E88] text-white'
              : 'bg-white border-[#E2E8F0] text-[#334155] hover:border-[#00BFA5]'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" strokeWidth={2.5} />
          <span>Topic / Idea</span>
        </button>

        <button
          type="button"
          disabled={disabled || isPlanningOutline}
          aria-pressed={inputKind === 'script'}
          onClick={() => onInputKindChange('script')}
          className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-full border-2 text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap ${
            inputKind === 'script'
              ? 'bg-[#00BFA5] border-[#009E88] text-white'
              : 'bg-white border-[#E2E8F0] text-[#334155] hover:border-[#00BFA5]'
          }`}
        >
          <FileText className="w-3.5 h-3.5" strokeWidth={2.5} />
          <span>Paste Full Script</span>
        </button>
      </div>

      {/* Topic or Full Script Textarea */}
      <div className="rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] p-3.5 space-y-2.5">
        <div className="relative">
          <textarea
            id="documentary-topic-or-script"
            rows={inputKind === 'script' ? 5 : 3}
            maxLength={5000}
            disabled={disabled || isPlanningOutline}
            value={inputText}
            onChange={(e) => onInputTextChange(e.target.value)}
            placeholder={
              inputKind === 'script'
                ? 'Paste your full documentary or explainer narration script (paragraphs become synced visual chapters)...'
                : 'Enter a gripping topic or idea (e.g., "How Deep-Sea Cables Survive 1000x Ocean Pressure" or "Why Black Holes Evaporate")...'
            }
            className="w-full rounded-xl border-2 border-[#3D5AFE] bg-white pl-3.5 pr-9 py-2.5 text-sm font-semibold text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none disabled:opacity-55 resize-y"
          />
          {inputText && !disabled && !isPlanningOutline && (
            <button
              type="button"
              onClick={() => onInputTextChange('')}
              aria-label="Clear topic or script"
              className="absolute right-2.5 top-2.5 p-1 rounded-md text-[#64748B] hover:text-[#FF1744] cursor-pointer"
            >
              <X className="w-4 h-4" strokeWidth={2.5} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono-tabular text-[11px] font-bold text-[#334155]">
            {inputText.trim().split(/\s+/).filter(Boolean).length} words ·{' '}
            {inputKind === 'script' ? 'Script-to-Chapters' : 'Topic-to-Series'}
          </span>

          <button
            type="button"
            disabled={!hasContent || disabled || isPlanningOutline}
            onClick={onPreviewOutline}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-[#3D5AFE] bg-[#3D5AFE] hover:bg-[#2F49E6] text-white text-xs font-extrabold transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            {isPlanningOutline ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.5} />
                <span>Planning Chapters...</span>
              </>
            ) : (
              <>
                <Layers className="w-3.5 h-3.5" strokeWidth={2.5} />
                <span>Preview Chapter Outline</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Optional External GPU Worker Toggle */}
      <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-[#0F172A] text-white flex items-center justify-center shrink-0">
            <Cpu className="w-4 h-4" strokeWidth={2.25} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold text-[#0F172A] truncate">
              External GPU Worker (FLUX / TRELLIS / Magpie / LipSync)
            </p>
            <p className="text-[11px] font-medium text-[#64748B] truncate">
              {externalGpuAvailable
                ? useExternalGpu
                  ? 'Enabled — offloads heavy 3D/Image & TTS assets with browser WebGL2 fallback'
                  : 'Off — using built-in zero-wait Browser WebGL2 3D/Motion Shader'
                : 'Optional endpoint not set — using built-in Browser WebGL2 3D/Motion Shader'}
            </p>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={useExternalGpu && externalGpuAvailable}
          disabled={disabled || !externalGpuAvailable}
          onClick={() => onToggleExternalGpu(!useExternalGpu)}
          className={`inline-flex items-center px-3 py-1 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 ${
            useExternalGpu && externalGpuAvailable
              ? 'bg-[#00BFA5] border-[#009E88] text-white'
              : 'bg-white border-[#CBD5E1] text-[#475569]'
          }`}
        >
          <span>{useExternalGpu && externalGpuAvailable ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-3.5 py-2.5 text-xs font-bold text-[#B71C1C]"
        >
          {error}
        </div>
      )}
    </section>
  );
}
