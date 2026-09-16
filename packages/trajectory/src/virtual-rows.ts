/**
 * 虚拟行投影：稳定 key + 视口窗口 + 有界 overscan（自写窗口数学，不引入新依赖）。
 * 移植自 dsh ui-trajectory/src/client/trajectory-virtual-rows.ts。
 */

import type { TrajectoryCellProps } from './types.js';
import { trajectoryRecordId } from './types.js';

const CONTENT_ROW_HEIGHT = 30;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps;
  collapsedSummaryKind?: 'turn' | 'assistant';
}

export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
  logicalIndex: number;
  record: T;
}

export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[];
  height: number;
  key: string;
}

export function trajectoryVirtualRecordKey(record: VirtualizableTrajectoryRecord): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell));
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`;
}

/**
 * 把「仅请求分隔点」的记录挂到下一个内容行，虚拟化器永远不会持有零高条目。
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = [];
  let pending: TrajectoryVirtualRowEntry<T>[] = [];

  for (const [logicalIndex, record] of records.entries()) {
    const entry = { logicalIndex, record };
    if (record.cell.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height:
        record.collapsedSummaryKind === undefined ? CONTENT_ROW_HEIGHT : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    });
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((candidate) => trajectoryVirtualRecordKey(candidate.record)).join('|'),
    });
  }

  return rows;
}

/**
 * 计算视口窗口：返回 [startIndex, endIndex] 与上下 spacer 高度。
 */
export function trajectoryViewportWindow(
  rows: readonly { height: number }[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { startIndex: number; endIndex: number; topHeight: number; bottomHeight: number } {
  if (rows.length === 0) {
    return { startIndex: 0, endIndex: 0, topHeight: 0, bottomHeight: 0 };
  }

  let startIndex = 0;
  let topHeight = 0;
  for (let index = 0; index < rows.length; index++) {
    const height = rows[index]?.height ?? 0;
    if (topHeight + height > scrollTop) {
      startIndex = index;
      break;
    }
    topHeight += height;
    startIndex = index + 1;
  }

  let endIndex = Math.min(rows.length, startIndex + 1);
  let used = 0;
  for (let index = startIndex; index < rows.length; index++) {
    const height = rows[index]?.height ?? 0;
    if (used >= viewportHeight) {
      endIndex = index;
      break;
    }
    used += height;
    endIndex = index + 1;
  }
  // 有界 overscan：向两侧扩展（不超出边界）
  const start = Math.max(0, startIndex - overscan);
  const end = Math.min(rows.length, endIndex + overscan);

  let top = 0;
  for (let index = 0; index < start; index++) top += rows[index]?.height ?? 0;
  let bottom = 0;
  for (let index = end; index < rows.length; index++) bottom += rows[index]?.height ?? 0;

  return { startIndex: start, endIndex: end, topHeight: top, bottomHeight: bottom };
}

/** 全部行的总高度 */
export function trajectoryTotalHeight(rows: readonly { height: number }[]): number {
  return rows.reduce((total, row) => total + row.height, 0);
}
