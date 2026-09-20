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
import { ensureDir, fileExists, getRunDir, getWikiDir, joinPath, loadConfig, loadWikiBlueprint, writeJsonFile, writeTextFile, createLogger, withRunLog, buildPageStartEvent, buildPageEndEvent, type RunLogWriter } from '@zread-pi/utils';
import { createAgent } from '../agents/create-agent.js';
import { getDetailSpec, MINIMAL_PANORAMA_REQUIREMENT, type BlueprintDetailSpec } from '../agents/blueprint-detail.js';
import { createWritePageTool, buildPageFrontmatter, resolvePageOutputPath } from '../tools/page-tools.js';
import {
  extractGateReport,
  resolveGateMode,
  type ContentGateReport,
} from '../wiki/content-gate.js';
import {
  FileEditTool,
  FileReadTool,
  GlobTool,
  GrepTool,
  LsTool,
  getString,
  type TokenUsage,
  type ToolDefinition,
} from '@zread-pi/agent-runtime';
import { polishPageFile } from './polish.js';
import { verifyWiki } from './verify-wiki.js';
import { createRunLogSink } from '../agents/run-log-sink.js';
import { rememberCurrentProject } from './memory.js';
import PageAgentPrompt from '../prompts/page-agent';
import { withPageFormat } from '../agents/page-format.js';
import type { AppConfig, BlueprintDetailLevel, WikiPage, RunEventAgentMeta } from '@zread-pi/types';
import type { WikiResult, ProgressState, PageResult, GenerateWikiOptions, ArticleEventPayload } from './types.js';

/** 本模块的命名 logger（页面生成管线）。 */
const pagesLogger = createLogger('orchestrator.pages');

/**
 * Build page-specific prompt
 *
 * minimal 档位会附加「全景导览」要求（唯一一篇必须用 Mermaid 架构图梳理模块关系与数据流）。
 * `variant` 为写盘变体（档位子目录），只影响提示词里的输出路径说明。
 */
export function buildPagePrompt(
  page: WikiPage,
  spec: BlueprintDetailSpec,
  variant?: BlueprintDetailLevel | null,
  language?: string | null,
): string {
  const associatedFilesList = page.associatedFiles?.map(f => `- ${f}`).join('\n') || '（无关联路径）';
  const topicSummary = page.topicSummary ? `\n**主题摘要**: ${page.topicSummary}` : '';
  const panorama = spec.panorama ? `\n\n---\n\n${MINIMAL_PANORAMA_REQUIREMENT}` : '';
  const wikiBase = variant ? `.zread-pi/wiki/${variant}` : '.zread-pi/wiki';

  // 页面格式契约（frontmatter / 标题层级 / Mermaid 引号 / 溯源格式 / 自检清单）：
  // 与叙述语气正交的硬性约束，拼在页面提示词之后、任务元数据之前。
  const withFormat = withPageFormat(PageAgentPrompt, language);

  return `${withFormat}

---

## 当前页面任务

**标题**: ${page.title}
**Slug**: ${page.slug}
**文件名**: ${page.file}
**章节**: ${page.section}
**难度**: ${page.level}${topicSummary}

**关联路径**:
${associatedFilesList}

**范围纪律**: 文章内容不得超出上面的主题摘要（若有）与关联路径所划定的范围；关联文档 / 源码导航只指向同分类或相邻分类。

---

## 输出路径规范（必须严格遵守）

使用 \`write_page\` 工具时，**必须**传入以下参数确保正确的输出路径：
- \`slug\`: "${page.slug}"
- \`file\`: "${page.file}"
- \`section\`: "${page.section}"
- \`title\`: "${page.title}"

输出文件将写入: \`${wikiBase}/${page.section}/${page.file}\`

请按照三步工作流执行，最后使用 write_page 输出文档（务必传入完整的 file 和 section 参数）。${panorama}`;
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
 * 用于「模型写错路径」时把已生成的文件兜底移回 wiki.json 约定的位置，
 * 以及内容门 best-effort 落盘时取回被拦截的正文。
 */
export interface PageWriteAttempt {
  /** 调用发生时 Agent 的工作目录（write_page 以它为根解析路径） */
  cwd: string;
  /** 模型传入的路径参数（可能缺失或与 wiki.json 不一致） */
  file?: string;
  section?: string;
  slug?: string;
  /** 模型传入的标题（重建 frontmatter 用） */
  title?: string;
  /** write_page 成功时报告的绝对落盘路径 */
  outputPath?: string;
  /** 被内容门拦截时缓存的正文体（enforce 降级落盘用） */
  content?: string;
  /** 该次调用是否被内容门拦截（区别于 Mermaid / 路径错误） */
  gateBlocked?: boolean;
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
function collectPageCandidates(
  page: WikiPage,
  attempts: PageWriteAttempt[],
  wikiDir: string,
  variant: BlueprintDetailLevel,
): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    push(attempt.outputPath);
    if (attempt.file || attempt.slug) {
      push(
        resolvePageOutputPath(
          attempt.cwd,
          {
            file: attempt.file,
            section: attempt.section,
            slug: attempt.slug ?? page.slug,
          },
          { variant },
        ),
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
  wikiDir: string,
  variant: BlueprintDetailLevel,
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
      pagesLogger.warn(`[${page.slug}] 兜底移动页面文件失败（${candidate} -> ${target}）：${message}`);
      return false;
    }
  };

  for (const candidate of collectPageCandidates(page, attempts, wikiDir, variant)) {
    if (await tryRelocate(candidate)) return candidate;
  }

  const scanned = await scanWikiDirForPage(wikiDir, page);
  if (scanned && (await tryRelocate(scanned))) return scanned;

  return null;
}

/**
 * 内容门的 best-effort 落盘降级（见 AGENTS.md §3 内容密度门）。
 *
 * `enforce` 模式下模型未在 token 预算内通过内容门时，页面文件不会落盘
 * （write_page 返回 is_error）。此时把**最近一次被拦截的内容**写入约定路径，
 * 末尾追加一行 `<!-- gate: ... -->` 注释，并把报告标记为 `enforce-degraded`：
 * 页面计为成功 + 质量告警，不判页失败（zread-pi「生成永不悬挂」哲学）。
 *
 * 返回标记后的报告；不满足降级条件（未被内容门拦截 / 模型从未产出内容）时返回 null，
 * 由调用方走原失败路径（那是「模型未产出」，不是「门判死」）。
 */
async function writeDegradedPage(options: {
  outputFile: string;
  page: WikiPage;
  attempts: PageWriteAttempt[];
  gateReport: ContentGateReport | undefined;
}): Promise<ContentGateReport | null> {
  const { outputFile, page, attempts, gateReport } = options;
  if (!gateReport || gateReport.passed) return null;

  // 最近一次被内容门拦截且带有正文的尝试（倒序取最新）
  const blocked = [...attempts]
    .reverse()
    .find((attempt) => attempt.gateBlocked && typeof attempt.content === 'string');
  if (!blocked) return null;

  const frontmatter = buildPageFrontmatter(blocked.title, blocked.slug ?? page.slug);
  const note = `<!-- gate: 内容门未在 token 预算内通过，best-effort 落盘（${gateReport.failures.join('；')}） -->`;
  try {
    await ensureDir(dirname(outputFile));
    await writeTextFile(outputFile, `${frontmatter}${blocked.content}\n\n${note}\n`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    pagesLogger.warn(`[${page.slug}] best-effort 落盘失败，走原失败路径：${message}`);
    return null;
  }

  return { ...gateReport, mode: 'enforce-degraded' };
}

/**
 * 生成后自动校验（`quality.verifyAfterGenerate`）：跑一次交付闸门并把摘要落盘。
 *
 * 摘要文件为 `<runDir>/verify.json`——**不改动 `RunMeta`**（run.json 是固定字段结构），trajectory replay 无感知。
 * 校验本身只读、失败不影响生成结果（生成永不悬挂：闸门是事后体检，不是交付前置）。
 */
async function maybeWriteVerifyReport(
  config: AppConfig,
  variant: BlueprintDetailLevel,
  runLog: RunLogWriter | undefined,
): Promise<void> {
  if (!config.quality?.verifyAfterGenerate) return;
  if (!runLog) return;

  try {
    const report = await verifyWiki({ detail: variant });
    const runDir = getRunDir(runLog.runId, process.cwd());
    await ensureDir(runDir);
    await writeJsonFile(joinPath(runDir, 'verify.json'), report);
    pagesLogger.info(
      `[OK] 交付闸门已落盘（${report.ok ? 'OVERALL PASS' : 'OVERALL FAIL'}）：${joinPath(runDir, 'verify.json')}`,
    );
  } catch (err: unknown) {
    // 校验失败不判生成失败（闸门是增强不是必需）
    const message = err instanceof Error ? err.message : String(err);
    pagesLogger.warn(`交付闸门自动校验失败（不影响生成结果）：${message}`);
  }
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

  // 全局记忆：开始生成文档时记录当前项目（失败不阻断生成）
  await rememberCurrentProject();

  // 蓝图细节档位（写盘变体）：显式指定 > 配置档位
  const config = await loadConfig();
  const variant: BlueprintDetailLevel = options?.detail ?? config.blueprint.detail;

  return withRunLog(
    options?.runLog,
    {
      kind: 'generate',
      detail: variant,
      model: config.llm.model ?? undefined,
      provider: config.llm.provider ?? undefined,
    },
    async (runLog) => generatePages(options, variant, runLog, startTime),
  );
}

/** 页面生成主体（runLog 一定存在：来自调用方或 withRunLog 自动创建） */
async function generatePages(
  options: GenerateWikiOptions | undefined,
  variant: BlueprintDetailLevel,
  runLog: RunLogWriter,
  startTime: number,
): Promise<WikiResult> {
  const config = await loadConfig();
  // 页面格式契约按 doc_language 选 zh / en 版本（`en` 之外一律中文）
  const docLanguage = options?.language ?? config.doc_language ?? null;
  // minimal 会在页面提示词里附加「全景导览」要求
  const spec = getDetailSpec(variant);
  const wikiDir = getWikiDir(variant);
  // 内容门模式（off = 完全跳过，行为与迁移前一致）；按页注入 page 上下文，见下方任务内构造
  const gateMode = resolveGateMode(config);

  // 并发数由调用方传递（默认 1）
  const maxConcurrent = options?.maxConcurrent ?? 1;

  // Load blueprint or use provided pages
  let pages: WikiPage[];
  if (options?.pages && options.pages.length > 0) {
    pages = options.pages;
  } else {
    const blueprint = await loadWikiBlueprint(options?.blueprintPath, variant);
    pages = blueprint.pages;
  }

  pagesLogger.info(`开始生成 Wiki 内容：${pages.length} 个页面，并发数 ${maxConcurrent}`);

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

      // 页面边界事件（轨迹日志）
      const pageAgent: Omit<RunEventAgentMeta, 'sessionId'> = {
        key: `page:${page.slug}`,
        role: 'page',
        pageSlug: page.slug,
      };
      const pageOutputPath = joinPath(wikiDir, page.section, page.file);
      // 页面 Agent 的轨迹 sink（绑定全局唯一 sessionId，作为 pi 会话 id 与回放归属键）
      const pageSink = createRunLogSink(runLog, pageAgent);
      runLog.append(buildPageStartEvent({ slug: page.slug, outputPath: pageOutputPath }));

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
      // 最近一次内容门报告（warn 记录 / enforce 拦截 / enforce-degraded 降级）
      let lastGateReport: ContentGateReport | undefined;
      // best-effort 落盘成功后的报告（优先于 lastGateReport 写进 PageResult）
      let degradedGate: ContentGateReport | undefined;
      // 页面 Agent 的最后一次累计用量快照：失败路径（Agent 抛错）拿不到
      // `result.tokenUsage`，用它在 page_error 上归账，避免失败页在合计里记为 0。
      let lastUsage: TokenUsage | undefined;
      // 上下文占比：已用 = 最近一次响应的上下文体量，窗口来自 Agent 的 system/init
      let lastContextTokens: number | undefined;
      let lastContextWindow: number | undefined;
      const writeAttempts: PageWriteAttempt[] = [];
      // write_page 按页注入内容门（page 提供 level / section / associatedFiles）
      const writeTool = createWritePageTool({
        variant,
        ...(gateMode !== 'off' ? { contentGate: { mode: gateMode, page, spec } } : {}),
      });
      const writePageTool: ToolDefinition = {
        ...writeTool,
        async call(input, context) {
          const attempt: PageWriteAttempt = {
            cwd: context.cwd,
            file: getString(input, 'file'),
            section: getString(input, 'section'),
            slug: getString(input, 'slug'),
            title: getString(input, 'title'),
          };
          writeAttempts.push(attempt);

          const toolResult = await writeTool.call(input, context);
          // 内容门报告（off 时结果里不携带，extractGateReport 返回 undefined）
          const gate = extractGateReport(toolResult.content);
          if (gate) lastGateReport = gate;
          if (toolResult.is_error) {
            lastWriteError = summarizeWriteError(toolResult.content);
            // 内容门拦截：缓存正文，供预算用尽时 best-effort 落盘
            if (gate && !gate.passed) {
              attempt.gateBlocked = true;
              attempt.content = getString(input, 'content');
            }
          } else {
            wrotePage = true;
            lastWriteError = undefined;
            attempt.outputPath = extractWrittenPath(toolResult.content);
          }
          return toolResult;
        },
      };

      /**
       * 成功收尾：落盘后的兜底润色 + 计成功 + page_complete 事件 + runLog。
       *
       * 正常完成与「内容门降级落盘」复用同一套逻辑（生成永不悬挂：降级也计成功，
       * 质量告警由 `gate.mode = enforce-degraded` 携带）。
       */
      const finishPageSuccess = async (
        usage: TokenUsage | undefined,
        contextTokens: number | undefined,
        contextWindow: number | undefined,
      ): Promise<PageResult> => {
        const outputFile = joinPath(wikiDir, page.section, page.file);
        // 落盘完成后的兜底润色（第 2 层，polish.mode = 'full' 才真正执行）。
        // 失败不判页失败：页面产物已存在，polish 是增强不是必需（polishPageFile 内部只告警）。
        const polish = await polishPageFile({
          filePath: outputFile,
          slug: page.slug,
          title: page.title,
          runLog: createRunLogSink(runLog, {
            key: `polish:${page.slug}`,
            role: 'polish',
            pageSlug: page.slug,
          }),
        });
        if (polish.applied) {
          pagesLogger.info(`[${page.slug}] polish 已生效（${polish.durationMs}ms)`);
        } else if (polish.reason === 'mermaid-rollback') {
          pagesLogger.warn(`[${page.slug}] polish 未保留：Mermaid 复检未通过，已回滚`);
        }

        progress.completed++;
        const pageResult: PageResult = {
          slug: page.slug,
          success: true,
          outputPath: `.zread-pi/wiki/${page.section}/${page.file}`,
          durationMs: Math.round(performance.now() - pageStartTime),
          tokenUsage: usage,
          polish,
          // 内容门报告（off 时 undefined；warn 记录 / enforce 通过或降级）
          gate: degradedGate ?? lastGateReport,
        };
        progress.results.push(pageResult);
        options?.onProgress?.(progress);

        options?.onEvent?.({
          type: 'page_complete',
          slug: page.slug,
          outputPath: pageResult.outputPath,
          durationMs: pageResult.durationMs,
          usage,
          contextTokens: contextTokens ?? lastContextTokens,
          contextWindow: contextWindow ?? lastContextWindow,
          gate: pageResult.gate,
        });
        runLog.append(
          buildPageEndEvent({
            slug: page.slug,
            outputPath: pageResult.outputPath,
            success: true,
            durationMs: pageResult.durationMs,
          }),
        );

        pagesLogger.info(`[OK] [${page.slug}] 完成 (${pageResult.durationMs}ms)`);

        return pageResult;
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
          prompts: buildPagePrompt(page, spec, variant, docLanguage),
          // maxTurns 由 config.agent.max_turns 提供（可在配置界面修改）；调用方可选覆盖
          maxTurns: options?.maxTurns,
          runLog: pageSink,
          // 通过 onEvent 将 CatalogEvent 转换为 ArticleEventPayload
          onEvent: (catalogEvent) => {
            // 任何带用量的中间事件都刷新累计快照（usage 已是该 Agent 的累计值）
            if (catalogEvent.usage) lastUsage = catalogEvent.usage;
            if (catalogEvent.contextTokens !== undefined) lastContextTokens = catalogEvent.contextTokens;
            if (catalogEvent.contextWindow !== undefined) lastContextWindow = catalogEvent.contextWindow;

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
                  contextTokens: lastContextTokens,
                  contextWindow: lastContextWindow,
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
              contextTokens: lastContextTokens,
              contextWindow: lastContextWindow,
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
        const outputFile = joinPath(wikiDir, page.section, page.file);
        if (!(await fileExists(outputFile))) {
          const rescuedFrom = wrotePage ? await rescuePageFile(page, writeAttempts, wikiDir, variant) : null;
          if (rescuedFrom) {
            pagesLogger.warn(
              `[${page.slug}] write_page 写入路径与 wiki.json 不一致，已兜底移动到约定位置：${rescuedFrom} -> ${outputFile}`,
            );
          } else {
            // 内容门降级（enforce 路径）：enforce 拦截后模型未在 token 预算内通过时，
            // 把最近一次被拦截的内容 best-effort 落盘，标 enforce-degraded，页面计成功。
            // 不满足降级条件（模型从未产出 / 非 内容门拦截）时返回 null，走原失败路径。
            const degraded = await writeDegradedPage({
              outputFile,
              page,
              attempts: writeAttempts,
              gateReport: lastGateReport,
            });
            if (degraded) {
              degradedGate = degraded;
              pagesLogger.warn(
                `[${page.slug}] 内容门未在预算内通过，best-effort 落盘（gate.mode=enforce-degraded）：${degraded.failures.length} 项未达标`,
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
        }

        return finishPageSuccess(
          result.tokenUsage,
          result.contextTokens,
          result.contextWindow,
        );

      } catch (err: unknown) {
        // Error isolation: single page failure doesn't stop others
        const message = err instanceof Error ? err.message : String(err);

        // 内容门降级（预算耗尽路径）：Agent 因预算耗尽 / 中断等原因没有正常收尾，
        // 但已经有被内容门拦截的有效正文时，仍然 best-effort 落盘并计为成功
        // （生成永不悬挂：门判死也把产物交到用户手里，质量告警由 gate 携带）。
        const failedOutputFile = joinPath(wikiDir, page.section, page.file);
        if (!(await fileExists(failedOutputFile))) {
          const degraded = await writeDegradedPage({
            outputFile: failedOutputFile,
            page,
            attempts: writeAttempts,
            gateReport: lastGateReport,
          });
          if (degraded) {
            degradedGate = degraded;
            pagesLogger.warn(
              `[${page.slug}] 内容门未在预算内通过（Agent 中断：${message.slice(0, 80)}），best-effort 落盘（gate.mode=enforce-degraded）：${degraded.failures.length} 项未达标`,
            );
            return finishPageSuccess(lastUsage, lastContextTokens, lastContextWindow);
          }
        }


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
          usage: lastUsage,
          contextTokens: lastContextTokens,
          contextWindow: lastContextWindow,
          gate: lastGateReport,
        });
        runLog.append(
          buildPageEndEvent({
            slug: page.slug,
            outputPath: pageOutputPath,
            success: false,
            error: message,
            durationMs: pageResult.durationMs,
          }),
        );

        pagesLogger.error(`[${page.slug}] 失败: ${message}`);

        return pageResult;
      }
    })
  );

  // 6. Wait for all tasks
  await Promise.all(tasks);

  // 生成后可选自动校验（quality.verifyAfterGenerate，缺省 false）。
  // 摘要落成 `<runDir>/verify.json`（不改动 run.json 契约；trajectory replay 无感知）。
  await maybeWriteVerifyReport(config, variant, runLog);

  const durationMs = Math.round(performance.now() - startTime);

  pagesLogger.info(
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