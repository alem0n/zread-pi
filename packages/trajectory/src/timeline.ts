/**
 * 时序投影（Overview 三泳道）：sequence / duration / time / actual 四种模式。
 * 移植自 dsh ui-trajectory/src/client/timeline.ts，输入改为本包的 TrajectoryTurnModel。
 */

import { formatDurationMillis } from './format.js';
import type { TrajectoryCellKind, TrajectoryCellProps, TrajectoryTurnModel } from './types.js';

export type TrajectoryTimelineMode = 'sequence' | 'duration' | 'time' | 'actual';

export interface TrajectoryTimeRange {
  start: number;
  end: number;
}

export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number;
  isError: boolean;
  kind: TrajectoryCellKind;
  label: string;
  lane: number;
}

export interface TrajectoryTimelineTurnBoundary {
  turn: number;
  time: number;
}

export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[];
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

export function formatTimelineOffset(milliseconds: number): string {
  return formatDurationMillis(milliseconds);
}

function laneFor(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2;
  if (kind === 'message' || kind === 'compacted') return 1;
  return 0;
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  if (!finite(cell.startedAt)) return null;
  const durationMs = finite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1_000) : 0;
  return { start: cell.startedAt, end: cell.startedAt + durationMs };
}

export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = 'sequence',
): TrajectoryTimelineModel | null {
  if (mode !== 'sequence') {
    return deriveTimedTimeline(turns, mode === 'duration' || mode === 'actual', mode === 'duration');
  }
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];

  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) =>
      group.cells.filter((cell) => cell.requestOnly !== true),
    );
    if (cells.length === 0) continue;
    if (turn.turn !== null) {
      turnBoundaries.push({ turn: turn.turn, time: spans.length });
    }
    spans.push(
      ...cells.map(
        (cell, offset): TrajectoryTimelineSpan => ({
          start: spans.length + offset,
          end: spans.length + offset + 1,
          index: cell.index,
          isError: cell.isError === true,
          kind: cell.kind,
          label: cell.text,
          lane: laneFor(cell.kind),
        }),
      ),
    );
  }

  if (spans.length === 0) return null;
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

function deriveTimedTimeline(
  turns: readonly TrajectoryTurnModel[],
  actualDuration: boolean,
  compressIdle: boolean,
): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap(
      (group): TrajectoryTimelineSpan[] =>
        group.cells.flatMap((cell) => {
          if (cell.requestOnly === true) return [];
          const range = cellRange(cell);
          return range === null
            ? []
            : [
                {
                  ...range,
                  index: cell.index,
                  isError: cell.isError === true,
                  kind: cell.kind,
                  label: cell.text,
                  lane: laneFor(cell.kind),
                },
              ];
        }),
    );
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (rawSpans.length === 0) return null;

  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  // 极值用循环而非 Math.min/max(...spread)：一次 run 的 span 数可达数万，
  // 展开参数栈既有引擎上限风险，也多分配一个中间数组（每轮流式 tick 都跑）。
  let rangeStart = Number.POSITIVE_INFINITY;
  let rangeEnd = Number.NEGATIVE_INFINITY;
  for (const turn of timedTurns) {
    let turnStart = Number.POSITIVE_INFINITY;
    for (const span of turn.rawSpans) {
      const offset = removedIdleBySpan.get(span) ?? 0;
      const start = span.start - offset;
      const end = (actualDuration ? span.end : span.start) - offset;
      const projected: TrajectoryTimelineSpan = { ...span, start, end };
      spans.push(projected);
      if (start < rangeStart) rangeStart = start;
      if (end > rangeEnd) rangeEnd = end;
      if (start < turnStart) turnStart = start;
    }
    if (turn.turn !== null && turn.rawSpans.length > 0) {
      turnBoundaries.push({ turn: turn.turn, time: turnStart });
    }
  }

  return {
    start: rangeStart,
    end: rangeEnd,
    spans,
    turnBoundaries,
  };
}

export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = 'sequence',
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}
