/**
 * Mermaid 语法类型检测 —— 纯函数
 *
 * 设计依据（L0 语法层）：Mermaid 里**架构图与流程图是同一种语法**
 * （都是 `flowchart`/`graph`，仅方向不同），无法机械区分。因此校验 / 计数
 * 按**三类语法**做，选型按**四类语义**教（见 `prompts/diagram-guide.*.md`）：
 *
 * | 语义   | 语法             | 回答的读者问题       | grounding 单位        |
 * |--------|------------------|----------------------|-----------------------|
 * | 架构图 | flowchart TB/BT  | 模块边界、分层、依赖 | 目录 / 包 / 模块      |
 * | 流程图 | flowchart TD/LR  | 单过程控制流         | 函数内控制流          |
 * | 序列图 | sequenceDiagram  | 跨模块调用时序       | 跨函数调用关系        |
 * | 状态图 | stateDiagram-v2  | 实体生命周期与迁移   | 状态变量 + 迁移触发点 |
 *
 * 消费方：`tools/page-tools.ts`（分类型校验分发）与 `wiki/content-gate.ts`
 * （分类型计数）。两者共用同一份首行判定，避免 drift。
 */

/** 三类语法（四类语义里的架构 / 流程同为 flowchart） */
export type MermaidSyntax = 'flowchart' | 'sequence' | 'state';

/**
 * 围栏内首个有意义的行（跳过空行与 `%%` 注释）。
 *
 * 图类型由**首行**决定：mermaid 的图种声明必须在第一行（前面只允许 `%%` 注释）。
 */
function firstMeaningfulLine(code: string): string | undefined {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('%%')) continue;
    return line;
  }
  return undefined;
}

/**
 * 按 fence 首行判定 Mermaid 语法类型。
 *
 * - `graph` / `flowchart` → `flowchart`（架构图与流程图共用此语法）
 * - `sequenceDiagram` → `sequence`
 * - `stateDiagram` / `stateDiagram-v2` → `state`
 * - 其余图种（erDiagram / gantt / pie / classDiagram …）与空块 → `unknown`
 *   （四类之外不做校验、不计入三类计数）
 */
export function detectMermaidSyntax(code: string): MermaidSyntax | 'unknown' {
  const header = firstMeaningfulLine(code);
  if (!header) return 'unknown';
  if (/^(?:graph|flowchart)\b/i.test(header)) return 'flowchart';
  if (/^sequenceDiagram\b/i.test(header)) return 'sequence';
  if (/^stateDiagram(?:-v2)?\b/i.test(header)) return 'state';
  return 'unknown';
}
