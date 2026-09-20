/**
 * 会话事实读取（node 侧）：把 run 目录下的 pi 会话文件读成 SessionFacts[]。
 *
 * 方案 C：会话是唯一完整事实源。本模块只做「磁盘 → 结构化事实」（fs），
 * 解析的纯逻辑在 @zread-pi/trajectory 的 parseSessionLines（无 node 依赖，
 * 可被 Vite 打包）。读取结果交给 replayRun / summarizeRunEvents 投影。
 *
 * 目录布局（pi 的 JsonlSessionRepo 决定，阶段 0 探针核实）：
 *   <runDir>/sessions/--<cwd 转义>--/<ts>_<encodeURIComponent(sessionId)>.jsonl
 * 一个 Agent 一个文件；损坏文件跳过（不丢弃整个 run）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSessionLines,
  sessionIdFromFileName,
  type SessionFacts,
} from '@zread-pi/trajectory';
import { getSessionsRoot } from './run-dir.js';
import { createLogger } from '../logger/service.js';

const logger = createLogger('orchestrator.session-store');

/** 读取一个 run 的全部会话事实（按会话创建时间排序） */
export async function readSessionFacts(
  runId: string,
  projectRoot: string = process.cwd(),
): Promise<SessionFacts[]> {
  const sessionsRoot = getSessionsRoot(runId, projectRoot);
  if (!existsSync(sessionsRoot)) return [];

  let directories: string[];
  try {
    directories = await readdir(sessionsRoot);
  } catch {
    return [];
  }

  const facts: SessionFacts[] = [];
  for (const directory of directories) {
    const dirPath = join(sessionsRoot, directory);
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
      const path = join(dirPath, name);
      try {
        const content = await readFile(path, 'utf-8');
        const lines = content.split(/\r?\n/);
        const sessionId = sessionIdFromFileName(name);
        const parsed = parseSessionLines(lines, sessionId);
        if (parsed.sessionId === '') {
          // header 与文件名都拿不到 id：无法与 agent_config join，跳过
          logger.warn(`会话文件缺少 session id，已跳过：${path}`);
          continue;
        }
        facts.push(parsed);
      } catch {
        // 损坏 / 不可读的会话文件：跳过，不丢弃整个 run
        logger.warn(`会话文件读取失败，已跳过：${path}`);
      }
    }
  }

  // 按文件名时间戳排序（= 会话创建顺序，与事件时序大体一致）
  return facts.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}
