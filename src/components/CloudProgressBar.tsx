import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { PipelineProgress, PipelineStepId } from '../types/studio';

interface CloudProgressBarProps {
  progress: PipelineProgress;
}

const STEPS: { id: PipelineStepId; num: string; label: string }[] = [
  { id: 'step_1_fetch_clip', num: '1', label: 'Fetch & Clip' },
  { id: 'step_2_clean_grade', num: '2', label: 'Clean & Grade' },
  { id: 'step_3_translate_seo', num: '3', label: 'Translate & SEO' },
  { id: 'step_4_voiceover', num: '4', label: 'Voiceover' },
  { id: 'step_5_mux_output', num: '5', label: 'Mux & Output' },
];

export function CloudProgressBar({ progress }: CloudProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));

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
              5-Step Video Production Pipeline
            </h2>
            <p className={`text-xs font-bold ${statusColor}`}>
              {progress.statusDetail ||
                'Load a video link or local file, then run all 5 steps.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
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
    </section>
  );
}
