/**
 * Blueprint Generation Types
 */

import type { FileManifest, SymbolManifest } from '@zread-pi/types';
import type { TokenUsage } from '@zread-pi/agent-runtime';

/**
 * Tech stack summary (parsed from Repo Map or package.json)
 */
export interface TechStackSummary {
  techStack: {
    languages: string[];
    frameworks: string[];
    buildTools: string[];
    testFrameworks?: string[];
  };
  projectType: 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli' | 'unknown';
  entryPoints: string[];
}


/**
 * Context for Blueprint Agent
 */
export interface BlueprintContext {
  projectRoot: string;
  fileManifest?: FileManifest;
  symbolManifest?: SymbolManifest;
  techStackSummary?: TechStackSummary;
}

/**
 * Blueprint generation result
 */
export interface BlueprintResult {
  /** 最终落盘的页面总数 */
  pagesCount: number;
  /** 分类阶段的分类数（三阶段流程；旧入口为 undefined） */
  sectionsCount?: number;
  /** 分主题 / 标题阶段失败的分类（不阻断其余分类） */
  failedSections?: BlueprintFailedSection[];
  techStackSummary?: TechStackSummary;
  durationMs: number;
  tokenUsage?: TokenUsage;
}

/** 蓝图三阶段（分类 → 分主题 → 标题） */
export type CatalogStage = 'classify' | 'topics' | 'titles';

/** 产生目录事件的 Agent 角色（每个 Agent 一行；缩编 subagent 单独成行） */
export type CatalogAgentRole = 'classify' | 'topics' | 'titles' | 'condense';

/** 单个目录 Agent 的生命周期状态 */
export type CatalogAgentStatus = 'waiting' | 'running' | 'completed' | 'failed';

/** 某个分类在某个阶段失败（记录后可继续其余分类） */
export interface BlueprintFailedSection {
  /** 分类标题 */
  section: string;
  /** 失败的阶段 */
  stage: 'topics' | 'titles';
  /** 失败原因（模型未调用工具 / Agent 报错等） */
  error: string;
}

/**
 * Blueprint generation options
 * Note: LLM config is loaded from ~/.zread-pi/config.yaml, not passed here
 */
export interface BlueprintOptions {
  projectRoot?: string;
  language?: 'zh' | 'en';
  debug?: boolean;
}

/**
 * Catalog generation event (for streaming progress)
 *
 * 完整流程：scanning → parsing → classify → topics → titles
 */
export interface CatalogEvent {
  type: 'scanning' | 'parsing' | 'requesting' | 'responding' | 'tool_start' | 'tool_result' | 'complete' | 'error' | 'retry';
  /** 当前处于哪个蓝图阶段（三阶段流程） */
  stage?: CatalogStage;
  /** 当前处理的分类（topics / titles 阶段） */
  section?: string;
  /**
   * 产生该事件的 Agent 标识（每个 Agent 一行）：
   * `classify` / `topics:<section>` / `titles:<section>` / `condense:<...>`。
   * 带该字段的事件只描述「某一个 Agent」，目录整体状态由不带该字段的事件承担。
   */
  agentKey?: string;
  /** 产生该事件的 Agent 角色（分类 / 分主题 / 标题 / 缩编 subagent） */
  agentRole?: CatalogAgentRole;
  /** 该 Agent 的生命周期状态（缺省按事件类型推断：complete→completed / error→failed / 其余→running） */
  agentStatus?: CatalogAgentStatus;
  /** 该 Agent **自己**的累计用量快照（`usage` 仍是目录级聚合，两者不同） */
  agentUsage?: TokenUsage;
  /**
   * 该 Agent 当前上下文体量（最近一次响应的 input + output + cacheRead + cacheWrite，
   * 口径与 pi 的 compaction 判定一致）；未响应过时为 undefined。
   */
  contextTokens?: number;
  /** 模型上下文窗口（来自 agent-runtime 的 system/init 事件） */
  contextWindow?: number;
  /** scanning/parsing 阶段的进度信息；带 stage 时表示分类级进度 */
  progress?: {
    current: number;
    total: number;
  };
  /** tool 阶段的工具信息 */
  toolName?: string;
  toolInput?: string;
  output?: string;
  /** Token 使用统计（三阶段流程为所有已结束/进行中 Agent 的聚合累计值） */
  usage?: TokenUsage;
  /** 错误信息 */
  error?: string;
  /** 耗时 */
  durationMs?: number;
  /** 重试次数（retry 时） */
  retryCount?: number;
  /** 最大重试次数（retry 时） */
  maxRetries?: number;
  /** 重试延迟毫秒（retry 时） */
  delayMs?: number;
  /** 分主题 / 标题阶段失败的分类（complete 事件携带） */
  failedSections?: BlueprintFailedSection[];
}