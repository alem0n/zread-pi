/**
 * 结构预计算（链 A）—— plan §3
 *
 * 从符号 / 文件缓存构建 StructureCache，并落盘审计件
 * `.zread-pi/cache/structure-<detail>.json`（每次运行重算重写，无缓存读路径；
 * 确定性由 test:analyzer 保证，产物供 diff 审计）。
 *
 * 缓存缺失时自愈重建（scan + parse + save），不静默降级；
 * symbols 仍为空时致命报错（D21）。
 */

import { join } from 'node:path';
import {
  scanFiles,
  parseFiles,
  buildStructureCache,
  type StructureSpec,
} from '@zread-pi/repo-analyzer';
import {
  loadCachedSymbols,
  saveCachedManifest,
  saveCachedSymbols,
  getCacheDir,
  writeJsonFile,
  createLogger,
  type RunLogWriter,
  buildStageEvent,
} from '@zread-pi/utils';
import type { BlueprintDetailLevel, StructureCache } from '@zread-pi/types';

const logger = createLogger('orchestrator.structure');

/** 档位 → 结构层参数（区间是目标参数，不是硬约束；plan D7） */
const STRUCTURE_SPECS: Record<BlueprintDetailLevel, StructureSpec> = {
  minimal: { level: 'minimal', sections: { min: 1, max: 1 }, topics: { min: 1, max: 1 } },
  low: { level: 'low', sections: { min: 2, max: 5 }, topics: { min: 1, max: 3 } },
  medium: { level: 'medium', sections: { min: 3, max: 6 }, topics: { min: 3, max: 5 } },
  high: { level: 'high', sections: { min: 3, max: 8 }, topics: { min: 3, max: 10 } },
  max: { level: 'max', sections: { min: 3, max: 8 }, topics: { min: 5, max: 12 } },
};

export interface EnsureStructureResult {
  structure: StructureCache;
  /** 审计件落盘路径 */
  auditPath: string;
}

/**
 * 确保结构上下文可用：扫描 → 解析（缓存优先）→ 构建 StructureCache。
 *
 * 文件清单必须带 language（结构层哈希与边解析依赖它），扫描器是唯一来源；
 * 符号清单优先用缓存（controller 已解析过），缺失 / 空时自愈解析。
 *
 * @throws symbols 为空时抛出「目标仓库没有可解析的源文件」（D21：致命、不静默回退）
 */
export async function ensureStructureContext(
  detail: BlueprintDetailLevel,
  options: { language?: string; runLog?: RunLogWriter } = {},
): Promise<EnsureStructureResult> {
  const spec = STRUCTURE_SPECS[detail];
  const language = options.language ?? 'zh';

  // 1. 文件清单（扫描器是 language 的唯一来源；顺带落缓存供 diff / verify 用）
  const manifest = await scanFiles(process.cwd());
  await saveCachedManifest(manifest);

  // 2. 符号清单（缓存优先；缺失 / 空 → 自愈解析）
  let symbols = await loadCachedSymbols();
  if (!symbols || symbols.symbols.length === 0) {
    logger.info('符号清单缓存缺失，重新解析');
    symbols = await parseFiles(manifest);
    await saveCachedSymbols(symbols);
  }

  // 3. 结构缓存（抛出 = 致命，不回退）
  const structure = buildStructureCache(symbols, manifest, { spec, language });

  // 4. 审计件（每次重算重写）
  const auditPath = join(getCacheDir(), `structure-${detail}.json`);
  await writeJsonFile(auditPath, structure);

  options.runLog?.append(buildStageEvent({ stage: 'structure' }));

  logger.info(
    `结构层完成：${structure.universe.length} 个文件 → ${structure.slices.length} 个切片 → ` +
      `${structure.sections.length} 个结构分类（模块度 ${structure.modularity.toFixed(3)}，` +
      `${structure.seams.length} 条缝合线）`,
  );

  return { structure, auditPath };
}
