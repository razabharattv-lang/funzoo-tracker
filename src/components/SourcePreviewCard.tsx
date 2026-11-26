import { Clock, Film, Loader2, Maximize2, Scissors } from 'lucide-react';
import { formatBytes, formatDuration } from '../lib/videoProbe';
import type { SourceMediaItem } from '../types/studio';

interface SourcePreviewCardProps {
  sourceMedia: SourceMediaItem | null;
  isFetchingLink: boolean;
}

export function SourcePreviewCard({
  sourceMedia,
  isFetchingLink,
}: SourcePreviewCardProps) {
  return (
    <section
      aria-label="Source Video Preview"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
            <Film className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <h2 className="text-base font-extrabold text-[#0F172A] truncate">
            Source Video Preview
          </h2>
        </div>

        {sourceMedia && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#00BFA5] text-white text-xs font-extrabold whitespace-nowrap shrink-0">
            <Scissors className="w-3.5 h-3.5" strokeWidth={2.5} />
            <span>
              {sourceMedia.mode === 'long'
                ? 'Long Video · 3 Highlight Clips'
                : 'Single Clip · Full Duration'}
            </span>
          </span>
        )}
      </div>

      {isFetchingLink ? (
        <div className="rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] px-4 py-10 flex flex-col items-center justify-center gap-2.5 text-center">
          <Loader2 className="w-7 h-7 text-[#3D5AFE] animate-spin" strokeWidth={2.5} />
          <p className="text-sm font-extrabold text-[#0F172A]">
            Resolving &amp; probing source video stream...
          </p>
          <p className="text-xs font-semibold text-[#475569]">
            Reading real duration, resolution, and playable frames
          </p>
        </div>
      ) : sourceMedia ? (
        <div className="space-y-3">
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden flex items-center justify-center max-h-[300px]">
            <video
              key={sourceMedia.objectUrl}
              src={sourceMedia.objectUrl}
              controls
              playsInline
              preload="metadata"
              className="w-full max-h-[300px] object-contain"
            />
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2">
              <p className="text-[11px] font-bold text-[#64748B] flex items-center gap-1">
                <Clock className="w-3 h-3 text-[#3D5AFE]" strokeWidth={2.5} />
                <span>Real Duration</span>
              </p>
              <p className="font-mono-tabular text-sm font-extrabold text-[#0F172A] mt-0.5">
                {formatDuration(sourceMedia.durationSec)}
              </p>
            </div>

            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2">
              <p className="text-[11px] font-bold text-[#64748B] flex items-center gap-1">
                <Maximize2 className="w-3 h-3 text-[#3D5AFE]" strokeWidth={2.5} />
                <span>Resolution</span>
              </p>
              <p className="font-mono-tabular text-sm font-extrabold text-[#0F172A] mt-0.5">
                {sourceMedia.width}×{sourceMedia.height}
              </p>
            </div>

            <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3 py-2">
              <p className="text-[11px] font-bold text-[#64748B]">File Size</p>
              <p className="font-mono-tabular text-sm font-extrabold text-[#0F172A] mt-0.5">
                {formatBytes(sourceMedia.sizeBytes)}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-[#CBD5E1] bg-[#F4F6F9] px-4 py-8 text-center">
          <p className="text-sm font-extrabold text-[#334155]">
            No video loaded yet.
          </p>
        </div>
      )}
    </section>
  );
}
