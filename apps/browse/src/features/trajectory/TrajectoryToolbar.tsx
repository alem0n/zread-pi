/**
 * TrajectoryToolbar —— 搜索框 / 折叠开关 / 时序模式切换 / 运行状态徽标。
 */

import { memo } from 'react';
import { Search, ChevronsDownUp, ChevronsUpDown, Clock, ListOrdered, AlignHorizontalDistributeCenter } from 'lucide-react';
import {
  formatDurationMs,
  formatTokens,
  type TrajectoryRunSummary,
  type TrajectoryTimelineMode,
} from '@zread-pi/trajectory';
import { useT } from '@/i18n/I18nContext';

interface TrajectoryToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  collapseTurns: boolean;
  onCollapseTurnsChange: (collapsed: boolean) => void;
  collapseAssistant: boolean;
  onCollapseAssistantChange: (collapsed: boolean) => void;
  timelineMode: TrajectoryTimelineMode;
  onTimelineModeChange: (mode: TrajectoryTimelineMode) => void;
  runSummary: TrajectoryRunSummary | null;
  runEnded: boolean;
}

const TIMELINE_MODES: Array<{ mode: TrajectoryTimelineMode; labelKey: string; icon: React.ReactNode }> = [
  { mode: 'sequence', labelKey: 'trajectory.modes.sequence', icon: <ListOrdered size={14} /> },
  { mode: 'duration', labelKey: 'trajectory.modes.duration', icon: <Clock size={14} /> },
  { mode: 'time', labelKey: 'trajectory.modes.time', icon: <AlignHorizontalDistributeCenter size={14} /> },
  { mode: 'actual', labelKey: 'trajectory.modes.actual', icon: <Clock size={14} /> },
];

const STATUS_ENTRIES: Record<TrajectoryRunSummary['status'], { key: string; className: string }> = {
  running: { key: 'trajectory.statuses.running', className: 'text-[#dd5b00]' },
  completed: { key: 'trajectory.statuses.completed', className: 'text-[#2a9d99]' },
  failed: { key: 'trajectory.statuses.failed', className: 'text-[#e54847]' },
  interrupted: { key: 'trajectory.statuses.interrupted', className: 'text-[#a39e98]' },
  unknown: { key: 'trajectory.statuses.unknown', className: 'text-[#a39e98]' },
};

export const TrajectoryToolbar = memo(function TrajectoryToolbar({
  query,
  onQueryChange,
  matchCount,
  collapseTurns,
  onCollapseTurnsChange,
  collapseAssistant,
  onCollapseAssistantChange,
  timelineMode,
  onTimelineModeChange,
  runSummary,
  runEnded,
}: TrajectoryToolbarProps) {
  const t = useT();
  const status = runSummary ? STATUS_ENTRIES[runSummary.status] : null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 bg-[#f6f5f4]">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a39e98]" />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('trajectory.searchPlaceholder')}
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#0075de] focus:border-transparent"
        />
        {query.trim() !== '' ? (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[#615d59]">
            {matchCount}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {TIMELINE_MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            onClick={() => onTimelineModeChange(entry.mode)}
            title={t('trajectory.modeTitle', { label: t(entry.labelKey) })}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
              timelineMode === entry.mode
                ? 'bg-[#0075de] text-white border-[#0075de]'
                : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
            }`}
          >
            {entry.icon}
            <span className="hidden sm:inline">{t(entry.labelKey)}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onCollapseTurnsChange(!collapseTurns)}
        title={t('trajectory.collapseTurns')}
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          collapseTurns
            ? 'bg-[#0075de] text-white border-[#0075de]'
            : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
        }`}
      >
        {collapseTurns ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        <span className="hidden sm:inline">{t('trajectory.turns')}</span>
      </button>

      <button
        type="button"
        onClick={() => onCollapseAssistantChange(!collapseAssistant)}
        title={t('trajectory.collapseSteps')}
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          collapseAssistant
            ? 'bg-[#0075de] text-white border-[#0075de]'
            : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
        }`}
      >
        {collapseAssistant ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        <span className="hidden sm:inline">{t('trajectory.steps')}</span>
      </button>

      <div className="ml-auto flex items-center gap-3 text-xs text-[#615d59]">
        {runSummary ? (
          <>
            <span className={status?.className}>
              {status ? t(status.key) : ''}
              {runSummary.status === 'running' && !runEnded ? ' ●' : ''}
            </span>
            {runSummary.kind ? <span className="text-[#a39e98]">{runSummary.kind}</span> : null}
            {runSummary.detail ? <span className="text-[#a39e98]">{runSummary.detail}</span> : null}
            {runSummary.pages.total > 0 ? (
              <span>
                {t('trajectory.pages', { completed: runSummary.pages.completed, total: runSummary.pages.total })}
                {runSummary.pages.failed > 0 ? (
                  <span className="text-[#e54847]">{t('trajectory.pagesFailed', { count: runSummary.pages.failed })}</span>
                ) : null}
              </span>
            ) : null}
            {runSummary.usage ? (
              <span>
                ↑{formatTokens(runSummary.usage.input_tokens)} ↓{formatTokens(runSummary.usage.output_tokens)}
              </span>
            ) : null}
            {runSummary.durationMs !== undefined ? <span>{formatDurationMs(runSummary.durationMs)}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
});
