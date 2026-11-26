import type { SourceMediaItem } from '../types/studio';

export function shouldTrimSocialEndCard(platformOrLabel: string): boolean {
  const lower = platformOrLabel.toLowerCase();
  return (
    lower.includes('rednote') ||
    lower.includes('xiaohongshu') ||
    lower.includes('xhs') ||
    lower.includes('douyin') ||
    lower.includes('tiktok') ||
    lower.includes('instagram') ||
    lower.includes('reels')
  );
}

export function probeVideoBlobToSource(params: {
  blob: Blob;
  sourceType: 'upload' | 'link';
  label: string;
  platform: string;
}): Promise<SourceMediaItem> {
  const { blob, sourceType, label, platform } = params;
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
    };

    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      cleanup();
      reject(new Error('Timed out reading video metadata.'));
    }, 15_000);

    video.onloadedmetadata = () => {
      const durationSec =
        Number.isFinite(video.duration) && video.duration > 0
          ? Number(video.duration.toFixed(2))
          : 15;
      const item: SourceMediaItem = {
        sourceType,
        blob,
        objectUrl,
        label,
        platform,
        width: video.videoWidth || 1080,
        height: video.videoHeight || 1920,
        durationSec,
        sizeBytes: blob.size,
        mode: durationSec > 65 ? 'long' : 'short',
        trimSocialEndCard:
          shouldTrimSocialEndCard(platform) || shouldTrimSocialEndCard(label),
      };
      cleanup();
      resolve(item);
    };

    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      cleanup();
      reject(
        new Error(
          'Could not read video metadata. Please choose a valid MP4, MOV, or WebM clip.'
        )
      );
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
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
