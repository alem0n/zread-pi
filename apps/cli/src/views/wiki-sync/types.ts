/**
 * Wiki Sync 类型定义
 *
 * 复用 wiki-generate 的 Status、Phase 基础类型，
 * 新增 sync 特有的状态展示。
 */

import type { WikiPage } from '@open-zread/types';
import type { TokenUsage } from '@open-zread/orchestrator';

// Reuse from wiki-generate (imported at usage site)
export type { WikiPage } from '@open-zread/types';
export type { TokenUsage } from '@open-zread/orchestrator';

/** 同步阶段 */
export type SyncPhase = 'detecting' | 'planning' | 'executing';

/** 目录（扫描+规划）状态 */
export interface SyncCatalogState {
  status: 'waiting' | 'loading' | 'completed' | 'failed';
  phase?: SyncPhase;
  /** 发现的变更文件数 */
  changedFiles?: number;
  /** Token 使用统计 */
  usage?: TokenUsage;
  /** 错误信息 */
  error?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
}

/** 单篇同步页面状态（扩展 wiki-generate PageStatus） */
export interface SyncPageState {
  status: 'waiting' | 'loading' | 'completed' | 'failed';
  /** 变更类型（用于 tag 颜色） */
  syncType?: 'new' | 'updated' | 'archived';
  usage?: TokenUsage;
  error?: string;
  durationMs?: number;
  outputPath?: string;
  phase?: 'requesting' | 'responding' | 'tool' | 'retry';
  currentTool?: string;
  retryCount?: number;
  maxRetries?: number;
  delayMs?: number;
}

/** 文章集合状态 */
export interface SyncArticlesState {
  pages: Record<string, SyncPageState>;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
}

/** 同步聚合状态 */
export interface WikiSyncState {
  catalog: SyncCatalogState;
  articles: SyncArticlesState;
  /** 同步页面列表（来自 SyncDiff） */
  syncPages: WikiPage[];
}
