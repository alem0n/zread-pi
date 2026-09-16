/**
 * Wiki Types
 *
 * Wiki page definitions and output format
 */

import type { BlueprintDetailLevel } from './config.js';

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
 * WikiSection - 顶级分类（分类阶段的产物）
 *
 * 蓝图生成改为三阶段后，section 是稳定的一级结构：
 * 分类阶段只产出 section，主题阶段再把页面增量归并到各 section 下。
 */
export interface WikiSection {
  /** 分类标题（如 "核心架构"） */
  title: string;
  /** 分类说明（供分主题 / 标题 Agent 参考） */
  description?: string;
  /**
   * 本分类的边界清单（scope）：用「包含：…」/「不包含：…」两条式声明。
   *
   * 分类阶段产出，逐级注入分主题 / 标题 / 页面阶段，作为防全项目漂移的
   * **负向边界**——「不包含」条目尽量点名相邻分类，形成分类间的互斥契约。
   * 可选字段：旧 wiki.json 无该字段时下游照常工作。
   */
  scope?: string[];
}

/**
 * WikiTopic - 主题阶段的页面草稿（slug/file 由代码统一分配）
 *
 * 模型只负责「这个分类下应该写哪些文章」，命名与去重由代码负责；
 * 标题在标题阶段统一精修，因此这里的 title 是草稿。
 */
export interface WikiTopic {
  /** 草稿标题（文档语言） */
  title: string;
  /**
   * 一句话主题摘要（≤40 字）：说明这篇文章论证什么、以哪些文件为证据。
   * 标题阶段不改它；写作时逐字注入页面提示词，作为范围锚点（可选字段）。
   */
  summary?: string;
  /** 英文短名（kebab-case，用于 slug）；缺省时由代码从 title 派生 */
  slug?: string;
  /** 二级模块聚合（可选） */
  group?: string;
  /** 难度等级（缺省 Intermediate） */
  level?: WikiLevel;
  /** 关联的源文件或目录路径（目录以 / 结尾） */
  associatedFiles?: string[];
}

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
  /**
   * 主题摘要（由 WikiTopic.summary 透传）：
   * 页面提示词里的语义边界之一，与关联路径共同锁定文章写作范围（可选字段）。
   */
  topicSummary?: string;
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
  /**
   * 生成时使用的蓝图细节档位（多档共存布局下 = 变体子目录名）。
   *
   * 旧版 wiki.json（含遗留的无档位 `wiki/wiki.json`）没有该字段；
   * 读取方以目录名 / 查询参数为准，字段仅作记录与展示。
   */
  detail?: BlueprintDetailLevel;
  /**
   * 分类阶段落盘的一级结构清单。
   *
   * 三阶段流程中骨架先写 sections、pages 为空，主题/标题阶段再增量补齐。
   */
  sections: WikiSection[];
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