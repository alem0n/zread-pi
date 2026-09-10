/**
 * 同步事件 → 状态映射（纯函数）
 *
 * 核心原则：
 * - 无副作用
 * - 与 wiki-generate/mapper.ts 共享基础事件映射逻辑
 */

import type { ArticleEventPayload, TokenUsage } from '@open-zread/orchestrator';
import type { SyncCatalogState, SyncArticlesState, SyncPageState } from './types';
import { initialSyncPageState } from './state';

// ——— 目录状态映射 ———

export type SyncCatalogEventType =
  | 'scanning'
  | 'parsing'
  | 'requesting'
  | 'responding'
  | 'tool_start'
  | 'tool_result'
  | 'complete'
  | 'error'
  | 'retry';

export interface SyncCatalogEventPayload {
  type: SyncCatalogEventType;
  toolName?: string;
  usage?: TokenUsage;
  error?: string;
  durationMs?: number;
  retryCount?: number;
  maxRetries?: number;
  delayMs?: number;
}

export function syncCatalogEventToState(
  state: SyncCatalogState,
  event: SyncCatalogEventPayload
): SyncCatalogState {
  switch (event.type) {
    case 'scanning':
    case 'parsing':
      return { ...state, status: 'loading', phase: 'detecting' };
    case 'requesting':
      return { ...state, status: 'loading', phase: 'planning', usage: event.usage };
    case 'responding':
      return { ...state, status: 'loading', phase: 'planning', usage: event.usage };
    case 'tool_start':
      return { ...state, status: 'loading', phase: 'planning', usage: event.usage };
    case 'tool_result':
      return { ...state, status: 'loading', phase: 'planning', usage: event.usage };
    case 'complete':
      return { status: 'completed', usage: event.usage, durationMs: event.durationMs ?? 0 };
    case 'error':
      return { status: 'failed', error: event.error, usage: event.usage, durationMs: event.durationMs ?? 0 };
    case 'retry':
      return { ...state, status: 'loading', phase: 'planning', usage: event.usage };
    default:
      return state;
  }
}

// ——— 文章状态映射（与 wiki-generate mapper 逻辑一致，额外保留 syncType） ———

export function syncArticleEventToState(
  state: SyncArticlesState,
  event: ArticleEventPayload
): SyncArticlesState {
  const currentStatus = state.pages[event.slug] || initialSyncPageState;

  let newPageStatus: SyncPageState;

  switch (event.type) {
    case 'page_start':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'requesting' };
      break;
    case 'requesting':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'requesting', usage: event.usage };
      break;
    case 'responding':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'responding', usage: event.usage };
      break;
    case 'tool_start':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'tool', currentTool: event.toolName, usage: event.usage };
      break;
    case 'tool_result':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'responding', usage: event.usage };
      break;
    case 'retry':
      newPageStatus = { ...currentStatus, status: 'loading', phase: 'retry', retryCount: event.retryCount, maxRetries: event.maxRetries, delayMs: event.delayMs, error: event.error, usage: event.usage };
      break;
    case 'page_complete':
      newPageStatus = { status: 'completed', syncType: currentStatus.syncType, usage: event.usage, durationMs: event.durationMs ?? 0, outputPath: event.outputPath };
      break;
    case 'page_error':
      newPageStatus = { status: 'failed', syncType: currentStatus.syncType, error: event.error, usage: event.usage, durationMs: event.durationMs ?? 0 };
      break;
    default:
      return state;
  }

  const oldStatus = currentStatus.status;
  const newStatus = newPageStatus.status;

  let completedCount = state.completedCount;
  let failedCount = state.failedCount;
  let pendingCount = state.pendingCount;

  if (oldStatus !== newStatus) {
    if (oldStatus === 'waiting' || oldStatus === 'loading') pendingCount--;
    if (newStatus === 'completed') completedCount++;
    if (newStatus === 'failed') failedCount++;
  }

  return {
    ...state,
    pages: { ...state.pages, [event.slug]: newPageStatus },
    completedCount,
    failedCount,
    pendingCount,
  };
}
