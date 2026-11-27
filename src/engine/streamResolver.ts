import {
  extractVideoUrl,
  YOUTUBE_DIRECT_FETCH_BLOCKED_MSG,
} from '../lib/urlExtractor';
import { probeVideoBlobToSource } from '../lib/videoProbe';
import type { SourceMediaItem, ViralSegment } from '../types/studio';

const DIRECT_VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(\?.*)?$/i;

function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchVideoBlobSafe(
  mediaUrl: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  if (!isSafeHttpUrl(mediaUrl)) return null;
  const timeoutController = new AbortController();
  const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), 12000);
  const onParentAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    const resp = await fetch(mediaUrl, {
      mode: 'cors',
      credentials: 'omit',
      signal: timeoutController.signal,
    });
    if (!resp.ok) return null;
    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/json')
    ) {
      return null;
    }
    const blob = await resp.blob();
    if (blob.size < 8 * 1024) return null;
    if (blob.type && !blob.type.startsWith('video/') && !blob.type.includes('octet-stream')) {
      return null;
    }
    return blob.type.startsWith('video/')
      ? blob
      : new Blob([blob], { type: 'video/mp4' });
  } catch (err) {
    if (signal?.aborted && (err as Error).name === 'AbortError') throw err;
    return null;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function resolveShortSocialUrlViaPublicEndpoint(
  cleanUrl: string,
  signal?: AbortSignal
): Promise<string | null> {
  // Attempt standard TikWM public JSON resolver for TikTok/Douyin share links only
  const lower = cleanUrl.toLowerCase();
  if (lower.includes('tiktok.com') || lower.includes('douyin.com')) {
    try {
      const resp = await fetch(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}`,
        { signal }
      );
      if (resp.ok) {
        const json = (await resp.json()) as {
          code?: number;
          data?: { hdplay?: string; play?: string };
        };
        const candidate = json.data?.hdplay || json.data?.play;
        if (candidate && isSafeHttpUrl(candidate)) {
          return candidate;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
    }
  }
  return null;
}

/**
 * Resolves a pasted direct video URL or social share text into a playable local Blob
 * and probes its actual duration & resolution.
 * Never fakes completion: if CORS/auth blocks browser fetch, throws a clear prompt
 * asking the user to upload the downloaded MP4/MOV/WebM file locally.
 */
export async function resolveLinkToSourceMedia(params: {
  rawInput: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<SourceMediaItem> {
  const { rawInput, signal, onStatus } = params;
  const extracted = extractVideoUrl(rawInput);

  if (!extracted || !isSafeHttpUrl(extracted.cleanUrl)) {
    throw new Error(
      'No valid public http(s) video link found. Paste a direct MP4/WebM link or upload your local video file below.'
    );
  }

  if (extracted.isYouTube) {
    throw new Error(YOUTUBE_DIRECT_FETCH_BLOCKED_MSG);
  }

  onStatus?.(`Resolving ${extracted.platform} link...`);

  let blob: Blob | null = null;

  // 1. Direct media URL attempt
  if (DIRECT_VIDEO_EXT_RE.test(extracted.cleanUrl)) {
    onStatus?.('Downloading direct video stream...');
    blob = await fetchVideoBlobSafe(extracted.cleanUrl, signal);
  }

  // 2. Social link resolver attempt (TikTok / Douyin public no-watermark endpoint)
  if (!blob) {
    const resolvedStreamUrl = await resolveShortSocialUrlViaPublicEndpoint(
      extracted.cleanUrl,
      signal
    );
    if (resolvedStreamUrl) {
      onStatus?.(`Fetching ${extracted.platform} video stream...`);
      blob = await fetchVideoBlobSafe(resolvedStreamUrl, signal);
    }
  }

  // 3. Last check: try direct CORS fetch in case the link redirects to an MP4 stream
  if (!blob && !DIRECT_VIDEO_EXT_RE.test(extracted.cleanUrl)) {
    blob = await fetchVideoBlobSafe(extracted.cleanUrl, signal);
  }

  if (!blob) {
    throw new Error(
      `${extracted.platform} blocked direct browser download (CORS / platform authentication). Save the video to your device and drop or upload the MP4/MOV/WebM file in the Local File section to process it cleanly.`
    );
  }

  onStatus?.('Reading real video duration and resolution...');
  const label = `${extracted.platform} Clip`;
  return probeVideoBlobToSource({
    blob,
    sourceType: 'link',
    label,
    platform: extracted.platform,
  });
}

/**
 * Fallback segment builder preserving real video duration with zero artificial truncation.
 */
export function buildDefaultViralSegments(source: SourceMediaItem): ViralSegment[] {
  const duration = Math.max(1, source.durationSec);
  const defaultCrop = { top: 0, bottom: 0, left: 0, right: 0 };

  return [
    {
      clipIndex: 1,
      startSec: 0,
      endSec: Number(duration.toFixed(2)),
      climaxSec: Number((duration * 0.45).toFixed(2)),
      reason: 'Full source video preserved without artificial duration cap',
      trimRange: { startSec: 0, endSec: Number(duration.toFixed(2)) },
      safeCropInsets: defaultCrop,
      watermarkZones: [],
    },
  ];
}
