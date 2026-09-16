/**
 * TrajectoryView —— 轨迹检查页的装配层（加载 / 轮询 / 过滤 / 虚拟化 / 检查器）。
 *
 * 数据流：useTrajectoryEvents（原始事件，分页 + 轮询）
 *   → useTrajectoryLayout（replay 折叠 + 搜索索引）
 *   → buildTrajectoryRows（turn / group / cell 行模型 + 过滤 + 折叠）
 *   → useVirtualList（窗口化）+ TrajectoryTable（行渲染）
 *   → TrajectoryInspector（选中记录详情）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { DETAILS_MIN_WIDTH } from '@zread-pi/trajectory';
import type { TrajectoryCellProps, TrajectoryTimelineMode, TrajectoryTurnModel } from '@zread-pi/trajectory';
import { useTrajectoryEvents } from './useTrajectoryEvents';
import { useTrajectoryLayout } from './useTrajectoryLayout';
import { useVirtualList } from './useVirtualList';
import { buildTrajectoryRows, TrajectoryTable } from './TrajectoryTable';
import { TrajectoryTimeline } from './TrajectoryTimeline';
import { TrajectoryToolbar } from './TrajectoryToolbar';
import { TrajectoryInspector } from './TrajectoryInspector';

interface TrajectoryViewProps {
  runId: string | undefined;
}

export function TrajectoryView({ runId }: TrajectoryViewProps) {
  const [query, setQuery] = useState('');
  const [collapseTurns, setCollapseTurns] = useState(false);
  const [collapseAssistant, setCollapseAssistant] = useState(true);
  const [timelineMode, setTimelineMode] = useState<TrajectoryTimelineMode>('duration');
  const [focusIndexes, setFocusIndexes] = useState<ReadonlySet<number> | null>(null);
  const [selectedCell, setSelectedCell] = useState<TrajectoryCellProps | null>(null);
  const [collapsedTurnSet, setCollapsedTurnSet] = useState<Set<number | null>>(new Set());
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_MIN_WIDTH);

  const events = useTrajectoryEvents(runId);
  const layout = useTrajectoryLayout(events.events, query);

  const rows = useMemo(
    () =>
      buildTrajectoryRows(layout.turns, {
        collapseTurns,
        collapsedTurnSet,
        collapseAssistant,
        focusIndexes,
        matchSet: layout.matchSet,
        hasMoreOlder: events.hasMoreOlder,
      }),
    [
      layout.turns,
      layout.matchSet,
      collapseTurns,
      collapsedTurnSet,
      collapseAssistant,
      focusIndexes,
      events.hasMoreOlder,
    ],
  );

  const virtual = useVirtualList(rows);

  // 键盘导航：上下移动选中、Esc 清除
  const selectableIndexes = useMemo(
    () => rows.filter((row) => row.kind === 'cell' && row.cell !== undefined).map((row) => row.cell!.index),
    [rows],
  );

  const selectByIndex = useCallback(
    (cellIndex: number | null) => {
      if (cellIndex === null) {
        setSelectedCell(null);
        return;
      }
      const rowOffset = rows.findIndex((row) => row.kind === 'cell' && row.cell?.index === cellIndex);
      if (rowOffset === -1) return;
      setSelectedCell(rows[rowOffset]!.cell ?? null);
      virtual.scrollToIndex(rowOffset);
    },
    [rows, virtual],
  );

  // 选中记录在过滤 / 折叠变化后仍指向同一个记录 id
  const selectedCellResolved = useMemo(() => {
    if (selectedCell === null) return null;
    const found = rows.find((row) => row.cell?.recordId === selectedCell.recordId);
    return found?.cell ?? null;
  }, [rows, selectedCell]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (selectedCellResolved === null) {
        if (event.key === 'ArrowDown' && selectableIndexes.length > 0) {
          event.preventDefault();
          selectByIndex(selectableIndexes[0] ?? null);
        }
        return;
      }
      const position = selectableIndexes.indexOf(selectedCellResolved.index);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = selectableIndexes[position + 1];
        if (next !== undefined) selectByIndex(next);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const previous = selectableIndexes[position - 1];
        if (previous !== undefined) selectByIndex(previous);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        selectByIndex(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedCellResolved, selectableIndexes, selectByIndex]);

  const handleToggleTurn = useCallback((turn: number | null) => {
    setCollapsedTurnSet((current) => {
      const next = new Set(current);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  }, []);

  const handleSelectSeq = useCallback(
    (seq: number) => {
      const candidate = rows.find((row) => row.cell?.sourceSeq === seq);
      if (candidate?.cell !== undefined) selectByIndex(candidate.cell.index);
    },
    [rows, selectByIndex],
  );

  const selectedIndexes = useMemo(
    () => new Set(selectedCellResolved === null ? [] : [selectedCellResolved.index]),
    [selectedCellResolved],
  );

  if (events.status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Loader2 className="animate-spin text-[#0075de]" size={20} />
        <span className="ml-2 text-sm text-[#615d59]">Loading trajectory…</span>
      </div>
    );
  }

  if (events.status === 'not-found') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white">
        <p className="text-sm text-[#615d59]">Run not found or no events recorded yet.</p>
        <Link to="/" className="text-sm text-[#0075de] hover:underline">
          Back to wiki
        </Link>
      </div>
    );
  }

  if (events.status === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white">
        <p className="text-sm text-[#e54847]">Failed to load run events</p>
        {events.errorMessage !== undefined ? (
          <p className="max-w-md text-xs text-[#615d59]">{events.errorMessage}</p>
        ) : null}
        <button
          type="button"
          onClick={() => void events.reload()}
          className="text-sm text-[#0075de] hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const headerRun = layout.runSummary;

  return (
    <div className="flex h-screen flex-col bg-white">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-200">
        <Link to="/" className="flex items-center gap-1 text-sm text-[#615d59] hover:text-[#0075de]">
          <ArrowLeft size={14} />
          Wiki
        </Link>
        <h1 className="text-sm font-semibold text-[#31302e]">
          Trajectory
          {runId !== undefined ? <span className="ml-2 font-mono text-xs text-[#a39e98]">{runId}</span> : null}
        </h1>
        {headerRun?.startedAt !== undefined ? (
          <span className="text-xs text-[#a39e98]">
            {new Date(headerRun.startedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      <TrajectoryToolbar
        query={query}
        onQueryChange={setQuery}
        matchCount={layout.matchSet?.size ?? 0}
        collapseTurns={collapseTurns || collapsedTurnSet.size > 0}
        onCollapseTurnsChange={(collapsed) => {
          setCollapseTurns(collapsed);
          if (!collapsed) setCollapsedTurnSet(new Set());
        }}
        collapseAssistant={collapseAssistant}
        onCollapseAssistantChange={setCollapseAssistant}
        timelineMode={timelineMode}
        onTimelineModeChange={setTimelineMode}
        runSummary={headerRun}
        runEnded={events.runEnded}
      />

      <TrajectoryTimeline
        turns={layout.turns as TrajectoryTurnModel[]}
        mode={timelineMode}
        focusIndexes={focusIndexes}
        onFocusChange={setFocusIndexes}
        selectedIndexes={selectedIndexes}
        onSelectIndex={selectByIndex}
      />

      <div className="flex flex-1 min-h-0">
        <TrajectoryTable
          rows={rows}
          startIndex={virtual.startIndex}
          endIndex={virtual.endIndex}
          topHeight={virtual.topHeight}
          bottomHeight={virtual.bottomHeight}
          totalHeight={virtual.totalHeight}
          scrollTop={virtual.scrollTop}
          selectedIndex={selectedCellResolved?.index ?? null}
          matchSet={layout.matchSet}
          collapsedTurns={collapseTurns}
          onToggleTurn={handleToggleTurn}
          onSelectCell={setSelectedCell}
          onLoadOlder={() => void events.loadOlder()}
          onScroll={virtual.onScroll}
          containerRef={virtual.containerRef}
        />
        <TrajectoryInspector
          cell={selectedCellResolved}
          requests={layout.requests}
          onSelectSeq={handleSelectSeq}
          width={detailsWidth}
          onWidthChange={setDetailsWidth}
        />
      </div>
    </div>
  );
}
