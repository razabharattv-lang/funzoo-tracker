import type { LocalClipInfo } from '../types/studio';

export function probeLocalVideoFile(file: File): Promise<LocalClipInfo> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      const info: LocalClipInfo = {
        file,
        objectUrl,
        name: file.name,
        sizeBytes: file.size,
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      };
      cleanup();
      resolve(info);
    };

    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      cleanup();
      reject(new Error('Could not read video metadata. Please choose a valid MP4, MOV, or WebM clip.'));
    };

    video.src = objectUrl;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
