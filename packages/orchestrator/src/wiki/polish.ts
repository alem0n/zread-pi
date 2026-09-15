/**
 * 页面级 polish 后处理（第 2 层兜底，`polish.mode = 'full'` 时启用）
 *
 * 预防层（第 1 层）把文风纪律注入系统提示，零额外成本；
 * 本模块是兜底：页面 `write_page` 成功 + 落盘兜底**之后**，对该文件跑一个轻量 polish Agent
 * （同一模型换一套系统提示：纪律 + Embedded mode，工具只给 read / edit / ls，不给 write_page，
 * 并使用独立的较小 token 预算）。
 *
 * 失败语义：polish 失败**不判页失败**——页面产物已存在，polish 是增强不是必需
 * （与 history 写入「失败不阻断」同一哲学）。唯一的破坏性检测是 Mermaid：
 * polish 完成后重跑 `validateMermaidContent`，若改坏图表则回滚到 polish 前的内容并告警。
 *
 * 详见 MIGRATION.md §15。
 */

import { readFile } from 'node:fs/promises';
import {
  FileEditTool,
  FileReadTool,
  LsTool,
  type TokenUsage,
  type ToolDefinition,
} from '@zread-pi/agent-runtime';
import { loadConfig, logger, writeTextFile } from '@zread-pi/utils';
import { createAgent } from '../agents/create-agent.js';
import { buildPolishSystemPrompt, buildPolishTaskPrompt } from '../agents/style-discipline.js';
import { formatMermaidValidationError, validateMermaidContent } from '../tools/page-tools.js';
import type { PolishOutcome } from './types.js';

/**
 * polish Agent 的独立小 token 预算：一次 Read + 少量 Edit 足够；
 * 与页面 Agent 的预算分开，避免润色把页面的预算顶掉。
 */
export const DEFAULT_POLISH_TOKEN_BUDGET = 60_000;

/** polish Agent 的工具集：只能读、只能就地编辑（没有 write_page，防止它重写整页） */
const POLISH_TOOLS: ToolDefinition[] = [FileReadTool, FileEditTool, LsTool];

export interface PolishPageOptions {
  /** 页面文件的绝对路径（即 write_page 落盘的约定位置） */
  filePath: string;
  /** 页面 slug（日志用） */
  slug: string;
  /** 页面标题（任务提示用） */
  title?: string;
  /** 覆盖默认 polish token 预算（测试用） */
  tokenBudget?: number;
}

/** 读取文件内容；不存在/读不了时返回 null（不抛错，polish 不阻断页面） */
async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 对单个页面文件执行兜底润色。
 *
 * 返回结构见 `PolishOutcome`；本函数**不会抛错**（除不可恢复的编程错误外），
 * 调用方（generate-wiki）只需要把它记录进 PageResult，不需要 try/catch。
 */
export async function polishPageFile(options: PolishPageOptions): Promise<PolishOutcome> {
  const startTime = performance.now();
  const startedAt = () => Math.round(performance.now() - startTime);

  const config = await loadConfig();
  const polishConfig = config.polish;
  if (polishConfig && polishConfig.enabled === false) {
    return { applied: false, reason: 'disabled', durationMs: startedAt() };
  }
  if (polishConfig?.mode !== 'full') {
    return { applied: false, reason: 'mode', durationMs: startedAt() };
  }

  const original = await readIfExists(options.filePath);
  if (original === null) {
    logger.warn(`[${options.slug}] polish 跳过：页面文件不可读（${options.filePath}）`);
    return { applied: false, reason: 'missing-file', durationMs: startedAt() };
  }

  logger.info(`[${options.slug}] 开始 polish（${options.filePath}）`);
  let agentError: string | undefined;
  let tokenUsage: TokenUsage | undefined;
  try {
    const result = await createAgent({
      tools: POLISH_TOOLS,
      prompts: buildPolishTaskPrompt({
        filePath: options.filePath,
        slug: options.slug,
        title: options.title,
      }),
      systemPrompt: buildPolishSystemPrompt(config.doc_language),
      tokenBudget: options.tokenBudget ?? DEFAULT_POLISH_TOKEN_BUDGET,
    });
    tokenUsage = result.tokenUsage;
  } catch (err: unknown) {
    // 页面已存在，polish 失败不判页失败，仅告警
    agentError = err instanceof Error ? err.message : String(err);
    logger.warn(`[${options.slug}] polish Agent 失败（不阻断页面）：${agentError}`);
  }

  const current = await readIfExists(options.filePath);
  if (current === null) {
    return { applied: false, reason: 'missing-file', error: agentError, durationMs: startedAt(), tokenUsage };
  }
  if (current === original) {
    return {
      applied: false,
      reason: agentError ? 'error' : 'no-change',
      error: agentError,
      durationMs: startedAt(),
      tokenUsage,
    };
  }

  // 唯一的结构性复检：polish 不能改坏 Mermaid；改坏就回滚到润色前内容并告警
  const mermaidIssues = validateMermaidContent(current);
  if (mermaidIssues.length > 0) {
    const detail = formatMermaidValidationError(mermaidIssues);
    try {
      await writeTextFile(options.filePath, original);
      logger.warn(`[${options.slug}] polish 改坏了 Mermaid，已回滚到润色前内容：\n${detail}`);
      return {
        applied: false,
        reason: 'mermaid-rollback',
        error: detail,
        durationMs: startedAt(),
        tokenUsage,
      };
    } catch (err: unknown) {
      // 回滚也失败：保留被改坏的文件但明确告警（不掩盖问题）
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[${options.slug}] polish 回滚失败：${message}\n${detail}`);
      return {
        applied: false,
        reason: 'mermaid-rollback',
        error: `${detail}\nrollback failed: ${message}`,
        durationMs: startedAt(),
        tokenUsage,
      };
    }
  }

  logger.success(`[${options.slug}] polish 完成（${startedAt()}ms）`);
  return { applied: true, error: agentError, durationMs: startedAt(), tokenUsage };
}
