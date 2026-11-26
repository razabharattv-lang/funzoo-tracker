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
import { uploadCharacterPortraitToCloudinary } from './lib/cloudinary';
import {
  deleteRenderRecord,
  loadSavedRenders,
  saveRenderRecord,
} from './lib/storage';
import { resolveSourceStream } from './engine/streamResolver';
import {
  analyzeContactSheetOneCall,
  applyFaceLockedOutfitChange,
  buildContactSheetJpeg,
  fetchLiveYouTubeTrends,
  generateViralScriptAndMetadata,
} from './engine/intelligenceEngine';
import { synthesizeStudioVoiceover } from './engine/audioEngine';
import { renderProductionMp4Gpu } from './engine/gpuRenderer';
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
    'Paste any video link or share-text (or upload a file), then click Generate Production Video — runs 100% on your device GPU.',
  runTag: null,
  startedAtMs: null,
  errorMessage: null,
};

function createRunTag(): string {
  const hex = Math.random().toString(16).slice(2, 8);
  return `exp_${Date.now()}_${hex}`;
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
      reason: 'Short Video Main Scene',
      video_url: manifest.video_url,
      duration_sec: manifest.duration_sec,
      width: manifest.width,
      height: manifest.height,
      file_size_bytes: manifest.file_size_bytes,
      voice_engine: manifest.voice_engine,
      render_engine: manifest.render_engine || 'WebCodecs GPU',
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
  const [isConfigExpanded, setIsConfigExpanded] = useState(
    () => getMissingConfigFields(loadStudioConfig()).length > 0
  );

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
  const activeOutputBlobUrlsRef = useRef<string[]>([]);

  const revokeOutputBlobUrls = useCallback(() => {
    for (const url of activeOutputBlobUrlsRef.current) {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    }
    activeOutputBlobUrlsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      revokeOutputBlobUrls();
    };
  }, [revokeOutputBlobUrls]);

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
    if (getMissingConfigFields(saved).length === 0) {
      window.setTimeout(() => setIsConfigExpanded(false), 600);
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
      setIsUploadingPortrait(true);
      try {
        const res = await uploadCharacterPortraitToCloudinary(file, studioConfig);
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
    revokeOutputBlobUrls();
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
  }, [clearLocalClip, progress.status, revokeOutputBlobUrls]);

  const handleCancelRender = useCallback(() => {
    abortRef.current?.abort();
    setProgress((prev) => ({
      ...prev,
      status: 'cancelled',
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
      ? Boolean(localClip)
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
    setResult(null);
    setSelectedClipIndex(0);
    setPortraitError(null);

    setProgress({
      status: 'running',
      activeStep: 'resolving_stream',
      completedSteps: [],
      percent: 5,
      statusDetail:
        controls.sourceType === 'upload'
          ? 'Loading local video clip into browser engine...'
          : 'Racing parallel no-watermark stream resolvers...',
      runTag,
      startedAtMs,
      errorMessage: null,
    });

    let sourceObjectUrlToRevoke: string | null = null;
    const newOutputBlobUrls: string[] = [];

    try {
      // CORE 1: Resolving Stream & Smart Clipping (5% -> 20%)
      const resolved = await resolveSourceStream({
        sourceType: controls.sourceType,
        videoUrl: controls.videoUrl,
        localClip,
        config: studioConfig,
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
      sourceObjectUrlToRevoke = resolved.objectUrl;

      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      const totalSegments = resolved.segments.length;

      // Optional Face-Locked Outfit Change (executed once before sequential clips)
      let effectivePortraitUrl = activeCharacterUrl;
      if (
        controls.characterEnabled &&
        activeCharacterUrl &&
        controls.outfitPrompt.trim()
      ) {
        setProgress((prev) => ({
          ...prev,
          activeStep: 'ai_trends',
          completedSteps: ['resolving_stream'],
          percent: 21,
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

      const clipOutputs: RenderedClipItem[] = [];

      // Strictly sequential multi-clip processing so mobile RAM stays flat between clips
      for (let idx = 0; idx < totalSegments; idx++) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const seg = resolved.segments[idx];
        const segDuration = Math.max(3, seg.endSec - seg.startSec);
        const clipPrefix =
          totalSegments > 1 ? `[Clip ${idx + 1}/${totalSegments}] ` : '';

        const segStartPct = 22 + Math.round((idx / totalSegments) * 75);
        const segSpanPct = Math.round(75 / totalSegments);

        // CORE 2: 1-Call Contact-Sheet Vision + Live YouTube Trends + NVIDIA Script
        setProgress((prev) => ({
          ...prev,
          activeStep: 'ai_trends',
          completedSteps: ['resolving_stream'],
          percent: segStartPct,
          statusDetail: `${clipPrefix}Sampling 9 keyframes onto lightweight OffscreenCanvas contact sheet...`,
        }));

        const { base64Jpeg } = await buildContactSheetJpeg(
          resolved.objectUrl,
          seg.startSec,
          seg.endSec,
          signal
        );

        setProgress((prev) => ({
          ...prev,
          percent: segStartPct + Math.round(segSpanPct * 0.12),
          statusDetail: `${clipPrefix}1-Call Gemini Vision scanning beats, climax & watermark boxes...`,
        }));

        const vision = await analyzeContactSheetOneCall({
          base64Jpeg,
          clipDurationSec: segDuration,
          customAngle: controls.customAngle,
          geminiApiKey: studioConfig.geminiApiKey,
          signal,
        });

        setProgress((prev) => ({
          ...prev,
          percent: segStartPct + Math.round(segSpanPct * 0.22),
          statusDetail: `${clipPrefix}Fetching live US YouTube Shorts trends (YouTube Data API v3)...`,
        }));

        const trends = await fetchLiveYouTubeTrends(
          vision.search_queries,
          studioConfig.youtubeApiKey,
          signal
        );

        setProgress((prev) => ({
          ...prev,
          percent: segStartPct + Math.round(segSpanPct * 0.3),
          statusDetail: `${clipPrefix}Generating suspense loop narration & viral SEO metadata...`,
        }));

        const scriptPack = await generateViralScriptAndMetadata({
          vision,
          trends,
          clipDurationSec: segDuration,
          language: controls.language,
          customAngle: controls.customAngle,
          config: studioConfig,
          signal,
        });

        // CORE 3: Studio WebAudio DSP & Real Male/Female Voiceover + Lip-Sync Envelope
        setProgress((prev) => ({
          ...prev,
          activeStep: 'voice_lipsync',
          completedSteps: ['resolving_stream', 'ai_trends'],
          percent: segStartPct + Math.round(segSpanPct * 0.4),
          statusDetail: `${clipPrefix}Synthesizing high-energy voiceover & OfflineAudioContext vocal DSP...`,
        }));

        const audio = await synthesizeStudioVoiceover({
          scriptText: scriptPack.voiceover,
          language: controls.language,
          voiceGender: controls.voiceGender,
          geminiApiKey: studioConfig.geminiApiKey,
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              statusDetail: `${clipPrefix}${msg}`,
            }));
          },
          signal,
        });

        // CORE 4: Off-Main-Thread WebWorker + WebGL2 + WebCodecs GPU Render (lazy FFmpeg fallback)
        const gpuBasePct = segStartPct + Math.round(segSpanPct * 0.52);
        const gpuSpanPct = Math.max(12, Math.round(segSpanPct * 0.45));

        setProgress((prev) => ({
          ...prev,
          activeStep: 'gpu_render',
          completedSteps: ['resolving_stream', 'ai_trends', 'voice_lipsync'],
          percent: gpuBasePct,
          statusDetail: `${clipPrefix}Launching background WebGL2 + WebCodecs GPU Worker...`,
        }));

        const rendered = await renderProductionMp4Gpu({
          sourceVideoBlob: resolved.blob,
          sourceWidth: resolved.width,
          sourceHeight: resolved.height,
          startSec: seg.startSec,
          endSec: seg.endSec,
          audio,
          scriptText: scriptPack.voiceover,
          language: controls.language,
          watermarkBoxes: vision.watermark_boxes,
          climaxSecond: vision.climax_second,
          characterEnabled: controls.characterEnabled,
          characterPortraitUrl: controls.characterEnabled
            ? effectivePortraitUrl
            : '',
          onStatus: (msg) => {
            setProgress((prev) => ({
              ...prev,
              statusDetail: `${clipPrefix}${msg}`,
            }));
          },
          onProgressPct: (localPct) => {
            const mappedPct = Math.min(
              98,
              gpuBasePct + Math.round((localPct / 100) * gpuSpanPct)
            );
            setProgress((prev) => ({
              ...prev,
              percent: Math.max(prev.percent, mappedPct),
            }));
          },
          signal,
        });

        newOutputBlobUrls.push(rendered.blobUrl);

        clipOutputs.push({
          clip_index: seg.clipIndex,
          start_sec: seg.startSec,
          end_sec: seg.endSec,
          reason: seg.reason,
          video_url: rendered.blobUrl,
          duration_sec: rendered.durationSec,
          width: rendered.width,
          height: rendered.height,
          file_size_bytes: rendered.sizeBytes,
          voice_engine: `${audio.engineLabel} · ${scriptPack.scriptEngine}`,
          render_engine: rendered.renderEngine,
          character_mode: rendered.characterMode,
          watermark_boxes_removed: rendered.delogoCount,
          climax_second: vision.climax_second,
          youtube_trends_count: trends.length,
          voiceover: scriptPack.voiceover,
          title: scriptPack.title,
          description: scriptPack.description,
          tags: scriptPack.tags,
          hashtags: scriptPack.hashtags,
          posting_time: scriptPack.posting_time,
        });
      }

      const first = clipOutputs[0];
      if (!first) {
        throw new Error('No output clips were generated.');
      }

      const manifest: RenderResultManifest = {
        run_tag: runTag,
        video_url: first.video_url,
        duration_sec: first.duration_sec,
        width: first.width,
        height: first.height,
        file_size_bytes: first.file_size_bytes,
        language: controls.language,
        voice_gender: controls.voiceGender,
        voice_engine: first.voice_engine,
        render_engine: first.render_engine,
        character_mode: first.character_mode,
        watermark_boxes_removed: first.watermark_boxes_removed,
        mid_twist_second: first.climax_second,
        youtube_trends_count: first.youtube_trends_count,
        voiceover: first.voiceover,
        title: first.title,
        description: first.description,
        tags: first.tags,
        hashtags: first.hashtags,
        posting_time: first.posting_time,
        completed_at: new Date().toISOString(),
        is_long_video_split: resolved.isLongVideoSplit,
        source_total_duration: resolved.durationSec,
        clips: clipOutputs,
      };

      activeOutputBlobUrlsRef.current = newOutputBlobUrls;
      setResult(manifest);
      setSelectedClipIndex(0);
      setProgress((prev) => ({
        ...prev,
        status: 'completed',
        activeStep: 'ready',
        completedSteps: [
          'resolving_stream',
          'ai_trends',
          'voice_lipsync',
          'gpu_render',
          'ready',
        ],
        percent: 100,
        statusDetail:
          clipOutputs.length > 1
            ? `Hardware-rendered ${clipOutputs.length} viral ${first.width}×${first.height} MP4 clips directly in your browser.`
            : `Finished ${first.width}×${first.height} explainer MP4 (${first.render_engine}) — ready for instant download.`,
      }));

      const updated = saveRenderRecord({
        manifest,
        sourceLabel: resolved.sourceLabel,
        customAngle: controls.customAngle,
      });
      setSavedRenders(updated);
    } catch (err) {
      for (const u of newOutputBlobUrls) URL.revokeObjectURL(u);
      if ((err as Error).name === 'AbortError') return;
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        statusDetail: 'In-browser render stopped with an error.',
        errorMessage: (err as Error).message || 'Unexpected render failure.',
      }));
    } finally {
      if (sourceObjectUrlToRevoke) {
        URL.revokeObjectURL(sourceObjectUrlToRevoke);
      }
    }
  }, [
    activeCharacterUrl,
    canGenerate,
    controls,
    localClip,
    progress.status,
    revokeOutputBlobUrls,
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
        'resolving_stream',
        'ai_trends',
        'voice_lipsync',
        'gpu_render',
        'ready',
      ],
      percent: 100,
      statusDetail:
        clipsCount > 1
          ? `Loaded ${clipsCount}-clip render metadata (${record.manifest.run_tag}).`
          : `Loaded saved render metadata (${record.manifest.run_tag}).`,
      runTag: record.manifest.run_tag,
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
                onCancelRender={handleCancelRender}
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
            onGoToStudio={() => setActiveTab('studio')}
          />
        )}
      </main>
    </div>
  );
}
