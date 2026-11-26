import { useState } from 'react';
import { Download, Film, CheckCircle2, Loader2 } from 'lucide-react';
import type { LocalClipInfo, RenderResultManifest } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface VerticalPlayerCardProps {
  localClip: LocalClipInfo | null;
  result: RenderResultManifest | null;
}

export function VerticalPlayerCard({
  localClip,
  result,
}: VerticalPlayerCardProps) {
  const [isDownloading, setIsDownloading] = useState(false);

  const activeVideoUrl = result ? result.video_url : localClip ? localClip.objectUrl : null;
  const isFinishedOutput = Boolean(result);

  const handleDownloadMp4 = async () => {
    if (!result?.video_url || isDownloading) return;
    setIsDownloading(true);
    try {
      const response = await fetch(result.video_url);
      if (!response.ok) throw new Error('Direct download fallback');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `us-explainer-${result.job_id}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    } catch {
      const fallback = document.createElement('a');
      fallback.href = result.video_url;
      fallback.download = `us-explainer-${result.job_id}.mp4`;
      fallback.target = '_blank';
      fallback.rel = 'noreferrer';
      document.body.appendChild(fallback);
      fallback.click();
      document.body.removeChild(fallback);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <section
      aria-label="Vertical 1080x1920 Preview Player"
      className={`rounded-2xl border-2 bg-white p-5 flex flex-col ${
        isFinishedOutput ? 'border-[#00C853]' : 'border-[#E2E8F0]'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-3.5">
        <div>
          <h2 className="text-base font-extrabold text-[#0F172A]">
            {isFinishedOutput ? 'Finished 1080×1920 MP4' : 'Vertical Studio Preview'}
          </h2>
          <p className="text-xs font-medium text-[#64748B] mt-0.5">
            {isFinishedOutput
              ? 'Rendered & watermark-free US explainer clip'
              : localClip
              ? 'Previewing raw source clip prior to cloud render'
              : '9:16 vertical output frame'}
          </p>
        </div>

        {isFinishedOutput && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#00C853] text-white text-xs font-extrabold whitespace-nowrap shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.5} />
            <span>1080p</span>
          </span>
        )}
      </div>

      {/* 9:16 Vertical Video Frame */}
      <div className="w-full max-w-[290px] mx-auto aspect-[9/16] rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden flex items-center justify-center">
        {activeVideoUrl ? (
          <video
            key={activeVideoUrl}
            src={activeVideoUrl}
            controls
            playsInline
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <div className="w-full h-full bg-[#F4F6F9] flex flex-col items-center justify-center p-6 text-center">
            <div className="w-12 h-12 rounded-xl border-2 border-[#CBD5E1] bg-white text-[#64748B] flex items-center justify-center mb-3">
              <Film className="w-6 h-6" strokeWidth={2} />
            </div>
            <p className="text-sm font-extrabold text-[#334155]">
              9:16 Preview Ready
            </p>
            <p className="text-xs font-medium text-[#64748B] mt-1">
              Drop a raw clip on the left to inspect it, or run a 7GB cloud render to play your finished MP4 here.
            </p>
          </div>
        )}
      </div>

      {/* Output Specs & Emerald Green Download CTA */}
      <div className="mt-4 space-y-3">
        {result ? (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-bold text-[#334155] font-mono-tabular">
              <span>
                {result.width}×{result.height}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(result.duration_sec)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(result.file_size_bytes)}</span>
            </div>

            <button
              type="button"
              onClick={handleDownloadMp4}
              disabled={isDownloading}
              className="w-full py-3 px-4 rounded-xl border-2 border-[#00A344] bg-[#00C853] hover:bg-[#00B24A] text-white font-extrabold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer whitespace-nowrap"
            >
              {isDownloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.5} />
                  <span>Preparing MP4...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" strokeWidth={2.5} />
                  <span>Download MP4</span>
                </>
              )}
            </button>
          </>
        ) : (
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-center text-xs font-semibold text-[#64748B]">
            Download MP4 unlocks once cloud render completes
          </div>
        )}
      </div>
    </section>
  );
}
