/**
 * 事件→状态映射（纯函数）
 *
 * 核心原则：
 * - 输入状态 + 事件 → 输出新状态
 * - 无副作用，易于测试
 *
 * 注意：SDK 的 usage 已经是累积总量，不需要再累加
 */

import type { ArticleEventPayload, TokenUsage } from '@zread-pi/orchestrator';
import { sumTokenUsage } from '@zread-pi/agent-runtime';
import type {
  CatalogAgentState,
  CatalogState,
  ArticlesState,
  PageStatus,
  CatalogEventPayload,
} from './types';
import { initialPageStatus } from './state';

/**
 * 一轮运行开始时把上一轮的累计快照结转到 `carryUsage`（展示口径 = carryUsage + usage）。
 *
 * 幂等：调用两次时第二次的 `usage` 已为 undefined，结转结果不变。
 * 这样重试/重新生成只会重置「本轮快照」，不会丢掉已消耗的历史用量。
 */
function carryForward<T extends { usage?: TokenUsage; carryUsage?: TokenUsage }>(state: T): T {
  return {
    ...state,
    carryUsage: sumTokenUsage([state.carryUsage, state.usage]),
    usage: undefined,
  };
}

function tokenUsageEquals(a?: TokenUsage, b?: TokenUsage): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  return (
    a.input_tokens === b.input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens &&
    a.cache_read_input_tokens === b.cache_read_input_tokens
  );
}

function catalogStateEquals(a: CatalogState, b: CatalogState): boolean {
  return (
    a.status === b.status &&
    a.phase === b.phase &&
    a.currentTool === b.currentTool &&
    a.stage === b.stage &&
    a.section === b.section &&
    a.sectionsProgress?.current === b.sectionsProgress?.current &&
    a.sectionsProgress?.total === b.sectionsProgress?.total &&
    (a.failedSections ?? null) === (b.failedSections ?? null) &&
    agentsEqual(a.agents, b.agents) &&
    tokenUsageEquals(a.usage, b.usage) &&
    tokenUsageEquals(a.carryUsage, b.carryUsage) &&
    a.durationMs === b.durationMs &&
    a.error === b.error &&
    a.retryCount === b.retryCount &&
    a.maxRetries === b.maxRetries &&
    a.delayMs === b.delayMs
  );
}

function agentStateEquals(a: CatalogAgentState, b: CatalogAgentState): boolean {
  return (
    a.status === b.status &&
    a.stage === b.stage &&
    a.role === b.role &&
    a.section === b.section &&
    a.phase === b.phase &&
    a.currentTool === b.currentTool &&
    tokenUsageEquals(a.usage, b.usage) &&
    a.contextTokens === b.contextTokens &&
    a.contextWindow === b.contextWindow &&
    a.durationMs === b.durationMs &&
    a.error === b.error &&
    a.retryCount === b.retryCount &&
    a.maxRetries === b.maxRetries &&
    a.delayMs === b.delayMs
  );
}

function agentsEqual(
  a?: Record<string, CatalogAgentState>,
  b?: Record<string, CatalogAgentState>,
): boolean {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const left = a?.[key];
    const right = b?.[key];
    return left !== undefined && right !== undefined && agentStateEquals(left, right);
  });
}

/** 事件 → 单个 Agent 行的状态（`agentStatus` 缺省按事件类型推断；running 映射为展示态的 loading） */
function agentStatusFor(event: CatalogEventPayload): CatalogAgentState['status'] {
  switch (event.agentStatus) {
    case 'running':
      return 'loading';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      break;
  }
  if (event.type === 'complete') return 'completed';
  if (event.type === 'error') return 'failed';
  return 'loading';
}

/** 事件类型 → Agent 行内的阶段（终态 / 计划态没有 phase） */
function agentPhaseFor(event: CatalogEventPayload): CatalogAgentState['phase'] {
  switch (event.type) {
    case 'requesting':
      return 'requesting';
    case 'responding':
      return 'responding';
    case 'tool_start':
      return 'tool';
    case 'tool_result':
      return 'responding';
    case 'retry':
      return 'retry';
    default:
      return undefined;
  }
}

/**
 * 把「某个 Agent 的事件」写进行状态表（每个 Agent 一行）。
 *
 * - `usage` 是目录级聚合，行内用量取 `agentUsage`（该 Agent 自己的累计快照）；
 * - 终态事件可能不带 phase / 工具 / 上下文：用行内旧值兼底；
 * - 已终态的行不被后续 running 事件倒推回 loading（安全网，正常时序不会发生）；
 * - 无变化时返回原 state（保持引用相等语义）。
 */
function applyAgentEvent(state: CatalogState, event: CatalogEventPayload): CatalogState {
  const key = event.agentKey;
  if (!key) return state;

  const existing = state.agents?.[key];
  const incoming = agentStatusFor(event);
  const status =
    existing && (existing.status === 'completed' || existing.status === 'failed') && incoming === 'loading'
      ? existing.status
      : incoming;
  const phase = agentPhaseFor(event);

  const next: CatalogAgentState = {
    ...(existing ?? {}),
    status,
    stage: event.stage ?? existing?.stage ?? 'classify',
    role: event.agentRole ?? existing?.role ?? 'classify',
    ...(event.section !== undefined ? { section: event.section } : {}),
    ...(event.agentUsage ? { usage: event.agentUsage } : {}),
    ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
    ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.retryCount !== undefined ? { retryCount: event.retryCount } : {}),
    ...(event.maxRetries !== undefined ? { maxRetries: event.maxRetries } : {}),
    ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
    ...(event.toolName !== undefined ? { currentTool: event.toolName } : {}),
    ...(phase !== undefined ? { phase } : {}),
  };

  if (existing && agentStateEquals(existing, next)) return state;

  return { ...state, agents: { ...(state.agents ?? {}), [key]: next } };
}

/**
 * 三阶段附加字段：stage / section / 分类级进度 / 失败分类。
 * 无变化时返回原状态（保持 mapper 的引用相等语义）。
 */
function applyStageFields(state: CatalogState, event: CatalogEventPayload): CatalogState {
  const needsStage = event.stage !== undefined && state.stage !== event.stage;
  const needsSection = event.section !== undefined && state.section !== event.section;
  const needsProgress =
    event.progress !== undefined &&
    event.stage !== undefined &&
    (state.sectionsProgress?.current !== event.progress.current ||
      state.sectionsProgress?.total !== event.progress.total);
  const needsFailed =
    event.failedSections !== undefined && state.failedSections !== event.failedSections;

  if (!needsStage && !needsSection && !needsProgress && !needsFailed) return state;

  return {
    ...state,
    ...(needsStage ? { stage: event.stage } : {}),
    ...(needsSection ? { section: event.section } : {}),
    ...(needsProgress ? { sectionsProgress: { ...event.progress! } } : {}),
    ...(needsFailed ? { failedSections: event.failedSections } : {}),
  };
}

function reuseCatalogStateIfUnchanged(
  state: CatalogState,
  nextState: CatalogState
): CatalogState {
  return catalogStateEquals(state, nextState) ? state : nextState;
}

function pageStatusEquals(a: PageStatus, b: PageStatus): boolean {
  return (
    a.status === b.status &&
    a.phase === b.phase &&
    a.currentTool === b.currentTool &&
    tokenUsageEquals(a.usage, b.usage) &&
    tokenUsageEquals(a.carryUsage, b.carryUsage) &&
    a.contextTokens === b.contextTokens &&
    a.contextWindow === b.contextWindow &&
    a.durationMs === b.durationMs &&
    a.error === b.error &&
    a.outputPath === b.outputPath &&
    a.retryCount === b.retryCount &&
    a.maxRetries === b.maxRetries &&
    a.delayMs === b.delayMs
  );
}

// ==================== 目录状态转换 ====================

/**
 * 目录事件 → 状态转换（纯函数）
 *
 * @param state - 当前目录状态
 * @param event - 目录事件 payload
 * @returns 新目录状态
 *
 * 注意：usage 直接使用 SDK 返回值（已是累积总量）
 */
export function catalogEventToState(
  state: CatalogState,
  event: CatalogEventPayload
): CatalogState {
  // 先写「每个 Agent 一行」的行状态（无 agentKey 的事件原样返回）
  const base = applyAgentEvent(state, event);

  // 单个 Agent 的终态事件（带 agentKey 的 complete / error）：只反映该行，
  // 不改目录整体状态（目录整体的 complete / error 由不带 agentKey 的事件发出）。
  if (event.agentKey && (event.type === 'complete' || event.type === 'error')) {
    const nextState: CatalogState = event.usage ? { ...base, usage: event.usage } : base;
    return reuseCatalogStateIfUnchanged(state, applyStageFields(nextState, event));
  }

  let nextState: CatalogState;

  switch (event.type) {
    case 'scanning':
    case 'parsing':
      // 每轮目录生成的起点：把上一轮的累计快照结转到 carryUsage（重试不清零）。
      // 行状态表同时清空：新一轮会重新规划 Agent（用量已进聚合 carryUsage）。
      nextState = carryForward({
        ...base,
        status: 'loading',
        phase: 'scanning',
        error: undefined,
        // 新一轮从分类开始：清空上一轮残留的阶段展示
        stage: undefined,
        section: undefined,
        sectionsProgress: undefined,
        failedSections: undefined,
        agents: {},
      });
      break;

    case 'requesting':
      nextState = {
        ...base,
        status: 'loading',
        phase: 'requesting',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'responding':
      nextState = {
        ...base,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_start':
      nextState = {
        ...base,
        status: 'loading',
        phase: 'tool',
        currentTool: event.toolName,
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_result':
      nextState = {
        ...base,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'complete':
      nextState = {
        ...base,
        status: 'completed',
        usage: event.usage,
        carryUsage: base.carryUsage,
        durationMs: event.durationMs ?? 0,
      };
      break;

    case 'error':
      nextState = {
        ...base,
        status: 'failed',
        // 失败事件可能不带用量（例如扫描/解析阶段抛错）：保留最后一次已知快照，
        // 否则目录已消耗的 token 会被合计清零。
        usage: event.usage ?? base.usage,
        carryUsage: base.carryUsage,
        error: event.error,
        durationMs: event.durationMs ?? 0,
      };
      break;

    case 'retry':
      nextState = {
        ...base,
        status: 'loading',
        phase: 'retry',
        retryCount: event.retryCount,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        error: event.error,
        // 重试事件同样可能不带用量：保留本轮快照（carryUsage 本来就在 state 里）
        usage: event.usage ?? base.usage,
      };
      break;

    default:
      return state;
  }

  return reuseCatalogStateIfUnchanged(state, applyStageFields(nextState, event));
}

// ==================== 文章状态转换 ====================

/**
 * 文章事件 → 状态转换（纯函数）
 *
 * @param state - 当前文章集合状态
 * @param event - 文章事件 payload
 * @returns 新文章集合状态
 *
 * 注意：usage 直接使用 SDK 返回值（已是累积总量）
 */
export function articleEventToState(
  state: ArticlesState,
  event: ArticleEventPayload
): ArticlesState {
  // 获取当前页面状态
  const currentStatus = state.pages[event.slug] || initialPageStatus;

  // 上下文报表值（已用 / 窗口）只随「最近一次响应」更新；
  // 事件未带时沿用旧值（终态 / 重试事件能继续显示上一次的上下文状态）。
  // 注意：page_start（新一轮）不使用该 patch，因此重新生成会清零。
  const contextPatch = {
    contextTokens: event.contextTokens ?? currentStatus.contextTokens,
    contextWindow: event.contextWindow ?? currentStatus.contextWindow,
  };

  // 计算新页面状态（usage 直接使用，不累加）
  let newPageStatus: PageStatus;

  switch (event.type) {
    case 'page_start':
      // 每轮页面生成的起点：把上一轮（成功/失败/重试）的累计快照结转到 carryUsage
      newPageStatus = carryForward({
        ...initialPageStatus,
        status: 'loading',
        phase: 'requesting',
        carryUsage: currentStatus.carryUsage,
        usage: currentStatus.usage,
      });
      // 新一轮的上下文从零开始（不沿用上一轮的报表值）
      break;

    case 'requesting':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'requesting',
        usage: event.usage, // 直接使用，不累加
        ...contextPatch,
      };
      break;

    case 'responding':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
        ...contextPatch,
      };
      break;

    case 'tool_start':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'tool',
        currentTool: event.toolName,
        usage: event.usage, // 直接使用，不累加
        ...contextPatch,
      };
      break;

    case 'tool_result':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
        ...contextPatch,
      };
      break;

    case 'retry':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'retry',
        retryCount: event.retryCount,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        error: event.error,
        usage: event.usage ?? currentStatus.usage,
        ...contextPatch,
      };
      break;

    case 'page_complete':
      newPageStatus = {
        status: 'completed',
        usage: event.usage, // 直接使用，不累加
        carryUsage: currentStatus.carryUsage,
        durationMs: event.durationMs ?? 0,
        outputPath: event.outputPath,
        ...contextPatch,
      };
      break;

    case 'page_error':
      newPageStatus = {
        status: 'failed',
        // 同目录错误：失败事件不带用量时沿用该页最后一次快照（失败页也要计入合计）
        usage: event.usage ?? currentStatus.usage,
        carryUsage: currentStatus.carryUsage,
        error: event.error,
        durationMs: event.durationMs ?? 0,
        ...contextPatch,
      };
      break;

    default:
      return state;
  }

  // 计算统计变化
  const oldStatus = currentStatus.status;
  const newStatus = newPageStatus.status;

  let completedCount = state.completedCount;
  let failedCount = state.failedCount;
  let pendingCount = state.pendingCount;

  // 状态变化时更新计数
  if (oldStatus !== newStatus) {
    if (oldStatus === 'waiting' || oldStatus === 'loading') {
      pendingCount--;
    }
    if (newStatus === 'completed') {
      completedCount++;
    }
    if (newStatus === 'failed') {
      failedCount++;
    }
  }

  const nextState = {
    ...state,
    pages: { ...state.pages, [event.slug]: newPageStatus },
    currentPageSlug:
      event.type === 'page_start' ? event.slug : state.currentPageSlug,
    completedCount,
    failedCount,
    pendingCount,
  };

  if (
    pageStatusEquals(currentStatus, newPageStatus) &&
    nextState.currentPageSlug === state.currentPageSlug &&
    nextState.completedCount === state.completedCount &&
    nextState.failedCount === state.failedCount &&
    nextState.pendingCount === state.pendingCount
  ) {
    return state;
  }

  return nextState;
}
