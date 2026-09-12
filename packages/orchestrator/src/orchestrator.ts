/**
 * Blueprint Orchestrator
 *
 * Coordinates single Blueprint Agent to generate wiki.json blueprint.
 */

import { FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool, LsTool } from '@zread-pi/agent-runtime';
import { loadWikiBlueprint } from '@zread-pi/utils';
import { createAgent } from './agents/create-agent';
import { rememberCurrentProject } from './wiki/memory.js';
import GenerateCatalog from './prompts/generate-catalog';
import { GenerateBlueprintTool, ValidateBlueprintTool } from './tools/output-tools.js';
import { GetCoreSignaturesTool, GetDirectoryTreeTool, GetModuleDetailsTool } from './tools/repo-map-tools.js';
import type { BlueprintResult, CatalogEvent } from './types.js';

/** Blueprint Agent 工具列表 */
const BLUEPRINT_TOOLS = [
  // 三层 Repo Map 工具
  GetDirectoryTreeTool,      // Layer 1: 目录树
  GetCoreSignaturesTool,     // Layer 2: 核心签名
  GetModuleDetailsTool,      // Layer 3: 模块详情
  // 输出工具
  GenerateBlueprintTool,     // 生成 wiki.json
  ValidateBlueprintTool,     // 验证蓝图
  // 基础工具
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  LsTool,
];

/**
 * Generate Wiki Catalog
 *
 * 使用 Blueprint Agent 生成 wiki.json 目录结构。
 * 支持可选进度回调用于实时 UI 更新。
 *
 * @param onEvent - 进度回调（可选）
 * @returns BlueprintResult with output path and metadata
 */
export async function generateWikiCatalog(
  onEvent?: (event: CatalogEvent) => void
): Promise<BlueprintResult> {
  // 全局记忆：开始生成文档时记录当前项目（失败不阻断生成）
  await rememberCurrentProject();

  const result = await createAgent({
    tools: BLUEPRINT_TOOLS,
    prompts: GenerateCatalog as string,
    onEvent,
  });

  // Agent 正常结束 ≠ 蓝图已落盘/有效：模型可能只输出文字，或写出非法 JSON。
  // 校验 wiki.json 可加载，避免生成界面显示目录完成、而首页按文件检查判定「无目录」。
  try {
    await loadWikiBlueprint();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`目录生成未产出有效 wiki.json：${message}`);
  }

  return {
    pagesCount: 0,
    durationMs: result.durationMs,
    tokenUsage: result.tokenUsage,
  };
}

// Re-export types
export type { BlueprintOptions, BlueprintResult, CatalogEvent } from './types.js';

// Sync exports
export { syncWiki } from './wiki/sync-wiki.js';
export type { SyncResult } from './wiki/sync-wiki.js';
