/**
 * 页面级 polish 后处理（第 2 层兜底，`polish.mode = 'full'` 时启用）
 *
 * 预防层（第 1 层）把文风纪律注入系统提示，零额外成本；
 * 本模块是兜底：页面 `write_page` 成功 + 落盘兜底**之后**，对该文件跑一个轻量 polish Agent
 * （同一模型换一套系统提示：纪律 + Embedded mode，工具只给 read / edit / ls，不给 write_page，
 * 并使用独立的较小 token 预算）。
 *
 * 失败语义：polish 失败**不判页失败**——页面产物已存在，polish 是增强不是必需
 * （与 history 写入「失败不阻断」同一哲学）。唯一的破坏性检测是**结构复检**：
 * polish 完成后跑 `checkPolishDiff`，若它改动了 frontmatter / `Sources:` 溯源行 /
 * Mermaid 代码块（只许改散文），就回滚到 polish 前的内容并告警。
 *
 * 详见 MIGRATION.md §15 / §32.3。
 */

import { readFile } from 'node:fs/promises';
import {
  FileEditTool,
  FileReadTool,
  LsTool,
  type TokenUsage,
  type ToolDefinition,
} from '@zread-pi/agent-runtime';
import { loadConfig, createLogger, writeTextFile } from '@zread-pi/utils';
import { createAgent, type AgentResult, type RunLogSink } from '../agents/create-agent.js';
import { buildPolishSystemPrompt, buildPolishTaskPrompt } from '../agents/style-discipline.js';
import { formatMermaidValidationError, validateMermaidContent } from '../tools/page-tools.js';
import type { PolishOutcome } from './types.js';

/** 本模块的命名 logger（页面润色）。 */
const polishLogger = createLogger('orchestrator.polish');

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
  /** 轨迹日志 sink（可选；已绑定 polish Agent 身份） */
  runLog?: RunLogSink;
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
 * polish 结构复检：只许改散文，frontmatter / `Sources:` 溯源行 / Mermaid 代码块逐字不变。
 *
 * 三项都是「事实」而非「散文」：frontmatter 由 write_page 注入（title / slug 是
 * wiki.json 契约）；`Sources:` 的路径与行号是溯源证据；Mermaid 代码块是图结构本身
 * （外面的解释文字才算散文）。任一项被改动即判定 polish 越界，回滚到润色前内容。
 */
export interface PolishDiffViolation {
  /** 被改动的结构类别 */
  kind: 'frontmatter' | 'sources' | 'mermaid';
  /** 一行诊断结论（拼进回滚告警） */
  detail: string;
}

const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SOURCES_LINE_RE = /^[ \t>]*Sources?:\s.*$/gim;
const MERMAID_BLOCK_RE = /^```mermaid[\s\S]*?^```/gm;

/** 提取全部 Mermaid 代码块（含围栏，逐字比较） */
function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  MERMAID_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MERMAID_BLOCK_RE.exec(text)) !== null) blocks.push(match[0]);
  return blocks;
}

/** 纯函数：比较润色前后，列出全部越界改动（空数组 = 只改了散文，安全） */
export function checkPolishDiff(original: string, current: string): PolishDiffViolation[] {
  const violations: PolishDiffViolation[] = [];

  // 1. frontmatter 块逐字不变（title / slug 是 write_page 注入的契约，不是散文）
  const fmOriginal = FRONTMATTER_BLOCK_RE.exec(original)?.[0] ?? '';
  const fmCurrent = FRONTMATTER_BLOCK_RE.exec(current)?.[0] ?? '';
  if (fmOriginal !== fmCurrent) {
    violations.push({ kind: 'frontmatter', detail: 'frontmatter 块被改动（title / slug 由 write_page 注入，只许改散文）' });
  }

  // 2. Sources 溯源行逐字不变（路径 / 行号 / 链接目标是证据，不是散文）
  const sourcesOriginal = (original.match(SOURCES_LINE_RE) ?? []).sort().join('\n');
  const sourcesCurrent = (current.match(SOURCES_LINE_RE) ?? []).sort().join('\n');
  if (sourcesOriginal !== sourcesCurrent) {
    violations.push({ kind: 'sources', detail: 'Sources 溯源行被改动（路径 / 行号必须逐字保留）' });
  }

  // 3. Mermaid 代码块逐字不变（图结构是事实；块外的解释文字才算散文）
  const mermaidOriginal = extractMermaidBlocks(original).join('\n---\n');
  const mermaidCurrent = extractMermaidBlocks(current).join('\n---\n');
  if (mermaidOriginal !== mermaidCurrent) {
    violations.push({ kind: 'mermaid', detail: 'Mermaid 代码块被改动（图结构只许原样保留）' });
  }

  return violations;
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
    polishLogger.warn(`[${options.slug}] polish 跳过：页面文件不可读（${options.filePath}）`);
    return { applied: false, reason: 'missing-file', durationMs: startedAt() };
  }

  polishLogger.info(`[${options.slug}] 开始 polish（${options.filePath}）`);
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
      ...(options.runLog !== undefined ? { runLog: options.runLog } : {}),
    });
    tokenUsage = result.tokenUsage;
  } catch (err: unknown) {
    // 页面已存在，polish 失败不判页失败，仅告警
    agentError = err instanceof Error ? err.message : String(err);
    polishLogger.warn(`[${options.slug}] polish Agent 失败（不阻断页面）：${agentError}`);
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

  // 结构复检：只许改散文（frontmatter / Sources / Mermaid 代码块逐字不变）。
  // 任一项被改动即判定越界，回滚到润色前内容；Mermaid 越界时额外附语法校验详情。
  const violations = checkPolishDiff(original, current);
  if (violations.length > 0) {
    const mermaidBroken = violations.some((v) => v.kind === 'mermaid');
    const mermaidDetail = mermaidBroken
      ? formatMermaidValidationError(validateMermaidContent(current))
      : '';
    const detail = [
      ...violations.map((v) => v.detail),
      ...(mermaidDetail ? [mermaidDetail] : []),
    ].join('\n');
    try {
      await writeTextFile(options.filePath, original);
      const kind = violations[0].kind;
      polishLogger.warn(`[${options.slug}] polish 越界（${kind}），已回滚到润色前内容：\n${detail}`);
      return {
        applied: false,
        reason: kind === 'mermaid' ? 'mermaid-rollback' : 'structure-rollback',
        error: detail,
        durationMs: startedAt(),
        tokenUsage,
      };
    } catch (err: unknown) {
      // 回滚也失败：保留被改坏的文件但明确告警（不掩盖问题）
      const message = err instanceof Error ? err.message : String(err);
      polishLogger.error(`[${options.slug}] polish 回滚失败：${message}\n${detail}`);
      return {
        applied: false,
        reason: 'structure-rollback',
        error: `${detail}\nrollback failed: ${message}`,
        durationMs: startedAt(),
        tokenUsage,
      };
    }
  }

  polishLogger.info(`[OK] [${options.slug}] polish 完成（${startedAt()}ms）`);
  return { applied: true, error: agentError, durationMs: startedAt(), tokenUsage };
}
