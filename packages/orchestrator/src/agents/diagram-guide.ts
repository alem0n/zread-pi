/**
 * 图表选型与题注纪律 —— 「该画哪类图、画前读什么、题注怎么写」
 *
 * 来源：`prompts/diagram-guide.zh.md`（中文源）
 *       `prompts/diagram-guide.en.md`（同等翻译）
 *
 * 与 page-format 的**分工**（避免两处规定打架）：
 * - page-format 只保留「必须用 Mermaid + 节点引号规则 + 拓扑或 0」；
 * - 本块负责**选型逻辑**（四类语义决策表）、grounding 要求、题注格式。
 *
 * 拼装点：`buildPagePrompt()`（generate-wiki.ts），拼在 `<page_format>` 之后、
 * 任务元数据之前——先定格式，再定选型，最后才给任务。
 */
import diagramGuideEn from '../prompts/diagram-guide.en.md' with { type: 'text' }
import diagramGuideZh from '../prompts/diagram-guide.zh.md' with { type: 'text' }

/** 文档语言（与 config.doc_language 的取值一致；`en` 之外一律按中文处理） */
export type DiagramGuideLanguage = 'zh' | 'en'

/** 图表纪律注入块标签（与 `<page_format>` 同风格的 XML 包裹） */
export const DIAGRAM_GUIDE_TAG = 'diagram_guide'

/** 按 doc_language 选择图表纪律文本（en → 英文版，其余 → 中文版） */
export function getDiagramGuide(language: string | null | undefined): string {
  return language === 'en' ? diagramGuideEn : diagramGuideZh
}

/** 图表纪律注入块（含包裹标签） */
export function formatDiagramGuide(language: string | null | undefined): string {
  return `\n<${DIAGRAM_GUIDE_TAG}>\n\n${getDiagramGuide(language).trim()}\n</${DIAGRAM_GUIDE_TAG}>\n`
}

/**
 * 「页面提示词 + 图表纪律」：`buildPagePrompt()` 的拼装点，在 page-format 之后。
 *
 * 始终注入（与 page-format 同为硬约束，不受 `polish.enabled` 影响）。
 */
export function withDiagramGuide(
  prompt: string,
  language: string | null | undefined,
): string {
  return `${prompt}\n${formatDiagramGuide(language)}`
}
