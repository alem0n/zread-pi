/**
 * 文风纪律（humanizer）—— 第 1 层预防 + polish Agent 的系统提示
 *
 * 来源：`prompts/humanizer.en.md`（blader/humanizer SKILL.md v3.0.0，MIT）
 *       `prompts/humanizer.zh.md`（humanizer-zh，翻译自 blader/humanizer）
 * 精炼方式与裁剪理由见 MIGRATION.md §15。
 *
 * 两层用法：
 * - 预防层（`polish.enabled = true`，默认）：`withStyleDiscipline()` 把纪律块拼进蓝图 /
 *   页面 Agent 的系统提示，排在 `<project_context>` 之后（见 agents/create-agent.ts）；
 * - 兜底层（`polish.mode = 'full'`）：`buildPolishSystemPrompt()` 生成 polish Agent 的
 *   系统提示 = 同一份纪律 + Embedded mode 输出约定（见 wiki/polish.ts）。
 */
import humanizerEn from '../prompts/humanizer.en.md' with { type: 'text' }
import humanizerZh from '../prompts/humanizer.zh.md' with { type: 'text' }

/** 文档语言（与 config.doc_language 的取值一致；`en` 之外一律按中文处理） */
export type StyleLanguage = 'zh' | 'en'

/** 纪律注入块标签（与 `<project_context>` 同风格的 XML 包裹） */
export const STYLE_DISCIPLINE_TAG = 'writing_discipline'

/** 按 doc_language 选择纪律文本（en → humanizer，其余 → humanizer-zh） */
export function getStyleDiscipline(language: string | null | undefined): string {
  return language === 'en' ? humanizerEn : humanizerZh
}

/** 纪律注入块（含包裹标签，前面留空行便于拼接） */
export function formatStyleDiscipline(language: string | null | undefined): string {
  return `\n\n<${STYLE_DISCIPLINE_TAG}>\n\n${getStyleDiscipline(language).trim()}\n</${STYLE_DISCIPLINE_TAG}>\n`
}

/**
 * 「基础系统提示 + 文风纪律」：create-agent.ts 的拼接点。
 * `enabled = false`（`polish.enabled = false`）时原样返回，完全关闭预防层。
 */
export function withStyleDiscipline(
  systemPrompt: string,
  language: string | null | undefined,
  enabled = true,
): string {
  return enabled ? `${systemPrompt}${formatStyleDiscipline(language)}` : systemPrompt
}

/**
 * polish Agent 的 Embedded mode 约定。
 *
 * humanizer skill 的 Embedded mode 定义是「只回最终文本」；这里把交付物替换为文件本身：
 * Agent 用 Read / Edit 就地润色，不输出解释或修改清单，最终回复只允许一行状态词，
 * 避免把「润色报告」当成文档内容写进页面（也避免调用方把它的输出误当产物）。
 */
export const POLISH_EMBEDDED_MODE = `## Embedded mode（本 Agent 的输出约定）
你在另一个任务内部运行，唯一的交付物是被润色的文件本身：
1. 先用 Read 读取目标文件，再用 Edit 就地修改；不要新建文件，不要调用其它写工具。
2. 只改散文。代码块、行内代码、\`Sources:\` 溯源行、YAML frontmatter、Mermaid 语法
   与链接目标一律原样保留（见上文「绝对不许动」）。
3. 不缩小信息量：不删事实、不删溯源、不删图表、不删章节。
4. 最终回复只允许一行：\`POLISHED\` 或 \`NO_CHANGE\`。不要输出解释、总结或修改清单。
   没有把握在事实范围内改进时，回 \`NO_CHANGE\`，不要为「有改动」而改写。`

/** polish Agent 的系统提示：纪律全文 + Embedded mode 输出约定 */
export function buildPolishSystemPrompt(language: string | null | undefined): string {
  return `${getStyleDiscipline(language).trim()}\n\n${POLISH_EMBEDDED_MODE}\n`
}

/** polish Agent 的任务提示（文件路径由调用方传入，避免模型自己猜路径） */
export function buildPolishTaskPrompt(options: {
  filePath: string
  slug: string
  title?: string
}): string {
  const titleLine = options.title ? `\n- 页面标题：${options.title}` : ''
  return `请润色以下 wiki 页面文件（保留全部事实、溯源、代码与图表结构）：

- 文件路径：${options.filePath}
- 页面 slug：${options.slug}${titleLine}

按系统提示里的文风纪律执行：先 Read，再用 Edit 就地修改，最后只回一行状态词。`
}
