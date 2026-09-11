/**
 * Wiki Content Generation Engine
 *
 * TypeScript control flow for parallel Wiki page generation.
 *
 * Architecture: "Code for control flow, LLM for content"
 * - TypeScript uses p-limit for concurrency control
 * - Each Wiki page gets an independent Agent via createAgent
 * - Error isolation: single page failure doesn't affect others
 * - 支持细粒度事件回调（onEvent）和批量进度回调（onProgress）
 */

import pLimit from 'p-limit';
import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ensureDir, fileExists, getWikiDir, joinPath, loadWikiBlueprint, logger } from '@zread-pi/utils';
import { createAgent } from '../agents/create-agent.js';
import {
  FileEditTool,
  FileReadTool,
  GlobTool,
  GrepTool,
  LsTool,
  getString,
  type ToolDefinition,
} from '@zread-pi/agent-runtime';
import { WritePageTool, resolvePageOutputPath } from '../tools/page-tools.js';
import PageAgentPrompt from '../prompts/page-agent';
import type { WikiPage } from '@zread-pi/types';
import type { WikiResult, ProgressState, PageResult, GenerateWikiOptions, ArticleEventPayload } from './types.js';

/**
 * Build page-specific prompt
 */
function buildPagePrompt(page: WikiPage): string {
  const associatedFilesList = page.associatedFiles?.map(f => `- ${f}`).join('\n') || '（无关联路径）';

  return `${PageAgentPrompt}

---

## 当前页面任务

**标题**: ${page.title}
**Slug**: ${page.slug}
**文件名**: ${page.file}
**章节**: ${page.section}
**难度**: ${page.level}

**关联路径**:
${associatedFilesList}

---

## 输出路径规范（必须严格遵守）

使用 \`write_page\` 工具时，**必须**传入以下参数确保正确的输出路径：
- \`slug\`: "${page.slug}"
- \`file\`: "${page.file}"
- \`section\`: "${page.section}"
- \`title\`: "${page.title}"

输出文件将写入: \`.zread-pi/wiki/${page.section}/${page.file}\`

请按照三步工作流执行，最后使用 write_page 输出文档（务必传入完整的 file 和 section 参数）。`;
}

/**
 * 从 write_page 的错误结果里取一条短原因（TUI 单行展示，过长会被截断）。
 * write_page 的返回是 JSON（如 {"success":false,"error":"Mermaid validation failed.\n..."}），
 * 优先取其中的 error 首行；非 JSON 时退回原文首行。
 */
function summarizeWriteError(content: unknown): string {
  if (typeof content !== 'string') return 'write_page 执行失败';

  let text = content;
  try {
    const parsed = JSON.parse(content) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      text = parsed.error;
    }
  } catch {
    // 非 JSON 内容，直接用原文
  }

  return text.split('\n')[0].slice(0, 160);
}

/**
 * 记录一次 write_page 调用的输入参数与真实落盘路径，
 * 用于「模型写错路径」时把已生成的文件兜底移回 wiki.json 约定的位置。
 */
export interface PageWriteAttempt {
  /** 调用发生时 Agent 的工作目录（write_page 以它为根解析路径） */
  cwd: string;
  /** 模型传入的路径参数（可能缺失或与 wiki.json 不一致） */
  file?: string;
  section?: string;
  slug?: string;
  /** write_page 成功时报告的绝对落盘路径 */
  outputPath?: string;
}

/** 从 write_page 的 JSON 结果里解析真实落盘路径（仅成功时有值）。 */
function extractWrittenPath(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as { success?: unknown; path?: unknown };
    return parsed.success === true && typeof parsed.path === 'string' && parsed.path.length > 0
      ? parsed.path
      : undefined;
  } catch {
    // 非 JSON 内容：拿不到真实落盘路径，后续靠输入参数复算 / 目录扫描兜底
    return undefined;
  }
}

/** 兜底查找上限：避免异常仓库下无界遍历（wiki 目录正常只有几十到几百个条目）。 */
const WIKI_RESCUE_SCAN_LIMIT = 2000;

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 收集「模型可能把页面写到哪」的候选路径（按可信度从高到低）：
 * 1. write_page 报告过的真实落盘路径（最近的优先）；
 * 2. 按模型传入参数 + write_page 的解析规则复算出的路径；
 * 3. 依据页面元数据的常见错误落点（缺 section、误用 slug 命名等）。
 */
function collectPageCandidates(page: WikiPage, attempts: PageWriteAttempt[], wikiDir: string): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    push(attempt.outputPath);
    if (attempt.file || attempt.slug) {
      push(
        resolvePageOutputPath(attempt.cwd, {
          file: attempt.file,
          section: attempt.section,
          slug: attempt.slug ?? page.slug,
        }),
      );
    }
  }

  push(joinPath(wikiDir, page.file));
  push(joinPath(wikiDir, `${page.slug}.md`));
  push(joinPath(wikiDir, page.section, `${page.slug}.md`));

  return candidates;
}

/**
 * 在 `.zread-pi/wiki` 下按文件名兜底查找页面文件（有界递归）。
 * 仅在 write_page 报告过成功、但报告路径已不存在时才需要走到这里。
 * 跳过 `archived/`：那是历史快照，不能当作本次生成的产物。
 */
async function scanWikiDirForPage(wikiDir: string, page: WikiPage): Promise<string | null> {
  const targets = new Set([basename(page.file), `${page.slug}.md`]);
  const queue: string[] = [wikiDir];
  let visited = 0;

  while (queue.length > 0 && visited < WIKI_RESCUE_SCAN_LIMIT) {
    const dir = queue.shift();
    if (!dir) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (++visited > WIKI_RESCUE_SCAN_LIMIT) break;
      const entryPath = joinPath(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'archived') queue.push(entryPath);
      } else if (entry.isFile() && targets.has(entry.name)) {
        return entryPath;
      }
    }
  }

  return null;
}

/** 把文件移动到约定位置：优先 rename，跨设备（EXDEV 等）时退回复制 + 删除。 */
async function relocatePageFile(source: string, target: string): Promise<void> {
  await ensureDir(dirname(target));
  try {
    await rename(source, target);
  } catch {
    await copyFile(source, target);
    await unlink(source).catch(() => {});
  }
}

/**
 * 落盘兜底：write_page 已成功但文件不在 wiki.json 约定的
 * `.zread-pi/wiki/<section>/<file>` 时，找到真实写入的文件并移动过去。
 *
 * 返回被移动的源路径（便于调用方记录日志/断言）；找不到可救援文件时返回 null。
 */
export async function rescuePageFile(
  page: WikiPage,
  attempts: PageWriteAttempt[],
  wikiDir: string = getWikiDir(),
): Promise<string | null> {
  const target = joinPath(wikiDir, page.section, page.file);

  const tryRelocate = async (candidate: string): Promise<boolean> => {
    if (candidate === target) return false;
    if (!(await isExistingFile(candidate))) return false;
    try {
      await relocatePageFile(candidate, target);
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[${page.slug}] 兜底移动页面文件失败（${candidate} -> ${target}）：${message}`);
      return false;
    }
  };

  for (const candidate of collectPageCandidates(page, attempts, wikiDir)) {
    if (await tryRelocate(candidate)) return candidate;
  }

  const scanned = await scanWikiDirForPage(wikiDir, page);
  if (scanned && (await tryRelocate(scanned))) return scanned;

  return null;
}

/**
 * Generate Wiki Content
 *
 * Parallel Wiki page generation with p-limit concurrency control.
 * 支持细粒度事件回调（onEvent）和批量进度回调（onProgress）。
 *
 * 注意：并发数由调用方传递，重试次数由 createAgent 从配置读取。
 */
export async function generateWikiContent(options?: GenerateWikiOptions): Promise<WikiResult> {
  const startTime = performance.now();

  // 并发数由调用方传递（默认 1）
  const maxConcurrent = options?.maxConcurrent ?? 1;

  // Load blueprint or use provided pages
  let pages: WikiPage[];
  if (options?.pages && options.pages.length > 0) {
    pages = options.pages;
  } else {
    const blueprint = await loadWikiBlueprint(options?.blueprintPath);
    pages = blueprint.pages;
  }

  logger.info(`开始生成 Wiki 内容：${pages.length} 个页面，并发数 ${maxConcurrent}`);

  // 3. Create concurrency limiter
  const limit = pLimit(maxConcurrent);

  // 4. Initialize progress tracking
  const progress: ProgressState = {
    total: pages.length,
    completed: 0,
    failed: 0,
    pending: pages.length,
    currentPage: null,
    results: [],
  };

  // 5. Parallel page generation using existing createAgent
  const tasks = pages.map((page) =>
    limit(async () => {
      const pageStartTime = performance.now();

      // 发射 page_start 事件
      options?.onEvent?.({ type: 'page_start', slug: page.slug });

      // Update progress
      progress.currentPage = page;
      progress.pending--;
      options?.onProgress?.(progress);

      // 跟踪 write_page 是否真正成功（模型可能从未调用，或被 Mermaid 校验拦截），
      // 并记录每次调用的输入/实际落盘路径，供写错路径时的兜底移动使用。
      let wrotePage = false;
      let lastWriteError: string | undefined;
      const writeAttempts: PageWriteAttempt[] = [];
      const writePageTool: ToolDefinition = {
        ...WritePageTool,
        async call(input, context) {
          const attempt: PageWriteAttempt = {
            cwd: context.cwd,
            file: getString(input, 'file'),
            section: getString(input, 'section'),
            slug: getString(input, 'slug'),
          };
          writeAttempts.push(attempt);

          const toolResult = await WritePageTool.call(input, context);
          if (toolResult.is_error) {
            lastWriteError = summarizeWriteError(toolResult.content);
          } else {
            wrotePage = true;
            lastWriteError = undefined;
            attempt.outputPath = extractWrittenPath(toolResult.content);
          }
          return toolResult;
        },
      };

      try {

        // 使用 createAgent，通过 onEvent 回调发射细粒度事件
        const result = await createAgent({
          tools: [
            FileReadTool,
            FileEditTool,
            GlobTool,
            GrepTool,
            LsTool,
            writePageTool
          ],
          prompts: buildPagePrompt(page),
          // maxTurns 由 config.agent.max_turns 提供（可在配置界面修改）；调用方可选覆盖
          maxTurns: options?.maxTurns,
          // 通过 onEvent 将 CatalogEvent 转换为 ArticleEventPayload
          onEvent: (catalogEvent) => {
            // 将 CatalogEvent 转换为 ArticleEventPayload
            let articleEventType: ArticleEventPayload['type'];
            let toolName: string | undefined;

            switch (catalogEvent.type) {
              case 'requesting':
                articleEventType = 'requesting';
                break;
              case 'responding':
                articleEventType = 'responding';
                break;
              case 'tool_start':
                articleEventType = 'tool_start';
                toolName = catalogEvent.toolName;
                break;
              case 'tool_result':
                articleEventType = 'tool_result';
                break;
              case 'retry':
                // 重试事件：传递给 UI 显示重试状态
                options?.onEvent?.({
                  type: 'retry',
                  slug: page.slug,
                  usage: catalogEvent.usage,
                  retryCount: catalogEvent.retryCount,
                  maxRetries: catalogEvent.maxRetries,
                  delayMs: catalogEvent.delayMs,
                  error: catalogEvent.error,
                });
                return;
              case 'error':
                // 错误事件：createAgent 会 throw 异常，由 catch 块处理
                return;
              case 'complete':
                // 完成事件：不在这里发射，由外层处理
                return;
              default:
                // 其他事件类型不发射
                return;
            }

            options?.onEvent?.({
              type: articleEventType,
              slug: page.slug,
              usage: catalogEvent.usage,
              toolName,
            });
          },
        });

        // Agent 正常结束 ≠ 页面已落盘：模型可能只输出文字、写到错误路径，
        // 或被 Mermaid 校验拦截后放弃。以 wiki.json 约定的输出文件存在为准，
        // 避免生成界面显示完成、而首页按文件检查仍显示未完成。
        //
        // 兜底：write_page 已成功时，模型可能把文件写到了别的路径
        // （典型：漏传 section 落到 wiki 根、只传 slug 写成 <slug>.md）。
        // 此时把真实写入的文件移动回约定位置，而不是直接记为失败。
        const outputFile = joinPath(getWikiDir(), page.section, page.file);
        if (!(await fileExists(outputFile))) {
          const rescuedFrom = wrotePage ? await rescuePageFile(page, writeAttempts, getWikiDir()) : null;
          if (rescuedFrom) {
            logger.warn(
              `[${page.slug}] write_page 写入路径与 wiki.json 不一致，已兜底移动到约定位置：${rescuedFrom} -> ${outputFile}`,
            );
          } else {
            const reason = wrotePage
              ? 'write_page 写入路径与 wiki.json 不一致'
              : lastWriteError
                ? `write_page 失败：${lastWriteError}`
                : '模型未调用 write_page';
            throw new Error(`页面文件未生成（${reason}）`);
          }
        }

        // Success
        progress.completed++;
        const pageResult: PageResult = {
          slug: page.slug,
          success: true,
          outputPath: `.zread-pi/wiki/${page.section}/${page.file}`,
          durationMs: Math.round(performance.now() - pageStartTime),
          tokenUsage: result.tokenUsage,
        };
        progress.results.push(pageResult);
        options?.onProgress?.(progress);

        // 发射 page_complete 事件
        options?.onEvent?.({
          type: 'page_complete',
          slug: page.slug,
          outputPath: pageResult.outputPath,
          durationMs: pageResult.durationMs,
          usage: result.tokenUsage,
        });

        logger.success(`[${page.slug}] 完成 (${pageResult.durationMs}ms)`);

        return pageResult;

      } catch (err: unknown) {
        // Error isolation: single page failure doesn't stop others
        const message = err instanceof Error ? err.message : String(err);


        progress.failed++;
        const pageResult: PageResult = {
          slug: page.slug,
          success: false,
          error: message,
          durationMs: Math.round(performance.now() - pageStartTime),
        };
        progress.results.push(pageResult);
        options?.onProgress?.(progress);

        // 发射 page_error 事件
        options?.onEvent?.({
          type: 'page_error',
          slug: page.slug,
          error: message,
          durationMs: pageResult.durationMs,
        });

        logger.error(`[${page.slug}] 失败: ${message}`);

        return pageResult;
      }
    })
  );

  // 6. Wait for all tasks
  await Promise.all(tasks);

  const durationMs = Math.round(performance.now() - startTime);

  logger.info(
    `Wiki 内容生成完成：${progress.completed}/${progress.total} 成功，${progress.failed} 失败 (${durationMs}ms)`
  );

  return {
    total: pages.length,
    completed: progress.completed,
    failed: progress.failed,
    durationMs,
    results: progress.results,
  };
}