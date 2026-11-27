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

/**
 * Probes an actual video Blob via HTMLVideoElement metadata, reading true duration,
 * videoWidth, and videoHeight with zero hardcoded duration caps.
 */
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

    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.ondurationchange = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      cleanup();
      reject(new Error(message));
    };

    const finalize = () => {
      if (settled) return;
      const rawDur = video.duration;
      const rawW = video.videoWidth;
      const rawH = video.videoHeight;

      if (!Number.isFinite(rawDur) || rawDur <= 0 || rawW <= 0 || rawH <= 0) {
        fail(
          'Could not read playable video dimensions or duration. Please upload a valid MP4, MOV, or WebM file.'
        );
        return;
      }

      settled = true;
      const durationSec = Number(rawDur.toFixed(2));
      const item: SourceMediaItem = {
        sourceType,
        blob,
        objectUrl,
        label,
        platform,
        width: rawW,
        height: rawH,
        durationSec,
        sizeBytes: blob.size,
        mode: durationSec > 65 ? 'long' : 'short',
        trimSocialEndCard:
          shouldTrimSocialEndCard(platform) || shouldTrimSocialEndCard(label),
      };
      cleanup();
      resolve(item);
    };

    const timer = window.setTimeout(() => {
      fail('Timed out reading video metadata. Please try uploading the local video file directly.');
    }, 45_000);

    video.onloadedmetadata = () => {
      // Handle WebM recordings that report Infinity until seeked
      if (video.duration === Infinity) {
        const tryResolveDuration = () => {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            finalize();
          }
        };
        video.ondurationchange = tryResolveDuration;
        video.onseeked = () => {
          finalize();
        };
        try {
          video.currentTime = 1e7;
        } catch {
          finalize();
        }
        return;
      }
      finalize();
    };

    video.onerror = () => {
      fail(
        'This video format could not be decoded in the browser. Please choose a standard MP4, MOV, or WebM clip.'
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
