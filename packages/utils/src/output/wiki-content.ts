/**
 * Wiki Content Utilities
 *
 * Functions for generating and loading Wiki blueprint.
 *
 * 三阶段蓝图（分类 → 分主题 → 标题）的落盘设施：
 * - 分类阶段：`initWikiSkeleton` / `mergeWikiSections` 维护 `sections`；
 * - 主题阶段：`mergeSectionTopics` 统一分配 slug/file 后增量归并页面；
 * - 标题阶段：`applySectionTitles` 批量写回精修后的 title；
 * - 所有「读-改-写」都走跨进程文件锁 + 临时文件 rename 原子替换，
 *   保证任一阶段落盘后 wiki.json 都是完整可解析的（loadWikiBlueprint 始终可加载）。
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
  AppConfig,
  WikiLevel,
  WikiOutput,
  WikiPage,
  WikiSection,
  WikiTopic,
  TechStackSummary,
} from '@zread-pi/types';
import {
  getWikiDir,
  getWikiJsonPath,
  readTextFile,
  writeJsonFile,
  writeTextFileAtomic,
} from '../file-io.js';
import { withFileLock } from '../lockfile.js';
import { logger } from '../logger.js';

const DEFAULT_BLUEPRINT_FILE = 'wiki.json';

/** 分类数量上限（超出部分丢弃；基础分类永远保留） */
export const MAX_BLUEPRINT_SECTIONS = 8;

/**
 * 强制包含的三个基础分类（按文档语言选择）。
 *
 * 无论模型如何分类，概览 / 快速开始 / 核心架构都必须存在——它们承载
 * 「项目是什么、怎么跑起来、整体怎么组织」三个入口，是 Wiki 的骨架。
 */
const BASE_SECTIONS: Record<'zh' | 'en', WikiSection[]> = {
  zh: [
    { title: '概览', description: '项目定位、核心价值与整体速览' },
    { title: '快速开始', description: '安装、配置与最小可运行示例' },
    { title: '核心架构', description: '整体架构、核心模块职责与协作关系' },
  ],
  en: [
    { title: 'Overview', description: 'What the project is, its core value and high-level tour' },
    { title: 'Quick Start', description: 'Install, configure and run the smallest working example' },
    { title: 'Core Architecture', description: 'Overall architecture, core modules and how they cooperate' },
  ],
};

function baseSectionsFor(language: string): WikiSection[] {
  return language === 'en' ? BASE_SECTIONS.en : BASE_SECTIONS.zh;
}

/** 分类名比较键（大小写不敏感；落盘/比较前统一归一化） */
function sectionKey(title: string): string {
  return title.trim().toLowerCase();
}

function sameTitle(a: string, b: string): boolean {
  return sectionKey(a) === sectionKey(b);
}

function normalizeSectionEntry(entry: unknown): WikiSection | null {
  if (typeof entry === 'string') {
    const title = entry.trim();
    return title ? { title } : null;
  }
  if (!entry || typeof entry !== 'object') return null;

  const raw = entry as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  return description ? { title, description } : { title };
}

/** 把任意输入归一化为 section 列表（去空、去重、保持顺序，不注入基础分类） */
export function normalizeSectionList(input: unknown): WikiSection[] {
  if (!Array.isArray(input)) return [];

  const result: WikiSection[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const section = normalizeSectionEntry(entry);
    if (!section) continue;
    const key = sectionKey(section.title);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(section);
  }
  return result;
}

/**
 * 归一化分类清单：去重 + 强制基础分类（概览/快速开始/核心架构）+ 数量上限。
 * 基础分类排在最前，因此截断不会丢基础分类。
 */
export function normalizeBlueprintSections(
  input: unknown,
  language: string,
  limit: number = MAX_BLUEPRINT_SECTIONS,
): WikiSection[] {
  const result: WikiSection[] = [];
  const seen = new Set<string>();

  for (const section of [...baseSectionsFor(language), ...normalizeSectionList(input)]) {
    const key = sectionKey(section.title);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(section);
  }

  return result.slice(0, limit);
}

/**
 * 合并分类清单（sync 分类阶段用）：
 * 既有分类原样保留（可能承载着已生成的页面），模型新增的分类追加在末尾。
 */
export function mergeBlueprintSections(
  existing: unknown,
  incoming: unknown,
  language: string,
): WikiSection[] {
  const result = normalizeBlueprintSections(existing, language, Number.MAX_SAFE_INTEGER);
  const seen = new Set(result.map((section) => sectionKey(section.title)));

  for (const section of normalizeSectionList(incoming)) {
    const key = sectionKey(section.title);
    if (seen.has(key)) {
      const target = result.find((entry) => sectionKey(entry.title) === key);
      if (target && !target.description && section.description) {
        target.description = section.description;
      }
      continue;
    }
    if (result.length >= MAX_BLUEPRINT_SECTIONS) break;
    seen.add(key);
    result.push(section);
  }

  return result;
}

/** 从页面列表推导分类（旧版 wiki.json 没有 sections 字段时的回退） */
export function deriveSectionsFromPages(pages: WikiPage[]): WikiSection[] {
  const result: WikiSection[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!page.section) continue;
    const key = sectionKey(page.section);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ title: page.section });
  }
  return result;
}

/** 读取蓝图里的分类清单（有 sections 用 sections，否则从 pages 推导） */
export function sectionsFromBlueprint(output: WikiOutput): WikiSection[] {
  if (Array.isArray(output.sections) && output.sections.length > 0) {
    return normalizeSectionList(output.sections);
  }
  return deriveSectionsFromPages(output.pages);
}

// ==================== slug / level / 关联路径归一化 ====================

/** 从标题（或英文短名）派生 slug 词干；非 ASCII 标题回退为 page */
export function slugStem(input: string): string {
  const stem = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return stem || 'page';
}

/** 全局页面序号：取现有 slug 的数字前缀最大值 + 1 */
export function nextPageIndex(pages: WikiPage[]): number {
  let max = 0;
  for (const page of pages) {
    const match = /^(\d+)-/.exec(page.slug);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max + 1;
}

function uniqueSlug(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  let suffix = 2;
  while (used.has(`${candidate}-${suffix}`)) suffix++;
  return `${candidate}-${suffix}`;
}

/** 难度等级归一化：接受大小写变体与中文说法，缺省 Intermediate */
export function normalizeLevel(value: unknown): WikiLevel {
  if (typeof value !== 'string') return 'Intermediate';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'beginner' || normalized === '初级' || normalized === '入门') return 'Beginner';
  if (normalized === 'advanced' || normalized === '高级') return 'Advanced';
  return 'Intermediate';
}

function normalizeGroup(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const group = value.trim();
  return group.length > 0 ? group : undefined;
}

function normalizeAssociatedFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const path = entry.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result.length > 0 ? result : undefined;
}

// ==================== 落盘（文件锁 + 原子替换） ====================

function generateWikiId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${dateStr}-${timeStr}`;
}

async function readWikiOutput(path: string): Promise<WikiOutput> {
  const content = await readTextFile(path);
  const output = JSON.parse(content) as WikiOutput;
  if (!output || typeof output !== 'object') {
    throw new Error(`wiki.json 内容无效: ${path}`);
  }
  if (!Array.isArray(output.pages)) {
    throw new Error(`wiki.json 缺少 pages 数组: ${path}`);
  }
  return output;
}

async function writeWikiOutput(path: string, output: WikiOutput): Promise<void> {
  await writeTextFileAtomic(path, JSON.stringify(output, null, 2));
}

/**
 * 在文件锁保护下对 wiki.json 做「读-改-写」。
 * wiki.json 必须已存在（分类阶段会先落盘骨架）；不存在时抛出可读错误。
 */
async function withWikiOutput<T>(fn: (output: WikiOutput) => T | Promise<T>): Promise<T> {
  const path = getWikiJsonPath();
  return withFileLock(path, async () => {
    let output: WikiOutput;
    try {
      output = await readWikiOutput(path);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`wiki.json 尚不存在，无法增量归并: ${path}\n${message}`, { cause: err });
    }
    const result = await fn(output);
    await writeWikiOutput(path, output);
    return result;
  });
}

/**
 * 初始化蓝图骨架（分类阶段）：
 * 写入 sections（强制包含基础分类）+ 空 pages，覆盖旧骨架。
 *
 * 之后的每个阶段都只做增量归并，因此任何时刻 wiki.json 都是可加载的。
 */
export async function initWikiSkeleton(
  sections: WikiSection[],
  config: AppConfig,
  techStackSummary?: TechStackSummary,
): Promise<string> {
  const output: WikiOutput = {
    id: generateWikiId(),
    generated_at: new Date().toISOString(),
    language: config.doc_language,
    sections: normalizeBlueprintSections(sections, config.doc_language),
    pages: [],
    ...(techStackSummary ? { techStackSummary } : {}),
  };

  const outputPath = getWikiJsonPath();
  await withFileLock(outputPath, () => writeWikiOutput(outputPath, output));

  logger.success(`Wiki 骨架已生成: ${outputPath}（${output.sections?.length ?? 0} 个分类）`);
  return outputPath;
}

/**
 * 合并分类清单（sync 的分类阶段）：
 * 保持既有分类与页面不动，只把模型新增的分类补进 sections。
 */
export async function mergeWikiSections(
  incoming: WikiSection[],
  config: AppConfig,
): Promise<WikiSection[]> {
  return withWikiOutput((output) => {
    output.sections = mergeBlueprintSections(output.sections, incoming, config.doc_language);
    return output.sections;
  });
}

/** 主题阶段的归并结果 */
export interface MergeTopicsResult {
  section: string;
  /** 新分配的页面数 */
  added: number;
  /** 复用的既有页面数（sync：保留旧 slug/file） */
  reused: number;
  /** 被去重丢弃的主题数（同分类下 title 重复） */
  duplicated: number;
  /** 该分类下的页面总数 */
  sectionPages: number;
  /** wiki.json 页面总数 */
  totalPages: number;
}

export interface MergeTopicsOptions {
  /**
   * 按 title（或 slug 提示）匹配既有页面并复用其 slug/file。
   * sync 的主题阶段开启，保证未改动的页面不换 URL、不产生重复页。
   */
  reuseExisting?: boolean;
}

/**
 * 按分类增量归并主题（主题阶段）：
 * - slug/file 由代码统一分配（全局序号 + 英文词干），同分类内 title 去重；
 * - 分类不在 sections 清单时自动补上；
 * - 使用文件锁串行化并发 section 的读-改-写，编号不会撞车。
 */
export async function mergeSectionTopics(
  section: WikiSection,
  topics: WikiTopic[],
  options: MergeTopicsOptions = {},
): Promise<MergeTopicsResult> {
  const sectionTitle = section.title?.trim();
  if (!sectionTitle) throw new Error('section.title 不能为空');

  const incoming = Array.isArray(topics) ? topics : [];

  return withWikiOutput((output) => {
    if (!Array.isArray(output.sections)) output.sections = [];
    if (!output.sections.some((entry) => sameTitle(entry.title, sectionTitle))) {
      output.sections.push(
        section.description ? { title: sectionTitle, description: section.description } : { title: sectionTitle },
      );
    }

    const existing = output.pages.filter((page) => sameTitle(page.section, sectionTitle));
    const usedSlugs = new Set(output.pages.map((page) => page.slug));
    const usedTitles = new Set(existing.map((page) => page.title.trim().toLowerCase()));
    let nextIndex = nextPageIndex(output.pages);

    let added = 0;
    let reused = 0;
    let duplicated = 0;

    for (const topic of incoming) {
      const title = typeof topic?.title === 'string' ? topic.title.trim() : '';
      if (!title) continue;

      const slugHint = typeof topic?.slug === 'string' ? topic.slug.trim() : '';
      const match = options.reuseExisting
        ? existing.find((page) => sameTitle(page.title, title)) ??
          (slugHint ? existing.find((page) => page.slug === slugHint) : undefined)
        : undefined;

      if (match) {
        // 复用既有 slug/file，只更新元数据（章节归属保持既有值）
        if (title !== match.title) match.title = title;
        const group = normalizeGroup(topic.group);
        if (group !== undefined) match.group = group;
        match.level = normalizeLevel(topic.level);
        const associatedFiles = normalizeAssociatedFiles(topic.associatedFiles);
        if (associatedFiles !== undefined) match.associatedFiles = associatedFiles;
        usedTitles.add(title.toLowerCase());
        reused += 1;
        continue;
      }

      const titleKey = title.toLowerCase();
      if (usedTitles.has(titleKey)) {
        duplicated += 1;
        continue;
      }

      const slug = uniqueSlug(`${nextIndex}-${slugStem(slugHint || title)}`, usedSlugs);
      nextIndex += 1;

      const page: WikiPage = {
        slug,
        title,
        file: `${slug}.md`,
        section: sectionTitle,
        group: normalizeGroup(topic.group),
        level: normalizeLevel(topic.level),
        associatedFiles: normalizeAssociatedFiles(topic.associatedFiles),
      };

      output.pages.push(page);
      usedSlugs.add(slug);
      usedTitles.add(titleKey);
      added += 1;
    }

    return {
      section: sectionTitle,
      added,
      reused,
      duplicated,
      sectionPages: existing.length + added,
      totalPages: output.pages.length,
    };
  });
}

/** 标题阶段的写回结果 */
export interface ApplyTitlesResult {
  /** 实际更新的标题数 */
  updated: number;
  /** 跳过（标题相同 / 空 / 同分类内重名）的条目数 */
  skipped: number;
  /** slug 在该分类下不存在的条目数 */
  unknown: number;
}

/**
 * 批量写回标题（标题阶段）：只改 title，slug/file/section 保持不变。
 * slug 不属于该分类时计入 unknown 并跳过（不允许跨分类改标题）。
 */
export async function applySectionTitles(
  section: WikiSection,
  titles: Array<{ slug?: string; title?: string }>,
): Promise<ApplyTitlesResult> {
  const sectionTitle = section.title?.trim();
  if (!sectionTitle) throw new Error('section.title 不能为空');
  const incoming = Array.isArray(titles) ? titles : [];

  return withWikiOutput((output) => {
    const pages = output.pages.filter((page) => sameTitle(page.section, sectionTitle));
    const bySlug = new Map(pages.map((page) => [page.slug, page]));
    const usedTitles = new Set(pages.map((page) => page.title.trim().toLowerCase()));

    let updated = 0;
    let skipped = 0;
    let unknown = 0;

    for (const entry of incoming) {
      const slug = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
      const page = slug ? bySlug.get(slug) : undefined;
      if (!page) {
        unknown += 1;
        continue;
      }

      const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
      if (!title || sameTitle(title, page.title)) {
        skipped += 1;
        continue;
      }

      const titleKey = title.toLowerCase();
      if (usedTitles.has(titleKey)) {
        skipped += 1;
        continue;
      }

      usedTitles.delete(page.title.trim().toLowerCase());
      page.title = title;
      usedTitles.add(titleKey);
      updated += 1;
    }

    return { updated, skipped, unknown };
  });
}

/**
 * 覆盖写页面清单（sync 写回 status 用）：sections/techStackSummary 原样保留。
 * 需要 wiki.json 已存在。
 */
export async function writeWikiPages(pages: WikiPage[]): Promise<string> {
  const outputPath = getWikiJsonPath();
  await withWikiOutput((output) => {
    output.pages = pages;
  });
  return outputPath;
}

// ==================== 兼容旧流程 ====================

/**
 * Generate Wiki Blueprint
 *
 * Generate wiki.json blueprint and save to wiki directory.
 * 旧版一次性蓝图入口（generate_blueprint 工具）；三阶段流程改用骨架 + 增量归并。
 */
export async function generateWikiJson(
  pages: WikiPage[],
  config: AppConfig,
  techStackSummary?: TechStackSummary,
): Promise<string> {
  const wikiOutput: WikiOutput = {
    id: generateWikiId(),
    generated_at: new Date().toISOString(),
    language: config.doc_language,
    pages,
    techStackSummary,
  };

  const outputPath = getWikiJsonPath();
  await writeJsonFile(outputPath, wikiOutput);

  logger.success(`Blueprint generated: ${outputPath}`);
  return outputPath;
}

/**
 * Load Wiki Blueprint
 *
 * Load wiki.json from wiki directory.
 *
 * 三阶段流程中先写骨架（sections + 空 pages）、再增量补齐页面，
 * 因此「pages 为空」只有在 sections 也为空时才算非法。
 *
 * @param path - Optional custom path (defaults to .zread-pi/wiki/wiki.json)
 * @returns WikiOutput with pages array
 * @throws Error if blueprint not found or invalid structure
 */
export async function loadWikiBlueprint(path?: string): Promise<WikiOutput> {
  const wikiDir = getWikiDir();
  const blueprintPath = path ?? join(wikiDir, DEFAULT_BLUEPRINT_FILE);

  try {
    const content = await readFile(blueprintPath, 'utf-8');
    const blueprint = JSON.parse(content) as WikiOutput;

    // Validate blueprint structure
    if (!blueprint.pages || !Array.isArray(blueprint.pages)) {
      throw new Error('蓝图缺少 pages 字段或格式无效');
    }

    const hasSections = Array.isArray(blueprint.sections) && blueprint.sections.length > 0;
    if (blueprint.pages.length === 0 && !hasSections) {
      throw new Error('蓝图 pages 数组为空');
    }

    return blueprint;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`加载蓝图失败: ${blueprintPath}\n${message}`, { cause: err });
  }
}
