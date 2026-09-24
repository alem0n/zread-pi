/**
 * 结构层入口 —— plan §3 链 A 的 buildStructureCache
 *
 * 输入 SymbolManifest（新增 lineCount / ranges）+ FileManifest，
 * 产出 StructureCache：CEG → 切片（细级）→ 分类窗口选层 → 槽位集合覆盖。
 *
 * 纯函数 + 只读 manifest/symbols：不写任何仓库产物（审计件由调用方落盘）。
 * 确定性由算法本身保证（固定节点序 + 确定性平局打破），同输入两次构建逐字节一致。
 */

import type {
  FileManifest,
  SymbolManifest,
  StructureCache,
  StructureSlice,
} from '@zread-pi/types';
import { buildCodeGraph, computeExcluded, computeManifestHash } from './graph.js';
import { buildSlices } from './partition.js';
import {
  buildSections,
  buildSlots,
  computeSeams,
  type StructureSpec,
} from './coverage.js';

export interface BuildStructureOptions {
  spec: StructureSpec;
  /** minimal 档位：跳过分类选层（由机器蓝图侧收敛为 1 分类 1 页） */
  minimal?: boolean;
}

/** 目标页面数 = sections.max × max(1, round((topics.min + topics.max) / 2)) */
function targetPagesOf(spec: StructureSpec): number {
  const perSection = Math.max(1, Math.round((spec.topics.min + spec.topics.max) / 2));
  return Math.max(1, spec.sections.max * perSection);
}

/** 路径归一化：扫描器在 Windows 产出反斜杠，结构层一律按 POSIX 正斜杠处理 */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 在结构层边界把清单 / 符号的路径归一化为 POSIX（不改原对象） */
function normalizeInputs(
  symbols: SymbolManifest,
  manifest: FileManifest,
): { symbols: SymbolManifest; manifest: FileManifest } {
  const needsNormalize =
    manifest.files.some((file) => file.path.includes('\\')) ||
    symbols.symbols.some((symbol) => symbol.file.includes('\\'));
  if (!needsNormalize) return { symbols, manifest };
  return {
    symbols: {
      ...symbols,
      symbols: symbols.symbols.map((symbol) => ({ ...symbol, file: toPosix(symbol.file) })),
    },
    manifest: {
      ...manifest,
      files: manifest.files.map((file) => ({ ...file, path: toPosix(file.path) })),
    },
  };
}

/**
 * 构建结构缓存。
 *
 * @throws symbols 为空时抛出「无可解析源文件」（plan D21：致命、不静默回退）
 */
export function buildStructureCache(
  symbols: SymbolManifest,
  manifest: FileManifest,
  options: BuildStructureOptions,
): StructureCache {
  if (symbols.symbols.length === 0) {
    throw new Error(
      '目标仓库没有可解析的源文件，无法构建结构切分（md-only 或语言不可解析的仓库不支持）',
    );
  }

  const { spec } = options;
  const { symbols: normSymbols, manifest: normManifest } = normalizeInputs(symbols, manifest);
  const manifestHash = computeManifestHash(normManifest);
  const graph = buildCodeGraph(normSymbols, normManifest);
  const universe = graph.universe;
  const excluded = computeExcluded(normManifest, universe);

  // 切片（细级 = 页面级）
  const targetPages = targetPagesOf(spec);
  const minSliceSize = Math.max(1, Math.round(universe.length / targetPages));
  const { slices, sliceIndexOf, modularity, hierarchyCounts } = buildSlices(graph, normSymbols, {
    minSliceSize,
  });

  // 缝合线与 hub 度
  const { seams, fileSeamDegree, sliceSeamDegree } = computeSeams(graph, slices, sliceIndexOf);
  const slicesWithDegree: StructureSlice[] = slices.map((slice, index) => ({
    ...slice,
    seamDegree: sliceSeamDegree[index] ?? 0,
  }));

  // 分类级（minimal 跳过：机器蓝图侧收敛为 1 分类 1 页）
  const selection = options.minimal
    ? { sections: [], chosenCount: 0, hierarchyCounts: [], window: { min: 0, target: 0 } }
    : buildSections(graph, slicesWithDegree, sliceIndexOf, spec);

  // 全局槽位（minimal 也算：全景导览页需要 hub 路径作为 associatedFiles）
  const slots = buildSlots(seams, fileSeamDegree, 'zh');

  return {
    manifestHash,
    universe,
    excluded,
    edges: graph.edges,
    slices: slicesWithDegree,
    sections: selection.sections,
    slots,
    seams,
    modularity,
    params: {
      detail: spec.level,
      universeCount: universe.length,
      targetPages,
      minSliceSize,
      sectionWindow: selection.window,
      chosenSectionCount: selection.chosenCount,
      hierarchyCounts,
    },
  };
}

export { computeLineLedger } from './coverage.js';
export { computeManifestHash, computeExcluded, buildCodeGraph } from './graph.js';
export { buildSlices, louvainHierarchy, modularityOf, sliceQuotient } from './partition.js';
export {
  buildSections,
  buildSlots,
  computeSeams,
  hubCandidates,
  edgeView,
  type StructureSpec,
  type SectionSelection,
} from './coverage.js';
export type { CodeGraph } from './graph.js';
