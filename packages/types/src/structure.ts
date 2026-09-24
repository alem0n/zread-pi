/**
 * Structure Types —— 结构优先蓝图的代码侧结构产物
 *
 * 结构阶段（buildStructureCache）把符号清单落成「文件级代码实体图」（CEG），
 * 用确定性层级 Louvain 产出两级互斥划分（切片 → 分类），并给出全局槽位。
 * LLM 只负责命名（title / description / scope / summary / group / level），
 * 结构（sections / pages / slug / 文件归属）全部由代码构造。
 *
 * 算法定案见 plan.md §5；数据契约见 §6。
 */

/** 图边类型：import（权 2）/ reexport（权 3） */
export type StructureEdgeKind = 'import' | 'reexport';

/** 代码实体图（CEG，文件级）的一条有向边 */
export interface StructureEdge {
  from: string;
  to: string;
  kind: StructureEdgeKind;
  /** 权重：import = 2，reexport = 3；同一有序对取最大权 */
  weight: number;
}

/** 缝合线（跨切片的有向边记录；供槽位集合覆盖与页面 refs 取数） */
export interface SeamRecord {
  from: string;
  to: string;
  kind: StructureEdgeKind;
  fromSlice: string;
  toSlice: string;
}

/** 切片（细级 = 页面级） */
export interface StructureSlice {
  /** 切片 id：S1..Sn（按根社区排序编号） */
  id: string;
  /** 切片标签：代表文件去扩展名的 basename */
  label: string;
  /** 切片包含的文件（全集 U 的一个划分成员，字典序） */
  files: string[];
  /** 切片代表文件（fan-in 最大，平票取路径字典序小） */
  representative: string;
  /** 关联的缝合线记录数（hub 候选排序用） */
  seamDegree: number;
}

/** 机器分类种类：基础分类（概览 / 核心架构）或结构分类 */
export type MachineSectionKind = 'base' | 'structure';

/** 机器分类（粗级） */
export interface MachineSection {
  /** 分类 id：基础分类为 overview / core；结构分类为 sec-<社区内最小切片 id> */
  id: string;
  /** 机器默认标题（命名 Agent 失败时的兜底；命名阶段可覆盖） */
  title: string;
  /** 机器默认说明（命名阶段可覆盖） */
  description: string;
  kind: MachineSectionKind;
  /** 成员切片 id（基础分类恒为空——它们只持全局槽位） */
  slices: string[];
}

/** 全局槽位种类 */
export type SlotKind = 'overview' | 'hub' | 'seams';

/**
 * 全局槽位（不拥有文件；ownsFiles 恒为空）。
 *
 * - overview：隶属「概览」，associatedFiles = 集合覆盖选出的 hub 路径（≤6）；
 * - hub：`slot:hub:<path>`，associatedFiles = 该 hub 文件本身；
 * - seams：兜底，associatedFiles = 未覆盖缝合线端点（去重排序取 6 条）。
 */
export interface SlotSpec {
  /** 槽位 id：slot:overview / slot:hub:<path> / slot:seams */
  id: string;
  kind: SlotKind;
  /** 所属分类 id：overview 槽位 → 概览；hub / seams → 核心架构 */
  sectionId: string;
  /** 槽位标题（系统固定，不经命名阶段） */
  title: string;
  /** 关联路径（hub 路径 / seam 端点；供全景与依赖地图 grounding） */
  associatedFiles: string[];
}

/** 结构阶段的参数快照（审计件记录，便于 diff 复核） */
export interface StructureParams {
  /** 蓝图档位 */
  detail: string;
  /** 全集文件数 |U| */
  universeCount: number;
  /** 目标页面数 = sections.max × round((topics.min + topics.max) / 2) */
  targetPages: number;
  /** 切片最小文件数 = max(1, round(N / targetPages)) */
  minSliceSize: number;
  /** 分类选层窗口（Tmin / Tmax） */
  sectionWindow: { min: number; target: number };
  /** 最终选中的结构分类数 */
  chosenSectionCount: number;
  /** 切片商图的层级社区计数序列（选层用） */
  hierarchyCounts: number[];
}

/** 行级台账（信息性）：measured / total / declared / gap */
export interface LineLedger {
  measured: number;
  total: number;
  declared: number;
  gap: number;
}

/** 结构缓存（§5 全部中间产物 + manifestHash） */
export interface StructureCache {
  manifestHash: string;
  /** 全集 U（可解析源文件，字典序） */
  universe: string[];
  /** 未解析文件（manifest.files − U），原因统一 unsupported-or-unparsed */
  excluded: string[];
  edges: StructureEdge[];
  slices: StructureSlice[];
  sections: MachineSection[];
  slots: SlotSpec[];
  seams: SeamRecord[];
  /** 切片划分在文件图（无向投影）上的模块度 */
  modularity: number;
  /** 行级台账（由 symbols 的 lineCount / ranges 汇总） */
  lines: LineLedger;
  params: StructureParams;
}

/** 运行期页面 id（仅用于本轮工具绑定；跨次运行身份是 slug） */
export type MachinePageId = `slot:${string}` | `slice:${string}`;

/** 页面引用（跨页边；写作期的「只引用不讲解」清单） */
export interface PageRef {
  /** 被引用的文件路径 */
  path: string;
  /** 引用原因（`import 来自 <文件>` / `reexport 来自 <文件>`） */
  reason: string;
  /** 该文件归属页面的 slug */
  ownerSlug: string;
}

/** 符号行区间（tree-sitter 节点 startPosition / endPosition，加法式新增字段） */
export interface SymbolRange {
  /** 符号名 */
  name: string;
  /** 起始行（1-based，clip 到 [1, lineCount]） */
  start: number;
  /** 结束行（1-based，clip 到 [1, lineCount]） */
  end: number;
}
