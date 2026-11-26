import { Clock, Copy, Check, Film, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDuration } from '../lib/videoProbe';
import type { SavedRenderRecord } from '../types/studio';

interface RecentRendersViewProps {
  records: SavedRenderRecord[];
  onDelete: (runTag: string) => void;
  onBackToStudio: () => void;
}

export function RecentRendersView({
  records,
  onDelete,
  onBackToStudio,
}: RecentRendersViewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  if (records.length === 0) {
    return (
      <section className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-10 text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-[#EEF2FF] text-[#3D5AFE] flex items-center justify-center mx-auto">
          <Film className="w-6 h-6" strokeWidth={2.25} />
        </div>
        <h2 className="text-lg font-extrabold text-[#0F172A]">
          No Recent Renders Saved Yet
        </h2>
        <p className="text-xs font-semibold text-[#64748B] max-w-md mx-auto">
          Completed clip runs save their Titles, Descriptions, Tags, Hashtags, and Best Upload Times here for quick reuse.
        </p>
        <button
          type="button"
          onClick={onBackToStudio}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#3D5AFE] bg-[#3D5AFE] text-white text-xs font-extrabold cursor-pointer"
        >
          Return to Studio Workspace
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-[#0F172A]">
            Recent Production Runs ({records.length})
          </h2>
          <p className="text-xs font-semibold text-[#64748B]">
            Saved SEO copy packages from previous renders in this browser
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {records.map((rec) => {
          const primary = rec.clips[0];
          const copyKey = `${rec.runTag}-meta`;
          const bundleText = primary
            ? `Title: ${primary.metadata.title}\n\nDescription:\n${primary.metadata.description}\n\nTags: ${primary.metadata.tags}\n\nHashtags: ${primary.metadata.hashtags}\n\nBest Upload Time: ${primary.metadata.postingTime}`
            : '';

          return (
            <article
              key={rec.runTag}
              className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-[#0F172A] truncate">
                    {primary?.metadata.title || rec.sourceLabel}
                  </h3>
                  <p className="text-[11px] font-semibold text-[#64748B] flex items-center gap-1.5 mt-0.5 font-mono-tabular">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(rec.completedAt).toLocaleString()}</span>
                    <span>·</span>
                    <span>{formatDuration(rec.sourceDurationSec)}</span>
                    <span>·</span>
                    <span>
                      {rec.clips.length} clip{rec.clips.length > 1 ? 's' : ''}
                    </span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => onDelete(rec.runTag)}
                  aria-label="Delete render record"
                  className="p-1.5 rounded-lg border-2 border-[#E2E8F0] text-[#64748B] hover:border-[#FF1744] hover:text-[#FF1744] cursor-pointer shrink-0"
                >
                  <Trash2 className="w-4 h-4" strokeWidth={2.25} />
                </button>
              </div>

              {primary && (
                <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3 space-y-1.5 text-xs">
                  <p className="font-bold text-[#334155] line-clamp-2">
                    {primary.metadata.description}
                  </p>
                  <p className="font-semibold text-[#3D5AFE] truncate">
                    {primary.metadata.hashtags}
                  </p>
                  <p className="font-semibold text-[#007A33]">
                    {primary.metadata.postingTime}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => copyText(copyKey, bundleText)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-[#00C853] bg-[#00C853] hover:bg-[#00B248] text-white text-xs font-extrabold cursor-pointer"
                >
                  {copiedId === copyKey ? (
                    <>
                      <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                      <span>Copied All 5 Cards</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" strokeWidth={2.5} />
                      <span>Copy All 5 SEO Cards</span>
                    </>
                  )}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
