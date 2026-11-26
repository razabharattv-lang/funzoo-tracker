export type VoiceGender = 'female' | 'male';

export type ShieldFlag =
  | 'crop_watermark'
  | 'micro_zoom'
  | 'color_grade'
  | 'strip_metadata';

export type CaptionTheme =
  | 'capcut_yellow_white'
  | 'clean_white'
  | 'coral_pop'
  | 'none';

export type PipelineStepId =
  | 'uploading'
  | 'vision_script'
  | 'voice_captions'
  | 'ffmpeg_render'
  | 'ready';

export interface StudioControlsState {
  customPrompt: string;
  voiceGender: VoiceGender;
  shieldFlags: Record<ShieldFlag, boolean>;
  captionTheme: CaptionTheme;
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

export interface RenderResultManifest {
  job_id: string;
  video_url: string;
  video_public_id: string;
  duration_sec: number;
  width: number;
  height: number;
  file_size_bytes: number;
  voice_gender: VoiceGender;
  voice_engine: string;
  shield_options: string[];
  caption_theme: CaptionTheme;
  voiceover: string;
  title: string;
  description: string;
  tags: string;
  hashtags: string;
  posting_time: string;
  completed_at: string;
}

export interface SavedRenderRecord {
  manifest: RenderResultManifest;
  sourceFileName: string;
  customPrompt: string;
  githubRunUrl?: string;
}

export interface PipelineProgressState {
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  activeStep: PipelineStepId | null;
  completedSteps: PipelineStepId[];
  percent: number;
  statusDetail: string;
  jobId: string | null;
  githubRunId: number | null;
  githubRunUrl: string | null;
  startedAtMs: number | null;
  errorMessage: string | null;
}

export interface CloudEnvConfig {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  githubBranch: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
}
