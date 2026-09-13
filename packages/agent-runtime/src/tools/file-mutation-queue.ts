/**
 * 同文件写操作串行化（**不再自维护实现**）。
 *
 * 排队逻辑全部由 pi 内核承担：`harness/tools/file-mutation-queue.ts`
 * （vendor/pi/packages/agent/src/harness/tools/file-mutation-queue.ts）。
 * 本文件只做两件事，都是「接线」而不是实现：
 *  1. 给 pi 的 `withFileMutationQueue(env, path, fn, context)` 提供宿主能力：
 *     · `ExecutionEnv`：pi 的 `NodeExecutionEnv`（`harness/env/nodejs`），
 *       用它的 `absolutePath` / `canonicalPath` 得到排队键（canonical path = realpath，
 *       软链接指向同一文件时也能串行）；
 *     · `Context`：把工具拿到的 `abortSignal` 包进 `BACKGROUND_CONTEXT`。
 *  2. 保持本仓库调用点的两参数签名 `(filePath, fn, signal?)` 不变。
 *
 * 为什么 env 必须是**进程级单例**：pi 把队列状态存在 `WeakMap<ExecutionEnv, ...>` 里，
 * 每个 env 实例一套队列；只有共享同一个 env，不同子 Agent 对同一文件的写才会进同一条队列
 * （Wiki 页面是 p-limit 并行生成的，Edit 的「读-改-写」尤其怕丢更新）。
 *
 * 调用方传入的路径一律是**绝对路径**（Write/Edit 先 `resolveToCwd`），
 * 因此 env 的 `cwd` 只作为相对路径的兜底基准。
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/harness/env/nodejs'
import { withFileMutationQueue as withPiFileMutationQueue } from '@earendil-works/pi-agent-core/harness/tools/file-mutation-queue'

let sharedEnv: NodeExecutionEnv | undefined

function executionEnv(): NodeExecutionEnv {
  sharedEnv ??= new NodeExecutionEnv({ cwd: process.cwd() })
  return sharedEnv
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const context: Context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT
  return withPiFileMutationQueue(executionEnv(), filePath, fn, context)
}
