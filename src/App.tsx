import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar, type ActiveTab } from './components/TopBar';
import { StudioConfigBar } from './components/StudioConfigBar';
import { VideoSourceCard } from './components/VideoSourceCard';
import { SourcePreviewCard } from './components/SourcePreviewCard';
import { CharacterCard } from './components/CharacterCard';
import { ExplainerControls } from './components/ExplainerControls';
import { CloudProgressBar } from './components/CloudProgressBar';
import { OutputDeckCard } from './components/OutputDeckCard';
import { RecentRendersView } from './components/RecentRendersView';
import {
  clearStudioKeysOnly,
  getMissingConfigFields,
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
import { prepareLockedVisualClipsStage1 } from './engine/visualClipper';
import {
  applyFaceLockedOutfitChange,
  fetchLiveYouTubeTrends,
  inspectLockedVisualClipOneCall,
  refineBeatSyncedScriptAndMetadata,
} from './engine/intelligenceEngine';
import { synthesizeCommandingVoiceover } from './engine/audioEngine';
import { renderProductionMp4Gpu } from './engine/gpuRenderer';
import type {
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
    'Paste any video link (click Preview Source) or upload a file, then click Generate Production Video.',
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

  // Compact Card 1: Fetched / Imported Source Preview state
  const [sourceMedia, setSourceMedia] = useState<SourceMediaItem | null>(null);
  const [isFetchingLink, setIsFetchingLink] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

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

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      revokeOutputBlobUrls();
    };
  }, [revokeOutputBlobUrls]);

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
    revokeOutputBlobUrls();
    setControls((prev) => ({
      ...prev,
      videoUrl: '',
      customAngle: '',
      outfitPrompt: '',
    }));
    setProgress(IDLE_PROGRESS);
    setRenderedClips([]);
    setOutputRunTag(null);
    setOutputSourceDuration(0);
    setActiveTab('studio');
  }, [clearSourceMedia, progress.status, revokeOutputBlobUrls]);

  const handleCancelRender = useCallback(() => {
    abortRef.current?.abort();
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
      clipProgressLabel: null,
      statusDetail: 'GPU render cancelled. Ready for your next video.',
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

  const canGenerate =
    controls.sourceType === 'upload'
      ? Boolean(sourceMedia && sourceMedia.sourceType === 'upload')
      : Boolean(extractedLink);

  const handleStartRender = useCallback(async () => {
    if (!canGenerate || progress.status === 'running') return;

    const missing = getMissingConfigFields(studioConfig);
    if (missing.length > 0) {
      setIsConfigExpanded(true);
      setProgress({
        ...IDLE_PROGRESS,
        status: 'error',
        activeStep: 'resolving_stream',
        statusDetail: 'Add your Gemini API Key in Studio API Config above.',
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

    setProgress({
      status: 'running',
      activeStep: 'resolving_stream',
      completedSteps: [],
      percent: 5,
      statusDetail:
        controls.sourceType === 'upload'
          ? 'Preparing imported local video...'
          : 'Resolving direct no-watermark MP4 stream...',
      clipProgressLabel: null,
      runTag,
      startedAtMs,
      errorMessage: null,
    });

    const newOutputBlobUrls: string[] = [];

    try {
      // STEP 1: Resolve or reuse already-previewed SourceMediaItem (Compact Card 1)
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
              activeStep: 'resolving_stream',
              percent: Math.min(18, prev.percent + 2),
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

      // STAGE 1: Build & Lock Clean Visual Timeline FIRST (Clip, De-watermark, Cinema Grade)
      setProgress((prev) => ({
        ...prev,
        activeStep: 'visual_clip',
        completedSteps: ['resolving_stream'],
        percent: 18,
        statusDetail:
          activeSource.mode === 'long'
            ? 'Stage 1: Scanning 18 proportional keyframes (4%–96%) & locking clean viral clip timelines...'
            : 'Stage 1: Auto-trimming creator bumper & locking clean cinema-graded visual timeline...',
      }));

      const preparedClips = await prepareLockedVisualClipsStage1({
        source: activeSource,
        customAngle: controls.customAngle,
        geminiApiKey: studioConfig.geminiApiKey,
        onStatus: (msg) => {
          setProgress((prev) => ({
            ...prev,
            activeStep: 'visual_clip',
            percent: Math.min(32, Math.max(prev.percent, 22)),
            statusDetail: msg,
          }));
        },
        signal,
      });

      if (preparedClips.length === 0) {
        throw new Error('Stage 1 could not prepare a locked visual timeline.');
      }

      // Optional Face-Locked Outfit Change (once per job)
      let effectivePortraitUrl = activeCharacterUrl;
      if (
        controls.characterEnabled &&
        activeCharacterUrl &&
        controls.outfitPrompt.trim()
      ) {
        setProgress((prev) => ({
          ...prev,
          activeStep: 'visual_clip',
          percent: 34,
          statusDetail:
            'Applying face-locked outfit change to your talking character...',
        }));
        effectivePortraitUrl = await applyFaceLockedOutfitChange({
          portraitUrl: activeCharacterUrl,
          outfitPrompt: controls.outfitPrompt,
          geminiApiKey: studioConfig.geminiApiKey,
          signal,
        });
      }

      const totalClips = preparedClips.length;
      const finishedOutputs: RenderedClipOutput[] = [];
      const trendsCache = new Map<string, YouTubeTrendVideo[]>();

      // Process each locked visual clip strictly sequentially so phone RAM stays flat
      for (let i = 0; i < totalClips; i++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const preparedClip = preparedClips[i];
        const clipLabel =
          totalClips > 1 ? `Clip ${i + 1}/${totalClips}` : 'Single Short';
        const clipPrefix = totalClips > 1 ? `Clip ${i + 1}/${totalClips}: ` : '';

        const clipBasePct = 36 + Math.round((i / totalClips) * 60);
        const clipSpanPct = Math.round(60 / totalClips);

        // STAGE 2A: Inspect the ALREADY-CLEANED & STAMPED 9-Frame Contact Sheet (1 Vision Call)
        setProgress((prev) => ({
          ...prev,
          activeStep: 'ai_sync_trends',
          completedSteps: ['resolving_stream', 'visual_clip'],
          clipProgressLabel: clipLabel,
          percent: clipBasePct,
          statusDetail: `${clipPrefix}Stage 2: Inspecting locked ${preparedClip.lockedVisualDurationSec.toFixed(
            1
          )}s stamped frames & writing beat-synced script...`,
        }));

        const inspection = await inspectLockedVisualClipOneCall({
          source: activeSource,
          preparedClip,
          language: controls.language,
          customAngle: controls.customAngle,
          geminiApiKey: studioConfig.geminiApiKey,
          signal,
        });

        const lockedClip = inspection.updatedClip;

        // Fetch live US YouTube Shorts trends (cached by query key to save API quota)
        const trendCacheKey = inspection.searchQueries
          .map((q) => q.trim().toLowerCase())
          .sort()
          .join('|');
        let trends = trendsCache.get(trendCacheKey);
        if (!trends) {
          setProgress((prev) => ({
            ...prev,
            activeStep: 'ai_sync_trends',
            percent: clipBasePct + Math.round(clipSpanPct * 0.14),
            statusDetail: `${clipPrefix}Stage 2: Querying live US YouTube Shorts trends (${inspection.visionModel})...`,
          }));
          trends = await fetchLiveYouTubeTrends(
            inspection.searchQueries,
            studioConfig.youtubeApiKey,
            signal
          );
          trendsCache.set(trendCacheKey, trends);
        }

        // STAGE 2B: Refine strictly word-budgeted beats & 5 US trend SEO metadata cards
        setProgress((prev) => ({
          ...prev,
          activeStep: 'ai_sync_trends',
          percent: clipBasePct + Math.round(clipSpanPct * 0.24),
          statusDetail: `${clipPrefix}Stage 2: Refining word-budgeted beats (${lockedClip.lockedVisualDurationSec.toFixed(
            1
          )}s lock) & US SEO deck...`,
        }));

        const metadata = await refineBeatSyncedScriptAndMetadata({
          inspection,
          trends,
          language: controls.language,
          customAngle: controls.customAngle,
          config: studioConfig,
          signal,
        });

        // STAGE 3A: Commanding Heavy Voiceover + Automatic Time-Fit inside locked visual clip
        setProgress((prev) => ({
          ...prev,
          activeStep: 'voice_mux',
          completedSteps: ['resolving_stream', 'visual_clip', 'ai_sync_trends'],
          clipProgressLabel: clipLabel,
          percent: clipBasePct + Math.round(clipSpanPct * 0.36),
          statusDetail: `${clipPrefix}Stage 3: Synthesizing bold voiceover & broadcast vocal DSP...`,
        }));

        const audio = await synthesizeCommandingVoiceover({
          scriptText: metadata.voiceover,
          language: controls.language,
          voiceGender: controls.voiceGender,
          geminiApiKey: studioConfig.geminiApiKey,
          lockedVisualDurationSec: lockedClip.lockedVisualDurationSec,
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              activeStep: 'voice_mux',
              statusDetail: `${clipPrefix}${msg}`,
            }));
          },
          signal,
        });

        // STAGE 3B: Fast Single-Pass Continuous GPU Mux (requestVideoFrameCallback -> WebGL2/WebCodecs)
        const gpuStartPct = clipBasePct + Math.round(clipSpanPct * 0.5);
        const gpuSpanPct = Math.max(10, Math.round(clipSpanPct * 0.48));

        setProgress((prev) => ({
          ...prev,
          activeStep: 'voice_mux',
          completedSteps: ['resolving_stream', 'visual_clip', 'ai_sync_trends'],
          clipProgressLabel: clipLabel,
          percent: gpuStartPct,
          statusDetail: `${clipPrefix}Stage 3: Starting fast single-pass GPU mux (${lockedClip.lockedVisualDurationSec.toFixed(
            1
          )}s locked clip)...`,
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
              activeStep: 'voice_mux',
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
        // Append each completed clip immediately to Compact Card 2
        setRenderedClips([...finishedOutputs]);
      }

      activeOutputBlobUrlsRef.current = newOutputBlobUrls;
      const first = finishedOutputs[0];
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        activeStep: 'ready',
        completedSteps: [
          'resolving_stream',
          'visual_clip',
          'ai_sync_trends',
          'voice_mux',
          'ready',
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
    extractedLink,
    progress.status,
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
      activeStep: 'ready',
      completedSteps: [
        'resolving_stream',
        'visual_clip',
        'ai_sync_trends',
        'voice_mux',
        'ready',
      ],
      percent: 100,
      clipProgressLabel: null,
      statusDetail: `Loaded ${record.clips.length} saved clip${
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
            {/* LEFT COLUMN: Source Input -> Compact Card 1 (Source Preview) -> Character -> Controls */}
            <div className="lg:col-span-5 space-y-5">
              <VideoSourceCard
                sourceType={controls.sourceType}
                videoUrl={controls.videoUrl}
                sourceMedia={sourceMedia}
                disabled={progress.status === 'running'}
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

              {/* COMPACT CARD 1: Fetched / Imported Source Preview */}
              <SourcePreviewCard
                source={sourceMedia}
                disabled={progress.status === 'running'}
                onClear={clearSourceMedia}
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

            {/* RIGHT COLUMN: Live 5-Step Progress -> Compact Card 2 (Final Production Output Deck) */}
            <div className="lg:col-span-7 space-y-5">
              <CloudProgressBar
                progress={progress}
                onCancelRender={handleCancelRender}
                onDismissError={() => setProgress(IDLE_PROGRESS)}
              />

              {/* COMPACT CARD 2: Final Production Output Deck (Lists ALL rendered clips sequentially) */}
              <OutputDeckCard
                runTag={outputRunTag}
                clips={renderedClips}
                isRendering={progress.status === 'running'}
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
