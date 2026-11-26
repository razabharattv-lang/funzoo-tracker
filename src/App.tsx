import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, Layers } from 'lucide-react';
import { TopBar, type ActiveTab } from './components/TopBar';
import { StudioConfigBar } from './components/StudioConfigBar';
import { VideoSourceCard } from './components/VideoSourceCard';
import { DocumentaryInputCard } from './components/DocumentaryInputCard';
import { SourcePreviewCard } from './components/SourcePreviewCard';
import { CharacterCard } from './components/CharacterCard';
import { ExplainerControls } from './components/ExplainerControls';
import { CloudProgressBar } from './components/CloudProgressBar';
import { OutputDeckCard } from './components/OutputDeckCard';
import { RecentRendersView } from './components/RecentRendersView';
import {
  clearStudioKeysOnly,
  getMissingConfigFields,
  hasExternalGpuConfigured,
  loadStudioConfig,
  saveStudioConfig,
} from './lib/env';
import { probeVideoBlobToSource } from './lib/videoProbe';
import { extractVideoUrl } from './lib/urlExtractor';
import { uploadCharacterPortraitToCloudinary } from './lib/cloudinary';
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
import {
  planDocumentaryOutlineStep1,
  prepareDocumentaryChapterVisualsStep2,
} from './engine/documentaryPlanner';
import {
  applyFaceLockedOutfitChange,
  fetchLiveYouTubeTrends,
  inspectLockedVisualClipOneCall,
  refineBeatSyncedScriptAndMetadata,
  refineDocumentaryChapterScriptAndMetadata,
} from './engine/intelligenceEngine';
import { requestExternalGpuCharacterFrame } from './engine/modelRouter';
import { synthesizeCommandingVoiceover } from './engine/audioEngine';
import {
  detectDeviceRenderProfile,
  renderDocumentarySceneMp4Gpu,
  renderProductionMp4Gpu,
} from './engine/gpuRenderer';
import type {
  DocumentaryOutline,
  PipelineProgress,
  RenderedClipOutput,
  SavedCharacterAsset,
  SavedRenderRecord,
  SourceMediaItem,
  StudioConfig,
  StudioControlsState,
  YouTubeTrendVideo,
} from './types/studio';

const IDLE_PROGRESS: PipelineProgress = {
  status: 'idle',
  activeStep: null,
  completedSteps: [],
  percent: 0,
  statusDetail:
    'Choose Video Explainer or Documentary / 3D Mode, preview your source or chapters, and click Generate Production Video.',
  clipProgressLabel: null,
  runTag: null,
  startedAtMs: null,
  errorMessage: null,
};

function createRunTag(): string {
  const hex = Math.random().toString(16).slice(2, 8);
  return `exp_${Date.now()}_${hex}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [studioConfig, setStudioConfig] = useState<StudioConfig>(() =>
    loadStudioConfig()
  );
  const [isConfigExpanded, setIsConfigExpanded] = useState(
    () => getMissingConfigFields(loadStudioConfig()).length > 0
  );

  // Compact Card 1 states (Explainer source OR Documentary chapter outline)
  const [sourceMedia, setSourceMedia] = useState<SourceMediaItem | null>(null);
  const [isFetchingLink, setIsFetchingLink] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [documentaryOutline, setDocumentaryOutline] =
    useState<DocumentaryOutline | null>(null);
  const [isPlanningOutline, setIsPlanningOutline] = useState(false);
  const [documentaryError, setDocumentaryError] = useState<string | null>(null);

  const [controls, setControls] = useState<StudioControlsState>(() => {
    const initialConfig = loadStudioConfig();
    return {
      studioMode: 'explainer',
      sourceType: 'link',
      videoUrl: '',
      documentaryStyle: 'documentary',
      documentaryInputKind: 'topic',
      documentaryInput: '',
      useExternalGpu: hasExternalGpuConfigured(initialConfig),
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

  const [progress, setProgress] = useState<PipelineProgress>(IDLE_PROGRESS);

  // Compact Card 2: Final Production Output Deck state
  const [outputRunTag, setOutputRunTag] = useState<string | null>(null);
  const [outputSourceDuration, setOutputSourceDuration] = useState<number>(0);
  const [renderedClips, setRenderedClips] = useState<RenderedClipOutput[]>([]);

  const [savedRenders, setSavedRenders] = useState<SavedRenderRecord[]>(() =>
    loadSavedRenders()
  );

  const abortRef = useRef<AbortController | null>(null);
  const activeOutputBlobUrlsRef = useRef<string[]>([]);

  const revokeOutputBlobUrls = useCallback(() => {
    for (const url of activeOutputBlobUrlsRef.current) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    activeOutputBlobUrlsRef.current = [];
  }, []);

  const clearSourceMedia = useCallback(() => {
    setSourceMedia((prev) => {
      if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
    setSourceError(null);
  }, []);

  const clearDocumentaryOutline = useCallback(() => {
    setDocumentaryOutline(null);
    setDocumentaryError(null);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      revokeOutputBlobUrls();
    };
  }, [revokeOutputBlobUrls]);

  const handleSaveConfig = useCallback((next: StudioConfig) => {
    const saved = saveStudioConfig(next);
    setStudioConfig(saved);
    const hasGpu = hasExternalGpuConfigured(saved);
    setControls((prev) => {
      const matched = saved.characterImageUrl
        ? saved.savedCharacters.find((c) => c.url === saved.characterImageUrl)
        : null;
      return {
        ...prev,
        useExternalGpu: hasGpu ? prev.useExternalGpu : false,
        selectedCharacterId: matched ? matched.id : prev.selectedCharacterId,
      };
    });
    if (getMissingConfigFields(saved).length === 0) {
      window.setTimeout(() => setIsConfigExpanded(false), 600);
    }
  }, []);

  const handleClearKeys = useCallback(() => {
    setStudioConfig((current) => clearStudioKeysOnly(current));
  }, []);

  const handleFileSelected = useCallback(async (file: File) => {
    setSourceError(null);
    try {
      const probed = await probeVideoBlobToSource({
        blob: file,
        sourceType: 'upload',
        label: file.name,
        platform: 'Local File',
      });
      setSourceMedia((prev) => {
        if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
        return probed;
      });
      setRenderedClips([]);
      setOutputRunTag(null);
      setProgress(IDLE_PROGRESS);
    } catch (err) {
      setSourceError((err as Error).message);
    }
  }, []);

  const handleFetchLinkPreview = useCallback(async () => {
    if (isFetchingLink || progress.status === 'running') return;
    setSourceError(null);
    setIsFetchingLink(true);
    try {
      const resolved = await resolveLinkToSourceMedia({
        rawInput: controls.videoUrl,
        onStatus: () => {},
      });
      setSourceMedia((prev) => {
        if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
        return resolved;
      });
    } catch (err) {
      setSourceError((err as Error).message);
    } finally {
      setIsFetchingLink(false);
    }
  }, [controls.videoUrl, isFetchingLink, progress.status]);

  const handlePreviewDocumentaryOutline = useCallback(async () => {
    if (isPlanningOutline || progress.status === 'running') return;
    if (controls.documentaryInput.trim().length < 6) return;
    setDocumentaryError(null);
    setIsPlanningOutline(true);
    try {
      const outline = await planDocumentaryOutlineStep1({
        rawInput: controls.documentaryInput,
        inputKind: controls.documentaryInputKind,
        style: controls.documentaryStyle,
        language: controls.language,
        customAngle: controls.customAngle,
        config: studioConfig,
      });
      setDocumentaryOutline(outline);
    } catch (err) {
      setDocumentaryError((err as Error).message);
    } finally {
      setIsPlanningOutline(false);
    }
  }, [
    controls.customAngle,
    controls.documentaryInput,
    controls.documentaryInputKind,
    controls.documentaryStyle,
    controls.language,
    isPlanningOutline,
    progress.status,
    studioConfig,
  ]);

  const handleUploadPortrait = useCallback(
    async (file: File) => {
      setPortraitError(null);
      setIsUploadingPortrait(true);
      try {
        const res = await uploadCharacterPortraitToCloudinary(
          file,
          studioConfig
        );
        const cleanName =
          file.name.replace(/\.[^.]+$/, '').slice(0, 32) || 'Portrait';
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
          savedCharacters: [newAsset, ...studioConfig.savedCharacters].slice(
            0,
            8
          ),
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
        setStudioConfig(
          saveStudioConfig({
            ...studioConfig,
            characterImageUrl: chosen.url,
          })
        );
      }
    },
    [studioConfig]
  );

  const handleDeleteCharacter = useCallback(
    (id: string) => {
      const remaining = studioConfig.savedCharacters.filter((c) => c.id !== id);
      const nextUrl = remaining[0]?.url ?? '';
      setStudioConfig(
        saveStudioConfig({
          ...studioConfig,
          characterImageUrl: nextUrl,
          savedCharacters: remaining,
        })
      );
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
    clearSourceMedia();
    clearDocumentaryOutline();
    revokeOutputBlobUrls();
    setControls((prev) => ({
      ...prev,
      videoUrl: '',
      documentaryInput: '',
      customAngle: '',
      outfitPrompt: '',
    }));
    setProgress(IDLE_PROGRESS);
    setRenderedClips([]);
    setOutputRunTag(null);
    setOutputSourceDuration(0);
    setActiveTab('studio');
  }, [
    clearDocumentaryOutline,
    clearSourceMedia,
    progress.status,
    revokeOutputBlobUrls,
  ]);

  const handleCancelRender = useCallback(() => {
    abortRef.current?.abort();
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
      clipProgressLabel: null,
      statusDetail: 'GPU render cancelled. Ready for your next project.',
      errorMessage: null,
    }));
  }, []);

  const activeCharacter =
    studioConfig.savedCharacters.find(
      (c) => c.id === controls.selectedCharacterId
    ) ??
    studioConfig.savedCharacters[0] ??
    null;

  const activeCharacterUrl =
    activeCharacter?.url || studioConfig.characterImageUrl || '';

  const extractedLink = extractVideoUrl(controls.videoUrl);
  const externalGpuAvailable = hasExternalGpuConfigured(studioConfig);

  const canGenerate =
    controls.studioMode === 'documentary'
      ? controls.documentaryInput.trim().length >= 6
      : controls.sourceType === 'upload'
      ? Boolean(sourceMedia && sourceMedia.sourceType === 'upload')
      : Boolean(extractedLink);

  const resolveCharacterPortraitOnce = useCallback(
    async (signal: AbortSignal): Promise<string> => {
      let url = activeCharacterUrl;
      if (!controls.characterEnabled || !url) return '';

      if (controls.outfitPrompt.trim() && studioConfig.geminiApiKey) {
        url = await applyFaceLockedOutfitChange({
          portraitUrl: url,
          outfitPrompt: controls.outfitPrompt,
          geminiApiKey: studioConfig.geminiApiKey,
          signal,
        });
      }

      if (controls.useExternalGpu && externalGpuAvailable) {
        const extChar = await requestExternalGpuCharacterFrame({
          config: studioConfig,
          useExternalGpu: true,
          portraitUrl: url,
          signal,
        });
        if (extChar?.enhancedPortraitUrl) {
          url = extChar.enhancedPortraitUrl;
        }
      }
      return url;
    },
    [
      activeCharacterUrl,
      controls.characterEnabled,
      controls.outfitPrompt,
      controls.useExternalGpu,
      externalGpuAvailable,
      studioConfig,
    ]
  );

  const handleStartRender = useCallback(async () => {
    if (!canGenerate || progress.status === 'running') return;

    const missing = getMissingConfigFields(studioConfig);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      setProgress({
        ...IDLE_PROGRESS,
        status: 'error',
        activeStep: 'step_1_inspect',
        statusDetail:
          'Add your Gemini or NVIDIA API Key in Studio API Config above.',
        errorMessage: `Missing required config: ${missing.join(
          ', '
        )}. Enter your key in the Studio API Config bar above.`,
      });
      return;
    }

    if (controls.characterEnabled && !activeCharacterUrl) {
      setPortraitError(
        'Upload a character portrait or turn Talking Character OFF.'
      );
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    revokeOutputBlobUrls();
    const runTag = createRunTag();
    const startedAtMs = Date.now();
    setOutputRunTag(runTag);
    setRenderedClips([]);
    setPortraitError(null);
    setSourceError(null);
    setDocumentaryError(null);

    const newOutputBlobUrls: string[] = [];

    try {
      // ================================================================
      // MODE B: SCRIPT-TO-DOCUMENTARY / MOTION GRAPHICS / 3D-BLENDER
      // ================================================================
      if (controls.studioMode === 'documentary') {
        setProgress({
          status: 'running',
          activeStep: 'step_1_inspect',
          completedSteps: [],
          percent: 6,
          statusDetail:
            'Step 1: Architecting chapter outline (Nemotron Ultra 550B / Step 5 / Kimi K3.1 / Gemini 3.8)...',
          clipProgressLabel: null,
          runTag,
          startedAtMs,
          errorMessage: null,
        });

        const outline =
          documentaryOutline &&
          documentaryOutline.style === controls.documentaryStyle &&
          documentaryOutline.inputKind === controls.documentaryInputKind
            ? documentaryOutline
            : await planDocumentaryOutlineStep1({
                rawInput: controls.documentaryInput,
                inputKind: controls.documentaryInputKind,
                style: controls.documentaryStyle,
                language: controls.language,
                customAngle: controls.customAngle,
                config: studioConfig,
                signal,
              });

        setDocumentaryOutline(outline);
        setOutputSourceDuration(outline.totalDurationSec);

        const effectivePortraitUrl = await resolveCharacterPortraitOnce(signal);
        const totalChapters = outline.chapters.length;
        const finishedOutputs: RenderedClipOutput[] = [];
        const trendsCache = new Map<string, YouTubeTrendVideo[]>();
        const profile = detectDeviceRenderProfile();

        for (let i = 0; i < totalChapters; i++) {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const rawChapter = outline.chapters[i];
          const chLabel = `Chapter ${i + 1}/${totalChapters}`;
          const chPrefix = `${chLabel}: `;
          const basePct = 15 + Math.round((i / totalChapters) * 82);
          const spanPct = Math.round(82 / totalChapters);

          // STEP 2: Visual Scene & Stamped Contact Sheet
          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_2_clean_visuals',
            completedSteps: ['step_1_inspect'],
            clipProgressLabel: chLabel,
            percent: basePct,
            statusDetail: `${chPrefix}Step 2: Preparing ${
              controls.useExternalGpu && externalGpuAvailable
                ? 'External GPU FLUX / TRELLIS visuals'
                : 'Browser WebGL2 3D/Motion shader scene'
            }...`,
          }));

          const preparedChapter = await prepareDocumentaryChapterVisualsStep2({
            chapter: rawChapter,
            config: studioConfig,
            useExternalGpu: controls.useExternalGpu,
            targetWidth: profile.width,
            targetHeight: profile.height,
            signal,
          });

          // STEP 3: Script & Live US YouTube Trends
          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_3_script_trends',
            completedSteps: ['step_1_inspect', 'step_2_clean_visuals'],
            percent: basePct + Math.round(spanPct * 0.18),
            statusDetail: `${chPrefix}Step 3: Refining beat-synced script & US YouTube Trends (Mistral 4 / GLM-5 / Riva / Gemini)...`,
          }));

          const trendKey = preparedChapter.searchQueries
            .map((q) => q.trim().toLowerCase())
            .sort()
            .join('|');
          let trends = trendsCache.get(trendKey);
          if (!trends) {
            trends = await fetchLiveYouTubeTrends(
              preparedChapter.searchQueries,
              studioConfig.youtubeApiKey,
              signal
            );
            trendsCache.set(trendKey, trends);
          }

          const metadata = await refineDocumentaryChapterScriptAndMetadata({
            chapter: preparedChapter,
            seriesTitle: outline.topicOrTitle,
            trends,
            language: controls.language,
            customAngle: controls.customAngle,
            config: studioConfig,
            signal,
          });

          // STEP 4: Commanding Voice & Talking Character
          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_4_voice_character',
            completedSteps: [
              'step_1_inspect',
              'step_2_clean_visuals',
              'step_3_script_trends',
            ],
            percent: basePct + Math.round(spanPct * 0.38),
            statusDetail: `${chPrefix}Step 4: Synthesizing commanding narration & OfflineAudioContext broadcast DSP...`,
          }));

          const audio = await synthesizeCommandingVoiceover({
            scriptText: metadata.voiceover,
            language: controls.language,
            voiceGender: controls.voiceGender,
            geminiApiKey: studioConfig.geminiApiKey,
            config: studioConfig,
            useExternalGpu: controls.useExternalGpu,
            lockedVisualDurationSec: preparedChapter.targetDurationSec,
            onStatus: (msg) => {
              setProgress((prev) => ({
                ...prev,
                activeStep: 'step_4_voice_character',
                statusDetail: `${chPrefix}${msg}`,
              }));
            },
            signal,
          });

          // STEP 5: Hardware WebGL2 / WebCodecs Scene Mux
          const gpuStartPct = basePct + Math.round(spanPct * 0.54);
          const gpuSpanPct = Math.max(10, Math.round(spanPct * 0.44));

          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_5_gpu_mux',
            completedSteps: [
              'step_1_inspect',
              'step_2_clean_visuals',
              'step_3_script_trends',
              'step_4_voice_character',
            ],
            percent: gpuStartPct,
            statusDetail: `${chPrefix}Step 5: Muxing ${preparedChapter.targetDurationSec.toFixed(
              1
            )}s 9:16 H.264 MP4 on GPU...`,
          }));

          const rendered = await renderDocumentarySceneMp4Gpu({
            chapter: preparedChapter,
            audio,
            scriptText: metadata.voiceover,
            beats: metadata.beats,
            language: controls.language,
            characterEnabled: controls.characterEnabled,
            characterPortraitUrl: controls.characterEnabled
              ? effectivePortraitUrl
              : '',
            onStatus: (msg) => {
              setProgress((prev) => ({
                ...prev,
                activeStep: 'step_5_gpu_mux',
                statusDetail: `${chPrefix}${msg}`,
              }));
            },
            onProgressPct: (localPct) => {
              const mapped = Math.min(
                98,
                gpuStartPct + Math.round((localPct / 100) * gpuSpanPct)
              );
              setProgress((prev) => ({
                ...prev,
                percent: Math.max(prev.percent, mapped),
              }));
            },
            signal,
          });

          newOutputBlobUrls.push(rendered.blobUrl);

          const clipOutput: RenderedClipOutput = {
            clipIndex: preparedChapter.chapterIndex,
            totalClips: totalChapters,
            startSec: 0,
            endSec: preparedChapter.targetDurationSec,
            reason: preparedChapter.title,
            studioMode: 'documentary',
            documentaryStyle: preparedChapter.style,
            videoUrl: rendered.blobUrl,
            durationSec: rendered.durationSec,
            width: rendered.width,
            height: rendered.height,
            fps: rendered.fps,
            fileSizeBytes: rendered.sizeBytes,
            language: controls.language,
            voiceGender: controls.voiceGender,
            voiceEngine: `${audio.engineLabel} · ${metadata.scriptEngine}`,
            renderEngine: rendered.renderEngine,
            characterMode: rendered.characterMode,
            watermarkBoxesRemoved: 0,
            endCardTrimmedSec: 0,
            safeCropApplied: false,
            climaxSecond: preparedChapter.climaxSec,
            metadata,
          };

          finishedOutputs.push(clipOutput);
          setRenderedClips([...finishedOutputs]);
        }

        activeOutputBlobUrlsRef.current = newOutputBlobUrls;
        const first = finishedOutputs[0];
        setProgress((prev) => ({
          ...prev,
          status: 'completed',
          activeStep: 'step_5_gpu_mux',
          completedSteps: [
            'step_1_inspect',
            'step_2_clean_visuals',
            'step_3_script_trends',
            'step_4_voice_character',
            'step_5_gpu_mux',
          ],
          clipProgressLabel: null,
          percent: 100,
          statusDetail: `Completed ${finishedOutputs.length} documentary chapter${
            finishedOutputs.length === 1 ? '' : 's'
          } (${first?.width}×${first?.height} @ ${first?.fps}fps) — ready below.`,
        }));

        const record: SavedRenderRecord = {
          runTag,
          completedAt: new Date().toISOString(),
          sourceLabel: outline.topicOrTitle,
          sourceDurationSec: outline.totalDurationSec,
          mode: 'documentary',
          studioMode: 'documentary',
          customAngle: controls.customAngle,
          clips: finishedOutputs,
        };
        setSavedRenders(saveRenderRecord(record));
        return;
      }

      // ================================================================
      // MODE A: VIDEO EXPLAINER & VIRAL CLIPPER
      // ================================================================
      setProgress({
        status: 'running',
        activeStep: 'step_1_inspect',
        completedSteps: [],
        percent: 5,
        statusDetail:
          controls.sourceType === 'upload'
            ? 'Step 1: Inspecting imported local video...'
            : 'Step 1: Resolving direct no-watermark MP4 stream...',
        clipProgressLabel: null,
        runTag,
        startedAtMs,
        errorMessage: null,
      });

      let activeSource = sourceMedia;
      const linkMatchesExisting =
        controls.sourceType === 'link' &&
        activeSource?.sourceType === 'link' &&
        extractedLink &&
        activeSource.label === extractedLink.cleanUrl;

      if (controls.sourceType === 'link' && !linkMatchesExisting) {
        activeSource = await resolveLinkToSourceMedia({
          rawInput: controls.videoUrl,
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              activeStep: 'step_1_inspect',
              percent: Math.min(14, prev.percent + 2),
              statusDetail: msg,
            }));
          },
          signal,
        });
        setSourceMedia((prev) => {
          if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
          return activeSource;
        });
      }

      if (!activeSource) {
        throw new Error('No source video available to render.');
      }

      setOutputSourceDuration(activeSource.durationSec);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      setProgress((prev) => ({
        ...prev,
        activeStep: 'step_1_inspect',
        percent: 16,
        statusDetail:
          activeSource.mode === 'long'
            ? 'Step 1: Scanning 18 proportional keyframes (Nemotron VL / Omni / Gemini 3.8) to pinpoint viral segments...'
            : 'Step 1: Inspecting timeline & trimming creator outro bumper...',
      }));

      const { segments, inspectorModel } = await inspectAndSliceSegmentsStep1({
        source: activeSource,
        customAngle: controls.customAngle,
        nvidiaApiKey: studioConfig.nvidiaApiKey,
        geminiApiKey: studioConfig.geminiApiKey,
        onStatus: (msg) => {
          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_1_inspect',
            percent: Math.min(22, Math.max(prev.percent, 18)),
            statusDetail: msg,
          }));
        },
        signal,
      });

      // STEP 2: Anti-Copyright Cleanups, Safe Crop, Cinema Grade & Contact Sheet
      setProgress((prev) => ({
        ...prev,
        activeStep: 'step_2_clean_visuals',
        completedSteps: ['step_1_inspect'],
        percent: 24,
        statusDetail:
          'Step 2: Locking clean visual timelines, delogo masks & cinema color grade...',
      }));

      const preparedClips = await cleanAndGradeClipsStep2({
        source: activeSource,
        segments,
        inspectorModel,
        onStatus: (msg) => {
          setProgress((prev) => ({
            ...prev,
            activeStep: 'step_2_clean_visuals',
            percent: Math.min(34, Math.max(prev.percent, 26)),
            statusDetail: msg,
          }));
        },
        signal,
      });

      if (preparedClips.length === 0) {
        throw new Error('Step 2 could not prepare a locked visual timeline.');
      }

      const effectivePortraitUrl = await resolveCharacterPortraitOnce(signal);
      const totalClips = preparedClips.length;
      const finishedOutputs: RenderedClipOutput[] = [];
      const trendsCache = new Map<string, YouTubeTrendVideo[]>();

      for (let i = 0; i < totalClips; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const preparedClip = preparedClips[i];
        const clipLabel =
          totalClips > 1 ? `Clip ${i + 1}/${totalClips}` : 'Single Short';
        const clipPrefix = totalClips > 1 ? `Clip ${i + 1}/${totalClips}: ` : '';

        const clipBasePct = 36 + Math.round((i / totalClips) * 60);
        const clipSpanPct = Math.round(60 / totalClips);

        // STEP 3: Inspect stamped frames + US YouTube trends + beat-synced script
        setProgress((prev) => ({
          ...prev,
          activeStep: 'step_3_script_trends',
          completedSteps: ['step_1_inspect', 'step_2_clean_visuals'],
          clipProgressLabel: clipLabel,
          percent: clipBasePct,
          statusDetail: `${clipPrefix}Step 3: Syncing stamped ${preparedClip.lockedVisualDurationSec.toFixed(
            1
          )}s frames with beat-synced script & US trends...`,
        }));

        const inspection = await inspectLockedVisualClipOneCall({
          source: activeSource,
          preparedClip,
          language: controls.language,
          customAngle: controls.customAngle,
          nvidiaApiKey: studioConfig.nvidiaApiKey,
          geminiApiKey: studioConfig.geminiApiKey,
          signal,
        });

        const lockedClip = inspection.updatedClip;
        const trendCacheKey = inspection.searchQueries
          .map((q) => q.trim().toLowerCase())
          .sort()
          .join('|');
        let trends = trendsCache.get(trendCacheKey);
        if (!trends) {
          trends = await fetchLiveYouTubeTrends(
            inspection.searchQueries,
            studioConfig.youtubeApiKey,
            signal
          );
          trendsCache.set(trendCacheKey, trends);
        }

        const metadata = await refineBeatSyncedScriptAndMetadata({
          inspection,
          trends,
          language: controls.language,
          customAngle: controls.customAngle,
          config: studioConfig,
          signal,
        });

        // STEP 4: Punchy Voice & Character
        setProgress((prev) => ({
          ...prev,
          activeStep: 'step_4_voice_character',
          completedSteps: [
            'step_1_inspect',
            'step_2_clean_visuals',
            'step_3_script_trends',
          ],
          clipProgressLabel: clipLabel,
          percent: clipBasePct + Math.round(clipSpanPct * 0.36),
          statusDetail: `${clipPrefix}Step 4: Synthesizing commanding voiceover & broadcast vocal DSP...`,
        }));

        const audio = await synthesizeCommandingVoiceover({
          scriptText: metadata.voiceover,
          language: controls.language,
          voiceGender: controls.voiceGender,
          geminiApiKey: studioConfig.geminiApiKey,
          config: studioConfig,
          useExternalGpu: controls.useExternalGpu,
          lockedVisualDurationSec: lockedClip.lockedVisualDurationSec,
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              activeStep: 'step_4_voice_character',
              statusDetail: `${clipPrefix}${msg}`,
            }));
          },
          signal,
        });

        // STEP 5: Single-Pass GPU Mux & Output Deck
        const gpuStartPct = clipBasePct + Math.round(clipSpanPct * 0.5);
        const gpuSpanPct = Math.max(10, Math.round(clipSpanPct * 0.48));

        setProgress((prev) => ({
          ...prev,
          activeStep: 'step_5_gpu_mux',
          completedSteps: [
            'step_1_inspect',
            'step_2_clean_visuals',
            'step_3_script_trends',
            'step_4_voice_character',
          ],
          clipProgressLabel: clipLabel,
          percent: gpuStartPct,
          statusDetail: `${clipPrefix}Step 5: Running single-pass WebGL2 + WebCodecs GPU mux (${lockedClip.lockedVisualDurationSec.toFixed(
            1
          )}s)...`,
        }));

        const rendered = await renderProductionMp4Gpu({
          source: activeSource,
          clip: lockedClip,
          audio,
          scriptText: metadata.voiceover,
          beats: metadata.beats,
          language: controls.language,
          characterEnabled: controls.characterEnabled,
          characterPortraitUrl: controls.characterEnabled
            ? effectivePortraitUrl
            : '',
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              activeStep: 'step_5_gpu_mux',
              statusDetail: `${clipPrefix}${msg}`,
            }));
          },
          onProgressPct: (localPct) => {
            const mapped = Math.min(
              98,
              gpuStartPct + Math.round((localPct / 100) * gpuSpanPct)
            );
            setProgress((prev) => ({
              ...prev,
              percent: Math.max(prev.percent, mapped),
            }));
          },
          signal,
        });

        newOutputBlobUrls.push(rendered.blobUrl);

        const clipOutput: RenderedClipOutput = {
          clipIndex: lockedClip.clipIndex,
          totalClips,
          startSec: lockedClip.trimRange.startSec,
          endSec: lockedClip.trimRange.endSec,
          reason: lockedClip.reason,
          studioMode: 'explainer',
          videoUrl: rendered.blobUrl,
          durationSec: rendered.durationSec,
          width: rendered.width,
          height: rendered.height,
          fps: rendered.fps,
          fileSizeBytes: rendered.sizeBytes,
          language: controls.language,
          voiceGender: controls.voiceGender,
          voiceEngine: `${audio.engineLabel} · ${metadata.scriptEngine}`,
          renderEngine: rendered.renderEngine,
          characterMode: rendered.characterMode,
          watermarkBoxesRemoved: rendered.delogoCount,
          endCardTrimmedSec: rendered.bumperTrimmedSec,
          safeCropApplied: rendered.safeCropApplied,
          climaxSecond: lockedClip.climaxSec,
          metadata,
        };

        finishedOutputs.push(clipOutput);
        setRenderedClips([...finishedOutputs]);
      }

      activeOutputBlobUrlsRef.current = newOutputBlobUrls;
      const first = finishedOutputs[0];
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        activeStep: 'step_5_gpu_mux',
        completedSteps: [
          'step_1_inspect',
          'step_2_clean_visuals',
          'step_3_script_trends',
          'step_4_voice_character',
          'step_5_gpu_mux',
        ],
        clipProgressLabel: null,
        percent: 100,
        statusDetail:
          finishedOutputs.length > 1
            ? `Completed all ${finishedOutputs.length} beat-synced 9:16 MP4 clips (${first?.width}×${first?.height} @ ${first?.fps}fps) — ready below.`
            : `Finished ${first?.width}×${first?.height} MP4 (${first?.renderEngine}) — ready for instant download below.`,
      }));

      const record: SavedRenderRecord = {
        runTag,
        completedAt: new Date().toISOString(),
        sourceLabel: activeSource.label,
        sourceDurationSec: activeSource.durationSec,
        mode: activeSource.mode,
        studioMode: 'explainer',
        customAngle: controls.customAngle,
        clips: finishedOutputs,
      };
      setSavedRenders(saveRenderRecord(record));
    } catch (err) {
      for (const u of newOutputBlobUrls) URL.revokeObjectURL(u);
      if ((err as Error).name === 'AbortError') return;
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        clipProgressLabel: null,
        statusDetail: 'In-browser render stopped with an error.',
        errorMessage: (err as Error).message || 'Unexpected render failure.',
      }));
    }
  }, [
    activeCharacterUrl,
    canGenerate,
    controls,
    documentaryOutline,
    externalGpuAvailable,
    extractedLink,
    progress.status,
    resolveCharacterPortraitOnce,
    revokeOutputBlobUrls,
    sourceMedia,
    studioConfig,
  ]);

  const handleLoadRecord = useCallback((record: SavedRenderRecord) => {
    setOutputRunTag(record.runTag);
    setOutputSourceDuration(record.sourceDurationSec);
    setRenderedClips(record.clips);
    setProgress({
      status: 'completed',
      activeStep: 'step_5_gpu_mux',
      completedSteps: [
        'step_1_inspect',
        'step_2_clean_visuals',
        'step_3_script_trends',
        'step_4_voice_character',
        'step_5_gpu_mux',
      ],
      percent: 100,
      clipProgressLabel: null,
      statusDetail: `Loaded ${record.clips.length} saved item${
        record.clips.length === 1 ? '' : 's'
      } (${record.runTag}).`,
      runTag: record.runTag,
      startedAtMs: null,
      errorMessage: null,
    });
    setActiveTab('studio');
  }, []);

  const handleDeleteRecord = useCallback((runTag: string) => {
    setSavedRenders(deleteRenderRecord(runTag));
  }, []);

  const isRunning = progress.status === 'running';

  return (
    <div className="min-h-screen bg-[#F4F6F9] text-[#0F172A] flex flex-col">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onResetWorkspace={handleResetWorkspace}
        isRendering={isRunning}
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
            {/* LEFT COLUMN: Mode Switcher -> Input Card -> Compact Card 1 (Preview) -> Character -> Controls */}
            <div className="lg:col-span-5 space-y-5">
              {/* Studio Mode Switcher */}
              <div
                role="tablist"
                aria-label="Production Studio Mode"
                className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-1.5 grid grid-cols-2 gap-1.5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={controls.studioMode === 'explainer'}
                  disabled={isRunning}
                  onClick={() =>
                    setControls((prev) => ({ ...prev, studioMode: 'explainer' }))
                  }
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-extrabold transition-colors cursor-pointer disabled:opacity-55 whitespace-nowrap ${
                    controls.studioMode === 'explainer'
                      ? 'bg-[#3D5AFE] text-white'
                      : 'bg-white text-[#475569] hover:bg-[#F4F6F9] hover:text-[#0F172A]'
                  }`}
                >
                  <Clapperboard className="w-4 h-4 shrink-0" strokeWidth={2.5} />
                  <span>Video Explainer &amp; Clipper</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={controls.studioMode === 'documentary'}
                  disabled={isRunning}
                  onClick={() =>
                    setControls((prev) => ({
                      ...prev,
                      studioMode: 'documentary',
                    }))
                  }
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-extrabold transition-colors cursor-pointer disabled:opacity-55 whitespace-nowrap ${
                    controls.studioMode === 'documentary'
                      ? 'bg-[#3D5AFE] text-white'
                      : 'bg-white text-[#475569] hover:bg-[#F4F6F9] hover:text-[#0F172A]'
                  }`}
                >
                  <Layers className="w-4 h-4 shrink-0" strokeWidth={2.5} />
                  <span>Documentary / Motion / 3D</span>
                </button>
              </div>

              {controls.studioMode === 'explainer' ? (
                <VideoSourceCard
                  sourceType={controls.sourceType}
                  videoUrl={controls.videoUrl}
                  sourceMedia={sourceMedia}
                  disabled={isRunning}
                  isFetchingLink={isFetchingLink}
                  error={sourceError}
                  onSourceTypeChange={(sourceType) =>
                    setControls((prev) => ({ ...prev, sourceType }))
                  }
                  onVideoUrlChange={(videoUrl) => {
                    setSourceError(null);
                    setControls((prev) => ({ ...prev, videoUrl }));
                  }}
                  onFetchLinkPreview={() => void handleFetchLinkPreview()}
                  onFileSelected={(file) => void handleFileSelected(file)}
                  onClearSource={clearSourceMedia}
                />
              ) : (
                <DocumentaryInputCard
                  style={controls.documentaryStyle}
                  inputKind={controls.documentaryInputKind}
                  inputText={controls.documentaryInput}
                  useExternalGpu={controls.useExternalGpu}
                  externalGpuAvailable={externalGpuAvailable}
                  disabled={isRunning}
                  isPlanningOutline={isPlanningOutline}
                  error={documentaryError}
                  onStyleChange={(documentaryStyle) => {
                    setDocumentaryOutline(null);
                    setControls((prev) => ({ ...prev, documentaryStyle }));
                  }}
                  onInputKindChange={(documentaryInputKind) => {
                    setDocumentaryOutline(null);
                    setControls((prev) => ({ ...prev, documentaryInputKind }));
                  }}
                  onInputTextChange={(documentaryInput) => {
                    setDocumentaryError(null);
                    setDocumentaryOutline(null);
                    setControls((prev) => ({ ...prev, documentaryInput }));
                  }}
                  onToggleExternalGpu={(useExternalGpu) =>
                    setControls((prev) => ({ ...prev, useExternalGpu }))
                  }
                  onPreviewOutline={() =>
                    void handlePreviewDocumentaryOutline()
                  }
                />
              )}

              {/* COMPACT CARD 1: Source Video Preview OR Documentary Chapter Outline */}
              <SourcePreviewCard
                studioMode={controls.studioMode}
                source={sourceMedia}
                documentaryOutline={documentaryOutline}
                disabled={isRunning}
                onClear={
                  controls.studioMode === 'documentary'
                    ? clearDocumentaryOutline
                    : clearSourceMedia
                }
              />

              <CharacterCard
                enabled={controls.characterEnabled}
                savedCharacters={studioConfig.savedCharacters}
                selectedCharacterId={controls.selectedCharacterId}
                outfitPrompt={controls.outfitPrompt}
                disabled={isRunning}
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
                isRendering={isRunning}
                onChange={setControls}
                onStartRender={() => void handleStartRender()}
              />
            </div>

            {/* RIGHT COLUMN: Live 5-Step Progress -> Compact Card 2 (Final Production Output Deck) */}
            <div className="lg:col-span-7 space-y-5">
              <CloudProgressBar
                progress={progress}
                onCancelRender={handleCancelRender}
                onDismissError={() => setProgress(IDLE_PROGRESS)}
              />

              {/* COMPACT CARD 2: Final Production Output Deck */}
              <OutputDeckCard
                runTag={outputRunTag}
                clips={renderedClips}
                isRendering={isRunning}
                sourceDurationSec={outputSourceDuration}
              />
            </div>
          </div>
        ) : (
          <RecentRendersView
            records={savedRenders}
            onLoadRecord={handleLoadRecord}
            onDeleteRecord={handleDeleteRecord}
            onGoToStudio={() => setActiveTab('studio')}
          />
        )}
      </main>
    </div>
  );
}
