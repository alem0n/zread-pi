/**
 * Blueprint Stages - 三阶段蓝图（分类 → 分主题 → 标题）的阶段驱动器
 *
 * 设计要点：
 * - 阶段 1「分类」：单 Agent 只产出 sections，落盘 wiki.json 骨架（致命失败）；
 * - 阶段 2「分主题」：按 section 并发（p-limit），每个 section 一个 Agent，
 *   通过 `submit_section_topics` 增量归并页面；单 section 失败记录到 failedSections，不阻断其余；
 * - 阶段 3「标题」：按 section 并发，输入该分类的页面列表，通过 `refine_section_titles`
 *   批量写回 title；输出量极小，失败保留原 title。
 *
 * 事件：所有阶段都会在 CatalogEvent 上打 `stage` / `section` / 分类级 `progress`，
 * 并把「所有已结束 + 进行中 Agent」的聚合用量作为 `usage` 上报（供 CLI 展示）。
 * 单阶段 Agent 的 `complete` 事件不外发——整体完成的 `complete` 由调用方发出。
 */

import pLimit from 'p-limit';
import {
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LsTool,
  addTokenUsage,
  emptyTokenUsage,
  sumTokenUsage,
  type TokenUsage,
  type ToolDefinition,
  type ToolInputParams,
  type ToolContext,
  type ToolResult,
} from '@zread-pi/agent-runtime';
import {
  loadWikiBlueprint,
  logger,
  sectionsFromBlueprint,
} from '@zread-pi/utils';
import type { AppConfig } from '@zread-pi/types';
import type { WikiPage, WikiSection } from '@zread-pi/types';
import { createAgent, type AgentResult } from './create-agent.js';
import {
  createRefineSectionTitlesTool,
  createSubmitSectionTopicsTool,
  createSubmitSectionsTool,
} from '../tools/output-tools.js';
import {
  GetCoreSignaturesTool,
  GetDirectoryTreeTool,
  GetModuleDetailsTool,
} from '../tools/repo-map-tools.js';
import ClassifyPrompt from '../prompts/classify';
import TopicsPrompt, { SYNC_TOPICS_RULES } from '../prompts/topics';
import TitlesPrompt from '../prompts/titles';
import type { BlueprintFailedSection, CatalogEvent, CatalogStage } from '../types.js';

/** 探索类工具（分类 / 主题阶段共用；与旧蓝图 Agent 的工具面保持一致） */
const EXPLORE_TOOLS: ToolDefinition[] = [
  GetDirectoryTreeTool,
  GetCoreSignaturesTool,
  GetModuleDetailsTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  LsTool,
];

/** 标题阶段工具（只够核对文件内容，避免长时间探索） */
const TITLE_TOOLS: ToolDefinition[] = [FileReadTool, GlobTool, GrepTool, LsTool];

/** 阶段驱动上下文 */
export interface BlueprintStageContext {
  config: AppConfig;
  onEvent?: (event: CatalogEvent) => void;
  usage: BlueprintUsageTracker;
}

/**
 * 跨 Agent 的聚合用量账本。
 *
 * 每个 Agent 的事件携带的是「该 Agent 自己的累计快照」；
 * 这里维护「已结束 Agent 的合计」+「进行中 Agent 的最新快照」，
 * 从而让 UI 在任何时刻看到的总量都只在增加（并发 section 也不会丢记账）。
 */
export class BlueprintUsageTracker {
  private settled: TokenUsage = emptyTokenUsage();
  private active = new Map<string, TokenUsage | undefined>();

  /** 记录某 Agent 的最新快照，返回聚合总量 */
  snapshot(key: string, usage?: TokenUsage): TokenUsage {
    if (usage) this.active.set(key, usage);
    else if (!this.active.has(key)) this.active.set(key, undefined);
    return this.total();
  }

  /** 某 Agent 结束：把最终用量结算进累计值（优先用 harness ledger 的终值） */
  settle(key: string, final?: TokenUsage): void {
    const value = final ?? this.active.get(key);
    if (value) this.settled = addTokenUsage(this.settled, value);
    this.active.delete(key);
  }

  total(): TokenUsage {
    return addTokenUsage(this.settled, sumTokenUsage([...this.active.values()]));
  }
}

/** 包装输出工具，记录「是否成功调用过」（失败分类的判定依据） */
function trackOutputTool(
  tool: ToolDefinition,
  state: { succeeded: boolean; error?: string },
): ToolDefinition {
  return {
    ...tool,
    async call(input: ToolInputParams, context: ToolContext): Promise<ToolResult> {
      const result = await tool.call(input, context);
      if (result.is_error) {
        state.error = String(result.content).split('\n')[0].slice(0, 200);
      } else {
        state.succeeded = true;
        state.error = undefined;
      }
      return result;
    },
  };
}

function emitStageEvent(
  context: BlueprintStageContext,
  stage: CatalogStage,
  event: Omit<CatalogEvent, 'stage' | 'usage'> & { usage?: TokenUsage },
): void {
  context.onEvent?.({ ...event, stage, usage: event.usage ?? context.usage.total() });
}

interface RunAgentOptions {
  key: string;
  stage: CatalogStage;
  section?: string;
  tools: ToolDefinition[];
  prompts: string;
  progress?: { current: number; total: number };
  /** 单 Agent 出错时是否把 error 事件转发给 UI（分类阶段致命 → 转发；分类内失败 → 不转发） */
  forwardErrors: boolean;
}

/** 运行一个阶段 Agent：事件附上 stage/section/聚合用量，结束时结算用量 */
async function runAgentAndSettle(
  context: BlueprintStageContext,
  options: RunAgentOptions,
): Promise<AgentResult> {
  try {
    return await createAgent({
      tools: options.tools,
      prompts: options.prompts,
      onEvent: (event) => {
        const aggregate = context.usage.snapshot(options.key, event.usage);

        if (event.type === 'complete') return;
        if (event.type === 'error' && !options.forwardErrors) return;

        context.onEvent?.({
          ...event,
          stage: options.stage,
          section: options.section,
          usage: aggregate,
          ...(options.progress ? { progress: options.progress } : {}),
        });
      },
    });
  } finally {
    context.usage.settle(options.key);
  }
}

function buildClassifyPrompt(extraContext?: string): string {
  return [
    ClassifyPrompt,
    extraContext ? `---\n\n${extraContext}` : '',
    '请先用 Repo Map 工具完成分析，然后调用 submit_sections 提交分类清单。',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function buildTopicsPrompt(section: WikiSection, extraRules?: string): string {
  return [
    TopicsPrompt,
    extraRules ?? '',
    '---',
    '',
    '## 当前分类',
    `- 分类: ${section.title}`,
    `- 说明: ${section.description ?? '（无）'}`,
    '',
    '请调用 submit_section_topics 提交该分类下的主题清单（section 字段必须与上面的分类标题一致）。',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function buildTitlesPrompt(section: WikiSection, pages: WikiPage[]): string {
  const pageLines = pages.map((page) => {
    const group = page.group ? `（group: ${page.group}）` : '';
    const files = page.associatedFiles?.length ? ` [files: ${page.associatedFiles.join(', ')}]` : '';
    return `- ${page.slug}: ${page.title}${group}${files}`;
  });

  return [
    TitlesPrompt,
    '---',
    '',
    '## 当前分类',
    `- 分类: ${section.title}`,
    `- 说明: ${section.description ?? '（无）'}`,
    '',
    '## 当前分类的页面列表',
    ...pageLines,
    '',
    '请调用 refine_section_titles 提交该分类下所有页面的精炼标题（slug 逐字保留）。',
  ].join('\n');
}

/**
 * 阶段 1：分类（单 Agent）。
 *
 * @param merge - sync 模式：保留既有分类与页面，只合并新增分类。
 * @returns 分类清单（含强制基础分类）
 * @throws 模型未调用 `submit_sections` / wiki.json 不可加载时抛出（分类阶段是致命阶段）
 */
export async function runClassifyStage(
  context: BlueprintStageContext,
  options: { merge?: boolean; extraContext?: string } = {},
): Promise<WikiSection[]> {
  const merge = options.merge === true;
  emitStageEvent(context, 'classify', { type: 'requesting' });

  const state = { succeeded: false, error: undefined as string | undefined };
  const tool = trackOutputTool(createSubmitSectionsTool({ merge }), state);

  const result = await runAgentAndSettle(context, {
    key: 'classify',
    stage: 'classify',
    tools: [...EXPLORE_TOOLS, tool],
    prompts: buildClassifyPrompt(options.extraContext),
    forwardErrors: true,
  });

  const blueprint = await loadWikiBlueprint().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`分类阶段未产出有效 wiki.json：${message}`, { cause: err });
  });

  if (!state.succeeded) {
    throw new Error(
      `分类阶段未产出有效 wiki.json：模型未成功调用 submit_sections${state.error ? `（${state.error}）` : ''}`,
    );
  }

  const sections = sectionsFromBlueprint(blueprint);
  logger.info(
    `[classify] 分类完成：${sections.length} 个分类（${Math.round(result.durationMs)}ms）`,
  );
  return sections;
}

/**
 * 阶段 2：分主题（按 section 并发）。
 * 单 section 失败只记录，不抛错、不阻断其余分类。
 */
export async function runTopicsStage(
  context: BlueprintStageContext,
  sections: WikiSection[],
  options: {
    reuseExisting?: boolean;
    /** 追加到主题提示词的规则（sync 用；传函数时可按 section 展开旧页面清单） */
    extraRules?: string | ((section: WikiSection) => string);
  } = {},
): Promise<BlueprintFailedSection[]> {
  const failed: BlueprintFailedSection[] = [];
  if (sections.length === 0) return failed;

  const maxConcurrent = Math.max(1, context.config.concurrency.max_concurrent ?? 1);
  const limit = pLimit(maxConcurrent);
  let completed = 0;

  emitStageEvent(context, 'topics', {
    type: 'requesting',
    progress: { current: 0, total: sections.length },
  });

  const tasks = sections.map((section, index) =>
    limit(async () => {
      const key = `topics:${section.title}`;
      const state = { succeeded: false, error: undefined as string | undefined };
      const tool = trackOutputTool(
        createSubmitSectionTopicsTool(section, { reuseExisting: options.reuseExisting }),
        state,
      );

      emitStageEvent(context, 'topics', {
        type: 'requesting',
        section: section.title,
        progress: { current: completed, total: sections.length },
      });

      try {
        const extraRules =
          typeof options.extraRules === 'function' ? options.extraRules(section) : options.extraRules;

        await runAgentAndSettle(context, {
          key,
          stage: 'topics',
          section: section.title,
          tools: [...EXPLORE_TOOLS, tool],
          prompts: buildTopicsPrompt(section, extraRules),
          progress: { current: completed, total: sections.length },
          forwardErrors: false,
        });

        if (!state.succeeded) {
          failed.push({
            section: section.title,
            stage: 'topics',
            error: state.error ?? '模型未调用 submit_section_topics',
          });
          logger.warn(`[topics] 分类「${section.title}」失败：${state.error ?? '模型未调用工具'}`);
        } else {
          logger.info(`[topics] 分类「${section.title}」完成（${index + 1}/${sections.length}）`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ section: section.title, stage: 'topics', error: message });
        logger.warn(`[topics] 分类「${section.title}」失败：${message}`);
      } finally {
        completed += 1;
        emitStageEvent(context, 'topics', {
          type: 'tool_result',
          section: section.title,
          progress: { current: completed, total: sections.length },
        });
      }
    }),
  );

  await Promise.all(tasks);
  return failed;
}

/**
 * 阶段 3：标题（按 section 并发）。
 * 输入该分类的页面列表；空分类直接跳过。失败保留原 title，只记录。
 */
export async function runTitlesStage(
  context: BlueprintStageContext,
  sections: WikiSection[],
  pages: WikiPage[],
): Promise<BlueprintFailedSection[]> {
  const failed: BlueprintFailedSection[] = [];
  const sectionKeyOf = (value: string): string => value.trim().toLowerCase();

  const targets = sections
    .map((section) => ({
      section,
      pages: pages.filter((page) => sectionKeyOf(page.section) === sectionKeyOf(section.title)),
    }))
    .filter((target) => target.pages.length > 0);

  if (targets.length === 0) return failed;

  const maxConcurrent = Math.max(1, context.config.concurrency.max_concurrent ?? 1);
  const limit = pLimit(maxConcurrent);
  let completed = 0;

  emitStageEvent(context, 'titles', {
    type: 'requesting',
    progress: { current: 0, total: targets.length },
  });

  const tasks = targets.map((target) =>
    limit(async () => {
      const section = target.section;
      const key = `titles:${section.title}`;
      const state = { succeeded: false, error: undefined as string | undefined };
      const tool = trackOutputTool(createRefineSectionTitlesTool(section), state);

      emitStageEvent(context, 'titles', {
        type: 'requesting',
        section: section.title,
        progress: { current: completed, total: targets.length },
      });

      try {
        await runAgentAndSettle(context, {
          key,
          stage: 'titles',
          section: section.title,
          tools: [...TITLE_TOOLS, tool],
          prompts: buildTitlesPrompt(section, target.pages),
          progress: { current: completed, total: targets.length },
          forwardErrors: false,
        });

        if (!state.succeeded) {
          // 标题精修失败不判页失败：保留原 title
          failed.push({
            section: section.title,
            stage: 'titles',
            error: state.error ?? '模型未调用 refine_section_titles',
          });
          logger.warn(`[titles] 分类「${section.title}」失败，保留原标题：${state.error ?? '模型未调用工具'}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ section: section.title, stage: 'titles', error: message });
        logger.warn(`[titles] 分类「${section.title}」失败，保留原标题：${message}`);
      } finally {
        completed += 1;
        emitStageEvent(context, 'titles', {
          type: 'tool_result',
          section: section.title,
          progress: { current: completed, total: targets.length },
        });
      }
    }),
  );

  await Promise.all(tasks);
  return failed;
}
