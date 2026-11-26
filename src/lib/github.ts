import type {
  OutputLanguage,
  PipelineStepId,
  SourceType,
  StudioConfig,
  VoiceGender,
} from '../types/studio';

export interface WorkflowDispatchPayload {
  videoSource: string;
  sourceType: SourceType;
  language: OutputLanguage;
  voiceGender: VoiceGender;
  customAngle: string;
  characterEnabled: boolean;
  characterUrl: string;
  outfitPrompt: string;
  runTag: string;
  sessionCookie?: string;
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
  config: StudioConfig,
  payload: WorkflowDispatchPayload,
  signal?: AbortSignal
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(
    config.repoOwner
  )}/${encodeURIComponent(
    config.repoName
  )}/actions/workflows/scheduler.yml/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: githubHeaders(config.githubToken),
    body: JSON.stringify({
      ref: config.githubBranch,
      inputs: {
        video_source: payload.videoSource,
        source_type: payload.sourceType,
        language: payload.language,
        voice_gender: payload.voiceGender,
        custom_angle: payload.customAngle.trim(),
        character_enabled: payload.characterEnabled ? 'true' : 'false',
        character_url: payload.characterEnabled ? payload.characterUrl : '',
        outfit_prompt: payload.characterEnabled ? payload.outfitPrompt.trim() : '',
        run_tag: payload.runTag,
        session_cookie: payload.sessionCookie?.trim() ?? '',
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

export async function findWorkflowRunByTag(
  config: StudioConfig,
  runTag: string,
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

  const exactMatch = runs.find((run) => run.name?.includes(runTag));
  if (exactMatch) return exactMatch;

  const recentFallback = runs.find((run) => {
    const createdMs = Date.parse(run.created_at);
    return Number.isFinite(createdMs) && createdMs >= dispatchedAtMs - 15000;
  });

  return recentFallback ?? null;
}

export async function fetchWorkflowRunJobs(
  config: StudioConfig,
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
  config: StudioConfig,
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
  config: StudioConfig
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

export function extractRunTagFromRunName(runName: string): string | null {
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
  const steps = jobs[0]?.steps ?? [];
  const findStep = (name: string) =>
    steps.find((s) => s.name.toLowerCase() === name.toLowerCase());

  const fetchStep = findStep('Fetching Link');
  const analyzeStep = findStep('1-FPS Scan & Trend Research');
  const voiceCharStep = findStep('Suspense Voice & Character');
  const renderStep = findStep('Anti-Copyright Render');
  const publishStep = findStep('Publish & Cleanup');

  if (run.status === 'completed' && run.conclusion === 'success') {
    return {
      activeStep: 'ready',
      completedSteps: [
        'fetching_link',
        'scan_trends',
        'voice_character',
        'anti_copyright_render',
        'ready',
      ],
      percent: 100,
      detail: 'Finished 1080×1920 MP4 clip(s) and live YouTube-grounded metadata are ready.',
    };
  }

  if (
    publishStep &&
    (publishStep.status === 'in_progress' || publishStep.status === 'completed')
  ) {
    return {
      activeStep: 'ready',
      completedSteps: [
        'fetching_link',
        'scan_trends',
        'voice_character',
        'anti_copyright_render',
      ],
      percent: 94,
      detail:
        'Uploading finished 1080×1920 MP4 clip(s) to Cloudinary and deleting temporary raw files...',
    };
  }

  if (renderStep && renderStep.status === 'in_progress') {
    return {
      activeStep: 'anti_copyright_render',
      completedSteps: ['fetching_link', 'scan_trends', 'voice_character'],
      percent: 78,
      detail:
        'Applying watermark delogo, 15% crop, dynamic zoom, CapCut captions & timed character pop-ins...',
    };
  }

  if (voiceCharStep && voiceCharStep.status === 'in_progress') {
    return {
      activeStep: 'voice_character',
      completedSteps: ['fetching_link', 'scan_trends'],
      percent: 58,
      detail:
        'Generating deep suspense voiceover and face-locked talking character segments...',
    };
  }

  if (analyzeStep && analyzeStep.status === 'in_progress') {
    return {
      activeStep: 'scan_trends',
      completedSteps: ['fetching_link'],
      percent: 38,
      detail:
        'Scanning video at 1 FPS with Gemini Vision and querying live YouTube Data API v3 trends...',
    };
  }

  if (fetchStep && fetchStep.status === 'completed') {
    return {
      activeStep: 'scan_trends',
      completedSteps: ['fetching_link'],
      percent: 30,
      detail: 'Source video acquired. Starting 1-FPS Scan & Trend Research...',
    };
  }

  return {
    activeStep: 'fetching_link',
    completedSteps: [],
    percent: fetchStep?.status === 'in_progress' ? 22 : 16,
    detail:
      fetchStep?.status === 'in_progress'
        ? 'Extracting clean source video via 3-layer link engine on 7GB runner...'
        : run.status === 'queued'
        ? 'Waiting for 7GB GitHub Actions runner to start...'
        : 'Booting FFmpeg, yt-dlp, Playwright Chromium & ONNX cache on 7GB runner...',
  };
}
