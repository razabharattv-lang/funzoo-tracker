export interface ExtractedVideoLink {
  cleanUrl: string;
  platform: string;
  wasExtractedFromText: boolean;
}

const URL_REGEX = /https?:\/\/[^\s]+/i;
const TRAILING_PUNCT_REGEX = /[.,;!?)"'】》」』，。！？、]+$/;

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

  return {
    cleanUrl,
    platform: detectVideoPlatform(cleanUrl),
    wasExtractedFromText: cleanUrl !== trimmed,
  };
}
