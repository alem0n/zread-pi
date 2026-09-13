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
    tokenUsageEquals(a.usage, b.usage) &&
    tokenUsageEquals(a.carryUsage, b.carryUsage) &&
    a.durationMs === b.durationMs &&
    a.error === b.error &&
    a.retryCount === b.retryCount &&
    a.maxRetries === b.maxRetries &&
    a.delayMs === b.delayMs
  );
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
  let nextState: CatalogState;

  switch (event.type) {
    case 'scanning':
    case 'parsing':
      // 每轮目录生成的起点：把上一轮的累计快照结转到 carryUsage（重试不清零）
      nextState = carryForward({
        ...state,
        status: 'loading',
        phase: 'scanning',
        error: undefined,
      });
      break;

    case 'requesting':
      nextState = {
        ...state,
        status: 'loading',
        phase: 'requesting',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'responding':
      nextState = {
        ...state,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_start':
      nextState = {
        ...state,
        status: 'loading',
        phase: 'tool',
        currentTool: event.toolName,
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_result':
      nextState = {
        ...state,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'complete':
      nextState = {
        status: 'completed',
        usage: event.usage,
        carryUsage: state.carryUsage,
        durationMs: event.durationMs ?? 0,
      };
      break;

    case 'error':
      nextState = {
        status: 'failed',
        // 失败事件可能不带用量（例如扫描/解析阶段抛错）：保留最后一次已知快照，
        // 否则目录已消耗的 token 会被合计清零。
        usage: event.usage ?? state.usage,
        carryUsage: state.carryUsage,
        error: event.error,
        durationMs: event.durationMs ?? 0,
      };
      break;

    case 'retry':
      nextState = {
        ...state,
        status: 'loading',
        phase: 'retry',
        retryCount: event.retryCount,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        error: event.error,
        // 重试事件同样可能不带用量：保留本轮快照（carryUsage 本来就在 state 里）
        usage: event.usage ?? state.usage,
      };
      break;

    default:
      return state;
  }

  return reuseCatalogStateIfUnchanged(state, nextState);
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
      break;

    case 'requesting':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'requesting',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'responding':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_start':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'tool',
        currentTool: event.toolName,
        usage: event.usage, // 直接使用，不累加
      };
      break;

    case 'tool_result':
      newPageStatus = {
        ...currentStatus,
        status: 'loading',
        phase: 'responding',
        usage: event.usage, // 直接使用，不累加
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
      };
      break;

    case 'page_complete':
      newPageStatus = {
        status: 'completed',
        usage: event.usage, // 直接使用，不累加
        carryUsage: currentStatus.carryUsage,
        durationMs: event.durationMs ?? 0,
        outputPath: event.outputPath,
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
