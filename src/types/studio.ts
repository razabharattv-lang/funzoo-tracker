export type SourceType = 'upload' | 'link';

export type OutputLanguage = 'en' | 'hi';

export type VoiceGender = 'male' | 'female';

export type PipelineStepId =
  | 'resolving_stream'
  | 'visual_clip'
  | 'ai_sync_trends'
  | 'voice_mux'
  | 'ready';

export interface SavedCharacterAsset {
  id: string;
  name: string;
  url: string;
  publicId: string;
  uploadedAt: string;
}

export interface StudioConfig {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
  characterImageUrl: string;
  savedCharacters: SavedCharacterAsset[];
}

export interface StudioControlsState {
  sourceType: SourceType;
  videoUrl: string;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  customAngle: string;
  characterEnabled: boolean;
  selectedCharacterId: string | null;
  outfitPrompt: string;
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

/**
 * Stage 1 Output: Locked, trimmed, de-watermarked & cinema-graded visual clip
 * with an exact duration and stamped relative-second contact sheet ready for Stage 2 AI inspection.
 */
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
}

export interface VisionTimelineBeat {
  second: number;
  timestamp: string;
  action: string;
}

export interface VisionAnalysisResult {
  coreTopic: string;
  climaxSecond: number;
  timeline: VisionTimelineBeat[];
  beats: ScriptBeat[];
  watermarkZones: WatermarkZone[];
  safeCropInsets: SafeCropInsets;
  trimRange: TrimRange;
  searchQueries: string[];
  viralSegments: ViralSegment[];
  visionModel: string;
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
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  fileSizeBytes: number;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  voiceEngine: string;
  renderEngine: string;
  characterMode: string;
  watermarkBoxesRemoved: number;
  endCardTrimmedSec: number;
  safeCropApplied?: boolean;
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
