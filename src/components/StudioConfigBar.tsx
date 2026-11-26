import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Trash2,
} from 'lucide-react';
import type {
  CacheStorageSummary,
  OfflineModelStatus,
  StudioConfig,
} from '../types/studio';
import { hasExternalGpuConfigured } from '../lib/env';
import { PRE_EMBEDDED_MODEL_MANIFEST } from '../engine/cacheManager';

interface StudioConfigBarProps {
  config: StudioConfig;
  isExpanded: boolean;
  offlineModels?: OfflineModelStatus[];
  cacheSummary?: CacheStorageSummary | null;
  onToggleExpand: () => void;
  onSave: (next: StudioConfig) => void;
  onClearKeys: () => void;
}

export function StudioConfigBar({
  config,
  isExpanded,
  offlineModels = PRE_EMBEDDED_MODEL_MANIFEST,
  cacheSummary = null,
  onToggleExpand,
  onSave,
  onClearKeys,
}: StudioConfigBarProps) {
  const [draft, setDraft] = useState<StudioConfig>(config);
  const [showGemini, setShowGemini] = useState(false);
  const [showNvidia, setShowNvidia] = useState(false);
  const [showYoutube, setShowYoutube] = useState(false);
  const [showGpuKey, setShowGpuKey] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const hasExternalGpu = hasExternalGpuConfigured(config);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ ...draft, savedCharacters: config.savedCharacters });
    setJustSaved(true);
    window.setTimeout(() => {
      setJustSaved(false);
    }, 1800);
  };

  const isDiscreet = !isExpanded;
  const cachedCount = offlineModels.filter((m) => m.cached).length;
  const totalKB = Math.round(
    (cacheSummary?.totalCachedBytes ?? 350 * 1024) / 1024
  );

  const connectedServices: string[] = [`${cachedCount}/4 Offline Models Cached`];
  if (config.geminiApiKey) {
    connectedServices.push('Gemini Key Ready');
  } else {
    connectedServices.push('Server AI / Key');
  }
  if (config.nvidiaApiKey) connectedServices.push('NVIDIA NIM');
  if (config.youtubeApiKey) connectedServices.push('YouTube');
  if (config.cloudinaryCloudName && config.cloudinaryUploadPreset) {
    connectedServices.push('Cloudinary');
  }
  if (hasExternalGpu) {
    connectedServices.push('External GPU');
  }

  return (
    <section
      aria-label="Studio Engine, Pre-Embedded Offline Models & Optional Integrations"
      className={`rounded-2xl border-2 bg-white overflow-hidden transition-colors ${
        isExpanded ? 'border-[#3D5AFE]' : 'border-[#E2E8F0]'
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
            className={`rounded-lg flex items-center justify-center shrink-0 bg-[#00C853] text-white ${
              isDiscreet ? 'w-6 h-6' : 'w-8 h-8'
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
              Studio Engine &amp; Offline Cache
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-extrabold whitespace-nowrap bg-[#00BFA5] text-white">
              <Database className="w-3 h-3" strokeWidth={2.5} />
              <span>Cache API + IDB ({totalKB} KB)</span>
            </span>
            <span className="font-mono-tabular text-xs font-semibold text-[#64748B] truncate">
              {connectedServices.join(' · ')}
            </span>
            {config.savedCharacters.length > 0 && (
              <span className="text-xs font-semibold text-[#64748B] whitespace-nowrap">
                · {config.savedCharacters.length} Character
                {config.savedCharacters.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:text-[#0F172A] whitespace-nowrap shrink-0">
          <span>{isExpanded ? 'Close' : 'Engine & Keys'}</span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
          )}
        </span>
      </button>

      {isExpanded && (
        <div className="p-5 space-y-5 bg-white">
          {/* Pre-Embedded Lightweight Offline Models & Persistent Browser Cache Grid */}
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-md bg-[#00BFA5] text-white flex items-center justify-center shrink-0">
                  <Cpu className="w-3.5 h-3.5" strokeWidth={2.5} />
                </span>
                <span className="text-xs font-extrabold text-[#0F172A]">
                  Pre-Embedded Lightweight Offline Models (Low-Heat Phone Safe)
                </span>
              </div>
              <span className="font-mono-tabular text-[11px] font-extrabold text-[#00A344] bg-white px-2.5 py-0.5 rounded-md border-2 border-[#E2E8F0]">
                Persistent Cache API + IndexedDB Active ({totalKB} KB)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {offlineModels.map((model) => (
                <div
                  key={model.id}
                  className="rounded-lg border-2 border-[#E2E8F0] bg-white p-2.5 flex flex-col justify-between gap-1"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-[11px] font-extrabold text-[#0F172A] truncate">
                      {model.label}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-[#00C853] text-white shrink-0">
                      Cached
                    </span>
                  </div>
                  <span className="text-[10px] font-semibold text-[#64748B] truncate">
                    {model.engine}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Gemini API Key (Used for 6-Frame Video Inspection, Script, Metadata & TTS) */}
              <div>
                <label
                  htmlFor="studio-gemini-key"
                  className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
                >
                  Gemini API Key (gemini-2.5-flash / TTS)
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
                    placeholder="AIzaSy... (or configured via GitHub Secret)"
                    className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGemini((v) => !v)}
                    aria-label={
                      showGemini ? 'Hide Gemini key' : 'Show Gemini key'
                    }
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
                  NVIDIA NIM Key (Optional — Nemotron, Mistral 4, Riva)
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
                    aria-label={
                      showNvidia ? 'Hide NVIDIA key' : 'Show NVIDIA key'
                    }
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
                  YouTube Data API v3 Key (Optional — Live US Trends &amp; Tags)
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
                    placeholder="Optional YouTube Data v3 key"
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

            {/* Optional External GPU Worker Endpoint */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1 border-t-2 border-[#F1F5F9]">
              <div>
                <label
                  htmlFor="studio-external-gpu-endpoint"
                  className="block text-xs font-bold text-[#475569] mb-1"
                >
                  External GPU Worker URL (Optional — FLUX / TRELLIS / Magpie /
                  LipSync)
                </label>
                <input
                  id="studio-external-gpu-endpoint"
                  type="url"
                  autoComplete="off"
                  value={draft.externalGpuEndpoint}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      externalGpuEndpoint: e.target.value,
                    }))
                  }
                  placeholder="https://your-gpu-worker.example.com"
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="studio-external-gpu-key"
                  className="block text-xs font-bold text-[#475569] mb-1"
                >
                  External GPU Worker Key / Bearer Token (Optional)
                </label>
                <div className="relative">
                  <input
                    id="studio-external-gpu-key"
                    type={showGpuKey ? 'text' : 'password'}
                    autoComplete="off"
                    value={draft.externalGpuKey}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        externalGpuKey: e.target.value,
                      }))
                    }
                    placeholder="Optional Bearer token"
                    className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGpuKey((v) => !v)}
                    aria-label={showGpuKey ? 'Hide GPU key' : 'Show GPU key'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                  >
                    {showGpuKey ? (
                      <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                    ) : (
                      <Eye className="w-4 h-4" strokeWidth={2.25} />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t-2 border-[#F1F5F9] flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs font-medium text-[#64748B]">
                Pre-embedded offline models (Scene/Logo Scanner, Word Aligner,
                Face Rig &amp; Script Engine) are persistently cached in Cache
                API + IndexedDB so phone CPU/RAM stays cool while cloud &amp;
                external GPU endpoints remain ready.
              </p>

              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={onClearKeys}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:border-[#FF1744] hover:text-[#FF1744] hover:bg-[#FFF1F3] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
                  <span>Reset Optional</span>
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
        </div>
      )}
    </section>
  );
}
