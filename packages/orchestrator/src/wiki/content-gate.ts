/**
 * 内容密度门（content gate）—— 纯函数 + 常量表
 *
 * 来源：lecture-to-notes 的 `scripts/verify_notes.py::density_gate`
 * （先逐字复制判定结构，再做 TS 兼容改写，见 MIGRATION §29 / §5.5）。
 * 复制后改写：CJK 正则 → 通用可见文本计数（剥离 frontmatter / 代码块 / Mermaid /
 * `Sources:` 行 / 表格）；视频时长基准 → level + 关联文件规模；强阻断 → warn/enforce
 * 可降级（§5.1）。判定语义保持一致，有意偏差见 MIGRATION §29。
 * 仅与 tools/page-tools.ts（拦截点）、wiki/verify-wiki.ts、MIGRATION §29 一起改动。
 *
 * 移植纪律（§5.5）：阈值不得随手「优化」。下限表数值是按 fixtures/hello-python
 * 与真实仓库规模标定的，任何变动须在 MIGRATION §29 声明为有意偏差。
 *
 * 反注水（§4，与密度门同一 PR 落地）：门限是**下限不是目标**——
 * 「源没有就应该是 0」：关联文件没有可写代码时代码块正确答案是 0；
 * 不涉及拓扑关系的页面 Mermaid 数正确答案是 0（minimal 档 panorama 是唯一例外）；
 * 达标不等于写得好，不在 TUI 上把「超出下限 X%」当 KPI 展示。
 */

import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';
import type { ContentGateMode, WikiLevel, WikiPage } from '@zread-pi/types';

// ==================== 指标 ====================

/** 内容门的机械度量（全部纯文本可判定，零外部依赖） */
export interface ContentGateMetrics {
  /** 散文字符数：剥离 frontmatter / 代码块 / Mermaid / Sources 行 / 表格后的可见文本 */
  proseChars: number;
  /** 标题总数（`^#{1,6} `） */
  headings: number;
  /** 出现过的标题层级（顺序，用于跳级检测） */
  headingLevels: number[];
  /** Mermaid 围栏块数 */
  mermaidBlocks: number;
  /** 代码块数（不含 Mermaid） */
  codeBlocks: number;
  /** `Sources:` 溯源行数 */
  sourceNotes: number;
  /** 参与到「连续 ≥3 段同前缀词」运行的段落数 */
  repeatOpenings: number;
}

/** 内容门报告（写进 PageResult.gate，可选字段不破坏旧调用方） */
export interface ContentGateReport {
  /** 是否全部硬性指标达标（建议项不影响该字段） */
  passed: boolean;
  /** 生效模式（warn 只记录 / enforce 拦截 / enforce-degraded 降级落盘） */
  mode: 'warn' | 'enforce' | 'enforce-degraded';
  /** 度量值 */
  metrics: ContentGateMetrics;
  /** 硬性失败项的人类可读说明（带「当前 N / 下限 M」常驻反馈） */
  failures: string[];
  /**
   * 软性建议项（不影响 passed、不拦截）：例如「建议补充代码片段」。
   * 反注水（§4）：源里没有可写代码时代码块正确答案是 0，不能机械地判失败。
   */
  advisories: string[];
  /** 耗时（毫秒，诊断用） */
  durationMs: number;
}

// ==================== 下限表（纯常量，对齐 BLUEPRINT_DETAIL_SPECS 的形状） ====================

/** 单个难度等级的散文下限参数（下限 = base + perFile × min(文件数, cap)） */
interface ContentGateSpec {
  level: WikiLevel;
  /** 散文字符下限基准 */
  proseBase: number;
  /** 每个关联源文件追加的字符数 */
  prosePerFile: number;
  /** 计入关联文件数的上限（避免无限追加） */
  proseFileCap: number;
  /** 散文下限的绝对封顶（避免大页面下限失控） */
  proseMax: number;
  /** 是否建议出现代码块（关联源文件且非 Beginner 时建议 ≥1） */
  codeRecommended: boolean;
}

/**
 * 难度等级 → 散文下限参数。
 *
 * 数值标定依据：Beginner 页面以概念解释为主（1200 字起步），Intermediate / Advanced
 * 页面论述更深、关联文件更多（1800 / 2400）。每多一个关联源文件多 200 字，
 * 最多计入 8 个文件；`proseMax` = base + perFile × 8，即文件封顶所能达到的上限，
 * 作为「单页散文需求」的绝对天花板。
 */
const CONTENT_GATE_SPECS: Record<WikiLevel, ContentGateSpec> = {
  Beginner: {
    level: 'Beginner',
    proseBase: 1200,
    prosePerFile: 200,
    proseFileCap: 8,
    proseMax: 2800,
    codeRecommended: false,
  },
  Intermediate: {
    level: 'Intermediate',
    proseBase: 1800,
    prosePerFile: 200,
    proseFileCap: 8,
    proseMax: 3400,
    codeRecommended: true,
  },
  Advanced: {
    level: 'Advanced',
    proseBase: 2400,
    prosePerFile: 200,
    proseFileCap: 8,
    proseMax: 4000,
    codeRecommended: true,
  },
};

/** 「重复句首」允许的上限：参与到连续同前缀词运行的段落数超过此值才算失败 */
const REPEAT_OPENINGS_MAX = 2;

/** 强制要求 Mermaid 图的 section 角色（classify 的基础分类，中英皆含） */
const OVERVIEW_SECTIONS = new Set([
  '概览',
  'overview',
  '核心架构',
  'core architecture',
]);

// ==================== 文本剥离（移植自 verify_notes.py 的 flatten_tex 思路） ====================

const YAML_FENCE_OPEN_RE = /^---[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+/;
const FENCE_RE = /^```[ \t]*/;
const MERMAID_LANG_RE = /^```[ \t]*mermaid\b/i;
const SOURCE_LINE_RE = /^\s*Sources:/;
const TABLE_ROW_RE = /^\s*\|/;

/** 去掉 YAML frontmatter（`---\n...\n---`），返回剩余正文 */
function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines.length === 0 || !YAML_FENCE_OPEN_RE.test(lines[0])) return content;
  for (let i = 1; i < lines.length; i++) {
    if (YAML_FENCE_OPEN_RE.test(lines[i])) {
      return lines.slice(i + 1).join('\n');
    }
  }
  // 只有开头的 `---` 没有闭合：当作无 frontmatter
  return content;
}

/** 判定关联文件里有多少个「源文件」（以 `/` 结尾的是目录，不算） */
function countSourceFiles(page: WikiPage): number {
  return (page.associatedFiles ?? []).filter((file) => !file.trim().endsWith('/')).length;
}

/**
 * 单遍扫描计算全部指标（复用 page-tools 的 MERMAID_FENCE_RE 语义，但自行计数，
 * 不导出 extractMermaidBlocks，避免为复用扩大导出面）。
 */
export function extractGateMetrics(fullContent: string): ContentGateMetrics {
  const body = stripFrontmatter(fullContent);
  const lines = body.split('\n');

  const metrics: ContentGateMetrics = {
    proseChars: 0,
    headings: 0,
    headingLevels: [],
    mermaidBlocks: 0,
    codeBlocks: 0,
    sourceNotes: 0,
    repeatOpenings: 0,
  };

  let inFence = false;
  // 散文段落缓冲（连续的非剥离行成段），用于重复句首检测
  const paragraphs: string[] = [];
  let pending: string[] = [];

  const flushParagraph = (): void => {
    if (pending.length > 0) {
      paragraphs.push(pending.join('\n'));
      pending = [];
    }
  };

  for (const line of lines) {
    // 围栏开合：在围栏内的一律不计入散文
    if (FENCE_RE.test(line)) {
      if (!inFence) {
        inFence = true;
        flushParagraph();
        if (MERMAID_LANG_RE.test(line)) metrics.mermaidBlocks += 1;
        else metrics.codeBlocks += 1;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    // Sources 溯源行
    if (SOURCE_LINE_RE.test(line)) {
      flushParagraph();
      metrics.sourceNotes += 1;
      continue;
    }
    // 表格行
    if (TABLE_ROW_RE.test(line)) {
      flushParagraph();
      continue;
    }

    // 空行：段落边界
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      metrics.headings += 1;
      metrics.headingLevels.push(heading[1].length);
      // 标题文字计入散文（可见文本）
      metrics.proseChars += [...line.replace(HEADING_RE, '')].length;
      continue;
    }

    // 普通散文行
    metrics.proseChars += [...line].length;
    pending.push(line);
  }
  flushParagraph();

  metrics.repeatOpenings = countRepeatOpenings(paragraphs);
  return metrics;
}

/** 去掉行首的 markdown 装饰（列表符号 / 引用 / 序号 / 标题井号） */
function stripLeadingMarkdown(text: string): string {
  return text
    .trim()
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/^(?:[-*>]|[0-9]+[.)])[ \t]*/, '')
    .trim();
}

/** 段落的前缀词键（取前 3 个码位，中英通用；忽略大小写） */
function openingKey(paragraph: string): string | null {
  const core = stripLeadingMarkdown(paragraph);
  if (core.length === 0) return null;
  // 纯标点 / 分隔线之类的开头不参与统计
  if (/^[\p{P}\s]+$/u.test(core.slice(0, 3))) return null;
  return [...core.slice(0, 3)].join('').toLowerCase();
}

/**
 * 统计参与到「连续 ≥3 段同前缀词」运行的段落数（对齐 reader-first 的「重复句首」）。
 *
 * 口径：对每个最大同键运行，长度 ≥3 时把该运行的段落数全部计入；多个运行累加。
 * 允许的上限见 REPEAT_OPENINGS_MAX。
 */
function countRepeatOpenings(paragraphs: string[]): number {
  const keys = paragraphs.map(openingKey);
  let total = 0;
  let runStart = 0;

  for (let i = 1; i <= keys.length; i++) {
    const prev = keys[i - 1];
    const current = i < keys.length ? keys[i] : null;
    if (current !== null && current === prev && prev !== null) continue;
    // 运行在 i 处断开：[runStart, i) 是同键运行
    const runLength = i - runStart;
    if (runLength >= 3) total += runLength;
    runStart = i;
  }
  return total;
}

// ==================== 下限判定 ====================

/** 散文字符下限（自适应 level + 关联文件规模，不搞一刀切） */
export function proseFloor(page: WikiPage): number {
  const spec = CONTENT_GATE_SPECS[page.level] ?? CONTENT_GATE_SPECS.Intermediate;
  const fileCount = Math.min(countSourceFiles(page), spec.proseFileCap);
  return Math.min(spec.proseBase + spec.prosePerFile * fileCount, spec.proseMax);
}

/**
 * 是否强制要求 Mermaid 图：由 section 角色（基础分类）与档位 panorama 派生，
 * **不挂在 level 表上**（难度与「是否需要架构图」正交，见 §5.5 审查修订 #8）。
 */
export function mermaidRequiredFor(page: WikiPage, spec: BlueprintDetailSpec): boolean {
  if (spec.panorama) return true;
  return OVERVIEW_SECTIONS.has(page.section.trim().toLowerCase());
}

/** 是否建议出现代码块（关联源文件且非 Beginner；源没有代码时正确答案是 0） */
export function codeRecommendedFor(page: WikiPage): boolean {
  const spec = CONTENT_GATE_SPECS[page.level] ?? CONTENT_GATE_SPECS.Intermediate;
  return spec.codeRecommended && countSourceFiles(page) > 0;
}

/** 是否跳级（`#` → `###` 这类跨级标题） */
function hasHeadingSkip(levels: number[]): boolean {
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) return true;
  }
  return false;
}

/**
 * 评估内容门（纯函数）：metrics + 下限比对 + 失败说明。
 *
 * `mode` 只影响报告里的标记（拦截/降级由工具层与 generate-wiki 承担）。
 */
export function evaluateContentGate(
  fullContent: string,
  page: WikiPage,
  spec: BlueprintDetailSpec,
  mode: 'warn' | 'enforce' = 'warn',
): ContentGateReport {
  const startTime = performance.now();
  const metrics = extractGateMetrics(fullContent);
  const failures: string[] = [];
  const advisories: string[] = [];

  const proseNeed = proseFloor(page);
  if (metrics.proseChars < proseNeed) {
    failures.push(
      `散文篇幅不足：当前 ${metrics.proseChars} / 下限 ${proseNeed}（按难度 ${page.level} 与 ${countSourceFiles(page)} 个关联源文件自适应）；请补充源码支撑的讲解，不要同义改写注水`,
    );
  }

  const hasH2 = metrics.headingLevels.includes(2);
  if (!hasH2) {
    failures.push('缺少二级标题（##）：每个页面至少需要一个二级标题划分结构');
  }
  if (hasHeadingSkip(metrics.headingLevels)) {
    failures.push('标题层级跳级（如 # 直接到 ###）：标题应逐级递进，不跳级');
  }

  if (metrics.sourceNotes < 1) {
    failures.push('缺少 Sources 溯源行：关键论述末尾必须有 `Sources: [文件](路径#Lx-Ly)`');
  }

  if (mermaidRequiredFor(page, spec) && metrics.mermaidBlocks < 1) {
    failures.push(
      '缺少 Mermaid 架构图：本页属于概览/核心架构类（或 minimal 全景导览），必须用 Mermaid 梳理模块关系',
    );
  }

  if (codeRecommendedFor(page) && metrics.codeBlocks < 1) {
    // 软性建议（反注水 §4）：源里可能确实没有可写代码，正确答案是 0，
    // 因此只提示不判失败、不拦截。
    advisories.push(
      '建议补充代码片段：关联了源文件但正文没有代码块（若源里确实没有可写代码，正确答案是 0，此条不判失败）',
    );
  }

  if (metrics.repeatOpenings > REPEAT_OPENINGS_MAX) {
    failures.push(
      `段落句首重复过多：${metrics.repeatOpenings} 段参与到连续同前缀词运行（上限 ${REPEAT_OPENINGS_MAX}）；请改写重复的句首`,
    );
  }

  return {
    passed: failures.length === 0,
    mode,
    metrics,
    failures,
    advisories,
    durationMs: Math.round(performance.now() - startTime),
  };
}

// ==================== 反馈文案（对齐 formatQuantityFeedback 的「当前 N / 下限 M」风格） ====================

/** 把报告格式化成工具错误文案（enforce 拦截时返回给模型，促其重写） */
export function formatContentGateError(report: ContentGateReport): string {
  return [
    '内容密度门未通过（Content gate failed）：以下指标低于下限，请按说明重写后再调用 write_page。',
    '注意：门限是下限不是目标——不要同义改写注水、不要为凑图表而加图；源里没有可写代码时代码块正确答案是 0。',
    '',
    ...report.failures.map((failure, index) => `${index + 1}. ${failure}`),
  ].join('\n');
}

/** 从 write_page 的 JSON 结果里解析内容门报告（成功 / 拦截结果都可能携带） */
export function extractGateReport(content: unknown): ContentGateReport | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as { gate?: unknown };
    const gate = parsed.gate;
    if (!gate || typeof gate !== 'object') return undefined;
    const raw = gate as Record<string, unknown>;
    const metrics = raw.metrics as Record<string, unknown> | undefined;
    if (!metrics || typeof metrics !== 'object') return undefined;
    return {
      passed: raw.passed === true,
      mode:
        raw.mode === 'warn' || raw.mode === 'enforce' || raw.mode === 'enforce-degraded'
          ? raw.mode
          : 'warn',
      metrics: metrics as unknown as ContentGateMetrics,
      failures: Array.isArray(raw.failures)
        ? (raw.failures as string[]).filter((f) => typeof f === 'string')
        : [],
      advisories: Array.isArray(raw.advisories)
        ? (raw.advisories as string[]).filter((f) => typeof f === 'string')
        : [],
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * 由配置解析内容门模式（generate-wiki / verify-wiki 的统一入口）。
 *
 * `enabled = false` 与 `mode = 'off'` 等价：完全跳过（不计算、不记录）。
 */
export function resolveGateMode(config: {
  quality?: { contentGate?: { enabled?: boolean; mode?: ContentGateMode } } | null;
}): 'off' | 'warn' | 'enforce' {
  const gate = config.quality?.contentGate;
  if (!gate || gate.enabled === false) return 'off';
  return gate.mode ?? 'warn';
}

// ==================== 与 Python 参考实现的黄金值对照（§5.5） ====================

/**
 * CJK 统一表意文字计数。
 *
 * 逐字移植自 `verify_notes.py:38` 的 `CJK = re.compile(r"[一-鿿]")`
 * （U+4E00..U+9FFF，不含扩展区 B 及以外）。供黄金值对照（见
 * `test/golden-parity.ts`）：同一输入下 TS 与 Python 的计数必须一致。
 * 语义保持源实现，不随手「优化」。
 */
const CJK_RE = /[\u4e00-\u9fff]/u;

export function countCjkChars(text: string): number {
  return [...text].filter((char) => CJK_RE.test(char)).length;
}

/**
 * 数字台账的 TS 侧口径（对照 `extract_claims.py::numbers_in`）。
 *
 * 语义：`\d+(?:[.,]\d+)*`——连续数字串，小数点 / 千分位逗号续接为一段。
 * 逐字保持源正则语义（逗号是千分位而非分隔符，与 Python 同一输入下结果一致）。
 */
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

export function numbersIn(value: string): string[] {
  return value.match(NUMBER_RE) ?? [];
}
