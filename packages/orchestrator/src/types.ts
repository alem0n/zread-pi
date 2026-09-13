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