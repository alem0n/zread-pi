/**
 * run 日志读取：窗口读取（beforeSeq 向前分页 / afterSeq 实时尾）+ 损坏行跳过。
 *
 * 损坏行容忍策略与 history 的自愈一致：单行 JSON 解析失败时跳过该行，
 * 继续读取其余行（截断的末行、并发写了一半的行都不会让整个 run 不可读）。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { RunEvent, RunMeta } from '@zread-pi/types';
import { getEventsPath, getMetaPath } from './run-dir.js';

/** 单次读取返回的事件上限（防止异常大的日志一次性灌进内存） */
export const DEFAULT_READ_LIMIT = 500;

export interface ReadEventsOptions {
  /** 向前分页：只取 seq < beforeSeq 的事件，返回**最新的** limit 条（顺序保持） */
  beforeSeq?: number;
  /** 实时尾：只取 seq > afterSeq 的事件（最早的 limit 条） */
  afterSeq?: number;
  /** 返回条数上限 */
  limit?: number;
}

export interface ReadEventsResult {
  events: RunEvent[];
  /** 是否还有更旧的事件可加载（向前分页用） */
  hasMore: boolean;
  /** 是否还有更新的事件（尾随用；恒为「文件末尾之后是否可能有新行」） */
  hasNewer: boolean;
  /** 该 run 是否已经结束（run.json 的 status 不是 running） */
  runEnded: boolean;
}

/** 读取 run.json（缺失 / 损坏返回 undefined） */
export async function readRunMeta(
  runId: string,
  projectRoot: string = process.cwd(),
): Promise<RunMeta | undefined> {
  const path = getMetaPath(runId, projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as RunMeta;
  } catch {
    return undefined;
  }
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { seq?: unknown; kind?: unknown };
  return typeof candidate.seq === 'number' && typeof candidate.kind === 'string';
}

/** 解析全部有效事件（跳过损坏行） */
async function readAllEvents(runId: string, projectRoot: string): Promise<RunEvent[]> {
  const path = getEventsPath(runId, projectRoot);
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  const events: RunEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRunEvent(parsed)) events.push(parsed);
    } catch {
      // 损坏行（写到一半 / 截断）：跳过，不丢弃整个 run
    }
  }
  return events;
}

export async function readEvents(
  runId: string,
  options: ReadEventsOptions = {},
  projectRoot: string = process.cwd(),
): Promise<ReadEventsResult> {
  const limit = Math.max(1, options.limit ?? DEFAULT_READ_LIMIT);
  const all = await readAllEvents(runId, projectRoot);
  const meta = await readRunMeta(runId, projectRoot);
  const runEnded = meta?.status !== 'running';
  const maxSeq = all.length === 0 ? 0 : all.reduce((max, event) => Math.max(max, event.seq), 0);

  // 实时尾：afterSeq 之后的事件，取最早的 limit 条
  if (options.afterSeq !== undefined) {
    const after = all.filter((event) => event.seq > options.afterSeq!);
    const window = after.slice(0, limit);
    return {
      events: window,
      hasMore: false,
      // 返回窗口之外还有更新的事件（本次读取被 limit 截断）
      hasNewer: after.length > window.length,
      runEnded,
    };
  }

  // 向前分页：beforeSeq 之前的事件，取最新的 limit 条并恢复顺序
  if (options.beforeSeq !== undefined) {
    const before = all
      .filter((event) => event.seq < options.beforeSeq!)
      .sort((left, right) => right.seq - left.seq);
    const window = before.slice(0, limit).reverse();
    return {
      events: window,
      hasMore: before.length > limit,
      hasNewer: all.some((event) => event.seq >= options.beforeSeq!),
      runEnded,
    };
  }

  // 缺省：最新的 limit 条（尾部）
  return {
    events: all.slice(-limit),
    hasMore: all.length > limit,
    hasNewer: false,
    runEnded,
  };
}
