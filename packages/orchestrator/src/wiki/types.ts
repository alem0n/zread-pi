/**
 * Wiki Generation Types
 *
 * Types for Wiki content generation system.
 */

import type { BlueprintDetailLevel, WikiPage, RunEventAgentMeta } from '@zread-pi/types';
import type { TokenUsage } from '@zread-pi/agent-runtime';
import type { RunLogWriter } from '@zread-pi/utils';
import type { ContentGateReport } from '../tools/page-tools.js';
// ==================== 进度状态（批量回调） ====================

/**
 * Progress State
 *
 * Tracks generation progress for CLI display.
 */
export interface ProgressState {
  /** Total pages to generate */
  total: number;
  /** Completed pages */
  completed: number;
  /** Failed pages */
  failed: number;
  /** Pending pages */
  pending: number;
  /** Current page being processed */
  currentPage: WikiPage | null;
  /** Individual page results */
  results: PageResult[];
}

/**
 * Page Result
 *
 * Result of a single page generation.
 */
export interface PageResult {
  /** Page slug */
  slug: string;
  /** Success status */
  success: boolean;
  /** Output file path (if successful) */
  outputPath?: string;
  /** Error message (if failed) */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Token usage (if available) */
  tokenUsage?: TokenUsage;
  /** 页面落盘后的兜底润色结果（polish.mode = 'full' 时才可能 applied） */
  polish?: PolishOutcome;
  /**
   * 内容密度门报告（quality.contentGate 未关闭时才有值）。
   *
   * warn 模式只记录不拦截；enforce 拦截失败后预算用尽时 best-effort 落盘，
   * mode 记为 'enforce-degraded'，页面仍计成功（见 MIGRATION §29）。
   */
  gate?: ContentGateReport;
}

/**
 * Polish Outcome - 单页 polish 后处理的结果
 *
 * polish 是增强而非必需：任何失败都只记录在这里，不影响页面成功与否
 * （失败语义与 history 写入「失败不阻断」一致）。
 */
export interface PolishOutcome {
  /**
   * 文件是否被实际修改且通过 Mermaid 复检。
   * 例外：Mermaid 回滚失败时 applied=false，error 里带失败详情（页面内容已被改坏，需人工检查）。
   */
  applied: boolean;
  /**
   * 未应用/未执行的原因：
   * - disabled：polish.enabled = false；
   * - mode：polish.mode != 'full'（仅第 1 层预防）；
   * - missing-file：页面文件不存在（理论上不会发生，防御性分支）；
   * - no-change：polish Agent 未改动文件；
   * - mermaid-rollback：polish 改坏了 Mermaid，已回滚到润色前内容；
   * - error：polish Agent 抛错（文件若已被改动且 Mermaid 复检通过则 applied=true）。
   */
  reason?: 'disabled' | 'mode' | 'missing-file' | 'no-change' | 'mermaid-rollback' | 'error';
  /** 错误/回滚原因详情（诊断用） */
  error?: string;
  /** 耗时（毫秒） */
  durationMs: number;
  /** polish Agent 的 token 用量 */
  tokenUsage?: TokenUsage;
}

/**
 * Wiki Result
 *
 * Final result of Wiki content generation.
 */
export interface WikiResult {
  /** Total pages */
  total: number;
  /** Successfully generated pages */
  completed: number;
  /** Failed pages */
  failed: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Individual page results */
  results: PageResult[];
}

// ==================== 细粒度事件（实时回调） ====================

/**
 * 文章生成事件类型
 */
export type ArticleEventType =
  | 'page_start' // 开始处理某页
  | 'requesting' // Agent 请求中
  | 'responding' // Agent 响应中（流式）
  | 'tool_start' // 工具调用开始
  | 'tool_result' // 工具调用结果
  | 'retry' // API 重试中
  | 'page_complete' // 页面完成
  | 'page_error'; // 页面失败

/**
 * 文章事件 payload
 */
export interface ArticleEventPayload {
  type: ArticleEventType;
  /** 页面 slug */
  slug: string;
  /** Token 使用统计 */
  usage?: TokenUsage;
  /**
   * 该页面 Agent 当前上下文体量（最近一次响应的 input + output + cacheRead + cacheWrite）；
   * 未响应过时为 undefined。
   */
  contextTokens?: number;
  /** 模型上下文窗口（来自 agent-runtime 的 system/init 事件） */
  contextWindow?: number;
  /** 工具名称（tool_start 时） */
  toolName?: string;
  /** 错误信息 */
  error?: string;
  /** 输出路径 */
  outputPath?: string;
  /** 耗时 */
  durationMs?: number;
  /** 重试次数（retry 时） */
  retryCount?: number;
  /** 最大重试次数（retry 时） */
  maxRetries?: number;
  /** 重试延迟（retry 时） */
  delayMs?: number;
  /**
   * 内容密度门报告（quality.contentGate 未关闭时携带）。
   *
   * warn 模式只报告不拦截；enforce-degraded 表示预算用尽后 best-effort 落盘。
   */
  gate?: ContentGateReport;
}

// ==================== 生成选项 ====================

/**
 * Generate Wiki Content Options
 */
export interface GenerateWikiOptions {
  /** Blueprint file path (default: .zread-pi/wiki[/<detail>]/wiki.json) */
  blueprintPath?: string;
  /** 待生成的页面列表（如果传入，则不从 blueprint 加载，只生成这些页面） */
  pages?: WikiPage[];
  /** Custom concurrency limit (overrides config) */
  maxConcurrent?: number;
  /**
   * 写盘变体（蓝图细节档位）。
   * 缺省 = 配置的 `blueprint.detail`；`null` = 遗留 `.zread-pi/wiki`（只读兼容）。
   */
  detail?: BlueprintDetailLevel | null;
  /** 单个页面的最大轮次（覆盖 config.agent.max_turns；0 = 不限制轮次） */
  maxTurns?: number;
  /** 细粒度事件回调（实时） */
  onEvent?: (event: ArticleEventPayload) => void;
  /** Progress callback for CLI display (batch) */
  onProgress?: (state: ProgressState) => void;
  /**
   * 轨迹日志（缺省 = 自动创建单次 run；传入时由上层控制生命周期，
   * 目录 + 页面阶段共享同一个 run）
   */
  runLog?: RunLogWriter;
}