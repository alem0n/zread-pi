/**
 * Sync Wiki - Wiki 同步核心逻辑
 *
 * 流程：检测变更 → LLM 重新规划 → 产出 SyncDiff
 */
import { FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool } from '@zread-pi/agent-runtime';
import { scanFiles, parseFiles } from '@zread-pi/repo-analyzer';
import {
  loadCachedManifest,
  saveCachedManifest,
  saveCachedSymbols,
  loadWikiBlueprint,
  diffManifests,
} from '@zread-pi/utils';
import { createAgent } from '../agents/create-agent';
import SyncCatalogPrompt from '../prompts/sync-catalog';
import {
  GenerateSyncBlueprintTool,
  ValidateBlueprintTool,
} from '../tools/output-tools.js';
import {
  GetCoreSignaturesTool,
  GetDirectoryTreeTool,
  GetModuleDetailsTool,
} from '../tools/repo-map-tools.js';
import type { SyncDiff } from '@zread-pi/types';
import type { CatalogEvent } from '../types.js';
import type { TokenUsage } from '@zread-pi/agent-runtime';

/** Sync Agent 工具列表 */
const SYNC_TOOLS = [
  GetDirectoryTreeTool,
  GetCoreSignaturesTool,
  GetModuleDetailsTool,
  GenerateSyncBlueprintTool,
  ValidateBlueprintTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
];

export interface SyncResult {
  /** 变更分类结果 */
  diff: SyncDiff;
  /** Token 使用统计 */
  tokenUsage?: TokenUsage;
  /** 耗时（毫秒） */
  durationMs: number;
}

/**
 * Sync Wiki
 *
 * @param onEvent - 进度回调（与 generateWikiCatalog 兼容的 CatalogEvent）
 * @returns SyncDiff containing new/updated/archived pages
 */
export async function syncWiki(
  onEvent?: (event: CatalogEvent) => void
): Promise<SyncResult> {
  const startTime = Date.now();

  // ——— 阶段1: 检测 ———
  onEvent?.({ type: 'scanning' });

  const [currentManifest, cachedManifest, oldWikiJson] = await Promise.all([
    scanFiles(),
    loadCachedManifest(),
    (async () => {
      try { return await loadWikiBlueprint(); } catch { return null; }
    })(),
  ]);

  if (!oldWikiJson) {
    throw new Error('No existing wiki.json found — run generate first');
  }

  // 构建 diff 摘要
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

    const parts: string[] = [];
    if (diff.added.length > 0) parts.push(`新增文件 (${diff.added.length}):\n${diff.added.map(f => `  + ${f}`).join('\n')}`);
    if (diff.modified.length > 0) parts.push(`修改文件 (${diff.modified.length}):\n${diff.modified.map(f => `  ~ ${f}`).join('\n')}`);
    if (diff.removed.length > 0) parts.push(`删除文件 (${diff.removed.length}):\n${diff.removed.map(f => `  - ${f}`).join('\n')}`);
    diffSummary = parts.join('\n\n');
  } else {
    diffSummary = `(无缓存 manifest，所有 ${currentManifest.files.length} 个文件视为新增)`;
  }

  // 解析 + 保存缓存
  onEvent?.({ type: 'parsing' });
  const symbols = await parseFiles(currentManifest);
  await Promise.all([
    saveCachedManifest(currentManifest),
    saveCachedSymbols(symbols),
  ]);

  // ——— 阶段2: 规划 ———
  const result = await createAgent({
    tools: SYNC_TOOLS,
    prompts: [
      `## 旧 wiki.json（参考）\n\`\`\`json\n${JSON.stringify(oldWikiJson, null, 2)}\n\`\`\``,
      `## 文件变更摘要\n${diffSummary}`,
      '## 任务',
      SyncCatalogPrompt as string,
    ].join('\n\n'),
    onEvent,
  });

  // 加载新生成的 wiki.json
  const newWikiJson = await loadWikiBlueprint();

  // 对比新旧 wiki.json，产出 SyncDiff
  const syncDiff: SyncDiff = {
    newPages: [],
    updatedPages: [],
    archivedPages: [],
  };

  for (const page of newWikiJson.pages) {
    switch (page.status) {
      case 'new':
        syncDiff.newPages.push(page);
        break;
      case 'updated':
        syncDiff.updatedPages.push(page);
        break;
      case 'archived':
        syncDiff.archivedPages.push(page);
        break;
      // unchanged pages are silently ignored
    }
  }

  return {
    diff: syncDiff,
    tokenUsage: result.tokenUsage,
    durationMs: Date.now() - startTime,
  };
}
