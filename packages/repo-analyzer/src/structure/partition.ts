/**
 * 确定性层级 Louvain 与切片构建 —— §5.2
 *
 * 移植 research `wiki-gen/lib/partition.js`（9/23 版实读对齐）：
 * - 固定节点序（U 字典序）、每轮 `comm[i] = i` 起步；
 * - 平局取社区号最小（候选按社区号升序遍历，仅 `s > bestScore + EPS` 才替换）；
 * - EPS = 1e-12；while guard = 32；
 * - 商图聚合与 mapping 链同原实现；数字复合键（min*2^27+max）与循环 push 两处规模修复一并移植；
 * - research 默认 `maxLevels = 8`；zread 不设上限，循环到收敛（count === n 或 count === 1）。
 *
 * 有意偏差（plan §5.2 research 对照）：
 * - `reanchorModules` / `reconcileRanges` / `pinTrees` 是实体级的，文件级图不适用，不移植；
 * - barrel 重锚定（②）是 research 090 规则在文件级的显式后处理；
 * - 孤儿（④）取同父目录吸附（docs 089a 的文件级对应），research 无此规则；
 * - 标签（⑤）取 fan-in 代表文件，research 用包名 + 导出成员启发式。
 */

import type { SymbolManifest, StructureSlice } from '@zread-pi/types';
import type { CodeGraph } from './graph.js';

const EPS = 1e-12;
const LOCAL_MOVE_GUARD = 32;
const FOLD_GUARD_EXTRA = 4;

/** 并查集（路径压缩 + 按秩合并） */
class DSU {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    let current = x;
    while (this.parent[current] !== current) {
      this.parent[current] = this.parent[this.parent[current]];
      current = this.parent[current];
    }
    return current;
  }

  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
    return true;
  }
}

/** ΔQ：把度 kU 的孤立节点 u 并入社区 c 的收益 */
function scoreInto(wUC: number, kU: number, sigmaTotC: number, m: number): number {
  return (wUC - (kU * sigmaTotC) / (2 * m)) / m;
}

/** 一轮 Louvain 局部移动；adj 必须对称 */
function localMove(adj: Array<Map<number, number>>, n: number): { comm: Int32Array; moved: number } {
  const comm = new Int32Array(n);
  for (let i = 0; i < n; i++) comm[i] = i;
  const k = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (const [, w] of adj[i]) {
      k[i] += w;
      m += w;
    }
  }
  m /= 2; // 总边权
  const sigmaTot = new Float64Array(n);
  for (let i = 0; i < n; i++) sigmaTot[comm[i]] += k[i];

  if (m === 0) return { comm, moved: 0 };

  let moved = 0;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < LOCAL_MOVE_GUARD) {
    improved = false;
    for (let u = 0; u < n; u++) {
      const cur = comm[u];
      const neighW = new Map<number, number>();
      for (const [v, w] of adj[u]) {
        if (v === u) continue;
        const c = comm[v];
        neighW.set(c, (neighW.get(c) ?? 0) + w);
      }
      sigmaTot[cur] -= k[u];
      let best = cur;
      let bestScore = scoreInto(neighW.get(cur) ?? 0, k[u], sigmaTot[cur], m);
      const candidates = [...neighW.keys()].sort((a, b) => a - b);
      for (const c of candidates) {
        if (c === cur) continue;
        const s = scoreInto(neighW.get(c) ?? 0, k[u], sigmaTot[c], m);
        if (s > bestScore + EPS) {
          bestScore = s;
          best = c;
        }
      }
      comm[u] = best;
      sigmaTot[best] += k[u];
      if (best !== cur) {
        moved++;
        improved = true;
      }
    }
  }
  return { comm, moved };
}

/** 把社区数组重标号为紧凑的 0..k-1 */
function compact(comm: Int32Array): { comm: Int32Array; count: number } {
  const map = new Map<number, number>();
  const out = new Int32Array(comm.length);
  for (let i = 0; i < comm.length; i++) {
    if (!map.has(comm[i])) map.set(comm[i], map.size);
    out[i] = map.get(comm[i])!;
  }
  return { comm: out, count: map.size };
}

export interface HierarchyResult {
  /** 每层的社区计数（层层合并；末层恒为 1，退化图除外） */
  levels: Array<{ count: number; moved: number }>;
  /** 每个原始节点的顶层社区 */
  chain: Int32Array;
  /** 每层的社区划分：levelChains[t][i] = 原始节点 i 在第 t 层的社区（选层用） */
  levelChains: Int32Array[];
}

/**
 * 层级 Louvain。`maxLevels` 缺省 = 不设上限，循环到收敛
 * （count === n 即每节点自成社区时停；count === 1 即完全合并时停）。
 */
export function louvainHierarchy(
  adj0: Array<Map<number, number>>,
  n0: number,
  options: { maxLevels?: number } = {},
): HierarchyResult {
  const maxLevels = options.maxLevels ?? Number.POSITIVE_INFINITY;
  let adj = adj0;
  let n = n0;
  const levels: Array<{ count: number; moved: number }> = [];
  const levelChains: Int32Array[] = [];
  let mapping = new Int32Array(n0).map((_, i) => i);

  for (let level = 0; level < maxLevels; level++) {
    const { comm, moved } = localMove(adj, n);
    const c = compact(comm);
    levels.push({ count: c.count, moved });
    // 捕获第 t 层的划分：原始节点在该层的社区
    const levelChain = new Int32Array(n0);
    for (let i = 0; i < n0; i++) levelChain[i] = c.comm[mapping[i]];
    levelChains.push(levelChain);
    if (c.count === n) break; // 收敛：每节点自成社区
    if (c.count === 1) break; // 完全合并

    const newMapping = new Int32Array(n0);
    for (let i = 0; i < n0; i++) newMapping[i] = c.comm[mapping[i]];
    mapping = newMapping;

    // 聚合为商图
    const agg: Array<Map<number, number>> = Array.from({ length: c.count }, () => new Map());
    for (let i = 0; i < n; i++) {
      const ci = c.comm[i];
      for (const [j, w] of adj[i]) {
        const cj = c.comm[j];
        agg[ci].set(cj, (agg[ci].get(cj) ?? 0) + w);
      }
    }
    adj = agg;
    n = c.count;
  }

  const chain = new Int32Array(n0);
  for (let i = 0; i < n0; i++) chain[i] = mapping[i];
  return { levels, chain, levelChains };
}

/** 切片划分在无向邻接上的模块度（research modularity 口径） */
export function modularityOf(
  adj: Array<Map<number, number>>,
  n: number,
  comm: Int32Array,
): number {
  const k = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    for (const [, w] of adj[i]) {
      k[i] += w;
      m += w;
    }
  }
  m /= 2;
  if (m === 0) return 0;
  let q = 0;
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]) {
      if (comm[i] === comm[j]) q += w - (k[i] * k[j]) / (2 * m);
    }
  }
  return q / (2 * m);
}

export interface BuildSlicesOptions {
  minSliceSize: number;
  idPrefix?: string;
}

export interface BuildSlicesResult {
  slices: StructureSlice[];
  /** 每个文件 → 切片在 slices 中的索引 */
  sliceIndexOf: Int32Array;
  modularity: number;
  /** 层级社区计数序列（审计用） */
  hierarchyCounts: number[];
}

/**
 * 由层级划分构建切片：分组 → 折叠小社区 → barrel 重锚定 → 孤儿吸附 → 标签编号。
 *
 * 顺序（plan §5.2，② / ④ 引用「切片」故在实际编号前以社区标签运行）：
 * ① louvainHierarchy → ③ 折叠（零度社区豁免）→ ② barrel → ④ 孤儿 → ⑤ 标签编号。
 */
export function buildSlices(
  graph: CodeGraph,
  symbols: SymbolManifest,
  options: BuildSlicesOptions,
): BuildSlicesResult {
  const { universe, index, adjacency, edges } = graph;
  const n = universe.length;
  const minSize = Math.max(1, options.minSliceSize);
  const idPrefix = options.idPrefix ?? 'S';

  // —— ① 层级 Louvain ——
  const { chain, levels } = louvainHierarchy(adjacency, n);
  const hierarchyCounts = levels.map((level) => level.count);

  // —— ③ 折叠小社区（DSU）——
  const commIds = [...new Set(chain)].sort((a, b) => a - b);
  const commIndex = new Map<number, number>(commIds.map((c, i) => [c, i]));
  const dsu = new DSU(commIds.length);

  // 数字复合键（min*2^27+max）：仅 get 不迭代，序无关（research 附录 E 的规模修复）
  const weightKey = (a: number, b: number): number =>
    a < b ? a * 134217728 + b : b * 134217728 + a;
  const commWeight = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adjacency[i]) {
      const a = commIndex.get(chain[i]);
      const b = commIndex.get(chain[j]);
      if (a === undefined || b === undefined || a === b) continue;
      const key = weightKey(a, b);
      commWeight.set(key, (commWeight.get(key) ?? 0) + w);
    }
  }
  const groupSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = commIndex.get(chain[i])!;
    groupSize.set(c, (groupSize.get(c) ?? 0) + 1);
  }

  let changed = true;
  let guard = 0;
  while (changed && guard++ < commIds.length + FOLD_GUARD_EXTRA) {
    changed = false;
    for (let ci = 0; ci < commIds.length; ci++) {
      const root = dsu.find(ci);
      let size = 0;
      for (let k = 0; k < commIds.length; k++) if (dsu.find(k) === root) size += groupSize.get(k) ?? 0;
      if (size >= minSize) continue;
      // 最强邻居社区（平票取社区索引小）
      let best = -1;
      let bestW = 0;
      for (let k = 0; k < commIds.length; k++) {
        if (dsu.find(k) === root) continue;
        const w = commWeight.get(weightKey(root, k)) ?? 0;
        if (w > bestW) {
          bestW = w;
          best = k;
        }
      }
      // bestW === 0：无真实邻居（零度社区）——孤儿步骤 ④ 处理，豁免折叠
      if (best >= 0 && bestW > 0) {
        dsu.union(root, best);
        changed = true;
      }
    }
  }

  // 折叠后的社区标签（用 DSU 根的 commIndex）
  const label = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    label[i] = dsu.find(commIndex.get(chain[i])!);
  }

  const byFile = new Map<string, SymbolManifest['symbols'][number]>();
  for (const symbol of symbols.symbols) byFile.set(symbol.file, symbol);

  // —— ② barrel 重锚定 ——
  // functions 为空、exports 全部是再导出（含 ` from `）的文件，
  // 划入其 reexport 目标所在社区的众数（平票取社区索引小；无已解析目标保持原社区）。
  for (let i = 0; i < n; i++) {
    const path = universe[i];
    const symbol = byFile.get(path);
    if (!symbol) continue;
    if (symbol.functions.length !== 0) continue;
    if (symbol.exports.length === 0) continue;
    if (!symbol.exports.every((entry) => entry.includes(' from '))) continue;

    const counts = new Map<number, number>();
    for (const entry of symbol.exports) {
      const target = resolveTargetFile(entry, path, graph);
      if (!target) continue;
      const targetIndex = index.get(target);
      if (targetIndex === undefined) continue;
      const targetLabel = label[targetIndex];
      counts.set(targetLabel, (counts.get(targetLabel) ?? 0) + 1);
    }
    if (counts.size === 0) continue; // 无已解析目标 → 保持

    let bestLabel = -1;
    let bestCount = -1;
    for (const [candidate, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      if (count > bestCount) {
        bestCount = count;
        bestLabel = candidate;
      }
    }
    if (bestLabel >= 0) label[i] = bestLabel;
  }

  // —— ④ 孤儿吸附 ——
  // 零度文件（无任何边）并入「同父目录文件所在社区」（多候选取社区索引小）；
  // 无同目录文件 → 保持独立（单文件社区，豁免折叠）。
  const degree = new Int32Array(n);
  for (let i = 0; i < n; i++) degree[i] = adjacency[i].size;
  const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');

  const dirsToIndices = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const dir = dirOf(universe[i]);
    if (!dirsToIndices.has(dir)) dirsToIndices.set(dir, []);
    dirsToIndices.get(dir)!.push(i);
  }

  for (let i = 0; i < n; i++) {
    if (degree[i] > 0) continue;
    const dir = dirOf(universe[i]);
    const siblings = (dirsToIndices.get(dir) ?? []).filter(
      (j) => j !== i && degree[j] > 0,
    );
    if (siblings.length === 0) continue; // 保持独立单文件切片
    let bestLabel = -1;
    for (const j of siblings) {
      const candidate = label[j];
      if (bestLabel < 0 || candidate < bestLabel) bestLabel = candidate;
    }
    if (bestLabel >= 0) label[i] = bestLabel;
  }

  // —— ⑤ 物化切片：按社区标签分组，标签升序编号 S1..Sn ——
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const key = label[i];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }

  // 加权 fan-in（每条入边的权之和），用于选切片代表
  const inWeight = new Float64Array(n);
  for (const edge of edges) {
    const to = index.get(edge.to);
    if (to !== undefined) inWeight[to] += edge.weight;
  }

  const sortedLabels = [...groups.keys()].sort((a, b) => a - b);
  const slices: StructureSlice[] = [];
  // sliceIndexOf：文件 → 切片序号（0-based）
  const sliceIndexOf = new Int32Array(n).fill(-1);
  for (let s = 0; s < sortedLabels.length; s++) {
    const members = groups.get(sortedLabels[s])!;
    let representative = -1;
    let bestFanIn = -1;
    for (const i of members) {
      const fanIn = inWeight[i];
      if (fanIn > bestFanIn || (fanIn === bestFanIn && universe[i] < universe[representative])) {
        bestFanIn = fanIn;
        representative = i;
      }
    }
    const files = members.map((i) => universe[i]).sort();
    members.forEach((i) => (sliceIndexOf[i] = s));
    const representativePath = representative >= 0 ? universe[representative] : files[0];
    slices.push({
      id: `${idPrefix}${s + 1}`,
      label: stemOf(representativePath),
      files,
      representative: representativePath,
      seamDegree: 0, // 由 coverage 阶段回填
    });
  }

  // 模块度（切片划分在文件图上）
  const sliceComm = new Int32Array(n);
  for (let i = 0; i < n; i++) sliceComm[i] = sliceIndexOf[i];
  const modularity = modularityOf(adjacency, n, sliceComm);

  return { slices, sliceIndexOf, modularity, hierarchyCounts };
}

/** 去扩展名的 basename（切片标签与唯一匹配共用） */
function stemOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 解析 import / reexport 文本到 U 内的目标文件（与 graph.ts 同口径，此处只用于 barrel） */
function resolveTargetFile(text: string, from: string, graph: CodeGraph): string | null {
  const literal = firstQuotedLiteral(text);
  if (literal === null) return null;
  const candidates: string[] = [];
  if (literal.startsWith('.')) {
    const joined = normalizePosix(posixJoin(posixDirname(from), literal));
    candidates.push(joined);
    const withoutExt = stripExtension(joined);
    for (const ext of EXTENSION_CANDIDATES) candidates.push(`${withoutExt}${ext}`);
  } else {
    candidates.push(basenameOf(literal));
  }
  for (const candidate of candidates) {
    if (graph.index.has(candidate)) return candidate;
  }
  return null;
}

/** 去掉最后一个扩展名（`.d.ts` 整体去掉） */
function stripExtension(path: string): string {
  if (path.endsWith('.d.ts')) return path.slice(0, -5);
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot > slash) return path.slice(0, dot);
  return path;
}

const EXTENSION_CANDIDATES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.d.ts',
  '.py', '.go', '.rs', '.java', '.php', '.rb', '.swift', '.kt',
  '.cs', '.c', '.h', '.cpp', '.hpp',
];

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

function firstQuotedLiteral(text: string): string | null {
  const quoted = /'([^']*)'|"([^"]*)"/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  const angle = /<([^>]+)>/.exec(text);
  if (angle) return angle[1] ?? '';
  return null;
}

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * 切片商图（无向邻接，节点 = 切片序号）：供分类级 Louvain 与合并取数。
 */
export function sliceQuotient(
  graph: CodeGraph,
  slices: StructureSlice[],
  sliceIndexOf: Int32Array,
): Array<Map<number, number>> {
  const count = slices.length;
  const adj: Array<Map<number, number>> = Array.from({ length: count }, () => new Map());
  const { adjacency } = graph;
  for (let i = 0; i < adjacency.length; i++) {
    const a = sliceIndexOf[i];
    if (a < 0) continue;
    for (const [j, w] of adjacency[i]) {
      const b = sliceIndexOf[j];
      if (b < 0 || a === b) continue;
      adj[a].set(b, (adj[a].get(b) ?? 0) + w);
      adj[b].set(a, (adj[b].get(a) ?? 0) + w);
    }
  }
  return adj;
}
