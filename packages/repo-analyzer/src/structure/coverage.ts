/**
 * 两级切分的第二级（分类）与全局槽位 —— §5.3 / §5.4 / §5.6
 *
 * - 分类级：在切片商图上再跑同一确定性层级 Louvain，按窗口选层，
 *   超上限则「合并到底」，低于下限则接受（区间是目标参数，不是硬约束）；
 * - 槽位：贪心集合覆盖（移植 research plan.js，阈值 3、上限 6）+ seams 兜底；
 * - 全局槽位不拥有文件（ownsFiles 恒为空），只承载跨切片视图。
 */

import type {
  SeamRecord,
  SlotSpec,
  StructureEdge,
  StructureSlice,
  MachineSection,
  SymbolManifest,
} from '@zread-pi/types';
import type { CodeGraph } from './graph.js';
import { louvainHierarchy, sliceQuotient } from './partition.js';

/** hub 候选的缝合线度阈值（research plan.js HUB_THRESHOLD） */
const HUB_THRESHOLD = 3;
/** hub 槽位上限（research plan.js MAX_HUB_ARTICLES） */
const MAX_HUB_ARTICLES = 6;
/** slot:seams 的关联路径条数上限 */
const MAX_SEAM_PATHS = 6;

/** 结构层需要的档位区间（由 BlueprintDetailSpec 映射而来） */
export interface StructureSpec {
  level: string;
  sections: { min: number; max: number };
  topics: { min: number; max: number };
}

export interface SectionSelection {
  sections: MachineSection[];
  chosenCount: number;
  /** 切片商图的层级社区计数序列 */
  hierarchyCounts: number[];
  /** 选层窗口 */
  window: { min: number; target: number };
}

/**
 * 缝合线（跨切片有向边）与每文件的缝合线度。
 */
export function computeSeams(
  graph: CodeGraph,
  slices: StructureSlice[],
  sliceIndexOf: Int32Array,
): { seams: SeamRecord[]; fileSeamDegree: Map<string, number>; sliceSeamDegree: number[] } {
  const seams: SeamRecord[] = [];
  const fileSeamDegree = new Map<string, number>();
  const sliceSeamDegree = new Array<number>(slices.length).fill(0);
  const touchedSlices = new Set<number>();

  for (const edge of graph.edges) {
    const fromIdx = graph.index.get(edge.from);
    const toIdx = graph.index.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) continue;
    const a = sliceIndexOf[fromIdx];
    const b = sliceIndexOf[toIdx];
    if (a < 0 || b < 0 || a === b) continue;
    seams.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      fromSlice: slices[a].id,
      toSlice: slices[b].id,
    });
    fileSeamDegree.set(edge.from, (fileSeamDegree.get(edge.from) ?? 0) + 1);
    fileSeamDegree.set(edge.to, (fileSeamDegree.get(edge.to) ?? 0) + 1);
    touchedSlices.add(a);
    touchedSlices.add(b);
  }
  for (const s of touchedSlices) sliceSeamDegree[s] += 1;

  return { seams, fileSeamDegree, sliceSeamDegree };
}

/** 区间并集长度（行台账的 declared 用） */
function unionLength(ranges: Array<{ start: number; end: number }> | undefined): number {
  if (!ranges || ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let currentEnd = -1;
  let currentStart = -1;
  for (const range of sorted) {
    if (currentStart < 0 || range.start > currentEnd + 1) {
      if (currentStart >= 0) total += currentEnd - currentStart + 1;
      currentStart = range.start;
      currentEnd = range.end;
    } else {
      currentEnd = Math.max(currentEnd, range.end);
    }
  }
  if (currentStart >= 0) total += currentEnd - currentStart + 1;
  return total;
}

/** 行级台账（信息性）：measured / total / declared / gap */
export function computeLineLedger(
  symbols: SymbolManifest,
  universe: string[],
): { measured: number; total: number; declared: number; gap: number } {
  const byFile = new Map<string, SymbolManifest['symbols'][number]>();
  for (const symbol of symbols.symbols) byFile.set(symbol.file, symbol);

  let measured = 0;
  let total = 0;
  let declared = 0;
  for (const path of universe) {
    const symbol = byFile.get(path);
    if (!symbol || symbol.lineCount === undefined) continue; // 未测（旧缓存 / vue 无 ranges）
    measured += 1;
    total += symbol.lineCount;
    declared += unionLength(symbol.ranges);
  }
  return { measured, total, declared, gap: total - declared };
}

/**
 * 分类级选层（§5.3）。
 *
 * 运行切片商图上的层级 Louvain，从计数序列里按窗口选层；选中数超过窗口上限时
 * 按「区间权重最大的一对」循环合并到底，低于下限则接受。
 */
export function buildSections(
  graph: CodeGraph,
  slices: StructureSlice[],
  sliceIndexOf: Int32Array,
  spec: StructureSpec,
): SectionSelection {
  const window = {
    min: Math.max(1, spec.sections.min - 2),
    target: 0,
  };
  window.target = Math.max(window.min, spec.sections.max - 2);

  if (slices.length === 0) {
    return { sections: [], chosenCount: 0, hierarchyCounts: [], window };
  }

  const quotient = sliceQuotient(graph, slices, sliceIndexOf);
  const { levels, levelChains } = louvainHierarchy(quotient, slices.length);
  const counts = levels.map((level) => level.count);

  // 选层：窗口内取最大；否则取离窗口最近者（平票取较大者）
  const windowMin = window.min;
  const windowMax = window.target;
  const inWindow = counts.filter((c) => c >= windowMin && c <= windowMax);
  let chosen = counts[0];
  if (inWindow.length > 0) {
    chosen = Math.max(...inWindow);
  } else {
    const distance = (c: number): number => (c > windowMax ? c - windowMax : windowMin - c);
    chosen = counts.reduce((best, c) => {
      if (c === best) return best;
      const dc = distance(c);
      const db = distance(best);
      if (dc < db) return c;
      if (dc === db && c > best) return c;
      return best;
    }, counts[0]);
  }

  // 取计数 === chosen 的那一层的划分（chosen 必是某个层级的计数）
  const levelIndex = counts.indexOf(chosen);
  const clusters: ClusterState = {
    label: new Int32Array(levelChains[levelIndex] ?? levelChains[levelChains.length - 1]),
    count: counts[levelIndex] ?? counts[counts.length - 1],
  };

  // 选中数 > 上限 → 合并到底（区间权重最大的一对，平票取代表切片序小）
  while (clusters.count > window.target && clusters.count > 1) {
    mergeStrongestPair(clusters, quotient);
  }

  // 结构分类：按社区内的最小切片序号升序
  const byFirstSlice = new Map<number, number[]>();
  for (let s = 0; s < slices.length; s++) {
    const cluster = clusters.label[s];
    if (!byFirstSlice.has(cluster)) byFirstSlice.set(cluster, []);
    byFirstSlice.get(cluster)!.push(s);
  }
  const ordered = [...byFirstSlice.entries()].sort((a, b) => a[1][0] - b[1][0]);

  const usedTitles = new Set<string>();
  const sections: MachineSection[] = [];
  for (const [, sliceIndices] of ordered) {
    const members = sliceIndices.map((s) => slices[s]);
    const minSlice = members.map((s) => s.id).reduce((a, b) => (a < b ? a : b));
    const fileCount = members.reduce((sum, s) => sum + s.files.length, 0);
    let title = members[0].label;
    if (usedTitles.has(title)) title = `${title}（${minSlice}）`;
    usedTitles.add(title);
    sections.push({
      id: `sec-${minSlice}`,
      title,
      description: `结构分类：切片 ${members.map((s) => s.id).join('、')}（${fileCount} 个文件）`,
      kind: 'structure',
      slices: members.map((s) => s.id),
    });
  }

  return { sections, chosenCount: sections.length, hierarchyCounts: counts, window };
}

interface ClusterState {
  /** 每个切片 → 簇标签 */
  label: Int32Array;
  /** 簇数量 */
  count: number;
}

/** 合并区间权重最大的一对簇（平票取代表切片序小者） */
function mergeStrongestPair(
  clusters: ClusterState,
  quotient: Array<Map<number, number>>,
): void {
  const clustersOf = new Map<number, number[]>();
  for (let s = 0; s < clusters.label.length; s++) {
    const c = clusters.label[s];
    if (!clustersOf.has(c)) clustersOf.set(c, []);
    clustersOf.get(c)!.push(s);
  }

  let best: { weight: number; representative: number; a: number; b: number } | null = null;
  const clusterIds = [...clustersOf.keys()];
  for (let i = 0; i < clusterIds.length; i++) {
    for (let j = i + 1; j < clusterIds.length; j++) {
      const a = clusterIds[i];
      const b = clusterIds[j];
      let weight = 0;
      for (const s of clustersOf.get(a)!) {
        for (const t of clustersOf.get(b)!) {
          weight += quotient[s].get(t) ?? 0;
        }
      }
      const representative = Math.min(
        ...clustersOf.get(a)!,
        ...clustersOf.get(b)!,
      );
      const candidate = { weight, representative, a, b };
      if (
        !best ||
        candidate.weight > best.weight ||
        (candidate.weight === best.weight && candidate.representative < best.representative)
      ) {
        best = candidate;
      }
    }
  }
  if (!best || best.weight < 0) return;

  // 把 b 并入 a（标签取较小者，保持代表切片序最小）
  const keep = Math.min(best.a, best.b);
  const drop = Math.max(best.a, best.b);
  let changed = false;
  for (let s = 0; s < clusters.label.length; s++) {
    if (clusters.label[s] === drop) {
      clusters.label[s] = keep;
      changed = true;
    }
  }
  if (changed) clusters.count -= 1;
}

/**
 * 全局槽位（§5.4）：贪心集合覆盖选 hub，未覆盖缝合线兜底成 seam 地图。
 *
 * 移植 research plan.js 的集合覆盖语义（阈值 3、上限 6、预截断 top-6），
 * 但 zread 的覆盖项是缝合线（跨切片边），不移植实体级 MENTION_BUDGET。
 */
export function buildSlots(
  seams: SeamRecord[],
  fileSeamDegree: Map<string, number>,
  language: string,
): SlotSpec[] {
  const slots: SlotSpec[] = [];
  const isEn = language === 'en';

  // 缝合线序号 → 该缝合线参与的文件（端点）
  const seamFiles: string[][] = seams.map((seam) => [seam.from, seam.to]);

  // hub 候选：seamDegree >= 3，按（度 desc、路径 asc）预截断 top-6
  const candidates = [...fileSeamDegree.entries()]
    .filter(([, degree]) => degree >= HUB_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_HUB_ARTICLES);

  // 每个候选覆盖的缝合线序号集合
  const covers = new Map<string, number[]>();
  for (const [path] of candidates) {
    const indices: number[] = [];
    seams.forEach((seam, index) => {
      if (seam.from === path || seam.to === path) indices.push(index);
    });
    covers.set(path, indices);
  }

  // 贪心集合覆盖：每轮取「新覆盖未解释 seam 数」最大者（平票路径字典序小），上限 6
  const covered = new Set<number>();
  const picked: string[] = [];
  while (picked.length < MAX_HUB_ARTICLES) {
    let best: { path: string; gain: number } | null = null;
    for (const [path] of candidates) {
      if (picked.includes(path)) continue;
      const gain = (covers.get(path) ?? []).filter((index) => !covered.has(index)).length;
      if (gain <= 0) continue;
      if (!best || gain > best.gain || (gain === best.gain && path < best.path)) {
        best = { path, gain };
      }
    }
    if (!best) break;
    picked.push(best.path);
    for (const index of covers.get(best.path) ?? []) covered.add(index);
  }

  // slot:overview —— 概览分类，关联所选 hub 路径（≤6）
  slots.push({
    id: 'slot:overview',
    kind: 'overview',
    sectionId: 'overview',
    title: isEn ? 'Overview' : '概览',
    associatedFiles: picked.slice(0, MAX_HUB_ARTICLES),
  });

  // hub 槽位 —— 核心架构分类，每篇只关联 hub 文件本身
  for (const path of picked) {
    slots.push({
      id: `slot:hub:${path}`,
      kind: 'hub',
      sectionId: 'core',
      title: isEn ? `Hub: ${path}` : `枢纽：${path}`,
      associatedFiles: [path],
    });
  }

  // 未覆盖缝合线 或 无 hub 槽位 → slot:seams 兜底（保证核心架构 ≥1 个槽位页）
  const uncovered = seams
    .map((_, index) => index)
    .filter((index) => !covered.has(index));
  if (uncovered.length > 0 || picked.length === 0) {
    const endpoints = [...new Set(uncovered.flatMap((index) => seamFiles[index]))].sort();
    slots.push({
      id: 'slot:seams',
      kind: 'seams',
      sectionId: 'core',
      title: isEn ? 'Cross-slice dependency map' : '跨切片依赖地图（缝合线总览）',
      associatedFiles: endpoints.slice(0, MAX_SEAM_PATHS),
    });
  }

  return slots;
}

/** 按（度 desc、路径 asc）排序的 hub 候选，供审计件展示 */
export function hubCandidates(
  fileSeamDegree: Map<string, number>,
): Array<{ path: string; degree: number }> {
  return [...fileSeamDegree.entries()]
    .filter(([, degree]) => degree >= HUB_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, degree]) => ({ path, degree }));
}

/** 结构边的只读视图（审计件用） */
export function edgeView(edges: StructureEdge[]): StructureEdge[] {
  return edges;
}
