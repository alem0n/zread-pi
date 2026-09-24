/**
 * Wiki Content Utilities
 *
 * Functions for generating and loading Wiki blueprint.
 *
 * 结构优先蓝图的落盘设施：
 * - `buildMachineBlueprint` 由结构层派生机器骨架（sections / pages / coverage），
 *   `initWikiBlueprint` 覆盖写 schemaVersion=2 骨架；
 * - 命名阶段 `applySectionNames` / `applyPageNames` 只写语义字段，
 *   slug / file / section / ownsFiles / associatedFiles / refs 恒不变；
 * - sync 的 `reconcileBlueprint` 做确定性身份继承；
 * - 所有「读-改-写」都走跨进程文件锁 + 临时文件 rename 原子替换，
 *   保证任一阶段落盘后 wiki.json 都是完整可解析的（loadWikiBlueprint 始终可加载）。
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
  AppConfig,
  BlueprintDetailLevel,
  StructureCache,
  StructureEdgeKind,
  MachinePageId,
  PageRef,
  WikiCoverage,
  WikiLevel,
  WikiOutput,
  WikiPage,
  WikiSection,
  TechStackSummary,
} from '@zread-pi/types';
import {
  getWikiDir,
  getWikiJsonPath,
  readTextFile,
  writeTextFileAtomic,
} from '../file-io.js';
import { withFileLock } from '../lockfile.js';
import { createLogger } from '../logger/service.js';

const logger = createLogger('orchestrator.wiki-content');

const DEFAULT_BLUEPRINT_FILE = 'wiki.json';

/** 分类数量上限（超出部分丢弃；基础分类永远保留） */
const BASE_SECTIONS: Record<'zh' | 'en', WikiSection[]> = {
  zh: [
    { title: '概览', description: '项目定位、核心价值与整体速览' },
    { title: '核心架构', description: '整体架构、核心模块职责与协作关系' },
  ],
  en: [
    { title: 'Overview', description: 'What the project is, its core value and high-level tour' },
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
/** 字符串数组归一化（trim + 去空 + 去重）；无有效条目时返回 undefined */
function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const item = entry.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.length > 0 ? result : undefined;
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

/** 主题摘要归一化：trim + 去空；不截断（语义字段由模型负责长度） */
function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const summary = value.trim();
  return summary.length > 0 ? summary : undefined;
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
 *
 * `variant` 指定变体子目录。
 */
async function withWikiOutput<T>(
  variant: BlueprintDetailLevel,
  fn: (output: WikiOutput) => T | Promise<T>,
): Promise<T> {
  const path = getWikiJsonPath(variant);
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
 * 覆盖写页面清单（sync 写回 status 用）：sections/techStackSummary 原样保留。
 * 需要 wiki.json 已存在。
 */
export async function writeWikiPages(
  pages: WikiPage[],
  options: { variant: BlueprintDetailLevel },
): Promise<string> {
  const outputPath = getWikiJsonPath(options.variant);
  await withWikiOutput(options.variant, (output) => {
    output.pages = pages;
  });
  return outputPath;
}

// ==================== 机器蓝图（结构优先） ====================

/** 基础分类的固定 id（与语言无关；title / description 随 doc_language） */
const BASE_SECTION_IDS = ['overview', 'core'] as const;

function isBaseSectionId(id: string | undefined): boolean {
  return id !== undefined && (BASE_SECTION_IDS as readonly string[]).includes(id);
}

export interface MachinePageEntry {
  /** 运行期机器页 id（`slice:S1` / `slot:overview` …），不入库，仅用于本轮工具绑定 */
  id: MachinePageId;
  /** slug 词干（英文短名），slug / file 由此派生 */
  stem: string;
  page: WikiPage;
}

export interface MachineBlueprint {
  sections: WikiSection[];
  pages: MachinePageEntry[];
  coverage: WikiCoverage;
}

export interface MachineBlueprintOptions {
  /** 写盘变体（档位子目录） */
  variant: BlueprintDetailLevel;
  /** minimal 档位：收敛为 1 分类 1 页（拥有全部 U） */
  minimal?: boolean;
}

/** 跨切片依赖原因文案（`import 来自 <文件>` / `reexport 来自 <文件>`） */
function refReason(kind: StructureEdgeKind, from: string): string {
  return kind === 'reexport' ? `reexport 来自 ${from}` : `import 来自 ${from}`;
}

/** 按路径去重排序的合集（associatedFiles 是集合语义；接受数组或 Set） */
function unionFiles(...groups: Array<Iterable<string>>): string[] {
  const set = new Set<string>();
  for (const group of groups) for (const path of group) set.add(path);
  return [...set].sort();
}

/**
 * 由结构缓存派生机器蓝图骨架：sections / pages / coverage 全部由代码构造。
 *
 * - minimal（D16）：1 个「概览」分类 + 1 个页拥有全部 U（hub 路径作 associatedFiles）；
 * - 非 minimal：概览 + 核心架构 + 结构分类；槽位页归基础分类，切片页归结构分类；
 * - 页号顺序（§5.5）：slot:overview(0) → slot:seams(1) → hub 槽位(2..) → 切片页(续)。
 *
 * LLM 只能改 title / description / scope / summary / group / level（P2 命名阶段）。
 */
export function buildMachineBlueprint(
  cache: StructureCache,
  config: AppConfig,
  options: MachineBlueprintOptions,
): MachineBlueprint {
  const language = config.doc_language;
  const isEn = language === 'en';
  const base = baseSectionsFor(language);
  const overviewSlot = cache.slots.find((slot) => slot.id === 'slot:overview');
  const hubPaths = overviewSlot?.associatedFiles ?? [];

  // —— minimal：1 分类 1 页（D16）——
  if (options.minimal) {
    const slug = '0-overview';
    const page: WikiPage = {
      slug,
      title: base[0].title,
      file: `${slug}.md`,
      section: base[0].title,
      ownsFiles: [...cache.universe],
      associatedFiles: normalizeAssociatedFiles(hubPaths) ?? [],
      level: 'Intermediate',
    };
    return {
      sections: [{ ...base[0], id: 'overview', slices: [] }],
      pages: [{ id: 'slot:overview', stem: 'overview', page }],
      coverage: {
        manifestHash: cache.manifestHash,
        universeCount: cache.universe.length,
        excluded: [...cache.excluded],
        fileOwner: Object.fromEntries(cache.universe.map((path) => [path, slug])),
        slicesBySection: {},
        modularity: cache.modularity,
        seamCount: cache.seams.length,
        lines: cache.lines,
      },
    };
  }

  // —— 非 minimal ——
  const sections: WikiSection[] = [
    { ...base[0], id: 'overview', slices: [] },
    { ...base[1], id: 'core', slices: [] },
    ...cache.sections.map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      slices: section.slices,
    })),
  ];

  const entries: MachinePageEntry[] = [];
  const usedSlugs = new Set<string>();
  let index = 0;
  const addPage = (
    id: MachinePageId,
    stem: string,
    page: Omit<WikiPage, 'slug' | 'file'>,
  ): string => {
    const slug = uniqueSlug(`${index}-${stem}`, usedSlugs);
    index += 1;
    usedSlugs.add(slug);
    entries.push({ id, stem, page: { ...page, slug, file: `${slug}.md` } });
    return slug;
  };

  // 槽位页（顺序：overview → seams → hubs）
  addPage('slot:overview', 'overview', {
    title: overviewSlot?.title ?? base[0].title,
    section: base[0].title,
    ownsFiles: [],
    associatedFiles: normalizeAssociatedFiles(hubPaths) ?? [],
    level: 'Intermediate',
  });

  const seamsSlot = cache.slots.find((slot) => slot.id === 'slot:seams');
  if (seamsSlot) {
    addPage('slot:seams', 'cross-slice-dependency-map', {
      title: seamsSlot.title,
      section: base[1].title,
      ownsFiles: [],
      associatedFiles: normalizeAssociatedFiles(seamsSlot.associatedFiles) ?? [],
      level: 'Intermediate',
    });
  }

  for (const slot of cache.slots) {
    if (slot.kind !== 'hub') continue;
    const stem = `hub-${slugStem(slot.associatedFiles[0] ?? slot.id)}`;
    addPage(`slot:hub:${slot.associatedFiles[0] ?? ''}`, stem, {
      title: slot.title,
      section: base[1].title,
      ownsFiles: [],
      associatedFiles: normalizeAssociatedFiles(slot.associatedFiles) ?? [],
      level: 'Intermediate',
    });
  }

  // 切片页（按结构分类顺序 → 切片顺序，即 S1..Sn）
  const sliceById = new Map(cache.slices.map((slice) => [slice.id, slice]));
  const fileSlice: Map<string, { sliceId: string; slug: string }> = new Map();
  const slicesBySection: Record<string, string[]> = {};

  for (const section of cache.sections) {
    slicesBySection[section.id] = [...section.slices];
    for (const sliceId of section.slices) {
      const slice = sliceById.get(sliceId);
      if (!slice) continue;

      // 该切片对外的跨切片边（去重 by path）
      const refs: PageRef[] = [];
      const seenRefs = new Set<string>();
      for (const file of slice.files) {
        for (const edge of cache.edges) {
          if (edge.from !== file) continue;
          const owner = fileSlice.get(edge.to);
          // 目标尚未分配页（同切片或后面的切片）→ 暂不记，第二轮回填
          if (!owner || owner.sliceId === slice.id) continue;
          if (seenRefs.has(edge.to)) continue;
          seenRefs.add(edge.to);
          refs.push({ path: edge.to, reason: refReason(edge.kind, file), ownerSlug: owner.slug });
        }
      }

      const slug = addPage(`slice:${sliceId}`, slugStem(slice.label), {
        title: slice.label,
        section: section.title,
        ownsFiles: [...slice.files],
        refs: refs.length > 0 ? refs : undefined,
        associatedFiles: unionFiles(slice.files, seenRefs),
        topicSummary: isEn
          ? `Slice ${slice.id} (${slice.label}): ${slice.files.length} files, ${slice.seamDegree} cross-slice dependencies`
          : `覆盖切片 ${slice.id}（${slice.label}）：${slice.files.length} 个文件，${slice.seamDegree} 条跨切片依赖`,
        level: 'Intermediate',
      });

      for (const file of slice.files) fileSlice.set(file, { sliceId: slice.id, slug });
    }
  }

  // 第二轮：补齐「目标切片在本切片之后」的 refs（ownerSlug 与 associatedFiles）
  for (const entry of entries) {
    const sliceId = entry.id.startsWith('slice:') ? entry.id.slice('slice:'.length) : null;
    if (!sliceId) continue;
    const slice = sliceById.get(sliceId);
    if (!slice) continue;
    const refs: PageRef[] = entry.page.refs ? [...entry.page.refs] : [];
    const seenRefs = new Set(refs.map((ref) => ref.path));
    let appended = false;
    for (const file of slice.files) {
      for (const edge of cache.edges) {
        if (edge.from !== file) continue;
        const owner = fileSlice.get(edge.to);
        if (!owner || owner.sliceId === sliceId || seenRefs.has(edge.to)) continue;
        seenRefs.add(edge.to);
        refs.push({ path: edge.to, reason: refReason(edge.kind, file), ownerSlug: owner.slug });
        appended = true;
      }
    }
    if (appended) entry.page.refs = refs;
    entry.page.associatedFiles = unionFiles(slice.files, seenRefs);
  }

  const fileOwner: Record<string, string> = {};
  for (const [file, { slug }] of fileSlice) fileOwner[file] = slug;

  return {
    sections,
    pages: entries,
    coverage: {
      manifestHash: cache.manifestHash,
      universeCount: cache.universe.length,
      excluded: [...cache.excluded],
      fileOwner,
      slicesBySection,
      modularity: cache.modularity,
      seamCount: cache.seams.length,
      lines: cache.lines,
    },
  };
}

/**
 * 初始化机器蓝图（覆盖写）：schemaVersion = 2 + sections + pages + coverage。
 *
 * 之后的命名阶段只做增量归并，任何时刻 wiki.json 都可加载（pages 为空合法）。
 */
export async function initWikiBlueprint(
  blueprint: MachineBlueprint,
  config: AppConfig,
  techStackSummary: TechStackSummary | undefined,
  options: MachineBlueprintOptions,
): Promise<string> {
  const output: WikiOutput = {
    id: generateWikiId(),
    generated_at: new Date().toISOString(),
    language: config.doc_language,
    schemaVersion: 2,
    sections: blueprint.sections,
    pages: blueprint.pages.map((entry) => entry.page),
    coverage: blueprint.coverage,
    detail: options.variant,
    ...(techStackSummary ? { techStackSummary } : {}),
  };

  const outputPath = getWikiJsonPath(options.variant);
  await withFileLock(outputPath, () => writeWikiOutput(outputPath, output));

  logger.info(
    `机器蓝图已生成: ${outputPath}（${output.sections?.length ?? 0} 个分类，${output.pages.length} 个页面）`,
  );
  return outputPath;
}

/** 命名提交的通用条目形状 */
interface NameEntry {
  id?: string;
  title?: string;
  description?: string;
  scope?: unknown;
  summary?: string;
  group?: string;
  level?: string;
}

export interface ApplySectionNamesResult {
  /** title / description 实际写入数 */
  updated: number;
  /** scope 写入数（所有分类都接受） */
  scope: number;
  /** 跳过（空值 / 重名 / 基础分类的 title 提交 / onlyIds 排除） */
  skipped: number;
  /** id 在 sections 中不存在 */
  unknown: number;
}

export interface ApplySectionNamesOptions {
  variant: BlueprintDetailLevel;
  /** 只允许写入这些 id（空槽回收 / 增量命名用）；不在集合内的一律跳过 */
  onlyIds?: Set<string>;
}

/**
 * 写回分类命名（命名阶段）：只改 title / description / scope，
 * id / slices / 顺序恒不变；基础分类（overview / core）的 title / description 提交一律忽略。
 *
 * 结构分类改名时同步更新 pages[].section（页面靠 title 归属分类）。
 */
export async function applySectionNames(
  names: NameEntry[],
  options: ApplySectionNamesOptions,
): Promise<ApplySectionNamesResult> {
  const incoming = Array.isArray(names) ? names : [];

  return withWikiOutput(options.variant, (output) => {
    const sections = Array.isArray(output.sections) ? output.sections : [];
    const byId = new Map<string, WikiSection>();
    for (const section of sections) {
      if (section.id) byId.set(section.id, section);
    }
    const usedTitles = new Set(sections.map((section) => sectionKey(section.title)));
    const renames: Array<{ from: string; to: string }> = [];

    let updated = 0;
    let scopeCount = 0;
    let skipped = 0;
    let unknown = 0;

    for (const entry of incoming) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const target = id ? byId.get(id) : undefined;
      if (!target) {
        unknown += 1;
        continue;
      }
      if (options.onlyIds && !options.onlyIds.has(id)) {
        skipped += 1;
        continue;
      }

      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const description = typeof entry.description === 'string' ? entry.description.trim() : '';
      const scope = normalizeStringList(entry.scope);

      // scope 所有分类都接受（下游硬边界）
      if (scope) {
        target.scope = scope;
        scopeCount += 1;
      }

      // 基础分类的 title / description 是系统固定值，提交一律忽略
      if (isBaseSectionId(id)) {
        if (title || description) skipped += 1;
        continue;
      }

      if (title && !sameTitle(title, target.title)) {
        const key = sectionKey(title);
        if (usedTitles.has(key)) {
          skipped += 1;
        } else {
          usedTitles.delete(sectionKey(target.title));
          renames.push({ from: target.title, to: title });
          target.title = title;
          usedTitles.add(key);
          updated += 1;
        }
      }
      if (description) {
        target.description = description;
        updated += 1;
      }
    }

    // 分类改名 → 页面的 section 字段同步
    if (renames.length > 0) {
      for (const page of output.pages) {
        const rename = renames.find((entry) => sameTitle(page.section, entry.from));
        if (rename) page.section = rename.to;
      }
    }

    return { updated, scope: scopeCount, skipped, unknown };
  });
}

export interface ApplyPageNamesResult {
  updated: number;
  skipped: number;
  unknown: number;
}

export interface ApplyPageNamesOptions {
  variant: BlueprintDetailLevel;
  /** 机器页清单（id → slug 绑定；wiki.json 不存 id，必须由调用方提供） */
  machinePages: MachinePageEntry[];
  /** 只允许写入这些 id（空槽回收后防止写过期页） */
  onlyIds?: Set<string>;
}

/**
 * 写回页面命名（命名阶段）：只改 title / topicSummary / group / level，
 * slug / file / section / ownsFiles / associatedFiles / refs 结构性不可改。
 */
export async function applyPageNames(
  names: NameEntry[],
  options: ApplyPageNamesOptions,
): Promise<ApplyPageNamesResult> {
  const incoming = Array.isArray(names) ? names : [];
  const slugById = new Map(options.machinePages.map((entry) => [entry.id, entry.page.slug]));

  return withWikiOutput(options.variant, (output) => {
    const bySlug = new Map(output.pages.map((page) => [page.slug, page]));

    let updated = 0;
    let skipped = 0;
    let unknown = 0;

    for (const entry of incoming) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const slug = id ? slugById.get(id as MachinePageId) : undefined;
      const page = slug ? bySlug.get(slug) : undefined;
      if (!slug || !page) {
        unknown += 1;
        continue;
      }
      if (options.onlyIds && !options.onlyIds.has(id)) {
        skipped += 1;
        continue;
      }

      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      if (title) {
        const usedTitles = new Set(
          output.pages
            .filter((other) => sameTitle(other.section, page.section) && other.slug !== page.slug)
            .map((other) => other.title.trim().toLowerCase()),
        );
        if (usedTitles.has(title.toLowerCase())) {
          skipped += 1;
        } else {
          page.title = title;
          updated += 1;
        }
      }

      const summary = normalizeSummary(entry.summary);
      if (summary !== undefined) {
        page.topicSummary = summary;
        updated += 1;
      }
      const group = normalizeGroup(entry.group);
      if (group !== undefined) {
        page.group = group;
        updated += 1;
      }
      if (entry.level !== undefined) {
        const level = normalizeLevel(entry.level);
        if (level !== page.level) {
          page.level = level;
          updated += 1;
        }
      }
    }

    return { updated, skipped, unknown };
  });
}

// ==================== sync 对齐（链 E） ====================

export interface ReconcileResult {
  /** 对齐后的机器蓝图（命中页继承旧身份，section 按多数票协调） */
  blueprint: MachineBlueprint;
  /** 需要命名的「新分类」id（无票 / 票冲突落败的结构分类） */
  freshSectionIds: Set<string>;
  /** 需要命名的「新页面」id（未命中任何旧页面的机器页） */
  freshPageIds: Set<MachinePageId>;
}

/**
 * reconcileBlueprint —— sync 的纯函数对齐（plan 链 E，确定性）。
 *
 * 页面匹配：`pair 重叠 = |oldPage.ownsFiles ∩ newPage.ownsFiles|`，
 * 候选对按（重叠 desc, oldSlug asc, newSlug asc）排序 → 贪心双射
 * （每边至多命中一次，重叠 ≥ 1）。槽位页（ownsFiles 为空）不参与匹配。
 *
 * - 命中页：整份身份继承 { slug, file, title, topicSummary, group, level }，
 *   section 归属取机器新值；ownsFiles / associatedFiles / refs 取机器新值；
 * - 未命中页 = 新页（fresh，待命名）；
 * - 旧页 slug 不在结果集 → 归档（无条件，由 computeSyncDiff 判定）。
 *
 * 分类协调：结构分类得票 = 其命中页的旧 section title 集合；
 * 多数票（> 命中页半数，平票取旧 wiki.json 中顺序靠前者）→ 继承旧 title / description / scope；
 * 无票 / 落败 → 机器 title（计入新分类）。
 * 基础分类：title / description 系统固定，description / scope 从旧 wiki.json 继承。
 */
export function reconcileBlueprint(
  machine: MachineBlueprint,
  old: WikiOutput,
  config: AppConfig,
): ReconcileResult {
  const oldPages = Array.isArray(old.pages) ? old.pages : [];
  const oldSections = Array.isArray(old.sections) ? old.sections : [];
  const oldBySlug = new Map(oldPages.map((page) => [page.slug, page]));

  // —— 页面匹配（贪心双射）——
  interface Pair {
    oldPage: WikiPage;
    entry: MachinePageEntry;
    overlap: number;
  }
  const pairs: Pair[] = [];
  for (const entry of machine.pages) {
    const newFiles = new Set(entry.page.ownsFiles ?? []);
    if (newFiles.size === 0) continue; // 槽位页不参与
    for (const oldPage of oldPages) {
      const oldFiles = oldPage.ownsFiles ?? [];
      if (oldFiles.length === 0) continue;
      let overlap = 0;
      for (const file of oldFiles) if (newFiles.has(file)) overlap += 1;
      if (overlap > 0) pairs.push({ oldPage, entry, overlap });
    }
  }
  pairs.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      a.oldPage.slug.localeCompare(b.oldPage.slug) ||
      a.entry.page.slug.localeCompare(b.entry.page.slug),
  );

  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const inheritedOf = new Map<string, WikiPage>(); // 机器页 slug → 旧页
  for (const pair of pairs) {
    if (usedOld.has(pair.oldPage.slug) || usedNew.has(pair.entry.page.slug)) continue;
    usedOld.add(pair.oldPage.slug);
    usedNew.add(pair.entry.page.slug);
    inheritedOf.set(pair.entry.page.slug, pair.oldPage);
  }

  // 槽位页（ownsFiles 为空）没有文件重叠可匹配：按机器 slug 对齐槽位页
  // （槽位 slug 由槽位种类决定，跨次运行稳定；页身份 = slug，见 plan 链 E）
  for (const entry of machine.pages) {
    if (usedNew.has(entry.page.slug)) continue;
    if ((entry.page.ownsFiles ?? []).length > 0) continue;
    const slotOld = oldPages.find((page) => page.slug === entry.page.slug && (page.ownsFiles ?? []).length === 0);
    if (!slotOld || usedOld.has(slotOld.slug)) continue;
    usedOld.add(slotOld.slug);
    usedNew.add(entry.page.slug);
    inheritedOf.set(entry.page.slug, slotOld);
  }

  // —— 分类协调：先算出每个机器分类的最终 title ——
  const baseTitles = new Set(baseSectionsFor(config.doc_language).map((section) => section.title));
  const oldSectionIndex = new Map(oldSections.map((section, index) => [section.title, index]));
  const resolvedTitle = new Map<string, string>();
  const freshSectionIds = new Set<string>();

  for (const section of machine.sections) {
    const id = section.id ?? '';
    if (isBaseSectionId(id)) {
      resolvedTitle.set(id, section.title); // 系统固定
      continue;
    }

    // 该结构分类的命中页（用机器清单的 section title 归属筛选）
    const sectionKey = section.title.trim().toLowerCase();
    const matched = machine.pages.filter(
      (entry) => entry.page.section.trim().toLowerCase() === sectionKey,
    );
    const inheritedPages = matched.filter((entry) => inheritedOf.has(entry.page.slug));

    const votes = new Map<string, number>();
    for (const entry of inheritedPages) {
      const oldTitle = inheritedOf.get(entry.page.slug)?.section;
      if (!oldTitle) continue;
      votes.set(oldTitle, (votes.get(oldTitle) ?? 0) + 1);
    }

    const threshold = inheritedPages.length / 2;
    let winner: string | null = null;
    for (const [title, count] of [...votes.entries()].sort((a, b) => {
      const indexDiff = (oldSectionIndex.get(a[0]) ?? Number.MAX_SAFE_INTEGER) -
        (oldSectionIndex.get(b[0]) ?? Number.MAX_SAFE_INTEGER);
      return b[1] - a[1] || indexDiff;
    })) {
      if (count > threshold) {
        winner = title;
        break;
      }
    }

    if (winner !== null) {
      resolvedTitle.set(id, winner);
    } else {
      resolvedTitle.set(id, section.title);
      freshSectionIds.add(id);
    }
  }

  // —— 页面：继承身份 + section 归属取协调后的 title ——
  const freshPageIds = new Set<MachinePageId>();
  const entries: MachinePageEntry[] = [];
  for (const entry of machine.pages) {
    const inherited = inheritedOf.get(entry.page.slug);
    if (!inherited) {
      freshPageIds.add(entry.id);
      entries.push(entry);
      continue;
    }
    entries.push({
      ...entry,
      page: {
        ...entry.page,
        slug: inherited.slug,
        file: inherited.file,
        title: inherited.title,
        ...(inherited.topicSummary !== undefined ? { topicSummary: inherited.topicSummary } : {}),
        ...(inherited.group !== undefined ? { group: inherited.group } : {}),
        level: inherited.level,
      },
    });
  }

  // section 归属：按机器分类的协调结果重写每页的 section
  const titleBySectionTitle = new Map<string, string>();
  for (const section of machine.sections) {
    titleBySectionTitle.set(section.title, resolvedTitle.get(section.id ?? '') ?? section.title);
  }
  for (const entry of entries) {
    entry.page.section = titleBySectionTitle.get(entry.page.section) ?? entry.page.section;
  }

  // —— 基础分类的 description / scope 从旧产物继承 ——
  const sections: WikiSection[] = machine.sections.map((section) => {
    const id = section.id ?? '';
    if (!isBaseSectionId(id)) {
      const resolved = resolvedTitle.get(id);
      if (resolved && resolved !== section.title) {
        const oldSection = oldSections.find((entry) => entry.title === resolved);
        return {
          ...section,
          title: resolved,
          ...(oldSection?.description ? { description: oldSection.description } : {}),
          ...(oldSection?.scope ? { scope: oldSection.scope } : {}),
        };
      }
      return section;
    }
    const oldSection = oldSections.find((entry) => entry.title === section.title);
    return {
      ...section,
      ...(oldSection?.description ? { description: oldSection.description } : {}),
      ...(oldSection?.scope ? { scope: oldSection.scope } : {}),
    };
  });

  // —— coverage 重算（slug 变了，fileOwner 必须重建）——
  const fileOwner: Record<string, string> = {};
  for (const entry of entries) {
    for (const file of entry.page.ownsFiles ?? []) fileOwner[file] = entry.page.slug;
  }
  const slicesBySection: Record<string, string[]> = {};
  for (const section of machine.sections) {
    slicesBySection[section.id ?? ''] = [...(section.slices ?? [])];
  }

  return {
    blueprint: {
      sections,
      pages: entries,
      coverage: {
        ...machine.coverage,
        fileOwner,
        slicesBySection,
      },
    },
    freshSectionIds,
    freshPageIds,
  };
}

// ==================== 读取 ====================

/**
 * Load Wiki Blueprint
 *
 * Load wiki.json from wiki directory.
 *
 * 三阶段流程中先写骨架（sections + 空 pages）、再增量补齐页面，
 * 因此「pages 为空」只有在 sections 也为空时才算非法。
 *
 * @param path - Optional custom path (defaults to `.zread-pi/wiki/<variant>/wiki.json`)
 * @param variant - 变体子目录（必填）
 * @returns WikiOutput with pages array
 * @throws Error if blueprint not found or invalid structure
 */
export async function loadWikiBlueprint(
  path: string | undefined,
  variant: BlueprintDetailLevel,
): Promise<WikiOutput> {
  const wikiDir = getWikiDir(variant);
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
