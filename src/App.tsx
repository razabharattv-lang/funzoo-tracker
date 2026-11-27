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
import {
  getRunQuotaStats,
  probeInitialConnectionStatus,
  resetRunQuotaGuard,
} from './engine/modelRouter';
import {
  createGuaranteedFallbackVoice,
  synthesizeCommandingVoiceover,
} from './engine/audioEngine';
import { renderProductionMp4Gpu } from './engine/gpuRenderer';
import { warmOfflineEngines } from './engine/offlineModels';
import type {
  ConnectionStatusState,
  DiagnosticLogEntry,
  PipelineDiagnostics,
  PipelineProgress,
  PipelineStepId,
  RenderedClipOutput,
  SavedRenderRecord,
  SourceMediaItem,
  StudioControlsState,
  TrendMetadata,
  YouTubeTrendVideo,
} from './types/studio';

function createEmptyDiagnostics(): PipelineDiagnostics {
  return {
    sourceDurationSec: null,
    sourceResolution: null,
    sourceSizeBytes: null,
    step1FramesSampled: 0,
    step2FramesRendered: 0,
    contactSheetBytes: 0,
    aiCallsMade: 0,
    aiMode: 'pending',
    aiModel: null,
    aiNote: null,
    audioDurationSec: null,
    audioSampleRate: null,
    audioSource: null,
    outputBlobBytes: null,
    outputMimeType: null,
    outputDurationSec: null,
    renderEngine: null,
    stepLogs: [],
  };
}

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
  diagnostics: createEmptyDiagnostics(),
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
  gemini: 'Key-Missing',
  nvidia: 'Key-Missing',
  youtube: 'Key-Missing',
  voice: 'Studio-Audio',
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

    // Reset per-run API quota guard (enforces strict 1-call LLM budget and zero 429 retries)
    resetRunQuotaGuard();

    // Clear stale previous outputs atomically at run start so Output Deck always matches this run
    const runSeq = ++pipelineRunSeqRef.current;
    replaceRenderedClips([]);

    const runTag = `studio-${Date.now().toString(36)}`;
    const runStartedAtMs = Date.now();
    const completedSteps: PipelineStepId[] = [];
    const outputs: RenderedClipOutput[] = [];
    const diagnostics: PipelineDiagnostics = createEmptyDiagnostics();
    let currentStepId: PipelineStepId = 'step_1_fetch_clip';
    let currentStepLabel = 'Step 1/5 (Fetch)';
    const stepLabels: Record<PipelineStepId, string> = {
      step_1_fetch_clip: 'Step 1/5 (Fetch)',
      step_2_clean_grade: 'Step 2/5 (Clean)',
      step_3_translate_seo: 'Step 3/5 (Translate)',
      step_4_voiceover: 'Step 4/5 (Voice)',
      step_5_mux_output: 'Step 5/5 (Output)',
    };
    const isActiveRun = () =>
      runSeq === pipelineRunSeqRef.current && !signal.aborted;
    const safePatchConnection = (patch: Partial<ConnectionStatusState>) => {
      if (isActiveRun()) patchConnectionStatus(patch);
    };
    const cloneDiagnostics = (): PipelineDiagnostics => ({
      ...diagnostics,
      stepLogs: [...diagnostics.stepLogs],
    });
    const pushDiagLog = (
      step: PipelineStepId,
      message: string,
      status: DiagnosticLogEntry['status'] = 'ok'
    ) => {
      const elapsedSec = Number(((Date.now() - runStartedAtMs) / 1000).toFixed(1));
      diagnostics.stepLogs.push({ step, message, status, atSec: elapsedSec });
    };
    const markStep = (
      activeStep: PipelineStepId,
      percent: number,
      statusDetail: string,
      clipProgressLabel: string | null = null
    ) => {
      if (!isActiveRun()) return;
      currentStepId = activeStep;
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
        diagnostics: cloneDiagnostics(),
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
      // Reset live connection badges to probed Ready/Key-Missing before execution begins
      try {
        const snapshot = await probeInitialConnectionStatus(false);
        if (isActiveRun()) setConnectionStatus(snapshot);
      } catch {
        // Keep current status if health check unavailable
      }

      // STEP 1: Fetch & Inspect (requires real playable video + decoded canvas frames)
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
            'No playable video is loaded. Upload a local MP4/MOV/WebM video file or paste a direct playable video link first.'
          );
        }
      }

      if (
        !activeSource ||
        !Number.isFinite(activeSource.durationSec) ||
        activeSource.durationSec <= 0 ||
        activeSource.width <= 0 ||
        activeSource.height <= 0 ||
        activeSource.sizeBytes <= 0
      ) {
        throw new Error(
          'Source video could not be decoded (invalid duration or resolution). Please upload a standard local H.264 MP4 or WebM file.'
        );
      }

      diagnostics.sourceDurationSec = Number(activeSource.durationSec.toFixed(2));
      diagnostics.sourceResolution = `${activeSource.width}×${activeSource.height}`;
      diagnostics.sourceSizeBytes = activeSource.sizeBytes;

      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      const { segments, inspectorModel, framesSampled } = await inspectAndSliceSegmentsStep1({
        source: activeSource,
        onProgress: (detail) =>
          markStep('step_1_fetch_clip', 16, `Step 1/5: ${detail}`),
      });
      if (segments.length === 0 || framesSampled <= 0) {
        throw new Error(
          'Step 1 could not extract real frames from the source video. Please upload a standard local MP4 or WebM file.'
        );
      }

      diagnostics.step1FramesSampled = framesSampled;
      pushDiagLog(
        'step_1_fetch_clip',
        `Verified ${activeSource.durationSec.toFixed(1)}s (${activeSource.width}×${activeSource.height}), sampled ${framesSampled} keyframes.`,
        'ok'
      );
      completedSteps.push('step_1_fetch_clip');

      // STEP 2: Visual Clean & Grade (requires real drawn canvas tiles + verified JPEG contact sheet)
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
      if (
        preparedClips.length === 0 ||
        preparedClips.some((c) => c.framesSampled <= 0 || c.contactSheetBytes <= 500)
      ) {
        throw new Error(
          'Step 2 failed to draw readable graded frames onto the canvas. Please re-upload a standard MP4/WebM file.'
        );
      }

      diagnostics.step2FramesRendered = preparedClips.reduce(
        (acc, c) => acc + c.framesSampled,
        0
      );
      diagnostics.contactSheetBytes = preparedClips.reduce(
        (acc, c) => acc + c.contactSheetBytes,
        0
      );
      pushDiagLog(
        'step_2_clean_grade',
        `Graded ${diagnostics.step2FramesRendered} vertical frames (contact sheet ${Math.round(diagnostics.contactSheetBytes / 1024)} KB).`,
        'ok'
      );
      completedSteps.push('step_2_clean_grade');

      // STEP 3: Vision-to-Action + SEO (strictly max 1 external LLM/Vision API call per run)
      markStep(
        'step_3_translate_seo',
        40,
        'Step 3/5: Inspecting video frames & generating script + SEO metadata (1 API call max)...'
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
          onConnectionPatch: safePatchConnection,
        });
        if (i === 0 && meta.fetchedTrends && meta.fetchedTrends.length > 0) {
          sharedNicheTrends = meta.fetchedTrends;
        }
        clipMetadataList.push(meta);
      }

      if (
        clipMetadataList.length !== preparedClips.length ||
        clipMetadataList.some(
          (m) => !m.voiceover.trim() || !m.title.trim() || !m.description.trim()
        )
      ) {
        throw new Error('Step 3 failed to produce complete narration and SEO metadata.');
      }

      const primaryMeta = clipMetadataList[0];
      const quotaAfterStep3 = getRunQuotaStats();
      diagnostics.aiCallsMade = quotaAfterStep3.llmCallsMade;
      diagnostics.aiMode = primaryMeta.aiSourceMode === 'live' ? 'live' : 'fallback';
      diagnostics.aiModel = primaryMeta.scriptEngine;
      diagnostics.aiNote = primaryMeta.aiFallbackReason ?? null;
      pushDiagLog(
        'step_3_translate_seo',
        diagnostics.aiMode === 'live'
          ? `AI Live Response (${quotaAfterStep3.llmCallsMade} call · ${primaryMeta.scriptEngine}).`
          : `Local Fallback (${quotaAfterStep3.llmCallsMade} call · ${primaryMeta.aiFallbackReason || 'No cloud response'}).`,
        diagnostics.aiMode === 'live' ? 'ok' : 'warn'
      );
      completedSteps.push('step_3_translate_seo');

      // STEP 4: Commanding Voiceover (verified audible PCM audio track before Step 5)
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
            pacingBeats: clip.pacingBeats,
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
            'Step 4/5: Cloud TTS unavailable — continuing with synthesized studio audio...',
            clipLabel
          );
          voice = createGuaranteedFallbackVoice({
            scriptText: meta.voiceover,
            beats: meta.beats,
            pacingBeats: clip.pacingBeats,
            language: controls.language,
            voiceGender: controls.voiceGender,
            targetDurationSec: clip.lockedVisualDurationSec,
            reason: 'Fallback Audio',
          });
        }

        if (
          !voice ||
          !Number.isFinite(voice.durationSec) ||
          voice.durationSec <= 0 ||
          !voice.pcmSamples ||
          voice.pcmSamples.length === 0
        ) {
          throw new Error('Step 4 failed to synthesize a playable audio track.');
        }

        safePatchConnection({ voice: voice.voiceSource });
        meta.wordTimings = voice.wordTimings;
        voiceResults.push(voice);
      }

      if (voiceResults.length !== preparedClips.length) {
        throw new Error('Step 4 voiceover count did not match edited clips.');
      }

      const primaryVoice = voiceResults[0];
      diagnostics.audioDurationSec = primaryVoice.durationSec;
      diagnostics.audioSampleRate = primaryVoice.sampleRate;
      diagnostics.audioSource = primaryVoice.voiceEngine;
      pushDiagLog(
        'step_4_voiceover',
        `Verified audio track (${primaryVoice.durationSec.toFixed(1)}s @ ${Math.round(primaryVoice.sampleRate / 1000)}kHz · ${primaryVoice.voiceSource}).`,
        primaryVoice.voiceSource === 'Gemini-TTS' ? 'ok' : 'warn'
      );
      completedSteps.push('step_4_voiceover');

      // STEP 5: Fast, Phone-Safe Mux & Output Deck (verified playable Blob > 1 KB)
      for (let i = 0; i < preparedClips.length; i++) {
        if (!isActiveRun()) throw new DOMException('Cancelled', 'AbortError');
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

        if (!rendered.blob || rendered.blob.size <= 1024 || rendered.durationSec <= 0) {
          throw new Error(
            `Step 5 output validation failed (${rendered.blob?.size ?? 0} bytes). Please try Chrome or Safari desktop.`
          );
        }

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

      const primaryOut = outputs[0];
      diagnostics.outputBlobBytes = primaryOut.fileSizeBytes;
      diagnostics.outputMimeType = primaryOut.mimeType;
      diagnostics.outputDurationSec = primaryOut.durationSec;
      diagnostics.renderEngine = primaryOut.renderEngine;
      pushDiagLog(
        'step_5_mux_output',
        `Exported verified ${primaryOut.mimeType} (${(primaryOut.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB, ${primaryOut.durationSec.toFixed(1)}s · ${primaryOut.renderEngine}).`,
        'ok'
      );
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
        statusDetail: `Completed ${outputs.length} verified clip${outputs.length > 1 ? 's' : ''} + 5 one-click SEO copy cards.`,
        clipProgressLabel: `${outputs.length}/${outputs.length} Done`,
        runTag,
        startedAtMs: null,
        errorMessage: null,
        diagnostics: cloneDiagnostics(),
      });
    } catch (err) {
      outputs.forEach((o) => safeRevokeObjectUrl(o.videoUrl));
      if (runSeq !== pipelineRunSeqRef.current || (err as Error).name === 'AbortError') return;
      const rawMsg =
        err instanceof Error ? err.message : 'Unexpected pipeline error occurred.';
      const formattedMsg = rawMsg.startsWith('Step ')
        ? rawMsg
        : `${currentStepLabel}: ${rawMsg}`;
      pushDiagLog(currentStepId, formattedMsg, 'error');
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        activeStep: currentStepId,
        completedSteps: [...completedSteps],
        statusDetail: `${currentStepLabel} failed — see details below.`,
        errorMessage: formattedMsg,
        diagnostics: cloneDiagnostics(),
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
