import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar, type ActiveTab } from './components/TopBar';
import { VideoSourceCard } from './components/VideoSourceCard';
import { SourcePreviewCard } from './components/SourcePreviewCard';
import { ExplainerControls } from './components/ExplainerControls';
import { CloudProgressBar } from './components/CloudProgressBar';
import { OutputDeckCard } from './components/OutputDeckCard';
import { RecentRendersView } from './components/RecentRendersView';
import { probeVideoBlobToSource } from './lib/videoProbe';
import {
  buildYouTubeContextNotice,
  extractVideoUrl,
  fetchYouTubeOEmbedContext,
  YOUTUBE_DIRECT_FETCH_BLOCKED_MSG,
  type YouTubeOEmbedContext,
} from './lib/urlExtractor';
import {
  deleteRenderRecord,
  loadSavedRenders,
  saveRenderRecord,
} from './lib/storage';
import { resolveLinkToSourceMedia } from './engine/streamResolver';
import {
  cleanAndGradeClipsStep2,
  inspectAndSliceSegmentsStep1,
} from './engine/visualClipper';
import { translateClipAndBuildSeoStep3 } from './engine/intelligenceEngine';
import { probeInitialConnectionStatus } from './engine/modelRouter';
import {
  createGuaranteedFallbackVoice,
  synthesizeCommandingVoiceover,
} from './engine/audioEngine';
import { renderProductionMp4Gpu } from './engine/gpuRenderer';
import { warmOfflineEngines } from './engine/offlineModels';
import type {
  ConnectionStatusState,
  PipelineProgress,
  PipelineStepId,
  RenderedClipOutput,
  SavedRenderRecord,
  SourceMediaItem,
  StudioControlsState,
  TrendMetadata,
  YouTubeTrendVideo,
} from './types/studio';

const INITIAL_PROGRESS: PipelineProgress = {
  status: 'idle',
  activeStep: null,
  completedSteps: [],
  percent: 0,
  statusDetail: '',
  clipProgressLabel: null,
  runTag: null,
  startedAtMs: null,
  errorMessage: null,
};

const INITIAL_CONTROLS: StudioControlsState = {
  sourceType: 'link',
  videoUrl: '',
  language: 'en',
  voiceGender: 'male',
  aiEngine: 'auto',
  customAngle: '',
};

const INITIAL_CONNECTION_STATUS: ConnectionStatusState = {
  gemini: 'Fallback',
  nvidia: 'Static-Skip',
  youtube: 'Fallback',
  voice: 'Browser-Speech',
  backendAvailable: false,
};

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [controls, setControls] = useState<StudioControlsState>(INITIAL_CONTROLS);
  const [sourceMedia, setSourceMedia] = useState<SourceMediaItem | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isFetchingLink, setIsFetchingLink] = useState(false);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatusState>(
    INITIAL_CONNECTION_STATUS
  );
  const [progress, setProgress] = useState<PipelineProgress>(INITIAL_PROGRESS);
  const [renderedClips, setRenderedClips] = useState<RenderedClipOutput[]>([]);
  const [savedRenders, setSavedRenders] = useState<SavedRenderRecord[]>(() =>
    loadSavedRenders()
  );

  const youtubeLinkContextRef = useRef<YouTubeOEmbedContext | null>(null);
  const sourceMediaRef = useRef<SourceMediaItem | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const linkAbortRef = useRef<AbortController | null>(null);
  const oembedAbortRef = useRef<AbortController | null>(null);
  const sourceLoadSeqRef = useRef(0);
  const pipelineRunSeqRef = useRef(0);
  const sourceUrlRef = useRef<string | null>(null);
  const renderedUrlsRef = useRef<string[]>([]);

  const safeRevokeObjectUrl = useCallback((url: string | null | undefined) => {
    if (!url || !url.startsWith('blob:')) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore already-revoked object URLs
    }
  }, []);

  useEffect(() => {
    let active = true;
    warmOfflineEngines();
    void probeInitialConnectionStatus()
      .then((snapshot) => {
        if (active) setConnectionStatus(snapshot);
      })
      .catch(() => {
        // Keep safe default connection status if initial probe fails
      });
    return () => {
      active = false;
      abortRef.current?.abort();
      linkAbortRef.current?.abort();
      oembedAbortRef.current?.abort();
      safeRevokeObjectUrl(sourceUrlRef.current);
      renderedUrlsRef.current.forEach((u) => safeRevokeObjectUrl(u));
    };
  }, [safeRevokeObjectUrl]);

  const patchConnectionStatus = useCallback(
    (patch: Partial<ConnectionStatusState>) => {
      setConnectionStatus((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const replaceSourceMedia = useCallback(
    (next: SourceMediaItem | null) => {
      if (sourceUrlRef.current && sourceUrlRef.current !== next?.objectUrl) {
        safeRevokeObjectUrl(sourceUrlRef.current);
      }
      sourceUrlRef.current = next?.objectUrl ?? null;
      sourceMediaRef.current = next;
      setSourceMedia(next);
    },
    [safeRevokeObjectUrl]
  );

  const updateYoutubeLinkContext = useCallback(
    (next: YouTubeOEmbedContext | null) => {
      youtubeLinkContextRef.current = next;
    },
    []
  );

  const fetchYouTubeMetadataInBackground = useCallback(
    (rawUrl: string) => {
      oembedAbortRef.current?.abort();
      const extracted = extractVideoUrl(rawUrl);
      if (!extracted?.isYouTube || !extracted.youtubeVideoId) {
        updateYoutubeLinkContext(null);
        return;
      }

      const controller = new AbortController();
      oembedAbortRef.current = controller;
      updateYoutubeLinkContext(null);

      void fetchYouTubeOEmbedContext(extracted.cleanUrl, controller.signal).then(
        (ctx) => {
          if (controller.signal.aborted || !ctx) return;
          updateYoutubeLinkContext(ctx);
          if (!sourceMediaRef.current || sourceMediaRef.current.sourceType !== 'upload') {
            setSourceError(buildYouTubeContextNotice(ctx));
          } else {
            setProgress((prev) =>
              prev.status === 'idle'
                ? {
                    ...prev,
                    statusDetail: `Video ready + YouTube context "${ctx.title}". Click Run Pipeline.`,
                  }
                : prev
            );
          }
        }
      );
    },
    [updateYoutubeLinkContext]
  );

  const replaceRenderedClips = useCallback(
    (next: RenderedClipOutput[]) => {
      const nextUrls = new Set(next.map((c) => c.videoUrl));
      renderedUrlsRef.current.forEach((u) => {
        if (!nextUrls.has(u)) safeRevokeObjectUrl(u);
      });
      renderedUrlsRef.current = next.map((c) => c.videoUrl);
      setRenderedClips(next);
    },
    [safeRevokeObjectUrl]
  );

  const handleFileSelected = useCallback(
    async (file: File) => {
      linkAbortRef.current?.abort();
      const loadSeq = ++sourceLoadSeqRef.current;
      setSourceError(null);
      try {
        const probed = await probeVideoBlobToSource({
          blob: file,
          sourceType: 'upload',
          label: file.name,
          platform: 'Local Video',
        });
        if (loadSeq !== sourceLoadSeqRef.current) {
          safeRevokeObjectUrl(probed.objectUrl);
          return;
        }
        replaceSourceMedia(probed);
        replaceRenderedClips([]);
        const ytCtx = youtubeLinkContextRef.current;
        const ytSuffix = ytCtx?.title
          ? ` · Linked context: "${ytCtx.title}"`
          : '';
        setProgress({
          ...INITIAL_PROGRESS,
          statusDetail: `Video ready (${probed.durationSec.toFixed(1)}s · ${probed.width}×${probed.height}${ytSuffix}). Click Run Pipeline.`,
        });
      } catch (err) {
        if (loadSeq !== sourceLoadSeqRef.current) return;
        setSourceError(
          err instanceof Error
            ? err.message
            : 'Could not read video metadata from this file.'
        );
      }
    },
    [replaceRenderedClips, replaceSourceMedia, safeRevokeObjectUrl]
  );

  const handleFetchLinkPreview = useCallback(async () => {
    setSourceError(null);
    const extracted = extractVideoUrl(controls.videoUrl);
    if (!extracted) {
      setSourceError('Paste a valid http:// or https:// video link first.');
      return;
    }
    if (extracted.isYouTube) {
      replaceSourceMedia(null);
      setSourceError(buildYouTubeContextNotice(youtubeLinkContextRef.current));
      if (!youtubeLinkContextRef.current) {
        fetchYouTubeMetadataInBackground(controls.videoUrl);
      }
      return;
    }

    linkAbortRef.current?.abort();
    const controller = new AbortController();
    linkAbortRef.current = controller;
    const loadSeq = ++sourceLoadSeqRef.current;

    setIsFetchingLink(true);
    try {
      const resolved = await resolveLinkToSourceMedia({
        rawInput: controls.videoUrl,
        signal: controller.signal,
        onStatus: (msg) =>
          setProgress((prev) => ({
            ...prev,
            statusDetail: msg,
          })),
      });
      if (loadSeq !== sourceLoadSeqRef.current || controller.signal.aborted) {
        safeRevokeObjectUrl(resolved.objectUrl);
        return;
      }
      replaceSourceMedia(resolved);
      replaceRenderedClips([]);
      setProgress({
        ...INITIAL_PROGRESS,
        statusDetail: `Source link loaded (${resolved.durationSec.toFixed(1)}s, ${resolved.width}×${resolved.height}). Ready to run all 5 steps.`,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || loadSeq !== sourceLoadSeqRef.current) {
        return;
      }
      setSourceError(
        err instanceof Error
          ? err.message
          : 'Could not fetch video from this link. Please upload the local video file.'
      );
    } finally {
      if (loadSeq === sourceLoadSeqRef.current) {
        setIsFetchingLink(false);
      }
    }
  }, [
    controls.videoUrl,
    fetchYouTubeMetadataInBackground,
    replaceRenderedClips,
    replaceSourceMedia,
    safeRevokeObjectUrl,
  ]);

  const handleClearSource = useCallback(() => {
    replaceSourceMedia(null);
    setSourceError(null);
  }, [replaceSourceMedia]);

  const handleResetWorkspace = useCallback(() => {
    if (progress.status === 'running') return;
    oembedAbortRef.current?.abort();
    updateYoutubeLinkContext(null);
    replaceSourceMedia(null);
    replaceRenderedClips([]);
    setControls(INITIAL_CONTROLS);
    setSourceError(null);
    setProgress(INITIAL_PROGRESS);
    setActiveTab('studio');
  }, [
    progress.status,
    replaceRenderedClips,
    replaceSourceMedia,
    updateYoutubeLinkContext,
  ]);

  const handleCancelPipeline = useCallback(() => {
    abortRef.current?.abort();
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
      statusDetail: 'Pipeline stopped by user.',
    }));
  }, []);

  const handleGenerate = useCallback(async () => {
    setSourceError(null);
    linkAbortRef.current?.abort();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    // Clear stale previous outputs atomically at run start so Output Deck always matches this run
    const runSeq = ++pipelineRunSeqRef.current;
    replaceRenderedClips([]);

    const runTag = `studio-${Date.now().toString(36)}`;
    const runStartedAtMs = Date.now();
    const completedSteps: PipelineStepId[] = [];
    const outputs: RenderedClipOutput[] = [];
    let currentStepLabel = 'Step 1/5 (Fetch)';
    const stepLabels: Record<PipelineStepId, string> = {
      step_1_fetch_clip: 'Step 1/5 (Fetch)',
      step_2_clean_grade: 'Step 2/5 (Clean)',
      step_3_translate_seo: 'Step 3/5 (Translate)',
      step_4_voiceover: 'Step 4/5 (Voice)',
      step_5_mux_output: 'Step 5/5 (Output)',
    };
    const markStep = (
      activeStep: PipelineStepId,
      percent: number,
      statusDetail: string,
      clipProgressLabel: string | null = null
    ) => {
      if (runSeq !== pipelineRunSeqRef.current) return;
      currentStepLabel = stepLabels[activeStep];
      setProgress({
        status: 'running',
        activeStep,
        completedSteps: [...completedSteps],
        percent,
        statusDetail,
        clipProgressLabel,
        runTag,
        startedAtMs: runStartedAtMs,
        errorMessage: null,
      });
    };

    // Keep mobile screens awake and re-acquire Wake Lock after tab switches while pipeline runs
    const wakeLockRef: { current: { release: () => Promise<void> } | null } = {
      current: null,
    };
    const requestWakeLock = async () => {
      try {
        const wl = (
          navigator as Navigator & {
            wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
          }
        ).wakeLock;
        if (wl && !signal.aborted && !document.hidden) {
          wakeLockRef.current = await wl.request('screen');
        }
      } catch {
        // Ignore if unsupported or denied by browser
      }
    };
    const onPipelineVisibility = () => {
      if (!document.hidden && !signal.aborted && runSeq === pipelineRunSeqRef.current) {
        void requestWakeLock();
      }
    };
    void requestWakeLock();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onPipelineVisibility);
    }

    try {
      // STEP 1: Fetch & Smart Clipping
      markStep('step_1_fetch_clip', 6, 'Step 1/5: Verifying source video and real duration...');

      let activeSource = sourceMedia;
      if (!activeSource) {
        if (controls.sourceType === 'link' && extractVideoUrl(controls.videoUrl)) {
          activeSource = await resolveLinkToSourceMedia({
            rawInput: controls.videoUrl,
            signal,
            onStatus: (msg) => markStep('step_1_fetch_clip', 10, `Step 1/5: ${msg}`),
          });
          replaceSourceMedia(activeSource);
        } else {
          throw new Error(
            'Please paste a valid video link or upload a local MP4/MOV/WebM file first.'
          );
        }
      }

      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      const { segments, inspectorModel } = await inspectAndSliceSegmentsStep1({
        source: activeSource,
        onProgress: (detail) =>
          markStep('step_1_fetch_clip', 16, `Step 1/5: ${detail}`),
      });
      if (segments.length === 0) {
        throw new Error('Step 1 returned no usable video segments to process.');
      }

      completedSteps.push('step_1_fetch_clip');

      // STEP 2: Visual Clean & Grade
      markStep(
        'step_2_clean_grade',
        24,
        `Step 2/5: Cleaning, subject-safe framing & grading ${segments.length} clip${segments.length > 1 ? 's' : ''}...`
      );

      const preparedClips = await cleanAndGradeClipsStep2({
        source: activeSource,
        segments,
        inspectorModel,
        onProgress: (detail) =>
          markStep('step_2_clean_grade', 32, `Step 2/5: ${detail}`),
      });

      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (preparedClips.length === 0) {
        throw new Error('Step 2 failed to prepare vertical visual clips.');
      }
      completedSteps.push('step_2_clean_grade');

      // STEP 3: Vision-to-Action + Niche YouTube Trends (1 single YouTube call on detected topic)
      markStep(
        'step_3_translate_seo',
        40,
        'Step 3/5: Inspecting video frames & fetching live US YouTube niche trends...'
      );

      const activeYoutubeCtx = youtubeLinkContextRef.current;
      const effectiveSourceLabel = activeYoutubeCtx?.title
        ? `${activeYoutubeCtx.title}${
            activeYoutubeCtx.authorName ? ` — ${activeYoutubeCtx.authorName}` : ''
          } (${activeSource.label})`
        : activeSource.label;
      const effectiveCustomAngle = activeYoutubeCtx?.title
        ? [
            controls.customAngle.trim(),
            `YouTube context: "${activeYoutubeCtx.title}"${
              activeYoutubeCtx.authorName ? ` by ${activeYoutubeCtx.authorName}` : ''
            }`,
          ]
            .filter(Boolean)
            .join(' | ')
        : controls.customAngle;

      let sharedNicheTrends: YouTubeTrendVideo[] = [];
      const clipMetadataList: TrendMetadata[] = [];
      for (let i = 0; i < preparedClips.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const clip = preparedClips[i];
        const stepPct = 44 + Math.round(((i + 0.5) / preparedClips.length) * 14);
        const clipLabel = `Clip ${clip.clipIndex}/${clip.totalClips}`;

        const meta = await translateClipAndBuildSeoStep3({
          clip,
          sourceLabel: effectiveSourceLabel,
          language: controls.language,
          aiEngine: controls.aiEngine,
          customAngle: effectiveCustomAngle,
          trends: sharedNicheTrends,
          allowYouTubeLookup: i === 0,
          signal,
          onStatus: (detail) =>
            markStep('step_3_translate_seo', stepPct, `Step 3/5: ${detail}`, clipLabel),
          onConnectionPatch: patchConnectionStatus,
        });
        if (i === 0 && meta.fetchedTrends && meta.fetchedTrends.length > 0) {
          sharedNicheTrends = meta.fetchedTrends;
        }
        clipMetadataList.push(meta);
      }

      if (clipMetadataList.length !== preparedClips.length) {
        throw new Error('Step 3 script/SEO count did not match edited clips.');
      }
      completedSteps.push('step_3_translate_seo');

      // STEP 4: Commanding Voiceover (Gemini 3.8 Flash TTS or Real Browser Speech Voiceover)
      const voiceResults: Awaited<
        ReturnType<typeof synthesizeCommandingVoiceover>
      >[] = [];
      for (let i = 0; i < preparedClips.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const clip = preparedClips[i];
        const meta = clipMetadataList[i];
        const clipLabel = `Clip ${clip.clipIndex}/${clip.totalClips}`;
        const stepPct = 60 + Math.round(((i + 0.5) / preparedClips.length) * 14);

        let voice: Awaited<ReturnType<typeof synthesizeCommandingVoiceover>>;
        try {
          voice = await synthesizeCommandingVoiceover({
            scriptText: meta.voiceover,
            beats: meta.beats,
            language: controls.language,
            voiceGender: controls.voiceGender,
            targetDurationSec: clip.lockedVisualDurationSec,
            signal,
            onStatus: (detail) =>
              markStep('step_4_voiceover', stepPct, `Step 4/5: ${detail}`, clipLabel),
          });
        } catch (voiceErr) {
          if (signal.aborted || (voiceErr as Error)?.name === 'AbortError') {
            throw voiceErr;
          }
          markStep(
            'step_4_voiceover',
            stepPct,
            'Step 4/5: Cloud TTS unavailable — continuing with synthesized fallback audio...',
            clipLabel
          );
          voice = createGuaranteedFallbackVoice({
            scriptText: meta.voiceover,
            beats: meta.beats,
            language: controls.language,
            voiceGender: controls.voiceGender,
            targetDurationSec: clip.lockedVisualDurationSec,
            reason: 'Fallback Audio',
          });
        }

        patchConnectionStatus({ voice: voice.voiceSource });
        meta.wordTimings = voice.wordTimings;
        voiceResults.push(voice);
      }

      if (voiceResults.length !== preparedClips.length) {
        throw new Error('Step 4 voiceover count did not match edited clips.');
      }
      completedSteps.push('step_4_voiceover');

      // STEP 5: Fast, Phone-Safe Mux & Output Deck
      for (let i = 0; i < preparedClips.length; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const clip = preparedClips[i];
        const meta = clipMetadataList[i];
        const voice = voiceResults[i];
        const clipLabel = `Clip ${clip.clipIndex}/${clip.totalClips}`;

        const rendered = await renderProductionMp4Gpu({
          source: activeSource,
          clip,
          metadata: meta,
          voice,
          language: controls.language,
          signal,
          onProgress: (localPct, detail) => {
            const overallPct =
              75 +
              Math.round(
                ((i + localPct / 100) / Math.max(1, preparedClips.length)) * 24
              );
            markStep('step_5_mux_output', overallPct, `Step 5/5: ${detail}`, clipLabel);
          },
        });

        const videoUrl = URL.createObjectURL(rendered.blob);
        outputs.push({
          clipIndex: clip.clipIndex,
          totalClips: clip.totalClips,
          startSec: clip.trimRange.startSec,
          endSec: clip.trimRange.endSec,
          reason: clip.reason,
          videoUrl,
          mimeType: rendered.mimeType,
          durationSec: rendered.durationSec,
          width: rendered.width,
          height: rendered.height,
          fps: rendered.fps,
          fileSizeBytes: rendered.blob.size,
          language: controls.language,
          voiceGender: controls.voiceGender,
          voiceEngine: voice.voiceEngine,
          voiceSource: voice.voiceSource,
          renderEngine: rendered.renderEngine,
          watermarkBoxesRemoved: clip.delogoZoneCount,
          endCardTrimmedSec: clip.bumperTrimmedSec,
          safeCropApplied: clip.safeCropApplied,
          climaxSecond: clip.climaxSec,
          metadata: meta,
        });
      }

      if (runSeq !== pipelineRunSeqRef.current || signal.aborted) {
        outputs.forEach((o) => safeRevokeObjectUrl(o.videoUrl));
        return;
      }
      if (outputs.length === 0) {
        throw new Error('Step 5 produced no playable output clips.');
      }
      completedSteps.push('step_5_mux_output');
      replaceRenderedClips(outputs);

      const saved = saveRenderRecord({
        runTag,
        completedAt: new Date().toISOString(),
        sourceLabel: effectiveSourceLabel,
        sourceDurationSec: activeSource.durationSec,
        mode: activeSource.mode,
        customAngle: controls.customAngle,
        clips: outputs,
      });
      setSavedRenders(saved);

      setProgress({
        status: 'completed',
        activeStep: null,
        completedSteps: [...completedSteps],
        percent: 100,
        statusDetail: `Completed ${outputs.length} production clip${outputs.length > 1 ? 's' : ''} + 5 one-click SEO copy cards.`,
        clipProgressLabel: `${outputs.length}/${outputs.length} Done`,
        runTag,
        startedAtMs: null,
        errorMessage: null,
      });
    } catch (err) {
      outputs.forEach((o) => safeRevokeObjectUrl(o.videoUrl));
      if (runSeq !== pipelineRunSeqRef.current || (err as Error).name === 'AbortError') return;
      const rawMsg =
        err instanceof Error ? err.message : 'Unexpected pipeline error occurred.';
      const formattedMsg = rawMsg.startsWith('Step ')
        ? rawMsg
        : `${currentStepLabel}: ${rawMsg}`;
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        statusDetail: `${currentStepLabel} failed — see details below.`,
        errorMessage: formattedMsg,
      }));
    } finally {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onPipelineVisibility);
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    }
  }, [
    controls,
    patchConnectionStatus,
    replaceRenderedClips,
    replaceSourceMedia,
    safeRevokeObjectUrl,
    sourceMedia,
  ]);

  const isRendering = progress.status === 'running';
  const extractedLink =
    controls.sourceType === 'link' ? extractVideoUrl(controls.videoUrl) : null;
  const canRun =
    Boolean(sourceMedia) || Boolean(extractedLink && !extractedLink.isYouTube);

  return (
    <div className="min-h-screen bg-[#F4F6F9] text-[#0F172A] flex flex-col">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onResetWorkspace={handleResetWorkspace}
        isRendering={isRendering}
        savedCount={savedRenders.length}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'history' ? (
          <RecentRendersView
            records={savedRenders}
            onDelete={(tag) => setSavedRenders(deleteRenderRecord(tag))}
            onBackToStudio={() => setActiveTab('studio')}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left Column: Link/Upload Input -> Card 1 Source Preview -> Translation & Voice Controls */}
            <div className="lg:col-span-5 space-y-5">
              <VideoSourceCard
                sourceType={controls.sourceType}
                videoUrl={controls.videoUrl}
                sourceMedia={sourceMedia}
                disabled={isRendering}
                isFetchingLink={isFetchingLink}
                error={sourceError}
                onSourceTypeChange={(sourceType) =>
                  setControls((prev) => ({ ...prev, sourceType }))
                }
                onVideoUrlChange={(videoUrl) => {
                  const nextExtracted = extractVideoUrl(videoUrl);
                  if (nextExtracted?.isYouTube) {
                    setSourceError(YOUTUBE_DIRECT_FETCH_BLOCKED_MSG);
                    fetchYouTubeMetadataInBackground(videoUrl);
                  } else {
                    oembedAbortRef.current?.abort();
                    updateYoutubeLinkContext(null);
                    setSourceError(null);
                  }
                  if (sourceMedia?.sourceType === 'link') {
                    replaceSourceMedia(null);
                  }
                  setControls((prev) => ({ ...prev, videoUrl }));
                }}
                onFetchLinkPreview={handleFetchLinkPreview}
                onFileSelected={handleFileSelected}
                onClearSource={handleClearSource}
              />

              <SourcePreviewCard
                sourceMedia={sourceMedia}
                isFetchingLink={isFetchingLink}
              />

              <ExplainerControls
                language={controls.language}
                voiceGender={controls.voiceGender}
                aiEngine={controls.aiEngine}
                customAngle={controls.customAngle}
                canRun={canRun}
                isRendering={isRendering}
                onLanguageChange={(language) =>
                  setControls((prev) => ({ ...prev, language }))
                }
                onVoiceGenderChange={(voiceGender) =>
                  setControls((prev) => ({ ...prev, voiceGender }))
                }
                onAiEngineChange={(aiEngine) =>
                  setControls((prev) => ({ ...prev, aiEngine }))
                }
                onCustomAngleChange={(customAngle) =>
                  setControls((prev) => ({ ...prev, customAngle }))
                }
                onGenerate={handleGenerate}
                onCancel={handleCancelPipeline}
              />
            </div>

            {/* Right Column: 5-Step Pipeline Progress + Live Connection Pills -> Card 2 Final Production Output Deck */}
            <div className="lg:col-span-7 space-y-5">
              <CloudProgressBar
                progress={progress}
                connectionStatus={connectionStatus}
              />

              <OutputDeckCard
                key={progress.runTag ?? 'empty'}
                clips={renderedClips}
                runTag={progress.runTag}
                renderError={
                  progress.status === 'error' ? progress.errorMessage : null
                }
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
