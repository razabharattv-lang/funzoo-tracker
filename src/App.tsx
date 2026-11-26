import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Scissors } from 'lucide-react';
import { TopBar, type ActiveTab } from './components/TopBar';
import { StudioConfigBar } from './components/StudioConfigBar';
import { VideoSourceCard } from './components/VideoSourceCard';
import { CharacterCard } from './components/CharacterCard';
import { ExplainerControls } from './components/ExplainerControls';
import { CloudProgressBar } from './components/CloudProgressBar';
import { VerticalPlayerCard } from './components/VerticalPlayerCard';
import { MetadataDeck } from './components/MetadataDeck';
import { RecentRendersView } from './components/RecentRendersView';
import {
  clearStudioKeysOnly,
  getMissingConfigFields,
  loadStudioConfig,
  saveStudioConfig,
} from './lib/env';
import { formatDuration, probeLocalVideoFile } from './lib/videoProbe';
import { extractVideoUrl } from './lib/urlExtractor';
import {
  fetchRenderResultManifest,
  uploadCharacterPortraitToCloudinary,
  uploadRawVideoToCloudinary,
} from './lib/cloudinary';
import {
  cancelWorkflowRun,
  dispatchCloudRender,
  extractRunTagFromRunName,
  fetchRecentWorkflowRuns,
  fetchWorkflowRunJobs,
  findWorkflowRunByTag,
  mapGitHubStepsToStudioProgress,
} from './lib/github';
import {
  deleteRenderRecord,
  loadSavedRenders,
  saveRenderRecord,
} from './lib/storage';
import type {
  LocalClipInfo,
  PipelineProgressState,
  RenderedClipItem,
  RenderResultManifest,
  SavedCharacterAsset,
  SavedRenderRecord,
  StudioConfig,
  StudioControlsState,
} from './types/studio';

const IDLE_PROGRESS: PipelineProgressState = {
  status: 'idle',
  activeStep: null,
  completedSteps: [],
  percent: 0,
  statusDetail:
    'Paste any video link or Chinese share-text (or upload a file), then click Generate Production Video.',
  runTag: null,
  githubRunId: null,
  githubRunUrl: null,
  startedAtMs: null,
  errorMessage: null,
};

function createRunTag(): string {
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

function normalizeManifestClips(
  manifest: RenderResultManifest | null
): RenderedClipItem[] {
  if (!manifest) return [];
  if (Array.isArray(manifest.clips) && manifest.clips.length > 0) {
    return manifest.clips;
  }
  return [
    {
      clip_index: 1,
      start_sec: 0,
      end_sec: manifest.duration_sec,
      reason: 'Short Video Full Cut',
      video_url: manifest.video_url,
      video_public_id: manifest.video_public_id,
      duration_sec: manifest.duration_sec,
      width: manifest.width,
      height: manifest.height,
      file_size_bytes: manifest.file_size_bytes,
      voice_engine: manifest.voice_engine,
      character_mode: manifest.character_mode,
      watermark_boxes_removed: manifest.watermark_boxes_removed,
      climax_second: manifest.mid_twist_second,
      youtube_trends_count: manifest.youtube_trends_count,
      voiceover: manifest.voiceover,
      title: manifest.title,
      description: manifest.description,
      tags: manifest.tags,
      hashtags: manifest.hashtags,
      posting_time: manifest.posting_time,
    },
  ];
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [studioConfig, setStudioConfig] = useState<StudioConfig>(() =>
    loadStudioConfig()
  );
  const [isConfigExpanded, setIsConfigExpanded] = useState(false);

  const [localClip, setLocalClip] = useState<LocalClipInfo | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);

  const [controls, setControls] = useState<StudioControlsState>(() => {
    const initialConfig = loadStudioConfig();
    return {
      sourceType: 'link',
      videoUrl: '',
      language: 'en',
      voiceGender: 'male',
      customAngle: '',
      characterEnabled: false,
      selectedCharacterId: initialConfig.savedCharacters[0]?.id ?? null,
      outfitPrompt: '',
    };
  });

  const [isUploadingPortrait, setIsUploadingPortrait] = useState(false);
  const [portraitError, setPortraitError] = useState<string | null>(null);

  const [progress, setProgress] = useState<PipelineProgressState>(IDLE_PROGRESS);
  const [result, setResult] = useState<RenderResultManifest | null>(null);
  const [selectedClipIndex, setSelectedClipIndex] = useState(0);
  const [savedRenders, setSavedRenders] = useState<SavedRenderRecord[]>(() =>
    loadSavedRenders()
  );

  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const renderedClips = useMemo(
    () => normalizeManifestClips(result),
    [result]
  );
  const activeClip =
    renderedClips[selectedClipIndex] ?? renderedClips[0] ?? null;

  const handleSaveConfig = useCallback((next: StudioConfig) => {
    const saved = saveStudioConfig(next);
    setStudioConfig(saved);
    if (saved.characterImageUrl) {
      const matched = saved.savedCharacters.find(
        (c) => c.url === saved.characterImageUrl
      );
      if (matched) {
        setControls((prev) => ({
          ...prev,
          selectedCharacterId: matched.id,
        }));
      }
    }
    if (getMissingConfigFields(saved, true).length === 0) {
      window.setTimeout(() => setIsConfigExpanded(false), 700);
    }
  }, []);

  const handleClearKeys = useCallback(() => {
    setStudioConfig((current) => clearStudioKeysOnly(current));
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
      setSelectedClipIndex(0);
      setProgress(IDLE_PROGRESS);
    } catch (err) {
      setClipError((err as Error).message);
    }
  }, []);

  const handleUploadPortrait = useCallback(
    async (file: File) => {
      setPortraitError(null);
      if (
        !studioConfig.cloudinaryCloudName ||
        !studioConfig.cloudinaryUploadPreset
      ) {
        setIsConfigExpanded(true);
        setPortraitError(
          'Add your Cloudinary Cloud Name and Unsigned Upload Preset in Studio Config first.'
        );
        return;
      }

      setIsUploadingPortrait(true);
      try {
        const res = await uploadCharacterPortraitToCloudinary(file, studioConfig);
        const cleanName = file.name.replace(/\.[^.]+$/, '').slice(0, 32) || 'Portrait';
        const newAsset: SavedCharacterAsset = {
          id: `char_${Date.now()}`,
          name: cleanName,
          url: res.secure_url,
          publicId: res.public_id,
          uploadedAt: new Date().toISOString(),
        };
        const nextConfig = saveStudioConfig({
          ...studioConfig,
          characterImageUrl: res.secure_url,
          savedCharacters: [newAsset, ...studioConfig.savedCharacters].slice(0, 8),
        });
        setStudioConfig(nextConfig);
        setControls((prev) => ({
          ...prev,
          characterEnabled: true,
          selectedCharacterId: newAsset.id,
        }));
      } catch (err) {
        setPortraitError((err as Error).message);
      } finally {
        setIsUploadingPortrait(false);
      }
    },
    [studioConfig]
  );

  const handleSelectCharacter = useCallback(
    (selectedCharacterId: string) => {
      setControls((prev) => ({ ...prev, selectedCharacterId }));
      const chosen = studioConfig.savedCharacters.find(
        (c) => c.id === selectedCharacterId
      );
      if (chosen) {
        const nextConfig = saveStudioConfig({
          ...studioConfig,
          characterImageUrl: chosen.url,
        });
        setStudioConfig(nextConfig);
      }
    },
    [studioConfig]
  );

  const handleDeleteCharacter = useCallback(
    (id: string) => {
      const remaining = studioConfig.savedCharacters.filter((c) => c.id !== id);
      const nextUrl = remaining[0]?.url ?? '';
      const nextConfig = saveStudioConfig({
        ...studioConfig,
        characterImageUrl: nextUrl,
        savedCharacters: remaining,
      });
      setStudioConfig(nextConfig);
      setControls((prev) => ({
        ...prev,
        selectedCharacterId:
          prev.selectedCharacterId === id
            ? remaining[0]?.id ?? null
            : prev.selectedCharacterId,
      }));
    },
    [studioConfig]
  );

  const handleResetWorkspace = useCallback(() => {
    if (progress.status === 'running') return;
    clearLocalClip();
    setControls((prev) => ({
      ...prev,
      videoUrl: '',
      customAngle: '',
      outfitPrompt: '',
    }));
    setProgress(IDLE_PROGRESS);
    setResult(null);
    setSelectedClipIndex(0);
    setActiveTab('studio');
  }, [clearLocalClip, progress.status]);

  const handleCancelRender = useCallback(async () => {
    abortRef.current?.abort();
    const runId = activeRunIdRef.current;
    if (
      runId &&
      studioConfig.githubToken &&
      studioConfig.repoOwner &&
      studioConfig.repoName
    ) {
      try {
        await cancelWorkflowRun(studioConfig, runId);
      } catch {
        // ignore cancel error after abort
      }
    }
    activeRunIdRef.current = null;
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
      statusDetail: 'Cloud render cancelled. Ready for your next video.',
      errorMessage: null,
    }));
  }, [studioConfig]);

  const activeCharacter =
    studioConfig.savedCharacters.find(
      (c) => c.id === controls.selectedCharacterId
    ) ??
    studioConfig.savedCharacters[0] ??
    null;

  const activeCharacterUrl =
    activeCharacter?.url || studioConfig.characterImageUrl || '';

  const extractedLink = extractVideoUrl(controls.videoUrl);

  const canGenerate =
    controls.sourceType === 'upload'
      ? Boolean(localClip)
      : Boolean(extractedLink);

  const handleStartRender = useCallback(async () => {
    if (!canGenerate || progress.status === 'running') return;

    const requireUnsignedPreset = controls.sourceType === 'upload';
    const missing = getMissingConfigFields(studioConfig, requireUnsignedPreset);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      setProgress({
        ...IDLE_PROGRESS,
        status: 'error',
        activeStep: 'fetching_link',
        statusDetail: 'Complete Studio Config before starting a cloud render.',
        errorMessage: `Missing Studio Config fields: ${missing.join(
          ', '
        )}. Enter them in the collapsible Studio Config bar above.`,
      });
      return;
    }

    if (controls.characterEnabled && !activeCharacterUrl) {
      setPortraitError('Upload a character portrait or turn Talking Character OFF.');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    activeRunIdRef.current = null;

    const runTag = createRunTag();
    const startedAtMs = Date.now();
    setResult(null);
    setSelectedClipIndex(0);
    setPortraitError(null);

    setProgress({
      status: 'running',
      activeStep: 'fetching_link',
      completedSteps: [],
      percent: 4,
      statusDetail:
        controls.sourceType === 'upload'
          ? 'Uploading raw clip to Cloudinary...'
          : 'Dispatching pasted video URL to 7GB GitHub Actions runner...',
      runTag,
      githubRunId: null,
      githubRunUrl: null,
      startedAtMs,
      errorMessage: null,
    });

    try {
      let videoSourceForWorkflow = extractedLink?.cleanUrl ?? controls.videoUrl.trim();
      let sourceLabel = videoSourceForWorkflow;

      if (controls.sourceType === 'upload' && localClip) {
        sourceLabel = localClip.name;
        const uploadRes = await uploadRawVideoToCloudinary(
          localClip.file,
          runTag,
          studioConfig,
          (uploadPct) => {
            const scaled = Math.max(4, Math.min(18, Math.round((uploadPct / 100) * 18)));
            setProgress((prev) => ({
              ...prev,
              percent: scaled,
              statusDetail: `Uploading raw clip to Cloudinary (${uploadPct}%)...`,
            }));
          },
          controller.signal
        );
        videoSourceForWorkflow = uploadRes.secure_url;
      }

      const dispatchedAtMs = Date.now();
      setProgress((prev) => ({
        ...prev,
        percent: Math.max(prev.percent, 18),
        statusDetail: 'Triggering 7GB GitHub Actions workflow...',
      }));

      await dispatchCloudRender(
        studioConfig,
        {
          videoSource: videoSourceForWorkflow,
          sourceType: controls.sourceType,
          language: controls.language,
          voiceGender: controls.voiceGender,
          customAngle: controls.customAngle,
          characterEnabled: controls.characterEnabled,
          characterUrl: controls.characterEnabled ? activeCharacterUrl : '',
          outfitPrompt: controls.characterEnabled ? controls.outfitPrompt : '',
          runTag,
          sessionCookie: studioConfig.sessionCookie,
        },
        controller.signal
      );

      // Locate matching workflow run by run_tag
      let matchedRun = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        await sleep(2500, controller.signal);
        matchedRun = await findWorkflowRunByTag(
          studioConfig,
          runTag,
          dispatchedAtMs,
          controller.signal
        );
        if (matchedRun) break;
      }

      if (!matchedRun) {
        throw new Error(
          'Workflow dispatched, but the GitHub Actions run did not appear within 60 seconds. Check your repository Actions tab.'
        );
      }

      activeRunIdRef.current = matchedRun.id;
      setProgress((prev) => ({
        ...prev,
        githubRunId: matchedRun.id,
        githubRunUrl: matchedRun.html_url,
        statusDetail: '7GB runner started. Fetching source video...',
      }));

      let finishedOk = false;
      for (let poll = 0; poll < 360; poll++) {
        const { run, jobs } = await fetchWorkflowRunJobs(
          studioConfig,
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
            finishedOk = true;
            break;
          }
          throw new Error(
            `GitHub Actions workflow finished with "${run.conclusion ?? 'failure'}". Open GitHub Run logs to inspect details.`
          );
        }

        await sleep(3000, controller.signal);
      }

      if (!finishedOk) {
        throw new Error('Cloud render polling timed out after 18 minutes.');
      }

      setProgress((prev) => ({
        ...prev,
        activeStep: 'ready',
        completedSteps: [
          'fetching_link',
          'scan_trends',
          'voice_character',
          'anti_copyright_render',
        ],
        percent: 98,
        statusDetail: 'Loading finished 1080×1920 MP4 clip(s) and grounded metadata...',
      }));

      const manifest = await fetchRenderResultManifest(
        studioConfig.cloudinaryCloudName,
        runTag,
        controller.signal
      );

      const clipsCount = manifest.clips?.length ?? 1;
      setResult(manifest);
      setSelectedClipIndex(0);
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        activeStep: 'ready',
        completedSteps: [
          'fetching_link',
          'scan_trends',
          'voice_character',
          'anti_copyright_render',
          'ready',
        ],
        percent: 100,
        statusDetail:
          clipsCount > 1
            ? `Long video sliced into ${clipsCount} viral 1080×1920 MP4 clips with live YouTube-grounded metadata.`
            : 'Finished 1080×1920 explainer MP4 and live YouTube-grounded metadata are ready.',
      }));

      const updated = saveRenderRecord({
        manifest,
        sourceLabel,
        customAngle: controls.customAngle,
        githubRunUrl: matchedRun.html_url,
      });
      setSavedRenders(updated);
      activeRunIdRef.current = null;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      activeRunIdRef.current = null;
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        statusDetail: 'Cloud render stopped with an error.',
        errorMessage: (err as Error).message || 'Unexpected render failure.',
      }));
    }
  }, [
    activeCharacterUrl,
    canGenerate,
    controls,
    extractedLink,
    localClip,
    progress.status,
    studioConfig,
  ]);

  const handleLoadRecord = useCallback((record: SavedRenderRecord) => {
    setResult(record.manifest);
    setSelectedClipIndex(0);
    const clipsCount = record.manifest.clips?.length ?? 1;
    setProgress({
      status: 'completed',
      activeStep: 'ready',
      completedSteps: [
        'fetching_link',
        'scan_trends',
        'voice_character',
        'anti_copyright_render',
        'ready',
      ],
      percent: 100,
      statusDetail:
        clipsCount > 1
          ? `Loaded ${clipsCount}-clip render (${record.manifest.run_tag}).`
          : `Loaded completed render (${record.manifest.run_tag}).`,
      runTag: record.manifest.run_tag,
      githubRunId: null,
      githubRunUrl: record.githubRunUrl ?? null,
      startedAtMs: null,
      errorMessage: null,
    });
    setActiveTab('studio');
  }, []);

  const handleDeleteRecord = useCallback((runTag: string) => {
    setSavedRenders(deleteRenderRecord(runTag));
  }, []);

  const handleSyncFromGitHub = useCallback(async (): Promise<string> => {
    const missing = getMissingConfigFields(studioConfig, false);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      throw new Error(
        `Add ${missing.join(', ')} in Studio Config above to sync GitHub Actions runs.`
      );
    }

    const runs = await fetchRecentWorkflowRuns(studioConfig);
    const completedRuns = runs.filter(
      (r) => r.status === 'completed' && r.conclusion === 'success'
    );

    let synced = 0;
    let latestList = loadSavedRenders();
    const existingTags = new Set(latestList.map((r) => r.manifest.run_tag));

    for (const run of completedRuns) {
      const tag = extractRunTagFromRunName(run.name);
      if (!tag || existingTags.has(tag)) continue;
      try {
        const manifest = await fetchRenderResultManifest(
          studioConfig.cloudinaryCloudName,
          tag
        );
        latestList = saveRenderRecord({
          manifest,
          sourceLabel: tag,
          customAngle: '',
          githubRunUrl: run.html_url,
        });
        existingTags.add(tag);
        synced += 1;
      } catch {
        // skip runs without manifest
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
          onClearKeys={handleClearKeys}
        />

        {activeTab === 'studio' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* LEFT COLUMN: Zero-Clutter Essential Controls */}
            <div className="lg:col-span-5 space-y-5">
              <VideoSourceCard
                sourceType={controls.sourceType}
                videoUrl={controls.videoUrl}
                clip={localClip}
                disabled={progress.status === 'running'}
                error={clipError}
                onSourceTypeChange={(sourceType) =>
                  setControls((prev) => ({ ...prev, sourceType }))
                }
                onVideoUrlChange={(videoUrl) =>
                  setControls((prev) => ({ ...prev, videoUrl }))
                }
                onFileSelected={(file) => void handleFileSelected(file)}
                onClearClip={clearLocalClip}
              />

              <CharacterCard
                enabled={controls.characterEnabled}
                savedCharacters={studioConfig.savedCharacters}
                selectedCharacterId={controls.selectedCharacterId}
                outfitPrompt={controls.outfitPrompt}
                disabled={progress.status === 'running'}
                isUploadingPortrait={isUploadingPortrait}
                uploadError={portraitError}
                onToggleEnabled={(characterEnabled) =>
                  setControls((prev) => ({ ...prev, characterEnabled }))
                }
                onSelectCharacter={handleSelectCharacter}
                onUploadPortrait={(file) => void handleUploadPortrait(file)}
                onDeleteCharacter={handleDeleteCharacter}
                onOutfitPromptChange={(outfitPrompt) =>
                  setControls((prev) => ({ ...prev, outfitPrompt }))
                }
              />

              <ExplainerControls
                controls={controls}
                canGenerate={canGenerate}
                isRendering={progress.status === 'running'}
                onChange={setControls}
                onStartRender={() => void handleStartRender()}
              />
            </div>

            {/* RIGHT COLUMN: Live 5-Step Progress, Multi-Clip Switcher, 9:16 Player & Copy Output Deck */}
            <div className="lg:col-span-7 space-y-5">
              <CloudProgressBar
                progress={progress}
                onCancelRender={() => void handleCancelRender()}
                onDismissError={() => setProgress(IDLE_PROGRESS)}
              />

              {renderedClips.length > 1 && (
                <section
                  aria-label="Viral Clips Selector"
                  className="rounded-2xl border-2 border-[#3D5AFE] bg-[#EEF2FF] p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-lg bg-[#3D5AFE] text-white flex items-center justify-center shrink-0">
                        <Scissors className="w-4 h-4" strokeWidth={2.5} />
                      </span>
                      <div>
                        <h2 className="text-sm font-extrabold text-[#0F172A]">
                          Top {renderedClips.length} Viral Shorts Extracted
                        </h2>
                        <p className="text-xs font-semibold text-[#334155]">
                          Auto-sliced from{' '}
                          {formatDuration(result?.source_total_duration ?? 0)} long video — select a clip to preview, download &amp; copy metadata
                        </p>
                      </div>
                    </div>
                  </div>

                  <div
                    className={`grid grid-cols-1 gap-2.5 ${
                      renderedClips.length >= 4
                        ? 'sm:grid-cols-2 xl:grid-cols-4'
                        : 'sm:grid-cols-3'
                    }`}
                  >
                    {renderedClips.map((clip, idx) => {
                      const isActive = idx === selectedClipIndex;
                      return (
                        <button
                          key={clip.clip_index}
                          type="button"
                          onClick={() => setSelectedClipIndex(idx)}
                          className={`rounded-xl border-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                            isActive
                              ? 'border-[#3D5AFE] bg-[#3D5AFE] text-white'
                              : 'border-[#CBD5E1] bg-white text-[#0F172A] hover:border-[#3D5AFE]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-extrabold whitespace-nowrap">
                              Clip {clip.clip_index}
                            </span>
                            <span
                              className={`font-mono-tabular text-[11px] font-bold ${
                                isActive ? 'text-white/90' : 'text-[#3D5AFE]'
                              }`}
                            >
                              {formatDuration(clip.start_sec)}–{formatDuration(clip.end_sec)}
                            </span>
                          </div>
                          <p
                            className={`text-[11px] font-semibold mt-1 truncate ${
                              isActive ? 'text-white/90' : 'text-[#64748B]'
                            }`}
                            title={clip.title || clip.reason}
                          >
                            {clip.title || clip.reason}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
                <div className="xl:col-span-5">
                  <VerticalPlayerCard
                    localClip={controls.sourceType === 'upload' ? localClip : null}
                    result={result}
                    activeClip={activeClip}
                    totalClips={renderedClips.length}
                  />
                </div>
                <div className="xl:col-span-7">
                  <MetadataDeck
                    result={result}
                    activeClip={activeClip}
                    totalClips={renderedClips.length}
                  />
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
