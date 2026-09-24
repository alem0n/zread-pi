/**
 * Wiki Types
 *
 * Wiki page definitions and output format
 */

import type { BlueprintDetailLevel } from './config.js';
import type { PageRef } from './structure.js';

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
  /**
   * 分类 id（结构优先蓝图 v2 产物）：基础分类为 overview / core，结构分类为 sec-<最小切片 id>。
   *
   * 可选字段：旧 wiki.json（schemaVersion 缺失）无该字段，读取方按 title 聚合。
   */
  id?: string;
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
  /**
   * 成员切片 id（结构优先蓝图 v2）：基础分类为空数组（只持全局槽位），
   * 结构分类为其机器切片成员（互斥完备）。可选字段：旧产物无该字段。
   */
  slices?: string[];
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
  /**
   * 本页拥有的源文件（结构优先蓝图 v2）：文件级排他归属，
   * 覆盖等式 |U| == Σ|ownsFiles| 的判据。全局槽位页为空数组。
   * 可选字段：旧产物无该字段（按 associatedFiles 兜底展示）。
   */
  ownsFiles?: string[];
  /**
   * 跨页引用（结构优先蓝图 v2）：本页文件指向其它页面拥有文件的边，
   * 写作期注入为「只引用不讲解」清单。可选字段：旧产物无该字段。
   */
  refs?: PageRef[];
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
   * 产物 schema 版本（结构优先蓝图 = 2）。
   *
   * 缺失 = 旧产物（三阶段蓝图）：sync 拒绝执行并提示重新 generate；
   * verify 的 coverage 检查组整组 SKIP。
   */
  schemaVersion?: number;
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
  /** 覆盖台账（v2 必填；旧产物缺失） */
  coverage?: WikiCoverage;
  techStackSummary?: TechStackSummary;
}

/** 同步变更摘要（仅包含有变更的页面） */
export interface SyncDiff {
  newPages: WikiPage[];
  updatedPages: WikiPage[];
  archivedPages: WikiPage[];
}

/**
 * 覆盖台账（结构优先蓝图 v2）：文件级排他归属的证明数据。
 *
 * 等式（verify 的 C1 判据）：`|M| == Σ|page.ownsFiles| + |excluded|`，
 * 等价于 `|U| == Σ|page.ownsFiles|`（U 内每个文件恰被一个页面拥有）。
 * 行级台账（lines）是信息性报表，不参与归属判定。
 */
export interface WikiCoverage {
  /** 生成时清单的哈希（manifest.files 的 path+language 排序哈希） */
  manifestHash: string;
  /** 全集文件数 |U|（可解析源文件） */
  universeCount: number;
  /** 未解析文件（manifest − U） */
  excluded: string[];
  /** 文件 → 拥有它的页面 slug（与 pages.ownsFiles 逐项一致） */
  fileOwner: Record<string, string>;
  /** 分类 id → 成员切片 id */
  slicesBySection: Record<string, string[]>;
  /** 切片划分在文件图（无向投影）上的模块度 */
  modularity: number;
  /** 缝合线（跨切片边）总数 */
  seamCount: number;
  /**
   * 行级台账（信息性）：measured = 已测文件数，total = U 的总行数，
   * declared = 符号 ranges 覆盖的行数，gap = total − declared（import / export / 空行等间隙）。
   * 可选字段：符号缓存无 ranges 时缺失。
   */
  lines?: { measured: number; total: number; declared: number; gap: number };
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