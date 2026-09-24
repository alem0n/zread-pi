/**
 * Blueprint Orchestrator
 *
 * 结构优先蓝图（structure-first）：
 *   结构（代码，buildStructureCache）→ 机器骨架落盘 → 分类命名（LLM）→ 页面命名（LLM）
 *
 * 特点：
 * - sections / pages / slug / 文件归属全部由代码构造并先落盘（永不悬挂）；
 * - LLM 只负责命名（title / description / scope / summary / group / level），
 *   命名失败用机器默认值兜底；
 * - 单 section 失败记录到 failedSections，不阻断其余分类；
 * - 文章生成阶段（generateWikiContent）零改动，继续只消费最终 wiki.json。
 */

import {
  loadConfig,
  loadWikiBlueprint,
  withRunLog,
  buildFailedSectionsEvent,
  type RunLogWriter,
} from '@zread-pi/utils';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import {
  BlueprintUsageTracker,
  runStructureStage,
  runSectionsNamingStage,
  runPagesNamingStage,
} from './agents/blueprint-stages.js';
import { rememberCurrentProject } from './wiki/memory.js';
import { ensureStructureContext } from './wiki/structure.js';
import type {
  BlueprintFailedSection,
  BlueprintResult,
  CatalogEvent,
} from './types.js';
import type { BlueprintStageContext } from './agents/blueprint-stages.js';

/**
 * Generate Wiki Catalog
 *
 * 结构优先生成 wiki.json 目录结构（结构 → 分类命名 → 页面命名；支持可选进度回调）。
 *
 * 产物写入档位变体子目录 `wiki/<detail>/`（多档共存）；不传 options.detail 时
 * 用配置的 `blueprint.detail`（默认 high）。
 *
 * @param onEvent - 进度回调（可选；事件带 stage / section / 分类级 progress）
 * @param options.detail - 写入哪个档位变体（缺省 = 配置档位）
 * @param options.runLog - 轨迹日志（缺省 = 自动创建单次 run；传入时由上层控制生命周期）
 * @returns BlueprintResult with output path and metadata
 * @throws 结构构建失败（symbols 为空 / 算法异常）时致命报错，不回退旧路径
 */
export async function generateWikiCatalog(
  onEvent?: (event: CatalogEvent) => void,
  options: { detail?: BlueprintDetailLevel; runLog?: RunLogWriter } = {},
): Promise<BlueprintResult> {
  // 全局记忆：开始生成文档时记录当前项目（失败不阻断生成）
  await rememberCurrentProject();

  const startTime = performance.now();
  const config = await loadConfig();
  const detail = options.detail ?? config.blueprint.detail;
  const usage = new BlueprintUsageTracker();

  return withRunLog(
    options.runLog,
    {
      kind: 'generate',
      detail,
      model: config.llm.model ?? undefined,
      provider: config.llm.provider ?? undefined,
    },
    async (runLog) => {
      const context: BlueprintStageContext = { config, onEvent, usage, variant: detail, runLog };

      // —— 阶段 0：结构预计算（纯代码；symbols 为空时致命报错 D21）——
      const { structure } = await ensureStructureContext(detail, {
        language: config.doc_language,
        runLog,
      });
      context.structure = structure;

      // —— 阶段 1：结构 → 机器骨架（致命失败）——
      const { sections, pages } = await runStructureStage(context);

      // —— 阶段 2：分类命名（失败用机器标题兜底）——
      const namedSections = await runSectionsNamingStage(context, sections);

      // —— 阶段 3：页面命名（单分类失败不阻断）——
      const failedSections: BlueprintFailedSection[] = await runPagesNamingStage(context, namedSections);

      // 失败分类落进轨迹日志（不阻断其余分类的产物）
      if (failedSections.length > 0) {
        runLog.append(buildFailedSectionsEvent({ sections: failedSections }));
      }

      // Agent 正常结束 ≠ 蓝图已落盘/有效：所有阶段结束后再校验一次 wiki.json 可加载。
      let blueprint;
      try {
        blueprint = await loadWikiBlueprint(undefined, detail);
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
        sectionsCount: namedSections.length,
        ...(failedSections.length > 0 ? { failedSections } : {}),
        durationMs,
        tokenUsage,
      };
    },
  );
}

// Re-export types
export type { BlueprintOptions, BlueprintResult, CatalogEvent } from './types.js';

// Sync exports
export { syncWiki } from './wiki/sync-wiki.js';
export type { SyncResult } from './wiki/sync-wiki.js';
