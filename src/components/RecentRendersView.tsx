import { ArrowUpRight, Film, Trash2 } from 'lucide-react';
import type { SavedRenderRecord } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface RecentRendersViewProps {
  records: SavedRenderRecord[];
  onLoadRecord: (record: SavedRenderRecord) => void;
  onDeleteRecord: (runTag: string) => void;
  onGoToStudio: () => void;
}

export function RecentRendersView({
  records,
  onLoadRecord,
  onDeleteRecord,
  onGoToStudio,
}: RecentRendersViewProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-[#0F172A]">
            Recent Studio Renders
          </h1>
          <p className="text-xs font-medium text-[#64748B] mt-0.5">
            Reload saved titles, descriptions, tags, hashtags, and scripts from your browser history.
          </p>
        </div>

        <button
          type="button"
          onClick={onGoToStudio}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] text-[#3D5AFE] hover:bg-[#3D5AFE] hover:text-white text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap"
        >
          <span>Back to Studio</span>
        </button>
      </div>

      {records.length === 0 ? (
        <div className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#EEF2FF] border-2 border-[#3D5AFE] text-[#3D5AFE] flex items-center justify-center mx-auto mb-4">
            <Film className="w-7 h-7" strokeWidth={2.25} />
          </div>
          <h2 className="text-lg font-extrabold text-[#0F172A]">
            No completed renders yet
          </h2>
          <p className="text-sm font-medium text-[#64748B] max-w-md mx-auto mt-1.5">
            Paste a video link, upload a clip, or enter a documentary script/topic in the Studio Workspace to render on your device GPU.
          </p>
          <button
            type="button"
            onClick={onGoToStudio}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border-2 border-[#D5002B] bg-[#FF1744] hover:bg-[#E5123B] text-white text-sm font-extrabold transition-colors cursor-pointer"
          >
            <span>Open Studio Workspace</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {records.map((record) => {
            const firstClip = record.clips[0];
            if (!firstClip) return null;
            const completedDate = record.completedAt
              ? new Date(record.completedAt).toLocaleString()
              : '';
            const isDoc =
              record.studioMode === 'documentary' ||
              record.mode === 'documentary';

            return (
              <article
                key={record.runTag}
                className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-4 flex flex-col justify-between gap-4 hover:border-[#3D5AFE] transition-colors"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-extrabold text-[#0F172A] leading-snug line-clamp-2">
                      {firstClip.metadata.title || record.sourceLabel}
                    </h3>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {record.clips.length > 1 && (
                        <span className="px-2 py-0.5 rounded-full bg-[#3D5AFE] text-white text-[11px] font-extrabold whitespace-nowrap">
                          {record.clips.length} {isDoc ? 'Ch' : 'Clips'}
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full bg-[#00C853] text-white text-[11px] font-extrabold whitespace-nowrap">
                        {firstClip.language === 'hi' ? 'Hindi' : 'US EN'}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs font-medium text-[#475569] line-clamp-2">
                    {firstClip.metadata.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#64748B] font-mono-tabular">
                    <span>{formatDuration(firstClip.durationSec)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(firstClip.fileSizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {firstClip.voiceGender === 'male' ? 'Fenrir Male' : 'Kore Female'}
                    </span>
                  </div>

                  {completedDate && (
                    <p className="text-[11px] font-medium text-[#94A3B8]">
                      {completedDate}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 border-t-2 border-[#F1F5F9]">
                  <button
                    type="button"
                    onClick={() => onLoadRecord(record)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border-2 border-[#3D5AFE] bg-[#EEF2FF] text-[#3D5AFE] hover:bg-[#3D5AFE] hover:text-white text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <span>Open in Studio</span>
                    <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteRecord(record.runTag)}
                    aria-label={`Remove ${
                      firstClip.metadata.title || record.runTag
                    }`}
                    className="p-2 rounded-lg border-2 border-[#E2E8F0] text-[#64748B] hover:border-[#FF1744] hover:text-[#FF1744] hover:bg-[#FFF1F3] transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={2.25} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
