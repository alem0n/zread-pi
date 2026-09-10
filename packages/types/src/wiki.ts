/**
 * Wiki Types
 *
 * Wiki page definitions and output format
 */

/**
 * Wiki 难度级别
 * - Beginner: 初学者，适合入门章节
 * - Intermediate: 中级，需要一定基础
 * - Advanced: 高级，适合深度技术章节
 */
export type WikiLevel = 'Beginner' | 'Intermediate' | 'Advanced';

/** 同步页面变更状态 */
export type SyncPageStatus = 'unchanged' | 'new' | 'updated' | 'archived';

/**
 * WikiPage - Wiki page definition
 */
export interface WikiPage {
  slug: string;
  title: string;
  file: string;
  section: string;
  /**
   * 二级模块聚合，用于在同一 section 下进一步分组相关章节
   * 例如："平台接入指南"、"核心引擎架构"
   */
  group?: string;
  level: WikiLevel;
  /**
   * 关联的源文件或目录路径
   * - 文件路径: "packages/web-integration/src/index.ts"
   * - 目录路径: "packages/web-integration/src/" (以 / 结尾)
   * 后续生成 Wiki 内容时，会读取这些路径获取上下文
   */
  associatedFiles?: string[];
  /** 同步状态（sync 流程中标记，非同步流程为 undefined） */
  status?: SyncPageStatus;
}

/**
 * WikiOutput - Final output
 */
export interface WikiOutput {
  id: string;
  generated_at: string;
  language: string;
  pages: WikiPage[];
  techStackSummary?: TechStackSummary;
}

/** 同步变更摘要（仅包含有变更的页面） */
export interface SyncDiff {
  newPages: WikiPage[];
  updatedPages: WikiPage[];
  archivedPages: WikiPage[];
}

/**
 * TechStackSummary - Technology stack analysis result
 */
export interface TechStackSummary {
  techStack: {
    languages: string[];
    frameworks: string[];
    buildTools: string[];
  };
  projectType: string;
  entryPoints: string[];
}