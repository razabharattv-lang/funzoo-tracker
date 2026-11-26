import { useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Download,
  FileText,
  Film,
  Hash,
  Tag,
  Type,
} from 'lucide-react';
import { formatBytes, formatDuration } from '../lib/videoProbe';
import type { RenderedClipOutput } from '../types/studio';

interface OutputDeckCardProps {
  clips: RenderedClipOutput[];
  runTag: string | null;
}

export function OutputDeckCard({ clips, runTag }: OutputDeckCardProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const safeIdx = Math.min(selectedIdx, Math.max(0, clips.length - 1));
  const activeClip = clips[safeIdx] ?? null;

  const copyField = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard API fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    }
  };

  const handleDownload = (clip: RenderedClipOutput) => {
    const ext = clip.mimeType.includes('webm') ? 'webm' : 'mp4';
    const baseName = (runTag || 'studio-clip').replace(/[^a-zA-Z0-9_-]/g, '-');
    const fileName = `${baseName}-clip-${clip.clipIndex}.${ext}`;
    const anchor = document.createElement('a');
    anchor.href = clip.videoUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const copyCards = activeClip
    ? [
        {
          key: 'title',
          label: '1. Title',
          icon: Type,
          value: activeClip.metadata.title,
        },
        {
          key: 'description',
          label: '2. Description',
          icon: FileText,
          value: activeClip.metadata.description,
        },
        {
          key: 'tags',
          label: '3. Tags',
          icon: Tag,
          value: activeClip.metadata.tags,
        },
        {
          key: 'hashtags',
          label: '4. Hashtags',
          icon: Hash,
          value: activeClip.metadata.hashtags,
        },
        {
          key: 'posting_time',
          label: '5. Best Upload Time (USA EST + India IST)',
          icon: Clock,
          value: activeClip.metadata.postingTime,
        },
      ]
    : [];

  return (
    <section
      aria-label="Final Production Output Deck"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-[#00C853] text-white flex items-center justify-center shrink-0">
            <Film className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <div>
            <h2 className="text-base font-extrabold text-[#0F172A]">
              Card 2 · Final Production Output Deck
            </h2>
            <p className="text-xs font-medium text-[#64748B]">
              {activeClip
                ? `${activeClip.renderEngine} · ${activeClip.metadata.scriptEngine}`
                : 'Finished video clips, MP4 download, and 5 one-click SEO copy cards appear here'}
            </p>
          </div>
        </div>

        {clips.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {clips.map((c, idx) => (
              <button
                key={c.clipIndex}
                type="button"
                onClick={() => setSelectedIdx(idx)}
                className={`px-3 py-1 rounded-full border-2 text-xs font-extrabold transition-colors cursor-pointer ${
                  idx === safeIdx
                    ? 'border-[#00BFA5] bg-[#00BFA5] text-white'
                    : 'border-[#E2E8F0] bg-[#F4F6F9] text-[#334155] hover:border-[#00BFA5]'
                }`}
              >
                Clip {c.clipIndex}
              </button>
            ))}
          </div>
        )}
      </div>

      {!activeClip ? (
        <div className="rounded-xl border-2 border-dashed border-[#CBD5E1] bg-[#F4F6F9] px-5 py-12 text-center space-y-1.5">
          <p className="text-sm font-extrabold text-[#334155]">
            Ready to produce your finished clip &amp; 5 copy cards
          </p>
          <p className="text-xs font-medium text-[#64748B]">
            Run the 5-step pipeline to preview your clean graded video, download MP4, and copy Title, Description, Tags, Hashtags, and Best Upload Time (EST/IST).
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Output Video Player + Download Button */}
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#0F172A] overflow-hidden flex items-center justify-center max-h-[380px]">
            <video
              key={activeClip.videoUrl}
              src={activeClip.videoUrl}
              controls
              playsInline
              className="w-full max-h-[380px] object-contain"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-[#334155] font-mono-tabular">
              <span>{formatDuration(activeClip.durationSec)}</span>
              <span aria-hidden="true">·</span>
              <span>
                {activeClip.width}×{activeClip.height} @ {activeClip.fps}fps
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(activeClip.fileSizeBytes)}</span>
              {activeClip.watermarkBoxesRemoved > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#00BFA5]">
                    {activeClip.watermarkBoxesRemoved} Logo Patch
                    {activeClip.watermarkBoxesRemoved > 1 ? 'es' : ''}
                  </span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => handleDownload(activeClip)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#00C853] bg-[#00C853] hover:bg-[#00B248] text-white text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4" strokeWidth={2.5} />
              <span>
                {activeClip.mimeType.includes('webm')
                  ? `Download Clip ${activeClip.clipIndex} (WebM)`
                  : `Download MP4 (Clip ${activeClip.clipIndex})`}
              </span>
            </button>
          </div>

          {/* Direct Translation Script Strip */}
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-[#0F172A]">
                Direct Translation Voiceover Script ({activeClip.voiceEngine})
              </span>
              <button
                type="button"
                onClick={() => copyField('script', activeClip.metadata.voiceover)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#00C853] bg-white hover:bg-[#00C853] text-[#008A38] hover:text-white text-[11px] font-extrabold transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedKey === 'script' ? (
                  <>
                    <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" strokeWidth={2.5} />
                    <span>Copy Script</span>
                  </>
                )}
              </button>
            </div>
            <p className="text-xs font-semibold text-[#334155] leading-relaxed whitespace-pre-wrap">
              {activeClip.metadata.voiceover}
            </p>
          </div>

          {/* 5 One-Click Copy SEO Cards */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-[#475569]">
              5 One-Click Upload Copy Cards
            </h3>

            <div className="grid grid-cols-1 gap-2.5">
              {copyCards.map((card) => {
                const Icon = card.icon;
                const isCopied = copiedKey === card.key;
                return (
                  <div
                    key={card.key}
                    className="rounded-xl border-2 border-[#E2E8F0] bg-white p-3.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-extrabold text-[#0F172A] flex items-center gap-1.5">
                        <Icon
                          className="w-3.5 h-3.5 text-[#3D5AFE] shrink-0"
                          strokeWidth={2.5}
                        />
                        <span>{card.label}</span>
                      </span>

                      <button
                        type="button"
                        onClick={() => copyField(card.key, card.value)}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg border-2 text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          isCopied
                            ? 'border-[#00C853] bg-[#00C853] text-white'
                            : 'border-[#00C853] bg-[#E8F9EE] text-[#007A33] hover:bg-[#00C853] hover:text-white'
                        }`}
                      >
                        {isCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" strokeWidth={2.5} />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>

                    <p className="text-xs font-semibold text-[#334155] leading-relaxed whitespace-pre-wrap break-words">
                      {card.value}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
