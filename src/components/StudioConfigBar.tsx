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
  const [showToken, setShowToken] = useState(false);
  const [showCookie, setShowCookie] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const missing = getMissingConfigFields(config, false);
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

  return (
    <section
      aria-label="Studio Fallback Configuration"
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
              {autoWired ? 'Auto-Wired Ready' : 'Studio Fallback Config'}
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
            <span className="font-mono-tabular text-xs font-semibold text-[#64748B] truncate">
              {config.repoOwner}/{config.repoName}
            </span>
            {config.savedCharacters.length > 0 && (
              <span className="text-xs font-semibold text-[#64748B] whitespace-nowrap">
                · {config.savedCharacters.length} Character
                {config.savedCharacters.length === 1 ? '' : 's'}
              </span>
            )}
            {config.sessionCookie && (
              <span className="text-xs font-semibold text-[#3D5AFE] whitespace-nowrap">
                · Cookie Set
              </span>
            )}
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:text-[#0F172A] whitespace-nowrap shrink-0">
          <span>
            {isExpanded
              ? 'Close'
              : autoWired
              ? 'Fallback Drawer'
              : 'Fallback Setup'}
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
            <div>
              <label
                htmlFor="studio-github-token"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                GitHub Token (actions &amp; workflow scope)
              </label>
              <div className="relative">
                <input
                  id="studio-github-token"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.githubToken}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, githubToken: e.target.value }))
                  }
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? 'Hide GitHub token' : 'Show GitHub token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  {showToken ? (
                    <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                  ) : (
                    <Eye className="w-4 h-4" strokeWidth={2.25} />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="studio-cloudinary-cloud"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                Cloudinary Cloud Name
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
                placeholder="e.g. dxyz12345"
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="studio-cloudinary-preset"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                Cloudinary Unsigned Upload Preset
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
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>
          </div>

          {/* Optional Session Cookie & Character Portrait URL */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="studio-session-cookie"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                Session Cookie (Optional — Restricted Links Only)
              </label>
              <div className="relative">
                <input
                  id="studio-session-cookie"
                  type={showCookie ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft.sessionCookie}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, sessionCookie: e.target.value }))
                  }
                  placeholder="Optional Cookie header (a1=...; web_session=...) for login-walled links"
                  className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] pl-3.5 pr-10 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowCookie((v) => !v)}
                  aria-label={showCookie ? 'Hide session cookie' : 'Show session cookie'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  {showCookie ? (
                    <EyeOff className="w-4 h-4" strokeWidth={2.25} />
                  ) : (
                    <Eye className="w-4 h-4" strokeWidth={2.25} />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="studio-character-url"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                Character Portrait URL (Auto-Synced on Upload)
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
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#FFAB00] focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="studio-repo-owner"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Repo Owner
              </label>
              <input
                id="studio-repo-owner"
                type="text"
                value={draft.repoOwner}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, repoOwner: e.target.value }))
                }
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="studio-repo-name"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Repo Name
              </label>
              <input
                id="studio-repo-name"
                type="text"
                value={draft.repoName}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, repoName: e.target.value }))
                }
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="studio-repo-branch"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                Branch
              </label>
              <input
                id="studio-repo-branch"
                type="text"
                value={draft.githubBranch}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, githubBranch: e.target.value }))
                }
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2 text-xs font-bold text-[#0F172A] font-mono-tabular focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>
          </div>

          <div className="pt-3 border-t-2 border-[#F1F5F9] flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium text-[#64748B]">
              {autoWired
                ? 'Auto-wired from GitHub Secrets at build time. Use this drawer only for fallback overrides or optional Session Cookies.'
                : 'Saved locally in browser localStorage. On GitHub Pages, GH_PAT & Cloudinary secrets auto-wire automatically.'}
            </p>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClearKeys}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#475569] hover:border-[#FF1744] hover:text-[#FF1744] hover:bg-[#FFF1F3] transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
                <span>Clear Keys</span>
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
