export type SourceType = 'upload' | 'link';

export type OutputLanguage = 'en' | 'hi';

export type VoiceGender = 'male' | 'female';

export type AiEnginePreference =
  | 'auto'
  | 'gemini-3.8-flash'
  | 'nvidia/nemotron-3.5-super-vl-120b-a12b'
  | 'nvidia/nemotron-3.5-lightning-30b-a3b'
  | 'mistralai/mistral-large-4'
  | 'nvidia/riva-translate-4b-instruct-v2'
  | 'nvidia/nemotron-3.5-content-safety';

export type PipelineStepId =
  | 'step_1_fetch_clip'
  | 'step_2_clean_grade'
  | 'step_3_translate_seo'
  | 'step_4_voiceover'
  | 'step_5_mux_output';

export type OfflineModelId =
  | 'scene_logo_scanner'
  | 'caption_timing_aligner'
  | 'offline_translation_seo';

export interface OfflineModelStatus {
  id: OfflineModelId;
  label: string;
  engine: string;
  cached: boolean;
  ready: boolean;
  sizeKB: number;
}

export interface AlignedWordTiming {
  word: string;
  startSec: number;
  endSec: number;
  confidence: number;
  isEmphasis: boolean;
}

export interface LocalSceneScanResult {
  sceneCutTimestampsSec: number[];
  highActionWindows: {
    startSec: number;
    endSec: number;
    climaxSec: number;
    motionScore: number;
  }[];
  detectedWatermarkZones: WatermarkZone[];
  suggestedSafeCropInsets: SafeCropInsets;
  hasOutroBumper: boolean;
}

export interface StudioControlsState {
  sourceType: SourceType;
  videoUrl: string;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  aiEngine: AiEnginePreference;
  customAngle: string;
}

export interface SourceMediaItem {
  sourceType: SourceType;
  blob: Blob;
  objectUrl: string;
  label: string;
  platform: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
  mode: 'short' | 'long';
  trimSocialEndCard: boolean;
}

export type WatermarkAction =
  | 'safe_edge_crop'
  | 'gpu_delogo_patch'
  | 'trim_bumper';

export interface WatermarkZone {
  id: string;
  startSec: number;
  endSec: number;
  box: [number, number, number, number];
  action: WatermarkAction;
  label: string;
}

export interface SafeCropInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TrimRange {
  startSec: number;
  endSec: number;
}

export interface ScriptBeat {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ViralSegment {
  clipIndex: number;
  startSec: number;
  endSec: number;
  climaxSec: number;
  reason: string;
  trimRange: TrimRange;
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
}

export interface PreparedVisualClip {
  clipIndex: number;
  totalClips: number;
  sourceStartSec: number;
  sourceEndSec: number;
  trimRange: TrimRange;
  usableIntervals: TrimRange[];
  lockedVisualDurationSec: number;
  climaxSec: number;
  reason: string;
  safeCropInsets: SafeCropInsets;
  watermarkZones: WatermarkZone[];
  bumperTrimmedSec: number;
  safeCropApplied: boolean;
  delogoZoneCount: number;
  stampedContactSheetJpeg: string;
  stampedTimestampsSec: number[];
  inspectorModel: string;
}

export interface YouTubeTrendVideo {
  title: string;
  channel: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  tags: string[];
}

export interface TrendMetadata {
  voiceover: string;
  beats: ScriptBeat[];
  wordTimings?: AlignedWordTiming[];
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  postingTime: string;
  scriptEngine: string;
  youtubeTrendsCount: number;
}

export interface RenderedClipOutput {
  clipIndex: number;
  totalClips: number;
  startSec: number;
  endSec: number;
  reason: string;
  videoUrl: string;
  mimeType: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  fileSizeBytes: number;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  voiceEngine: string;
  renderEngine: string;
  watermarkBoxesRemoved: number;
  endCardTrimmedSec: number;
  safeCropApplied: boolean;
  climaxSecond: number;
  metadata: TrendMetadata;
}

export interface PipelineProgress {
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  activeStep: PipelineStepId | null;
  completedSteps: PipelineStepId[];
  percent: number;
  statusDetail: string;
  clipProgressLabel: string | null;
  runTag: string | null;
  startedAtMs: number | null;
  errorMessage: string | null;
}

export interface SavedRenderRecord {
  runTag: string;
  completedAt: string;
  sourceLabel: string;
  sourceDurationSec: number;
  mode: 'short' | 'long';
  customAngle: string;
  clips: RenderedClipOutput[];
}
