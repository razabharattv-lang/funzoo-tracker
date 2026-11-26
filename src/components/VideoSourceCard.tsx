import { useRef, useState } from 'react';
import {
  CheckCircle2,
  DownloadCloud,
  Film,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { SourceMediaItem, SourceType } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';
import { extractVideoUrl } from '../lib/urlExtractor';

interface VideoSourceCardProps {
  sourceType: SourceType;
  videoUrl: string;
  sourceMedia: SourceMediaItem | null;
  disabled: boolean;
  isFetchingLink: boolean;
  error: string | null;
  onSourceTypeChange: (type: SourceType) => void;
  onVideoUrlChange: (url: string) => void;
  onFetchLinkPreview: () => void;
  onFileSelected: (file: File) => void;
  onClearSource: () => void;
}

export function VideoSourceCard({
  sourceType,
  videoUrl,
  sourceMedia,
  disabled,
  isFetchingLink,
  error,
  onSourceTypeChange,
  onVideoUrlChange,
  onFetchLinkPreview,
  onFileSelected,
  onClearSource,
}: VideoSourceCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const extracted = extractVideoUrl(videoUrl);
  const hasValidLink = Boolean(extracted);
  const isReady = sourceType === 'link' ? hasValidLink : Boolean(sourceMedia);
  const uploadedClip =
    sourceMedia && sourceMedia.sourceType === 'upload' ? sourceMedia : null;

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || disabled) return;
    const file = files[0];
    if (!file.type.startsWith('video/')) return;
    onSourceTypeChange('upload');
    onFileSelected(file);
  };

  return (
    <section
      aria-label="Universal Video Link or Local File Upload"
      className={`rounded-2xl border-2 p-5 space-y-4 transition-colors ${
        isDragging
          ? 'border-[#3D5AFE] bg-[#EEF2FF]'
          : isReady
          ? 'border-[#3D5AFE] bg-white'
          : 'border-[#E2E8F0] bg-white'
      }`}
    >
      {/* PRIMARY HERO INPUT: Universal Video Link Input */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
              <Link2 className="w-4 h-4" strokeWidth={2.5} />
            </span>
            <div>
              <h2 className="text-base font-extrabold text-[#0F172A]">
                1. Video Link or Upload
              </h2>
              <p className="text-xs font-medium text-[#64748B]">
                Paste link/share-text or upload a local video file
              </p>
            </div>
          </div>

          {sourceType === 'link' && extracted && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#3D5AFE] text-white text-xs font-extrabold whitespace-nowrap shrink-0">
              <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.5} />
              <span>{extracted.platform}</span>
            </span>
          )}
        </div>

        <div
          className={`rounded-xl border-2 p-3.5 transition-colors ${
            sourceType === 'link'
              ? 'border-[#3D5AFE] bg-[#EEF2FF]'
              : 'border-[#E2E8F0] bg-[#F4F6F9]'
          }`}
        >
          <div className="relative">
            <textarea
              id="paste-any-video-link"
              rows={2}
              disabled={disabled || isFetchingLink}
              value={videoUrl}
              onFocus={() => {
                if (sourceType !== 'link') onSourceTypeChange('link');
              }}
              onChange={(e) => {
                if (sourceType !== 'link') onSourceTypeChange('link');
                onVideoUrlChange(e.target.value);
              }}
              placeholder="Paste video link or share text..."
              className="w-full rounded-xl border-2 border-[#3D5AFE] bg-white pl-3.5 pr-9 py-2.5 text-sm font-semibold text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none disabled:opacity-55 resize-none"
            />
            {videoUrl && !disabled && !isFetchingLink && (
              <button
                type="button"
                onClick={() => onVideoUrlChange('')}
                aria-label="Clear pasted link"
                className="absolute right-2.5 top-2.5 p-1 rounded-md text-[#64748B] hover:text-[#FF1744] cursor-pointer"
              >
                <X className="w-4 h-4" strokeWidth={2.5} />
              </button>
            )}
          </div>

          {sourceType === 'link' && extracted && (
            <div className="mt-2.5 rounded-lg border-2 border-[#3D5AFE] bg-white px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-extrabold text-[#3D5AFE]">
                  {extracted.wasExtractedFromText
                    ? `Clean URL Extracted (${extracted.platform})`
                    : `Ready to Resolve (${extracted.platform})`}
                </p>
                <p
                  className="font-mono-tabular text-xs font-bold text-[#0F172A] truncate mt-0.5"
                  title={extracted.cleanUrl}
                >
                  {extracted.cleanUrl}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled || isFetchingLink}
                onClick={onFetchLinkPreview}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-[#3D5AFE] bg-[#3D5AFE] hover:bg-[#2F49E6] text-white text-xs font-extrabold transition-colors disabled:opacity-55 cursor-pointer whitespace-nowrap shrink-0"
              >
                {isFetchingLink ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.5} />
                    <span>Fetching...</span>
                  </>
                ) : (
                  <>
                    <DownloadCloud className="w-3.5 h-3.5" strokeWidth={2.5} />
                    <span>Preview Source</span>
                  </>
                )}
              </button>
            </div>
          )}

          {sourceType === 'link' && videoUrl.trim().length > 0 && !extracted && (
            <p className="mt-2 text-xs font-bold text-[#FF1744]">
              No valid http:// or https:// URL detected in the pasted text yet.
            </p>
          )}
        </div>
      </div>

      {/* SECONDARY OPTION: Direct Local Gallery Upload */}
      <div className="pt-1">
        <div className="flex items-center gap-3 mb-2.5">
          <div className="flex-1 h-0.5 bg-[#E2E8F0]" />
          <span className="text-xs font-extrabold text-[#64748B] whitespace-nowrap">
            Or Upload Local File
          </span>
          <div className="flex-1 h-0.5 bg-[#E2E8F0]" />
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/*"
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {uploadedClip && sourceType === 'upload' ? (
          <div className="rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
                <Film className="w-5 h-5" strokeWidth={2.25} />
              </div>
              <div className="min-w-0">
                <p
                  className="text-sm font-extrabold text-[#0F172A] truncate"
                  title={uploadedClip.label}
                >
                  {uploadedClip.label}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#334155] mt-0.5 font-mono-tabular">
                  <span>{formatDuration(uploadedClip.durationSec)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {uploadedClip.width}×{uploadedClip.height}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{formatBytes(uploadedClip.sizeBytes)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-[#3D5AFE] border-2 border-[#3D5AFE] hover:bg-[#3D5AFE] hover:text-white disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={2.25} />
                <span>Replace</span>
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onClearSource();
                  onSourceTypeChange('link');
                }}
                aria-label="Remove local video file"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-[#FF1744] border-2 border-[#FF1744] hover:bg-[#FF1744] hover:text-white disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
                <span>Remove</span>
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              if (!disabled) setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!disabled) setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            className={`w-full rounded-xl border-2 border-dashed px-4 py-3 flex items-center justify-center gap-2.5 text-xs font-extrabold transition-colors cursor-pointer disabled:opacity-50 ${
              isDragging
                ? 'border-[#3D5AFE] bg-[#DCE4FF] text-[#1E3A8A]'
                : 'border-[#CBD5E1] bg-[#F4F6F9] text-[#334155] hover:border-[#3D5AFE] hover:bg-[#EEF2FF] hover:text-[#3D5AFE]'
            }`}
          >
            <UploadCloud className="w-4 h-4 shrink-0" strokeWidth={2.5} />
            <span>
              {isDragging
                ? 'Drop MP4 / MOV clip here'
                : 'Or drag & drop / choose a local MP4, MOV, or WebM file'}
            </span>
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-3.5 py-2.5 text-xs font-bold text-[#B71C1C]"
        >
          {error}
        </div>
      )}
    </section>
  );
}
