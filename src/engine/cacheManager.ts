import type { OfflineModelStatus } from '../types/studio';

export const PRE_EMBEDDED_MODEL_MANIFEST: OfflineModelStatus[] = [
  {
    id: 'scene_logo_scanner',
    label: 'Scene Cut & Watermark Scanner',
    engine: 'Browser Canvas Histogram & Motion Engine',
    cached: true,
    ready: true,
    sizeKB: 48,
  },
  {
    id: 'caption_timing_aligner',
    label: 'Voiceover Word Timing Aligner',
    engine: 'WebAudio RMS Syllable Envelope Engine',
    cached: true,
    ready: true,
    sizeKB: 24,
  },
  {
    id: 'offline_translation_seo',
    label: 'Offline Translation & SEO Fallback',
    engine: 'Local Direct-Script & US/IST SEO Engine',
    cached: true,
    ready: true,
    sizeKB: 36,
  },
];

export function getOfflineModelStatuses(): OfflineModelStatus[] {
  return PRE_EMBEDDED_MODEL_MANIFEST.map((item) => ({ ...item }));
}
