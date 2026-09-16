/**
 * GrepTool - 按正则搜索文件内容（替换实现）
 *
 * 参考上游 `pi/packages/coding-agent/src/core/tools/grep.ts`，修掉旧实现的三个问题：
 *  1. **全量缓冲**：旧实现把 rg 的整个 stdout 收进内存才处理，命中上限形同虚设；
 *     现在用 `--json` 流式解析，达到上限立刻 kill 子进程（`streamLines`）。
 *  2. **绝对路径输出**：旧实现直接把 `resolve(cwd, path)` 丢给 rg，输出全是绝对路径；
 *     现在统一归一化为「相对搜索根的 POSIX 路径」（搜索单个文件时用 basename）。
 *  3. **rg / grep 分支不一致**：旧实现的 rg 分支不做 `--json`、不做行截断、超长行会灌满上下文，
 *     fallback 分支用的是完全不同的参数与输出（还依赖 `grep -r`，Windows 上没有）。
 *     现在统一为「rg 优先 + 纯 JS 兜底」，两条路径输出同一套格式与提示。
 *
 * 另外补上上游有、旧实现没有的能力：`ignoreCase` / `literal` / `context` / `limit`，
 * 以及长行截断（500 字符）与超长输出的字节截断（50KB）。
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, relative } from 'node:path'
import { defineTool, getBoolean, getNumber, getRequiredString, getString } from './types.js'
import type { ToolCallReturn } from './types.js'
import { streamLines } from './child-process.js'
import { BUILTIN_EXCLUDED_DIRS, isInsideGitRepo, walkFiles } from './file-walk.js'
import { matchGlobPath } from './glob-match.js'
import { resolveToCwd } from './path-utils.js'
import { findSearchBinary } from './search-binaries.js'
import {
  appendToolNotices,
  byteLimitNotice,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  toTruncationDetails,
  truncateHead,
  truncateLine,
  DEFAULT_MAX_BYTES,
} from './truncate.js'

const DEFAULT_LIMIT = 100
/** 兜底实现读取文件的大小上限：超过就跳过（rg 默认也会跳过明显过大的文件）。 */
const MAX_FALLBACK_FILE_BYTES = 10 * 1024 * 1024

type OutputMode = 'content' | 'files_with_matches' | 'count'

interface MatchLine {
  filePath: string
  lineNumber: number
  lineText?: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isBinaryContent(text: string): boolean {
  return text.slice(0, 8000).includes('\u0000')
}

/** 搜索根是目录时输出相对路径，是文件时输出 basename（与 rg 打印已给路径的行为对齐）。 */
function createPathFormatter(searchPath: string, isDirectory: boolean): (filePath: string) => string {
  return (filePath: string) => {
    if (!isDirectory) return basename(filePath)
    const relativePath = relative(searchPath, filePath)
    if (relativePath && !relativePath.startsWith('..')) {
      return relativePath.split(/[\\/]/).join('/')
    }
    return basename(filePath)
  }
}

// ---------------------------------------------------------------------------
// rg 路径
// ---------------------------------------------------------------------------

async function grepWithRg(
  rgPath: string,
  options: {
    pattern: string
    searchPath: string
    isDirectory: boolean
    glob?: string
    ignoreCase: boolean
    literal: boolean
    contextValue: number
    limit: number
    outputMode: OutputMode
    signal?: AbortSignal
  },
): Promise<{ rows: string[]; matchLimitReached: boolean; linesTruncated: boolean; error?: string }> {
  const { pattern, searchPath, isDirectory, glob, ignoreCase, literal, contextValue, limit, outputMode, signal } = options
  const formatPath = createPathFormatter(searchPath, isDirectory)

  const args: string[] = []
  if (outputMode === 'files_with_matches') args.push('--files-with-matches')
  else if (outputMode === 'count') args.push('--count')
  else args.push('--json', '--line-number')
  args.push('--color=never', '--hidden')
  // rg 与 fd 同理：不在 git 仓库内时默认不应用 .gitignore，必须显式打开，
  // 否则「解压出来的源码包」会把 dist / node_modules 全部搜出来，与 JS 兜底不一致
  if (!(await isInsideGitRepo(searchPath))) args.push('--no-require-git')
  if (ignoreCase) args.push('--ignore-case')
  if (literal) args.push('--fixed-strings')
  for (const excluded of BUILTIN_EXCLUDED_DIRS) args.push('--glob', `!**/${excluded}/**`)
  if (glob) args.push('--glob', glob)
  args.push('--', pattern, searchPath)

  const matches: MatchLine[] = []
  const plainRows: string[] = []
  let matchCount = 0
  let matchLimitReached = false
  let linesTruncated = false
  // context 模式需要回读文件行；缓存避免重复 IO
  const fileLineCache = new Map<string, string[] | undefined>()

  const getFileLines = async (filePath: string): Promise<string[] | undefined> => {
    if (fileLineCache.has(filePath)) return fileLineCache.get(filePath)
    let lines: string[] | undefined
    try {
      const content = await readFile(filePath, 'utf-8')
      lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    } catch {
      lines = undefined
    }
    fileLineCache.set(filePath, lines)
    return lines
  }

  const stream = await streamLines(rgPath, args, {
    signal,
    onLine: (line) => {
      if (line.trim().length === 0) return undefined
      if (outputMode !== 'content') {
        // files-with-matches / count 模式：rg 每行一条结果
        if (matchCount >= limit) return false
        matchCount++;
        plainRows.push(line.replace(/\r$/, ''));
        if (matchCount >= limit) {
          matchLimitReached = true
          return false
        }
        return undefined
      }

      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
      try {
        event = JSON.parse(line)
      } catch {
        return undefined
      }
      if (event.type !== 'match') return undefined
      matchCount++
      const filePath = event.data?.path?.text
      const lineNumber = event.data?.line_number
      if (filePath && typeof lineNumber === 'number') {
        matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text })
      }
      if (matchCount >= limit) {
        matchLimitReached = true
        return false
      }
      return undefined
    },
  })

  if (stream.aborted) throw new Error('Operation aborted')
  if (stream.error) return { rows: [], matchLimitReached, linesTruncated, error: `Failed to run ripgrep: ${stream.error.message}` }
  if (!matchLimitReached && stream.code !== 0 && stream.code !== 1) {
    return {
      rows: [],
      matchLimitReached,
      linesTruncated,
      error: stream.stderr.trim() || `ripgrep exited with code ${stream.code}`,
    }
  }

  if (outputMode !== 'content') {
    return {
      rows: plainRows.map((row) => formatPathRow(row, searchPath, formatPath, outputMode)),
      matchLimitReached,
      linesTruncated,
    }
  }

  const rows: string[] = []
  for (const match of matches) {
    const displayPath = formatPath(match.filePath)
    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = match.lineText.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '')
      const { text, wasTruncated } = truncateLine(sanitized)
      if (wasTruncated) linesTruncated = true
      rows.push(`${displayPath}:${match.lineNumber}: ${text}`)
      continue
    }

    const lines = await getFileLines(match.filePath)
    if (!lines) {
      rows.push(`${displayPath}:${match.lineNumber}: (unable to read file)`)
      continue
    }
    const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber
    const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber
    for (let current = start; current <= end; current++) {
      const rawLine = lines[current - 1] ?? ''
      const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ''))
      if (wasTruncated) linesTruncated = true
      rows.push(
        current === match.lineNumber
          ? `${displayPath}:${current}: ${text}`
          : `${displayPath}-${current}- ${text}`,
      )
    }
  }

  return { rows, matchLimitReached, linesTruncated }
}

/** rg 的 files-with-matches / count 输出是文件路径本身，需要重新相对化。 */
function formatPathRow(
  row: string,
  searchPath: string,
  formatPath: (filePath: string) => string,
  outputMode: OutputMode,
): string {
  if (outputMode === 'count') {
    // `path:count`（Windows 上的盘符会让首个 `:` 变成路径的一部分，用最后一个分隔）
    const separator = row.lastIndexOf(':')
    if (separator === -1) return row
    const filePath = row.slice(0, separator)
    const count = row.slice(separator + 1)
    return `${formatPath(filePath)}:${count}`
  }
  return formatPath(row)
}

// ---------------------------------------------------------------------------
// 纯 JS 兜底
// ---------------------------------------------------------------------------

async function grepWithJs(
  options: {
    pattern: string
    searchPath: string
    isDirectory: boolean
    glob?: string
    ignoreCase: boolean
    literal: boolean
    contextValue: number
    limit: number
    outputMode: OutputMode
    signal?: AbortSignal
  },
): Promise<{ rows: string[]; matchLimitReached: boolean; linesTruncated: boolean; error?: string; skippedLargeFiles: number }> {
  const { pattern, searchPath, isDirectory, glob, ignoreCase, literal, contextValue, limit, outputMode, signal } = options

  let regex: RegExp
  try {
    regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? 'i' : '')
  } catch (err: unknown) {
    return {
      rows: [],
      matchLimitReached: false,
      linesTruncated: false,
      skippedLargeFiles: 0,
      error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const formatPath = createPathFormatter(searchPath, isDirectory)
  const rows: string[] = []
  let matchCount = 0
  let matchLimitReached = false
  let linesTruncated = false
  let skippedLargeFiles = 0
  const countRows = new Map<string, number>()
  const fileOrder: string[] = []

  const considerFile = async (absolutePath: string, relativePath: string): Promise<boolean> => {
    if (glob && !matchGlobPath(relativePath, glob)) return true

    let fileStat
    try {
      fileStat = await stat(absolutePath)
    } catch {
      return true
    }
    if (!fileStat.isFile()) return true
    if (fileStat.size > MAX_FALLBACK_FILE_BYTES) {
      skippedLargeFiles++
      return true
    }

    let content: string
    try {
      content = await readFile(absolutePath, 'utf-8')
    } catch {
      return true
    }
    if (isBinaryContent(content)) return true

    const displayPath = formatPath(absolutePath)
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    const matchedLineNumbers: number[] = []
    for (let index = 0; index < lines.length; index++) {
      if (regex.test(lines[index])) matchedLineNumbers.push(index + 1)
    }
    if (matchedLineNumbers.length === 0) return true

    if (outputMode === 'files_with_matches') {
      matchCount++
      fileOrder.push(displayPath)
      return matchCount < limit
    }
    if (outputMode === 'count') {
      matchCount++
      countRows.set(displayPath, matchedLineNumbers.length)
      fileOrder.push(displayPath)
      return matchCount < limit
    }

    let previousLine = -1
    for (const lineNumber of matchedLineNumbers) {
      if (matchCount >= limit) {
        matchLimitReached = true
        return false
      }
      matchCount++

      const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber
      const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber
      // 与 rg 一致：不连续的行区间之间加 `--` 分隔
      if (previousLine !== -1 && start > previousLine + 1) rows.push('--')
      for (let current = Math.max(start, previousLine + 1); current <= end; current++) {
        const { text, wasTruncated } = truncateLine(lines[current - 1] ?? '')
        if (wasTruncated) linesTruncated = true
        rows.push(
          current === lineNumber ? `${displayPath}:${current}: ${text}` : `${displayPath}-${current}- ${text}`,
        )
      }
      previousLine = end
    }
    return matchCount < limit
  }

  if (isDirectory) {
    for await (const entry of walkFiles(searchPath, { signal })) {
      if (signal?.aborted) throw new Error('Operation aborted')
      const keepGoing = await considerFile(entry.absolutePath, entry.relativePath)
      if (!keepGoing) break
    }
  } else {
    await considerFile(searchPath, basename(searchPath))
  }

  if (outputMode !== 'content') {
    const rendered = fileOrder.map((path) => (outputMode === 'count' ? `${path}:${countRows.get(path) ?? 0}` : path))
    return { rows: rendered, matchLimitReached, linesTruncated, skippedLargeFiles }
  }

  return { rows, matchLimitReached, linesTruncated, skippedLargeFiles }
}

// ---------------------------------------------------------------------------

function normalizeOutputMode(value: string | undefined): OutputMode {
  if (value === 'files_with_matches' || value === 'count') return value
  return 'content'
}

export const GrepTool = defineTool({
  name: 'grep',
  description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern (regex or literal string)',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search (default: current directory)',
      },
      glob: {
        type: 'string',
        description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case-insensitive search (default: false)',
      },
      literal: {
        type: 'boolean',
        description: 'Treat pattern as literal string instead of regex (default: false)',
      },
      context: {
        type: 'number',
        description: 'Number of lines to show before and after each match (default: 0)',
      },
      limit: {
        type: 'number',
        description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})`,
      },
      output_mode: {
        type: 'string',
        description: "Output format: 'content' (default), 'files_with_matches', or 'count'",
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context): Promise<ToolCallReturn | string> {
    const pattern = getRequiredString(input, 'pattern')
    const pathValue = getString(input, 'path')
    const searchPath = resolveToCwd(pathValue && pathValue.length > 0 ? pathValue : '.', context.cwd)
    const glob = getString(input, 'glob')
    const ignoreCase = getBoolean(input, 'ignoreCase') ?? false
    const literal = getBoolean(input, 'literal') ?? false
    const contextValue = Math.max(0, getNumber(input, 'context') ?? 0)
    const limit = Math.max(1, getNumber(input, 'limit') ?? DEFAULT_LIMIT)
    const outputMode = normalizeOutputMode(getString(input, 'output_mode'))

    let isDirectory: boolean
    try {
      const searchStat = await stat(searchPath)
      isDirectory = searchStat.isDirectory()
    } catch {
      return { data: `Error: Path not found: ${searchPath}`, is_error: true }
    }

    const shared = {
      pattern,
      searchPath,
      isDirectory,
      glob,
      ignoreCase,
      literal,
      contextValue,
      limit,
      outputMode,
      signal: context.abortSignal,
    }

    let rows: string[] = []
    let matchLimitReached = false
    let linesTruncated = false
    let usedFallback = false
    let skippedLargeFiles = 0

    const rgPath = findSearchBinary('rg')
    if (rgPath) {
      const rgResult = await grepWithRg(rgPath, shared)
      if (rgResult.error) {
        // rg 存在但调用失败（正则不兼容/权限等）：退回纯 JS，避免整次搜索失败
        usedFallback = true
        const jsResult = await grepWithJs(shared)
        if (jsResult.error) return { data: `Error: ${jsResult.error}`, is_error: true }
        rows = jsResult.rows
        matchLimitReached = jsResult.matchLimitReached
        linesTruncated = jsResult.linesTruncated
        skippedLargeFiles = jsResult.skippedLargeFiles
      } else {
        rows = rgResult.rows
        matchLimitReached = rgResult.matchLimitReached
        linesTruncated = rgResult.linesTruncated
      }
    } else {
      usedFallback = true
      const jsResult = await grepWithJs(shared)
      if (jsResult.error) return { data: `Error: ${jsResult.error}`, is_error: true }
      rows = jsResult.rows
      matchLimitReached = jsResult.matchLimitReached
      linesTruncated = jsResult.linesTruncated
      skippedLargeFiles = jsResult.skippedLargeFiles
    }

    if (rows.length === 0) {
      return {
        data: `No matches found for pattern "${pattern}" in ${searchPath}`,
        details: { pattern, path: searchPath, usedFallback },
      }
    }

    const rawOutput = rows.join('\n')
    const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
    const notices: string[] = []
    if (matchLimitReached) {
      notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`)
    }
    if (truncation.truncated) {
      notices.push(byteLimitNotice())
    }
    if (linesTruncated) {
      notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
    }
    if (skippedLargeFiles > 0) {
      notices.push(`${skippedLargeFiles} file(s) larger than ${formatSize(MAX_FALLBACK_FILE_BYTES)} were skipped`)
    }

    return {
      data: appendToolNotices(truncation.content, notices),
      details: {
        pattern,
        path: searchPath,
        outputMode,
        usedFallback,
        ...(matchLimitReached ? { matchLimitReached: limit } : {}),
        ...(linesTruncated ? { linesTruncated: true } : {}),
        ...(truncation.truncated ? { truncation: toTruncationDetails(truncation) } : {}),
      },
    }
  },
})
