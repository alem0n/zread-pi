/**
 * LsTool - 目录列举（新增工具）
 *
 * 对应上游 `pi/packages/coding-agent/src/core/tools/ls.ts`。
 * 之所以需要它：旧实现里 `Read` 遇到目录时会提示「Use Bash with 'ls'」——而本仓库
 * **从未注册过 Bash 工具**（AGENTS.md 明确说明 shell 能力未迁移），
 * 模型照做只会连续失败。新增 `Ls` 后这类文案才有对应能力。
 *
 * 与上游的差异（有意为之）：
 *  - 工具名按本仓库既有 PascalCase 约定（与 Read / Write / Edit / Glob / Grep 一致）；
 *  - 目录判定用 `stat`（跟随软链接，软链接指向目录时补 `/`），与上游一致；
 *  - 输出条目上限 + 字节上限双限制，提示文案与上游一致。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, getNumber, getString } from './types.js'
import type { ToolCallReturn } from './types.js'
import { resolveToCwd } from './path-utils.js'
import { appendToolNotices, byteLimitNotice, toTruncationDetails, truncateHead, DEFAULT_MAX_BYTES } from './truncate.js'

const DEFAULT_LIMIT = 500

export const LsTool = defineTool({
  name: 'Ls',
  description: `List directory contents. Returns entries sorted alphabetically (case-insensitive), with a trailing "/" for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list (defaults to the working directory)',
      },
      limit: {
        type: 'number',
        description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
      },
    },
    required: [],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context): Promise<ToolCallReturn | string> {
    const pathValue = getString(input, 'path')
    const dirPath = resolveToCwd(pathValue && pathValue.length > 0 ? pathValue : '.', context.cwd)
    const effectiveLimit = Math.max(1, getNumber(input, 'limit') ?? DEFAULT_LIMIT)

    let entryNames: string[]
    try {
      const directoryStat = await stat(dirPath)
      if (!directoryStat.isDirectory()) {
        return { data: `Error: Not a directory: ${dirPath}`, is_error: true }
      }
      entryNames = await readdir(dirPath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { data: `Error: Path not found: ${dirPath}`, is_error: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { data: `Error: Cannot read directory ${dirPath}: ${message}`, is_error: true }
    }

    // 大小写不敏感排序，保证三平台顺序一致（Linux/Windows 的 localeCompare 差异不会影响结果）
    entryNames.sort((a, b) => {
      const left = a.toLowerCase()
      const right = b.toLowerCase()
      if (left < right) return -1
      if (left > right) return 1
      return a < b ? -1 : a > b ? 1 : 0
    })

    const entries: string[] = []
    let entryLimitReached = false
    for (const name of entryNames) {
      if (entries.length >= effectiveLimit) {
        entryLimitReached = true
        break
      }
      let suffix = ''
      try {
        const entryStat = await stat(join(dirPath, name))
        if (entryStat.isDirectory()) suffix = '/'
      } catch {
        // 无法 stat 的条目（权限/断链）直接跳过，不让整次列举失败
        continue
      }
      entries.push(`${name}${suffix}`)
    }

    if (entries.length === 0) {
      return {
        data: '(empty directory)',
        details: { path: dirPath, totalEntries: entryNames.length },
      }
    }

    const rawOutput = entries.join('\n')
    // 条目数已经封顶，这里只做字节截断
    const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
    const notices: string[] = []
    if (entryLimitReached) {
      notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`)
    }
    if (truncation.truncated) {
      notices.push(byteLimitNotice())
    }

    return {
      data: appendToolNotices(truncation.content, notices),
      details: {
        path: dirPath,
        totalEntries: entryNames.length,
        ...(entryLimitReached ? { entryLimitReached: effectiveLimit } : {}),
        ...(truncation.truncated ? { truncation: toTruncationDetails(truncation) } : {}),
      },
    }
  },
})
