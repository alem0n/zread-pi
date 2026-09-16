/**
 * FileReadTool - 读取文件（替换实现）
 *
 * 参考上游 `pi/packages/coding-agent/src/core/tools/read.ts` +
 * `pi/packages/agent/src/harness/tools/{read,image}.ts`，修掉旧实现的问题：
 *  1. 旧实现「图片」只按扩展名识别，且只回一句 `[Image file: ... (N bytes)]`，
 *     模型拿不到任何内容；现在按 **magic number** 判型（无扩展名的截图也能认出来），
 *     并在模型支持图片输入时以 image 内容块回传（否则回退为文本说明，避免请求被拒）。
 *     第六步接入图片处理管线（`tools/image/`，移植自 pi coding-agent）：
 *     自动缩放到 2000×2000 / 4.5MB base64 以内（省 token、避免 provider 拒收），
 *     BMP 等非内联格式自动转 PNG，并在文本里说明「已转换 / 已缩放及坐标换算比例」。
 *  2. 旧实现硬编码 `limit = 2000` 行，且没有字节上限 —— 一个 500KB 的单行 minified
 *     文件会直接灌满上下文；现在用共享的截断设施（2000 行 / 50KB，先到先触发），
 *     并给出可执行的续读提示（`Use offset=N to continue.`）。
 *  3. 旧实现遇到目录时提示「Use Bash with 'ls'」，而本仓库**没有 Bash 工具**；
 *     现在改为点名 `Ls`。
 *  4. 旧实现 offset 是 0-based 且会给每行加 `行号\t` 前缀（与 Edit 的精确匹配语义无关，
 *     纯属浪费 token）。现在与上游一致：offset 1-based，输出原始文本。
 *
 * 参数对齐上游 pi：主参数 `path`。
 */

import { readFile, stat } from 'node:fs/promises'
import { defineTool, getNumber, getRequiredString, getString } from './types.js'
import type { ToolCallReturn } from './types.js'
import type { ToolInputParams } from '../types.js'
// 图片判型直接用 pi 内核实现（不再本地维护副本，见 MIGRATION.md §13）
import { detectSupportedImageMimeType } from '@earendil-works/pi-agent-core/harness/tools/image'
// 图片处理管线（格式归一化 + 缩放 + 提示），移植自 pi coding-agent
import { processImage } from './image/image-process.js'
import { resolveReadPathAsync } from './path-utils.js'
import { toTruncationDetails, truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.js'

function resolveFilePath(input: ToolInputParams): string {
  const filePath = getString(input, 'path')
  if (!filePath) throw new TypeError('Expected string for key "path", got undefined')
  return filePath
}

export const FileReadTool = defineTool({
  name: 'read',
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read (relative or absolute)',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['path'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context): Promise<ToolCallReturn | string> {
    const requestedPath = resolveFilePath(input)
    const absolutePath = await resolveReadPathAsync(requestedPath, context.cwd)

    let fileStat
    try {
      fileStat = await stat(absolutePath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { data: `Error: File not found: ${absolutePath}`, is_error: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { data: `Error reading file: ${message}`, is_error: true }
    }

    if (fileStat.isDirectory()) {
      return {
        data: `Error: ${absolutePath} is a directory, not a file. Use the ls tool to list directory contents.`,
        is_error: true,
      }
    }

    let buffer: Buffer
    try {
      buffer = await readFile(absolutePath)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { data: `Error reading file: ${message}`, is_error: true }
    }

    const mimeType = detectSupportedImageMimeType(buffer)
    if (mimeType) {
      if (context.supportsImages === true) {
        // 处理管线：非内联格式转 PNG、超过 2000×2000 / 4.5MB 时缩放
        const processed = await processImage(buffer, mimeType)
        if (!processed.ok) {
          // 处理失败（photon 不可用 / 压不到限制内）：退回文本说明，不把原始大图灌给 provider
          return {
            data: `[Image file: ${absolutePath} (${formatSize(buffer.length)}, ${mimeType}). ${processed.message}]`,
            details: { path: absolutePath, mimeType, bytes: buffer.length, imageOmitted: true },
          }
        }
        const text = [`Read image file [${processed.mimeType}]`, ...processed.hints].join('\n')
        return {
          content: [
            { type: 'text', text },
            {
              type: 'image',
              source: { type: 'base64', media_type: processed.mimeType, data: processed.data },
            },
          ],
          details: { path: absolutePath, mimeType: processed.mimeType, bytes: buffer.length },
        }
      }
      const reason =
        context.supportsImages === false
          ? 'the current model does not support image input'
          : 'image input support could not be determined for the current model'
      return {
        data: `[Image file: ${absolutePath} (${formatSize(buffer.length)}, ${mimeType}). Content omitted because ${reason}.]`,
        details: { path: absolutePath, mimeType, bytes: buffer.length, imageOmitted: true },
      }
    }

    // 非图片二进制（含 NUL 字节）：直接说明，别把乱码灌进上下文
    if (buffer.subarray(0, 8000).includes(0)) {
      return {
        data: `[Binary file: ${absolutePath} (${formatSize(buffer.length)}). Not a supported image type, so no textual content is available.]`,
        details: { path: absolutePath, bytes: buffer.length, binary: true },
      }
    }

    const textContent = buffer.toString('utf-8')
    const allLines = textContent.split('\n')
    const totalFileLines = allLines.length

    // 1-based offset
    const offset = getNumber(input, 'offset')
    const startLine = offset && offset > 0 ? Math.max(0, Math.floor(offset) - 1) : 0
    const startLineDisplay = startLine + 1
    if (startLine >= allLines.length) {
      return {
        data: `Error: Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
        is_error: true,
      }
    }

    const limitValue = getNumber(input, 'limit')
    let selectedContent: string
    let userLimitedLines: number | undefined
    if (limitValue !== undefined && Number.isFinite(limitValue) && limitValue > 0) {
      const endLine = Math.min(startLine + Math.floor(limitValue), allLines.length)
      selectedContent = allLines.slice(startLine, endLine).join('\n')
      userLimitedLines = endLine - startLine
    } else {
      selectedContent = allLines.slice(startLine).join('\n')
    }

    const truncation = truncateHead(selectedContent)

    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? '', 'utf-8'))
      return {
        data: `[Line ${startLineDisplay} is ${firstLineSize}, exceeding the ${formatSize(DEFAULT_MAX_BYTES)} limit. Read the file with a tool that can page by bytes, or use grep to locate the relevant part.]`,
        details: { path: absolutePath, truncation: toTruncationDetails(truncation), firstLineExceedsLimit: true },
      }
    }

    if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1
      const nextOffset = endLineDisplay + 1
      const suffix =
        truncation.truncatedBy === 'lines'
          ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
          : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
      return {
        data: truncation.content + suffix,
        details: { path: absolutePath, truncation: toTruncationDetails(truncation) },
      }
    }

    if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      const remaining = allLines.length - (startLine + userLimitedLines)
      const nextOffset = startLine + userLimitedLines + 1
      return {
        data: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
        details: { path: absolutePath },
      }
    }

    return {
      data: truncation.content.length === 0 ? '(empty file)' : truncation.content,
      details: { path: absolutePath },
    }
  },
})
