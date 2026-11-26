import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { PipelineProgressState, PipelineStepId } from '../types/studio';

interface CloudProgressBarProps {
  progress: PipelineProgressState;
  onCancelRender: () => void;
  onDismissError: () => void;
}

const PIPELINE_STEPS: { id: PipelineStepId; label: string; shortLabel: string }[] = [
  { id: 'fetching_link', label: 'Fetching Link', shortLabel: 'Fetching Link' },
  {
    id: 'scan_trends',
    label: '1-FPS Scan & Trend Research',
    shortLabel: '1-FPS Scan & Trends',
  },
  {
    id: 'voice_character',
    label: 'Suspense Voice & Character',
    shortLabel: 'Voice & Character',
  },
  {
    id: 'anti_copyright_render',
    label: 'Anti-Copyright Render',
    shortLabel: 'Anti-Copyright Render',
  },
  { id: 'ready', label: 'Ready', shortLabel: 'Ready' },
];

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function CloudProgressBar({
  progress,
  onCancelRender,
  onDismissError,
}: CloudProgressBarProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (progress.status !== 'running' || !progress.startedAtMs) {
      if (progress.status === 'idle') setElapsedMs(0);
      return;
    }
    const start = progress.startedAtMs;
    setElapsedMs(Date.now() - start);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 1000);
    return () => window.clearInterval(id);
  }, [progress.status, progress.startedAtMs]);

  const isRunning = progress.status === 'running';
  const isCompleted = progress.status === 'completed';
  const isError = progress.status === 'error';

  const cardBorder = isCompleted
    ? 'border-[#00C853]'
    : isRunning
    ? 'border-[#3D5AFE]'
    : isError
    ? 'border-[#FF1744]'
    : 'border-[#E2E8F0]';

  const barFillColor = isCompleted
    ? 'bg-[#00C853]'
    : isError
    ? 'bg-[#FF1744]'
    : 'bg-[#3D5AFE]';

  return (
    <section
      aria-label="7GB Cloud Render Progress"
      className={`rounded-2xl border-2 bg-white p-5 transition-colors ${cardBorder}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-base font-extrabold text-[#0F172A]">
              7GB Cloud Render Pipeline
            </h2>
            {isCompleted && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#00C853] text-white text-xs font-extrabold whitespace-nowrap">
                Ready
              </span>
            )}
            {isRunning && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#3D5AFE] text-white text-xs font-extrabold whitespace-nowrap">
                Running
              </span>
            )}
            {isError && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#FF1744] text-white text-xs font-extrabold whitespace-nowrap">
                Failed
              </span>
            )}
          </div>
          <p className="text-xs font-semibold text-[#475569] mt-1">
            {progress.statusDetail}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {(isRunning || isCompleted) && elapsedMs > 0 && (
            <span className="font-mono-tabular text-xs font-bold text-[#334155] px-2.5 py-1 rounded-lg bg-[#F4F6F9] border-2 border-[#E2E8F0]">
              {formatElapsed(elapsedMs)}
            </span>
          )}
          <span className="font-mono-tabular text-sm font-extrabold text-[#0F172A] min-w-[3.2rem] text-right">
            {progress.percent}%
          </span>
          {progress.githubRunUrl && (
            <a
              href={progress.githubRunUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#3D5AFE] bg-[#EEF2FF] text-[#3D5AFE] text-xs font-bold hover:bg-[#3D5AFE] hover:text-white transition-colors whitespace-nowrap"
            >
              <span>GitHub Run</span>
              <ExternalLink className="w-3.5 h-3.5" strokeWidth={2.25} />
            </a>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={onCancelRender}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#FF1744] bg-white text-[#FF1744] hover:bg-[#FF1744] hover:text-white text-xs font-bold transition-colors whitespace-nowrap cursor-pointer"
            >
              <XCircle className="w-3.5 h-3.5" strokeWidth={2.25} />
              <span>Cancel</span>
            </button>
          )}
        </div>
      </div>

      {/* Solid-Fill Progress Bar */}
      <div
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="w-full h-3.5 rounded-full bg-[#E2E8F0] overflow-hidden mb-4"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barFillColor}`}
          style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
        />
      </div>

      {/* 5 Stepped Indicators */}
      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {PIPELINE_STEPS.map((step, index) => {
          const isDone = progress.completedSteps.includes(step.id);
          const isActive = progress.activeStep === step.id && isRunning;
          const isFailedHere = progress.activeStep === step.id && isError;

          let containerClass = 'border-[#E2E8F0] bg-[#F4F6F9] text-[#64748B]';
          let iconBadgeClass = 'bg-[#CBD5E1] text-[#334155]';

          if (isDone) {
            containerClass = 'border-[#00C853] bg-[#E8F8EE] text-[#065F46]';
            iconBadgeClass = 'bg-[#00C853] text-white';
          } else if (isActive) {
            containerClass = 'border-[#3D5AFE] bg-[#EEF2FF] text-[#1E3A8A]';
            iconBadgeClass = 'bg-[#3D5AFE] text-white';
          } else if (isFailedHere) {
            containerClass = 'border-[#FF1744] bg-[#FFF1F3] text-[#991B1B]';
            iconBadgeClass = 'bg-[#FF1744] text-white';
          }

          return (
            <li
              key={step.id}
              className={`rounded-xl border-2 px-2.5 py-2 flex items-center gap-2 transition-colors ${containerClass}`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-extrabold shrink-0 font-mono-tabular ${iconBadgeClass}`}
              >
                {isDone ? (
                  <Check className="w-3 h-3" strokeWidth={3} />
                ) : isActive ? (
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className="text-xs font-bold leading-tight truncate"
                title={step.label}
              >
                {step.shortLabel}
              </span>
            </li>
          );
        })}
      </ol>

      {isError && progress.errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] p-3.5 flex items-start justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle
              className="w-4 h-4 text-[#FF1744] shrink-0 mt-0.5"
              strokeWidth={2.5}
            />
            <p className="text-xs font-bold text-[#991B1B] break-words">
              {progress.errorMessage}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            className="text-xs font-extrabold text-[#FF1744] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
