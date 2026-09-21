/**
 * Mermaid 分类型校验 + 题注校验 —— 纯函数验证
 *
 * 覆盖 L4 校验层（flowchart / sequence / state 三类语法的 FAIL 规则）与
 * L2 题注层（题注存在性 + 题注类型 ↔ 实际语法一致性）。
 *
 * 规则边界用真实的 mermaid 12 探针标定过（tools/probe-mermaid.ts 探针结论）：
 * 只把 mermaid 判为 parse error 的构造判 FAIL；mermaid 容忍但本仓库
 * 要求的 grounding 纪律（如 Note 参与者必须出现过）单列规则。
 *
 * 运行：bun run packages/orchestrator/test/mermaid-validation.ts
 */

import {
  validateMermaidContent,
  validateDiagramCaptions,
  formatMermaidValidationError,
} from '../src/tools/page-tools.js';
import { detectMermaidSyntax } from '../src/wiki/mermaid-syntax.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 把问题列表压成 `rule` 集合，方便断言「命中了哪条规则」 */
function rules(issues: ReturnType<typeof validateMermaidContent>): string[] {
  return [...new Set(issues.map((issue) => issue.rule))].sort();
}

// ==================== A. 语法类型检测 ====================

console.log('\n▶ A. detectMermaidSyntax（三类语法承载四类语义）');

{
  check('flowchart → flowchart', detectMermaidSyntax('flowchart TB\nA-->B') === 'flowchart');
  check('graph 别名 → flowchart（架构 / 流程同语法）', detectMermaidSyntax('graph LR\nA-->B') === 'flowchart');
  check('flowchart TD（流程图）→ flowchart', detectMermaidSyntax('flowchart TD\nA-->B') === 'flowchart');
  check('sequenceDiagram → sequence', detectMermaidSyntax('sequenceDiagram\nA->>B: x') === 'sequence');
  check('stateDiagram-v2 → state', detectMermaidSyntax('stateDiagram-v2\n[*] --> Idle') === 'state');
  check('stateDiagram（v1）→ state', detectMermaidSyntax('stateDiagram\n[*] --> Idle') === 'state');
  check('erDiagram → unknown（四类之外不校验）', detectMermaidSyntax('erDiagram\nA||--o{B: has') === 'unknown');
  check('前置 %% 注释不干扰类型判定', detectMermaidSyntax('%% 注释\nflowchart TB\nA-->B') === 'flowchart');
  check('空块 → unknown', detectMermaidSyntax('\n\n') === 'unknown');
}

// ==================== B. flowchart（既有规则不变） ====================

console.log('\n▶ B. flowchart 节点标签引号（既有规则）');

{
  const valid = ['```mermaid', 'flowchart TB', '  A["用户(输入)"] --> B["结果"]', '```'].join('\n');
  check('合法引号标签 → 无问题', validateMermaidContent(valid).length === 0, JSON.stringify(validateMermaidContent(valid)));

  const bad = ['```mermaid', 'flowchart TB', '  A[用户(输入)] --> B[结果]', '```'].join('\n');
  const issues = validateMermaidContent(bad);
  check('标签含括号未加引号 → FLOW_LABEL_QUOTES', rules(issues).includes('FLOW_LABEL_QUOTES'), JSON.stringify(issues));
  check('问题带 block / line 坐标', issues.length === 1 && issues[0].block === 1 && issues[0].line === 3, JSON.stringify(issues[0]));
  check('错误文案含节点名与正确写法', formatMermaidValidationError(issues).includes('A['));
}

// ==================== C. sequence（序列图） ====================

console.log('\n▶ C. sequence 校验');

{
  const valid = [
    '```mermaid',
    'sequenceDiagram',
    '  participant Entry as "入口"',
    '  participant Core as "核心"',
    '  Entry->>Core: 处理请求',
    '  Core-->>Entry: 返回结果',
    '  Note over Entry,Core: 调用链说明',
    '```',
  ].join('\n');
  check('合法序列图 → 无问题', validateMermaidContent(valid).length === 0, JSON.stringify(validateMermaidContent(valid)));

  const bare = ['```mermaid', 'sequenceDiagram', '  participant', '  A->>B: x', '```'].join('\n');
  check('participant 后无名字 → SEQ_PARTICIPANT_EMPTY', rules(validateMermaidContent(bare)).includes('SEQ_PARTICIPANT_EMPTY'));

  const arrowBack = ['```mermaid', 'sequenceDiagram', '  Alice<-Bob: Hi', '```'].join('\n');
  check('反向箭头 <- → SEQ_ARROW_INVALID', rules(validateMermaidContent(arrowBack)).includes('SEQ_ARROW_INVALID'));

  const arrowEq = ['```mermaid', 'sequenceDiagram', '  Alice==>Bob: Hi', '```'].join('\n');
  check('==> 箭头 → SEQ_ARROW_INVALID', rules(validateMermaidContent(arrowEq)).includes('SEQ_ARROW_INVALID'));

  const arrowUnicode = ['```mermaid', 'sequenceDiagram', '  Alice→Bob: Hi', '```'].join('\n');
  check('Unicode 箭头 → → SEQ_ARROW_INVALID', rules(validateMermaidContent(arrowUnicode)).includes('SEQ_ARROW_INVALID'));

  const validArrow = ['```mermaid', 'sequenceDiagram', '  Alice-->>Bob: Hi', '  Alice-xBob: Bye', '  Alice-)Bob: async', '```'].join('\n');
  check('-->> / -x / -) 合法箭头不误杀', validateMermaidContent(validArrow).length === 0, JSON.stringify(validateMermaidContent(validArrow)));

  const displayParen = ['```mermaid', 'sequenceDiagram', '  participant A as 网关(入口)', '  A->>B: x', '```'].join('\n');
  check('显示名含括号未加引号 → SEQ_LABEL_QUOTES', rules(validateMermaidContent(displayParen)).includes('SEQ_LABEL_QUOTES'));

  const displayQuoted = ['```mermaid', 'sequenceDiagram', '  participant A as "网关(入口)"', '  A->>B: x', '```'].join('\n');
  check('显示名加引号 → 无问题', validateMermaidContent(displayQuoted).length === 0, JSON.stringify(validateMermaidContent(displayQuoted)));

  const noteUnknown = ['```mermaid', 'sequenceDiagram', '  Alice->>Bob: Hi', '  Note over Alice,Ghost: 说明', '```'].join('\n');
  check('Note 引用未出现的参与者 → SEQ_NOTE_UNKNOWN_PARTICIPANT', rules(validateMermaidContent(noteUnknown)).includes('SEQ_NOTE_UNKNOWN_PARTICIPANT'));

  const noteForward = ['```mermaid', 'sequenceDiagram', '  Note over Alice,Bob: 先出现', '  Alice->>Bob: Hi', '```'].join('\n');
  check('Note 在消息之前引用参与者 → 不报（两遍收集，允许乱序）', validateMermaidContent(noteForward).length === 0, JSON.stringify(validateMermaidContent(noteForward)));

  const noteNoColon = ['```mermaid', 'sequenceDiagram', '  Alice->>Bob: Hi', '  Note over Alice,Bob', '```'].join('\n');
  check('Note 缺少 : 文本 → SEQ_NOTE_SYNTAX', rules(validateMermaidContent(noteNoColon)).includes('SEQ_NOTE_SYNTAX'));

  const cjkId = ['```mermaid', 'sequenceDiagram', '  participant 网关 as "网关"', '  网关->>核心: 请求', '```'].join('\n');
  check('CJK 参与者名不误杀', validateMermaidContent(cjkId).length === 0, JSON.stringify(validateMermaidContent(cjkId)));
}

// ==================== D. state（状态图） ====================

console.log('\n▶ D. state 校验');

{
  const valid = [
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  Idle --> Running : 启动',
    '  Running --> [*] : 停止',
    '  note left of Idle : 说明',
    '```',
  ].join('\n');
  check('合法状态图 → 无问题', validateMermaidContent(valid).length === 0, JSON.stringify(validateMermaidContent(valid)));

  const singleDash = ['```mermaid', 'stateDiagram-v2', '  [*] -> Idle', '```'].join('\n');
  check('单箭头 -> → STATE_ARROW_INVALID', rules(validateMermaidContent(singleDash)).includes('STATE_ARROW_INVALID'));

  const backArrow = ['```mermaid', 'stateDiagram-v2', '  [*] --> Idle', '  Idle <- [*]', '```'].join('\n');
  check('反向箭头 <- → STATE_ARROW_INVALID', rules(validateMermaidContent(backArrow)).includes('STATE_ARROW_INVALID'));

  const unquotedLabel = ['```mermaid', 'stateDiagram-v2', '  [*] --> Idle', '  state Engine Idle as Idle', '```'].join('\n');
  check('state 标签未加引号 → STATE_LABEL_QUOTES', rules(validateMermaidContent(unquotedLabel)).includes('STATE_LABEL_QUOTES'));

  const quotedLabel = ['```mermaid', 'stateDiagram-v2', '  [*] --> Idle', '  state "Engine Idle" as Idle', '```'].join('\n');
  check('state 加引号标签 → 无问题', validateMermaidContent(quotedLabel).length === 0, JSON.stringify(validateMermaidContent(quotedLabel)));

  const noteNoColon = ['```mermaid', 'stateDiagram-v2', '  [*] --> Idle', '  note left of Idle', '```'].join('\n');
  check('note 缺 : 文本 → STATE_NOTE_SYNTAX', rules(validateMermaidContent(noteNoColon)).includes('STATE_NOTE_SYNTAX'));

  const noteMultiline = [
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  note left of Idle',
    '    多行说明',
    '  end note',
    '```',
  ].join('\n');
  check('多行 note（end note 收尾）→ 无问题', validateMermaidContent(noteMultiline).length === 0, JSON.stringify(validateMermaidContent(noteMultiline)));

  const composite = ['```mermaid', 'stateDiagram-v2', '  [*] --> First', '  state First {', '    [*] --> Second', '  }', '  First --> [*]', '```'].join('\n');
  check('复合状态块（state First { ... }）不误杀', validateMermaidContent(composite).length === 0, JSON.stringify(validateMermaidContent(composite)));

  const direction = ['```mermaid', 'stateDiagram-v2', '  direction TB', '  [*] --> Idle', '```'].join('\n');
  check('direction 声明行不误杀', validateMermaidContent(direction).length === 0, JSON.stringify(validateMermaidContent(direction)));
}

// ==================== E. 其他图种不校验 ====================

console.log('\n▶ E. 四类之外的图种不校验');

{
  const er = ['```mermaid', 'erDiagram', '  CUSTOMER ||--o{ ORDER : places', '```'].join('\n');
  check('erDiagram 不产生语法问题', validateMermaidContent(er).length === 0);
}

// ==================== F. 题注层（L2） ====================

console.log('\n▶ F. 题注校验（write_page 生成期强制，verify 不查）');

{
  const withCaption = [
    '**图｜架构图｜模块依赖关系**：核心模块与依赖',
    '',
    '```mermaid',
    'flowchart TB',
    '  A["核心"] --> B["依赖"]',
    '```',
  ].join('\n');
  check('架构图 + 正确题注 → 无问题', validateDiagramCaptions(withCaption).length === 0, JSON.stringify(validateDiagramCaptions(withCaption)));

  const noCaption = ['正文。', '', '```mermaid', 'flowchart TB', '  A["核心"]', '```'].join('\n');
  check('图上方无题注 → CAPTION_MISSING', rules(validateDiagramCaptions(noCaption)).includes('CAPTION_MISSING'));

  const badShape = ['**模块依赖关系**', '', '```mermaid', 'flowchart TB', '  A["核心"]', '```'].join('\n');
  const shapeIssues = validateDiagramCaptions(badShape);
  check('题注缺类型词 → CAPTION_MISSING', rules(shapeIssues).includes('CAPTION_MISSING'), JSON.stringify(shapeIssues));

  const mismatch = [
    '**图｜序列图｜登录鉴权调用链**：网关 → 鉴权',
    '',
    '```mermaid',
    'flowchart TB',
    '  A["网关"] --> B["鉴权"]',
    '```',
  ].join('\n');
  check('题注写序列图却画 flowchart → CAPTION_TYPE_MISMATCH', rules(validateDiagramCaptions(mismatch)).includes('CAPTION_TYPE_MISMATCH'));

  const okEn = [
    '**Figure｜Sequence Diagram｜Auth flow**：gateway → auth',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: x',
    '```',
  ].join('\n');
  check('英文题注 + sequence → 无问题', validateDiagramCaptions(okEn).length === 0, JSON.stringify(validateDiagramCaptions(okEn)));

  const enMismatch = [
    '**Figure｜Architecture Diagram｜Auth flow**：gateway → auth',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: x',
    '```',
  ].join('\n');
  check('英文题注类型不一致 → CAPTION_TYPE_MISMATCH', rules(validateDiagramCaptions(enMismatch)).includes('CAPTION_TYPE_MISMATCH'));

  const adjacent = ['**图｜架构图｜紧贴图**：依赖', '```mermaid', 'flowchart TB', '  A["核心"]', '```'].join('\n');
  check('题注与 fence 之间无空行也合法', validateDiagramCaptions(adjacent).length === 0, JSON.stringify(validateDiagramCaptions(adjacent)));

  const unknownKind = ['**图｜ER 关系图**：表关系', '', '```mermaid', 'erDiagram', '  A ||--o{ B : has', '```'].join('\n');
  check('未知图种只要求题注形状，不校对类型词', validateDiagramCaptions(unknownKind).length === 0, JSON.stringify(validateDiagramCaptions(unknownKind)));

  const seqCaptionOk = [
    '**图｜时序图｜调用链**：A → B',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: x',
    '```',
  ].join('\n');
  check('「时序图」作为序列图类型词被接受', validateDiagramCaptions(seqCaptionOk).length === 0);

  // 语法问题与题注问题可共存（write_page 合并两者，语法在前）
  const both = ['正文', '', '```mermaid', 'flowchart TB', '  A[用户(输入)]', '```'].join('\n');
  const allIssues = [...validateMermaidContent(both), ...validateDiagramCaptions(both)];
  check('语法 + 题注问题可共存', allIssues.length === 2 && rules(allIssues).includes('FLOW_LABEL_QUOTES') && rules(allIssues).includes('CAPTION_MISSING'), JSON.stringify(rules(allIssues)));
  const text = formatMermaidValidationError(allIssues);
  check('合并错误文案含两类规则', text.includes('FLOW_LABEL_QUOTES') && text.includes('CAPTION_MISSING'));
  check('错误文案含题注格式示例', text.includes('**图｜'));
}

// ==================== 汇总 ====================

console.log('');
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.log(`❌ ${failed.length} 项失败：`);
  for (const c of failed) console.log(`  - ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  process.exitCode = 1;
}
console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);
