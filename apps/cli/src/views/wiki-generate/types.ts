/**
 * Wiki Generate 类型定义
 *
 * 架构设计：
 * - 基础类型：Status、Phase
 * - 目录状态：CatalogState
 * - 文章状态：PageStatus、ArticlesState
 * - 聚合状态：WikiGenerateState
 */

import type { WikiPage } from '@zread-pi/types';
import type { TokenUsage, BlueprintFailedSection } from '@zread-pi/orchestrator';

// ==================== 基础状态类型 ====================

/** 统一状态枚举 */
export type Status = 'waiting' | 'loading' | 'completed' | 'failed';

/** 蓝图三阶段（分类 → 分主题 → 标题） */
export type CatalogStage = 'classify' | 'topics' | 'titles';

/** 目录生成阶段 */
export type CatalogPhase = 'scanning' | 'requesting' | 'responding' | 'tool' | 'retry';

/** 文章生成阶段 */
export type ArticlePhase = 'requesting' | 'responding' | 'tool' | 'retry';

/** 文章事件类型 */
export type ArticleEventType =
  | 'page_start'
  | 'requesting'
  | 'responding'
  | 'tool_start'
  | 'tool_result'
  | 'page_complete'
  | 'page_error';

// ==================== 导出外部类型 ====================

export type { WikiPage } from '@zread-pi/types';
export type { TokenUsage, ArticleEventPayload, BlueprintFailedSection } from '@zread-pi/orchestrator';

// ==================== 目录状态 ====================

/** 目录生成状态 */
export interface CatalogState {
  status: Status;
  phase?: CatalogPhase;
  /** 当前工具名（tool 阶段） */
  currentTool?: string;
  /** 当前蓝图阶段（分类 → 分主题 → 标题） */
  stage?: CatalogStage;
  /** 当前处理的分类（topics / titles 阶段） */
  section?: string;
  /** 当前阶段的分类级进度 */
  sectionsProgress?: { current: number; total: number };
  /** 分主题 / 标题阶段失败的分类 */
  failedSections?: BlueprintFailedSection[];
  /** Token 使用统计（本轮运行的累计快照） */
  usage?: TokenUsage;
  /**
   * 历史轮次已消耗的累计用量（重新生成时把上一轮的 `usage` 结转到此处）。
   * 展示口径 = `carryUsage + usage`，因此重试/重新生成**不会**把已消耗的 token 清零。
   */
  carryUsage?: TokenUsage;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 错误信息 */
  error?: string;
  /** 重试次数（retry 阶段） */
  retryCount?: number;
  /** 最大重试次数（retry 阶段） */
  maxRetries?: number;
  /** 重试延迟毫秒（retry 阶段） */
  delayMs?: number;
}

// ==================== 文章状态 ====================

/** 单篇文章状态 */
export interface PageStatus {
  status: Status;
  phase?: ArticlePhase;
  /** 当前工具名（tool 阶段） */
  currentTool?: string;
  /** Token 使用统计（本轮运行的累计快照） */
  usage?: TokenUsage;
  /**
   * 历史轮次已消耗的累计用量（重新生成时把上一轮的 `usage` 结转到此处）。
   * 展示口径 = `carryUsage + usage`：成功 + 失败 + 重试的消耗都留在槽位里。
   */
  carryUsage?: TokenUsage;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 错误信息 */
  error?: string;
  /** 输出路径（完成时） */
  outputPath?: string;
  /** 重试次数（retry 阶段） */
  retryCount?: number;
  /** 最大重试次数（retry 阶段） */
  maxRetries?: number;
  /** 重试延迟毫秒（retry 阶段） */
  delayMs?: number;
}

/** 文章集合状态 */
export interface ArticlesState {
  /** 状态映射：slug → PageStatus */
  pages: Record<string, PageStatus>;
  /** 当前正在生成的页面 slug */
  currentPageSlug?: string;
  /** 已完成数量 */
  completedCount: number;
  /** 失败数量 */
  failedCount: number;
  /** 待处理数量 */
  pendingCount: number;
  /** 总耗时（毫秒） */
  totalDurationMs?: number;
}

// ==================== 聚合状态 ====================

/** Wiki 生成完整状态 */
export interface WikiGenerateState {
  catalog: CatalogState;
  articles: ArticlesState;
  /** 文章列表数据（来自 wiki.json） */
  wikiPages: WikiPage[];
}

// ==================== 事件 Payload（供 mapper 使用） ====================

/** 目录事件类型 */
export type CatalogEventType =
  | 'scanning'
  | 'parsing'
  | 'requesting'
  | 'responding'
  | 'tool_start'
  | 'tool_result'
  | 'complete'
  | 'error'
  | 'retry';

/** 目录事件 payload */
export interface CatalogEventPayload {
  type: CatalogEventType;
  phase?: CatalogPhase;
  toolName?: string;
  /** 当前蓝图阶段 */
  stage?: CatalogStage;
  /** 当前处理的分类 */
  section?: string;
  /** 分类级进度（带 stage 的事件） */
  progress?: { current: number; total: number };
  usage?: TokenUsage;
  error?: string;
  durationMs?: number;
  outputPath?: string;
  /** 重试次数（retry 时） */
  retryCount?: number;
  /** 最大重试次数（retry 时） */
  maxRetries?: number;
  /** 重试延迟毫秒（retry 时） */
  delayMs?: number;
  /** 失败的分类（complete 事件） */
  failedSections?: BlueprintFailedSection[];
}

// ==================== 兼容旧类型（过渡期保留） ====================

/** 目录生成进度状态（旧命名，兼容现有代码） */
export type CatalogProgress = CatalogState;