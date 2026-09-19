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
import type { TokenUsage, BlueprintFailedSection, CatalogAgentRole, CatalogAgentStatus, ContentGateReport } from '@zread-pi/orchestrator';

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
export type {
  TokenUsage,
  ArticleEventPayload,
  BlueprintFailedSection,
  CatalogAgentRole,
  CatalogAgentStatus,
  ContentGateReport,
} from '@zread-pi/orchestrator';

// ==================== 目录 Agent 行（每个 Agent 一行） ====================

/**
 * 单个目录 Agent 的展示状态。
 *
 * 目录生成会并发跑多个 Agent（分类 1 个 + 每个分类的主题 / 标题各 1 个，
 * 数量越界时还有缩编 subagent），UI 为每个 Agent 渲染一行，
 * 行内用量是该 Agent **自己**的累计快照（不是目录级聚合）。
 */
export interface CatalogAgentState {
  /** 生命周期状态 */
  status: Status;
  /** 所属阶段（分类 / 分主题 / 标题） */
  stage: CatalogStage;
  /** Agent 角色（缩编 subagent 单独成行） */
  role: CatalogAgentRole;
  /** 该 Agent 负责的分类（分类 Agent 无） */
  section?: string;
  /** 当前阶段（请求中 / 响应中 / 工具 / 重试） */
  phase?: CatalogPhase;
  /** 当前工具名（tool 阶段） */
  currentTool?: string;
  /** 该 Agent 自己的累计用量快照 */
  usage?: TokenUsage;
  /** 当前上下文体量（最近一次响应的 input + output + cacheRead + cacheWrite） */
  contextTokens?: number;
  /** 模型上下文窗口 */
  contextWindow?: number;
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
  /** 每个目录 Agent 一行的状态（key = agentKey；插入顺序即展示顺序） */
  agents?: Record<string, CatalogAgentState>;
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
   * 该页面 Agent 当前上下文体量（最近一次响应的 input + output + cacheRead + cacheWrite）。
   * 展示口径为「最近一次响应」，与累计用量 `usage` 不同。
   */
  contextTokens?: number;
  /** 模型上下文窗口（用于「已用 / 窗口」占比） */
  contextWindow?: number;
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
  /**
   * 内容密度门报告（quality.contentGate 未关闭时携带）。
   *
   * `passed=false` 时页面已完成但低于密度下限（warn 只报告；enforce-degraded 已降级落盘）。
   */
  gate?: ContentGateReport;
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
  /** 产生该事件的 Agent 标识（每个 Agent 一行；缺省 = 目录级事件） */
  agentKey?: string;
  /** 产生该事件的 Agent 角色 */
  agentRole?: CatalogAgentRole;
  /** 该 Agent 的生命周期状态 */
  agentStatus?: CatalogAgentStatus;
  /** 该 Agent **自己**的累计用量快照（`usage` 仍是目录级聚合） */
  agentUsage?: TokenUsage;
  /** 该 Agent 当前上下文体量 */
  contextTokens?: number;
  /** 模型上下文窗口 */
  contextWindow?: number;
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