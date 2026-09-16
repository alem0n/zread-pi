/**
 * 轨迹（Trajectory）视图的 API 层：runs 列表 / meta / 事件分页 + 运行中轮询。
 *
 * 服务端只存 / 分发原始事件（`RunEvent`），折叠在客户端完成（对齐 dsh）。
 */

import { api } from '@/utils/api';
import type { RunEvent, RunMeta, RunSummary } from '@zread-pi/types';

/** 服务端返回的运行列表 */
export interface RunsResponse {
  runs: RunSummary[];
  latest: string | null;
}

/** 事件分页接口的响应 */
export interface EventsResponse {
  runId: string;
  events: RunEvent[];
  /** 是否还有更旧的事件可加载（向前分页用） */
  hasMore: boolean;
  /** 是否还有更新的事件（本次读取被 limit 截断） */
  hasNewer: boolean;
  /** 运行已结束：前端据此停止尾随轮询 */
  runEnded: boolean;
  status: RunMeta['status'];
  lastSeq: number;
}

export interface TrajectoryApiOptions {
  /** 单页条数上限（与服务端默认一致） */
  limit?: number;
  /** 轮询间隔（毫秒；仅运行中生效） */
  pollIntervalMs?: number;
}

export const trajectoryApi = {
  listRuns: async (): Promise<RunsResponse> => {
    const response = await api.get<RunsResponse>('/runs');
    return response.data;
  },

  getRunMeta: async (runId: string): Promise<RunMeta | undefined> => {
    const response = await api.get<RunMeta>(`/runs/${encodeURIComponent(runId)}`);
    return response.data;
  },

  /**
   * 拉取事件：
   * - `afterSeq`：尾随（seq > afterSeq 的最早 limit 条）
   * - `beforeSeq`：向前分页（seq < beforeSeq 的最新 limit 条，顺序返回）
   * - 都不传：从 run 开头返回（检查器自上而下，首屏必须是 turn 1）
   */
  getEvents: async (
    runId: string,
    options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
  ): Promise<EventsResponse> => {
    const params: Record<string, string> = {};
    if (options.afterSeq !== undefined) params.afterSeq = String(options.afterSeq);
    if (options.beforeSeq !== undefined) params.beforeSeq = String(options.beforeSeq);
    if (options.limit !== undefined) params.limit = String(options.limit);
    const response = await api.get<EventsResponse>(
      `/runs/${encodeURIComponent(runId)}/events`,
      { params },
    );
    return response.data;
  },
};
