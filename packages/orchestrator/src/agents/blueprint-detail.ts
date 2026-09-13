/**
 * Blueprint Detail（蓝图细节档位）的纯函数层
 *
 * `blueprint.detail` 把「项目理解深度」交给用户，档位翻译成四层数量控制机制：
 *   1. 提示词数量目标（classify / topics 提示词参数化）；
 *   2. 常驻数量反馈（submit_sections / submit_section_topics 每次返回都带）；
 *   3. AI 归并（越界不落盘、返回策略文本请求重提；两次不收敛后开缩编 subagent）；
 *   4. 代码确定性兜底（基础分类保序取前 N / 每 distinct group 保 1 篇再按序填充）。
 *
 * 本模块只放**纯函数与常量**：数量区间、判定、反馈 / 策略 / 缩编提示词、
 * 代码兜底裁剪、minimal 的「全景导览」附加要求。副作用（落盘 / 调 LLM）在
 * `output-tools.ts` 与 `blueprint-stages.ts`。
 *
 * 档位定义（见 @zread-pi/types 的 BlueprintDetailLevel）：
 * | 档位    | 分类数 | 每分类文章数 | 标题精修 | 附加要求 |
 * |---------|--------|--------------|----------|----------|
 * | minimal | 固定 1 | 固定 1       | 跳过     | 全景导览（必须 Mermaid 架构图） |
 * | low     | 3~5    | 1~3          | 跳过     | — |
 * | medium  | 4~6    | 3~5          | 保留     | — |
 * | high    | 4~8    | 3~10         | 保留     | —（默认，与旧行为一致） |
 * | max     | 4~8    | 5~12         | 保留     | 强调全面详尽、鼓励更深关联文件探索 |
 */

import type { BlueprintDetailLevel, WikiSection, WikiTopic } from '@zread-pi/types';
import {
  mergeBlueprintSections,
  normalizeBlueprintDetail,
  normalizeBlueprintSections,
} from '@zread-pi/utils';

/** 分类 / 每分类文章的数量区间 */
export interface DetailRange {
  min: number;
  max: number;
}

/** 单个档位的完整规格 */
export interface BlueprintDetailSpec {
  level: BlueprintDetailLevel;
  /** 分类数量区间 */
  sections: DetailRange;
  /** 每分类文章（主题）数量区间 */
  topics: DetailRange;
  /** 是否跑标题精修阶段（low / minimal 跳过） */
  refineTitles: boolean;
  /** minimal：页面提示词附加「全景导览」（必须 Mermaid 架构图梳理模块关系与数据流） */
  panorama: boolean;
  /** max：强调全面详尽、鼓励更深关联文件探索 */
  exhaustive: boolean;
}

/** 档位规格表（顺序即配置界面展示顺序，由此处与 utils 的 BLUEPRINT_DETAIL_LEVELS 保持一致） */
export const BLUEPRINT_DETAIL_SPECS: Record<BlueprintDetailLevel, BlueprintDetailSpec> = {
  minimal: {
    level: 'minimal',
    sections: { min: 1, max: 1 },
    topics: { min: 1, max: 1 },
    refineTitles: false,
    panorama: true,
    exhaustive: false,
  },
  low: {
    level: 'low',
    sections: { min: 3, max: 5 },
    topics: { min: 1, max: 3 },
    refineTitles: false,
    panorama: false,
    exhaustive: false,
  },
  medium: {
    level: 'medium',
    sections: { min: 4, max: 6 },
    topics: { min: 3, max: 5 },
    refineTitles: true,
    panorama: false,
    exhaustive: false,
  },
  high: {
    level: 'high',
    sections: { min: 4, max: 8 },
    topics: { min: 3, max: 10 },
    refineTitles: true,
    panorama: false,
    exhaustive: false,
  },
  max: {
    level: 'max',
    sections: { min: 4, max: 8 },
    topics: { min: 5, max: 12 },
    refineTitles: true,
    panorama: false,
    exhaustive: true,
  },
};

/** 归一化档位并取规格（非法 / 缺省值回退 high） */
export function getDetailSpec(value: unknown): BlueprintDetailSpec {
  return BLUEPRINT_DETAIL_SPECS[normalizeBlueprintDetail(value)];
}

/** 越界后允许的 AI 反馈轮数（第 2 次仍不收敛 → 第 3 轮缩编 subagent / 代码兜底） */
export const MAX_QUANTITY_FEEDBACK_ROUNDS = 2;

/** 缩编 subagent 的独立小 token 预算（只看清单本身，一次读入 + 一次输出足够） */
export const DEFAULT_CONDENSE_TOKEN_BUDGET = 60_000;

/** 达到轮次上限、由代码收尾时的注记（模型可见的 tool_result 里也会带上） */
export const QUANTITY_FALLBACK_NOTE = '（已达到调整轮次上限，代码侧收尾）';

/**
 * 输出工具的数量控制状态（工具写入，阶段驱动器读取）。
 *
 * - `outOfRange` 记录越界未落盘的次数：达到 `MAX_QUANTITY_FEEDBACK_ROUNDS`
 *   时 `exhausted = true`，阶段驱动器转入缩编 subagent / 代码兜底；
 * - `lastPayload` 是最近一次归一化后的提交内容，供缩编与代码兜底复用。
 */
export interface QuantityToolState<TPayload = unknown> {
  /** 模型是否调用过工具（任意结果） */
  called: boolean;
  /** 是否成功落盘过 */
  persisted: boolean;
  /** 越界未落盘的次数 */
  outOfRange: number;
  /** 两次未收敛（outOfRange >= MAX）——应移交缩编 subagent / 代码兜底 */
  exhausted: boolean;
  /** 最近一次归一化后的提交内容 */
  lastPayload?: TPayload;
  /** 最近一次提交的（归一化）数量 */
  lastCount?: number;
  /** 最近一次越界的判定 */
  lastVerdict?: QuantityVerdict;
  /** 最近一次缩编 / 兜底的结果注记（诊断与测试用） */
  lastNote?: string;
}

// ==================== 数量判定与反馈 ====================

export type QuantityVerdict = 'ok' | 'under' | 'over';

export interface JudgeQuantityOptions {
  /** sync 模式只校验上限（既有分类 / 既有页面必留，不强制补齐下限） */
  enforceMin?: boolean;
}

/** 判定数量是否越界（enforceMin = false 时忽略下限） */
export function judgeQuantity(
  count: number,
  range: DetailRange,
  options: JudgeQuantityOptions = {},
): QuantityVerdict {
  if (count > range.max) return 'over';
  if (options.enforceMin !== false && count < range.min) return 'under';
  return 'ok';
}

export interface QuantityFeedbackOptions {
  kind: 'sections' | 'topics';
  count: number;
  spec: BlueprintDetailSpec;
  /** sync 模式：反馈里注明只校验上限 */
  upperBoundOnly?: boolean;
}

/**
 * 常驻数量反馈：`submit_sections` / `submit_section_topics` 每次成功返回都带，
 * 区间内也发（零额外成本，模型随时自我校准）。
 */
export function formatQuantityFeedback(options: QuantityFeedbackOptions): string {
  const { kind, count, spec } = options;
  const unit = kind === 'sections' ? '分类' : '文章';
  const range = kind === 'sections' ? spec.sections : spec.topics;
  const requirement =
    spec.level === 'minimal' ? '要求 1（固定）' : `要求 ${range.min}~${range.max}`;
  const suffix = options.upperBoundOnly ? '；sync 模式只校验上限，既有内容必留' : '';
  return `${unit}数量反馈：当前 ${count} / ${requirement}（当前档位：${spec.level}${suffix}）`;
}

// ==================== AI 归并策略文本 ====================

const BASE_SECTION_NOTE = '概览 / 快速开始 / 核心架构三个基础分类永不动、永不归并；';

function sectionsOverStrategy(spec: BlueprintDetailSpec, sync: boolean): string {
  if (sync) {
    return [
      `分类数超出上限（sync，上限 ${spec.sections.max}）：本次提交未落盘。既有分类必须全部保留，新增只能并入既有分类：`,
      '- 若变更文件属于某个既有分类的领域，请把它挂进该分类的内容规划，而不是新增顶层分类；',
      '- 只有确实无法归入任何既有分类时才新增，且合并后总数不得超上限；',
      '- 重新调用 submit_sections 提交完整清单（既有分类标题逐字保留）。',
    ].join('\n');
  }
  return [
    `分类数超出上限（要求 ${spec.sections.min}~${spec.sections.max}）：本次提交未落盘。请先归并，再重新调用 submit_sections：`,
    `- ${BASE_SECTION_NOTE}`,
    '- 只把同一领域、同一受众的分类合并为一个（合并后 description 取两者要点融合）；',
    '- 高密度的核心机制分类（调度器、状态机、协议解析引擎等）永不归并；',
    '- 合并后重新提交完整清单（不是增量），不要保留被合并掉的旧分类。',
  ].join('\n');
}

function sectionsUnderStrategy(spec: BlueprintDetailSpec): string {
  return [
    `分类数不足（要求 ${spec.sections.min}~${spec.sections.max}）：本次提交未落盘。请拆分 / 补充，再重新调用 submit_sections：`,
    '- 把覆盖过宽的分类拆成 2~3 个互不重叠的子领域（不要照搬文件夹名）；',
    '- 补充尚未覆盖的架构暗线（调度与并发、事件总线、上下文 / 依赖注入、错误与监控链路等）；',
    '- 新增分类仍需给出一句 description，说明覆盖范围与目标读者；',
    '- 合并后重新提交完整清单（不是增量）。',
  ].join('\n');
}

/** 分类越界的策略文本（AI 归并主路径；sync 只可能 over） */
export function buildSectionQuantityStrategy(
  verdict: 'under' | 'over',
  spec: BlueprintDetailSpec,
  options: { sync?: boolean } = {},
): string {
  return verdict === 'over'
    ? sectionsOverStrategy(spec, options.sync === true)
    : sectionsUnderStrategy(spec);
}

function topicsOverStrategy(spec: BlueprintDetailSpec, sync: boolean): string {
  if (sync) {
    return [
      `本分类主题数超出上限（sync，上限 ${spec.topics.max}）：本次提交未落盘。旧页面必须原样带回，只能归并新增主题：`,
      '- 既有页面的 slug / title 逐字保留，不能通过删除页面收敛数量；',
      '- 新增主题优先并入既有页面的 associatedFiles，而不是新增页面；',
      '- 重新调用 submit_section_topics 提交完整主题清单（含全部旧页面）。',
    ].join('\n');
  }
  return [
    `本分类主题数超出上限（要求 ${spec.topics.min}~${spec.topics.max}）：本次提交未落盘。请先归并，再重新调用 submit_section_topics：`,
    '- 同一领域的不同平台 / 协议实现严禁归并（应拆篇并用 group 聚合）；',
    '- 只把同一 group 内、面向同一读者、粒度相近的主题合并为一篇；',
    '- 高密度核心机制 / 关键算法（调度器、状态机、协议解析引擎）永不归并；',
    '- 合并后 associatedFiles 取并集、group 取更贴切的一个；',
    '- 重新提交该分类的完整主题清单（不是增量）。',
  ].join('\n');
}

function topicsUnderStrategy(spec: BlueprintDetailSpec): string {
  return [
    `本分类主题数不足（要求 ${spec.topics.min}~${spec.topics.max}）：本次提交未落盘。请拆分 / 补充，再重新调用 submit_section_topics：`,
    '- 把覆盖多个功能点的宽泛主题拆成独立成篇的主题（每篇聚焦一个核心机制）；',
    '- 对照 Repo Map 与关联路径，补充尚未覆盖的子系统 / 核心文件；',
    '- 细碎的 Utils / 常量允许聚合，但高密度核心机制必须独立成篇；',
    '- 重新提交该分类的完整主题清单（不是增量）。',
  ].join('\n');
}

/** 主题越界的策略文本（AI 归并主路径；sync 只可能 over） */
export function buildTopicsQuantityStrategy(
  verdict: 'under' | 'over',
  spec: BlueprintDetailSpec,
  options: { sync?: boolean } = {},
): string {
  return verdict === 'over'
    ? topicsOverStrategy(spec, options.sync === true)
    : topicsUnderStrategy(spec);
}

// ==================== 缩编 subagent 提示词 ====================

/**
 * 缩编 Agent 的系统提示（覆盖默认的「语言 + 项目上下文 + 文风纪律」组合）。
 * 它只做数量收敛，不看仓库、不产出正文，因此提示词保持极简。
 */
export const CONDENSE_SYSTEM_PROMPT = `你是一名信息架构编辑，负责把一份清单收敛到指定的数量区间。
你只做结构性的合并或拆分，不改变每个条目的含义，也不写解释性文字。
最终结果必须通过工具提交，工具之外的任何文字都会被忽略。`;

/** 缩编分类清单的任务提示词（第 3 轮：只看清单本身打破自我锚定） */
export function buildCondenseSectionTask(options: {
  spec: BlueprintDetailSpec;
  sections: WikiSection[];
  /** sync：既有分类必留，只允许合并新增 */
  sync?: boolean;
}): string {
  const { spec, sections } = options;
  const lines = sections.map(
    (section) => `- ${section.title}${section.description ? `：${section.description}` : ''}`,
  );
  const rules = options.sync
    ? [
        '既有分类必须全部保留，标题逐字一致；',
        `只能把新增分类并入既有分类，合并后总数不得超过 ${spec.sections.max} 个；`,
      ]
    : spec.sections.max < sections.length
      ? [
          '优先合并同一领域、同一受众的分类（description 融合两者要点）；',
          '概览 / 快速开始 / 核心架构永不合并；高密度核心机制分类永不合并；',
        ]
      : [
          '把覆盖过宽的条目拆成更细的子领域，或补充能承载多个模块的顶级分类；',
          '每个分类都必须给出一句 description。',
        ];

  return [
    `下面是一份 Wiki 顶级分类清单（共 ${sections.length} 个），要求数量为 ${spec.sections.min}~${spec.sections.max} 个。`,
    '请在不改变条目含义的前提下，输出一份符合数量要求的最终清单：',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    '## 待处理的分类清单',
    ...lines,
    '',
    '请调用 submit_condensed_sections 提交最终清单（只输出清单本身）。',
  ].join('\n');
}

/** 缩编主题清单的任务提示词（第 3 轮） */
export function buildCondenseTopicsTask(options: {
  spec: BlueprintDetailSpec;
  section: string;
  topics: WikiTopic[];
  /** sync：旧页面（title）必须原样保留 */
  sync?: boolean;
}): string {
  const { spec, section, topics } = options;
  const lines = topics.map((topic) => {
    const group = topic.group ? `（group: ${topic.group}）` : '';
    const files = topic.associatedFiles?.length ? ` [files: ${topic.associatedFiles.join(', ')}]` : '';
    return `- ${topic.title}${group}${files}`;
  });
  const rules = options.sync
    ? [
        '旧页面必须原样保留（title 逐字一致），不能通过删除页面收敛数量；',
        `只能把新增主题并入既有主题，合并后数量不得超过 ${spec.topics.max} 篇。`,
      ]
    : spec.topics.max < topics.length
      ? [
          '优先合并同一 group 内、面向同一读者、粒度相近的主题；',
          '同一领域的不同平台 / 协议实现不合并；高密度核心机制永不合并；',
          '合并后的主题保留更贴切的 group 与 associatedFiles 并集。',
        ]
      : [
          '把覆盖多个功能点的宽泛主题拆成独立成篇的主题；',
          '补充尚未覆盖的子系统 / 核心文件，并给出 associatedFiles。',
        ];

  return [
    `下面是分类「${section}」的文章主题清单（共 ${topics.length} 篇），要求数量为 ${spec.topics.min}~${spec.topics.max} 篇。`,
    '请在不改变条目含义的前提下，输出一份符合数量要求的最终清单：',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    '## 待处理的主题清单',
    ...lines,
    '',
    '请调用 submit_condensed_topics 提交最终清单（只输出清单本身）。',
  ].join('\n');
}

// ==================== 代码确定性兜底 ====================

/**
 * 分类清单的代码兜底（永不悬挂）：
 * - minimal：只保留「概览」；
 * - sync（传 existing）：既有分类必留，新增按序填充到上限；
 * - generate：基础分类保序取前 N（N = 档位上限）。
 */
export function codeFallbackSections(options: {
  input: unknown;
  language: string;
  spec: BlueprintDetailSpec;
  existing?: WikiSection[] | null;
}): WikiSection[] {
  const { input, language, spec, existing } = options;
  if (spec.level === 'minimal') {
    return normalizeBlueprintSections(input, language, 1, { minimal: true });
  }
  if (existing) {
    return mergeBlueprintSections(existing, input, language, spec.sections.max);
  }
  return normalizeBlueprintSections(input, language, spec.sections.max);
}

/** 主题是否属于「无 group」条目（每个无 group 条目视为独立分组，优先保留） */
function distinctGroupKey(topic: WikiTopic, index: number): string {
  const group = typeof topic.group === 'string' ? topic.group.trim().toLowerCase() : '';
  return group ? `g:${group}` : `u:${index}`;
}

/**
 * 主题清单的代码兜底（永不悬挂）：
 * 每 distinct group 保 1 篇（首次出现的顺序），再按原顺序填充剩余名额，直到上限。
 *
 * `preserveTitles`（sync）：这些 title（大小写不敏感）必须优先保留（既有页面必留）。
 */
export function condenseTopicsToMax(
  topics: WikiTopic[],
  max: number,
  options: { preserveTitles?: string[] } = {},
): WikiTopic[] {
  const valid = (Array.isArray(topics) ? topics : []).filter(
    (topic): topic is WikiTopic => Boolean(topic) && typeof topic.title === 'string' && topic.title.trim().length > 0,
  );
  if (max <= 0) return [];
  if (valid.length <= max) return valid;

  const preserve = new Set((options.preserveTitles ?? []).map((title) => title.trim().toLowerCase()));
  const picked: WikiTopic[] = [];
  const pickedIndex = new Set<number>();
  const seenGroups = new Set<string>();

  const push = (index: number): void => {
    if (pickedIndex.has(index) || picked.length >= max) return;
    pickedIndex.add(index);
    picked.push(valid[index]);
  };

  // 第一优先级：sync 的既有页面
  for (let index = 0; index < valid.length; index++) {
    if (preserve.has(valid[index].title.trim().toLowerCase())) push(index);
  }
  // 第二优先级：每个 distinct group 保 1 篇
  for (let index = 0; index < valid.length; index++) {
    const key = distinctGroupKey(valid[index], index);
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    push(index);
  }
  // 第三优先级：按原顺序填充剩余名额
  for (let index = 0; index < valid.length; index++) {
    push(index);
  }

  return picked;
}

// ==================== minimal 的「全景导览」 ====================

/**
 * minimal 档位的页面提示词附加要求：唯一一篇全景导览必须用 Mermaid 架构图
 * 梳理模块关系与数据流（由 generate-wiki 在拼页面提示词时附加）。
 */
export const MINIMAL_PANORAMA_REQUIREMENT = `## 全景导览附加要求（blueprint.detail = minimal）

本篇是项目的**唯一**一篇全景导览文章，必须让读者只读这一篇就能建立对项目的完整认知：

- **必须**使用 Mermaid 架构图梳理模块关系与数据流（\`\`\`mermaid + \`flowchart TB\`）；节点标签一律用 quoted label（如 \`A["核心模块"]\`），禁止裸写带括号/路径/符号的标签；
- 图中至少覆盖：入口层 → 核心模块 → 数据 / 存储 / 外部依赖的完整链路，并标注关键数据流方向；
- 图之外用文字补充模块职责与协作关系（谁调用谁、为什么这样分层），不要只给一张图；
- 仍然遵守通用溯源纪律：关键论述末尾给出 \`Sources: [文件](路径#Lx-Ly)\`。`;
