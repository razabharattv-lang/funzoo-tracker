import { Clapperboard, Layers, Scissors, Trash2 } from 'lucide-react';
import type {
  DocumentaryOutline,
  DocumentaryStyle,
  SourceMediaItem,
  StudioMode,
} from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface SourcePreviewCardProps {
  studioMode: StudioMode;
  source: SourceMediaItem | null;
  documentaryOutline: DocumentaryOutline | null;
  disabled: boolean;
  onClear: () => void;
}

function formatStyleLabel(style: DocumentaryStyle): string {
  if (style === '3d_blender') return '3D Blender';
  if (style === 'motion_graphics') return 'Motion Graphics';
  return 'Documentary';
}

/**
 * Compact Card 1 — Fetched / Imported Source Preview OR Documentary Chapter Outline Preview
 * Displayed directly beneath the left input card BEFORE final rendering starts.
 */
export function SourcePreviewCard({
  studioMode,
  source,
  documentaryOutline,
  disabled,
  onClear,
}: SourcePreviewCardProps) {
  if (studioMode === 'documentary') {
    if (!documentaryOutline) return null;

    return (
      <section
        aria-label="Documentary and 3D Chapter Outline Preview"
        className="rounded-2xl border-2 border-[#3D5AFE] bg-white overflow-hidden"
      >
        <div className="px-4 py-3 bg-[#EEF2FF] border-b-2 border-[#3D5AFE] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-7 h-7 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4" strokeWidth={2.5} />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-extrabold text-[#0F172A] truncate">
                {documentaryOutline.topicOrTitle}
              </h2>
              <p className="text-[11px] font-semibold text-[#334155] truncate">
                {documentaryOutline.plannerModel} ·{' '}
                {documentaryOutline.chapters.length} Chapters ·{' '}
                {documentaryOutline.totalDurationSec.toFixed(1)}s Total
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#3D5AFE] text-white text-[11px] font-extrabold whitespace-nowrap">
              {formatStyleLabel(documentaryOutline.style)}
            </span>
            {!disabled && (
              <button
                type="button"
                onClick={onClear}
                aria-label="Clear documentary outline preview"
                className="p-1.5 rounded-lg border-2 border-[#CBD5E1] bg-white text-[#64748B] hover:border-[#FF1744] hover:text-[#FF1744] transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        <div className="p-4 space-y-2.5">
          {documentaryOutline.chapters.map((ch) => (
            <div
              key={ch.chapterIndex}
              className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2.5 flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono-tabular text-[11px] font-extrabold px-2 py-0.5 rounded-md bg-[#0F172A] text-white">
                    CH {ch.chapterIndex}
                  </span>
                  <p className="text-xs font-extrabold text-[#0F172A] truncate">
                    {ch.title}
                  </p>
                </div>
                <p className="text-[11px] font-medium text-[#475569] mt-1 line-clamp-2">
                  {ch.rawNarration}
                </p>
              </div>
              <span className="font-mono-tabular text-xs font-extrabold text-[#3D5AFE] whitespace-nowrap shrink-0">
                {ch.targetDurationSec.toFixed(1)}s
              </span>
            </div>
          ))}
        </div>
      </section>
    );
  }

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
                ? '18-Keyframe Timeline Scan -> 3–5 Locked Clips (30s / 40s / 60s)'
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
