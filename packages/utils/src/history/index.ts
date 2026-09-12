/**
 * 全局记忆（Global Memory）—— 「最近用 zread-pi 生成过文档的项目」清单。
 *
 * 落盘：`<项目家目录>/history`（路径由 `project-home.ts` 唯一定义，默认 `~/.zread-pi/history`），
 * 用 `binary-log.ts` 的 ZRH1 二进制结构存项目绝对路径（追加 / 顺序遍历 / 随机删除均为最优复杂度）。
 *
 * 语义：
 *  - 开始生成文档时调用 `rememberProject()`：把当前项目路径写到清单末尾；
 *    同路径去重 —— 重复生成同一个项目只保留最近一条（自然形成「最近使用」顺序）；
 *  - `zread-pi history` 调用 `pruneHistory()`：并发检查每个项目目录下 `.zread-pi` 是否还存在，
 *    失效的删除，剩下的按记录顺序返回；
 *  - 记忆属于可再生的辅助数据：读取失败 / 文件损坏都不应阻塞文档生成或 history 命令。
 */

import { rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HistoryFormatError, HistoryLog, type HistoryLogEntry } from './binary-log.js';
import { mapWithConcurrency } from './concurrency.js';
import { projectHomePath, ZREAD_PI_DIR_NAME } from '../project-home.js';

/** 记忆中二进制文件的文件名 */
export const HISTORY_FILE_NAME = 'history';
/** 清理失效记录时的默认并发数 */
export const DEFAULT_PRUNE_CONCURRENCY = 8;

/** 全局记忆文件的绝对路径（`<项目家目录>/history`） */
export function getHistoryPath(): string {
  return projectHomePath(HISTORY_FILE_NAME);
}

export interface ProjectRecord {
  /** 项目绝对路径 */
  path: string;
  /** 记录在二进制文件中的偏移（snapshot 值，随机删除 / 排查用） */
  offset: number;
}

export interface HistoryPruneOptions {
  /**
   * 检查目录存在性的并发数（默认 8）。
   * 探测是 I/O 等待型任务，并发可明显加快项目很多时的遍历速度；结果顺序不变。
   */
  concurrency?: number;
}

export interface HistoryPruneResult {
  /** 本次遍历的记录总数（含本次删除的） */
  scanned: number;
  /** 被判定失效并删除的项目路径（按记录顺序） */
  removed: string[];
  /** 遍历结束后仍然有效的记录（按记录顺序，最新在最后） */
  remaining: ProjectRecord[];
}

/**
 * 打开全局记忆文件；损坏时备份原文件并重建空清单。
 *
 * 损坏的自愈（而不是抛错）是有意为之：记忆丢了只是 list 变短，
 * 生成文档与查看历史都不应该因为一个坏文件而失败。
 */
async function openHistory(): Promise<HistoryLog> {
  const filePath = getHistoryPath();
  try {
    return await HistoryLog.open(filePath);
  } catch (error) {
    if (!(error instanceof HistoryFormatError)) throw error;
    try {
      await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // 备份失败（权限等）也继续重建，避免阻塞
    }
    return HistoryLog.open(filePath);
  }
}

/** 归一化为项目绝对路径（相对路径按当前工作目录解析） */
function normalizeProjectPath(projectPath: string): string {
  const trimmed = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!trimmed) throw new TypeError('history: 项目路径不能为空');
  return resolve(trimmed);
}

function toRecord(entry: HistoryLogEntry): ProjectRecord {
  return { path: entry.path, offset: entry.offset };
}

/**
 * 写入一条全局记忆（开始生成文档时调用）。
 *
 * @param projectPath 项目目录，缺省为当前工作目录；内部会归一化为绝对路径
 * @returns 写入的记录（含偏移）
 */
export async function rememberProject(projectPath: string = process.cwd()): Promise<ProjectRecord> {
  const log = await openHistory();
  const entry = await log.append(normalizeProjectPath(projectPath));
  return toRecord(entry);
}

/** 顺序读出全部记忆（最旧的在前；不检查目录是否存在） */
export async function readHistory(): Promise<ProjectRecord[]> {
  const log = await openHistory();
  return log.entries().map(toRecord);
}

/** 删除某个项目的记录；返回是否删掉了 */
export async function forgetProject(projectPath: string): Promise<boolean> {
  const log = await openHistory();
  return log.remove(normalizeProjectPath(projectPath));
}

/** 清空全局记忆 */
export async function clearHistory(): Promise<void> {
  const log = await openHistory();
  await log.clear();
}

/**
 * 遍历全部记录并清理失效项：
 *
 *  1. 并发检查每条记录对应项目目录下的 `.zread-pi` 目录是否存在（不存在 = 项目已删除 / 产物已清理）；
 *  2. 删除失效记录（二进制结构里 O(1) 墓碑 + 按需压缩）；
 *  3. 返回剩余记录。
 */
export async function pruneHistory(options: HistoryPruneOptions = {}): Promise<HistoryPruneResult> {
  const log = await openHistory();
  const entries = log.entries();
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency as number))
    : DEFAULT_PRUNE_CONCURRENCY;

  const checks = await mapWithConcurrency(entries, concurrency, async (entry) => ({
    entry,
    alive: await hasLocalOutput(entry.path),
  }));

  const removed: string[] = [];
  for (const { entry, alive } of checks) {
    if (alive) continue;
    if (await log.remove(entry)) removed.push(entry.path);
  }

  return {
    scanned: entries.length,
    removed,
    remaining: log.entries().map(toRecord),
  };
}

/** 项目目录下是否还有本地产物目录（`<project>/.zread-pi`，且必须是目录） */
async function hasLocalOutput(projectPath: string): Promise<boolean> {
  try {
    const info = await stat(join(projectPath, ZREAD_PI_DIR_NAME));
    return info.isDirectory();
  } catch {
    return false;
  }
}
