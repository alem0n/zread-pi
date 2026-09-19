/**
 * 页面格式契约 —— 与叙述语气无关的硬性格式约束
 *
 * 来源：`prompts/page-format.zh.md`（从 `prompts/page-agent.ts` 抽出的硬性格式契约：
 * frontmatter 注入 / 标题层级 / Mermaid 引号 / 溯源格式 / 交付前自检清单）
 *       `prompts/page-format.en.md`（同等翻译）
 * 语境改写与条目对应见 MIGRATION.md §32.1（plan.md §3.4.1）。
 *
 * 与 humanizer（反 AI 腔）/ reader-first（教会读者）**正交**：
 * 这里只规定「格式必须成立」，不规定「怎么写得好读」。
 *
 * 拼装点：`buildPagePrompt()`（generate-wiki.ts），拼在页面叙述提示词之后、
 * 任务元数据之前——格式契约靠前，模型在动笔前先读到。
 */
import pageFormatEn from '../prompts/page-format.en.md' with { type: 'text' }
import pageFormatZh from '../prompts/page-format.zh.md' with { type: 'text' }

/** 文档语言（与 config.doc_language 的取值一致；`en` 之外一律按中文处理） */
export type FormatLanguage = 'zh' | 'en'

/** 格式契约注入块标签（与 `<writing_discipline>` 同风格的 XML 包裹） */
export const PAGE_FORMAT_TAG = 'page_format'

/** 按 doc_language 选择格式契约文本（en → 英文版，其余 → 中文版） */
export function getPageFormat(language: string | null | undefined): string {
  return language === 'en' ? pageFormatEn : pageFormatZh
}

/** 格式契约注入块（含包裹标签） */
export function formatPageFormat(language: string | null | undefined): string {
  return `\n<${PAGE_FORMAT_TAG}>\n\n${getPageFormat(language).trim()}\n</${PAGE_FORMAT_TAG}>\n`
}

/**
 * 「页面提示词 + 格式契约」：`buildPagePrompt()` 的拼装点。
 *
 * 格式契约**始终注入**（它是硬约束，不受 `polish.enabled` 影响）。
 */
export function withPageFormat(
  prompt: string,
  language: string | null | undefined,
): string {
  return `${prompt}\n${formatPageFormat(language)}`
}
