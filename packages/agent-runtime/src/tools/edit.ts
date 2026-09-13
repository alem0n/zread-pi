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
 * 参数兼容（AGENTS.md 硬约束：不重命名工具；参数保持向后可用）：
 *  - 主参数沿用本仓库既有的 `file_path` / `old_string` / `new_string` / `replace_all`
 *  - 同时接受上游形式 `path` + `edits: [{ oldText, newText }]`
 *  - 也接受上游的顶层 `oldText` / `newText` 别名
 *  - `edits` 传成 JSON 字符串（部分模型会这样发）也会被解析
 */

import { constants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import type { JsonArray, JsonObject, JsonValue, ToolInputParams } from '../types.js'
import { defineTool, getBoolean, getString } from './types.js'
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
  /** replace_all 模式：old_string 的所有出现都被替换（精确匹配，不走 fuzzy） */
  replaceAll: boolean
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonObject
}

function asJsonArray(value: JsonValue | undefined): JsonArray | undefined {
  return Array.isArray(value) ? value : undefined
}

function readEditPair(value: unknown): Edit | undefined {
  const object = asJsonObject(value as JsonValue | undefined)
  if (!object) return undefined
  const oldText = object.oldText
  const newText = object.newText
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  return { oldText, newText }
}

/** 把多种入参形态归一化成统一的 `{ requestedPath, edits, replaceAll }`。 */
export function normalizeEditInput(input: ToolInputParams): NormalizedEditInput {
  const requestedPath = getString(input, 'file_path') ?? getString(input, 'path')
  if (!requestedPath) throw new TypeError('Expected string for key "file_path", got undefined')

  const edits: Edit[] = []
  let replaceAll = getBoolean(input, 'replace_all') ?? false

  // 1) edits 数组（含 JSON 字符串形式）
  let rawEdits: JsonValue | undefined = input.edits as JsonValue | undefined
  if (typeof rawEdits === 'string') {
    try {
      rawEdits = JSON.parse(rawEdits) as JsonValue
    } catch {
      // 解析失败就按下面其它形态处理
    }
  }
  const editsArray = asJsonArray(rawEdits)
  if (editsArray) {
    for (const entry of editsArray) {
      const pair = readEditPair(entry)
      if (!pair) throw new Error('Edit tool input is invalid: every edits[] entry needs string oldText and newText.')
      edits.push(pair)
    }
  } else {
    const single = readEditPair(rawEdits)
    if (single) edits.push(single)
  }

  // 2) 顶层 oldText / newText 别名（上游历史形态）
  const legacyOld = getString(input, 'oldText')
  const legacyNew = getString(input, 'newText')
  if (legacyOld !== undefined && legacyNew !== undefined) {
    edits.push({ oldText: legacyOld, newText: legacyNew })
  }

  // 3) 本仓库既有形态：old_string / new_string
  const oldString = getString(input, 'old_string')
  const newString = getString(input, 'new_string')
  if (oldString !== undefined && newString !== undefined) {
    edits.push({ oldText: oldString, newText: newString })
  }
  if (getBoolean(input, 'replace_all') === undefined && (oldString !== undefined || legacyOld !== undefined)) {
    // 未显式给出 replace_all 时保持旧默认（false）
    replaceAll = false
  }

  if (edits.length === 0) {
    throw new Error('Edit tool input is invalid. Provide old_string/new_string, or a non-empty edits array.')
  }
  return { requestedPath, edits, replaceAll }
}

export const FileEditTool = defineTool({
  name: 'Edit',
  description:
    'Edit a single file using exact text replacement. old_string must match a unique, non-overlapping region of the original file (whitespace and line endings are normalized, so CRLF files work with LF input). Use replace_all to change every occurrence, or pass multiple disjoint edits via edits[].',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit (relative to the working directory, or absolute)',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find. Must be unique in the file unless replace_all is true.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence of old_string (exact match, default false).',
      },
      edits: {
        type: 'array',
        description:
          'Alternative to old_string/new_string: one or more disjoint replacements. Each entry is matched against the original file, not incrementally. Do not emit overlapping edits; merge nearby changes into one.',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: 'Exact text for one targeted replacement' },
            newText: { type: 'string', description: 'Replacement text for this targeted edit' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['file_path'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolCallReturn | string> {
    const { requestedPath, edits, replaceAll } = normalizeEditInput(input)
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

      // BOM 先剥掉再匹配：模型不会在 old_string 里带上不可见的 BOM
      const { bom, text: content } = stripBom(rawContent)
      const originalEnding = detectLineEnding(content)
      const normalizedContent = normalizeToLF(content)

      let baseContent: string
      let newContent: string
      // replace_all 只对「单个 old/new 对」有意义；与 edits[] 同时给出时按多段严格模式处理
      const useReplaceAll = replaceAll && edits.length === 1
      if (useReplaceAll) {
        const oldText = normalizeToLF(edits[0]?.oldText ?? '')
        const newText = normalizeToLF(edits[0]?.newText ?? '')
        if (oldText.length === 0) {
          throw new Error(`old_string must not be empty in ${requestedPath}.`)
        }
        if (!normalizedContent.includes(oldText)) {
          throw new Error(
            `Could not find the exact text in ${requestedPath}. The old text must match exactly including all whitespace and newlines.`,
          )
        }
        baseContent = normalizedContent
        newContent = normalizedContent.split(oldText).join(newText)
        if (baseContent === newContent) {
          throw new Error(`No changes made to ${requestedPath}. The replacement produced identical content.`)
        }
      } else {
        const applied = applyEditsToNormalizedContent(normalizedContent, edits, requestedPath)
        baseContent = applied.baseContent
        newContent = applied.newContent
      }
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
