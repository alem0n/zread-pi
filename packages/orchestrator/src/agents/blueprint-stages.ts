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
  createLogger,
  mergeSectionTopics,
  mergeWikiSections,
  initWikiSkeleton,
  sectionsFromBlueprint,
  buildStageEvent,
  buildSectionEvent,
  type RunLogWriter,
  type ApplyTitlesResult,
} from '@zread-pi/utils';
import type { AppConfig, BlueprintDetailLevel } from '@zread-pi/types';
import type { WikiPage, WikiSection, WikiTopic } from '@zread-pi/types';
import { createAgent, type AgentResult, type RunLogSink } from './create-agent.js';
import { createRunLogSink } from './run-log-sink.js';
import {
  createRefineSectionTitlesTool,
  createSubmitCondensedSectionsTool,
  createSubmitCondensedTopicsTool,
  createSubmitSectionTopicsTool,
  createSubmitSectionsTool,
  type CondensedSectionCapture,
  type CondensedTopicCapture,
} from '../tools/output-tools.js';
import {
  GetCoreSignaturesTool,
  GetDirectoryTreeTool,
  GetModuleDetailsTool,
} from '../tools/repo-map-tools.js';
import {
  CONDENSE_SYSTEM_PROMPT,
  DEFAULT_CONDENSE_TOKEN_BUDGET,
  QUANTITY_FALLBACK_NOTE,
  buildCondenseSectionTask,
  buildCondenseTopicsTask,
  codeFallbackSections,
  condenseTopicsToMax,
  getDetailSpec,
  type BlueprintDetailSpec,
  type QuantityToolState,
} from './blueprint-detail.js';
import { renderClassifyPrompt } from '../prompts/classify';
import { renderTopicsPrompt, SYNC_TOPICS_RULES } from '../prompts/topics';
import TitlesPrompt from '../prompts/titles';
import type { BlueprintFailedSection, CatalogAgentRole, CatalogAgentStatus, CatalogEvent, CatalogStage } from '../types.js';
import type { RunEventAgentMeta } from '@zread-pi/types';

/** 三个阶段各自的命名 logger（对齐 cordis 日志总线；旧实现的 [classify]/[topics]/[titles] 前缀由名字取代）。 */
const classifyLogger = createLogger('classify');
const topicsLogger = createLogger('topics');
const titlesLogger = createLogger('titles');

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
  /**
   * 轨迹日志（可选）：所有阶段 Agent 的事件都会写入 `<repo>/.zread-pi/runs/<runId>/`。
   * 缺省 = 不记录（由上层 generate / sync 在传入时才启用）。
   */
  runLog?: RunLogWriter;
  /**
   * 写盘变体（档位子目录）：`wiki/<variant>/`。
   */
  variant: BlueprintDetailLevel;
  /**
   * 数量控制档位（缺省 = 配置档位）。
   */
  detail?: BlueprintDetailLevel;
}

/** 把 Agent 身份绑定到 runLog 的 append 上（生成全局唯一 sessionId；缺省 runLog 时返回 undefined） */
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
  /** Agent 角色（缺省 = stage；缩编 subagent 显式传 condense） */
  role?: CatalogAgentRole;
  section?: string;
  tools: ToolDefinition[];
  prompts: string;
  progress?: { current: number; total: number };
  /** 单 Agent 出错时是否把 error 事件转发给 UI（分类阶段致命 → 转发；分类内失败 → 不转发） */
  forwardErrors: boolean;
  /** 覆盖默认系统提示（缩编 subagent 用：纪律 + 任务，不叠加项目上下文） */
  systemPrompt?: string;
  /** 独立小 token 预算（缩编 subagent 用） */
  tokenBudget?: number;
}

/**
 * 运行一个阶段 Agent：事件附上 stage / section / 聚合用量 / Agent 身份，结束时结算用量。
 *
 * 每个 Agent 都会发出三类事件（供 UI 一个 Agent 一行展示）：
 * 1. 运行态（`agentStatus: 'running'`）——开始前一次 + create-agent 的流式事件；
 * 2. 流式中间态——带上该 Agent 自己的累计用量（`agentUsage`）与上下文报表值；
 * 3. 终态（`agentStatus: 'completed' | 'failed'`）——在用量结算进聚合账本后发出，
 *    因此 `usage` 仍是目录级聚合、`agentUsage` 是该 Agent 的最终快照。
 *
 * 终态事件的 `type` 是 `complete` / `error`；调用方（UI）以 `agentKey` 区分
 * 「单个 Agent 完成」与「整个目录完成」。
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
  /** 该 Agent 自己的最新快照（`usage` 事件字段是目录级聚合，不能拿它当行内用量） */
  const own = {
    usage: undefined as TokenUsage | undefined,
    contextTokens: undefined as number | undefined,
    contextWindow: undefined as number | undefined,
  };

  /** Agent 身份 + 行内用量（每个 Agent 一行） */
  const identity = (status: CatalogAgentStatus) => ({
    agentKey: options.key,
    agentRole,
    agentStatus: status,
    ...(own.usage ? { agentUsage: own.usage } : {}),
    ...(own.contextTokens !== undefined ? { contextTokens: own.contextTokens } : {}),
    ...(own.contextWindow !== undefined ? { contextWindow: own.contextWindow } : {}),
  });

  // 开始前发出「运行中」：加载配置 / 建会话的窗口也算在运行态里
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
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      ...(runLog !== undefined ? { runLog } : {}),
      onEvent: (event) => {
        // 该 Agent 自己的快照 / 上下文（不随聚合变化）
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
    // 结算：把该 Agent 的最终用量写进聚合账本（后续事件的聚合值已含它）
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
 *
 * Agent 运行正常结束 ≠ 业务成功（如模型从未调用输出工具）；此时先用
 * `agentStatus: 'failed'` 把该行改为失败，再抛错 / 记 failedSections。
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

/** 当前档位（数量控制用；旧配置 / 非法值已在 validateConfig 回退 high） */
function detailOf(context: BlueprintStageContext): BlueprintDetailLevel {
  return context.detail ?? context.config.blueprint.detail;
}

function buildClassifyPrompt(spec: BlueprintDetailSpec, merge: boolean, extraContext?: string): string {
  return [
    renderClassifyPrompt({ spec, merge }),
    extraContext ? `---\n\n${extraContext}` : '',
    '请先用 Repo Map 工具完成分析，然后调用 submit_sections 提交分类清单。',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** 把 section.scope 渲染成提示词里的边界清单行（无 scope 时返回空数组，旧产物照常） */
function formatScopeLines(scope?: string[]): string[] {
  if (!scope || scope.length === 0) return [];
  return ['- 范围边界（scope）:', ...scope.map((item) => `  - ${item}`)];
}

function buildTopicsPrompt(
  spec: BlueprintDetailSpec,
  section: WikiSection,
  extraRules?: string,
): string {
  return [
    renderTopicsPrompt({ spec }),
    extraRules ?? '',
    '---',
    '',
    '## 当前分类',
    `- 分类: ${section.title}`,
    `- 说明: ${section.description ?? '（无）'}`,
    ...formatScopeLines(section.scope),
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
    ...formatScopeLines(section.scope),
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
 * 数量越界不会致命：输出工具不落盘并回传策略文本（AI 归并），
 * 两次不收敛后由缩编 subagent / 代码兜底完成落盘（永不悬挂）。
 *
 * @param merge - sync 模式：保留既有分类与页面，只合并新增分类。
 * @returns 分类清单（含强制基础分类）
 * @throws 模型从未调用 `submit_sections` / 工具报错且无兜底可用时抛出（分类阶段是致命阶段）
 */
export async function runClassifyStage(
  context: BlueprintStageContext,
  options: { merge?: boolean; extraContext?: string } = {},
): Promise<WikiSection[]> {
  const merge = options.merge === true;
  const spec = getDetailSpec(detailOf(context));
  emitStageEvent(context, 'classify', { type: 'requesting' });
  context.runLog?.append(buildStageEvent({ stage: 'classify' }));
  // 分类 Agent 的等待行（每个 Agent 一行：UI 先建行，再进入运行态）
  emitStageEvent(context, 'classify', {
    type: 'requesting',
    agentKey: 'classify',
    agentRole: 'classify',
    agentStatus: 'waiting',
  });

  const state = { succeeded: false, error: undefined as string | undefined };
  const quantity: QuantityToolState<WikiSection[]> = {
    called: false,
    persisted: false,
    outOfRange: 0,
    exhausted: false,
  };
  const tool = trackOutputTool(
    createSubmitSectionsTool({ merge, detail: spec.level, variant: context.variant, state: quantity }),
    state,
  );

  const result = await runAgentAndSettle(context, {
    key: 'classify',
    stage: 'classify',
    tools: [...EXPLORE_TOOLS, tool],
    prompts: buildClassifyPrompt(spec, merge, options.extraContext),
    forwardErrors: true,
  });

  const failureMessage = `分类阶段未产出有效 wiki.json：模型未成功调用 submit_sections${state.error ? `（${state.error}）` : ''}`;
  if (!quantity.called) {
    // Agent 运行可能正常结束（模型只是没调工具）：行内状态以业务判定为准
    markAgentFailed(context, { key: 'classify', stage: 'classify', error: failureMessage });
    throw new Error(failureMessage);
  }
  if (!quantity.persisted) {
    if (quantity.outOfRange === 0) {
      markAgentFailed(context, { key: 'classify', stage: 'classify', error: failureMessage });
      throw new Error(failureMessage);
    }
    await persistSectionsAfterQuantityFailure(context, quantity, { merge, spec });
  }

  const blueprint = await loadWikiBlueprint(undefined, context.variant).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`分类阶段未产出有效 wiki.json：${message}`, { cause: err });
  });

  const sections = sectionsFromBlueprint(blueprint);
  classifyLogger.info(
    `分类完成：${sections.length} 个分类，档位 ${spec.level}（${Math.round(result.durationMs)}ms）`,
  );
  return sections;
}

/** 读取某个分类下既有页面的标题（sync 代码兜底时优先保留旧页面用） */
async function loadSectionPageTitles(
  sectionTitle: string,
  variant: BlueprintDetailLevel,
): Promise<string[]> {
  const blueprint = await loadWikiBlueprint(undefined, variant);
  const key = sectionTitle.trim().toLowerCase();
  return blueprint.pages
    .filter((page) => page.section.trim().toLowerCase() === key)
    .map((page) => page.title);
}

/**
 * 第 3 轮：缩编 subagent（干净上下文、只看清单本身、一次性只读输出工具）。
 * 失败（未调用工具 / 报错 / 空结果）静默返回 null，由调用方走代码兜底。
 */
async function runSectionCondenseAgent(
  context: BlueprintStageContext,
  payload: WikiSection[],
  options: { merge: boolean; spec: BlueprintDetailSpec },
): Promise<WikiSection[] | null> {
  const captured: CondensedSectionCapture = {};
  const tool = createSubmitCondensedSectionsTool(captured);
  try {
    await runAgentAndSettle(context, {
      key: 'condense:classify',
      stage: 'classify',
      role: 'condense',
      tools: [tool],
      prompts: buildCondenseSectionTask({
        spec: options.spec,
        sections: payload,
        sync: options.merge,
      }),
      systemPrompt: CONDENSE_SYSTEM_PROMPT,
      tokenBudget: DEFAULT_CONDENSE_TOKEN_BUDGET,
      forwardErrors: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    classifyLogger.warn(`缩编 subagent 失败，降级为代码兜底：${message}`);
    return null;
  }
  return captured.sections && captured.sections.length > 0 ? captured.sections : null;
}

/**
 * 分类数量未收敛后的收尾：缩编 subagent → 代码确定性兜底，随后必须落盘（永不悬挂）。
 */
async function persistSectionsAfterQuantityFailure(
  context: BlueprintStageContext,
  quantity: QuantityToolState<WikiSection[]>,
  options: { merge: boolean; spec: BlueprintDetailSpec },
): Promise<void> {
  const language = context.config.doc_language;
  const payload = quantity.lastPayload ?? [];

  let sections: WikiSection[] | null = null;
  let via: 'condense' | 'code' = 'code';

  if (payload.length > 0) {
    sections = await runSectionCondenseAgent(context, payload, options);
    if (sections) via = 'condense';
  }

  if (!sections) {
    let existing: WikiSection[] | null = null;
    if (options.merge) {
      const current = await loadWikiBlueprint(undefined, context.variant).catch(() => null);
      existing = current ? current.sections ?? sectionsFromBlueprint(current) : null;
    }
    sections = codeFallbackSections({ input: payload, language, spec: options.spec, existing });
    quantity.lastNote = QUANTITY_FALLBACK_NOTE;
  } else {
    quantity.lastNote = '（缩编 subagent 收敛）';
  }

  if (options.merge) {
    await mergeWikiSections(sections, context.config, {
      limit: options.spec.sections.max,
      minimal: options.spec.level === 'minimal',
      variant: context.variant,
    });
  } else {
    await initWikiSkeleton(sections, context.config, undefined, {
      limit: options.spec.sections.max,
      minimal: options.spec.level === 'minimal',
      variant: context.variant,
    });
  }

  quantity.persisted = true;
  quantity.lastPayload = sections;
  quantity.lastCount = sections.length;
  classifyLogger.warn(
    `数量越界 ${quantity.outOfRange} 次后由${via === 'condense' ? '缩编 subagent' : '代码兜底'}收尾：` +
      `${sections.length} 个分类 ${quantity.lastNote ?? ''}`,
  );
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

  const spec = getDetailSpec(detailOf(context));
  const maxConcurrent = Math.max(1, context.config.concurrency.max_concurrent ?? 1);
  const limit = pLimit(maxConcurrent);
  let completed = 0;

  emitStageEvent(context, 'topics', {
    type: 'requesting',
    progress: { current: 0, total: sections.length },
  });
  context.runLog?.append(buildStageEvent({ stage: 'topics' }));
  // 每个分类一个 Agent 行（waiting）：并发槽位未到时 UI 也能看到完整清单
  for (const section of sections) {
    emitStageEvent(context, 'topics', {
      type: 'requesting',
      section: section.title,
      agentKey: `topics:${section.title}`,
      agentRole: 'topics',
      agentStatus: 'waiting',
    });
    context.runLog?.append(buildSectionEvent({ section: section.title }));
  }

  const tasks = sections.map((section, index) =>
    limit(async () => {
      const key = `topics:${section.title}`;
      const state = { succeeded: false, error: undefined as string | undefined };
      const quantity: QuantityToolState<WikiTopic[]> = {
        called: false,
        persisted: false,
        outOfRange: 0,
        exhausted: false,
      };
      const tool = trackOutputTool(
        createSubmitSectionTopicsTool(section, {
          reuseExisting: options.reuseExisting,
          detail: spec.level,
          variant: context.variant,
          state: quantity,
        }),
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
          prompts: buildTopicsPrompt(spec, section, extraRules),
          progress: { current: completed, total: sections.length },
          forwardErrors: false,
        });

        if (!quantity.called || !quantity.persisted) {
          if (quantity.outOfRange > 0) {
            // 越界未落盘：缩编 subagent → 代码兜底（单分类失败不影响其余）
            const settled = await persistTopicsAfterQuantityFailure(context, section, quantity, {
              reuseExisting: options.reuseExisting,
              spec,
            });
            if (settled) {
              topicsLogger.info(`分类「${section.title}」完成（数量越界后收尾，${index + 1}/${sections.length}）`);
              return;
            }
          }
          failed.push({
            section: section.title,
            stage: 'topics',
            error: state.error ?? '模型未调用 submit_section_topics',
          });
          markAgentFailed(context, {
            key,
            stage: 'topics',
            section: section.title,
            error: state.error ?? '模型未调用 submit_section_topics',
          });
          topicsLogger.warn(`分类「${section.title}」失败：${state.error ?? '模型未调用工具'}`);
        } else {
          topicsLogger.info(`分类「${section.title}」完成（${index + 1}/${sections.length}）`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (quantity.persisted) {
          // Agent 在落盘后失败（例如预算耗尽于收尾读秒）：产物已在，不算失败
          topicsLogger.warn(`分类「${section.title}」已落盘但 Agent 报错：${message}`);
        } else {
          failed.push({ section: section.title, stage: 'topics', error: message });
          markAgentFailed(context, { key, stage: 'topics', section: section.title, error: message });
          topicsLogger.warn(`分类「${section.title}」失败：${message}`);
        }
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

/** 第 3 轮：主题缩编 subagent（干净上下文、一次性只读输出工具） */
async function runTopicsCondenseAgent(
  context: BlueprintStageContext,
  section: WikiSection,
  payload: WikiTopic[],
  options: { reuseExisting?: boolean; spec: BlueprintDetailSpec },
): Promise<WikiTopic[] | null> {
  const captured: CondensedTopicCapture = {};
  const tool = createSubmitCondensedTopicsTool(section, captured);
  try {
    await runAgentAndSettle(context, {
      key: `condense:topics:${section.title}`,
      stage: 'topics',
      role: 'condense',
      section: section.title,
      tools: [tool],
      prompts: buildCondenseTopicsTask({
        spec: options.spec,
        section: section.title,
        topics: payload,
        sync: options.reuseExisting === true,
      }),
      systemPrompt: CONDENSE_SYSTEM_PROMPT,
      tokenBudget: DEFAULT_CONDENSE_TOKEN_BUDGET,
      forwardErrors: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    topicsLogger.warn(`分类「${section.title}」缩编 subagent 失败，降级为代码兜底：${message}`);
    return null;
  }
  return captured.topics && captured.topics.length > 0 ? captured.topics : null;
}

/**
 * 分类主题数量未收敛后的收尾：缩编 subagent → 代码兜底，随后落盘。
 * @returns 是否成功落盘（失败不抛错，由调用方记 failedSections）
 */
async function persistTopicsAfterQuantityFailure(
  context: BlueprintStageContext,
  section: WikiSection,
  quantity: QuantityToolState<WikiTopic[]>,
  options: { reuseExisting?: boolean; spec: BlueprintDetailSpec },
): Promise<boolean> {
  const payload = quantity.lastPayload ?? [];
  let topics: WikiTopic[] | null = null;
  let via: 'condense' | 'code' = 'code';

  if (payload.length > 0) {
    topics = await runTopicsCondenseAgent(context, section, payload, options);
    if (topics) via = 'condense';
  }

  if (!topics) {
    const preserveTitles =
      options.reuseExisting === true
        ? await loadSectionPageTitles(section.title, context.variant).catch(() => [])
        : [];
    topics = condenseTopicsToMax(payload, options.spec.topics.max, { preserveTitles });
    quantity.lastNote = QUANTITY_FALLBACK_NOTE;
  } else {
    quantity.lastNote = '（缩编 subagent 收敛）';
  }

  try {
    await mergeSectionTopics(section, topics, {
      reuseExisting: options.reuseExisting,
      variant: context.variant,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    topicsLogger.warn(`分类「${section.title}」兜底落盘失败：${message}`);
    return false;
  }

  quantity.persisted = true;
  quantity.lastPayload = topics;
  quantity.lastCount = topics.length;
  topicsLogger.warn(
    `分类「${section.title}」数量越界 ${quantity.outOfRange} 次后由` +
      `${via === 'condense' ? '缩编 subagent' : '代码兜底'}收尾：${topics.length} 篇 ${quantity.lastNote ?? ''}`,
  );
  return true;
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

  // low / minimal 档位跳过标题精修（最便宜但砍掉无质量风险）
  const spec = getDetailSpec(detailOf(context));
  if (!spec.refineTitles) {
    titlesLogger.info(`档位 ${spec.level}：跳过标题精修阶段`);
    return failed;
  }

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
  context.runLog?.append(buildStageEvent({ stage: 'titles' }));
  // 每个有页面的分类一个标题 Agent 行（waiting）
  for (const target of targets) {
    emitStageEvent(context, 'titles', {
      type: 'requesting',
      section: target.section.title,
      agentKey: `titles:${target.section.title}`,
      agentRole: 'titles',
      agentStatus: 'waiting',
    });
    context.runLog?.append(buildSectionEvent({ section: target.section.title }));
  }

  const tasks = targets.map((target) =>
    limit(async () => {
      const section = target.section;
      const key = `titles:${section.title}`;
      const state = { succeeded: false, error: undefined as string | undefined };
      let applied: ApplyTitlesResult | undefined;
      const tool = trackOutputTool(
          createRefineSectionTitlesTool(section, {
            variant: context.variant,
            expectedSlugs: target.pages.map((page) => page.slug),
            onResult: (result) => {
              applied = result;
            },
          }),
          state,
        );

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
          markAgentFailed(context, {
            key,
            stage: 'titles',
            section: section.title,
            error: state.error ?? '模型未调用 refine_section_titles',
          });
          titlesLogger.warn(`分类「${section.title}」失败，保留原标题：${state.error ?? '模型未调用工具'}`);
        } else {
          // 重写率统计（plan.md §3.5）：诊断信号触发后标题被改写的比例，用于验证诊断段是否起作用
          const total = target.pages.length;
          const rewritten = applied?.updated ?? 0;
          const rate = total > 0 ? Math.round((rewritten / total) * 100) : 0;
          titlesLogger.info(
            `分类「${section.title}」标题重写率：${rewritten}/${total}（${rate}%，跳过 ${applied?.skipped ?? 0}，未知 ${applied?.unknown ?? 0}）`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ section: section.title, stage: 'titles', error: message });
        markAgentFailed(context, { key, stage: 'titles', section: section.title, error: message });
        titlesLogger.warn(`分类「${section.title}」失败，保留原标题：${message}`);
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
