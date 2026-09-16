/**
 * TrajectoryToolbar —— 搜索框 / 折叠开关 / 时序模式切换 / 运行状态徽标。
 */

import { Search, ChevronsDownUp, ChevronsUpDown, Clock, ListOrdered, AlignHorizontalDistributeCenter } from 'lucide-react';
import {
  formatDurationMs,
  formatTokens,
  type TrajectoryRunSummary,
  type TrajectoryTimelineMode,
} from '@zread-pi/trajectory';

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

const TIMELINE_MODES: Array<{ mode: TrajectoryTimelineMode; label: string; icon: React.ReactNode }> = [
  { mode: 'sequence', label: 'Sequence', icon: <ListOrdered size={14} /> },
  { mode: 'duration', label: 'Duration', icon: <Clock size={14} /> },
  { mode: 'time', label: 'Time', icon: <AlignHorizontalDistributeCenter size={14} /> },
  { mode: 'actual', label: 'Actual', icon: <Clock size={14} /> },
];

const STATUS_LABELS: Record<TrajectoryRunSummary['status'], { text: string; className: string }> = {
  running: { text: 'Running', className: 'text-[#dd5b00]' },
  completed: { text: 'Completed', className: 'text-[#2a9d99]' },
  failed: { text: 'Failed', className: 'text-[#e54847]' },
  interrupted: { text: 'Interrupted', className: 'text-[#a39e98]' },
  unknown: { text: 'Unknown', className: 'text-[#a39e98]' },
};

export function TrajectoryToolbar({
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
  const status = runSummary ? STATUS_LABELS[runSummary.status] : null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200 bg-[#f6f5f4]">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a39e98]" />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search records (prompt / tool / output / args)…"
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
            title={`${entry.label} mode`}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
              timelineMode === entry.mode
                ? 'bg-[#0075de] text-white border-[#0075de]'
                : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
            }`}
          >
            {entry.icon}
            <span className="hidden sm:inline">{entry.label}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onCollapseTurnsChange(!collapseTurns)}
        title="Collapse turns"
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          collapseTurns
            ? 'bg-[#0075de] text-white border-[#0075de]'
            : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
        }`}
      >
        {collapseTurns ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        <span className="hidden sm:inline">Turns</span>
      </button>

      <button
        type="button"
        onClick={() => onCollapseAssistantChange(!collapseAssistant)}
        title="Collapse consecutive assistant messages"
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
          collapseAssistant
            ? 'bg-[#0075de] text-white border-[#0075de]'
            : 'bg-white text-[#615d59] border-gray-200 hover:bg-[#f6f5f4]'
        }`}
      >
        {collapseAssistant ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        <span className="hidden sm:inline">Steps</span>
      </button>

      <div className="ml-auto flex items-center gap-3 text-xs text-[#615d59]">
        {runSummary ? (
          <>
            <span className={status?.className}>
              {status?.text}
              {runSummary.status === 'running' && !runEnded ? ' ●' : ''}
            </span>
            {runSummary.kind ? <span className="text-[#a39e98]">{runSummary.kind}</span> : null}
            {runSummary.detail ? <span className="text-[#a39e98]">{runSummary.detail}</span> : null}
            {runSummary.pages.total > 0 ? (
              <span>
                pages {runSummary.pages.completed}/{runSummary.pages.total}
                {runSummary.pages.failed > 0 ? (
                  <span className="text-[#e54847]"> ·{runSummary.pages.failed} failed</span>
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
}
