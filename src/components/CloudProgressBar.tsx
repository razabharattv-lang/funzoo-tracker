import { useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Loader2,
  Radio,
  Sparkles,
} from 'lucide-react';
import { formatBytes } from '../lib/videoProbe';
import type {
  ConnectionStatusState,
  PipelineProgress,
  PipelineStepId,
} from '../types/studio';

interface CloudProgressBarProps {
  progress: PipelineProgress;
  connectionStatus: ConnectionStatusState;
}

const STEPS: { id: PipelineStepId; num: string; label: string }[] = [
  { id: 'step_1_fetch_clip', num: '1', label: 'Fetch' },
  { id: 'step_2_clean_grade', num: '2', label: 'Clean' },
  { id: 'step_3_translate_seo', num: '3', label: 'Translate' },
  { id: 'step_4_voiceover', num: '4', label: 'Voice' },
  { id: 'step_5_mux_output', num: '5', label: 'Output' },
];

const STEP_SHORT_NAME: Record<PipelineStepId, string> = {
  step_1_fetch_clip: 'S1',
  step_2_clean_grade: 'S2',
  step_3_translate_seo: 'S3',
  step_4_voiceover: 'S4',
  step_5_mux_output: 'S5',
};

function pillStyle(value: string): string {
  if (value === 'Connected' || value === 'Gemini-TTS') {
    return 'border-[#00C853] bg-[#E8F9EE] text-[#065F46]';
  }
  if (value === 'CORS-Blocked' || value === 'Quota-Limit') {
    return 'border-[#FF1744] bg-[#FFF1F3] text-[#B71C1C]';
  }
  if (value === 'Studio-Audio' || value === 'Ready') {
    return 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]';
  }
  return 'border-[#CBD5E1] bg-[#F4F6F9] text-[#475569]';
}

export function CloudProgressBar({
  progress,
  connectionStatus,
}: CloudProgressBarProps) {
  const [diagExpanded, setDiagExpanded] = useState(false);
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
  const diag = progress.diagnostics;
  const hasDiagnostics =
    diag.sourceDurationSec !== null || diag.stepLogs.length > 0;
  const showDiagBody = diagExpanded || progress.status === 'error';

  const statusColor =
    progress.status === 'error'
      ? 'text-[#FF1744]'
      : progress.status === 'completed'
      ? 'text-[#00C853]'
      : progress.status === 'running'
      ? 'text-[#3D5AFE]'
      : 'text-[#64748B]';

  const barFill =
    progress.status === 'error'
      ? 'bg-[#FF1744]'
      : progress.status === 'completed'
      ? 'bg-[#00C853]'
      : 'bg-[#3D5AFE]';

  const statusPills = [
    { label: 'Gemini', value: connectionStatus.gemini },
    { label: 'NVIDIA', value: connectionStatus.nvidia },
    { label: 'YouTube', value: connectionStatus.youtube },
    { label: 'Voice', value: connectionStatus.voice },
  ];

  const aiModeLabel =
    diag.aiMode === 'live'
      ? `AI Live (${diag.aiCallsMade} call)`
      : diag.aiMode === 'fallback'
      ? `Local Fallback (${diag.aiCallsMade} call)`
      : 'Pending';

  const aiModeTone =
    diag.aiMode === 'live'
      ? 'text-[#065F46]'
      : diag.aiMode === 'fallback'
      ? 'text-[#B45309]'
      : 'text-[#64748B]';

  return (
    <section
      aria-label="5-Step Production Pipeline Progress"
      className="rounded-2xl border-2 border-[#E2E8F0] bg-white p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg bg-[#FF1744] text-white flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <div>
            <h2 className="text-base font-extrabold text-[#0F172A]">
              5-Step Pipeline
            </h2>
            {progress.status !== 'idle' && progress.statusDetail && (
              <p className={`text-xs font-bold ${statusColor}`}>
                {progress.statusDetail}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasDiagnostics && (
            <button
              type="button"
              onClick={() => setDiagExpanded((prev) => !prev)}
              aria-expanded={showDiagBody}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#CBD5E1] bg-[#F4F6F9] hover:border-[#3D5AFE] text-[#334155] text-[11px] font-extrabold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Activity className="w-3.5 h-3.5 text-[#3D5AFE]" strokeWidth={2.5} />
              <span>Run Diagnostics</span>
              {showDiagBody ? (
                <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
              )}
            </button>
          )}
          {progress.clipProgressLabel && (
            <span className="px-2.5 py-1 rounded-full border-2 border-[#3D5AFE] bg-[#EEF2FF] text-[#3D5AFE] text-xs font-extrabold font-mono-tabular">
              {progress.clipProgressLabel}
            </span>
          )}
          <span className="font-mono-tabular text-sm font-extrabold text-[#0F172A]">
            {pct}%
          </span>
        </div>
      </div>

      {/* Compact Connection Status Pills */}
      <div
        aria-label="Connection Status"
        className="flex flex-wrap items-center gap-2 pt-0.5"
      >
        <Radio className="w-3.5 h-3.5 text-[#3D5AFE] shrink-0" strokeWidth={2.5} />
        {statusPills.map((pill) => (
          <span
            key={pill.label}
            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border-2 text-[11px] font-extrabold whitespace-nowrap ${pillStyle(
              pill.value
            )}`}
          >
            <span>{pill.label}:</span>
            <span>{pill.value}</span>
          </span>
        ))}
      </div>

      {/* Progress Track */}
      <div className="w-full h-3 rounded-full bg-[#F4F6F9] border-2 border-[#E2E8F0] overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${barFill}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* 5 Explicit Step Badges */}
      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {STEPS.map((step) => {
          const isDone = progress.completedSteps.includes(step.id);
          const isActive =
            progress.status === 'running' && progress.activeStep === step.id;
          const isError =
            progress.status === 'error' && progress.activeStep === step.id;

          return (
            <li
              key={step.id}
              className={`rounded-xl border-2 px-2.5 py-2 flex items-center gap-1.5 text-xs font-extrabold transition-colors ${
                isError
                  ? 'border-[#FF1744] bg-[#FFF1F3] text-[#B71C1C]'
                  : isDone
                  ? 'border-[#00C853] bg-[#E8F9EE] text-[#065F46]'
                  : isActive
                  ? 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]'
                  : 'border-[#E2E8F0] bg-[#F4F6F9] text-[#64748B]'
              }`}
            >
              {isError ? (
                <AlertCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} />
              ) : isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} />
              ) : isActive ? (
                <Loader2
                  className="w-3.5 h-3.5 shrink-0 animate-spin"
                  strokeWidth={2.5}
                />
              ) : (
                <Circle className="w-3.5 h-3.5 shrink-0" strokeWidth={2.25} />
              )}
              <span className="truncate">
                {step.num}. {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {progress.status === 'error' && progress.errorMessage && (
        <div
          role="alert"
          className="rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-3.5 py-2.5 text-xs font-bold text-[#B71C1C]"
        >
          {progress.errorMessage}
        </div>
      )}

      {/* Toggleable Compact Run Diagnostics Strip */}
      {hasDiagnostics && showDiagBody && (
        <div
          aria-label="Run Diagnostics Details"
          className="rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] p-3 space-y-2.5"
        >
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] font-mono-tabular">
            <div className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5">
              <div className="text-[10px] font-bold uppercase text-[#64748B]">Source</div>
              <div className="font-extrabold text-[#0F172A] truncate">
                {diag.sourceDurationSec !== null
                  ? `${diag.sourceDurationSec.toFixed(1)}s · ${diag.sourceResolution || '—'}`
                  : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5">
              <div className="text-[10px] font-bold uppercase text-[#64748B]">Frames</div>
              <div className="font-extrabold text-[#0F172A] truncate">
                {diag.step1FramesSampled > 0
                  ? `S1:${diag.step1FramesSampled} / S2:${diag.step2FramesRendered}`
                  : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5">
              <div className="text-[10px] font-bold uppercase text-[#64748B]">AI Mode</div>
              <div className={`font-extrabold truncate ${aiModeTone}`}>
                {aiModeLabel}
              </div>
            </div>
            <div className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5">
              <div className="text-[10px] font-bold uppercase text-[#64748B]">Audio</div>
              <div className="font-extrabold text-[#0F172A] truncate">
                {diag.audioDurationSec !== null
                  ? `${diag.audioDurationSec.toFixed(1)}s`
                  : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 col-span-2 sm:col-span-1">
              <div className="text-[10px] font-bold uppercase text-[#64748B]">Output</div>
              <div className="font-extrabold text-[#0F172A] truncate">
                {diag.outputBlobBytes !== null
                  ? `${formatBytes(diag.outputBlobBytes)}`
                  : '—'}
              </div>
            </div>
          </div>

          {diag.stepLogs.length > 0 && (
            <ul className="space-y-1 text-[11px] font-mono-tabular">
              {diag.stepLogs.map((entry, idx) => (
                <li
                  key={`${entry.step}-${idx}`}
                  className={`flex items-start gap-2 rounded-lg px-2 py-1 ${
                    entry.status === 'error'
                      ? 'bg-[#FFF1F3] text-[#B71C1C]'
                      : entry.status === 'warn'
                      ? 'bg-[#FFFBEB] text-[#92400E]'
                      : 'bg-white text-[#334155]'
                  }`}
                >
                  <span className="font-extrabold shrink-0">
                    [{STEP_SHORT_NAME[entry.step]} · {entry.atSec.toFixed(1)}s]
                  </span>
                  <span className="font-semibold break-words">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
