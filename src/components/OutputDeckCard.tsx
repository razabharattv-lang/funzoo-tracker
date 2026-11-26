import { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileText,
  Film,
  Hash,
  MessageSquareText,
  Tag,
  Type,
} from 'lucide-react';
import type { DocumentaryStyle, RenderedClipOutput } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface OutputDeckCardProps {
  runTag: string | null;
  clips: RenderedClipOutput[];
  isRendering: boolean;
  sourceDurationSec?: number;
}

interface MetadataFieldSpec {
  key: 'title' | 'description' | 'tags' | 'hashtags' | 'postingTime';
  label: string;
  accentBorder: string;
  headerTint: string;
  iconBg: string;
  iconText: string;
  icon: typeof Type;
}

const METADATA_FIELDS: MetadataFieldSpec[] = [
  {
    key: 'title',
    label: 'Title',
    accentBorder: 'border-[#FF1744]',
    headerTint: 'bg-[#FFF1F3]',
    iconBg: 'bg-[#FF1744]',
    iconText: 'text-white',
    icon: Type,
  },
  {
    key: 'description',
    label: 'Description',
    accentBorder: 'border-[#3D5AFE]',
    headerTint: 'bg-[#EEF2FF]',
    iconBg: 'bg-[#3D5AFE]',
    iconText: 'text-white',
    icon: FileText,
  },
  {
    key: 'tags',
    label: 'Tags',
    accentBorder: 'border-[#00BFA5]',
    headerTint: 'bg-[#E6FAF7]',
    iconBg: 'bg-[#00BFA5]',
    iconText: 'text-white',
    icon: Tag,
  },
  {
    key: 'hashtags',
    label: 'Hashtags',
    accentBorder: 'border-[#D98E00]',
    headerTint: 'bg-[#FFF8E1]',
    iconBg: 'bg-[#FFAB00]',
    iconText: 'text-[#0F172A]',
    icon: Hash,
  },
  {
    key: 'postingTime',
    label: 'Best Upload Time (USA EST + India IST)',
    accentBorder: 'border-[#00C853]',
    headerTint: 'bg-[#E8F8EE]',
    iconBg: 'bg-[#00C853]',
    iconText: 'text-white',
    icon: Clock,
  },
];

function styleBadgeText(style?: DocumentaryStyle): string {
  if (style === '3d_blender') return '3D Blender';
  if (style === 'motion_graphics') return 'Motion Graphics';
  if (style === 'documentary') return 'Documentary';
  return 'Explainer';
}

function ClipOutputBlock({
  clip,
  runTag,
}: {
  clip: RenderedClipOutput;
  runTag: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [videoExpired, setVideoExpired] = useState(false);

  const qualityBadge = clip.width >= 1000 ? '1080p' : '720p';
  const isDoc = clip.studioMode === 'documentary';
  const unitLabel = isDoc ? 'Chapter' : 'Clip';

  const handleCopy = async (key: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 1800);
  };

  const handleCopyAll = () => {
    const bundle = [
      `TITLE:\n${clip.metadata.title}`,
      `DESCRIPTION:\n${clip.metadata.description}`,
      `TAGS:\n${clip.metadata.tags}`,
      `HASHTAGS:\n${clip.metadata.hashtags}`,
      `BEST UPLOAD TIME (USA EST + INDIA IST):\n${clip.metadata.postingTime}`,
    ].join('\n\n');
    void handleCopy('all', bundle);
  };

  const handleDownloadMp4 = () => {
    if (!clip.videoUrl || videoExpired) return;
    const prefix = isDoc ? 'doc' : 'explainer';
    const suffix = clip.totalClips > 1 ? `-${unitLabel.toLowerCase()}${clip.clipIndex}` : '';
    const fileName = `${prefix}-${runTag}${suffix}.mp4`;
    const anchor = document.createElement('a');
    anchor.href = clip.videoUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <article className="rounded-2xl border-2 border-[#00C853] bg-white overflow-hidden">
      {/* Clip Header Bar */}
      <div className="px-4 py-3 bg-[#E8F8EE] border-b-2 border-[#00C853] flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#00C853] text-white text-xs font-extrabold whitespace-nowrap">
              <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.5} />
              <span>
                {clip.totalClips > 1
                  ? `${unitLabel} ${clip.clipIndex} of ${clip.totalClips}`
                  : 'Production Ready'}
              </span>
            </span>
            {isDoc && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[#3D5AFE] text-white text-[11px] font-extrabold whitespace-nowrap">
                {styleBadgeText(clip.documentaryStyle)}
              </span>
            )}
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white border border-[#00A344] text-[11px] font-extrabold text-[#065F46] font-mono-tabular whitespace-nowrap">
              {qualityBadge} · {clip.fps}fps
            </span>
            <span className="font-mono-tabular text-xs font-bold text-[#065F46]">
              {formatDuration(clip.startSec)}–{formatDuration(clip.endSec)}
            </span>
          </div>
          <p className="text-xs font-bold text-[#0F172A] mt-1 truncate">
            {clip.reason} ·{' '}
            {clip.language === 'hi' ? 'Hindi' : 'English (USA)'} ·{' '}
            {clip.metadata.youtubeTrendsCount} US trends analyzed
          </p>
        </div>

        <button
          type="button"
          onClick={handleCopyAll}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            copiedKey === 'all'
              ? 'bg-[#00C853] border-[#00A344] text-white'
              : 'bg-white border-[#00A344] text-[#065F46] hover:bg-[#00C853] hover:text-white'
          }`}
        >
          {copiedKey === 'all' ? (
            <>
              <Check className="w-3.5 h-3.5" strokeWidth={3} />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" strokeWidth={2.25} />
              <span>Copy All 5</span>
            </>
          )}
        </button>
      </div>

      {/* Compact Two-Column Clip Preview + 5 Individual Copy Cards */}
      <div className="p-4 grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Left: Compact 9:16 Playable MP4 + Download Button */}
        <div className="xl:col-span-5 flex flex-col items-center space-y-3">
          <div className="w-full max-w-[240px] aspect-[9/16] rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden flex items-center justify-center">
            {clip.videoUrl && !videoExpired ? (
              <video
                key={clip.videoUrl}
                src={clip.videoUrl}
                controls
                playsInline
                onError={() => setVideoExpired(true)}
                className="w-full h-full object-contain bg-black"
              />
            ) : (
              <div className="w-full h-full bg-[#F4F6F9] flex flex-col items-center justify-center p-5 text-center">
                <Film className="w-7 h-7 text-[#64748B] mb-2" strokeWidth={2} />
                <p className="text-xs font-extrabold text-[#334155]">
                  Session MP4 Cleared on Reload
                </p>
                <p className="text-[11px] font-medium text-[#64748B] mt-1">
                  All 5 metadata cards remain ready to copy. Re-render to export a fresh MP4.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] font-bold text-[#334155] font-mono-tabular">
            <span>
              {clip.width}×{clip.height}
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(clip.durationSec)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(clip.fileSizeBytes)}</span>
            {clip.watermarkBoxesRemoved > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{clip.watermarkBoxesRemoved} delogo</span>
              </>
            )}
            {clip.safeCropApplied && (
              <>
                <span aria-hidden="true">·</span>
                <span>safe edge crop</span>
              </>
            )}
            {clip.endCardTrimmedSec > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>-{clip.endCardTrimmedSec}s bumper</span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={handleDownloadMp4}
            disabled={videoExpired || !clip.videoUrl}
            className="w-full max-w-[240px] py-2.5 px-4 rounded-xl border-2 border-[#00A344] bg-[#00C853] hover:bg-[#00B24A] text-white font-extrabold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
          >
            <Download className="w-4 h-4" strokeWidth={2.5} />
            <span>
              {videoExpired
                ? 'Re-render for MP4'
                : clip.totalClips > 1
                ? `Download ${unitLabel} ${clip.clipIndex} MP4`
                : 'Download MP4'}
            </span>
          </button>
        </div>

        {/* Right: 5 Individual 1-Click Copy Metadata Cards + Narration Script */}
        <div className="xl:col-span-7 space-y-2.5">
          {METADATA_FIELDS.map((field) => {
            const Icon = field.icon;
            const value = clip.metadata[field.key];
            const isCopied = copiedKey === field.key;

            return (
              <div
                key={field.key}
                className={`rounded-xl border-2 bg-white overflow-hidden ${field.accentBorder}`}
              >
                <div
                  className={`px-3 py-1.5 flex items-center justify-between gap-2 border-b-2 ${field.headerTint} ${field.accentBorder}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${field.iconBg} ${field.iconText}`}
                    >
                      <Icon className="w-3 h-3" strokeWidth={2.5} />
                    </span>
                    <span className="text-xs font-extrabold text-[#0F172A] truncate">
                      {field.label}
                    </span>
                  </div>

                  <button
                    type="button"
                    disabled={!value}
                    onClick={() => void handleCopy(field.key, value)}
                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border-2 text-[11px] font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isCopied
                        ? 'bg-[#00C853] border-[#00A344] text-white'
                        : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:border-[#00C853] hover:bg-[#00C853] hover:text-white'
                    }`}
                  >
                    {isCopied ? (
                      <>
                        <Check className="w-3 h-3" strokeWidth={3} />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" strokeWidth={2.25} />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="px-3 py-2">
                  <p className="text-xs font-semibold text-[#0F172A] leading-relaxed break-words whitespace-pre-line">
                    {value}
                  </p>
                </div>
              </div>
            );
          })}

          {clip.metadata.voiceover && (
            <div className="rounded-xl border-2 border-[#E2E8F0] bg-white overflow-hidden">
              <div className="px-3 py-1.5 bg-[#F4F6F9] border-b-2 border-[#E2E8F0] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-5 h-5 rounded-md bg-[#0F172A] text-white flex items-center justify-center shrink-0">
                    <MessageSquareText className="w-3 h-3" strokeWidth={2.25} />
                  </span>
                  <span className="text-xs font-extrabold text-[#0F172A] truncate">
                    Commanding Script ({clip.voiceEngine})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void handleCopy('voiceover', clip.metadata.voiceover)
                  }
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border-2 text-[11px] font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    copiedKey === 'voiceover'
                      ? 'bg-[#00C853] border-[#00A344] text-white'
                      : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:border-[#00C853] hover:bg-[#00C853] hover:text-white'
                  }`}
                >
                  {copiedKey === 'voiceover' ? (
                    <>
                      <Check className="w-3 h-3" strokeWidth={3} />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" strokeWidth={2.25} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <div className="px-3 py-2">
                <p className="text-xs font-medium text-[#334155] leading-relaxed">
                  {clip.metadata.voiceover}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * Compact Card 2 — Final Production Output Deck
 * Placed directly below the progress bar. Lists ALL finished 9:16 MP4 clips or chapters
 * sequentially one after another, each with playable video, Download MP4, and
 * 5 individual 1-Click Copy cards.
 */
export function OutputDeckCard({
  runTag,
  clips,
  isRendering,
  sourceDurationSec,
}: OutputDeckCardProps) {
  if (clips.length === 0) {
    return (
      <section
        aria-label="Final Production Output Deck"
        className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-6"
      >
        <div className="flex flex-col items-center justify-center text-center py-8 px-4">
          <div className="w-12 h-12 rounded-xl border-2 border-[#CBD5E1] bg-[#F4F6F9] text-[#64748B] flex items-center justify-center mb-3">
            <Film className="w-6 h-6" strokeWidth={2} />
          </div>
          <h2 className="text-base font-extrabold text-[#0F172A]">
            Final Production Output Deck
          </h2>
          <p className="text-xs font-medium text-[#64748B] max-w-md mt-1">
            {isRendering
              ? 'Rendering your 9:16 hardware-accelerated MP4 clip(s) — each completed clip and its 5 one-click copy cards appear here immediately as it finishes.'
              : 'Your finished watermark-free 9:16 MP4 clip(s), Download MP4 button(s), and 5 one-click copy metadata cards appear here once rendering completes.'}
          </p>
        </div>
      </section>
    );
  }

  const isDocDeck = clips[0]?.studioMode === 'documentary';

  return (
    <section
      aria-label="Final Production Output Deck"
      className="space-y-4"
    >
      <div className="rounded-2xl border-2 border-[#E2E8F0] bg-white px-5 py-3.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-extrabold text-[#0F172A]">
            Final Production Output Deck
          </h2>
          <p className="text-xs font-medium text-[#64748B]">
            {clips.length > 1
              ? `${clips.length} ${isDocDeck ? 'documentary / 3D chapters' : 'viral 9:16 MP4 clips'} rendered${
                  sourceDurationSec
                    ? ` (${formatDuration(sourceDurationSec)} total)`
                    : ''
                } — preview, download & copy each below`
              : 'Hardware-rendered 9:16 MP4 with instant local download and 5 one-click copy cards'}
          </p>
        </div>

        <span className="inline-flex items-center px-3 py-1 rounded-full bg-[#00C853] text-white text-xs font-extrabold whitespace-nowrap">
          {clips.length}{' '}
          {clips.length === 1
            ? 'MP4 Ready'
            : isDocDeck
            ? 'Chapters Ready'
            : 'Clips Ready'}
        </span>
      </div>

      <div className="space-y-4">
        {clips.map((clip) => (
          <ClipOutputBlock
            key={`${runTag ?? 'out'}-${clip.clipIndex}`}
            clip={clip}
            runTag={runTag ?? 'studio'}
          />
        ))}
      </div>
    </section>
  );
}
