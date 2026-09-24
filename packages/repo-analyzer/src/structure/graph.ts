/**
 * Code Entity Graph（CEG，文件级）—— §5.1
 *
 * 节点 = 可解析源文件（全集 U，字典序固定）；边 = import（权 2）/ reexport（权 3）。
 * 切分输入用无向投影 `w({u,v}) = max(双向有向权)`；缝合线记录保留有向。
 *
 * 边抽取是 best-effort 启发式（按 plan §5.1 三条规则）：
 * 反射 / 动态注册 / 宏生成的边不在图内——零度文件由孤儿规则兜底（§5.2 ④）。
 */

import { createHash } from 'node:crypto';
import type {
  FileManifest,
  SymbolManifest,
  StructureEdge,
  StructureEdgeKind,
} from '@zread-pi/types';

/** 相对路径补全时逐个追加尝试的扩展名序列（plan §5.1 规则 1） */
const EXTENSION_CANDIDATES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.d.ts',
  '.py', '.go', '.rs', '.java', '.php', '.rb', '.swift', '.kt',
  '.cs', '.c', '.h', '.cpp', '.hpp',
];

const WEIGHTS: Record<StructureEdgeKind, number> = { import: 2, reexport: 3 };

/**
 * POSIX 路径处理（不依赖 node:path，避免 Windows 反斜杠污染；
 * 输入路径一律为扫描器产出的正斜杠相对路径）。
 */
function normalizePosix(path: string): string {
  const result: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') result.pop();
      else result.push('..');
      continue;
    }
    result.push(segment);
  }
  return result.join('/');
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function posixJoin(base: string, relative: string): string {
  return normalizePosix(`${base}/${relative}`);
}

/** 取首个引号字面量；C 的 `#include <…>` 取尖括号内 */
function firstQuotedLiteral(text: string): string | null {
  const quoted = /'([^']*)'|"([^"]*)"/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  const angle = /<([^>]+)>/.exec(text);
  if (angle) return angle[1] ?? '';
  return null;
}

/** 去扩展名的 basename（用于唯一匹配） */
function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * 无引号字面量的模块说明符（python `from x import y` / rust `use a::b`）：
 * 取模块路径的**最后一段**，按去扩展名 basename 唯一匹配。
 */
function moduleLastSegment(text: string): string | null {
  const fromMatch = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(text);
  if (fromMatch) return lastSegmentOfPath(fromMatch[1]);

  const useMatch = /^\s*use\s+([A-Za-z_][\w:]*)/.exec(text);
  if (useMatch) {
    const path = useMatch[1].replace(/::\{[\s\S]*$/, '').replace(/::\*$/, '');
    return lastSegmentOfPath(path);
  }

  const importMatch = /^\s*import\s+([A-Za-z_][\w.]*)/.exec(text);
  if (importMatch) return lastSegmentOfPath(importMatch[1]);

  return null;
}

function lastSegmentOfPath(path: string): string {
  const segments = path.split(/[.:]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

/** 清单哈希：只用实读字段 path / language，排序后 sha256（plan §5.1） */
export function computeManifestHash(manifest: FileManifest): string {
  const entries = manifest.files
    .map((file) => [file.path, file.language] as [string, string])
    .sort();
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export interface CodeGraph {
  /** 全集 U（字典序） */
  universe: string[];
  /** path → universe 索引 */
  index: Map<string, number>;
  /** 有向边（同有序对取最大权，去自环，顺序确定） */
  edges: StructureEdge[];
  /** 无向邻接（对称投影，max(双向权)；索引同 universe） */
  adjacency: Array<Map<number, number>>;
}

/**
 * 解析单条 import / reexport 文本，给出目标文件（U 内唯一则建边，否则 null）。
 *
 * 规则 1（有引号字面量）：相对路径 join(dirname(from), cand) → 原样 → 逐扩展名 → basename；
 * 非相对路径 → basename 唯一匹配；歧义不建边。
 * 规则 2（无引号）：模块路径最后一段 → 去扩展名 basename 唯一匹配。
 */
function resolveImportTarget(
  text: string,
  from: string,
  graph: CodeGraph,
): string | null {
  const literal = firstQuotedLiteral(text);
  if (literal !== null) {
    const relative = literal.startsWith('.');
    const candidates: string[] = [];
    if (relative) {
      const joined = normalizePosix(posixJoin(posixDirname(from), literal));
      pushResolutionCandidates(candidates, joined);
      // 相对路径最后兜底：basename 唯一匹配
      candidates.push(basenameOf(literal));
    } else {
      candidates.push(basenameOf(literal));
    }
    for (const candidate of candidates) {
      const normalized = normalizePosix(candidate);
      if (!normalized) continue;
      if (graph.index.has(normalized)) return normalized;
    }
    // 相对路径按 basename 唯一匹配（上面的 candidates 已覆盖相对的 basename 兜底）
    if (!relative) {
      const base = basenameOf(literal);
      const unique = uniqueByBase(graph, base);
      if (unique) return unique;
    }
    return null;
  }

  const segment = moduleLastSegment(text);
  if (!segment) return null;
  return uniqueByStem(graph, segment);
}

/** 去掉最后一个扩展名（`.d.ts` 整体去掉），供扩展名替换式补全 */
function stripExtension(path: string): string {
  if (path.endsWith('.d.ts')) return path.slice(0, -5);
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot > slash) return path.slice(0, dot);
  return path;
}

/**
 * 相对路径的候选序列：原样 → 替换扩展名（TS 的 `./foo.js` 指向 `foo.ts` 是 ESM 约定）。
 * plan §5.1「逐个追加」在带扩展名的候选上等价于「替换」，这里统一处理两种形态。
 */
function pushResolutionCandidates(candidates: string[], joined: string): void {
  candidates.push(joined);
  const withoutExt = stripExtension(joined);
  for (const ext of EXTENSION_CANDIDATES) candidates.push(`${withoutExt}${ext}`);
}

/** 按 basename（含扩展名）唯一匹配；0 个或 ≥2 个都视为歧义 */
function uniqueByBase(graph: CodeGraph, base: string): string | null {
  let hit: string | null = null;
  for (const path of graph.universe) {
    if (basenameOf(path) !== base) continue;
    if (hit !== null) return null;
    hit = path;
  }
  return hit;
}

/** 按 basename（含扩展名）唯一匹配（构造期版本，直接扫 universe） */
function uniqueByStem(graph: CodeGraph, stem: string): string | null {
  let hit: string | null = null;
  for (const path of graph.universe) {
    if (stemOf(path) !== stem) continue;
    if (hit !== null) return null;
    hit = path;
  }
  return hit;
}

interface EdgeAccumulator {
  key: number;
  from: number;
  to: number;
  kind: StructureEdgeKind;
  weight: number;
}

/**
 * 构造 CEG。
 *
 * @param symbols - 符号清单（其 file 字段构成全集 U）
 * @param manifest - 文件清单（excluded = manifest.files − U）
 */
export function buildCodeGraph(symbols: SymbolManifest, manifest: FileManifest): CodeGraph {
  const universe = [...new Set(symbols.symbols.map((symbol) => symbol.file))].sort();
  const index = new Map<string, number>();
  universe.forEach((path, i) => index.set(path, i));

  const graph: CodeGraph = { universe, index, edges: [], adjacency: [] };
  const byFile = new Map<string, SymbolManifest['symbols'][number]>();
  for (const symbol of symbols.symbols) byFile.set(symbol.file, symbol);

  // 有向边聚合：同有序对取最大权，丢自环
  const accumulator = new Map<string, EdgeAccumulator>();
  const keyOf = (from: number, to: number): number => from * (universe.length + 1) + to;
  const n = universe.length;

  const addEdge = (fromPath: string, toPath: string, kind: StructureEdgeKind): void => {
    const from = index.get(fromPath);
    const to = index.get(toPath);
    if (from === undefined || to === undefined) return;
    if (from === to) return; // 丢自环
    const key = keyOf(from, to);
    const weight = WEIGHTS[kind];
    const existing = accumulator.get(key.toString());
    if (!existing) {
      accumulator.set(key.toString(), { key, from, to, kind, weight });
    } else {
      existing.weight = Math.max(existing.weight, weight);
      if (weight > WEIGHTS[existing.kind]) existing.kind = kind;
    }
  };

  for (const path of universe) {
    const symbol = byFile.get(path);
    if (!symbol) continue;

    // 规则 1 + 2：imports 的每条文本
    for (const text of symbol.imports) {
      const target = resolveImportTarget(text, path, graph);
      if (target) addEdge(path, target, 'import');
    }
    // 规则 3：exports 中含 ` from ` 的再导出
    for (const text of symbol.exports) {
      if (!text.includes(' from ')) continue;
      const target = resolveImportTarget(text, path, graph);
      if (target) addEdge(path, target, 'reexport');
    }
  }

  const edges: StructureEdge[] = [];
  const indices = [...accumulator.values()].sort((a, b) => a.key - b.key);
  for (const entry of indices) {
    edges.push({
      from: universe[entry.from],
      to: universe[entry.to],
      kind: entry.kind,
      weight: entry.weight,
    });
  }
  graph.edges = edges;

  // 无向邻接（对称投影）
  const adjacency: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (const entry of indices) {
    const w = entry.weight;
    const existing = adjacency[entry.from].get(entry.to) ?? 0;
    const merged = Math.max(existing, w);
    adjacency[entry.from].set(entry.to, merged);
    adjacency[entry.to].set(entry.from, merged);
  }
  graph.adjacency = adjacency;

  return graph;
}

/** manifest.files − U（原因统一 unsupported-or-unparsed） */
export function computeExcluded(manifest: FileManifest, universe: string[]): string[] {
  const universeSet = new Set(universe);
  return manifest.files
    .map((file) => file.path)
    .filter((path) => !universeSet.has(path))
    .sort();
}
