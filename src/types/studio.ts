export type StudioMode = 'explainer' | 'documentary';

export type DocumentaryStyle = 'documentary' | 'motion_graphics' | '3d_blender';

export type DocumentaryInputKind = 'topic' | 'script';

export type SourceType = 'upload' | 'link';

export type OutputLanguage = 'en' | 'hi';

export type VoiceGender = 'male' | 'female';

export type PipelineStepId =
  | 'step_1_inspect'
  | 'step_2_clean_visuals'
  | 'step_3_script_trends'
  | 'step_4_voice_character'
  | 'step_5_gpu_mux';

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
  externalGpuEndpoint: string;
  externalGpuKey: string;
  characterImageUrl: string;
  savedCharacters: SavedCharacterAsset[];
}

export interface StudioControlsState {
  studioMode: StudioMode;
  sourceType: SourceType;
  videoUrl: string;
  documentaryStyle: DocumentaryStyle;
  documentaryInputKind: DocumentaryInputKind;
  documentaryInput: string;
  useExternalGpu: boolean;
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

export type MotionShaderPreset =
  | 'cinema_grid'
  | 'neon_motion_hud'
  | 'blender_3d_extrude'
  | 'orbital_nebula';

export interface DocumentarySceneCard {
  sceneIndex: number;
  heading: string;
  visualPrompt: string;
  captionCallout: string;
  shaderPreset: MotionShaderPreset;
  accentHex: string;
  targetDurationSec: number;
  narrationDraft: string;
  externalVisualDataUrl?: string;
}

export interface DocumentaryChapter {
  chapterIndex: number;
  totalChapters: number;
  title: string;
  style: DocumentaryStyle;
  targetDurationSec: number;
  climaxSec: number;
  visualPrompt: string;
  captionCallout: string;
  shaderPreset: MotionShaderPreset;
  accentHex: string;
  rawNarration: string;
  beats: ScriptBeat[];
  searchQueries: string[];
  externalVisualDataUrl?: string;
  stampedContactSheetJpeg?: string;
  stampedTimestampsSec: number[];
  visualEngineLabel: string;
}

export interface DocumentaryOutline {
  id: string;
  topicOrTitle: string;
  style: DocumentaryStyle;
  inputKind: DocumentaryInputKind;
  chapters: DocumentaryChapter[];
  totalDurationSec: number;
  plannerModel: string;
}

/**
 * Step 1 & Step 2 Output: Locked, trimmed, de-watermarked & cinema-graded visual clip
 * with an exact duration and stamped relative-second contact sheet ready for Step 3 AI inspection.
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
  inspectorModel: string;
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
  studioMode: StudioMode;
  documentaryStyle?: DocumentaryStyle;
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
  mode: 'short' | 'long' | 'documentary';
  studioMode: StudioMode;
  customAngle: string;
  clips: RenderedClipOutput[];
}
