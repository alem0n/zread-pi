/**
 * Output Tools - Generate and save wiki.json blueprint
 *
 * 三阶段蓝图（分类 → 分主题 → 标题）的文件输出工具：
 * - `submit_sections`：分类阶段写骨架 / 合并分类（sync）；
 * - `submit_section_topics`：主题阶段按分类增量归并页面（slug/file 由代码分配）；
 * - `refine_section_titles`：标题阶段批量写回 title；
 * - `submit_condensed_sections` / `submit_condensed_topics`：缩编 subagent 的一次性输出工具
 *   （只捕获结果，不落盘；落盘由阶段驱动器统一走 merge 函数）。
 *
 * 数量控制（blueprint.detail，见 agents/blueprint-detail.ts）：
 * 每次提交都带「数量反馈」；越界提交**不落盘、不报错**，返回归并 / 补充策略文本请求重提；
 * 连续两次不收敛后标记 `state.exhausted`，由阶段驱动器开缩编 subagent 或代码兜底。
 *
 * `generate_blueprint` / `generate_sync_blueprint` / `validate_blueprint` 是旧版工具，
 * 保留仅归档（当前流程不再使用；提示词与测试均不引用）。
 * 存在性校验已迁移到交付闸门 `verify-wiki` 的页面维度（wiki/traceability.ts
 * 的 `checkAssociatedFiles`）。
 */

import type { ToolDefinition, ToolInputParams, ToolInputSchemaProperty, ToolContext, ToolResult } from '@zread-pi/agent-runtime'
import type { ApplyTitlesResult } from '@zread-pi/utils'
import {
  applySectionTitles,
  generateWikiJson,
  initWikiSkeleton,
  loadConfig,
  loadWikiBlueprint,
  mergeBlueprintSections,
  mergeSectionTopics,
  mergeWikiSections,
  normalizeBlueprintSections,
  normalizeSectionList,
} from '@zread-pi/utils'
import type { BlueprintDetailLevel, WikiPage, WikiSection, WikiTopic } from '@zread-pi/types'
import {
  MAX_QUANTITY_FEEDBACK_ROUNDS,
  QUANTITY_FALLBACK_NOTE,
  buildSectionQuantityStrategy,
  buildTopicsQuantityStrategy,
  formatQuantityFeedback,
  getDetailSpec,
  judgeQuantity,
  type BlueprintDetailSpec,
  type QuantityToolState,
  type QuantityVerdict,
} from '../agents/blueprint-detail.js'
import type { TechStackSummary } from '../types.js'

/** 统一的 tool_result 构造 */
function okResult(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content }
}

function failResult(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: '', content, is_error: true }
}

/** 分类条目 schema（submit_sections 与缩编工具共用） */
const SECTION_ITEM_SCHEMA: ToolInputSchemaProperty = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '分类标题（简洁中文，≤10 字）' },
    description: { type: 'string', description: '分类说明（这个分类覆盖什么、面向哪类读者）' },
    scope: {
      type: 'array',
      items: { type: 'string' },
      description:
        '分类的边界清单：1~3 条「包含：本分类覆盖的功能领域」+ 1~3 条「不包含：明确不覆盖的相邻领域（→ 其他分类）」',
    },
  },
  required: ['title'],
}

/** 主题条目 schema（submit_section_topics 与缩编工具共用） */
const TOPIC_ITEM_SCHEMA: ToolInputSchemaProperty = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '草稿标题（≤20 字）' },
    summary: {
      type: 'string',
      description: '一句话主题摘要（≤40 字，说明这篇论证什么、以哪些文件为证据）',
    },
    slug: { type: 'string', description: '英文 kebab-case 短名（用于 URL）' },
    group: { type: 'string', description: '二级模块聚合（可选）' },
    level: { type: 'string', description: '难度等级（Beginner/Intermediate/Advanced）' },
    associatedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '关联的源文件或目录路径（目录以 / 结尾）',
    },
  },
  required: ['title'],
}

function summarizeSections(sections: WikiSection[]): string {
  return sections
    .map((section) => {
      const head = `- ${section.title}${section.description ? `：${section.description}` : ''}`;
      const scope = section.scope?.length ? `\n  scope: ${section.scope.join('；')}` : '';
      return `${head}${scope}`;
    })
    .join('\n')
}

/** 归一化主题输入（仅用于数量统计；实际归并仍由 mergeSectionTopics 处理） */
function normalizeTopicInput(input: unknown): WikiTopic[] {
  if (!Array.isArray(input)) return []
  const result: WikiTopic[] = []
  const seen = new Set<string>()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const topic = entry as WikiTopic
    const title = typeof topic.title === 'string' ? topic.title.trim() : ''
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(topic)
  }
  return result
}

/**
 * 越界提交的统一处理：不落盘、不报错；前 N-1 次返回策略文本，第 N 次标记 exhausted。
 */
function outOfRangeResult(
  state: QuantityToolState<WikiSection[]> | QuantityToolState<WikiTopic[]>,
  kind: 'sections' | 'topics',
  count: number,
  verdict: Exclude<QuantityVerdict, 'ok'>,
  spec: BlueprintDetailSpec,
  options: { sync?: boolean } = {},
): ToolResult {
  state.outOfRange += 1
  state.lastVerdict = verdict

  const feedback = formatQuantityFeedback({ kind, count, spec, upperBoundOnly: options.sync })
  const strategy =
    kind === 'sections'
      ? buildSectionQuantityStrategy(verdict, spec, options)
      : buildTopicsQuantityStrategy(verdict, spec, options)

  if (state.outOfRange < MAX_QUANTITY_FEEDBACK_ROUNDS) {
    return okResult(
      `${feedback}\n\n${strategy}\n\n（本次提交未落盘；请按上述策略调整后重新调用工具提交完整清单。）`,
    )
  }

  state.exhausted = true
  return okResult(
    `${feedback}\n\n（已连续 ${MAX_QUANTITY_FEEDBACK_ROUNDS} 次未收敛，本次提交未落盘；不再要求重提，系统将用缩编 / 代码兜底完成落盘）${QUANTITY_FALLBACK_NOTE}`,
  )
}

/**
 * Submit Sections Tool（分类阶段）
 *
 * 写入 wiki.json 骨架：sections（强制包含概览/核心架构）+ 空 pages。
 * sync 流程传 `merge: true`：保留既有分类与页面，只把新增分类补进 sections。
 *
 * `detail`（蓝图细节档位）控制数量区间；`state` 用于回传越界 / 缩编触发信息。
 */
export function createSubmitSectionsTool(options: {
  merge?: boolean
  detail?: BlueprintDetailLevel
  /** 写盘变体（缺省 = detail） */
  variant?: BlueprintDetailLevel
  state?: QuantityToolState<WikiSection[]>
} = {}): ToolDefinition {
  const merge = options.merge === true
  const variant = options.variant !== undefined ? options.variant : (options.detail ?? 'high')
  const state: QuantityToolState<WikiSection[]> =
    options.state ?? { called: false, persisted: false, outOfRange: 0, exhausted: false }
  const spec = (): BlueprintDetailSpec => getDetailSpec(options.detail ?? 'high')

  return {
    name: 'submit_sections',
    description: merge
      ? '把更新后的 Wiki 顶级分类（section）清单合并进 wiki.json（既有分类与页面保持不变）。'
      : '提交 Wiki 顶级分类（section）清单，写入 wiki.json 骨架（sections + 空 pages）。',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          description: merge
            ? `更新后的顶级分类清单（sync：既有分类必留，新增优先并入既有；总量含既有不超 ${spec().sections.max} 个）`
            : `顶级分类清单（${spec().sections.min}~${spec().sections.max} 个；必须包含概览/核心架构）`,
          items: SECTION_ITEM_SCHEMA,
        },
      },
      required: ['sections'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return merge
        ? 'Merge the updated section list into wiki.json.'
        : 'Write the wiki.json skeleton with sections.'
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      state.called = true
      try {
        const rawSections = normalizeSectionList(input.sections)
        if (rawSections.length === 0) {
          return failResult('错误: sections 数组不能为空')
        }

        const config = await loadConfig()
        const detailSpec = spec()

        // minimal：固定 1 个分类（概览），无归并空间 —— 直接代码收尾
        if (detailSpec.level === 'minimal') {
          const normalized = normalizeBlueprintSections(rawSections, config.doc_language, 1, {
            minimal: true,
          })
          if (merge) {
            await mergeWikiSections(normalized, config, { limit: 1, minimal: true, variant })
          } else {
            await initWikiSkeleton(normalized, config, undefined, { minimal: true, limit: 1, variant })
          }
          state.persisted = true
          state.lastPayload = normalized
          state.lastCount = normalized.length
          const lines = merge
            ? [`分类清单已合并（${normalized.length} 个分类）:`, summarizeSections(normalized)]
            : ['Wiki 骨架已生成（minimal）:', summarizeSections(normalized)]
          return okResult(
            [
              lines.join('\n'),
              formatQuantityFeedback({ kind: 'sections', count: normalized.length, spec: detailSpec }),
              rawSections.length !== 1 ? `minimal 档位只保留「概览」一个分类。${QUANTITY_FALLBACK_NOTE}` : '',
            ]
              .filter((part) => part.length > 0)
              .join('\n\n'),
          )
        }

        if (merge) {
          const current = await loadWikiBlueprint(undefined, variant)
          const mergedCount = mergeBlueprintSections(
            current.sections,
            rawSections,
            config.doc_language,
            Number.MAX_SAFE_INTEGER,
          ).length

          const verdict = judgeQuantity(mergedCount, detailSpec.sections, { enforceMin: false })
          if (verdict !== 'ok') {
            state.lastPayload = rawSections
            state.lastCount = mergedCount
            return outOfRangeResult(state, 'sections', mergedCount, verdict, detailSpec, { sync: true })
          }

          const merged = await mergeWikiSections(rawSections, config, {
            limit: detailSpec.sections.max,
            variant,
          })
          state.persisted = true
          state.lastPayload = rawSections
          state.lastCount = merged.length
          return okResult(
            [
              `分类清单已合并（${merged.length} 个分类）:\n${summarizeSections(merged)}`,
              formatQuantityFeedback({
                kind: 'sections',
                count: merged.length,
                spec: detailSpec,
                upperBoundOnly: true,
              }),
            ].join('\n\n'),
          )
        }

        const normalized = normalizeBlueprintSections(
          rawSections,
          config.doc_language,
          Number.MAX_SAFE_INTEGER,
        )
        const count = normalized.length
        const verdict = judgeQuantity(count, detailSpec.sections)
        if (verdict !== 'ok') {
          state.lastPayload = normalized
          state.lastCount = count
          return outOfRangeResult(state, 'sections', count, verdict, detailSpec)
        }

        const outputPath = await initWikiSkeleton(normalized, config, undefined, {
          limit: detailSpec.sections.max,
          variant,
        })
        state.persisted = true
        state.lastPayload = normalized
        state.lastCount = count
        return okResult(
          [
            `Wiki 骨架已生成: ${outputPath}\n\n分类清单（${count} 个）:\n${summarizeSections(normalized)}`,
            formatQuantityFeedback({ kind: 'sections', count, spec: detailSpec }),
          ].join('\n\n'),
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return failResult(`写入分类清单失败: ${message}`)
      }
    },
  }
}

/** 生成流程使用的单例（写入新骨架，默认 high 档位） */
export const SubmitSectionsTool: ToolDefinition = createSubmitSectionsTool()

/**
 * Submit Section Topics Tool（主题阶段，按分类绑定）
 *
 * `section` 参数在 schema 中保留（模型需要确认自己在给哪个分类规划），
 * 但实际归并一律使用闭包绑定的期望分类——模型写错也不至于整段失败。
 *
 * `detail` 控制每分类文章数量区间；`state` 回传越界 / 缩编触发信息。
 * sync（`reuseExisting: true`）只校验上限：旧页面必须原样带回，不强制补齐下限。
 */
export function createSubmitSectionTopicsTool(
  section: WikiSection,
  options: {
    reuseExisting?: boolean
    detail?: BlueprintDetailLevel
    /** 写盘变体（缺省 = detail） */
    variant?: BlueprintDetailLevel
    state?: QuantityToolState<WikiTopic[]>
  } = {},
): ToolDefinition {
  const sync = options.reuseExisting === true
  const variant = options.variant !== undefined ? options.variant : (options.detail ?? 'high')
  const state: QuantityToolState<WikiTopic[]> =
    options.state ?? { called: false, persisted: false, outOfRange: 0, exhausted: false }
  const spec = (): BlueprintDetailSpec => getDetailSpec(options.detail ?? 'high')

  return {
    name: 'submit_section_topics',
    description: `提交分类「${section.title}」的文章主题（topic）清单；代码统一分配 slug/file 并增量归并进 wiki.json。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: `分类标题（必须为 "${section.title}"）` },
        topics: {
          type: 'array',
          description: sync
            ? `该分类下的文章主题（既有页面必须逐字带回；总量不超 ${spec().topics.max} 篇）`
            : `该分类下的文章主题（${spec().topics.min}~${spec().topics.max} 篇）`,
          items: TOPIC_ITEM_SCHEMA,
        },
      },
      required: ['section', 'topics'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return `Submit page topics for section "${section.title}".`
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      state.called = true
      try {
        const detailSpec = spec()
        const topics = normalizeTopicInput(input.topics)
        const incomingSection = typeof input.section === 'string' ? input.section.trim() : ''
        const mismatch =
          incomingSection && incomingSection.toLowerCase() !== section.title.trim().toLowerCase()
            ? `\n（模型传入的分类 "${incomingSection}" 与预期 "${section.title}" 不一致，已按预期分类归并）`
            : ''

        // minimal：固定 1 篇，无归并空间 —— 取首个主题，直接代码收尾
        if (detailSpec.level === 'minimal') {
          const kept = topics.slice(0, 1)
          const result = await mergeSectionTopics(section, kept, { reuseExisting: options.reuseExisting, variant })
          state.persisted = true
          state.lastPayload = kept
          state.lastCount = kept.length
          return okResult(
            [
              `分类「${result.section}」主题已归并：新增 ${result.added}，复用 ${result.reused}，去重 ${result.duplicated}`,
              `该分类现有 ${result.sectionPages} 篇；wiki.json 总计 ${result.totalPages} 篇${mismatch}`,
              formatQuantityFeedback({ kind: 'topics', count: kept.length, spec: detailSpec }),
              topics.length > 1 ? `minimal 档位每个分类只保留 1 篇。${QUANTITY_FALLBACK_NOTE}` : '',
            ]
              .filter((part) => part.length > 0)
              .join('\n'),
          )
        }

        const count = topics.length
        const verdict = judgeQuantity(count, detailSpec.topics, { enforceMin: !sync })
        if (verdict !== 'ok') {
          state.lastPayload = topics
          state.lastCount = count
          return outOfRangeResult(state, 'topics', count, verdict, detailSpec, { sync })
        }

        const result = await mergeSectionTopics(section, topics, {
          reuseExisting: options.reuseExisting,
          variant,
        })
        state.persisted = true
        state.lastPayload = topics
        state.lastCount = count
        return okResult(
          [
            `分类「${result.section}」主题已归并：新增 ${result.added}，复用 ${result.reused}，去重 ${result.duplicated}`,
            `该分类现有 ${result.sectionPages} 篇；wiki.json 总计 ${result.totalPages} 篇${mismatch}`,
            formatQuantityFeedback({ kind: 'topics', count, spec: detailSpec, upperBoundOnly: sync }),
          ].join('\n'),
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return failResult(`归并主题失败: ${message}`)
      }
    },
  }
}

/** 缩编 subagent 的分类捕获容器 */
export interface CondensedSectionCapture {
  sections?: WikiSection[]
}

/**
 * Submit Condensed Sections Tool（缩编 subagent 用，一次性、只读）
 *
 * 只把缩编结果捕获到内存，不落盘：落盘统一由阶段驱动器走
 * `mergeWikiSections` / `initWikiSkeleton`（文件锁与编号单点）。
 */
export function createSubmitCondensedSectionsTool(
  captured: CondensedSectionCapture,
): ToolDefinition {
  return {
    name: 'submit_condensed_sections',
    description: '提交缩编后的 Wiki 顶级分类清单（只捕获结果，由系统侧统一落盘）。',
    inputSchema: {
      type: 'object',
      properties: {
        sections: { type: 'array', description: '缩编后的顶级分类清单', items: SECTION_ITEM_SCHEMA },
      },
      required: ['sections'],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return 'Submit the condensed section list.'
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      const sections = normalizeSectionList(input.sections)
      if (sections.length === 0) {
        return failResult('错误: sections 数组不能为空')
      }
      captured.sections = sections
      return okResult(`已接收缩编后的分类清单（${sections.length} 个）：\n${summarizeSections(sections)}`)
    },
  }
}

/** 缩编 subagent 的主题捕获容器 */
export interface CondensedTopicCapture {
  topics?: WikiTopic[]
}

/** Submit Condensed Topics Tool（缩编 subagent 用，一次性、只读） */
export function createSubmitCondensedTopicsTool(
  section: WikiSection,
  captured: CondensedTopicCapture,
): ToolDefinition {
  return {
    name: 'submit_condensed_topics',
    description: `提交分类「${section.title}」缩编后的主题清单（只捕获结果，由系统侧统一落盘）。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: `分类标题（必须为 "${section.title}"）` },
        topics: { type: 'array', description: '缩编后的主题清单', items: TOPIC_ITEM_SCHEMA },
      },
      required: ['section', 'topics'],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return `Submit the condensed topics for section "${section.title}".`
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      const topics = normalizeTopicInput(input.topics)
      if (topics.length === 0) {
        return failResult('错误: topics 数组不能为空')
      }
      captured.topics = topics
      return okResult(`已接收分类「${section.title}」缩编后的主题清单（${topics.length} 篇）。`)
    },
  }
}

/**
 * Refine Section Titles Tool（标题阶段，按分类绑定）
 *
 * 只写回 title；slug / file / section 保持不变。
 */
export function createRefineSectionTitlesTool(
  section: WikiSection,
  options: {
    /** 写盘变体 */
    variant: BlueprintDetailLevel
    /**
     * 该分类的页面 slug 清单（由阶段驱动器传入），用于「数量一致性」自检：
     * 模型漏页（缺 slug）或交出陌生 slug 时直接 is_error，不落盘。
     */
    expectedSlugs?: string[]
    /**
     * 写回结果回调（阶段驱动器用它统计「重写率」——诊断信号触发后标题被改写的比例，
     * 用于验证诊断段是否真的起作用）。
     */
    onResult?: (result: ApplyTitlesResult) => void
  },
): ToolDefinition {
  return {
    name: 'refine_section_titles',
    description: `批量写回分类「${section.title}」下所有页面的精修标题（只改 title）。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: `分类标题（必须为 "${section.title}"）` },
        titles: {
          type: 'array',
          description: '该分类下所有页面的 slug + 精修标题',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string', description: '页面 slug（逐字保留，不得改动）' },
              title: { type: 'string', description: '精修后的标题（≤20 字）' },
            },
            required: ['slug', 'title'],
          },
        },
      },
      required: ['section', 'titles'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return `Refine page titles for section "${section.title}".`;
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      try {
        const titles = Array.isArray(input.titles)
          ? (input.titles as unknown as Array<{ slug?: string; title?: string }>)
          : []
        const incomingSection = typeof input.section === 'string' ? input.section.trim() : ''

        // 数量一致性自检（对齐 lecture-to-notes structure-reorder 的两级自检里
        // 「页数不变」那条）：在落盘之前校验，失败直接 is_error、不写盘。
        const expected = options.expectedSlugs ?? []
        if (expected.length > 0) {
          const incomingSlugs = titles
            .map((entry) => (typeof entry?.slug === 'string' ? entry.slug.trim() : ''))
            .filter((slug) => slug.length > 0)
          const unknownSlugs = incomingSlugs.filter((slug) => !expected.includes(slug))
          const missingSlugs = expected.filter((slug) => !incomingSlugs.includes(slug))
          if (unknownSlugs.length > 0 || missingSlugs.length > 0) {
            const parts = [
              ...(unknownSlugs.length > 0 ? [`陌生 slug ${unknownSlugs.length} 个：${unknownSlugs.join(', ')}`] : []),
              ...(missingSlugs.length > 0 ? [`遗漏 slug ${missingSlugs.length} 个：${missingSlugs.join(', ')}`] : []),
            ]
            return {
              type: 'tool_result',
              tool_use_id: '',
              content: `标题数量不一致（期望 ${expected.length} 页）：${parts.join('；')}。请提交该分类下**全部**页面的标题，slug 逐字保留，不得新增或遗漏。`,
              is_error: true,
            }
          }
        }

        const result = await applySectionTitles(section, titles, { variant: options.variant })
        options.onResult?.(result)

        const mismatch =
          incomingSection && incomingSection.toLowerCase() !== section.title.trim().toLowerCase()
            ? `\n（模型传入的分类 "${incomingSection}" 与预期 "${section.title}" 不一致，已按预期分类写回）`
            : ''

        return {
          type: 'tool_result',
          tool_use_id: '',
          content:
            `分类「${section.title}」标题已写回：更新 ${result.updated}，跳过 ${result.skipped}，未知 slug ${result.unknown}${mismatch}`,
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `写回标题失败: ${message}`,
          is_error: true,
        }
      }
    },
  }
}

/**
 * Generate Blueprint Tool（旧版，仅归档）
 *
 * Generates wiki.json blueprint and saves to wiki directory.
 * 三阶段流程改用 `submit_sections` / `submit_section_topics` / `refine_section_titles`。
 */
export const GenerateBlueprintTool: ToolDefinition = {
  name: 'generate_blueprint',
  description: '生成 Wiki 蓝图 JSON 文件，保存到 .zread-pi/wiki 目录。',
  inputSchema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        description: 'Wiki 页面列表',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: '页面 slug（如 1-project-overview）' },
            title: { type: 'string', description: '页面标题（如 项目概览）' },
            file: { type: 'string', description: '文件名（如 1-project-overview.md）' },
            section: { type: 'string', description: '所属章节（如 入门指南）' },
            group: { type: 'string', description: '二级模块聚合（可选，如 平台接入指南）' },
            level: { type: 'string', description: '难度等级（Beginner/Intermediate/Advanced）' },
            associatedFiles: {
              type: 'array',
              items: { type: 'string' },
              description: '关联的源文件或目录路径（目录以 / 结尾）'
            }
          },
          required: ['slug', 'title', 'file', 'section']
        }
      },
      techStackSummary: {
        type: 'object',
        description: '技术栈摘要（可选）'
      },
      coreModules: {
        type: 'object',
        description: '核心模块信息（可选）'
      }
    },
    required: ['pages']
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() {
    return 'Generate and save wiki blueprint JSON file.'
  },
  async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
    try {
      const pages = input.pages as unknown as WikiPage[]
      const techStackSummary = input.techStackSummary as unknown as TechStackSummary | undefined

      // Load config to get language setting
      const config = await loadConfig()

      // Validate pages
      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: '错误: pages 数组不能为空',
          is_error: true
        }
      }

      // Generate and save wiki.json
      const outputPath = await generateWikiJson(pages, config, techStackSummary, config.blueprint.detail)

      // Build result summary
      const groups = [...new Set(pages.map(p => p.group).filter(Boolean))]
      const summary = {
        outputPath,
        pagesCount: pages.length,
        sections: [...new Set(pages.map(p => p.section))],
        groups: groups.length > 0 ? groups : undefined,
        levels: {
          beginner: pages.filter(p => p.level === 'Beginner').length,
          intermediate: pages.filter(p => p.level === 'Intermediate').length,
          advanced: pages.filter(p => p.level === 'Advanced').length
        },
        hasAssociatedFiles: pages.filter(p => p.associatedFiles && p.associatedFiles.length > 0).length
      }

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Wiki 蓝图已生成: ${outputPath}\n\n详情:\n${JSON.stringify(summary, null, 2)}`
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `生成蓝图失败: ${message}`,
        is_error: true
      }
    }
  }
}

/**
 * Validate Blueprint Tool
 *
 * Validates that associatedFiles in pages point to real files or directories.
 */
/**
 * ValidateBlueprintTool（旧版，仅归档）
 *
 * 存在性校验已迁移到交付闸门 `verify-wiki` 的页面维度
 * （`checkAssociatedFiles`，见 wiki/traceability.ts），当前流程不再使用本工具。
 * 保留与 `generate_blueprint` 同策略：提示词与测试均不引用。
 */
export const ValidateBlueprintTool: ToolDefinition = {
  name: 'validate_blueprint',
  description: '验证蓝图中的 associatedFiles 字段指向真实存在的文件或目录。',
  inputSchema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        description: 'Wiki 页面列表'
      },
      projectRoot: {
        type: 'string',
        description: '项目根目录（可选）'
      }
    },
    required: ['pages']
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Validate blueprint associated files/directories exist.'
  },
  async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
    try {
      const pages = input.pages as unknown as WikiPage[]
      const projectRoot = input.projectRoot as unknown as string | undefined
      const { stat, readdir } = await import('fs/promises')
      const { join } = await import('path')
      const { getProjectRoot } = await import('@zread-pi/utils')

      const root = projectRoot || getProjectRoot()

      interface PathInfo {
        path: string
        type: 'file' | 'directory' | 'missing'
        fileCount?: number  // 目录下的文件数
      }

      const validation: {
        validPages: string[]
        invalidPages: { slug: string; missingPaths: string[] }[]
        warnings: string[]
        pathDetails: { slug: string; paths: PathInfo[] }[]
      } = {
        validPages: [],
        invalidPages: [],
        warnings: [],
        pathDetails: []
      }

      for (const page of pages) {
        if (!page.associatedFiles || page.associatedFiles.length === 0) {
          validation.warnings.push(`${page.slug}: 无关联路径`)
          continue
        }

        const missingPaths: string[] = []
        const pathInfos: PathInfo[] = []

        for (const pathStr of page.associatedFiles) {
          const fullPath = join(root, pathStr)
          try {
            const stats = await stat(fullPath)
            if (stats.isDirectory()) {
              // 目录：统计文件数
              const files = await readdir(fullPath, { recursive: true, withFileTypes: true })
              const tsFiles = files.filter(f => f.isFile() && (f.name.endsWith('.ts') || f.name.endsWith('.tsx') || f.name.endsWith('.js')))
              pathInfos.push({
                path: pathStr,
                type: 'directory',
                fileCount: tsFiles.length
              })
            } else {
              // 文件
              pathInfos.push({
                path: pathStr,
                type: 'file'
              })
            }
          } catch {
            missingPaths.push(pathStr)
            pathInfos.push({
              path: pathStr,
              type: 'missing'
            })
          }
        }

        validation.pathDetails.push({
          slug: page.slug,
          paths: pathInfos
        })

        if (missingPaths.length > 0) {
          validation.invalidPages.push({
            slug: page.slug,
            missingPaths
          })
        } else {
          validation.validPages.push(page.slug)
        }
      }

      const isValid = validation.invalidPages.length === 0

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({
          isValid,
          validation,
          summary: {
            totalPages: pages.length,
            validPages: validation.validPages.length,
            invalidPages: validation.invalidPages.length,
            warnings: validation.warnings.length
          }
        }, null, 2)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `验证失败: ${message}`,
        is_error: true
      }
    }
  }
}

/**
 * Generate Sync Blueprint Tool（旧版，仅归档）
 *
 * Generates wiki.json with sync status flags on each page.
 * 三阶段同步改用 `submit_sections`（merge）+ 主题/标题阶段 + 代码侧 SyncDiff 计算。
 */
export const GenerateSyncBlueprintTool: ToolDefinition = {
  name: 'generate_sync_blueprint',
  description: '生成同步后的 Wiki 蓝图 JSON，每页需包含 status 字段（unchanged/new/updated/archived）。',
  inputSchema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        description: 'Wiki 页面列表（每页必须包含 status 字段）',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            file: { type: 'string' },
            section: { type: 'string' },
            group: { type: 'string' },
            level: { type: 'string' },
            associatedFiles: {
              type: 'array',
              items: { type: 'string' }
            },
            status: {
              type: 'string',
              enum: ['unchanged', 'new', 'updated', 'archived'],
              description: '同步状态标记'
            }
          },
          required: ['slug', 'title', 'file', 'section', 'status']
        }
      },
      techStackSummary: {
        type: 'object',
        description: '技术栈摘要（可选，沿用旧值或重新生成）'
      }
    },
    required: ['pages']
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() {
    return 'Generate and save synced wiki blueprint JSON file.'
  },
  async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
    try {
      const pages = input.pages as unknown as (WikiPage & { status?: string })[]
      const techStackSummary = input.techStackSummary as unknown as TechStackSummary | undefined

      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: '错误: pages 数组不能为空',
          is_error: true
        }
      }

      // Separate pages by status
      const statusCounts: Record<string, number> = { unchanged: 0, new: 0, updated: 0, archived: 0 }
      for (const p of pages) {
        const s = p.status || 'unchanged'
        statusCounts[s] = (statusCounts[s] || 0) + 1
      }

      const config = await loadConfig()
      const outputPath = await generateWikiJson(pages as WikiPage[], config, techStackSummary, config.blueprint.detail)

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `同步蓝图已生成: ${outputPath}\n\n变更统计:\n` +
          `- 新增: ${statusCounts.new} 篇\n` +
          `- 更新: ${statusCounts.updated} 篇\n` +
          `- 归档: ${statusCounts.archived} 篇\n` +
          `- 未变更: ${statusCounts.unchanged} 篇\n` +
          `总计: ${pages.length} 篇`
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `生成同步蓝图失败: ${message}`,
        is_error: true
      }
    }
  }
}