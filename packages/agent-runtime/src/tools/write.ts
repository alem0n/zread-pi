/**
 * FileWriteTool - 写入 / 覆盖文件（替换实现）
 *
 * 参考上游 `pi/packages/coding-agent/src/core/tools/write.ts`：
 *  - 写入走 `withFileMutationQueue`，同文件的并发写被串行化（页面并行生成时的写-写竞争）；
 *  - 自动创建父目录；
 *  - 结果文本用「调用方给的路径」（相对路径更短、更贴近模型输入），绝对路径放 details。
 *
 * 参数名 `file_path` / `content` 保持不变（本仓库既有契约，测试与提示词都依赖它）。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool, getRequiredString } from './types.js'
import type { ToolCallReturn } from './types.js'
import { withFileMutationQueue } from './file-mutation-queue.js'
import { resolveToCwd } from './path-utils.js'

export const FileWriteTool = defineTool({
  name: 'Write',
  description:
    'Write content to a file. Creates the file if it does not exist, overwrites if it does. Automatically creates parent directories. Use Write only for new files or complete rewrites; use Edit for targeted changes.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to write (relative to the working directory, or absolute)',
      },
      content: {
        type: 'string',
        description: 'The full content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context): Promise<ToolCallReturn | string> {
    const requestedPath = getRequiredString(input, 'file_path')
    const content = getRequiredString(input, 'content')
    const absolutePath = resolveToCwd(requestedPath, context.cwd)
    const directory = dirname(absolutePath)

    // 注意：不要用 abort 事件监听器直接 reject —— 那样会在文件系统操作仍在进行时
    // 提前释放写队列。改为在每个 await 之后检查，语义相同但队列保持到最后。
    const throwIfAborted = (): void => {
      if (context.abortSignal?.aborted) throw new Error('Operation aborted')
    }

    return withFileMutationQueue(absolutePath, async () => {
      throwIfAborted()

      let existed = false
      try {
        existed = (await stat(absolutePath)).isFile()
      } catch {
        existed = false
      }

      await mkdir(directory, { recursive: true })
      throwIfAborted()

      await writeFile(absolutePath, content, 'utf-8')
      throwIfAborted()

      const lines = content.length === 0 ? 0 : content.split('\n').length
      const bytes = Buffer.byteLength(content, 'utf-8')
      return {
        data: `Successfully wrote to ${requestedPath}`,
        details: {
          path: absolutePath,
          requestPath: requestedPath,
          bytes,
          lines,
          created: !existed,
        },
      }
    })
  },
})
