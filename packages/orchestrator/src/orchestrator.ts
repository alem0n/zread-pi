/**
 * Blueprint Orchestrator
 *
 * 蓝图生成已从「单 Agent 一次性吐全量页面」改为三阶段多重循环：
 *   分类（1 个 Agent，sections）→ 分主题（每个 section 1 个 Agent，页面）
 *   → 标题（每个 section 1 个 Agent，精修 title）
 *
 * 特点：
 * - 每阶段增量归并进 wiki.json（文件锁 + 原子替换），任一阶段落盘后都可加载；
 * - slug / file 编号与去重由代码统一管理，不依赖模型；
 * - 单 section 失败记录到 failedSections，不阻断其余分类；
 * - 文章生成阶段（generateWikiContent）零改动，继续只消费最终 wiki.json。
 */

import { loadConfig, loadWikiBlueprint } from '@zread-pi/utils';
import {
  BlueprintUsageTracker,
  runClassifyStage,
  runTopicsStage,
  runTitlesStage,
} from './agents/blueprint-stages.js';
import { rememberCurrentProject } from './wiki/memory.js';
import type { BlueprintFailedSection, BlueprintResult, CatalogEvent } from './types.js';

/**
 * Generate Wiki Catalog
 *
 * 三阶段生成 wiki.json 目录结构（支持可选进度回调用于实时 UI 更新）。
 *
 * @param onEvent - 进度回调（可选；事件带 stage / section / 分类级 progress）
 * @returns BlueprintResult with output path and metadata
 */
export async function generateWikiCatalog(
  onEvent?: (event: CatalogEvent) => void,
): Promise<BlueprintResult> {
  // 全局记忆：开始生成文档时记录当前项目（失败不阻断生成）
  await rememberCurrentProject();

  const startTime = performance.now();
  const config = await loadConfig();
  const usage = new BlueprintUsageTracker();
  const context = { config, onEvent, usage };

  // —— 阶段 1：分类（单 Agent；失败致命，直接抛出）——
  const sections = await runClassifyStage(context);

  // —— 阶段 2：分主题（按 section 并发；单 section 失败不阻断）——
  const failedSections: BlueprintFailedSection[] = await runTopicsStage(context, sections);

  // —— 阶段 3：标题（输入分主题后的页面列表；失败保留原 title）——
  const afterTopics = await loadWikiBlueprint().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`目录生成未产出有效 wiki.json：${message}`, { cause: err });
  });

  if (afterTopics.pages.length === 0) {
    throw new Error('目录生成未产出有效 wiki.json：所有分类都未能产出页面');
  }

  failedSections.push(...(await runTitlesStage(context, sections, afterTopics.pages)));

  // Agent 正常结束 ≠ 蓝图已落盘/有效：所有阶段结束后再校验一次 wiki.json 可加载，
  // 避免生成界面显示目录完成、而首页按文件检查判定「无目录」。
  let blueprint;
  try {
    blueprint = await loadWikiBlueprint();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`目录生成未产出有效 wiki.json：${message}`, { cause: err });
  }

  if (blueprint.pages.length === 0) {
    throw new Error('目录生成未产出有效 wiki.json：所有分类都未能产出页面');
  }

  const durationMs = Math.round(performance.now() - startTime);
  const tokenUsage = usage.total();

  onEvent?.({
    type: 'complete',
    usage: tokenUsage,
    durationMs,
    ...(failedSections.length > 0 ? { failedSections } : {}),
  });

  return {
    pagesCount: blueprint.pages.length,
    sectionsCount: sections.length,
    ...(failedSections.length > 0 ? { failedSections } : {}),
    durationMs,
    tokenUsage,
  };
}

// Re-export types
export type { BlueprintOptions, BlueprintResult, CatalogEvent } from './types.js';

// Sync exports
export { syncWiki } from './wiki/sync-wiki.js';
export type { SyncResult } from './wiki/sync-wiki.js';
