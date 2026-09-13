/**
 * 跨进程文件锁（移植自 pi/packages/coding-agent/src/core/settings-manager.ts 的
 * `FileSettingsStorage.withLock` 思路，底层用同一个 `proper-lockfile`）。
 *
 * 为什么需要：项目家目录（`~/.zread-pi`）下的 config.yaml / auth.json / tools-state.json /
 * history 会被 TUI 配置界面、`Models.login()`、`tools:install`、`zread-pi history` 以及
 * **并行的多个 CLI 实例**读写。进程内串行化（Promise 链 / 每 Provider 队列）挡不住跨进程，
 * 而 writeFile 既非原子也可能互相覆盖 —— 这里用 `<file>.lock` 目录锁把
 * 「读-改-写」包成临界区，再配合临时文件 + rename 原子替换，避免半截文件。
 *
 * 语义与 pi 保持一致：
 *  - 只锁文件本身（`realpath: false`），文件不存在也能先加锁再创建；
 *  - 获取锁失败（`ELOCKED`）时按固定间隔重试若干次，仍失败才抛错；
 *  - 锁在进程异常退出后会因 stale 超时被自动回收（proper-lockfile 内建）。
 */

import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

/** 获取锁的最大尝试次数（含首次）与每次间隔（毫秒） */
const LOCK_MAX_ATTEMPTS = 10
const LOCK_RETRY_DELAY_MS = 20

function lockErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function sleepSync(ms: number): void {
  const start = Date.now()
  while (Date.now() - start < ms) {
    // 同步等待：锁是短临界区，且调用方（如配置写入）本身是同步 API
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 同步获取文件锁；返回释放函数。
 *
 * 目录不存在时先创建（锁文件 `<path>.lock` 需要父目录存在）。
 */
export function acquireFileLockSync(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true })

  let lastError: unknown
  for (let attempt = 1; attempt <= LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false })
    } catch (error) {
      if (lockErrorCode(error) !== 'ELOCKED' || attempt === LOCK_MAX_ATTEMPTS) {
        throw error
      }
      lastError = error
      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }

  throw (lastError as Error) ?? new Error(`Failed to acquire file lock: ${path}`)
}

/** 异步获取文件锁；返回释放函数（不阻塞事件循环）。 */
export async function acquireFileLock(path: string): Promise<() => void> {
  await mkdir(dirname(path), { recursive: true })

  let lastError: unknown
  for (let attempt = 1; attempt <= LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      return await lockfile.lock(path, { realpath: false })
    } catch (error) {
      if (lockErrorCode(error) !== 'ELOCKED' || attempt === LOCK_MAX_ATTEMPTS) {
        throw error
      }
      lastError = error
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }

  throw (lastError as Error) ?? new Error(`Failed to acquire file lock: ${path}`)
}

/**
 * 在文件锁保护下执行同步动作（获取 → 执行 → 释放，异常也会释放）。
 *
 * 锁获取失败会向上抛错：调用方应把它当作「写入失败」处理（如 saveConfig 的返回 false）。
 * 锁不可用时退化为无锁执行是危险的（并发写没有保护），因此这里选择失败而不是静默降级。
 */
export function withFileLockSync<T>(path: string, fn: () => T): T {
  const release = acquireFileLockSync(path)
  try {
    return fn()
  } finally {
    release()
  }
}

/** 在文件锁保护下执行异步动作（获取 → 执行 → 释放，异常也会释放）。 */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireFileLock(path)
  try {
    return await fn()
  } finally {
    release()
  }
}
