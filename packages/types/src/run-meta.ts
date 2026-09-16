/**
 * RunMeta —— 一次运行的元数据（run.json，文件锁 + 原子替换写入）
 */

import type { BlueprintDetailLevel } from './config.js';
import type { RunEventAgentRole, RunTokenUsage } from './run-event.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type RunKind = 'generate' | 'sync';

export interface RunAgentsMeta {
  count: number;
  byRole: Partial<Record<RunEventAgentRole, number>>;
}

export interface RunPagesMeta {
  total: number;
  completed: number;
  failed: number;
}

export interface RunMeta {
  /** runId（可排序、文件系统安全，如 2026-05-20T14-03-01-9f3a） */
  id: string;
  /** 开始时间（ISO） */
  startedAt: string;
  /** 结束时间（ISO；运行中缺省） */
  endedAt?: string;
  status: RunStatus;
  kind: RunKind;
  detail?: BlueprintDetailLevel;
  model?: string;
  provider?: string;
  /** 目标仓库绝对路径 */
  targetDir: string;
  agents: RunAgentsMeta;
  pages: RunPagesMeta;
  usage?: RunTokenUsage;
  durationMs?: number;
  error?: string;
  /** events.jsonl 的有效行数 */
  events: number;
  /** 最后一个事件的 seq（前端轮询游标；无事件时为 0） */
  lastSeq: number;
}

/** 列表用的精简形态（不含重型字段） */
export interface RunSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  kind: RunKind;
  detail?: BlueprintDetailLevel;
  pages: RunPagesMeta;
  agents: RunAgentsMeta;
  durationMs?: number;
  error?: string;
}
