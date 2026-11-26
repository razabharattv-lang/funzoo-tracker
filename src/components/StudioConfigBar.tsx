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
import type { CloudEnvConfig } from '../types/studio';
import { getMissingConfigFields } from '../lib/env';

interface StudioConfigBarProps {
  config: CloudEnvConfig;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSave: (next: CloudEnvConfig) => void;
  onClear: () => void;
}

export function StudioConfigBar({
  config,
  isExpanded,
  onToggleExpand,
  onSave,
  onClear,
}: StudioConfigBarProps) {
  const [draft, setDraft] = useState<CloudEnvConfig>(config);
  const [showToken, setShowToken] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const missing = getMissingConfigFields(config);
  const isConfigured = missing.length === 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(draft);
    setJustSaved(true);
    window.setTimeout(() => {
      setJustSaved(false);
    }, 1800);
  };

  return (
    <section
      aria-label="Studio Keys and Configuration"
      className={`rounded-2xl border-2 bg-white overflow-hidden transition-colors ${
        isExpanded
          ? 'border-[#3D5AFE]'
          : isConfigured
          ? 'border-[#E2E8F0]'
          : 'border-[#FFAB00]'
      }`}
    >
      {/* Collapsible Top Summary Strip */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className={`w-full px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
          isExpanded
            ? 'bg-[#EEF2FF] border-b-2 border-[#3D5AFE]'
            : 'bg-white hover:bg-[#F8FAFC]'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              isConfigured
                ? 'bg-[#00C853] text-white'
                : 'bg-[#FFAB00] text-[#0F172A]'
            }`}
          >
            <KeyRound className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-extrabold text-[#0F172A] whitespace-nowrap">
                Studio Keys &amp; Config
              </span>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-extrabold whitespace-nowrap ${
                  isConfigured
                    ? 'bg-[#00C853] text-white'
                    : 'bg-[#FFAB00] text-[#0F172A]'
                }`}
              >
                {isConfigured ? 'Keys Ready' : `${missing.length} Missing`}
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-[#475569] truncate">
                {config.repoOwner}/{config.repoName}
              </span>
            </div>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-[#E2E8F0] bg-white text-xs font-extrabold text-[#0F172A] whitespace-nowrap shrink-0">
          <span>{isExpanded ? 'Hide Config' : 'Configure Keys'}</span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
          )}
        </span>
      </button>

      {/* Collapsible Drawer Body */}
      {isExpanded && (
        <form onSubmit={handleSubmit} className="p-5 space-y-4 bg-white">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* GitHub Token */}
            <div>
              <label
                htmlFor="studio-github-token"
                className="block text-xs font-extrabold text-[#0F172A] mb-1.5"
              >
                GitHub Token (workflow &amp; actions scope)
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

            {/* Cloudinary Cloud Name */}
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

            {/* Cloudinary Upload Preset */}
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
                placeholder="e.g. us_explainer_unsigned"
                className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-xs font-bold text-[#0F172A] font-mono-tabular placeholder:text-[#94A3B8] focus:bg-white focus:border-[#3D5AFE] focus:outline-none"
              />
            </div>
          </div>

          {/* Repository Target (defaults to razabharattv-lang / funzoo-tracker) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
            <div>
              <label
                htmlFor="studio-repo-owner"
                className="block text-xs font-bold text-[#475569] mb-1"
              >
                GitHub Repo Owner
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
                GitHub Repo Name
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
                Workflow Branch
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

          {/* Action Footer */}
          <div className="pt-3 border-t-2 border-[#F1F5F9] flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium text-[#64748B]">
              Stored locally in your browser&apos;s <span className="font-mono-tabular font-bold text-[#334155]">localStorage</span> only — never committed to GitHub. Keep <span className="font-mono-tabular font-bold text-[#334155]">GEMINI_API_KEY</span> in GitHub Actions Secrets.
            </p>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClear}
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
                <span>{justSaved ? 'Saved Locally' : 'Save Config'}</span>
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
