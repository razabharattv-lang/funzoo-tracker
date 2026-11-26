import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  Film,
  Hash,
  Tag,
  Type,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { formatBytes, formatDuration } from '../lib/videoProbe';
import { speakWithBrowserSpeech, stopBrowserSpeech } from '../engine/audioEngine';
import type { RenderedClipOutput } from '../types/studio';

interface OutputDeckCardProps {
  clips: RenderedClipOutput[];
  runTag: string | null;
  renderError?: string | null;
}

export function OutputDeckCard({
  clips,
  runTag,
  renderError = null,
}: OutputDeckCardProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [browserSpeechSyncEnabled, setBrowserSpeechSyncEnabled] = useState(true);
  const [videoDecodeError, setVideoDecodeError] = useState<string | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const safeIdx = Math.min(selectedIdx, Math.max(0, clips.length - 1));
  const activeClip = clips[safeIdx] ?? null;
  const isBrokenVideo = Boolean(
    activeClip &&
      (!activeClip.videoUrl || activeClip.fileSizeBytes <= 1024 || videoDecodeError)
  );
  const isBrowserSpeechClip = activeClip?.voiceSource === 'Browser-Speech';
  const hasMultipleClips = clips.length > 1;
  const isLandscapeClip = Boolean(activeClip && activeClip.width > activeClip.height * 1.15);

  const selectClipIndex = (nextIdx: number) => {
    if (clips.length === 0) return;
    const bounded = (nextIdx + clips.length) % clips.length;
    stopBrowserSpeech();
    setVideoDecodeError(null);
    setSelectedIdx(bounded);
  };

  useEffect(() => {
    return () => {
      stopBrowserSpeech();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, [activeClip?.videoUrl]);

  const scheduleCopiedReset = (key: string) => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    setCopiedKey(key);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
      copyTimerRef.current = null;
    }, 1800);
  };

  const copyField = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      scheduleCopiedReset(key);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.select();
        document.execCommand('copy');
        scheduleCopiedReset(key);
      } catch {
        // ignore clipboard fallback failure in locked-down browsers
      } finally {
        if (ta.parentNode) ta.parentNode.removeChild(ta);
      }
    }
  };

  const handleDownload = (clip: RenderedClipOutput) => {
    if (!clip.videoUrl) return;
    const ext = (clip.mimeType ?? '').includes('webm') ? 'webm' : 'mp4';
    const baseName = (runTag || 'studio-clip').replace(/[^a-zA-Z0-9_-]/g, '-');
    const fileName = `${baseName}-clip-${clip.clipIndex}.${ext}`;
    const anchor = document.createElement('a');
    anchor.href = clip.videoUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    }
  };

  const handleVideoPlay = () => {
    if (!activeClip || !isBrowserSpeechClip || !browserSpeechSyncEnabled) return;
    speakWithBrowserSpeech({
      scriptText: activeClip.metadata.voiceover,
      language: activeClip.language,
      voiceGender: activeClip.voiceGender,
      targetDurationSec: activeClip.durationSec,
    });
  };

  const handleVideoStop = () => {
    if (isBrowserSpeechClip) {
      stopBrowserSpeech();
    }
  };

  const copyCards = activeClip
    ? [
        {
          key: 'title',
          label: 'Title',
          icon: Type,
          value: activeClip.metadata.title,
        },
        {
          key: 'description',
          label: 'Description',
          icon: FileText,
          value: activeClip.metadata.description,
        },
        {
          key: 'tags',
          label: 'Tags',
          icon: Tag,
          value: activeClip.metadata.tags,
        },
        {
          key: 'hashtags',
          label: 'Hashtags',
          icon: Hash,
          value: activeClip.metadata.hashtags,
        },
        {
          key: 'posting_time',
          label: 'Upload Time (EST/IST)',
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
          <h2 className="text-base font-extrabold text-[#0F172A]">
            Final Production Output
          </h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {activeClip && (
            <span
              className={`px-2.5 py-1 rounded-full border-2 text-[11px] font-extrabold whitespace-nowrap ${
                activeClip.voiceSource === 'Gemini-TTS'
                  ? 'border-[#00C853] bg-[#E8F9EE] text-[#065F46]'
                  : 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]'
              }`}
            >
              Voice: {activeClip.voiceSource}
            </span>
          )}

          {hasMultipleClips &&
            clips.map((c, idx) => (
              <button
                key={c.clipIndex}
                type="button"
                onClick={() => selectClipIndex(idx)}
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
      </div>

      {!activeClip ? (
        renderError ? (
          <div
            role="alert"
            className="rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-4 py-5 flex items-start gap-3 text-left"
          >
            <AlertCircle
              className="w-5 h-5 text-[#FF1744] shrink-0 mt-0.5"
              strokeWidth={2.5}
            />
            <div className="space-y-1">
              <p className="text-sm font-extrabold text-[#B71C1C]">
                Video Export Failed
              </p>
              <p className="text-xs font-semibold text-[#991B1B] leading-relaxed">
                {renderError}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-dashed border-[#CBD5E1] bg-[#F4F6F9] px-5 py-10 text-center">
            <p className="text-sm font-extrabold text-[#334155]">
              No finished clip yet.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {/* Shorts-Style 9:16 Swipeable Multi-Clip Stage */}
          <div
            tabIndex={hasMultipleClips ? 0 : undefined}
            onKeyDown={(e) => {
              if (!hasMultipleClips) return;
              if (e.key === 'ArrowLeft') selectClipIndex(safeIdx - 1);
              if (e.key === 'ArrowRight') selectClipIndex(safeIdx + 1);
            }}
            onTouchStart={(e) => {
              const t = e.touches[0];
              touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
            }}
            onTouchEnd={(e) => {
              if (!hasMultipleClips || !touchStartRef.current) return;
              const t = e.changedTouches[0];
              const start = touchStartRef.current;
              touchStartRef.current = null;
              if (!t) return;
              const deltaX = t.clientX - start.x;
              const deltaY = t.clientY - start.y;
              if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
                selectClipIndex(deltaX < 0 ? safeIdx + 1 : safeIdx - 1);
              }
            }}
            className="relative rounded-2xl border-2 border-[#E2E8F0] bg-[#0F172A] p-3 flex flex-col items-center justify-center gap-3 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3D5AFE]"
          >
            {hasMultipleClips && (
              <div className="w-full flex items-center justify-between gap-2 px-1">
                <button
                  type="button"
                  onClick={() => selectClipIndex(safeIdx - 1)}
                  aria-label="Previous clip"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#334155] bg-[#1E293B] hover:border-[#00BFA5] text-white text-xs font-extrabold cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.5} />
                  <span>Prev</span>
                </button>

                <span className="px-3 py-0.5 rounded-full bg-[#1E293B] border border-[#334155] text-white text-[11px] font-extrabold font-mono-tabular">
                  Clip {safeIdx + 1} / {clips.length} · Swipe
                </span>

                <button
                  type="button"
                  onClick={() => selectClipIndex(safeIdx + 1)}
                  aria-label="Next clip"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#334155] bg-[#1E293B] hover:border-[#00BFA5] text-white text-xs font-extrabold cursor-pointer transition-colors"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />
                </button>
              </div>
            )}

            {isBrokenVideo ? (
              <div
                role="alert"
                className="w-full rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-4 py-6 flex items-start gap-3 text-left"
              >
                <AlertCircle
                  className="w-5 h-5 text-[#FF1744] shrink-0 mt-0.5"
                  strokeWidth={2.5}
                />
                <div className="space-y-1">
                  <p className="text-sm font-extrabold text-[#B71C1C]">
                    Video Playback Unavailable
                  </p>
                  <p className="text-xs font-semibold text-[#991B1B] leading-relaxed">
                    {videoDecodeError ||
                      'Video recorder produced an empty (<= 1 KB) file on this browser. Try Chrome/Safari desktop or a standard MP4 file.'}
                  </p>
                </div>
              </div>
            ) : (
              <div
                className={`w-full overflow-hidden rounded-xl bg-black flex items-center justify-center ${
                  isLandscapeClip
                    ? 'max-w-[540px] aspect-video'
                    : 'max-w-[320px] aspect-[9/16]'
                }`}
              >
                <video
                  key={activeClip.videoUrl}
                  src={activeClip.videoUrl}
                  controls
                  playsInline
                  muted={isBrowserSpeechClip && browserSpeechSyncEnabled}
                  onPlay={handleVideoPlay}
                  onPause={handleVideoStop}
                  onEnded={handleVideoStop}
                  onError={() =>
                    setVideoDecodeError(
                      'This browser could not decode the recorded video stream. Re-run or test on Chrome/Safari desktop.'
                    )
                  }
                  className="w-full h-full object-contain"
                />
              </div>
            )}
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

            <div className="flex items-center gap-2 flex-wrap">
              {isBrowserSpeechClip && (
                <button
                  type="button"
                  onClick={() => {
                    stopBrowserSpeech();
                    setBrowserSpeechSyncEnabled((prev) => !prev);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 text-xs font-extrabold transition-colors cursor-pointer whitespace-nowrap ${
                    browserSpeechSyncEnabled
                      ? 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]'
                      : 'border-[#CBD5E1] bg-white text-[#475569]'
                  }`}
                >
                  {browserSpeechSyncEnabled ? (
                    <>
                      <Volume2 className="w-3.5 h-3.5" strokeWidth={2.5} />
                      <span>OS Speech Sync: ON</span>
                    </>
                  ) : (
                    <>
                      <VolumeX className="w-3.5 h-3.5" strokeWidth={2.5} />
                      <span>Embedded Track</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                disabled={isBrokenVideo}
                onClick={() => handleDownload(activeClip)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#00C853] bg-[#00C853] hover:bg-[#00B248] text-white text-xs font-extrabold transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap shrink-0"
              >
                <Download className="w-4 h-4" strokeWidth={2.5} />
                <span>Download MP4</span>
              </button>
            </div>
          </div>

          {/* Direct Translation Script Strip */}
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-[#0F172A]">
                Direct Translation Voiceover Script ({activeClip.voiceEngine})
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    speakWithBrowserSpeech({
                      scriptText: activeClip.metadata.voiceover,
                      language: activeClip.language,
                      voiceGender: activeClip.voiceGender,
                      targetDurationSec: activeClip.durationSec,
                    })
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#3D5AFE] bg-white hover:bg-[#3D5AFE] text-[#3D5AFE] hover:text-white text-[11px] font-extrabold transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Volume2 className="w-3.5 h-3.5" strokeWidth={2.5} />
                  <span>Listen Voice</span>
                </button>
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
            </div>
            <p className="text-xs font-semibold text-[#334155] leading-relaxed whitespace-pre-wrap">
              {activeClip.metadata.voiceover}
            </p>
          </div>

          {/* 5 One-Click Copy Cards */}
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
      )}
    </section>
  );
}
