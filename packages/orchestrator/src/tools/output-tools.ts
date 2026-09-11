/**
 * Output Tools - Generate and save wiki.json blueprint
 */

import type { ToolDefinition, ToolInputParams, ToolContext, ToolResult } from '@zread-pi/agent-runtime'
import { generateWikiJson, loadConfig } from '@zread-pi/utils'
import type { WikiPage } from '@zread-pi/types'
import type { TechStackSummary } from '../types.js'

/**
 * Generate Blueprint Tool
 *
 * Generates wiki.json blueprint and saves to wiki directory.
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
 * Generate Sync Blueprint Tool
 *
 * Generates wiki.json with sync status flags on each page.
 * Unlike GenerateBlueprintTool, this is used during sync flow and
 * expects each page to include a `status` field.
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