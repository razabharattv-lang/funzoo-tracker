import type {
  CaptionTheme,
  CloudEnvConfig,
  PipelineStepId,
  ShieldFlag,
  VoiceGender,
} from '../types/studio';

export interface WorkflowDispatchPayload {
  jobId: string;
  rawVideoUrl: string;
  rawPublicId: string;
  customPrompt: string;
  voiceGender: VoiceGender;
  shieldFlags: Record<ShieldFlag, boolean>;
  captionTheme: CaptionTheme;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubJobStep {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  number: number;
}

export interface GitHubRunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: GitHubJobStep[];
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function dispatchCloudRender(
  config: CloudEnvConfig,
  payload: WorkflowDispatchPayload,
  signal?: AbortSignal
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(
    config.repoName
  )}/actions/workflows/scheduler.yml/dispatches`;

  const enabledShields = (Object.entries(payload.shieldFlags) as [ShieldFlag, boolean][])
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .join(',');

  const response = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(config.githubToken),
    body: JSON.stringify({
      ref: config.githubBranch,
      inputs: {
        job_id: payload.jobId,
        raw_video_url: payload.rawVideoUrl,
        raw_public_id: payload.rawPublicId,
        custom_prompt: payload.customPrompt.trim(),
        voice_gender: payload.voiceGender,
        shield_options: enabledShields,
        caption_theme: payload.captionTheme,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `GitHub Actions dispatch failed (HTTP ${response.status}): ${errText.slice(0, 220)}`
    );
  }
}

export async function findWorkflowRunByJobId(
  config: CloudEnvConfig,
  jobId: string,
  dispatchedAtMs: number,
  signal?: AbortSignal
): Promise<GitHubWorkflowRun | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(
    config.repoName
  )}/actions/workflows/scheduler.yml/runs?event=workflow_dispatch&per_page=15`;

  const response = await fetch(url, {
    method: 'GET',
    headers: githubHeaders(config.githubToken),
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to query GitHub workflow runs (HTTP ${response.status}).`);
  }

  const data = (await response.json()) as { workflow_runs?: GitHubWorkflowRun[] };
  const runs = data.workflow_runs ?? [];

  const exactMatch = runs.find((run) => run.name?.includes(jobId));
  if (exactMatch) return exactMatch;

  const recentFallback = runs.find((run) => {
    const createdMs = Date.parse(run.created_at);
    return Number.isFinite(createdMs) && createdMs >= dispatchedAtMs - 15000;
  });

  return recentFallback ?? null;
}

export async function fetchWorkflowRunJobs(
  config: CloudEnvConfig,
  runId: number,
  signal?: AbortSignal
): Promise<{ run: GitHubWorkflowRun; jobs: GitHubRunJob[] }> {
  const runUrl = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(config.repoName)}/actions/runs/${runId}`;
  const jobsUrl = `${runUrl}/jobs`;

  const [runResp, jobsResp] = await Promise.all([
    fetch(runUrl, {
      method: 'GET',
      headers: githubHeaders(config.githubToken),
      cache: 'no-store',
      signal,
    }),
    fetch(jobsUrl, {
      method: 'GET',
      headers: githubHeaders(config.githubToken),
      cache: 'no-store',
      signal,
    }),
  ]);

  if (!runResp.ok) {
    throw new Error(`Failed to fetch workflow run status (HTTP ${runResp.status}).`);
  }

  const run = (await runResp.json()) as GitHubWorkflowRun;
  const jobsData = jobsResp.ok
    ? ((await jobsResp.json()) as { jobs?: GitHubRunJob[] })
    : { jobs: [] };

  return { run, jobs: jobsData.jobs ?? [] };
}

export async function cancelWorkflowRun(
  config: CloudEnvConfig,
  runId: number
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(config.repoName)}/actions/runs/${runId}/cancel`;

  await fetch(url, {
    method: 'POST',
    headers: githubHeaders(config.githubToken),
  });
}

export async function fetchRecentWorkflowRuns(
  config: CloudEnvConfig
): Promise<GitHubWorkflowRun[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(
    config.repoName
  )}/actions/workflows/scheduler.yml/runs?event=workflow_dispatch&per_page=12`;

  const response = await fetch(url, {
    method: 'GET',
    headers: githubHeaders(config.githubToken),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`GitHub Actions history returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as { workflow_runs?: GitHubWorkflowRun[] };
  return data.workflow_runs ?? [];
}

export function extractJobIdFromRunName(runName: string): string | null {
  const match = runName.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

export interface MappedStepProgress {
  activeStep: PipelineStepId;
  completedSteps: PipelineStepId[];
  percent: number;
  detail: string;
}

export function mapGitHubStepsToStudioProgress(
  run: GitHubWorkflowRun,
  jobs: GitHubRunJob[]
): MappedStepProgress {
  const completed: PipelineStepId[] = ['uploading'];
  const steps = jobs[0]?.steps ?? [];

  const findStep = (name: string) =>
    steps.find((s) => s.name.toLowerCase() === name.toLowerCase());

  const analyzeStep = findStep('AI Vision & Script');
  const voiceStep = findStep('Voice & Captions');
  const renderStep = findStep('FFmpeg Anti-Copyright Render');
  const publishStep = findStep('Upload Output & Cleanup');

  if (run.status === 'completed' && run.conclusion === 'success') {
    return {
      activeStep: 'ready',
      completedSteps: [
        'uploading',
        'vision_script',
        'voice_captions',
        'ffmpeg_render',
        'ready',
      ],
      percent: 100,
      detail: 'Finished 1080x1920 MP4 and US metadata are ready.',
    };
  }

  if (publishStep && (publishStep.status === 'in_progress' || publishStep.status === 'completed')) {
    completed.push('vision_script', 'voice_captions', 'ffmpeg_render');
    return {
      activeStep: 'ready',
      completedSteps: completed,
      percent: 94,
      detail: 'Uploading finished 1080x1920 MP4 to Cloudinary and removing raw clip...',
    };
  }

  if (renderStep && renderStep.status === 'in_progress') {
    completed.push('vision_script', 'voice_captions');
    return {
      activeStep: 'ffmpeg_render',
      completedSteps: completed,
      percent: 78,
      detail: 'Applying FFmpeg anti-copyright transforms and burning captions...',
    };
  }

  if (voiceStep && voiceStep.status === 'in_progress') {
    completed.push('vision_script');
    return {
      activeStep: 'voice_captions',
      completedSteps: completed,
      percent: 56,
      detail: 'Synthesizing natural American voiceover and ASS pop-up captions...',
    };
  }

  if (analyzeStep && analyzeStep.status === 'in_progress') {
    return {
      activeStep: 'vision_script',
      completedSteps: completed,
      percent: 36,
      detail: 'Gemini Vision is analyzing video frames and writing US explainer script...',
    };
  }

  if (analyzeStep && analyzeStep.status === 'completed') {
    completed.push('vision_script');
    return {
      activeStep: 'voice_captions',
      completedSteps: completed,
      percent: 48,
      detail: 'Starting voice synthesis and caption generation...',
    };
  }

  return {
    activeStep: 'vision_script',
    completedSteps: completed,
    percent: 24,
    detail:
      run.status === 'queued'
        ? 'Waiting for 7GB GitHub Actions runner to boot...'
        : 'Preparing FFmpeg & Python environment on 7GB runner...',
  };
}
