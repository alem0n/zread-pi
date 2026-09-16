/**
 * FileEditTool - 精确文本替换（替换实现）
 *
 * 参考上游 `pi/packages/coding-agent/src/core/tools/edit.ts`，修掉旧实现的问题：
 *  1. **CRLF / BOM 未归一化**：旧实现直接 `readFile(utf-8)` 后 `content.includes(old_string)`，
 *     在 CRLF 检出（Windows 默认 `core.autocrlf=true`）的文件上，模型给的 LF 文本永远匹配不上，
 *     只会看到一句"Make sure it matches exactly"。
 *  2. **无 fuzzy 兜底**：尾随空白、弯引号、en-dash、NBSP 等不可见字符差异直接失败。
 *  3. **不支持多段编辑**：一次只能改一处，多处不相邻改动要发多次工具调用。
 *  4. **无并发保护**：与 Write 同理存在同文件读-改-写丢更新的风险。
 *  5. **无 diff 回传**：模型与 UI 都看不到改了什么。
 *
 * 参数对齐上游 pi：`path` + `edits: [{ oldText, newText }]`（唯一接受形态）。
 */

import { constants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import type { ToolInputParams } from '../types.js'
import { defineTool, getString } from './types.js'
import type { ToolCallReturn } from './types.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { resolveToCwd } from './path-utils.js'
// 精确替换与 diff 计算直接用 pi 内核实现（不再本地维护副本，见 MIGRATION.md §13）
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from '@earendil-works/pi-agent-core/harness/tools/edit-diff'

interface NormalizedEditInput {
  requestedPath: string
  edits: Edit[]
}

function readEditPair(value: unknown): Edit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  const oldText = object.oldText
  const newText = object.newText
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  return { oldText, newText }
}

/** 把入参归一化成统一的 `{ requestedPath, edits }`（唯一形态：path + edits[]）。 */
export function normalizeEditInput(input: ToolInputParams): NormalizedEditInput {
  const requestedPath = getString(input, 'path')
  if (!requestedPath) throw new TypeError('Expected string for key "path", got undefined')

  const edits: Edit[] = []
  const editsArray = input.edits
  if (Array.isArray(editsArray)) {
    for (const entry of editsArray) {
      const pair = readEditPair(entry)
      if (!pair) throw new Error('Edit tool input is invalid: every edits[] entry needs string oldText and newText.')
      edits.push(pair)
    }
  }

  if (edits.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
  }
  return { requestedPath, edits }
}

export const FileEditTool = defineTool({
  name: 'edit',
  description:
    'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit (relative or absolute)',
      },
      edits: {
        type: 'array',
        description:
          'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description:
                'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
            },
            newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolCallReturn | string> {
    const { requestedPath, edits } = normalizeEditInput(input)
    const absolutePath = resolveToCwd(requestedPath, context.cwd)

    const throwIfAborted = (): void => {
      if (context.abortSignal?.aborted) throw new Error('Operation aborted')
    }

    return withFileMutationQueue(absolutePath, async () => {
      throwIfAborted()

      try {
        await access(absolutePath, constants.R_OK | constants.W_OK)
      } catch (error: unknown) {        throwIfAborted()
        const message = error instanceof Error && 'code' in error ? `Error code: ${error.code}` : String(error)
        throw new Error(`Could not edit file: ${requestedPath}. ${message}.`)
      }
      throwIfAborted()

      const rawContent = (await readFile(absolutePath)).toString('utf-8')
      throwIfAborted()

      // BOM 先剥掉再匹配：模型不会在 oldText 里带上不可见的 BOM
      const { bom, text: content } = stripBom(rawContent)
      const originalEnding = detectLineEnding(content)
      const normalizedContent = normalizeToLF(content)

      const applied = applyEditsToNormalizedContent(normalizedContent, edits, requestedPath)
      const baseContent = applied.baseContent
      const newContent = applied.newContent
      throwIfAborted()

      const finalContent = bom + restoreLineEndings(newContent, originalEnding)
      await writeFile(absolutePath, finalContent, 'utf-8')
      throwIfAborted()

      const diffResult = generateDiffString(baseContent, newContent)
      const patch = generateUnifiedPatch(requestedPath, baseContent, newContent)
      return {
        data: `Successfully replaced ${edits.length} block(s) in ${requestedPath}.`,
        details: {
          path: absolutePath,
          requestPath: requestedPath,
          firstChangedLine: diffResult.firstChangedLine ?? null,
          diff: diffResult.diff,
          patch,
        },
      }
    }, context.abortSignal)
  },
})
