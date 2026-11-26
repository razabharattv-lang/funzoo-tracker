import { extractVideoUrl } from '../lib/urlExtractor';
import type { LocalClipInfo, SourceType, StudioConfig } from '../types/studio';

export interface VideoSegmentPlan {
  clipIndex: number;
  startSec: number;
  endSec: number;
  reason: string;
}

export interface ResolvedSourceVideo {
  blob: Blob;
  objectUrl: string;
  sourceLabel: string;
  width: number;
  height: number;
  durationSec: number;
  isLongVideoSplit: boolean;
  segments: VideoSegmentPlan[];
}

interface ChapterMarker {
  startSec: number;
  title: string;
}

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

function parseChaptersFromDescription(description: string): ChapterMarker[] {
  const markers: ChapterMarker[] = [];
  const lines = (description || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(
      /(?:^|\s)(\d{1,2}:)?(\d{1,2}):(\d{2})(?:\s*[-–—]?\s*(.*))?/
    );
    if (!match) continue;
    const hrs = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
    const mins = parseInt(match[2], 10);
    const secs = parseInt(match[3], 10);
    if (Number.isNaN(hrs) || Number.isNaN(mins) || Number.isNaN(secs)) continue;
    const total = hrs * 3600 + mins * 60 + secs;
    const title =
      (match[4] || '').trim().slice(0, 48) || `Chapter ${markers.length + 1}`;
    markers.push({ startSec: total, title });
  }
  return markers.sort((a, b) => a.startSec - b.startSec);
}

async function fetchYouTubeChapters(
  videoId: string,
  youtubeApiKey: string,
  signal?: AbortSignal
): Promise<ChapterMarker[]> {
  if (!youtubeApiKey) return [];
  try {
    const resp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(
        videoId
      )}&key=${encodeURIComponent(youtubeApiKey)}`,
      { signal }
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      items?: { snippet?: { description?: string } }[];
    };
    const desc = data.items?.[0]?.snippet?.description ?? '';
    return parseChaptersFromDescription(desc);
  } catch {
    return [];
  }
}

export async function probeVideoBlob(blob: Blob): Promise<{
  objectUrl: string;
  width: number;
  height: number;
  durationSec: number;
}> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const meta = await new Promise<{
      width: number;
      height: number;
      durationSec: number;
    }>((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      const timer = window.setTimeout(() => {
        video.removeAttribute('src');
        reject(new Error('Timed out reading video metadata.'));
      }, 18_000);

      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        const dur =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : 15;
        resolve({
          width: video.videoWidth || 1080,
          height: video.videoHeight || 1920,
          durationSec: dur,
        });
      };

      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Browser could not decode the fetched video stream.'));
      };

      video.src = objectUrl;
    });
    return { objectUrl, ...meta };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

async function querySingleCobaltNode(
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
    throw new Error('No playable URL');
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
    const fastest = await Promise.any(
      COBALT_NODES.map((endpoint) =>
        querySingleCobaltNode(endpoint, cleanUrl, signal)
      )
    );
    return fastest;
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
): Promise<{ streamUrl: string | null; chapters: ChapterMarker[] }> {
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
  ];

  const attempt = async (host: string) => {
    const resp = await fetch(`${host}/streams/${encodeURIComponent(videoId)}`, {
      signal,
    });
    if (!resp.ok) throw new Error('Piped unavailable');
    const data = (await resp.json()) as {
      chapters?: { start?: number; title?: string }[];
      videoStreams?: {
        url?: string;
        mimeType?: string;
        videoOnly?: boolean;
        height?: number;
      }[];
    };
    const chapters: ChapterMarker[] = (data.chapters ?? [])
      .filter((c) => typeof c.start === 'number')
      .map((c) => ({
        startSec: c.start as number,
        title: c.title || 'Chapter Peak',
      }));
    const muxedStreams = (data.videoStreams ?? [])
      .filter(
        (s) =>
          s.url &&
          !s.videoOnly &&
          (s.mimeType || '').toLowerCase().includes('mp4')
      )
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const best = muxedStreams[0]?.url ?? null;
    if (!best) throw new Error('No muxed stream');
    return { streamUrl: best, chapters };
  };

  try {
    return await Promise.any(pipedInstances.map(attempt));
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return { streamUrl: null, chapters: [] };
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
          `Downloading MP4 stream via CORS relay (${i}/${CORS_RELAYS.length - 1})...`
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

export function buildViralSegmentPlans(
  durationSec: number,
  chapters: ChapterMarker[]
): VideoSegmentPlan[] {
  // Short video (<= 65s): trim slow intro/outro and extract peak main scene (20–40s)
  if (durationSec <= 65) {
    if (durationSec <= 22) {
      return [
        {
          clipIndex: 1,
          startSec: 0,
          endSec: Number(durationSec.toFixed(2)),
          reason: 'Short Video Main Scene',
        },
      ];
    }
    if (durationSec <= 40) {
      const trimLead = durationSec > 26 ? 1.0 : 0;
      const trimTail = durationSec > 26 ? 1.0 : 0;
      return [
        {
          clipIndex: 1,
          startSec: trimLead,
          endSec: Number((durationSec - trimTail).toFixed(2)),
          reason: 'Trimmed Main Action Scene (20–40s)',
        },
      ];
    }
    const clipLen = 36;
    const startSec = Number(
      Math.max(0, (durationSec - clipLen) * 0.35).toFixed(2)
    );
    return [
      {
        clipIndex: 1,
        startSec,
        endSec: Number(Math.min(durationSec, startSec + clipLen).toFixed(2)),
        reason: 'Auto-Extracted Main Scene (36s)',
      },
    ];
  }

  // Long video (> 65s): slice top 3 viral segments (30s, 40s, 60s)
  const targetLengths =
    durationSec >= 140
      ? [30, 40, 60]
      : [
          Math.max(20, Math.floor((durationSec - 6) * 0.25)),
          Math.max(22, Math.floor((durationSec - 6) * 0.32)),
          Math.max(24, Math.floor((durationSec - 6) * 0.38)),
        ];

  const segments: VideoSegmentPlan[] = [];
  const validChapters = chapters.filter(
    (c) => c.startSec >= 0 && c.startSec < durationSec - 20
  );

  const overlaps = (s: number, e: number) =>
    segments.some((seg) => !(e <= seg.startSec + 1 || s >= seg.endSec - 1));

  const preferredAnchors: { start: number; reason: string }[] = [];
  if (validChapters.length >= 3) {
    const picks = [
      validChapters[Math.min(1, validChapters.length - 1)],
      validChapters[Math.floor(validChapters.length * 0.5)],
      validChapters[Math.max(0, validChapters.length - 2)],
    ];
    for (const ch of picks) {
      preferredAnchors.push({
        start: ch.startSec,
        reason: `Chapter Highlight: ${ch.title}`,
      });
    }
  }

  preferredAnchors.push(
    { start: Math.min(12, durationSec * 0.08), reason: 'Opening Hook Spike' },
    { start: durationSec * 0.44, reason: 'Mid-Video Climax Spike' },
    { start: Math.max(0, durationSec * 0.72), reason: 'Finale Reveal Spike' }
  );

  for (let i = 0; i < targetLengths.length; i++) {
    const len = targetLengths[i];
    let placed = false;

    for (const anchor of preferredAnchors) {
      const startSec = Math.max(0, Math.min(durationSec - len, anchor.start));
      const endSec = Math.min(durationSec, startSec + len);
      if (endSec - startSec >= 18 && !overlaps(startSec, endSec)) {
        segments.push({
          clipIndex: segments.length + 1,
          startSec: Number(startSec.toFixed(2)),
          endSec: Number(endSec.toFixed(2)),
          reason: `${anchor.reason} (${Math.round(endSec - startSec)}s)`,
        });
        placed = true;
        break;
      }
    }

    if (!placed) {
      const fallbackStart = Math.max(
        0,
        Math.min(durationSec - len, (durationSec / targetLengths.length) * i)
      );
      const fallbackEnd = Math.min(durationSec, fallbackStart + len);
      if (
        !overlaps(fallbackStart, fallbackEnd) &&
        fallbackEnd - fallbackStart >= 15
      ) {
        segments.push({
          clipIndex: segments.length + 1,
          startSec: Number(fallbackStart.toFixed(2)),
          endSec: Number(fallbackEnd.toFixed(2)),
          reason: `Viral Segment #${i + 1} (${Math.round(
            fallbackEnd - fallbackStart
          )}s)`,
        });
      }
    }
  }

  segments.sort((a, b) => a.startSec - b.startSec);
  return segments.map((seg, idx) => ({ ...seg, clipIndex: idx + 1 }));
}

export async function resolveSourceStream(params: {
  sourceType: SourceType;
  videoUrl: string;
  localClip: LocalClipInfo | null;
  config: StudioConfig;
  onStatus: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<ResolvedSourceVideo> {
  const { sourceType, videoUrl, localClip, config, onStatus, signal } = params;

  if (sourceType === 'upload') {
    if (!localClip) {
      throw new Error('Select a local MP4, MOV, or WebM video file first.');
    }
    onStatus('Reading local video file metadata...');
    const probed = await probeVideoBlob(localClip.file);
    const segments = buildViralSegmentPlans(probed.durationSec, []);
    return {
      blob: localClip.file,
      objectUrl: probed.objectUrl,
      sourceLabel: localClip.name,
      width: probed.width,
      height: probed.height,
      durationSec: probed.durationSec,
      isLongVideoSplit: probed.durationSec > 65,
      segments,
    };
  }

  const extracted = extractVideoUrl(videoUrl);
  if (!extracted) {
    throw new Error(
      'Paste a valid http:// or https:// video link or social share-text.'
    );
  }

  const cleanUrl = extracted.cleanUrl;
  onStatus(
    `Sanitized ${extracted.platform} URL. Racing parallel no-watermark stream nodes...`
  );

  let chapters: ChapterMarker[] = [];
  const ytId = extractYouTubeVideoId(cleanUrl);
  const chaptersPromise = ytId
    ? fetchYouTubeChapters(ytId, config.youtubeApiKey, signal)
    : Promise.resolve<ChapterMarker[]>([]);

  let candidateStreamUrl: string | null = null;

  if (/\.(mp4|webm|mov)(\?|$)/i.test(cleanUrl)) {
    candidateStreamUrl = cleanUrl;
  }

  if (!candidateStreamUrl && cleanUrl.toLowerCase().includes('tiktok')) {
    onStatus('Resolving no-watermark HD TikTok stream...');
    candidateStreamUrl = await resolveViaTikWM(cleanUrl, signal);
  }

  if (!candidateStreamUrl) {
    candidateStreamUrl = await raceCobaltNodes(cleanUrl, signal);
  }

  if (!candidateStreamUrl && ytId) {
    onStatus('Checking parallel YouTube stream resolvers...');
    const piped = await resolveYouTubeViaPiped(ytId, signal);
    if (piped.chapters.length > 0) chapters = piped.chapters;
    candidateStreamUrl = piped.streamUrl;
  }

  const ytChapters = await chaptersPromise;
  if (ytChapters.length > 0) chapters = ytChapters;

  if (!candidateStreamUrl) {
    throw new Error(
      `Could not extract a direct no-watermark MP4 stream from ${extracted.platform} in the browser (CORS or login wall). Drop the saved video into "Or Upload Local File" to render instantly.`
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
      `${extracted.platform} blocked browser stream download. Save the clip and drop it into "Or Upload Local File" for instant hardware rendering.`
    );
  }

  onStatus('Inspecting duration & slicing peak viral segments...');
  const probed = await probeVideoBlob(blob);
  const segments = buildViralSegmentPlans(probed.durationSec, chapters);

  return {
    blob,
    objectUrl: probed.objectUrl,
    sourceLabel: cleanUrl,
    width: probed.width,
    height: probed.height,
    durationSec: probed.durationSec,
    isLongVideoSplit: probed.durationSec > 65,
    segments,
  };
}
