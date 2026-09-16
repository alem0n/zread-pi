/**
 * TrajectoryTable —— 事件台账（turn / group / cell 的窗口化列表）。
 *
 * 行模型：turn 头 / group 头 / 记录行 / 折叠摘要 / 「加载更旧」控件。
 * 过滤：时间线选区（focusIndexes）+ 搜索匹配（matchSet）。
 * 折叠：turn 级（每个 turn 一行摘要）/ assistant 级（同组连续 message 合并）。
 */

import { memo, useCallback, useMemo } from 'react';
import { Eye } from 'lucide-react';
import {
  formatDurationMs,
  formatPercent,
  formatTokens,
  cacheHitRatio,
  trajectoryVirtualRecordKey,
  type TrajectoryCellProps,
  type TrajectoryTurnModel,
} from '@zread-pi/trajectory';
import { useT, type TranslateFn } from '@/i18n/I18nContext';

export type RowKind = 'turn-header' | 'group-header' | 'cell' | 'collapsed-turn' | 'load-older';

export interface TrajectoryRow {
  kind: RowKind;
  key: string;
  height: number;
  turn?: TrajectoryTurnModel;
  group?: TrajectoryTurnModel['groups'][number];
  cell?: TrajectoryCellProps;
  collapsedCount?: number;
}

const ROW_HEIGHTS: Record<RowKind, number> = {
  'turn-header': 34,
  'group-header': 26,
  cell: 30,
  'collapsed-turn': 22,
  'load-older': 32,
};

interface BuildRowsOptions {
  /** 全局折叠所有 turn */
  collapseTurns: boolean;
  /** 单独收起的 turn 序号集合（null = turn 之间的独立段） */
  collapsedTurnSet: ReadonlySet<number | null>;
  collapseAssistant: boolean;
  focusIndexes: ReadonlySet<number> | null;
  matchSet: ReadonlySet<string> | null;
  hasMoreOlder: boolean;
  /** 文案翻译（轮次标题 / 折叠摘要等前端文案走它） */
  t: TranslateFn;
}

/** 折叠态的 turn：只保留头部 + 一条摘要行 */
function buildCollapsedSummary(turn: TrajectoryTurnModel, t: TranslateFn): TrajectoryRow {
  const cells = turn.groups.flatMap((group) => group.cells);
  const tools = cells.filter((cell) => cell.kind === 'tool');
  const duration = cells.reduce((total, cell) => total + (cell.timeSeconds ?? 0), 0);
  return {
    kind: 'collapsed-turn',
    key: `collapsed:${turn.turn === null ? 'standalone' : turn.turn}`,
    height: ROW_HEIGHTS['collapsed-turn'],
    collapsedCount: cells.length,
    turn,
    cell: cells[0],
    group: {
      title: t('trajectory.recordsCount', { count: cells.length }),
      description:
        tools.length > 0
          ? t('trajectory.collapsedTools', { ms: Math.round(duration * 1000), count: tools.length })
          : t('trajectory.collapsedDuration', { ms: Math.round(duration * 1000) }),
      cells: [],
    },
  };
}

export function buildTrajectoryRows(
  turns: readonly TrajectoryTurnModel[],
  options: BuildRowsOptions,
): TrajectoryRow[] {
  const rows: TrajectoryRow[] = [];
  const { collapseTurns, collapsedTurnSet, collapseAssistant, focusIndexes, matchSet, hasMoreOlder, t } = options;

  for (const turn of turns) {
    const turnHasFocus =
      focusIndexes === null || turn.groups.some((group) => group.cells.some((cell) => focusIndexes.has(cell.index)));
    const turnHasMatch =
      matchSet === null || turn.groups.some((group) => group.cells.some((cell) => matchSet.has(cell.recordId ?? '')));

    if (!turnHasFocus || !turnHasMatch) continue;

    const isCollapsed = collapseTurns || collapsedTurnSet.has(turn.turn);

    rows.push({
      kind: 'turn-header',
      key: `turn:${turn.turn === null ? 'standalone' : turn.turn}`,
      height: ROW_HEIGHTS['turn-header'],
      turn,
    });

    if (isCollapsed) {
      rows.push(buildCollapsedSummary(turn, t));
      continue;
    }

    for (const group of turn.groups) {
      const groupCells: TrajectoryCellProps[] = [];
      for (const cell of group.cells) {
        if (focusIndexes !== null && !focusIndexes.has(cell.index)) continue;
        if (matchSet !== null && !matchSet.has(cell.recordId ?? '')) continue;
        groupCells.push(cell);
      }
      if (groupCells.length === 0) continue;

      rows.push({
        kind: 'group-header',
        key: `group:${turn.turn === null ? 'standalone' : turn.turn}:${group.title}`,
        height: ROW_HEIGHTS['group-header'],
        group,
        turn,
      });

      // assistant 折叠：同组内连续的 message 合并成一条（保留最后一条 + 计数）
      const emitted: TrajectoryCellProps[] = [];
      let pending: TrajectoryCellProps[] = [];
      const flushPending = (): void => {
        if (pending.length === 0) return;
        const last = pending[pending.length - 1]!;
        emitted.push(pending.length > 1 ? { ...last, text: `${last.text} ×${pending.length}` } : last);
        pending = [];
      };
      for (const cell of groupCells) {
        if (collapseAssistant && cell.kind === 'message') {
          pending.push(cell);
          continue;
        }
        flushPending();
        emitted.push(cell);
      }
      flushPending();

      for (const cell of emitted) {
        rows.push({
          kind: 'cell',
          key: trajectoryVirtualRecordKey({ cell }),
          height: ROW_HEIGHTS.cell,
          cell,
          group,
          turn,
        });
      }
    }
  }

  if (hasMoreOlder) {
    rows.unshift({ kind: 'load-older', key: 'load-older', height: ROW_HEIGHTS['load-older'] });
  }

  return rows;
}

const KIND_BADGES: Record<TrajectoryCellProps['kind'], { label: string; className: string }> = {
  system: { label: 'SYS', className: 'text-[#a39e98]' },
  user: { label: 'USER', className: 'text-[#615d59]' },
  context: { label: 'CTX', className: 'text-[#615d59]' },
  compacted: { label: 'CMP', className: 'text-[#a39e98]' },
  message: { label: 'MSG', className: 'text-[#0075de]' },
  tool: { label: 'TOOL', className: 'text-[#2a9d99]' },
  subtool: { label: 'SUB', className: 'text-[#2a9d99]' },
};

interface TrajectoryTableProps {
  rows: TrajectoryRow[];
  startIndex: number;
  endIndex: number;
  topHeight: number;
  bottomHeight: number;
  totalHeight: number;
  scrollTop: number;
  selectedIndex: number | null;
  matchSet: ReadonlySet<string> | null;
  collapsedTurns: boolean;
  onToggleTurn: (turn: number | null) => void;
  onToggleSession?: (sessionId: string | undefined) => void;
  onSelectCell: (cell: TrajectoryCellProps) => void;
  onLoadOlder: () => void;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/** 滚动位置上方最近的 turn 头（用于单条 sticky 条，避免多个 sticky header 重叠） */
function activeTurnHeader(rows: TrajectoryRow[], scrollTop: number): { row: TrajectoryRow; offset: number } | null {
  let active: { row: TrajectoryRow; offset: number } | null = null;
  let offset = 0;
  for (const row of rows) {
    // 严格在视口顶之上才需要 sticky 条（否则与仍在视口内的表头重复渲染）
    if (row.kind === 'turn-header' && offset < scrollTop) active = { row, offset };
    if (offset >= scrollTop) break;
    offset += row.height;
  }
  return active;
}

export const TrajectoryTable = memo(function TrajectoryTable({
  rows,
  startIndex,
  endIndex,
  topHeight,
  bottomHeight,
  totalHeight,
  scrollTop,
  selectedIndex,
  matchSet,
  collapsedTurns,
  onToggleTurn,
  onToggleSession,
  onSelectCell,
  onLoadOlder,
  onScroll,
  containerRef,
}: TrajectoryTableProps) {
  const t = useT();
  const visible = useMemo(() => rows.slice(startIndex, endIndex), [rows, startIndex, endIndex]);

  const renderRow = useCallback(
    (row: TrajectoryRow, absoluteIndex: number): React.ReactNode => {
      if (row.kind === 'load-older') {
        return (
          <div key={row.key} style={{ height: row.height }} className="flex items-center">
            <button
              type="button"
              onClick={onLoadOlder}
              className="mx-auto text-xs text-[#0075de] hover:underline"
            >
              {t('trajectory.loadOlder')}
            </button>
          </div>
        );
      }

      if (row.kind === 'turn-header' && row.turn !== undefined) {
        const turn = row.turn;
        const cells = turn.groups.flatMap((group) => group.cells);
        const label =
          turn.turn === null
            ? t('trajectory.betweenTurns')
            : t('trajectory.turnLabel', { turn: turn.turn, label: turn.label });
        return (
          <div
            key={row.key}
            style={{ height: row.height }}
            className="flex items-center gap-2 px-3 bg-[#f6f5f4] border-b border-gray-200 cursor-pointer hover:bg-[#ecebe9]"
            onClick={() => onToggleTurn(turn.turn)}
            role="button"
            tabIndex={0}
          >
            <span className="text-xs font-semibold text-[#31302e] truncate">{label}</span>
            <span className="text-[10px] text-[#a39e98]">
              {t('trajectory.recordsCount', { count: cells.length })}
            </span>
            {/* 隐藏此会话：从台账与时间线移除（点击表头本身是折叠 / 展开 turn） */}
            {turn.turn !== null ? (
              <button
                type="button"
                title={t('trajectory.hideSession')}
                aria-label={t('trajectory.hideSession')}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSession?.(turn.sessionId);
                }}
                className="ml-auto p-0.5 rounded text-[#a39e98] hover:text-[#0075de] hover:bg-white"
              >
                <Eye size={12} />
              </button>
            ) : null}
          </div>
        );
      }

      if (row.kind === 'group-header' && row.group !== undefined) {
        return (
          <div
            key={row.key}
            style={{ height: row.height }}
            className="flex items-center gap-2 px-3 pl-5 bg-white"
          >
            <span className="text-[11px] font-medium text-[#615d59]">{row.group.title}</span>
            {row.group.description !== undefined ? (
              <span className="text-[10px] text-[#a39e98]">· {row.group.description}</span>
            ) : null}
          </div>
        );
      }

      if (row.kind === 'collapsed-turn') {
        return (
          <div
            key={row.key}
            style={{ height: row.height }}
            className="flex items-center gap-2 px-3 pl-5 text-xs text-[#615d59] italic cursor-pointer hover:bg-[#f6f5f4]"
            onClick={() => row.turn !== undefined && onToggleTurn(row.turn.turn)}
            role="button"
            tabIndex={0}
          >
            <span>{row.group?.title}</span>
            {row.group?.description !== undefined ? <span className="text-[#a39e98]">· {row.group.description}</span> : null}
          </div>
        );
      }

      const cell = row.cell;
      if (cell === undefined) return null;
      const badge = KIND_BADGES[cell.kind];
      const isSelected = selectedIndex === cell.index;
      const isMatch = matchSet?.has(cell.recordId ?? '') ?? false;
      const usage = [cell.input, cell.output].some((value) => value !== undefined)
        ? `↑${formatTokens(cell.input)} ↓${formatTokens(cell.output)}`
        : null;
      const cache = cell.cacheRead !== undefined && cell.cacheRead > 0
        ? formatPercent(cacheHitRatio({ input: cell.input, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite }))
        : null;

      return (
        <div
          key={row.key}
          style={{ height: row.height }}
          className={`flex items-center gap-2 px-3 cursor-pointer ${
            isSelected ? 'bg-[#0075de]/10' : absoluteIndex % 2 === 0 ? 'bg-white' : 'bg-[#fafafa]'
          } hover:bg-[#f6f5f4]`}
          onClick={() => onSelectCell(cell)}
          role="button"
          tabIndex={0}
        >
          <span className="text-[10px] font-mono w-8 shrink-0 text-[#a39e98]">#{cell.index}</span>
          <span className={`text-[10px] font-mono w-9 shrink-0 ${badge.className}`}>{badge.label}</span>
          <span
            className={`flex-1 min-w-0 truncate text-xs ${
              cell.isError ? 'text-[#e54847]' : 'text-[#31302e]'
            } ${isMatch && !isSelected ? 'bg-[#0075de]/20 rounded px-0.5' : ''}`}
          >
            {cell.text || cell.result || t('trajectory.emptyRecord')}
          </span>
          {cache !== null ? <span className="text-[10px] text-[#a39e98] shrink-0">{cache}</span> : null}
          {usage !== null ? <span className="text-[10px] text-[#615d59] shrink-0 font-mono">{usage}</span> : null}
          {cell.timeSeconds !== null && cell.timeSeconds !== undefined ? (
            <span className="text-[10px] text-[#a39e98] shrink-0 font-mono">
              {formatDurationMs(cell.timeSeconds * 1000)}
            </span>
          ) : null}
        </div>
      );
    },
    [collapsedTurns, matchSet, onLoadOlder, onSelectCell, onToggleTurn, onToggleSession, selectedIndex, t],
  );

  if (totalHeight === 0) {
    return (
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto bg-white">
        <div className="p-4 text-sm text-[#615d59]">{t('trajectory.noRecords')}</div>
      </div>
    );
  }

  const sticky = activeTurnHeader(rows, scrollTop);
  const stickyTurn = sticky?.row.kind === 'turn-header' ? sticky.row.turn : undefined;
  // 表头已完全滚出视口顶时才显示 sticky 条（部分可见时沿用文档流里的表头）
  const stickyVisible = sticky !== null && sticky.offset + sticky.row.height <= scrollTop;
  const stickyMeta =
    sticky !== null && stickyTurn !== undefined && stickyVisible
      ? { key: sticky.row.key, height: sticky.row.height, turn: stickyTurn }
      : null;

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto bg-white"
      onScroll={onScroll}
    >
      <div style={{ height: topHeight }} />
      {stickyMeta !== null ? (
        <div
          key={`sticky-${stickyMeta.key}`}
          style={{ height: stickyMeta.height }}
          className="sticky top-0 z-[1] flex items-center gap-2 px-3 bg-[#f6f5f4] border-b border-gray-200 cursor-pointer hover:bg-[#ecebe9]"
          onClick={() => onToggleTurn(stickyMeta.turn.turn)}
          role="button"
          tabIndex={0}
        >
          <span className="text-xs font-semibold text-[#31302e] truncate">
            {stickyMeta.turn.turn === null
              ? t('trajectory.betweenTurns')
              : t('trajectory.turnLabel', { turn: stickyMeta.turn.turn, label: stickyMeta.turn.label })}
          </span>
          <span className="text-[10px] text-[#a39e98]">
            {t('trajectory.recordsCount', {
              count: stickyMeta.turn.groups.reduce((total, group) => total + group.cells.length, 0),
            })}
          </span>
          {stickyMeta.turn.turn !== null ? (
            <button
              type="button"
              title={t('trajectory.hideSession')}
              aria-label={t('trajectory.hideSession')}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSession?.(stickyMeta.turn.sessionId);
              }}
              className="ml-auto p-0.5 rounded text-[#a39e98] hover:text-[#0075de] hover:bg-white"
            >
              <Eye size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {visible.map((row, offset) => renderRow(row, startIndex + offset))}
      <div style={{ height: bottomHeight }} />
    </div>
  );
});
