/**
 * useTrajectoryEvents —— 单次运行的事件流加载（向前分页 + 运行中尾随轮询）。
 *
 * - 缺省 runId = 最近一次运行（先查 /api/runs 再加载）；
 * - 初始加载最新一页（limit 条）；
 * - `loadOlder()` 向前分页（prepend 旧页）；
 * - 运行未结束时按 pollIntervalMs 轮询 `afterSeq`（尾随），结束后停止；
 * - 未知 runId / 接口失败 → error（含 404 判定）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { trajectoryApi, type EventsResponse } from './api';
import type { RunEvent } from '@zread-pi/types';

export type TrajectoryLoadStatus = 'loading' | 'ready' | 'not-found' | 'error';

export interface TrajectoryEventsState {
  status: TrajectoryLoadStatus;
  errorMessage?: string;
  /** 实际加载的 runId（缺省 runId 时由最近一次运行解析得到） */
  resolvedRunId?: string;
  events: RunEvent[];
  /** 是否还有更旧的事件可加载 */
  hasMoreOlder: boolean;
  /** 运行是否已结束（结束 = 停止轮询） */
  runEnded: boolean;
  /** 服务端已知的最大 seq（轮询对齐用） */
  lastSeq: number;
  loadOlder: () => Promise<void>;
  /** 手动刷新一次（出错恢复用） */
  reload: () => Promise<void>;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { response?: { status?: number } };
  return candidate.response?.status === 404;
}

function sortBySeq(events: RunEvent[]): RunEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq);
}

export function useTrajectoryEvents(
  runId: string | undefined,
  options: { limit?: number; pollIntervalMs?: number } = {},
): TrajectoryEventsState {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [status, setStatus] = useState<TrajectoryLoadStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [resolvedRunId, setResolvedRunId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [runEnded, setRunEnded] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);

  const eventsRef = useRef<RunEvent[]>([]);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const applyResponse = useCallback(
    (response: EventsResponse, mode: 'initial' | 'older' | 'newer', previousHasMoreOlder: boolean) => {
      setEvents((previous) => {
        if (mode === 'initial') return sortBySeq(response.events);
        if (mode === 'older') return sortBySeq([...previous, ...response.events]);
        // newer：去重后排序（轮询窗口与已有事件可能有重叠）
        const known = new Set(previous.map((event) => event.seq));
        return sortBySeq([...previous, ...response.events.filter((event) => !known.has(event.seq))]);
      });
      setHasMoreOlder(mode === 'newer' ? previousHasMoreOlder : response.hasMore);
      setHasNewer(response.hasNewer);
      setRunEnded(response.runEnded);
      setLastSeq(response.lastSeq);
    },
    [],
  );

  const loadInitial = useCallback(
    async (id: string): Promise<void> => {
      setStatus('loading');
      setErrorMessage(undefined);
      try {
        const response = await trajectoryApi.getEvents(id, { limit });
        setResolvedRunId(id);
        applyResponse(response, 'initial', false);
        setStatus('ready');
      } catch (error) {
        if (isNotFoundError(error)) {
          setStatus('not-found');
        } else {
          setStatus('error');
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [applyResponse, limit],
  );

  // 初始加载：有 runId 直接加载；缺省时解析最近一次运行
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setErrorMessage(undefined);
    if (runId !== undefined) {
      void loadInitial(runId);
      return () => {
        cancelled = true;
      };
    }
    trajectoryApi
      .listRuns()
      .then((response) => {
        if (cancelled) return;
        const latest = response.runs[0]?.id;
        if (latest === undefined) {
          setStatus('not-found');
          return;
        }
        void loadInitial(latest);
      })
      .catch((error) => {
        if (cancelled) return;
        if (isNotFoundError(error)) {
          setStatus('not-found');
        } else {
          setStatus('error');
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, loadInitial]);

  // 续页：首屏只取了开头一页，剩余事件按 afterSeq 续完（已结束的 run 也要续，
  // 否则看不到后半段）。续页未完成前不启动实时轮询，避免重复请求。
  useEffect(() => {
    if (resolvedRunId === undefined || status !== 'ready' || !hasNewer) return;
    const token = { cancelled: false };
    void (async (): Promise<void> => {
      try {
        const maxSeq = eventsRef.current.reduce((max, event) => Math.max(max, event.seq), 0);
        const response = await trajectoryApi.getEvents(resolvedRunId, { afterSeq: maxSeq, limit });
        if (token.cancelled) return;
        applyResponse(response, 'newer', hasMoreOlderRef.current);
      } catch {
        // 续页失败保留已加载部分（reload 可恢复）
      }
    })();
    return () => {
      token.cancelled = true;
    };
  }, [resolvedRunId, status, hasNewer, limit, applyResponse]);

  // 运行中轮询（尾随；续页未完成时由上面的 effect 接管，不重复请求）
  useEffect(() => {
    if (resolvedRunId === undefined || status !== 'ready' || runEnded || hasNewer) return;
    const token = { cancelled: false };

    const poll = async (): Promise<void> => {
      if (token.cancelled) return;
      try {
        const maxSeq = eventsRef.current.reduce((max, event) => Math.max(max, event.seq), 0);
        const response = await trajectoryApi.getEvents(resolvedRunId, { afterSeq: maxSeq, limit });
        if (token.cancelled) return;
        applyResponse(response, 'newer', hasMoreOlderRef.current);
      } catch {
        // 单次轮询失败不改变整体状态（下一轮会重试）
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    return () => {
      token.cancelled = true;
      clearInterval(timer);
    };
  }, [resolvedRunId, status, runEnded, hasNewer, pollIntervalMs, applyResponse]);

  const hasMoreOlderRef = useRef(false);
  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder;
  }, [hasMoreOlder]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (resolvedRunId === undefined || !hasMoreOlder) return;
    const minSeq = eventsRef.current.reduce((min, event) => Math.min(min, event.seq), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(minSeq)) return;
    try {
      const response = await trajectoryApi.getEvents(resolvedRunId, { beforeSeq: minSeq, limit });
      applyResponse(response, 'older', false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [resolvedRunId, hasMoreOlder, limit, applyResponse]);

  const reload = useCallback(async (): Promise<void> => {
    if (resolvedRunId !== undefined) void loadInitial(resolvedRunId);
  }, [resolvedRunId, loadInitial]);

  return {
    status,
    errorMessage,
    resolvedRunId,
    events,
    hasMoreOlder,
    runEnded,
    lastSeq,
    loadOlder,
    reload,
  };
}
