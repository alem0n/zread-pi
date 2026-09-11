/**
 * GlobTool - 按 glob 模式查找文件（替换实现）
 *
 * 参考上游 `pi/packages/coding-agent/src/core/tools/find.ts`，替换掉旧实现的两个问题：
 *  1. 旧实现依赖 Node 实验性的 `fs.promises.glob`（无 `.gitignore` 支持、无 dotfile 支持），
 *     失败后走 `spawn('bash', ...)` —— Windows 上没有 bash，回退分支等于不可用，
 *     而且描述里承诺的「按修改时间排序」两条路径都没实现；
 *  2. 输出是绝对路径（`searchDir` 拼接结果），同一个仓库在不同机器上产出不同，
 *     也让模型把 token 浪费在重复的前缀上。
 *
 * 现在：优先使用系统 `fd`（保留上游的参数与平台适配细节），没有则用纯 JS 兜底
 * （`file-walk.ts` + `glob-match.ts`）。两条路径都：
 *  - 尊重 `.gitignore` / `.ignore` / `.fdignore`（不在 git 仓库内也生效）
 *  - 跳过 `.git` / `node_modules` / `.zread-pi`
 *  - 输出相对搜索根的 POSIX 风格路径，并按字典序排序（确定性，便于 diff 与测试）
 *  - 结果数上限 + 字节上限双截断，并在结尾给出可执行的提示
 */

import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { defineTool, getNumber, getRequiredString, getString } from './types.js'
import type { ToolCallReturn } from './types.js'
import { runCapture } from './child-process.js'
import { BUILTIN_EXCLUDED_DIRS, isInsideGitRepo, walkFiles } from './file-walk.js'
import { matchGlobPath } from './glob-match.js'
import { resolveToCwd } from './path-utils.js'
import { findSearchBinary } from './search-binaries.js'
import { appendToolNotices, byteLimitNotice, toTruncationDetails, truncateHead, DEFAULT_MAX_BYTES } from './truncate.js'

const DEFAULT_LIMIT = 1000

/** 把 fd 结果相对搜索根归一化为 POSIX 风格（用于两条执行路径的输出格式统一）。 */
export function relativizeFindResultPath(resultPath: string, searchPath: string): string {
  const hadTrailingSeparator = resultPath.endsWith('/') || resultPath.endsWith('\\')
  const absolute = /^[A-Za-z]:[\\/]/.test(resultPath) || resultPath.startsWith('/') || resultPath.startsWith('\\')
  const relativePath = absolute ? relative(searchPath, resultPath) : resultPath
  const posixPath = relativePath.split(/[\\/]/).join('/')
  return hadTrailingSeparator && !posixPath.endsWith('/') ? `${posixPath}/` : posixPath
}

async function searchWithFd(
  fdPath: string,
  pattern: string,
  searchPath: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ results: string[]; error?: string }> {
  const args: string[] = ['--glob', '--color=never', '--hidden']
  for (const excluded of BUILTIN_EXCLUDED_DIRS) {
    args.push('--exclude', excluded)
  }

  // fd 默认只在 git 仓库内应用 .gitignore；仓库外必须显式打开，否则与 JS 兜底不一致
  if (!(await isInsideGitRepo(searchPath))) args.push('--no-require-git')
  args.push('--max-results', String(limit))

  // fd --glob 的 pattern 默认只匹配 basename；含 `/` 时必须 `--full-path`，
  // 且需要补 `**` `/` 前缀（full-path 模式下 pattern 匹配的是绝对候选路径）。
  let effectivePattern = pattern
  if (pattern.includes('/')) {
    args.push('--full-path')
    if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') {
      effectivePattern = `**/${pattern}`
    }
    // Windows 上 fd 用原生分隔符匹配完整路径
    if (process.platform === 'win32') {
      effectivePattern = effectivePattern.replaceAll('/', String.raw`[/\\]`)
    }
  }
  args.push('--', effectivePattern, searchPath)

  const capture = await runCapture(fdPath, args, { signal })
  if (capture.aborted) {
    throw new Error('Operation aborted')
  }
  if (capture.error) {
    return { results: [], error: `Failed to run fd: ${capture.error.message}` }
  }
  const output = capture.stdout
  if (capture.code !== 0 && output.trim().length === 0) {
    return { results: [], error: capture.stderr.trim() || `fd exited with code ${capture.code}` }
  }

  const results: string[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line.length === 0) continue
    results.push(relativizeFindResultPath(line, searchPath))
  }
  return { results }
}

async function searchWithJs(pattern: string, searchPath: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const results: string[] = []
  for await (const entry of walkFiles(searchPath, { signal })) {
    if (matchGlobPath(entry.relativePath, pattern)) {
      results.push(entry.relativePath)
      if (results.length >= limit) break
    }
  }
  return results
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export const GlobTool = defineTool({
  name: 'Glob',
  description: `Find files matching a glob pattern. Returns matching file paths relative to the search directory, sorted alphabetically. Respects .gitignore. Supports patterns like "**/*.ts" and "src/**/*.js"; patterns without "/" are matched against the file name (so "*.ts" matches nested files too). Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
      },
      path: {
        type: 'string',
        description: 'Directory to search in (defaults to the working directory)',
      },
      limit: {
        type: 'number',
        description: `Maximum number of results (default: ${DEFAULT_LIMIT})`,
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
    const effectiveLimit = Math.max(1, getNumber(input, 'limit') ?? DEFAULT_LIMIT)

    try {
      const searchStat = await stat(searchPath)
      if (!searchStat.isDirectory()) {
        return { data: `Error: Not a directory: ${searchPath}`, is_error: true }
      }
    } catch {
      return { data: `Error: Path not found: ${searchPath}`, is_error: true }
    }

    let results: string[] = []
    let usedFallback = false
    const fdPath = findSearchBinary('fd')
    if (fdPath) {
      const fdResult = await searchWithFd(fdPath, pattern, searchPath, effectiveLimit, context.abortSignal)
      if (fdResult.error) {
        // fd 存在但执行失败（动态库缺失/权限等）：退回纯 JS，而不是让整次搜索失败
        usedFallback = true
        results = await searchWithJs(pattern, searchPath, effectiveLimit, context.abortSignal)
      } else {
        results = fdResult.results
      }
    } else {
      usedFallback = true
      results = await searchWithJs(pattern, searchPath, effectiveLimit, context.abortSignal)
    }

    results = sortPaths(results)
    const resultLimitReached = results.length >= effectiveLimit

    if (results.length === 0) {
      return {
        data: `No files matching pattern "${pattern}" in ${searchPath}`,
        details: { path: searchPath, pattern, usedFallback },
      }
    }

    const rawOutput = results.join('\n')
    const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
    const notices: string[] = []
    if (resultLimitReached) {
      notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
    }
    if (truncation.truncated) {
      notices.push(byteLimitNotice())
    }

    return {
      data: appendToolNotices(truncation.content, notices),
      details: {
        path: searchPath,
        pattern,
        count: results.length,
        usedFallback,
        ...(resultLimitReached ? { resultLimitReached: effectiveLimit } : {}),
        ...(truncation.truncated ? { truncation: toTruncationDetails(truncation) } : {}),
      },
    }
  },
})
