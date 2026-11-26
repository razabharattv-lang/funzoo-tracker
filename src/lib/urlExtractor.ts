export interface ExtractedVideoLink {
  cleanUrl: string;
  platform: string;
  wasExtractedFromText: boolean;
  isYouTube: boolean;
  youtubeVideoId: string | null;
}

export interface YouTubeOEmbedContext {
  videoId: string;
  canonicalUrl: string;
  title: string;
  authorName: string;
  thumbnailUrl?: string;
}

export const YOUTUBE_DIRECT_FETCH_BLOCKED_MSG =
  'Direct browser video fetching is blocked for YouTube URLs without a backend proxy. Pick the local video file via Choose Video File (MP4, MOV, WebM) so Steps 1–5 run cleanly with captured link context.';

const URL_REGEX = /https?:\/\/[^\s]+/i;
const TRAILING_PUNCT_REGEX = /[.,;!?)"'】》」』，。！？、]+$/;
const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host.endsWith('.youtu.be')
    );
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(url: string): string | null {
  const trimmed = url.trim();
  if (YOUTUBE_ID_REGEX.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    let candidate: string | null = null;

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      candidate = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parsed.searchParams.get('v')) {
        candidate = parsed.searchParams.get('v');
      } else if (
        parts.length >= 2 &&
        ['shorts', 'embed', 'live', 'v'].includes(parts[0].toLowerCase())
      ) {
        candidate = parts[1];
      }
    }

    return candidate && YOUTUBE_ID_REGEX.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export async function fetchYouTubeOEmbedContext(
  urlOrId: string,
  signal?: AbortSignal
): Promise<YouTubeOEmbedContext | null> {
  const videoId = extractYouTubeVideoId(urlOrId);
  if (!videoId) return null;

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;

  const timeoutController = new AbortController();
  const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), 4500);
  const onParentAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: timeoutController.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: unknown;
      author_name?: unknown;
      thumbnail_url?: unknown;
    };
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    const authorName =
      typeof data.author_name === 'string' ? data.author_name.trim() : '';
    const thumbnailUrl =
      typeof data.thumbnail_url === 'string' ? data.thumbnail_url.trim() : undefined;
    if (!title && !authorName) return null;
    return {
      videoId,
      canonicalUrl,
      title,
      authorName,
      thumbnailUrl,
    };
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

export function buildYouTubeContextNotice(ctx: YouTubeOEmbedContext | null): string {
  if (!ctx || (!ctx.title && !ctx.authorName)) {
    return YOUTUBE_DIRECT_FETCH_BLOCKED_MSG;
  }
  const titlePart = ctx.title ? `"${ctx.title}"` : `Video ${ctx.videoId}`;
  const creatorPart = ctx.authorName ? ` by ${ctx.authorName}` : '';
  return `Captured YouTube context: ${titlePart}${creatorPart}. Pick the local video file via Choose Video File (MP4, MOV, WebM) so Steps 1–5 run smoothly with this link context.`;
}

export function detectVideoPlatform(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com')) {
    return 'RedNote / Xiaohongshu';
  }
  if (lower.includes('douyin.com') || lower.includes('iesdouyin.com')) {
    return 'Douyin';
  }
  if (lower.includes('kuaishou.com') || lower.includes('chenzhongtech.com')) {
    return 'Kuaishou';
  }
  if (lower.includes('tiktok.com') || lower.includes('vm.tiktok')) {
    return 'TikTok';
  }
  if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com')) {
    return 'Facebook';
  }
  if (lower.includes('instagram.com')) {
    return 'Instagram Reels';
  }
  if (lower.includes('youtube.com/shorts')) {
    return 'YouTube Shorts';
  }
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
    return 'YouTube Video';
  }
  if (lower.includes('bilibili.com') || lower.includes('b23.tv')) {
    return 'Bilibili';
  }
  if (lower.includes('weibo.com') || lower.includes('weibo.cn')) {
    return 'Weibo';
  }
  return 'Web Video Link';
}

export function extractVideoUrl(rawInput: string): ExtractedVideoLink | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const match = trimmed.match(URL_REGEX);
  if (!match) return null;

  const cleanUrl = match[0].replace(TRAILING_PUNCT_REGEX, '').trim();
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }

  const youtube = isYouTubeUrl(cleanUrl);

  return {
    cleanUrl,
    platform: detectVideoPlatform(cleanUrl),
    wasExtractedFromText: cleanUrl !== trimmed,
    isYouTube: youtube,
    youtubeVideoId: youtube ? extractYouTubeVideoId(cleanUrl) : null,
  };
}
