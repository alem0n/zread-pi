/**
 * Sync Wiki - Wiki 同步核心逻辑
 *
 * 流程：检测变更 → ensureStructureContext → buildMachineBlueprint → reconcileBlueprint
 *      → （按需）命名新增分类 / 新增页面 → 产出 SyncDiff
 *
 * 与旧实现的差异（有意为之）：
 * - 结构由代码重算（plan 链 A），sync 只让模型命名「新增」的分类 / 页面：
 *   命中既有页面的机器页整份继承旧身份（slug / 标题 / 摘要 / 分组 / 难度），
 *   URL 不漂移；未命中的页面才需要模型命名；
 * - 新增分类（多数票落败或无票）才跑分类命名阶段；新页面（未命中旧页面）才跑页面命名阶段；
 *   两者都为空时一个 Agent 都不跑（纯确定性同步）；
 * - 页面状态（new / updated / archived / unchanged）由代码机械判定（computeSyncDiff），
 *   不再由模型输出 status；SyncDiff 的语义与旧实现一致。
 */
import {
  loadConfig,
  createLogger,
  resolveWikiVariant,
  loadWikiBlueprint,
  writeWikiPages,
  withRunLog,
  buildFailedSectionsEvent,
  buildMachineBlueprint,
  initWikiBlueprint,
  reconcileBlueprint,
  type RunLogWriter,
} from '@zread-pi/utils';
import { scanFiles, parseFiles } from '@zread-pi/repo-analyzer';
import {
  loadCachedManifest,
  saveCachedManifest,
  saveCachedSymbols,
  diffManifests,
} from '@zread-pi/utils';
import {
  BlueprintUsageTracker,
  runSectionsNamingStage,
  runPagesNamingStage,
  type BlueprintStageContext,
} from '../agents/blueprint-stages.js';
import { ensureStructureContext } from './structure.js';
import type { SyncDiff, WikiPage } from '@zread-pi/types';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import type { BlueprintFailedSection, CatalogEvent } from '../types.js';
import type { TokenUsage } from '@zread-pi/agent-runtime';

/** 本模块的命名 logger（增量同步）。 */
const syncLogger = createLogger('orchestrator.sync');

export interface SyncResult {
  /** 变更分类结果 */
  diff: SyncDiff;
  /** Token 使用统计（所有同步 Agent 的合计） */
  tokenUsage?: TokenUsage;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 命名阶段失败的新增分类 / 页面（不阻断整体） */
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

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 页面是否发生变化（含关联路径命中本次 diff） */
function pageChanged(previous: WikiPage, next: WikiPage, changedFiles: Set<string>): boolean {
  if (previous.title !== next.title) return true;
  if ((previous.group ?? '') !== (next.group ?? '')) return true;
  if ((previous.level ?? 'Intermediate') !== (next.level ?? 'Intermediate')) return true;
  if ((previous.section ?? '') !== (next.section ?? '')) return true;
  if (!stringArraysEqual(previous.associatedFiles, next.associatedFiles)) return true;
  if (!stringArraysEqual(previous.ownsFiles, next.ownsFiles)) return true;
  return pageMatchesAny(next, changedFiles);
}

/**
 * 由新旧页面清单机械计算同步状态（纯函数）：
 * - slug 不存在于旧清单 → new；
 * - 旧 slug 在新清单里缺失 → archived（无条件；reconcile 后仍未命中的旧页面）；
 * - 标题/分组/难度/所属分类/关联路径/ownsFiles 变化，或关联路径命中本次 diff → updated；
 * - 其余 → unchanged。
 */
export function computeSyncDiff(options: {
  oldPages: WikiPage[];
  newPages: WikiPage[];
  changedFiles: Set<string>;
}): { pages: WikiPage[]; diff: SyncDiff } {
  const { oldPages, newPages, changedFiles } = options;
  const oldBySlug = new Map(oldPages.map((page) => [page.slug, page]));
  const newSlugs = new Set(newPages.map((page) => page.slug));

  const pages: WikiPage[] = [];
  const diff: SyncDiff = { newPages: [], updatedPages: [], archivedPages: [] };

  for (const page of newPages) {
    const previous = oldBySlug.get(page.slug);

    if (!previous) {
      page.status = 'new';
      diff.newPages.push(page);
    } else if (pageChanged(previous, page, changedFiles)) {
      page.status = 'updated';
      diff.updatedPages.push(page);
    } else {
      page.status = 'unchanged';
    }

    pages.push(page);
  }

  // 新清单里缺失的旧页面：无条件归档（reconcile 的贪心匹配已保证它们不再被需要）
  for (const previous of oldPages) {
    if (newSlugs.has(previous.slug)) continue;
    const archived: WikiPage = { ...previous, status: 'archived' };
    pages.push(archived);
    diff.archivedPages.push(archived);
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

/**
 * 解析 sync 的目标变体：显式指定 > 活动变体（配置档位 → 第一个存在档位） > 配置档位。
 *
 * 变体必非空：遗留目录布局已移除，任何 wiki.json 都在档位子目录下。
 */
function resolveSyncVariant(
  detail: BlueprintDetailLevel | null | undefined,
  configDetail: BlueprintDetailLevel,
): BlueprintDetailLevel {
  if (detail) return detail;
  return resolveWikiVariant(configDetail) ?? configDetail;
}

/**
 * Sync Wiki
 *
 * @param onEvent - 进度回调（与 generateWikiCatalog 兼容的 CatalogEvent）
 * @param options.detail - 要同步的档位变体；缺省 = 解析「当前活动变体」
 *   （配置档位 → 第一个存在的档位）；必为档位名（遗留目录布局已移除）。
 *   sync 只读写这一个变体，不触碰并存的其他档位产物。
 * @param options.runLog - 轨迹日志（缺省 = 自动创建单次 run）
 * @returns SyncDiff containing new/updated/archived pages
 */
export async function syncWiki(
  onEvent?: (event: CatalogEvent) => void,
  options: { detail?: BlueprintDetailLevel | null; runLog?: RunLogWriter } = {},
): Promise<SyncResult> {
  const config = await loadConfig();
  const variant = resolveSyncVariant(options.detail, config.blueprint.detail);
  // 未传 runLog 时自动创建单次 run（保证日志从不缺失）；传入时复用
  return withRunLog(
    options.runLog,
    {
      kind: 'sync',
      detail: variant,
      model: config.llm.model ?? undefined,
      provider: config.llm.provider ?? undefined,
    },
    (runLog) => syncWikiInternal(onEvent, options, runLog),
  );
}

async function syncWikiInternal(
  onEvent: ((event: CatalogEvent) => void) | undefined,
  options: { detail?: BlueprintDetailLevel | null },
  runLog: RunLogWriter,
): Promise<SyncResult> {
  const startTime = Date.now();
  const config = await loadConfig();
  // 要同步的变体：显式指定 > 活动变体（配置档位 → 第一个存在的档位）
  const variant = resolveSyncVariant(options.detail, config.blueprint.detail);
  const detail = variant;
  const minimal = detail === 'minimal';

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

  if (oldWikiJson.schemaVersion !== 2) {
    throw new Error(
      '旧版 wiki.json（schemaVersion 不是 2）不支持增量同步，请重新运行 generate 生成结构优先蓝图',
    );
  }

  // 构建 diff 摘要
  let change: ManifestDiff;
  let diffSummary: string;

  if (cachedManifest) {
    const diff = diffManifests(cachedManifest, currentManifest);

    // 无任何变更：跳过结构重算与 LLM 命名，直接返回空 diff
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

  // 解析 + 保存缓存（结构层依赖带 language 的符号清单）
  onEvent?.({ type: 'parsing' });
  const symbols = await parseFiles(currentManifest);
  await Promise.all([saveCachedManifest(currentManifest), saveCachedSymbols(symbols)]);

  // ——— 阶段2: 结构重算 + 对齐（确定性，无 LLM） ———
  const { structure } = await ensureStructureContext(detail, {
    language: config.doc_language,
    runLog,
  });

  const machine = buildMachineBlueprint(structure, config, { variant, minimal });
  const reconciled = reconcileBlueprint(machine, oldWikiJson, config);
  void diffSummary;

  // 对齐结果整份落盘（命中页继承旧身份；section 按多数票协调）
  await initWikiBlueprint(reconciled.blueprint, config, oldWikiJson.techStackSummary, {
    variant,
    minimal,
  });

  // ——— 阶段3: 只命名「新增」的分类 / 页面 ———
  const usage = new BlueprintUsageTracker();
  const context: BlueprintStageContext = {
    config,
    onEvent,
    usage,
    variant,
    runLog,
    structure,
    machinePages: reconciled.blueprint.pages,
  };

  const failedSections: BlueprintFailedSection[] = [];
  const freshSectionCount = reconciled.freshSectionIds.size;
  const freshPageCount = reconciled.freshPageIds.size;
  const needsNaming = !minimal && (freshSectionCount > 0 || freshPageCount > 0);

  if (needsNaming) {
    syncLogger.info(
      `sync：${freshSectionCount} 个新分类、${freshPageCount} 个新页面需要命名` +
        `（sections=[${[...reconciled.freshSectionIds].join(",")}]，pages=[${[
          ...reconciled.freshPageIds,
        ].join(",")}]）`,
    );

    if (freshSectionCount > 0) {
      // 分类命名失败时机器标题兜底（不产生 BlueprintFailedSection）
      await runSectionsNamingStage(context, reconciled.blueprint.sections, {
        onlyIds: reconciled.freshSectionIds,
      });
    }

    if (freshPageCount > 0) {
      const afterSections = await loadWikiBlueprint(undefined, variant);
      failedSections.push(
        ...(await runPagesNamingStage(context, afterSections.sections, {
          onlyIds: reconciled.freshPageIds,
        })),
      );
    }
  } else {
    syncLogger.info('sync：结构重算后无新增分类 / 页面，跳过所有命名 Agent');
  }

  // ——— 阶段4: 代码侧计算 SyncDiff 并写回 status ———
  const final = await loadWikiBlueprint(undefined, variant);
  const changedFiles = new Set(
    [...change.added, ...change.modified, ...change.removed].map(normalizePath),
  );

  const { pages, diff: syncDiff } = computeSyncDiff({
    oldPages: oldWikiJson.pages,
    newPages: final.pages,
    changedFiles,
  });
  await writeWikiPages(pages, { variant });

  const durationMs = Date.now() - startTime;
  const tokenUsage = usage.total();

  // 失败的新增分类 / 页面落进轨迹日志（不阻断其余产物）
  if (failedSections.length > 0) {
    runLog.append(buildFailedSectionsEvent({ sections: failedSections }));
  }

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
