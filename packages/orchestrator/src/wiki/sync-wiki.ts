/**
 * Sync Wiki - Wiki 同步核心逻辑
 *
 * 流程：检测变更 → （按需）合并分类 → 按变更 section 分主题 / 标题增量修补 → 产出 SyncDiff
 *
 * 与旧实现的差异（有意为之，见 MIGRATION.md §17）：
 * - 不再让模型一次性重排整个 wiki.json，而是先做文件 diff，再只对「受影响的分类」
 *   跑主题 / 标题阶段；未受影响的页面原样保留，URL（slug/file）不漂移；
 * - 新增文件不属于任何既有页面时，才额外跑一次分类阶段（合并模式）补出新分类；
 * - 页面状态（new / updated / archived / unchanged）由代码比较新旧页面机械判定，
 *   不再由模型输出 status；SyncDiff 的语义与旧实现一致。
 */
import { loadConfig, logger, resolveWikiVariant, sectionsFromBlueprint, loadWikiBlueprint, writeWikiPages } from '@zread-pi/utils';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanFiles, parseFiles } from '@zread-pi/repo-analyzer';
import {
  loadCachedManifest,
  saveCachedManifest,
  saveCachedSymbols,
  diffManifests,
} from '@zread-pi/utils';
import {
  BlueprintUsageTracker,
  runClassifyStage,
  runTopicsStage,
  runTitlesStage,
} from '../agents/blueprint-stages.js';
import { SYNC_TOPICS_RULES } from '../prompts/topics';
import type { SyncDiff, WikiPage } from '@zread-pi/types';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import type { BlueprintFailedSection, CatalogEvent } from '../types.js';
import type { TokenUsage } from '@zread-pi/agent-runtime';

export interface SyncResult {
  /** 变更分类结果 */
  diff: SyncDiff;
  /** Token 使用统计（所有同步 Agent 的合计） */
  tokenUsage?: TokenUsage;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 分主题 / 标题阶段失败的分类（不阻断整体） */
  failedSections?: BlueprintFailedSection[];
}

interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

/** 路径归一化：统一正斜杠、去掉 ./ 前缀（跨平台比较用） */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 关联路径是否覆盖某个文件/目录（目录以 / 结尾时按前缀匹配） */
function coversPath(entry: string, path: string): boolean {
  const normalized = normalizePath(entry);
  if (!normalized) return false;
  if (normalized.endsWith('/')) {
    const dir = normalized.replace(/\/+$/, '');
    return path === dir || path.startsWith(`${dir}/`);
  }
  return path === normalized;
}

function pageMatchesAny(page: WikiPage, paths: Iterable<string>): boolean {
  const associated = page.associatedFiles ?? [];
  if (associated.length === 0) return false;
  for (const path of paths) {
    if (associated.some((entry) => coversPath(entry, path))) return true;
  }
  return false;
}

/** 关联路径在最新清单里是否仍然存在 */
function pathStillPresent(entry: string, currentFiles: Set<string>): boolean {
  const normalized = normalizePath(entry);
  if (!normalized) return false;
  if (normalized.endsWith('/')) {
    const dir = normalized.replace(/\/+$/, '');
    for (const file of currentFiles) {
      if (file === dir || file.startsWith(`${dir}/`)) return true;
    }
    return false;
  }
  return currentFiles.has(normalized);
}

/**
 * 关联路径是否真实存在（sync 用；覆盖 README 等不入 manifest 的文件与目录）。
 * 相对于当前工作目录（CLI 已切换到目标仓库）。
 */
function pathExistsOnDisk(entry: string): boolean {
  const normalized = normalizePath(entry);
  if (!normalized) return false;
  try {
    return existsSync(resolve(process.cwd(), normalized));
  } catch {
    return false;
  }
}

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 页面元数据是否发生变化（含关联路径落在本次 diff 里） */
function pageChanged(previous: WikiPage, next: WikiPage, changedFiles: Set<string>): boolean {
  if (previous.title !== next.title) return true;
  if ((previous.group ?? '') !== (next.group ?? '')) return true;
  if ((previous.level ?? 'Intermediate') !== (next.level ?? 'Intermediate')) return true;
  if (!stringArraysEqual(previous.associatedFiles, next.associatedFiles)) return true;
  return pageMatchesAny(next, changedFiles);
}

/**
 * 由新旧页面清单机械计算同步状态（纯函数）：
 * - slug 不存在于旧清单 → new；
 * - 关联文件全部消失 → archived（不删除页面记录，SyncDiff 交由上层归档 .md）；
 * - 标题/分组/难度/关联路径变化，或关联路径命中本次 diff → updated；
 * - 其余 → unchanged。
 *
 * 旧清单里存在、新清单里缺失的页面（例如主题阶段漏报）会原样保留为 unchanged，
 * 避免增量修补过程中的模型遗漏导致页面丢失。
 */
export function computeSyncDiff(options: {
  oldPages: WikiPage[];
  newPages: WikiPage[];
  changedFiles: Set<string>;
  currentFiles: Set<string>;
  /**
   * 关联路径是否仍存在；缺省按 manifest 前缀判断。
   * sync 会传入基于文件系统的检查——README 等非扫描源码不在 manifest 里，
   * 只用 manifest 会把它们误判为「文件已删除」。
   */
  isPathPresent?: (entry: string) => boolean;
}): { pages: WikiPage[]; diff: SyncDiff } {
  const { oldPages, newPages, changedFiles, currentFiles } = options;
  const pathPresent = options.isPathPresent ?? ((entry: string) => pathStillPresent(entry, currentFiles));
  const filesGone = (page: WikiPage): boolean => {
    const associated = page.associatedFiles ?? [];
    return associated.length > 0 && associated.every((entry) => !pathPresent(entry));
  };
  const oldBySlug = new Map(oldPages.map((page) => [page.slug, page]));
  const newSlugs = new Set(newPages.map((page) => page.slug));

  const pages: WikiPage[] = [];
  const diff: SyncDiff = { newPages: [], updatedPages: [], archivedPages: [] };

  for (const page of newPages) {
    const previous = oldBySlug.get(page.slug);

    if (!previous) {
      page.status = 'new';
      diff.newPages.push(page);
    } else if (filesGone(page)) {
      page.status = 'archived';
      diff.archivedPages.push(page);
    } else if (pageChanged(previous, page, changedFiles)) {
      page.status = 'updated';
      diff.updatedPages.push(page);
    } else {
      page.status = 'unchanged';
    }

    pages.push(page);
  }

  // 新清单里缺失的旧页面：文件仍在则保留（漏报兜底）；全部文件消失则归档
  for (const previous of oldPages) {
    if (newSlugs.has(previous.slug)) continue;
    const archived = filesGone(previous);
    const carried: WikiPage = { ...previous, status: archived ? 'archived' : 'unchanged' };
    pages.push(carried);
    if (archived) diff.archivedPages.push(carried);
  }

  return { pages, diff };
}

function formatDiffSummary(diff: ManifestDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`新增文件 (${diff.added.length}):\n${diff.added.map((file) => `  + ${file}`).join('\n')}`);
  }
  if (diff.modified.length > 0) {
    parts.push(`修改文件 (${diff.modified.length}):\n${diff.modified.map((file) => `  ~ ${file}`).join('\n')}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`删除文件 (${diff.removed.length}):\n${diff.removed.map((file) => `  - ${file}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function buildSyncTopicsRules(
  oldPages: WikiPage[],
  sectionTitle: string,
  diffSummary: string,
): string {
  const sectionPages = oldPages.filter(
    (page) => page.section.trim().toLowerCase() === sectionTitle.trim().toLowerCase(),
  );

  const pageLines =
    sectionPages.length > 0
      ? sectionPages.map((page) => {
          const group = page.group ? `（group: ${page.group}）` : '';
          const level = page.level ? `（level: ${page.level}）` : '';
          const files = page.associatedFiles?.length ? ` [files: ${page.associatedFiles.join(', ')}]` : '';
          return `- ${page.slug}: ${page.title}${group}${level}${files}`;
        })
      : ['（本分类暂无旧页面）'];

  return [
    SYNC_TOPICS_RULES,
    '',
    '## 本分类的旧页面清单（保留的页面必须原样带回 slug 与 title）',
    ...pageLines,
    '',
    '## 文件变更摘要',
    diffSummary,
  ].join('\n');
}

/**
 * Sync Wiki
 *
 * @param onEvent - 进度回调（与 generateWikiCatalog 兼容的 CatalogEvent）
 * @param options.detail - 要同步的档位变体；缺省 = 解析「当前活动变体」
 *   （配置档位 → 遗留目录 → 第一个存在的档位）；`null` = 遗留目录。
 *   sync 只读写这一个变体，不触碰并存的其他档位产物。
 * @returns SyncDiff containing new/updated/archived pages
 */
export async function syncWiki(
  onEvent?: (event: CatalogEvent) => void,
  options: { detail?: BlueprintDetailLevel | null } = {},
): Promise<SyncResult> {
  const startTime = Date.now();
  const config = await loadConfig();
  // 要同步的变体：显式指定 > 活动变体（配置档位 → 遗留 → 第一个存在的档位）
  const variant =
    options.detail !== undefined
      ? options.detail
      : (resolveWikiVariant(config.blueprint.detail) ?? null);
  const detail = variant ?? config.blueprint.detail;

  // ——— 阶段1: 检测 ———
  onEvent?.({ type: 'scanning' });

  const [currentManifest, cachedManifest, oldWikiJson] = await Promise.all([
    scanFiles(),
    loadCachedManifest(),
    (async () => {
      try {
        return await loadWikiBlueprint(undefined, variant);
      } catch {
        return null;
      }
    })(),
  ]);

  if (!oldWikiJson) {
    throw new Error('No existing wiki.json found — run generate first');
  }

  // 构建 diff 摘要
  let change: ManifestDiff;
  let diffSummary: string;

  if (cachedManifest) {
    const diff = diffManifests(cachedManifest, currentManifest);

    // 无任何变更：跳过 LLM 规划，直接返回空 diff
    if (diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0) {
      onEvent?.({ type: 'complete', durationMs: Date.now() - startTime });
      return {
        diff: { newPages: [], updatedPages: [], archivedPages: [] },
        durationMs: Date.now() - startTime,
      };
    }

    change = diff;
    diffSummary = formatDiffSummary(diff);
  } else {
    change = { added: currentManifest.files.map((file) => file.path), modified: [], removed: [] };
    diffSummary = `(无缓存 manifest，所有 ${currentManifest.files.length} 个文件视为新增)`;
  }

  // 解析 + 保存缓存
  onEvent?.({ type: 'parsing' });
  const symbols = await parseFiles(currentManifest);
  await Promise.all([saveCachedManifest(currentManifest), saveCachedSymbols(symbols)]);

  // ——— 阶段2: 按变更 section 增量修补 ———
  const usage = new BlueprintUsageTracker();
  const context = { config, onEvent, usage, variant, detail };

  const oldPages = oldWikiJson.pages;
  const oldSections = sectionsFromBlueprint(oldWikiJson);
  const oldSectionKeys = new Set(oldSections.map((section) => section.title.trim().toLowerCase()));

  const currentFiles = new Set(currentManifest.files.map((file) => normalizePath(file.path)));
  const changedFiles = new Set(
    [...change.added, ...change.modified, ...change.removed].map(normalizePath),
  );

  // 变更命中既有页面的关联路径 → 该 section 需要重新规划主题
  const affected = new Set<string>();
  for (const page of oldPages) {
    if (pageMatchesAny(page, changedFiles)) affected.add(page.section.trim().toLowerCase());
  }

  // 新增文件不属于任何既有页面 → 跑分类阶段（合并模式）补出新分类
  const uncoveredAdded = change.added
    .map(normalizePath)
    .filter((path) => !oldPages.some((page) => pageMatchesAny(page, [path])));

  if (uncoveredAdded.length > 0) {
    const extraContext = [
      '## 旧分类清单（已有分类的标题尽量保持不变）',
      ...oldSections.map((section) => `- ${section.title}${section.description ? `：${section.description}` : ''}`),
      '',
      '## 文件变更摘要',
      diffSummary,
      '',
      `以下新增文件不属于任何既有页面，如有必要请补出新的分类：\n${uncoveredAdded
        .map((file) => `  + ${file}`)
        .join('\n')}`,
    ].join('\n');

    try {
      const merged = await runClassifyStage(context, { merge: true, extraContext });
      for (const section of merged) {
        if (!oldSectionKeys.has(section.title.trim().toLowerCase())) {
          affected.add(section.title.trim().toLowerCase());
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`sync 分类阶段失败（新增文件无法归入新分类，已跳过）：${message}`);
    }
  }

  // 读取最新 sections（分类阶段可能补了新分类）
  const latest = await loadWikiBlueprint(undefined, variant);
  const sections = sectionsFromBlueprint(latest);
  const targetSections = sections.filter((section) =>
    affected.has(section.title.trim().toLowerCase()),
  );

  const failedSections: BlueprintFailedSection[] = [];

  if (targetSections.length > 0) {
    logger.info(`sync：${targetSections.length} 个分类需要增量修补（${targetSections.map((s) => s.title).join('、')}）`);

    failedSections.push(
      ...(await runTopicsStage(context, targetSections, {
        reuseExisting: true,
        extraRules: (section) => buildSyncTopicsRules(oldPages, section.title, diffSummary),
      })),
    );

    const afterTopics = await loadWikiBlueprint(undefined, variant);
    failedSections.push(...(await runTitlesStage(context, targetSections, afterTopics.pages)));
  }

  // ——— 阶段3: 代码侧计算 SyncDiff 并写回 status ———
  const afterStages = await loadWikiBlueprint(undefined, variant);
  const { pages, diff: syncDiff } = computeSyncDiff({
    oldPages,
    newPages: afterStages.pages,
    changedFiles,
    currentFiles,
    // README / docs 等不在 manifest 里的关联路径：按文件系统实际存在判断
    isPathPresent: pathExistsOnDisk,
  });
  await writeWikiPages(pages, { variant });

  const durationMs = Date.now() - startTime;
  const tokenUsage = usage.total();

  onEvent?.({
    type: 'complete',
    usage: tokenUsage,
    durationMs,
    ...(failedSections.length > 0 ? { failedSections } : {}),
  });

  return {
    diff: syncDiff,
    tokenUsage,
    durationMs,
    ...(failedSections.length > 0 ? { failedSections } : {}),
  };
}
