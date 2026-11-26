import { extractVideoUrl } from '../lib/urlExtractor';
import { probeVideoBlobToSource } from '../lib/videoProbe';
import type { SourceMediaItem, ViralSegment } from '../types/studio';

const COBALT_NODES = [
  'https://api.cobalt.tools/',
  'https://cobalt-api.meowing.de/',
  'https://cobalt.canine.tools/',
  'https://cbl.bloat.cat/',
];

const CORS_RELAYS: ((url: string) => string)[] = [
  (url) => url,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

export const SOCIAL_ENDCARD_TRIM_SEC = 2.6;

function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtu.be')) {
      const seg = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      return seg && seg.length >= 11 ? seg.slice(0, 11) : null;
    }
    if (host.includes('youtube.com')) {
      const v = parsed.searchParams.get('v');
      if (v && v.length >= 11) return v.slice(0, 11);
      const shortsMatch = parsed.pathname.match(
        /\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/
      );
      if (shortsMatch) return shortsMatch[1];
    }
  } catch {
    return null;
  }
  return null;
}

async function queryCobaltNode(
  endpoint: string,
  cleanUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const timeoutCtrl = new AbortController();
  const timer = window.setTimeout(() => timeoutCtrl.abort(), 11_000);
  const onParentAbort = () => timeoutCtrl.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: cleanUrl,
        videoQuality: '1080',
        downloadMode: 'auto',
        filenameStyle: 'basic',
      }),
      signal: timeoutCtrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      url?: string;
      picker?: { type?: string; url?: string }[];
    };
    if (data.url && data.url.startsWith('http')) return data.url;
    const videoPick = data.picker?.find(
      (item) => item.url && (!item.type || item.type === 'video')
    );
    if (videoPick?.url) return videoPick.url;
    throw new Error('No playable stream URL');
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function raceCobaltNodes(
  cleanUrl: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    return await Promise.any(
      COBALT_NODES.map((ep) => queryCobaltNode(ep, cleanUrl, signal))
    );
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return null;
  }
}

async function resolveViaTikWM(
  cleanUrl: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!cleanUrl.toLowerCase().includes('tiktok')) return null;
  try {
    const resp = await fetch(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`,
      { signal }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      data?: { hdplay?: string; play?: string };
    };
    return data.data?.hdplay || data.data?.play || null;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return null;
  }
}

async function resolveYouTubeViaPiped(
  videoId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
  ];

  const attempt = async (host: string): Promise<string> => {
    const resp = await fetch(`${host}/streams/${encodeURIComponent(videoId)}`, {
      signal,
    });
    if (!resp.ok) throw new Error('Piped unavailable');
    const data = (await resp.json()) as {
      videoStreams?: {
        url?: string;
        mimeType?: string;
        videoOnly?: boolean;
        height?: number;
      }[];
    };
    const muxed = (data.videoStreams ?? [])
      .filter(
        (s) =>
          s.url &&
          !s.videoOnly &&
          (s.mimeType || '').toLowerCase().includes('mp4')
      )
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    if (!muxed[0]?.url) throw new Error('No muxed MP4 stream');
    return muxed[0].url;
  };

  try {
    return await Promise.any(pipedInstances.map(attempt));
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return null;
  }
}

async function downloadVideoBlobWithRelayFallback(
  streamUrl: string,
  onStatus: (msg: string) => void,
  signal?: AbortSignal
): Promise<Blob | null> {
  for (let i = 0; i < CORS_RELAYS.length; i++) {
    const targetUrl = CORS_RELAYS[i](streamUrl);
    try {
      if (i > 0) {
        onStatus(
          `Fetching MP4 stream via CORS relay (${i}/${CORS_RELAYS.length - 1})...`
        );
      }
      const resp = await fetch(targetUrl, { signal });
      if (!resp.ok) continue;
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/json')
      ) {
        continue;
      }
      const blob = await resp.blob();
      if (blob.size < 20_000) continue;
      const headText = await blob.slice(0, 64).text();
      if (headText.trimStart().startsWith('<')) continue;
      return blob.type.startsWith('video/')
        ? blob
        : new Blob([blob], { type: 'video/mp4' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
    }
  }
  return null;
}

/**
 * Computes usable duration after automatically trimming the final 2.6s creator
 * end-card bumper on RedNote/Xiaohongshu, Douyin, TikTok, and Reels sources.
 */
export function getUsableSourceDuration(source: SourceMediaItem): {
  usableDurationSec: number;
  endCardTrimmedSec: number;
} {
  if (source.trimSocialEndCard && source.durationSec > 6.5) {
    return {
      usableDurationSec: Number(
        Math.max(3.5, source.durationSec - SOCIAL_ENDCARD_TRIM_SEC).toFixed(2)
      ),
      endCardTrimmedSec: SOCIAL_ENDCARD_TRIM_SEC,
    };
  }
  return {
    usableDurationSec: source.durationSec,
    endCardTrimmedSec: 0,
  };
}

/**
 * Builds deterministic fallback segments if Vision did not return custom viral windows.
 * - Short (<= 65s): trims slow lead-in & social end-card into 1 peak main scene (20–40s).
 * - Long (> 65s): slices 3–4 proportional viral segments (30s, 40s, 60s).
 */
export function buildDefaultViralSegments(
  source: SourceMediaItem
): ViralSegment[] {
  const { usableDurationSec, endCardTrimmedSec } =
    getUsableSourceDuration(source);
  const zeroInsets = { top: 0, bottom: 0, left: 0, right: 0 };

  const defaultBumperZones =
    endCardTrimmedSec > 0
      ? [
          {
            id: 'social_outro_bumper',
            startSec: usableDurationSec,
            endSec: source.durationSec,
            box: [0, 0, 1000, 1000] as [number, number, number, number],
            action: 'trim_bumper' as const,
            label: `${source.platform} Creator Outro Bumper`,
          },
        ]
      : [];

  if (source.mode === 'short') {
    if (usableDurationSec <= 24) {
      return [
        {
          clipIndex: 1,
          startSec: 0,
          endSec: usableDurationSec,
          climaxSec: Number((usableDurationSec * 0.52).toFixed(2)),
          reason: 'Short Explainer Main Scene',
          trimRange: { startSec: 0, endSec: usableDurationSec },
          safeCropInsets: { ...zeroInsets },
          watermarkZones: [...defaultBumperZones],
        },
      ];
    }
    if (usableDurationSec <= 42) {
      const startSec = usableDurationSec > 28 ? 0.8 : 0;
      const endSec = usableDurationSec;
      return [
        {
          clipIndex: 1,
          startSec,
          endSec,
          climaxSec: Number(((endSec - startSec) * 0.52).toFixed(2)),
          reason: 'Trimmed Main Action Scene',
          trimRange: { startSec, endSec },
          safeCropInsets: { ...zeroInsets },
          watermarkZones: [...defaultBumperZones],
        },
      ];
    }
    const clipLen = 36;
    const startSec = Number(
      Math.max(0, (usableDurationSec - clipLen) * 0.35).toFixed(2)
    );
    const endSec = Number(Math.min(usableDurationSec, startSec + clipLen).toFixed(2));
    return [
      {
        clipIndex: 1,
        startSec,
        endSec,
        climaxSec: Number(((endSec - startSec) * 0.52).toFixed(2)),
        reason: 'Peak 36s Action Scene',
        trimRange: { startSec, endSec },
        safeCropInsets: { ...zeroInsets },
        watermarkZones: [...defaultBumperZones],
      },
    ];
  }

  // Long video (> 65s): proportional 30s / 40s / 60s windows
  const lengths =
    usableDurationSec >= 300
      ? [30, 40, 60, 40]
      : usableDurationSec >= 150
      ? [30, 40, 60]
      : [
          Math.max(20, Math.floor((usableDurationSec - 6) * 0.25)),
          Math.max(22, Math.floor((usableDurationSec - 6) * 0.32)),
          Math.max(24, Math.floor((usableDurationSec - 6) * 0.38)),
        ];

  const fractions =
    lengths.length === 4 ? [0.1, 0.34, 0.58, 0.8] : [0.1, 0.45, 0.74];
  const labels = [
    'Opening Tension Spike',
    'Mid-Story Climax Twist',
    'High-Stakes Deep Reveal',
    'Finale Payoff Moment',
  ];

  const segments: ViralSegment[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    const startSec = Number(
      Math.max(
        0,
        Math.min(usableDurationSec - len, usableDurationSec * fractions[i])
      ).toFixed(2)
    );
    const endSec = Number(Math.min(usableDurationSec, startSec + len).toFixed(2));
    if (endSec - startSec >= 15) {
      segments.push({
        clipIndex: segments.length + 1,
        startSec,
        endSec,
        climaxSec: Number(((endSec - startSec) * 0.52).toFixed(2)),
        reason: `${labels[i] || `Viral Highlight #${i + 1}`} (${Math.round(
          endSec - startSec
        )}s)`,
        trimRange: { startSec, endSec },
        safeCropInsets: { ...zeroInsets },
        watermarkZones: [],
      });
    }
  }
  return segments;
}

export async function resolveLinkToSourceMedia(params: {
  rawInput: string;
  onStatus: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<SourceMediaItem> {
  const { rawInput, onStatus, signal } = params;
  const extracted = extractVideoUrl(rawInput);
  if (!extracted) {
    throw new Error(
      'Paste a valid http:// or https:// video link or social share-text.'
    );
  }

  const cleanUrl = extracted.cleanUrl;
  onStatus(
    `Sanitized ${extracted.platform} link. Racing parallel no-watermark stream nodes...`
  );

  let candidateStreamUrl: string | null = null;
  const ytId = extractYouTubeVideoId(cleanUrl);

  if (/\.(mp4|webm|mov)(\?|$)/i.test(cleanUrl)) {
    candidateStreamUrl = cleanUrl;
  }

  if (!candidateStreamUrl && cleanUrl.toLowerCase().includes('tiktok')) {
    onStatus('Fetching no-watermark HD TikTok stream...');
    candidateStreamUrl = await resolveViaTikWM(cleanUrl, signal);
  }

  if (!candidateStreamUrl) {
    candidateStreamUrl = await raceCobaltNodes(cleanUrl, signal);
  }

  if (!candidateStreamUrl && ytId) {
    onStatus('Checking parallel YouTube MP4 resolvers...');
    candidateStreamUrl = await resolveYouTubeViaPiped(ytId, signal);
  }

  if (!candidateStreamUrl) {
    throw new Error(
      `Could not extract a direct no-watermark MP4 from ${extracted.platform} inside the browser (CORS or login wall). Drop the saved video into "Or Upload Local File" to preview & render immediately.`
    );
  }

  onStatus('Downloading resolved MP4 stream...');
  const blob = await downloadVideoBlobWithRelayFallback(
    candidateStreamUrl,
    onStatus,
    signal
  );

  if (!blob) {
    throw new Error(
      `${extracted.platform} blocked browser stream download. Drop the saved clip into "Or Upload Local File" for instant hardware GPU rendering.`
    );
  }

  onStatus('Inspecting video dimensions & mode...');
  return probeVideoBlobToSource({
    blob,
    sourceType: 'link',
    label: cleanUrl,
    platform: extracted.platform,
  });
}
