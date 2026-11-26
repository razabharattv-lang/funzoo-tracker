import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  KeyRound,
  Trash2,
} from 'lucide-react';
import type { StudioConfig } from '../types/studio';
import { getMissingConfigFields, isAutoWiredFromBuild } from '../lib/env';

interface StudioConfigBarProps {
  config: StudioConfig;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSave: (next: StudioConfig) => void;
  onClearKeys: () => void;
}

export function StudioConfigBar({
  config,
  isExpanded,
  onToggleExpand,
  onSave,
  onClearKeys,
}: StudioConfigBarProps) {
  const [draft, setDraft] = useState<StudioConfig>(config);
  const [showGemini, setShowGemini] = useState(false);
  const [showNvidia, setShowNvidia] = useState(false);
  const [showYoutube, setShowYoutube] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const missing = getMissingConfigFields(config);
  const isConfigured = missing.length === 0;
  const autoWired = isAutoWiredFromBuild();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ ...draft, savedCharacters: config.savedCharacters });
    setJustSaved(true);
    window.setTimeout(() => {
      setJustSaved(false);
    }, 1800);
  };

  const isDiscreet = autoWired && isConfigured && !isExpanded;

  const connectedServices: string[] = [];
  if (config.geminiApiKey) connectedServices.push('Gemini');
  if (config.nvidiaApiKey) connectedServices.push('NVIDIA');
  if (config.youtubeApiKey) connectedServices.push('YouTube');
  if (config.cloudinaryCloudName && config.cloudinaryUploadPreset) {
    connectedServices.push('Cloudinary');
  }

  return (
    <section
      aria-label="In-Browser Studio API Configuration"
      className={`rounded-2xl border-2 bg-white overflow-hidden transition-colors ${
        isExpanded
          ? 'border-[#3D5AFE]'
          : isConfigured
          ? 'border-[#E2E8F0]'
          : 'border-[#FFAB00]'
      }`}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className={`w-full flex flex-wrap items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
          isDiscreet ? 'px-4 py-2 bg-white hover:bg-[#F8FAFC]' : 'px-5 py-3'
        } ${
          isExpanded
            ? 'bg-[#EEF2FF] border-b-2 border-[#3D5AFE]'
            : !isDiscreet
            ? 'bg-white hover:bg-[#F8FAFC]'
            : ''
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`rounded-lg flex items-center justify-center shrink-0 ${
              isDiscreet ? 'w-6 h-6' : 'w-8 h-8'
            } ${
              isConfigured
                ? 'bg-[#00C853] text-white'
                : 'bg-[#FFAB00] text-[#0F172A]'
            }`}
          >
            <KeyRound
              className={isDiscreet ? 'w-3.5 h-3.5' : 'w-4 h-4'}
              strokeWidth={2.5}
            />
          </span>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span
              className={`font-extrabold text-[#0F172A] whitespace-nowrap ${
                isDiscreet ? 'text-xs' : 'text-sm'
              }`}
            >
              {autoWired ? 'Browser Engine Ready' : 'Studio API Config'}
            </span>
            {!isDiscreet && (
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-extrabold whitespace-nowrap ${
                  isConfigured
                    ? 'bg-[#00C853] text-white'
                    : 'bg-[#FFAB00] text-[#0F172A]'
                }`}
              >
                {isConfigured ? 'Ready' : `${missing.length} Missing`}
              </span>
            )}
            {connectedServices.length > 0 && (
              <span className="font-mono-tabular text-xs font-semibold text-[#64748B] truncate">
                {connectedServices.join(' · ')}
              </span>
            )}
            {config.savedCharacters.length > 0 && (
              <span className="text-xs font-semibold text-[#64748B] whitespace-nowrap">
                · {config.savedCharacters.length} Character
                {config.savedCharacters.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:text-[#0F172A] whitespace-nowrap shrink-0">
          <span>
            {isExpanded
              ? 'Close'
              : autoWired
              ? 'API Keys'
              : 'Configure Keys'}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
          )}
        </span>
      </button>

      {isExpanded && (
        <form onSubmit={handleSubmit} className="p-5 space-y-4 bg-white">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Gemini API Key (Required) */}
            <div>
              <label
                htmlFor="studio-gemini-key"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                Gemini API Key (Required — Vision, TTS &amp; Outfit)
              </label>
              <div className="relative">
                <input
                  id="studio-gemini-key"
                  type={showGemini ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.geminiApiKey}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      geminiApiKey: e.target.value,
                    }))
                  }
                  placeholder="AIzaSy..."
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGemini((v) => !v)}
                  aria-label={showGemini ? 'Hide Gemini key' : 'Show Gemini key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  {showGemini ? (
                    <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                  ) : (
                    <Eye className="w-4 h-4" strokeWidth={2.25} />
                  )}
                </button>
              </div>
            </div>

            {/* NVIDIA NIM API Key (Optional) */}
            <div>
              <label
                htmlFor="studio-nvidia-key"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                NVIDIA API Key (Optional — Llama-3.3-70B)
              </label>
              <div className="relative">
                <input
                  id="studio-nvidia-key"
                  type={showNvidia ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.nvidiaApiKey}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      nvidiaApiKey: e.target.value,
                    }))
                  }
                  placeholder="nvapi-..."
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowNvidia((v) => !v)}
                  aria-label={showNvidia ? 'Hide NVIDIA key' : 'Show NVIDIA key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  {showNvidia ? (
                    <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                  ) : (
                    <Eye className="w-4 h-4" strokeWidth={2.25} />
                  )}
                </button>
              </div>
            </div>

            {/* YouTube Data API v3 Key (Optional) */}
            <div>
              <label
                htmlFor="studio-youtube-key"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                YouTube Data API v3 Key (US Trends &amp; Chapters)
              </label>
              <div className="relative">
                <input
                  id="studio-youtube-key"
                  type={showYoutube ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.youtubeApiKey}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      youtubeApiKey: e.target.value,
                    }))
                  }
                  placeholder="AIzaSy..."
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowYoutube((v) => !v)}
                  aria-label={
                    showYoutube ? 'Hide YouTube key' : 'Show YouTube key'
                  }
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  {showYoutube ? (
                    <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                  ) : (
                    <Eye className="w-4 h-4" strokeWidth={2.25} />
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Optional Cloudinary Portrait Storage & Character URL */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="studio-cloudinary-cloud"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Cloudinary Cloud Name (Optional — Portraits)
              </label>
              <input
                id="studio-cloudinary-cloud"
                type="text"
                autoComplete="off"
                value={draft.cloudinaryCloudName}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    cloudinaryCloudName: e.target.value,
                  }))
                }
                placeholder="e.g. dxyz12345 (blank = browser storage)"
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="studio-cloudinary-preset"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Cloudinary Unsigned Preset (Optional)
              </label>
              <input
                id="studio-cloudinary-preset"
                type="text"
                autoComplete="off"
                value={draft.cloudinaryUploadPreset}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    cloudinaryUploadPreset: e.target.value,
                  }))
                }
                placeholder="e.g. explainer_unsigned"
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="studio-character-url"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Character Portrait URL (Auto-Synced)
              </label>
              <input
                id="studio-character-url"
                type="url"
                autoComplete="off"
                value={draft.characterImageUrl}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    characterImageUrl: e.target.value,
                  }))
                }
                placeholder="https://res.cloudinary.com/.../portrait.jpg"
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#FFAB00] focus:outline-none"
              />
            </div>
          </div>

          <div className="pt-3 border-t-2 border-[#F1F5F9] flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium text-[#64748B]">
              {autoWired
                ? 'API keys are auto-wired from GitHub Secrets on GitHub Pages. Everything runs 100% inside your browser GPU (WebGL2 + WebCodecs Worker) with zero GitHub Actions wait.'
                : 'Saved locally in browser localStorage for instant preview. On GitHub Pages, repository secrets auto-wire automatically.'}
            </p>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClearKeys}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:border-[#FF1744] hover:text-[#FF1744] hover:bg-[#FFF1F3] transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
                <span>Reset Keys</span>
              </button>

              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border-2 border-[#00A344] bg-[#00C853] hover:bg-[#00B24A] text-white text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" strokeWidth={3} />
                <span>{justSaved ? 'Saved!' : 'Save Config'}</span>
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
