import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar, type ActiveTab } from './components/TopBar';
import { StudioConfigBar } from './components/StudioConfigBar';
import { VideoDropzone } from './components/VideoDropzone';
import { ExplainerControls } from './components/ExplainerControls';
import { CloudProgressBar } from './components/CloudProgressBar';
import { VerticalPlayerCard } from './components/VerticalPlayerCard';
import { MetadataDeck } from './components/MetadataDeck';
import { RecentRendersView } from './components/RecentRendersView';
import {
  clearStudioConfig,
  getMissingConfigFields,
  loadStudioConfig,
  saveStudioConfig,
} from './lib/env';
import { probeLocalVideoFile } from './lib/videoProbe';
import {
  fetchRenderResultManifest,
  uploadRawVideoToCloudinary,
} from './lib/cloudinary';
import {
  cancelWorkflowRun,
  dispatchCloudRender,
  extractJobIdFromRunName,
  fetchRecentWorkflowRuns,
  fetchWorkflowRunJobs,
  findWorkflowRunByJobId,
  mapGitHubStepsToStudioProgress,
} from './lib/github';
import {
  deleteRenderRecord,
  loadSavedRenders,
  saveRenderRecord,
} from './lib/storage';
import type {
  CloudEnvConfig,
  LocalClipInfo,
  PipelineProgressState,
  RenderResultManifest,
  SavedRenderRecord,
  StudioControlsState,
} from './types/studio';

const DEFAULT_CONTROLS: StudioControlsState = {
  customPrompt: '',
  voiceGender: 'female',
  shieldFlags: {
    crop_watermark: true,
    micro_zoom: true,
    color_grade: true,
    strip_metadata: true,
  },
  captionTheme: 'capcut_yellow_white',
};

const IDLE_PROGRESS: PipelineProgressState = {
  status: 'idle',
  activeStep: null,
  completedSteps: [],
  percent: 0,
  statusDetail: 'Drop a source clip and click Render to launch the 7GB GitHub Actions engine.',
  jobId: null,
  githubRunId: null,
  githubRunUrl: null,
  startedAtMs: null,
  errorMessage: null,
};

function createJobId(): string {
  const hex = Math.random().toString(16).slice(2, 8);
  return `exp_${Date.now()}_${hex}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [studioConfig, setStudioConfig] = useState<CloudEnvConfig>(() =>
    loadStudioConfig()
  );
  const [isConfigExpanded, setIsConfigExpanded] = useState(false);
  const [localClip, setLocalClip] = useState<LocalClipInfo | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [controls, setControls] = useState<StudioControlsState>(DEFAULT_CONTROLS);
  const [progress, setProgress] = useState<PipelineProgressState>(IDLE_PROGRESS);
  const [result, setResult] = useState<RenderResultManifest | null>(null);
  const [savedRenders, setSavedRenders] = useState<SavedRenderRecord[]>(() =>
    loadSavedRenders()
  );

  const handleSaveConfig = useCallback((next: CloudEnvConfig) => {
    const saved = saveStudioConfig(next);
    setStudioConfig(saved);
    if (getMissingConfigFields(saved).length === 0) {
      window.setTimeout(() => setIsConfigExpanded(false), 700);
    }
  }, []);

  const handleClearConfig = useCallback(() => {
    setStudioConfig(clearStudioConfig());
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const clearLocalClip = useCallback(() => {
    setLocalClip((prev) => {
      if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
    setClipError(null);
  }, []);

  const handleFileSelected = useCallback(async (file: File) => {
    setClipError(null);
    try {
      const info = await probeLocalVideoFile(file);
      setLocalClip((prev) => {
        if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
        return info;
      });
      setResult(null);
      setProgress(IDLE_PROGRESS);
    } catch (err) {
      setClipError((err as Error).message);
    }
  }, []);

  const handleResetWorkspace = useCallback(() => {
    if (progress.status === 'running') return;
    clearLocalClip();
    setControls(DEFAULT_CONTROLS);
    setProgress(IDLE_PROGRESS);
    setResult(null);
    setActiveTab('studio');
  }, [clearLocalClip, progress.status]);

  const handleCancelRender = useCallback(async () => {
    abortRef.current?.abort();
    const runId = activeRunIdRef.current;
    const env = studioConfig;
    if (runId && env.githubToken && env.repoOwner && env.repoName) {
      try {
        await cancelWorkflowRun(env, runId);
      } catch {
        // Ignore cancellation network error after abort
      }
    }
    activeRunIdRef.current = null;
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
      statusDetail: 'Cloud render cancelled. Ready for a new clip.',
      errorMessage: null,
    }));
  }, [studioConfig]);

  const handleStartRender = useCallback(async () => {
    if (!localClip || progress.status === 'running') return;

    const env = studioConfig;
    const missing = getMissingConfigFields(env);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      setProgress({
        ...IDLE_PROGRESS,
        status: 'error',
        activeStep: 'uploading',
        statusDetail: 'Configure Studio Keys & Config before dispatching.',
        errorMessage: `Missing Studio Keys: ${missing.join(
          ', '
        )}. Enter them in the "Studio Keys & Config" bar above (saved locally in your browser).`,
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    activeRunIdRef.current = null;

    const jobId = createJobId();
    const startedAtMs = Date.now();
    setResult(null);

    setProgress({
      status: 'running',
      activeStep: 'uploading',
      completedSteps: [],
      percent: 4,
      statusDetail: 'Uploading raw source video to temporary Cloudinary storage...',
      jobId,
      githubRunId: null,
      githubRunUrl: null,
      startedAtMs,
      errorMessage: null,
    });

    try {
      // Stage 1: Direct browser upload to Cloudinary
      const uploadRes = await uploadRawVideoToCloudinary(
        localClip.file,
        jobId,
        env,
        (uploadPct) => {
          const scaledPct = Math.max(4, Math.min(20, Math.round((uploadPct / 100) * 20)));
          setProgress((prev) => ({
            ...prev,
            percent: scaledPct,
            statusDetail: `Uploading raw clip to Cloudinary (${uploadPct}%)...`,
          }));
        },
        controller.signal
      );

      // Stage 2: Dispatch GitHub Actions workflow_dispatch
      const dispatchedAtMs = Date.now();
      setProgress((prev) => ({
        ...prev,
        activeStep: 'vision_script',
        completedSteps: ['uploading'],
        percent: 22,
        statusDetail: 'Dispatching 7GB Cloud Render job on GitHub Actions...',
      }));

      await dispatchCloudRender(
        env,
        {
          jobId,
          rawVideoUrl: uploadRes.secure_url,
          rawPublicId: uploadRes.public_id,
          customPrompt: controls.customPrompt,
          voiceGender: controls.voiceGender,
          shieldFlags: controls.shieldFlags,
          captionTheme: controls.captionTheme,
        },
        controller.signal
      );

      // Locate the newly dispatched workflow run by jobId
      let matchedRun = null;
      for (let lookup = 0; lookup < 24; lookup++) {
        await sleep(2500, controller.signal);
        matchedRun = await findWorkflowRunByJobId(
          env,
          jobId,
          dispatchedAtMs,
          controller.signal
        );
        if (matchedRun) break;
      }

      if (!matchedRun) {
        throw new Error(
          'GitHub Actions accepted the dispatch, but the workflow run did not appear within 60 seconds. Check your repository Actions tab.'
        );
      }

      activeRunIdRef.current = matchedRun.id;
      setProgress((prev) => ({
        ...prev,
        githubRunId: matchedRun.id,
        githubRunUrl: matchedRun.html_url,
        statusDetail: '7GB Cloud runner assigned. Waiting for AI Vision & Script stage...',
      }));

      // Poll live run + job steps every 3 seconds until completion
      let finishedSuccessfully = false;
      for (let poll = 0; poll < 240; poll++) {
        const { run, jobs } = await fetchWorkflowRunJobs(
          env,
          matchedRun.id,
          controller.signal
        );
        const mapped = mapGitHubStepsToStudioProgress(run, jobs);

        setProgress((prev) => ({
          ...prev,
          activeStep: mapped.activeStep,
          completedSteps: mapped.completedSteps,
          percent: mapped.percent,
          statusDetail: mapped.detail,
          githubRunUrl: run.html_url,
        }));

        if (run.status === 'completed') {
          if (run.conclusion === 'success') {
            finishedSuccessfully = true;
            break;
          }
          throw new Error(
            `GitHub Actions workflow finished with conclusion "${run.conclusion ?? 'unknown'}". Inspect the GitHub Run logs for details.`
          );
        }

        await sleep(3000, controller.signal);
      }

      if (!finishedSuccessfully) {
        throw new Error('Cloud render timed out after 12 minutes of polling.');
      }

      // Fetch final manifest JSON directly from Cloudinary
      setProgress((prev) => ({
        ...prev,
        activeStep: 'ready',
        completedSteps: [
          'uploading',
          'vision_script',
          'voice_captions',
          'ffmpeg_render',
        ],
        percent: 98,
        statusDetail: 'Loading finished 1080×1920 MP4 and US viral metadata...',
      }));

      const manifest = await fetchRenderResultManifest(
        env.cloudinaryCloudName,
        jobId,
        controller.signal
      );

      setResult(manifest);
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        activeStep: 'ready',
        completedSteps: [
          'uploading',
          'vision_script',
          'voice_captions',
          'ffmpeg_render',
          'ready',
        ],
        percent: 100,
        statusDetail:
          'Finished 1080×1920 MP4 rendered and raw source deleted from Cloudinary.',
      }));

      const updatedHistory = saveRenderRecord({
        manifest,
        sourceFileName: localClip.name,
        customPrompt: controls.customPrompt,
        githubRunUrl: matchedRun.html_url,
      });
      setSavedRenders(updatedHistory);
      activeRunIdRef.current = null;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return;
      }
      activeRunIdRef.current = null;
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        statusDetail: 'Cloud render halted due to an error.',
        errorMessage: (err as Error).message || 'Unexpected render failure.',
      }));
    }
  }, [controls, localClip, progress.status, studioConfig]);

  const handleLoadRecord = useCallback((record: SavedRenderRecord) => {
    setResult(record.manifest);
    setProgress({
      status: 'completed',
      activeStep: 'ready',
      completedSteps: [
        'uploading',
        'vision_script',
        'voice_captions',
        'ffmpeg_render',
        'ready',
      ],
      percent: 100,
      statusDetail: `Loaded completed render (${record.manifest.job_id}).`,
      jobId: record.manifest.job_id,
      githubRunId: null,
      githubRunUrl: record.githubRunUrl ?? null,
      startedAtMs: null,
      errorMessage: null,
    });
    setActiveTab('studio');
  }, []);

  const handleDeleteRecord = useCallback((jobId: string) => {
    setSavedRenders(deleteRenderRecord(jobId));
  }, []);

  const handleSyncFromGitHub = useCallback(async (): Promise<string> => {
    const env = studioConfig;
    const missing = getMissingConfigFields(env);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      throw new Error(
        `Add ${missing.join(', ')} in the "Studio Keys & Config" bar above to sync GitHub Actions runs.`
      );
    }

    const runs = await fetchRecentWorkflowRuns(env);
    const completedRuns = runs.filter(
      (r) => r.status === 'completed' && r.conclusion === 'success'
    );

    let synced = 0;
    let latestList = loadSavedRenders();
    const existingIds = new Set(latestList.map((r) => r.manifest.job_id));

    for (const run of completedRuns) {
      const jobId = extractJobIdFromRunName(run.name);
      if (!jobId || existingIds.has(jobId)) continue;
      try {
        const manifest = await fetchRenderResultManifest(
          env.cloudinaryCloudName,
          jobId
        );
        latestList = saveRenderRecord({
          manifest,
          sourceFileName: `${jobId}.mp4`,
          customPrompt: '',
          githubRunUrl: run.html_url,
        });
        existingIds.add(jobId);
        synced += 1;
      } catch {
        // Skip runs whose Cloudinary manifest is unavailable or expired
      }
    }

    setSavedRenders(latestList);
    if (synced === 0) {
      return `Checked ${completedRuns.length} completed GitHub Actions runs — history is up to date.`;
    }
    return `Synced ${synced} completed cloud render${synced === 1 ? '' : 's'} from GitHub Actions.`;
  }, [studioConfig]);

  return (
    <div className="min-h-screen bg-[#F4F6F9] text-[#0F172A] flex flex-col">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onResetWorkspace={handleResetWorkspace}
        isRendering={progress.status === 'running'}
        savedCount={savedRenders.length}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 py-5 space-y-5">
        <StudioConfigBar
          config={studioConfig}
          isExpanded={isConfigExpanded}
          onToggleExpand={() => setIsConfigExpanded((open) => !open)}
          onSave={handleSaveConfig}
          onClear={handleClearConfig}
        />

        {activeTab === 'studio' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* LEFT COLUMN: Upload & Custom US Explainer Controls */}
            <div className="lg:col-span-5 space-y-5">
              <VideoDropzone
                clip={localClip}
                disabled={progress.status === 'running'}
                error={clipError}
                onFileSelected={(file) => void handleFileSelected(file)}
                onClearClip={clearLocalClip}
              />

              <ExplainerControls
                controls={controls}
                hasClip={Boolean(localClip)}
                isRendering={progress.status === 'running'}
                onChange={setControls}
                onStartRender={() => void handleStartRender()}
              />
            </div>

            {/* RIGHT COLUMN: Live Stepped Progress, Vertical Player & Viral Metadata Deck */}
            <div className="lg:col-span-7 space-y-5">
              <CloudProgressBar
                progress={progress}
                onCancelRender={() => void handleCancelRender()}
                onDismissError={() => setProgress(IDLE_PROGRESS)}
              />

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
                <div className="xl:col-span-5">
                  <VerticalPlayerCard localClip={localClip} result={result} />
                </div>
                <div className="xl:col-span-7">
                  <MetadataDeck result={result} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <RecentRendersView
            records={savedRenders}
            onLoadRecord={handleLoadRecord}
            onDeleteRecord={handleDeleteRecord}
            onSyncFromGitHub={handleSyncFromGitHub}
            onGoToStudio={() => setActiveTab('studio')}
          />
        )}
      </main>
    </div>
  );
}
