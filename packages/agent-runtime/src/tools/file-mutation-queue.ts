/**
 * 同文件写操作串行化
 *
 * 从上游移植：`pi/packages/agent/src/harness/tools/file-mutation-queue.ts`
 * （与 `coding-agent/src/core/tools/file-mutation-queue.ts` 同源）。
 *
 * 为什么必须移植：本仓库的 Wiki 页面是**并行生成**的（p-limit 并发），
 * 多个子 Agent 会对同一批文件发 Read/Write/Edit。同一文件的写-写竞争会导致
 * 「读-改-写」丢更新（Edit 尤其明显：读到 v1、另一个写者写 v2、再把 v1 的修改写回 → v2 丢失）。
 * 这里按「真实路径（realpath 解析软链接）」排队，不同文件仍然并行。
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

const fileMutationQueues = new Map<string, Promise<void>>()
let registrationQueue = Promise.resolve()

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error.code === 'ENOENT' || error.code === 'ENOTDIR')
	)
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath)
	try {
		return await realpath(resolvedPath)
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath
		}
		throw error
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath)
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve()

		let releaseNext!: () => void
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue
		})
		const chainedQueue = currentQueue.then(() => nextQueue)
		fileMutationQueues.set(key, chainedQueue)

		return { key, currentQueue, chainedQueue, releaseNext }
	})
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	)

	const { key, currentQueue, chainedQueue, releaseNext } = await registration
	await currentQueue
	try {
		return await fn()
	} finally {
		releaseNext()
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key)
		}
	}
}
