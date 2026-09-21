/**
 * Page Agent Tools
 *
 * Tools for Wiki page content generation.
 *
 * - write_page: Write Wiki page content to file with organized path structure
 *
 * Note: agent-runtime provides LsTool / GrepTool / GlobTool for directory listing and code search,
 * no need to duplicate here.
 */

import { resolve, dirname } from 'path';
import { defineTool, getRequiredString, getString } from '@zread-pi/agent-runtime';
import type { ToolInputParams, ToolContext, ToolDefinition } from '@zread-pi/agent-runtime';
import type { BlueprintDetailLevel, WikiPage } from '@zread-pi/types';
import { ensureDir, writeTextFile } from '@zread-pi/utils';
import {
  evaluateContentGate,
  formatContentGateError,
  type ContentGateReport,
} from '../wiki/content-gate.js';
import { detectMermaidSyntax, type MermaidSyntax } from '../wiki/mermaid-syntax.js';
import type { BlueprintDetailSpec } from '../agents/blueprint-detail.js';

// 内容门报告类型由此再导出（wiki/types.ts 的 PageResult.gate 引用）
export type { ContentGateReport, ContentGateMetrics } from '../wiki/content-gate.js';
// 语法类型检测由此再导出（content-gate 的分类型计数与本校验层共用同一份判定）
export { detectMermaidSyntax, type MermaidSyntax } from '../wiki/mermaid-syntax.js';

/** 校验问题所属的层：三类语法，或题注层（caption） */
export type MermaidIssueSyntax = MermaidSyntax | 'caption';

interface MermaidValidationIssue {
  block: number;
  line: number;
  /** 所属层：flowchart / sequence / state / caption（机器可解析的分组键） */
  syntax: MermaidIssueSyntax;
  /** 规则标识（机器可解析，如 FLOW_LABEL_QUOTES / SEQ_ARROW_INVALID / CAPTION_MISSING） */
  rule: string;
  /** 节点 id / 参与者名 / 状态名（题注类为题注要求的关键词） */
  nodeId: string;
  /** 相关标签 / 原始行文本（诊断用） */
  label: string;
  /** 一行人类可读说明（formatMermaidValidationError 直接拼接） */
  message: string;
}

interface MermaidBlock {
  code: string;
  /** fence 起始行号（1 起算，含 ```mermaid 行本身） */
  startLine: number;
}

type PageToolResult = string | { data: string; is_error?: boolean };

const MERMAID_FENCE_RE = /^```[ \t]*mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gim;
const FLOWCHART_NODE_LABEL_RE = /\b([A-Za-z_][\w-]*)\[([^\]\n]+)\]/g;
const LABEL_REQUIRES_QUOTES_RE = /[(){}|<>]/;

/** 构造一条校验问题（block / line 为 1 起算的人类可定位坐标） */
function makeIssue(
  block: number,
  line: number,
  syntax: MermaidIssueSyntax,
  rule: string,
  nodeId: string,
  label: string,
  message: string,
): MermaidValidationIssue {
  return { block, line, syntax, rule, nodeId, label, message };
}

function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let match: RegExpExecArray | null;

  MERMAID_FENCE_RE.lastIndex = 0;
  while ((match = MERMAID_FENCE_RE.exec(markdown)) !== null) {
    const beforeBlock = markdown.slice(0, match.index);
    blocks.push({
      code: match[1],
      startLine: beforeBlock.split('\n').length,
    });
  }

  return blocks;
}

function isQuotedLabel(label: string): boolean {
  const trimmed = label.trim();
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
}

// ==================== flowchart（架构图 / 流程图，既有规则不变） ====================

function validateFlowchartBlock(code: string, startLine: number): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];

  for (const [lineIndex, line] of code.split('\n').entries()) {
    let match: RegExpExecArray | null;

    FLOWCHART_NODE_LABEL_RE.lastIndex = 0;
    while ((match = FLOWCHART_NODE_LABEL_RE.exec(line)) !== null) {
      const [, nodeId, label] = match;

      if (!isQuotedLabel(label) && LABEL_REQUIRES_QUOTES_RE.test(label)) {
        issues.push(
          makeIssue(
            0, // 调用方按块号覆盖
            startLine + lineIndex,
            'flowchart',
            'FLOW_LABEL_QUOTES',
            nodeId,
            label,
            `flowchart 节点 \`${nodeId}\` 的标签含 Mermaid 结构字符（() {} | <>），必须加引号：${nodeId}["${label}"]`,
          ),
        );
      }
    }
  }

  return issues;
}

// ==================== sequence（序列图） ====================

/** 标识符：允许 CJK（mermaid 接受 `participant 网关` / `网关->>B: x` 这类名字）。
 *  不含 `-`：连字符会与箭头记号粘连（`Alice->>Bob` 的发送者会被吃成 `Alice-`） */
const ID_CHARS = '[A-Za-z_\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff]*';

/** 箭头记号允许出现的字符（不含字母 / 数字 / CJK，避免贪婪吞掉接收者名） */
const ARROW_CHARS = '[-=<>\\)/xX\\u2192\\u2190\\u2191\\u2193\\u27F6\\u27F5\\u27F7\\u21D0\\u21D2\\u21D4\\u279C]';

/** 参与者声明：participant / actor 后跟名字 */
const SEQ_PARTICIPANT_RE = new RegExp(`^\\s*(?:participant|actor)\\s+(${ID_CHARS})`, 'i');
/** participant / actor 后面连一个名字都没有（mermaid 词法错误） */
const SEQ_PARTICIPANT_BARE_RE = /^\s*(?:participant|actor)\s*$/i;
/** 参与者显示名：`participant A as <显示名>` */
const SEQ_PARTICIPANT_AS_RE = new RegExp(
  `^\\s*(?:participant|actor)\\s+${ID_CHARS}\\s+as\\s+(.+)$`,
  'i',
);
/** 消息行：`<sender> <箭头记号> <receiver>`（箭头记号只吃箭头字符，不吃标识符） */
const SEQ_TOKEN_RE = new RegExp(
  `^\\s*(${ID_CHARS})[ \\t]*(${ARROW_CHARS}+)[ \\t]*(${ID_CHARS})`,
);
/** Note 引用：`Note over A[, B]` 或 `Note (left|right) of A`（over 形态不带 left/right） */
const SEQ_NOTE_RE = new RegExp(
  `^\\s*Note[ \\t]+(?:(?:left|right)[ \\t]+of|over)[ \\t]+(${ID_CHARS}(?:[ \\t]*,[ \\t]*${ID_CHARS})*)`,
  'i',
);

/** sequence 的合法箭头记号（其余形态见 mermaid 文档；未知记号不判失败，避免误杀） */
const SEQ_VALID_ARROWS = new Set([
  '->>', '-->>', '->', '-->', '-x', '--x', '-)', '--)',
  '\\->>', '\\->', '/->>', '/->',
]);
/** sequence 明确非法的箭头记号（真实 parse error，见 tools/probe-mermaid.ts 的探针结论） */
const SEQ_INVALID_ARROWS = new Set([
  '<-', '<--', '<->', '==>', '=>', '→', '⟶', '⟵', '⇒', '⇐', '➜',
]);

function validateSequenceBlock(code: string, startLine: number): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];
  const lines = code.split('\n');
  const participants = new Set<string>();

  // 第一遍：收集全部参与者（声明 + 消息端点）。Note 的 grounding 比对需要全量集合，
  // 因此先收集再判定，允许后声明的参与者（mermaid 本身也允许隐式 / 乱序声明）。
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('%%')) continue;

    const decl = SEQ_PARTICIPANT_RE.exec(trimmed);
    if (decl) {
      participants.add(decl[1]);
      continue;
    }
    const msg = SEQ_TOKEN_RE.exec(trimmed);
    if (msg) {
      participants.add(msg[1]);
      participants.add(msg[3]);
    }
  }

  // 第二遍：逐行判定。顺序是「声明 → Note → 消息」：
  // Note 行与声明行会被宽泛的消息正则误当作消息，必须先判。
  for (const [lineIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('%%')) continue;
    const lineNo = startLine + lineIndex;

    // 1. 参与者定义合法（空名 → mermaid 词法错误）
    if (SEQ_PARTICIPANT_BARE_RE.test(line)) {
      issues.push(
        makeIssue(0, lineNo, 'sequence', 'SEQ_PARTICIPANT_EMPTY', '', line, '参与者定义为空：participant / actor 后必须跟一个名字'),
      );
      continue;
    }
    const decl = SEQ_PARTICIPANT_RE.exec(line);
    if (decl) {
      participants.add(decl[1]);
      // 2. 显示名（as 后）含结构字符 → 必须加引号（与 flowchart 同一引号纪律）
      const asMatch = SEQ_PARTICIPANT_AS_RE.exec(line);
      if (asMatch) {
        const display = asMatch[1].trim();
        if (!isQuotedLabel(display) && LABEL_REQUIRES_QUOTES_RE.test(display)) {
          issues.push(
            makeIssue(
              0, lineNo, 'sequence', 'SEQ_LABEL_QUOTES', decl[1], display,
              `参与者 \`${decl[1]}\` 的显示名含 Mermaid 结构字符，必须加引号：participant ${decl[1]} as "${display}"`,
            ),
          );
        }
      }
      continue;
    }

    // 3. Note：引用的参与者必须出现过；且必须用单行 `: 文本` 形态
    //    （sequence 不支持 `end note` 多行，否则 mermaid parse error）
    const note = SEQ_NOTE_RE.exec(line);
    if (note) {
      if (!/:/.test(line)) {
        issues.push(
          makeIssue(0, lineNo, 'sequence', 'SEQ_NOTE_SYNTAX', '', line, 'Note 缺少 `: 说明文本`（序列图不支持 end note 多行形态）'),
        );
        continue;
      }
      for (const name of note[1].split(',').map((item) => item.trim()).filter(Boolean)) {
        if (!participants.has(name)) {
          issues.push(
            makeIssue(
              0, lineNo, 'sequence', 'SEQ_NOTE_UNKNOWN_PARTICIPANT', name, line,
              `Note 引用了未在图内出现的参与者 \`${name}\`（参与者必须先在 participant 声明或消息中出现）`,
            ),
          );
        }
      }
      continue;
    }

    // 4. 消息箭头语法（合法记号放行、非法记号拦截、未知记号不判）
    const tokens = SEQ_TOKEN_RE.exec(line);
    if (tokens) {
      const [, sender, arrow, receiver] = tokens;
      if (SEQ_INVALID_ARROWS.has(arrow)) {
        issues.push(
          makeIssue(
            0, lineNo, 'sequence', 'SEQ_ARROW_INVALID', sender, line,
            `消息箭头非法：\`${sender} ${arrow} ${receiver}\`（序列图只接受 ->> -->> -> --> -x --x -) --) 等箭头）`,
          ),
        );
      }
    }
  }

  return issues;
}

// ==================== state（状态图） ====================

const STATE_TOKEN_RE = new RegExp(
  `^\\s*(\\[\\*\]|${ID_CHARS})[ \\t]*(${ARROW_CHARS}+)[ \\t]*(\\[\\*\]|${ID_CHARS})`,
);
const STATE_NOTE_RE = new RegExp(`^\\s*note[ \\t]+(?:left|right)[ \\t]+of\\b`, 'i');
/** `state <标签> as <id>`：标签必须加引号（mermaid 要求，见探针结论） */
const STATE_LABELED_RE = /^\s*state\s+([^:\n]+?)\s+as\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*$/i;

/** state 的合法迁移箭头只有 `-->`（其余单箭头 / 反向箭头 / 三连箭头均为 parse error） */
const STATE_VALID_ARROWS = new Set(['-->']);
const STATE_INVALID_ARROWS = new Set([
  '->', '<-', '<->', '<--', '--->', '==>', '=>', '→', '⟶', '⟵', '⇒', '⇐', '➜',
]);

/** 多行 note 的收尾标记（`note ... of X` 后若无 `:`，必须以 `end note` 收尾） */
const END_NOTE_RE = /^\s*end\s+note\s*$/i;
/** 前瞻上限：多行 note 的收尾不会离得很远，避免无界扫描 */
const NOTE_LOOKAHEAD = 10;

function validateStateBlock(code: string, startLine: number): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];
  const lines = code.split('\n');

  /** 从 idx 下一行起找 `end note`：遇到迁移 / 状态声明则提前终止（那说明不是多行 note） */
  const hasEndNote = (fromIndex: number): boolean => {
    for (let i = fromIndex + 1; i < Math.min(lines.length, fromIndex + 1 + NOTE_LOOKAHEAD); i++) {
      const candidate = lines[i].trim();
      if (candidate.length === 0) continue;
      if (END_NOTE_RE.test(candidate)) return true;
      if (/-->|-->|<-/.test(candidate) || /^state\b/i.test(candidate)) return false;
    }
    return false;
  };

  for (const [lineIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('%%')) continue;
    const lineNo = startLine + lineIndex;

    // 1. `state <标签> as <id>`：标签必须加引号（`state 空闲 as Idle` 是 parse error）
    //    必须在迁移判定之前：`state X as Y` 会被宽泛的迁移正则误当作迁移行。
    const labeled = STATE_LABELED_RE.exec(line);
    if (labeled) {
      const label = labeled[1].trim();
      if (!isQuotedLabel(label)) {
        issues.push(
          makeIssue(
            0, lineNo, 'state', 'STATE_LABEL_QUOTES', labeled[2], label,
            `状态标签未加引号：state "${label}" as ${labeled[2]}（mermaid 要求 as 前的标签必须引号包裹）`,
          ),
        );
      }
      continue;
    }

    // 2. note 语法：单行形态必须带 `: 文本`；多行形态以 `end note` 收尾
    //    同样必须在迁移判定之前：`note left of X` 会被迁移正则误当作迁移行。
    if (STATE_NOTE_RE.test(line) && !/:/.test(line)) {
      if (!hasEndNote(lineIndex)) {
        issues.push(
          makeIssue(0, lineNo, 'state', 'STATE_NOTE_SYNTAX', '', line, 'note 缺少 `: 说明文本`（多行 note 必须以 `end note` 收尾）'),
        );
      }
      continue;
    }

    // 3. 迁移箭头语法（合法记号放行、非法记号拦截、未知记号不判——
    //    direction / note / state 复合块等行不该被误伤）
    const tokens = STATE_TOKEN_RE.exec(line);
    if (tokens) {
      const [, from, arrow, to] = tokens;
      if (STATE_INVALID_ARROWS.has(arrow)) {
        issues.push(
          makeIssue(
            0, lineNo, 'state', 'STATE_ARROW_INVALID', from, line,
            `迁移箭头非法：\`${from} ${arrow} ${to}\`（状态图只接受 -->）`,
          ),
        );
      }
    }
  }

  return issues;
}

// ==================== 题注层（L2） ====================

/** 题注类型词 → 语法（zh / en 双语；架构 / 流程同为 flowchart 语法） */
const CAPTION_TYPE_WORDS: ReadonlyArray<{ syntax: MermaidSyntax; words: string[] }> = [
  { syntax: 'flowchart', words: ['架构图', '流程图', 'Architecture Diagram', 'Flow Diagram', 'Flowchart', 'Process Diagram'] },
  { syntax: 'sequence', words: ['序列图', '时序图', 'Sequence Diagram'] },
  { syntax: 'state', words: ['状态图', 'State Diagram', 'State Machine Diagram'] },
];

/** 题注行形状：`**图｜架构图｜标题**` / `**Figure｜Sequence Diagram｜Title**` */
const CAPTION_SHAPE_RE = /^\s*\*\*(?:图|Figure)\s*[｜|]/;

/** 从题注行解析类型词所指示的语法（形状不符返回 null；形状符但类型词未知返回 'other'） */
function detectCaptionSyntax(line: string): MermaidSyntax | 'other' | null {
  if (!CAPTION_SHAPE_RE.test(line)) return null;
  const lower = line.toLowerCase();
  for (const { syntax, words } of CAPTION_TYPE_WORDS) {
    if (words.some((word) => lower.includes(word.toLowerCase()))) return syntax;
  }
  return 'other';
}

/** 找到 fence 上方最近的非空行（题注与 fence 之间允许空行） */
function nearestNonEmptyLine(lines: string[], fenceLineIndex: number): string | null {
  for (let i = fenceLineIndex - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return null;
}

/**
 * 题注校验（L2）：每张 mermaid 块的上一行必须是题注，且题注类型词与 fence 实际语法一致。
 *
 * 换来三件可机械保证的事：① 题注写「序列图」却画了 flowchart → 拦截（真实高频失败模式）；
 * ② reader-first「图要先在正文里被提到再出现」从写作纪律变成机器可查；
 * ③ 渲染层拿到题注文本（不再裸图）。
 *
 * 只在 **write_page 生成期**调用（与引号校验同机制、同降级路径）；
 * **verify-wiki 不查题注**——旧页面没有题注，回溯报 FAIL 会破坏既有产物（约束 6）。
 */
export function validateDiagramCaptions(content: string): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];
  const lines = content.split('\n');

  for (const [blockIndex, block] of extractMermaidBlocks(content).entries()) {
    // startLine 是 ```mermaid 所在行（1 起算），题注在其上方
    const captionLine = nearestNonEmptyLine(lines, block.startLine - 1);
    const detected = detectMermaidSyntax(block.code);

    if (captionLine === null) {
      issues.push(
        makeIssue(
          blockIndex + 1, block.startLine, 'caption', 'CAPTION_MISSING', '', '',
          `图上方缺少题注：必须在 fence 上一行写 **图｜<架构图|流程图|序列图|状态图>｜<一句话标题>**，如 **图｜序列图｜登录鉴权调用链**`,
        ),
      );
      continue;
    }

    const captionSyntax = detectCaptionSyntax(captionLine);
    if (captionSyntax === null) {
      issues.push(
        makeIssue(
          blockIndex + 1, block.startLine, 'caption', 'CAPTION_MISSING', '', captionLine.trim(),
          `图上方的题注格式不对（现在是「${captionLine.trim().slice(0, 40)}」）：必须是 **图｜<架构图|流程图|序列图|状态图>｜<一句话标题>**`,
        ),
      );
      continue;
    }

    // 类型一致性：题注类型词 ↔ fence 实际语法（unknown 图种只要求题注形状，不校对类型词）
    if (detected !== 'unknown' && captionSyntax !== 'other' && captionSyntax !== detected) {
      const word = CAPTION_TYPE_WORDS.find((entry) => entry.syntax === captionSyntax)?.words[0] ?? captionSyntax;
      issues.push(
        makeIssue(
          blockIndex + 1, block.startLine, 'caption', 'CAPTION_TYPE_MISMATCH', '', captionLine.trim(),
          `题注类型与图的实际语法不一致：题注写「${word}」，但 fence 实际是 ${detected === 'flowchart' ? 'flowchart（架构 / 流程图语法）' : detected}；请统一题注类型词与图类型`,
        ),
      );
    }
  }

  return issues;
}

// ==================== 汇总入口 ====================

/**
 * Mermaid 语法校验（导出供 verify-wiki / polish 复用）：按 fence 的实际语法类型分发。
 *
 * - flowchart（架构图 / 流程图）：节点标签含 `(){}|<>` 必须引号（**既有不变**）；
 * - sequence：参与者定义合法、消息箭头语法、显示名引号、Note 参与者 grounding；
 * - state：迁移箭头必须 `-->`、`state "标签" as id`、note 语法。
 *
 * 只做**语法合法性**判定，不查题注（题注校验见 validateDiagramCaptions，
 * 由 write_page 生成期单独强制，verify-wiki 不回溯查旧页面）。
 */
export function validateMermaidContent(content: string): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];

  for (const [blockIndex, block] of extractMermaidBlocks(content).entries()) {
    const syntax = detectMermaidSyntax(block.code);
    let blockIssues: MermaidValidationIssue[] = [];
    // startLine 是 ```mermaid 所在行；块内首行在文档的 startLine+1 行，
    // 传 startLine+1 让报出的行号与文档行号一致
    switch (syntax) {
      case 'flowchart':
        blockIssues = validateFlowchartBlock(block.code, block.startLine + 1);
        break;
      case 'sequence':
        blockIssues = validateSequenceBlock(block.code, block.startLine + 1);
        break;
      case 'state':
        blockIssues = validateStateBlock(block.code, block.startLine + 1);
        break;
      default:
        // 四类之外的图种（erDiagram / gantt / pie …）：不做语法校验
        continue;
    }
    for (const issue of blockIssues) issues.push({ ...issue, block: blockIndex + 1 });
  }

  return issues;
}

/** 把校验问题格式化成可读的错误文本（工具错误与 polish 回滚告警共用同一文案） */
export function formatMermaidValidationError(issues: MermaidValidationIssue[]): string {
  const details = issues
    .map((issue) => `- Mermaid block ${issue.block}, line ${issue.line} [${issue.syntax}/${issue.rule}]: ${issue.message}`)
    .join('\n');

  return [
    'Mermaid 校验未通过（write_page 拦截）。',
    '架构 / 流程图（flowchart）节点标签含 () {} | <> 必须加引号，如 A["reference-counter.ts<br/>引用计数器"]；',
    '序列图（sequenceDiagram）参与者显示名含结构字符必须加引号、箭头只用 ->> -->> -> --> -x --x -) --)；',
    '状态图（stateDiagram-v2）迁移箭头只用 -->、带标签状态必须写 state "标签" as id。',
    '此外每张 mermaid 块的 fence 上一行必须有题注：**图｜<架构图|流程图|序列图|状态图>｜<标题>**。',
    '',
    details,
  ].join('\n');
}

/**
 * 按 write_page 的路径规则解析页面输出路径（与工具内拼接规则保持一致）。
 *
 * - 传 `variant`（档位）时基准目录为 `.zread-pi/wiki/<variant>`（多档共存）；
 * - `file` 含路径分隔符 → 相对基准目录解析（忽略 `section`）
 * - `file` + `section` → `<基准>/<section>/<file>`
 * - 只有 `file` → `<基准>/<file>`
 * - 没有 `file` → `<基准>/<slug>.md`
 *
 * 单独导出，供 generate-wiki 的落盘兜底复用同一套解析规则。
 */
export function resolvePageOutputPath(
  cwd: string,
  params: { file?: string; section?: string; slug: string },
  options: { variant: BlueprintDetailLevel },
): string {
  const wikiDir = resolve(cwd, '.zread-pi/wiki', options.variant);
  const { file, section, slug } = params;

  if (file) {
    if (file.includes('/') || file.includes('\\')) {
      return resolve(wikiDir, file);
    }
    if (section) {
      return resolve(wikiDir, section, file);
    }
    return resolve(wikiDir, file);
  }

  return resolve(wikiDir, `${slug}.md`);
}

/**
 * 构造 YAML frontmatter（write_page 与 generate-wiki 的 best-effort 落盘共用同一格式，
 * 避免 drift）。
 */
export function buildPageFrontmatter(title?: string, slug?: string): string {
  return title ? `---\ntitle: "${title}"\nslug: "${slug}"\n---\n\n` : '';
}

/**
 * 内容门运行参数（由 generate-wiki 按页注入；缺省 / mode = off 时完全跳过）。
 *
 * `page` 提供难度 / section / associatedFiles，`spec` 提供 minimal 档的 panorama 标记。
 */
export interface ContentGateOptions {
  mode: 'warn' | 'enforce';
  page: WikiPage;
  spec: BlueprintDetailSpec;
}

/** write_page 工具的构造选项 */
export interface WritePageToolOptions {
  variant: BlueprintDetailLevel;
  /** 内容门（不传 / mode = off = 完全跳过，行为与迁移前一致） */
  contentGate?: ContentGateOptions;
}

/**
 * Write Page Tool
 *
 * Write Wiki page content to the specified file path.
 * Uses WikiPage.file field for path, organized by section.
 *
 * 路径结构（`variant` = 蓝图细节档位）：
 * `.zread-pi/wiki/<variant>/{section}/{file}`
 *
 * 内容门（quality.contentGate）：Mermaid 校验之后追加，`mode = enforce` 时返回
 * is_error + 「当前 N / 下限 M」反馈让模型重写；`warn` 只把报告塞进结果 JSON
 * （由 generate-wiki 提取写进 PageResult.gate，不拦截落盘）。
 */
export function createWritePageTool(options: WritePageToolOptions | BlueprintDetailLevel): ToolDefinition {
  // 兼容旧调用方直接传 variant 的写法
  const variant: BlueprintDetailLevel =
    typeof options === 'string' ? options : options.variant;
  const contentGate =
    typeof options === 'string' ? undefined : options.contentGate;

  /** 评估内容门（mode = off / 未配置时返回 undefined） */
  const evaluateGate = (fullContent: string): ContentGateReport | undefined => {
    if (!contentGate) return undefined;
    return evaluateContentGate(fullContent, contentGate.page, contentGate.spec, contentGate.mode);
  };
  return defineTool({
    name: 'write_page',
    description: `将 Wiki 页面内容写入指定文件路径。按照章节组织目录结构。
输出路径: .zread-pi/wiki/${variant}/{file}`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: '页面 slug（如 "1-project-overview"）',
        },
        file: {
          type: 'string',
          description: '文件名或相对路径，如 "1-project-overview.md"',
        },
        section: {
          type: 'string',
          description: '所属章节（如 "入门指南"），用于组织目录结构',
        },
        content: {
          type: 'string',
          description: 'Markdown 格式的页面内容',
        },
        title: {
          type: 'string',
          description: '页面标题（可选，用于 YAML frontmatter）',
        },
      },
      required: ['slug', 'content'],
    },
    isReadOnly: false,
    isConcurrencySafe: false, // Write operation needs exclusive access
    async call(input: ToolInputParams, context: ToolContext): Promise<PageToolResult> {
      const slug = getRequiredString(input, 'slug');
      const content = getRequiredString(input, 'content');
      const title = getString(input, 'title');
      const file = getString(input, 'file');
      const section = getString(input, 'section');

      // Build output path based on file and section
      // Priority: file parameter (with section if needed) > slug fallback
      const filePath = resolvePageOutputPath(context.cwd, { file, section, slug }, { variant });

      // Build YAML frontmatter
      const frontmatter = buildPageFrontmatter(title, slug);

      const fullContent = frontmatter + content;
      // 语法校验（分类型）在前、题注校验在后：语法错误的文案更可操作，
      // 让模型先修语法；两者都走同一条 is_error 拦截 + 预算耗尽降级路径。
      const mermaidIssues = [
        ...validateMermaidContent(fullContent),
        ...validateDiagramCaptions(fullContent),
      ];
      if (mermaidIssues.length > 0) {
        return {
          data: JSON.stringify({
            success: false,
            error: formatMermaidValidationError(mermaidIssues),
          }),
          is_error: true,
        };
      }

      // 内容门（quality.contentGate）：在 Mermaid 校验之后、落盘之前。
      // enforce 未通过 → is_error + 常驻反馈（当前 N / 下限 M），模型在预算内重写；
      // warn / 通过 → 继续落盘，报告塞进结果 JSON 供 generate-wiki 提取。
      const gate = evaluateGate(fullContent);
      if (gate && !gate.passed && gate.mode === 'enforce') {
        return {
          data: JSON.stringify({
            success: false,
            error: formatContentGateError(gate),
            gate,
          }),
          is_error: true,
        };
      }

      // Write file
      try {
        await ensureDir(dirname(filePath));
        await writeTextFile(filePath, fullContent);

        return JSON.stringify({
          success: true,
          path: filePath,
          slug,
          section: section || '未分类',
          size: fullContent.length,
          // 内容门报告（warn / 通过时携带；off 时不存在该字段）
          ...(gate ? { gate } : {}),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          data: JSON.stringify({
            success: false,
            error: message,
          }),
          is_error: true,
        };
      }
    },
  });
}
