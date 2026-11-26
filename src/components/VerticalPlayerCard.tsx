import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Film, Loader2 } from 'lucide-react';
import type {
  LocalClipInfo,
  RenderedClipItem,
  RenderResultManifest,
} from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface VerticalPlayerCardProps {
  localClip: LocalClipInfo | null;
  result: RenderResultManifest | null;
  activeClip: RenderedClipItem | null;
  totalClips: number;
}

export function VerticalPlayerCard({
  localClip,
  result,
  activeClip,
  totalClips,
}: VerticalPlayerCardProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  const activeVideoUrl = activeClip
    ? activeClip.video_url
    : result
    ? result.video_url
    : localClip
    ? localClip.objectUrl
    : null;
  const isFinishedOutput = Boolean(activeClip || result);

  useEffect(() => {
    setVideoFailed(false);
  }, [activeVideoUrl]);

  const clipWidth = activeClip?.width ?? result?.width ?? 1080;
  const clipHeight = activeClip?.height ?? result?.height ?? 1920;
  const clipDuration = activeClip?.duration_sec ?? result?.duration_sec ?? 0;
  const clipBytes = activeClip?.file_size_bytes ?? result?.file_size_bytes ?? 0;
  const clipDelogo =
    activeClip?.watermark_boxes_removed ?? result?.watermark_boxes_removed ?? 0;
  const clipTrendsCount =
    activeClip?.youtube_trends_count ?? result?.youtube_trends_count ?? 0;
  const qualityBadge = clipWidth >= 1000 ? '1080p' : '720p';

  const handleDownloadMp4 = async () => {
    const downloadUrl = activeClip?.video_url ?? result?.video_url;
    if (!downloadUrl || !result || isDownloading || videoFailed) return;
    const clipSuffix =
      totalClips > 1 && activeClip ? `-clip${activeClip.clip_index}` : '';
    const fileName = `explainer-${result.run_tag}${clipSuffix}.mp4`;

    // Instant local download for in-browser Blob URLs
    if (downloadUrl.startsWith('blob:')) {
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return;
    }

    setIsDownloading(true);
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error('Direct download fallback');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    } catch {
      const fallback = document.createElement('a');
      fallback.href = downloadUrl;
      fallback.download = fileName;
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
      aria-label="Vertical 9:16 Video Player"
      className={`rounded-2xl border-2 bg-white p-5 flex flex-col ${
        isFinishedOutput ? 'border-[#00C853]' : 'border-[#E2E8F0]'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-3.5">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-[#0F172A] truncate">
            {isFinishedOutput
              ? totalClips > 1 && activeClip
                ? `Clip ${activeClip.clip_index} of ${totalClips} · ${clipWidth}×${clipHeight}`
                : `Finished ${clipWidth}×${clipHeight} MP4`
              : '9:16 Preview Player'}
          </h2>
          <p className="text-xs font-medium text-[#64748B] mt-0.5 truncate">
            {isFinishedOutput
              ? `${result?.language === 'hi' ? 'Hindi' : 'English (USA)'} · ${clipTrendsCount} YouTube trends analyzed`
              : localClip
              ? 'Previewing local source video before GPU render'
              : 'Paste any video link or upload a file to render'}
          </p>
        </div>

        {isFinishedOutput && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#00C853] text-white text-xs font-extrabold whitespace-nowrap shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.5} />
            <span>{qualityBadge}</span>
          </span>
        )}
      </div>

      {isFinishedOutput && totalClips > 1 && activeClip?.reason && (
        <div className="mb-3 rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] px-3 py-2 text-xs font-bold text-[#1E3A8A]">
          <span>{activeClip.reason}</span>
          <span className="font-mono-tabular text-[#3D5AFE] ml-1.5">
            ({formatDuration(activeClip.start_sec)} – {formatDuration(activeClip.end_sec)})
          </span>
        </div>
      )}

      <div className="w-full max-w-[290px] mx-auto aspect-[9/16] rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden flex items-center justify-center">
        {activeVideoUrl && !videoFailed ? (
          <video
            key={activeVideoUrl}
            src={activeVideoUrl}
            controls
            playsInline
            onError={() => setVideoFailed(true)}
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <div className="w-full h-full bg-[#F4F6F9] flex flex-col items-center justify-center p-6 text-center">
            <div className="w-12 h-12 rounded-xl border-2 border-[#CBD5E1] bg-white text-[#64748B] flex items-center justify-center mb-3">
              <Film className="w-6 h-6" strokeWidth={2} />
            </div>
            <p className="text-sm font-extrabold text-[#334155]">
              {videoFailed ? 'Session Video Expired' : '9:16 Output Ready'}
            </p>
            <p className="text-xs font-medium text-[#64748B] mt-1">
              {videoFailed
                ? 'Local browser MP4 blobs clear on page reload. Your metadata deck is ready to copy on the right, or re-render for a fresh MP4.'
                : 'Your finished watermark-free 9:16 explainer MP4 plays directly from browser memory once the GPU render finishes.'}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {isFinishedOutput ? (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-bold text-[#334155] font-mono-tabular">
              <span>
                {clipWidth}×{clipHeight}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(clipDuration)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(clipBytes)}</span>
              {clipDelogo > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{clipDelogo} delogo</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleDownloadMp4()}
              disabled={isDownloading || videoFailed}
              className="w-full py-3 px-4 rounded-xl border-2 border-[#00A344] bg-[#00C853] hover:bg-[#00B24A] text-white font-extrabold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              {isDownloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.5} />
                  <span>Preparing MP4...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" strokeWidth={2.5} />
                  <span>
                    {videoFailed
                      ? 'Re-render to Download MP4'
                      : totalClips > 1 && activeClip
                      ? `Download Clip ${activeClip.clip_index} MP4`
                      : 'Download MP4'}
                  </span>
                </>
              )}
            </button>

            <p className="text-center text-[11px] font-bold text-[#64748B]">
              Hardware-rendered directly in your browser — instant local MP4 download.
            </p>
          </>
        ) : (
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-center text-xs font-semibold text-[#64748B]">
            Instant Download MP4 unlocks when GPU render finishes
          </div>
        )}
      </div>
    </section>
  );
}
