import { useRef, useState } from 'react';
import { Film, Trash2, UploadCloud, RefreshCw } from 'lucide-react';
import type { LocalClipInfo } from '../types/studio';
import { formatBytes, formatDuration } from '../lib/videoProbe';

interface VideoDropzoneProps {
  clip: LocalClipInfo | null;
  disabled: boolean;
  error: string | null;
  onFileSelected: (file: File) => void;
  onClearClip: () => void;
}

export function VideoDropzone({
  clip,
  disabled,
  error,
  onFileSelected,
  onClearClip,
}: VideoDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || disabled) return;
    const file = files[0];
    if (!file.type.startsWith('video/')) {
      return;
    }
    onFileSelected(file);
  };

  return (
    <section
      aria-label="Video Upload"
      className={`rounded-2xl border-2 transition-colors p-5 ${
        isDragging
          ? 'border-[#3D5AFE] bg-[#EEF2FF]'
          : clip
          ? 'border-[#3D5AFE] bg-white'
          : 'border-[#E2E8F0] bg-white'
      }`}
    >
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-extrabold text-[#0F172A]">
            1. Source Clip Dropzone
          </h2>
          <p className="text-xs font-medium text-[#64748B] mt-0.5">
            Drop a RedNote, Douyin, or TikTok MP4 / MOV clip for 1080×1920 US explainer conversion.
          </p>
        </div>
        {clip && (
          <span className="inline-flex items-center px-3 py-1 rounded-full bg-[#EEF2FF] text-[#3D5AFE] border-2 border-[#3D5AFE] text-xs font-bold whitespace-nowrap shrink-0">
            Clip Loaded
          </span>
        )}
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

      {!clip ? (
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
          className={`w-full rounded-xl border-2 border-dashed p-7 text-center transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
            isDragging
              ? 'border-[#3D5AFE] bg-[#DCE4FF]'
              : 'border-[#3D5AFE] bg-[#EEF2FF] hover:bg-[#E2E8FF]'
          }`}
        >
          <div className="w-12 h-12 rounded-xl bg-[#3D5AFE] text-white flex items-center justify-center mx-auto mb-3">
            <UploadCloud className="w-6 h-6" strokeWidth={2.25} />
          </div>
          <p className="text-sm font-extrabold text-[#0F172A]">
            {isDragging ? 'Release to load raw clip' : 'Drag & drop clip here, or click to browse'}
          </p>
          <p className="text-xs font-medium text-[#475569] mt-1.5">
            MP4 · MOV · WebM — Raw file auto-deletes from Cloudinary after render
          </p>
        </button>
      ) : (
        <div className="rounded-xl border-2 border-[#3D5AFE] bg-[#EEF2FF] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
              <Film className="w-5 h-5" strokeWidth={2.25} />
            </div>
            <div className="min-w-0">
              <p
                className="text-sm font-extrabold text-[#0F172A] truncate"
                title={clip.name}
              >
                {clip.name}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#334155] mt-1 font-mono-tabular">
                <span>{formatDuration(clip.durationSec)}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {clip.width > 0 && clip.height > 0
                    ? `${clip.width}×${clip.height}`
                    : 'Video'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(clip.sizeBytes)}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-white text-[#3D5AFE] border-2 border-[#3D5AFE] hover:bg-[#3D5AFE] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={2.25} />
              <span>Replace</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onClearClip}
              aria-label="Remove video clip"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-white text-[#FF1744] border-2 border-[#FF1744] hover:bg-[#FF1744] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
              <span>Remove</span>
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-3.5 py-2.5 text-xs font-bold text-[#B71C1C]"
        >
          {error}
        </div>
      )}
    </section>
  );
}
