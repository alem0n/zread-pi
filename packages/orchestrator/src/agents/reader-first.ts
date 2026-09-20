/**
 * 读者优先写作纪律（reader-first）—— 「教会了读者」
 *
 * 来源：`prompts/reader-first.zh.md`（移植自 lecture-to-notes 的
 * `references/reader-first-writing.md`，先逐条复制再做「代码 wiki」语境兼容改写）
 *       `prompts/reader-first.en.md`（同等翻译）
 * 条目逐条对应，改写理由见各条目行内注释。
 *
 * 与 humanizer 的分工（重要决策）：
 * - humanizer = 「像人写的」（反 AI 腔，`style-discipline.ts`）；
 * - reader-first = 「教会了读者」（本模块）。
 * 两者正交，本块拼在 humanizer **之后**。
 *
 * 拼装点：`create-agent.ts`（页面 / 蓝图 Agent 的系统提示，在 humanizer 之后）
 * 与 `buildPolishSystemPrompt()`（polish Agent 的系统提示末尾自检清单）。
 */
import readerFirstEn from '../prompts/reader-first.en.md' with { type: 'text' }
import readerFirstZh from '../prompts/reader-first.zh.md' with { type: 'text' }

/** 文档语言（与 config.doc_language 的取值一致；`en` 之外一律按中文处理） */
export type ReaderLanguage = 'zh' | 'en'

/** 读者优先纪律注入块标签（与 `<writing_discipline>` 同风格的 XML 包裹） */
export const READER_FIRST_TAG = 'reader_first'

/** 按 doc_language 选择纪律文本（en → 英文版，其余 → 中文版） */
export function getReaderDiscipline(language: string | null | undefined): string {
  return language === 'en' ? readerFirstEn : readerFirstZh
}

/** 读者优先纪律注入块（含包裹标签） */
export function formatReaderDiscipline(language: string | null | undefined): string {
  return `\n\n<${READER_FIRST_TAG}>\n\n${getReaderDiscipline(language).trim()}\n</${READER_FIRST_TAG}>\n`
}

/**
 * 「系统提示 + 读者优先纪律」：`create-agent.ts` 的拼装点，排在 humanizer 之后。
 * `enabled = false` 时原样返回（与 `withStyleDiscipline` 同开关，共用 `polish.enabled`）。
 */
export function withReaderDiscipline(
  systemPrompt: string,
  language: string | null | undefined,
  enabled = true,
): string {
  return enabled ? `${systemPrompt}${formatReaderDiscipline(language)}` : systemPrompt
}

/**
 * polish Agent 的读者优先自检段：纪律全文的第 8 节「分遍修订」压缩为一次
 * 结构化自检 + 最终清单（见 `wiki/polish.ts` 的 `buildPolishSystemPrompt`）。
 */
export const READER_SELF_CHECK = `## 读者优先自检（单遍结构化）
按下列顺序逐项检查，只在**确实改善含义、逻辑、重点或可读性**时改动：
1. 结构：先验概念在依赖它的内容之前；每节只回答一个问题。
2. 论证：每段一件事；证据后面跟着含义。
3. 事实边界：代码事实与本文的整理保持可区分（不把实现写成设计意图）。
4. 术语：每个术语只用读者语言定义一次，之后一致使用。
5. 句式：去掉口语碎屑、模糊主语、从句堆叠、机械对比、重复段式。
6. 证据：复查每个函数名、参数、行号与因果陈述（用 read 回看源码确认）。
7. 渲染读：从头通读最终落盘的页面，而不是只看改动片段。
最后用最终清单自问：初读者读完开头能说出本页中心问题吗？密度门加的是
教学内容，还是散文 / 图表填充？结尾解释了价值与边界吗？`
