import { Clapperboard, RotateCcw } from 'lucide-react';

export type ActiveTab = 'studio' | 'history';

interface TopBarProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onResetWorkspace: () => void;
  isRendering: boolean;
  savedCount: number;
}

export function TopBar({
  activeTab,
  onTabChange,
  onResetWorkspace,
  isRendering,
  savedCount,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white border-b-2 border-[#E2E8F0]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          type="button"
          onClick={() => onTabChange('studio')}
          className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3D5AFE] rounded-lg"
        >
          <span className="w-9 h-9 rounded-lg bg-[#FF1744] text-white flex items-center justify-center shrink-0">
            <Clapperboard className="w-5 h-5" strokeWidth={2.25} />
          </span>
          <span className="text-lg font-extrabold tracking-tight text-[#0F172A]">
            US Explainer Studio
          </span>
        </button>

        {/* Zone 2: Clean single-line navigation links */}
        <nav aria-label="Primary" className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => onTabChange('studio')}
            className={`h-16 px-1 text-sm font-bold border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'studio'
                ? 'border-[#3D5AFE] text-[#3D5AFE]'
                : 'border-transparent text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            Studio Workspace
          </button>
          <button
            type="button"
            onClick={() => onTabChange('history')}
            className={`h-16 px-1 text-sm font-bold border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-2 ${
              activeTab === 'history'
                ? 'border-[#3D5AFE] text-[#3D5AFE]'
                : 'border-transparent text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            <span>Recent Renders</span>
            {savedCount > 0 && (
              <span className="font-mono-tabular text-xs font-bold text-[#3D5AFE]">
                ({savedCount})
              </span>
            )}
          </button>
        </nav>

        {/* Zone 3: Single primary header action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onResetWorkspace}
            disabled={isRendering}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold border-2 border-[#E2E8F0] bg-[#F4F6F9] text-[#0F172A] hover:border-[#3D5AFE] hover:bg-[#EEF2FF] hover:text-[#3D5AFE] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" strokeWidth={2.25} />
            <span>New Clip</span>
          </button>
        </div>
      </div>
    </header>
  );
}
