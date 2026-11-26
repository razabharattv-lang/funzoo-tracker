export type SourceType = 'upload' | 'link';

export type OutputLanguage = 'en' | 'hi';

export type VoiceGender = 'male' | 'female';

export type PipelineStepId =
  | 'fetching_link'
  | 'scan_trends'
  | 'voice_character'
  | 'anti_copyright_render'
  | 'ready';

export interface SavedCharacterAsset {
  id: string;
  name: string;
  url: string;
  publicId: string;
  uploadedAt: string;
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

export interface LocalClipInfo {
  file: File;
  objectUrl: string;
  name: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface RenderedClipItem {
  clip_index: number;
  start_sec: number;
  end_sec: number;
  reason: string;
  video_url: string;
  video_public_id: string;
  duration_sec: number;
  width: number;
  height: number;
  file_size_bytes: number;
  voice_engine: string;
  character_mode: string;
  watermark_boxes_removed: number;
  climax_second: number;
  youtube_trends_count: number;
  voiceover: string;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  posting_time: string;
}

export interface RenderResultManifest {
  run_tag: string;
  video_url: string;
  video_public_id: string;
  duration_sec: number;
  width: number;
  height: number;
  file_size_bytes: number;
  language: OutputLanguage;
  voice_gender: VoiceGender;
  voice_engine: string;
  character_mode: string;
  watermark_boxes_removed: number;
  mid_twist_second: number;
  youtube_trends_count: number;
  voiceover: string;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  posting_time: string;
  completed_at: string;
  is_long_video_split?: boolean;
  source_total_duration?: number;
  clips?: RenderedClipItem[];
}

export interface SavedRenderRecord {
  manifest: RenderResultManifest;
  sourceLabel: string;
  customAngle: string;
  githubRunUrl?: string;
}

export interface PipelineProgressState {
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  activeStep: PipelineStepId | null;
  completedSteps: PipelineStepId[];
  percent: number;
  statusDetail: string;
  runTag: string | null;
  githubRunId: number | null;
  githubRunUrl: string | null;
  startedAtMs: number | null;
  errorMessage: string | null;
}

export interface StudioConfig {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  githubBranch: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
  sessionCookie: string;
  characterImageUrl: string;
  savedCharacters: SavedCharacterAsset[];
}
