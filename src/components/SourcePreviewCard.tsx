import { Clapperboard, Scissors, Trash2 } from 'lucide-react';
import type { SourceMediaItem } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface SourcePreviewCardProps {
  source: SourceMediaItem | null;
  disabled: boolean;
  onClear: () => void;
}

/**
 * Compact Card 1 — Fetched / Imported Source Preview
 * Displayed directly beneath the Universal Video Link / Local Upload card
 * BEFORE rendering starts, showing duration, resolution, and detected mode badge.
 */
export function SourcePreviewCard({
  source,
  disabled,
  onClear,
}: SourcePreviewCardProps) {
  if (!source) return null;

  const isLong = source.mode === 'long';
  const isHorizontal = source.width > source.height;

  return (
    <section
      aria-label="Fetched or Imported Source Preview"
      className="rounded-2xl border-2 border-[#3D5AFE] bg-white overflow-hidden"
    >
      <div className="px-4 py-3 bg-[#EEF2FF] border-b-2 border-[#3D5AFE] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
            {isLong ? (
              <Scissors className="w-4 h-4" strokeWidth={2.5} />
            ) : (
              <Clapperboard className="w-4 h-4" strokeWidth={2.5} />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-extrabold text-[#0F172A] truncate">
              Source Video Preview
            </h2>
            <p className="text-[11px] font-semibold text-[#334155] truncate">
              {source.platform} · Ready before render
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-extrabold whitespace-nowrap ${
              isLong
                ? 'bg-[#3D5AFE] text-white'
                : 'bg-[#00BFA5] text-white'
            }`}
          >
            {isLong ? 'Long Video Viral Clipper' : 'Short Explainer'}
          </span>
          {!disabled && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear source preview"
              className="p-1.5 rounded-lg border-2 border-[#CBD5E1] bg-white text-[#64748B] hover:border-[#FF1744] hover:text-[#FF1744] transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      <div className="p-4 flex flex-col sm:flex-row items-center gap-4">
        <div
          className={`rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden shrink-0 ${
            isHorizontal
              ? 'w-full sm:w-[210px] aspect-video'
              : 'w-[132px] aspect-[9/16]'
          }`}
        >
          <video
            key={source.objectUrl}
            src={source.objectUrl}
            controls
            playsInline
            preload="metadata"
            className="w-full h-full object-contain bg-black"
          />
        </div>

        <div className="flex-1 min-w-0 w-full space-y-2.5">
          <p
            className="text-xs font-extrabold text-[#0F172A] truncate"
            title={source.label}
          >
            {source.label}
          </p>

          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-2.5 py-2">
              <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">
                Duration
              </p>
              <p className="font-mono-tabular text-xs font-extrabold text-[#0F172A] mt-0.5">
                {formatDuration(source.durationSec)}
              </p>
            </div>

            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-2.5 py-2">
              <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">
                Resolution
              </p>
              <p className="font-mono-tabular text-xs font-extrabold text-[#0F172A] mt-0.5">
                {source.width}×{source.height}
              </p>
            </div>

            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-2.5 py-2">
              <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">
                Size
              </p>
              <p className="font-mono-tabular text-xs font-extrabold text-[#0F172A] mt-0.5">
                {formatBytes(source.sizeBytes)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#F4F6F9] border border-[#CBD5E1] text-[11px] font-bold text-[#334155]">
              {isLong
                ? '18-Keyframe Video-First Clipper -> 3–5 Locked Clips (30s / 40s / 60s)'
                : 'Video-First Clean Lock -> Beat-Synced Short (12s–45s)'}
            </span>
            {source.trimSocialEndCard && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#FFF8E1] border border-[#FFAB00] text-[11px] font-extrabold text-[#78350F]">
                Auto-cuts creator bumper
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
