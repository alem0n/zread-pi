/**
 * Blueprint Stages - 结构优先蓝图的阶段驱动器
 *
 * 设计要点（plan §3 / §4）：
 * - 阶段 1「结构」：纯代码，buildStructureCache → 机器骨架落盘（致命失败）；
 * - 阶段 2「分类命名」：单 Agent，submit_sections 只填语义字段；失败用机器默认标题兜底；
 * - 阶段 3「页面命名」：按 section 并发（p-limit），submit_pages 只填语义字段；
 *   单 section 失败记录到 failedSections，不阻断其余。
 *
 * 事件：所有阶段都会在 CatalogEvent 上打 `stage` / `section` / 分类级 `progress`，
 * 并把「所有已结束 + 进行中 Agent」的聚合用量作为 `usage` 上报（供 CLI 展示）。
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
  createLogger,
  buildMachineBlueprint,
  initWikiBlueprint,
  buildStageEvent,
  buildSectionEvent,
  type RunLogWriter,
  type MachinePageEntry,
} from '@zread-pi/utils';
import type { AppConfig, BlueprintDetailLevel, StructureCache, WikiSection } from '@zread-pi/types';
import { createAgent, type AgentResult, type RunLogSink } from './create-agent.js';
import { createRunLogSink } from './run-log-sink.js';
import { createSubmitPagesTool, createSubmitSectionsTool } from '../tools/output-tools.js';
import {
  GetCoreSignaturesTool,
  GetDirectoryTreeTool,
  GetModuleDetailsTool,
} from '../tools/repo-map-tools.js';
import { getDetailSpec } from './blueprint-detail.js';
import {
  machineSectionViews,
  renderSectionsNamingPrompt,
  type MachineSectionView,
} from '../prompts/classify.js';
import {
  machinePageViews,
  renderPagesNamingPrompt,
  type MachinePageView,
} from '../prompts/topics.js';
import type {
  BlueprintFailedSection,
  CatalogAgentRole,
  CatalogAgentStatus,
  CatalogEvent,
  CatalogStage,
} from '../types.js';
import type { RunEventAgentMeta } from '@zread-pi/types';

const structureLogger = createLogger('structure');
const sectionsLogger = createLogger('sections');
const pagesLogger = createLogger('pages');

/** 探索类工具（命名阶段共用：核对切片内容后再命名） */
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

/** 阶段驱动上下文 */
export interface BlueprintStageContext {
  config: AppConfig;
  onEvent?: (event: CatalogEvent) => void;
  usage: BlueprintUsageTracker;
  /** 轨迹日志（可选） */
  runLog?: RunLogWriter;
  /** 写盘变体（档位子目录）：`wiki/<variant>/` */
  variant: BlueprintDetailLevel;
  /** 结构层产物（runStructureStage 写入，命名阶段读取） */
  structure?: StructureCache;
  /** 机器页条目（runStructureStage 写入，页面命名阶段按分类读取） */
  machinePages?: MachinePageEntry[];
}

function bindRunLog(
  runLog: RunLogWriter | undefined,
  agent: Omit<RunEventAgentMeta, 'sessionId'>,
): RunLogSink | undefined {
  return createRunLogSink(runLog, agent);
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

  snapshot(key: string, usage?: TokenUsage): TokenUsage {
    if (usage) this.active.set(key, usage);
    else if (!this.active.has(key)) this.active.set(key, undefined);
    return this.total();
  }

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
  role?: CatalogAgentRole;
  section?: string;
  tools: ToolDefinition[];
  prompts: string;
  progress?: { current: number; total: number };
  /** 单 Agent 出错时是否把 error 事件转发给 UI（结构阶段致命 → 转发；命名阶段 → 不转发） */
  forwardErrors: boolean;
}

/**
 * 运行一个阶段 Agent：事件附上 stage / section / 聚合用量 / Agent 身份，结束时结算用量。
 */
async function runAgentAndSettle(
  context: BlueprintStageContext,
  options: RunAgentOptions,
): Promise<AgentResult> {
  const agentRole: CatalogAgentRole = options.role ?? options.stage;
  const startedAt = Date.now();
  const runLog = bindRunLog(context.runLog, {
    key: options.key,
    role: agentRole,
    ...(options.section !== undefined ? { section: options.section } : {}),
  });
  const own = {
    usage: undefined as TokenUsage | undefined,
    contextTokens: undefined as number | undefined,
    contextWindow: undefined as number | undefined,
  };

  const identity = (status: CatalogAgentStatus) => ({
    agentKey: options.key,
    agentRole,
    agentStatus: status,
    ...(own.usage ? { agentUsage: own.usage } : {}),
    ...(own.contextTokens !== undefined ? { contextTokens: own.contextTokens } : {}),
    ...(own.contextWindow !== undefined ? { contextWindow: own.contextWindow } : {}),
  });

  context.onEvent?.({
    type: 'requesting',
    stage: options.stage,
    ...(options.section !== undefined ? { section: options.section } : {}),
    usage: context.usage.total(),
    ...identity('running'),
  });

  let result: AgentResult | undefined;
  let failure: unknown;

  try {
    result = await createAgent({
      tools: options.tools,
      prompts: options.prompts,
      ...(runLog !== undefined ? { runLog } : {}),
      onEvent: (event) => {
        if (event.usage) own.usage = event.usage;
        if (event.contextTokens !== undefined) own.contextTokens = event.contextTokens;
        if (event.contextWindow !== undefined) own.contextWindow = event.contextWindow;

        const aggregate = context.usage.snapshot(options.key, event.usage);

        if (event.type === 'complete') return;
        if (event.type === 'error' && !options.forwardErrors) return;

        context.onEvent?.({
          ...event,
          stage: options.stage,
          ...(options.section !== undefined ? { section: options.section } : {}),
          usage: aggregate,
          ...identity('running'),
          ...(options.progress ? { progress: options.progress } : {}),
        });
      },
    });
    return result;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    context.usage.settle(options.key, result?.tokenUsage);
    if (result?.tokenUsage) own.usage = result.tokenUsage;
    if (result?.contextTokens !== undefined) own.contextTokens = result.contextTokens;
    if (result?.contextWindow !== undefined) own.contextWindow = result.contextWindow;

    if (result) {
      context.onEvent?.({
        type: 'complete',
        stage: options.stage,
        ...(options.section !== undefined ? { section: options.section } : {}),
        usage: context.usage.total(),
        durationMs: result.durationMs,
        ...identity('completed'),
      });
    } else {
      context.onEvent?.({
        type: 'error',
        stage: options.stage,
        ...(options.section !== undefined ? { section: options.section } : {}),
        usage: context.usage.total(),
        durationMs: Date.now() - startedAt,
        error: failure instanceof Error ? failure.message : String(failure),
        ...identity('failed'),
      });
    }
  }
}

/**
 * 业务层判定某 Agent「未产出有效结果」时的收尾事件。
 */
function markAgentFailed(
  context: BlueprintStageContext,
  options: {
    key: string;
    stage: CatalogStage;
    role?: CatalogAgentRole;
    section?: string;
    error: string;
  },
): void {
  context.onEvent?.({
    type: 'error',
    stage: options.stage,
    ...(options.section !== undefined ? { section: options.section } : {}),
    agentKey: options.key,
    agentRole: options.role ?? options.stage,
    agentStatus: 'failed',
    error: options.error,
  });
}

/** 结构阶段无 pi 会话：单独发一个完成事件（结构阶段不产生 agent_config） */
function emitStructureCompleted(context: BlueprintStageContext, durationMs: number): void {
  context.onEvent?.({
    type: 'complete',
    stage: 'structure',
    usage: context.usage.total(),
    durationMs,
    agentKey: 'structure',
    agentRole: 'structure',
    agentStatus: 'completed',
  });
}

/**
 * 阶段 1：结构（纯代码，无 LLM）。
 *
 * 缓存 → buildStructureCache → 机器骨架（sections + pages + coverage）原子落盘。
 *
 * @throws 结构构建失败（致命，不回退旧路径；D8 / D21）
 */
export async function runStructureStage(
  context: BlueprintStageContext,
): Promise<{ sections: WikiSection[]; pages: MachinePageEntry[] }> {
  const startedAt = Date.now();
  emitStageEvent(context, 'structure', { type: 'requesting', agentStatus: 'waiting' });
  context.runLog?.append(buildStageEvent({ stage: 'structure' }));
  emitStageEvent(context, 'structure', {
    type: 'requesting',
    agentKey: 'structure',
    agentRole: 'structure',
    agentStatus: 'running',
  });

  const { structure } = context;
  if (!structure) {
    const message = '结构层产物缺失，无法生成机器蓝图';
    markAgentFailed(context, { key: 'structure', stage: 'structure', error: message });
    throw new Error(message);
  }

  const spec = getDetailSpec(context.variant);
  const minimal = spec.level === 'minimal';

  const blueprint = buildMachineBlueprint(structure, context.config, { variant: context.variant, minimal });
  await initWikiBlueprint(blueprint, context.config, undefined, { variant: context.variant, minimal });

  context.machinePages = blueprint.pages;

  emitStructureCompleted(context, Math.round(Date.now() - startedAt));
  structureLogger.info(
    `机器骨架已落盘：${blueprint.sections.length} 个分类，${blueprint.pages.length} 个页面`,
  );

  return { sections: blueprint.sections, pages: blueprint.pages };
}

/**
 * 阶段 2：分类命名（单 Agent；minimal 跳过——D16）。
 *
 * 失败 / 未调工具 = 非致命：机器标题兜底，行标 failed，继续。
 *
 * @param onlyIds sync 增量命名：只允许命名这些 id（新增分类）
 */
export async function runSectionsNamingStage(
  context: BlueprintStageContext,
  sections: WikiSection[],
  options: { onlyIds?: Set<string> } = {},
): Promise<WikiSection[]> {
  const spec = getDetailSpec(context.variant);
  if (spec.level === 'minimal') {
    sectionsLogger.info('minimal 档位：跳过分类命名阶段（机器标题兜底）');
    return sections;
  }

  // 每个结构分类的文件数（成员切片的文件数之和；基础分类为 0——它们只持全局槽位）
  const slicesById = new Map((context.structure?.slices ?? []).map((slice) => [slice.id, slice]));
  const fileCountBySection = new Map<string, number>();
  for (const section of sections) {
    fileCountBySection.set(
      section.id ?? '',
      (section.slices ?? []).reduce(
        (sum, sliceId) => sum + (slicesById.get(sliceId)?.files.length ?? 0),
        0,
      ),
    );
  }

  const views: MachineSectionView[] = machineSectionViews(sections, fileCountBySection);

  emitStageEvent(context, 'sections', { type: 'requesting' });
  context.runLog?.append(buildStageEvent({ stage: 'sections' }));
  emitStageEvent(context, 'sections', {
    type: 'requesting',
    agentKey: 'sections',
    agentRole: 'sections',
    agentStatus: 'waiting',
  });

  const state = { succeeded: false, error: undefined as string | undefined };
  const tool = trackOutputTool(
    createSubmitSectionsTool({
      variant: context.variant,
      ...(options.onlyIds ? { onlyIds: options.onlyIds } : {}),
    }),
    state,
  );

  try {
    await runAgentAndSettle(context, {
      key: 'sections',
      stage: 'sections',
      tools: [...EXPLORE_TOOLS, tool],
      prompts: renderSectionsNamingPrompt({ spec, machineSections: views, onlyIds: options.onlyIds }),
      forwardErrors: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sectionsLogger.warn(`分类命名 Agent 报错，使用机器标题兜底：${message}`);
    markAgentFailed(context, { key: 'sections', stage: 'sections', error: message });
    return sections;
  }

  if (!state.succeeded) {
    const message = state.error ?? '模型未调用 submit_sections';
    sectionsLogger.warn(`分类命名失败，使用机器标题兜底：${message}`);
    markAgentFailed(context, { key: 'sections', stage: 'sections', error: message });
    return sections;
  }

  const blueprint = await loadWikiBlueprint(undefined, context.variant).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    sectionsLogger.warn(`分类命名后读回 wiki.json 失败，使用机器标题：${message}`);
    return null;
  });

  if (!blueprint) return sections;
  sectionsLogger.info(`分类命名完成：${blueprint.sections?.length ?? sections.length} 个分类`);
  return blueprint.sections ?? sections;
}

/**
 * 阶段 3：页面命名（按 section 并发；minimal 跳过——D16）。
 *
 * 单 section 失败只记录，不抛错、不阻断其余分类（机器标题已在骨架里）。
 *
 * @param onlyIds sync 增量命名：只允许命名这些页面 id（新增页）
 */
export async function runPagesNamingStage(
  context: BlueprintStageContext,
  sections: WikiSection[],
  options: { onlyIds?: Set<string> } = {},
): Promise<BlueprintFailedSection[]> {
  const failed: BlueprintFailedSection[] = [];
  const spec = getDetailSpec(context.variant);
  if (spec.level === 'minimal') {
    pagesLogger.info('minimal 档位：跳过页面命名阶段（机器标题兜底）');
    return failed;
  }

  const machinePages = context.machinePages ?? [];
  if (machinePages.length === 0 || sections.length === 0) return failed;

  const sectionKeyOf = (value: string): string => value.trim().toLowerCase();
  // 机器页的 section 归属可能已被分类命名阶段改名：slice 页优先按
  // `section.slices` 归属（id 稳定），槽位页回退到 section title 匹配。
  const pagesBySectionTitle = new Map<string, MachinePageEntry[]>();
  for (const entry of machinePages) {
    const sliceId = entry.id.startsWith('slice:') ? entry.id.slice('slice:'.length) : null;
    const owner =
      sliceId !== null
        ? sections.find((section) => (section.slices ?? []).includes(sliceId))
        : undefined;
    const key = sectionKeyOf(owner?.title ?? entry.page.section);
    const list = pagesBySectionTitle.get(key);
    if (list) list.push(entry);
    else pagesBySectionTitle.set(key, [entry]);
  }

  const targets = sections
    .map((section) => ({
      section,
      pages: pagesBySectionTitle.get(sectionKeyOf(section.title)) ?? [],
    }))
    // sync 增量命名时，只保留确有待命名页面的分类（否则命中页的分类会跑空 Agent）
    .filter((target) => {
      if (target.pages.length === 0) return false;
      if (!options.onlyIds) return true;
      return target.pages.some((entry) => options.onlyIds?.has(entry.id));
    });

  if (targets.length === 0) return failed;

  const maxConcurrent = Math.max(1, context.config.concurrency.max_concurrent ?? 1);
  const limit = pLimit(maxConcurrent);
  let completed = 0;

  emitStageEvent(context, 'pages', {
    type: 'requesting',
    progress: { current: 0, total: targets.length },
  });
  context.runLog?.append(buildStageEvent({ stage: 'pages' }));
  for (const target of targets) {
    emitStageEvent(context, 'pages', {
      type: 'requesting',
      section: target.section.title,
      agentKey: `pages:${target.section.title}`,
      agentRole: 'pages',
      agentStatus: 'waiting',
    });
    context.runLog?.append(buildSectionEvent({ section: target.section.title }));
  }

  const tasks = targets.map((target) =>
    limit(async () => {
      const section = target.section;
      const key = `pages:${section.title}`;
      const state = { succeeded: false, error: undefined as string | undefined };
      const views: MachinePageView[] = machinePageViews(target.pages);
      const tool = trackOutputTool(
        createSubmitPagesTool(section.title, target.pages, {
          variant: context.variant,
          ...(options.onlyIds ? { onlyIds: options.onlyIds } : {}),
        }),
        state,
      );

      emitStageEvent(context, 'pages', {
        type: 'requesting',
        section: section.title,
        progress: { current: completed, total: targets.length },
      });

      try {
        await runAgentAndSettle(context, {
          key,
          stage: 'pages',
          section: section.title,
          tools: [...EXPLORE_TOOLS, tool],
          prompts: renderPagesNamingPrompt({
            spec,
            section: section.title,
            machinePages: views,
            onlyIds: options.onlyIds,
          }),
          progress: { current: completed, total: targets.length },
          forwardErrors: false,
        });

        if (!state.succeeded) {
          failed.push({
            section: section.title,
            stage: 'pages',
            error: state.error ?? '模型未调用 submit_pages',
          });
          markAgentFailed(context, {
            key,
            stage: 'pages',
            section: section.title,
            error: state.error ?? '模型未调用 submit_pages',
          });
          pagesLogger.warn(`分类「${section.title}」命名失败，保留机器标题：${state.error ?? '模型未调用工具'}`);
        } else {
          pagesLogger.info(`分类「${section.title}」页面命名完成（${completed + 1}/${targets.length}）`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ section: section.title, stage: 'pages', error: message });
        markAgentFailed(context, { key, stage: 'pages', section: section.title, error: message });
        pagesLogger.warn(`分类「${section.title}」命名失败，保留机器标题：${message}`);
      } finally {
        completed += 1;
        emitStageEvent(context, 'pages', {
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
