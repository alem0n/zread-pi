/**
 * useTrajectoryLayout —— 事件流 → 展示模型的派生（replay → layout → 请求编号 → 搜索索引）。
 *
 * 折叠在客户端完成（对齐 dsh）：服务端只给原始事件。
 * 搜索索引按「领先 + 尾随」节流提交（SEARCH_INDEX_THROTTLE_MS），匹配集合在提交后刷新；
 * 纯尾随会在运行中的 run 上饿死（每轮轮询都重置定时器）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TrajectorySearchIndex,
  appendTrajectoryPartialLayout,
  deriveTrajectoryLayout,
  replayRunEvents,
  replayRun,
  SEARCH_INDEX_THROTTLE_MS,
  type SessionFacts,
  type TrajectoryRequestNumber,
  type TrajectoryRunSummary,
  type TrajectoryTurnModel,
} from '@zread-pi/trajectory';
import type { RunEvent } from '@zread-pi/types';

export interface TrajectoryLayoutResult {
  turns: readonly TrajectoryTurnModel[];
  requests: readonly TrajectoryRequestNumber[];
  runSummary: TrajectoryRunSummary;
  /** 搜索匹配的记录 id 集合（null = 无查询） */
  matchSet: ReadonlySet<string> | null;
  /** 布局版本（每次派生变化 +1；虚拟化 / 滚动锚定用） */
  version: number;
}

export function useTrajectoryLayout(
  events: RunEvent[],
  query: string,
  partialThrottle: boolean = true,
  sessions: SessionFacts[] = [],
): TrajectoryLayoutResult {
  const [matchSet, setMatchSet] = useState<ReadonlySet<string> | null>(null);
  const [indexVersion, setIndexVersion] = useState(0);
  const indexRef = useRef(new TrajectorySearchIndex());

  // ① replay：事件 → 快照（记录 / 请求 / 进行中的消息 / run 摘要）
  // 有会话事实时走方案 C 路径（会话 = 内容事实源，事件只做时序/计量骨架）；
  // 旧 run 无会话 → 回退纯事件 replay。
  const snapshot = useMemo(
    () => (sessions.length > 0 ? replayRun({ events, sessions }) : replayRunEvents(events)),
    [events, sessions],
  );

  // ② layout：快照 → turn / group / cell（含流式 partial 的追加）
  const baseTurns = useMemo(() => deriveTrajectoryLayout(snapshot), [snapshot]);
  // partial 的续号由模型层遍历现有布局推导（不在调用侧把全量索引展开成参数栈）
  const turns = useMemo(
    () => (snapshot.partial === null ? baseTurns : appendTrajectoryPartialLayout(baseTurns, snapshot.partial)),
    [baseTurns, snapshot.partial],
  );

  // ③ 搜索索引：「领先 + 尾随」节流（leading & trailing throttle）。
  //  纯尾随（debounce）在事件高频到达（运行中每 1.5s 一轮轮询）时会饿死——
  //  每次 turns 变化都重置定时器，匹配集合永远不刷新。领先沿保证首屏立即可用，
  //  尾随保证流式期间最多每 SEARCH_INDEX_THROTTLE_MS 重建一次。
  const lastFlushAtRef = useRef(0);
  useEffect(() => {
    const flush = (): void => {
      indexRef.current.update([turns]);
      setIndexVersion((current) => current + 1);
    };
    if (!partialThrottle) {
      flush();
      return;
    }
    const now = Date.now();
    const elapsed = now - lastFlushAtRef.current;
    if (elapsed >= SEARCH_INDEX_THROTTLE_MS) {
      lastFlushAtRef.current = now;
      flush();
      return;
    }
    const timer = setTimeout(() => {
      lastFlushAtRef.current = Date.now();
      flush();
    }, SEARCH_INDEX_THROTTLE_MS - elapsed);
    return () => {
      clearTimeout(timer);
    };
  }, [turns, partialThrottle]);

  // ④ 匹配集合（查询为空 → null = 不过滤）
  useEffect(() => {
    if (query.trim() === '') {
      setMatchSet(null);
      return;
    }
    setMatchSet(indexRef.current.search(query));
  }, [query, indexVersion]);

  const requests = snapshot.requests;
  const runSummary = snapshot.runSummary;

  return useMemo(
    () => ({
      turns,
      requests,
      runSummary,
      matchSet,
      version: indexVersion,
    }),
    [turns, requests, runSummary, matchSet, indexVersion],
  );
}

/** 在 turns 中查找指定记录 id 的序号（检查器的「跳转到记录」用） */
export function findCellIndex(
  turns: readonly TrajectoryTurnModel[],
  recordId: string,
): { turnIndex: number; groupIndex: number; cellIndex: number } | null {
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    if (turn === undefined) continue;
    for (let groupIndex = 0; groupIndex < turn.groups.length; groupIndex++) {
      const group = turn.groups[groupIndex];
      if (group === undefined) continue;
      for (let cellIndex = 0; cellIndex < group.cells.length; cellIndex++) {
        if (group.cells[cellIndex]?.recordId === recordId) {
          return { turnIndex, groupIndex, cellIndex };
        }
      }
    }
  }
  return null;
}

/** 按 seq 查找最近的请求（检查器导航用） */
export function findRequestBySeq(
  requests: readonly TrajectoryRequestNumber[],
  seq: number | undefined,
): TrajectoryRequestNumber | undefined {
  if (seq === undefined) return undefined;
  return requests.find((request) => request.seq === seq);
}

export const trajectoryLayoutHelpers = {
  findCellIndex,
  findRequestBySeq,
};
