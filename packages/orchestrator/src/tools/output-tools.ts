/**
 * Output Tools - Generate and save wiki.json blueprint
 *
 * 三阶段蓝图（分类 → 分主题 → 标题）的文件输出工具：
 * - `submit_sections`：分类阶段写骨架 / 合并分类（sync）；
 * - `submit_section_topics`：主题阶段按分类增量归并页面（slug/file 由代码分配）；
 * - `refine_section_titles`：标题阶段批量写回 title。
 *
 * `generate_blueprint` / `generate_sync_blueprint` 是旧版一次性蓝图的工具，
 * 保留仅归档（当前流程不再使用；提示词与测试均不引用）。
 */

import type { ToolDefinition, ToolInputParams, ToolContext, ToolResult } from '@zread-pi/agent-runtime'
import {
  applySectionTitles,
  generateWikiJson,
  initWikiSkeleton,
  loadConfig,
  mergeSectionTopics,
  mergeWikiSections,
  normalizeBlueprintSections,
  normalizeSectionList,
} from '@zread-pi/utils'
import type { WikiPage, WikiSection, WikiTopic } from '@zread-pi/types'
import type { TechStackSummary } from '../types.js'

/**
 * Submit Sections Tool（分类阶段）
 *
 * 写入 wiki.json 骨架：sections（强制包含概览/快速开始/核心架构）+ 空 pages。
 * sync 流程传 `merge: true`：保留既有分类与页面，只把新增分类补进 sections。
 */
export function createSubmitSectionsTool(options: { merge?: boolean } = {}): ToolDefinition {
  const merge = options.merge === true

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
          description: '顶级分类清单（4~8 个；必须包含概览/快速开始/核心架构）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '分类标题（简洁中文，≤10 字）' },
              description: { type: 'string', description: '分类说明（这个分类覆盖什么、面向哪类读者）' },
            },
            required: ['title'],
          },
        },
      },
      required: ['sections'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return merge ? 'Merge the updated section list into wiki.json.' : 'Write the wiki.json skeleton with sections.';
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      try {
        const sections = normalizeSectionList(input.sections)
        if (sections.length === 0) {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: '错误: sections 数组不能为空',
            is_error: true,
          }
        }

        const config = await loadConfig()

        if (merge) {
          const merged = await mergeWikiSections(sections, config)
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `分类清单已合并（${merged.length} 个分类）:\n` +
              merged.map((section) => `- ${section.title}`).join('\n'),
          }
        }

        const normalized = normalizeBlueprintSections(sections, config.doc_language)
        const outputPath = await initWikiSkeleton(normalized, config)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Wiki 骨架已生成: ${outputPath}\n\n分类清单（${normalized.length} 个）:\n` +
            normalized.map((section) => `- ${section.title}${section.description ? `：${section.description}` : ''}`).join('\n'),
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `写入分类清单失败: ${message}`,
          is_error: true,
        }
      }
    },
  }
}

/** 生成流程使用的单例（写入新骨架） */
export const SubmitSectionsTool: ToolDefinition = createSubmitSectionsTool()

/**
 * Submit Section Topics Tool（主题阶段，按分类绑定）
 *
 * `section` 参数在 schema 中保留（模型需要确认自己在给哪个分类规划），
 * 但实际归并一律使用闭包绑定的期望分类——模型写错也不至于整段失败。
 */
export function createSubmitSectionTopicsTool(
  section: WikiSection,
  options: { reuseExisting?: boolean } = {},
): ToolDefinition {
  return {
    name: 'submit_section_topics',
    description: `提交分类「${section.title}」的文章主题（topic）清单；代码统一分配 slug/file 并增量归并进 wiki.json。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: `分类标题（必须为 "${section.title}"）` },
        topics: {
          type: 'array',
          description: '该分类下的文章主题（3~10 篇）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '草稿标题（≤20 字）' },
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
          },
        },
      },
      required: ['section', 'topics'],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return `Submit page topics for section "${section.title}".`;
    },
    async call(input: ToolInputParams, _context: ToolContext): Promise<ToolResult> {
      try {
        const topics = Array.isArray(input.topics) ? (input.topics as unknown as WikiTopic[]) : []
        const incomingSection = typeof input.section === 'string' ? input.section.trim() : ''
        const result = await mergeSectionTopics(section, topics, {
          reuseExisting: options.reuseExisting,
        })

        const mismatch =
          incomingSection && incomingSection.toLowerCase() !== section.title.trim().toLowerCase()
            ? `\n（模型传入的分类 "${incomingSection}" 与预期 "${section.title}" 不一致，已按预期分类归并）`
            : ''

        return {
          type: 'tool_result',
          tool_use_id: '',
          content:
            `分类「${result.section}」主题已归并：新增 ${result.added}，复用 ${result.reused}，去重 ${result.duplicated}\n` +
            `该分类现有 ${result.sectionPages} 篇；wiki.json 总计 ${result.totalPages} 篇${mismatch}`,
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `归并主题失败: ${message}`,
          is_error: true,
        }
      }
    },
  }
}

/**
 * Refine Section Titles Tool（标题阶段，按分类绑定）
 *
 * 只写回 title；slug / file / section 保持不变。
 */
export function createRefineSectionTitlesTool(section: WikiSection): ToolDefinition {
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
        const result = await applySectionTitles(section, titles)

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
      const outputPath = await generateWikiJson(pages, config, techStackSummary)

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
      const outputPath = await generateWikiJson(pages as WikiPage[], config, techStackSummary)

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