/**
 * run 目录约定（`<项目>/.zread-pi/runs/<runId>/`）。
 *
 * runId 形如 `2026-05-20T14-03-01-9f3a`：可排序（字典序 = 时间序）、
 * 文件系统安全（无冒号 / 路径分隔符）。
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from '@zread-pi/types';
import { ZREAD_PI_DIR_NAME } from '../project-home.js';
import { readRunMeta } from './run-log-reader.js';

export const RUNS_DIR_NAME = 'runs';
export const EVENTS_FILE_NAME = 'events.jsonl';
export const META_FILE_NAME = 'run.json';

/** runId 的校验规则（年-月-日THH-mm-ss-4 位十六进制） */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{4}$/;

/** 「最新一次运行」的别名（resolveRunId 接受） */
export const LATEST_RUN_ALIAS = 'latest';

/** 生成一个 runId（可排序、文件系统安全） */
export function generateRunId(now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const date =
    `${now.getUTCFullYear()}-${two(now.getUTCMonth() + 1)}-${two(now.getUTCDate())}` +
    `T${two(now.getUTCHours())}-${two(now.getUTCMinutes())}-${two(now.getUTCSeconds())}`;
  const suffix = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${date}-${suffix}`;
}

/** 目标仓库的 runs 根目录 */
export function getRunsDir(projectRoot: string = process.cwd()): string {
  return join(projectRoot, ZREAD_PI_DIR_NAME, RUNS_DIR_NAME);
}

/** 单次运行的目录 */
export function getRunDir(runId: string, projectRoot: string = process.cwd()): string {
  return join(getRunsDir(projectRoot), runId);
}

export function getEventsPath(runId: string, projectRoot: string = process.cwd()): string {
  return join(getRunDir(runId, projectRoot), EVENTS_FILE_NAME);
}

export function getMetaPath(runId: string, projectRoot: string = process.cwd()): string {
  return join(getRunDir(runId, projectRoot), META_FILE_NAME);
}

/** runId 合法 */
export function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * 列出所有运行（按 startedAt 降序 = 最新在前）。
 *
 * run.json 缺失 / 损坏时合成一条 `interrupted` 摘要（残留自愈的读取侧兜底）。
 */
export async function listRuns(projectRoot: string = process.cwd()): Promise<RunSummary[]> {
  const dir = getRunsDir(projectRoot);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const name of names) {
    if (!isValidRunId(name)) continue;
    const entry = join(dir, name);
    try {
      if (!(await stat(entry)).isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = await readRunMeta(name, projectRoot).catch(() => undefined);
    summaries.push(
      meta ?? {
        id: name,
        // 无 meta（损坏 / 正在创建）：用 runId 本身作 startedAt
        // （与 ISO 同为 `T` 分隔，字典序可比）
        startedAt: name,
        status: 'interrupted',
        kind: 'generate',
        pages: { total: 0, completed: 0, failed: 0 },
        agents: { count: 0, byRole: {} },
      },
    );
  }

  // 按真实开始时间排序：startedAt 是毫秒精度 ISO，比秒级 runId 准
  // （同秒内创建的 run，runId 的随机后缀不保证顺序 = 创建顺序）。
  // 同 startedAt 时以 id 降序兜底。无 meta 的合成条目用 runId 本身作 startedAt。
  return summaries.sort((left, right) => {
    const byStarted = (right.startedAt ?? '').localeCompare(left.startedAt ?? '');
    return byStarted !== 0 ? byStarted : right.id.localeCompare(left.id);
  });
}

/** 最新一次运行（任意状态） */
export async function latestRun(projectRoot: string = process.cwd()): Promise<RunSummary | undefined> {
  return (await listRuns(projectRoot))[0];
}

/**
 * 解析「某次运行」：合法 id → 原值；`latest` / 缺省 → 最新；非法 / 不存在 → undefined。
 */
export async function resolveRunId(
  idOrLatest: string | undefined,
  projectRoot: string = process.cwd(),
): Promise<string | undefined> {
  if (idOrLatest === undefined || idOrLatest === '') {
    return (await latestRun(projectRoot))?.id;
  }
  if (idOrLatest === LATEST_RUN_ALIAS) {
    return (await latestRun(projectRoot))?.id;
  }
  if (!isValidRunId(idOrLatest)) return undefined;
  return existsSync(getRunDir(idOrLatest, projectRoot)) ? idOrLatest : undefined;
}
