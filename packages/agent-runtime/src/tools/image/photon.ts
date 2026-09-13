/**
 * Photon 图片处理封装（移植自 pi/packages/coding-agent/src/utils/photon.ts）。
 *
 * 目的：让 `@silvia-odwyer/photon-node`（Rust/WASM）在两种运行方式下都能加载：
 *  1. Node / Bun 直接从 node_modules 运行（开发与 `bun run cli`）；
 *  2. Bun compile 出的独立二进制（wasm 由构建脚本复制到可执行文件旁）。
 *
 * photon-node 的 CJS 入口用 `fs.readFileSync(__dirname + '/photon_rs_bg.wasm')` 取 wasm，
 * 该路径会被 Bun 编译产物固化成构建机的绝对路径；这里的兜底补丁在 ENOENT 时
 * 依次尝试「可执行文件目录 / 可执行文件目录/photon / 当前工作目录」，找不到才抛出原错误。
 *
 * 与上游保持一致的语义：加载失败返回 null（调用方退回「不处理/文本说明」的降级路径），
 * 绝不因为图片能力不可用而让整个 Agent 失败。
 */

import type { PathOrFileDescriptor } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')

export type { PhotonImage as PhotonImageType } from '@silvia-odwyer/photon-node'

type ReadFileSync = typeof fs.readFileSync

const WASM_FILENAME = 'photon_rs_bg.wasm'

let photonModule: typeof import('@silvia-odwyer/photon-node') | null = null
let loadPromise: Promise<typeof import('@silvia-odwyer/photon-node') | null> | null = null

function pathOrNull(file: PathOrFileDescriptor): string | null {
  if (typeof file === 'string') return file
  if (file instanceof URL) return fileURLToPath(file)
  return null
}

function getFallbackWasmPaths(): string[] {
  const execDir = path.dirname(process.execPath)
  return [
    path.join(execDir, WASM_FILENAME),
    path.join(execDir, 'photon', WASM_FILENAME),
    path.join(process.cwd(), WASM_FILENAME),
  ]
}

function patchPhotonWasmRead(): () => void {
  const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs)
  const fallbackPaths = getFallbackWasmPaths()
  const mutableFs = fs as { readFileSync: ReadFileSync }

  const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
    const [file, options] = args
    const resolvedPath = pathOrNull(file)

    if (resolvedPath?.endsWith(WASM_FILENAME)) {
      try {
        return originalReadFileSync(...args)
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err?.code && err.code !== 'ENOENT') {
          throw error
        }

        for (const fallbackPath of fallbackPaths) {
          if (!fs.existsSync(fallbackPath)) continue
          if (options === undefined) {
            return originalReadFileSync(fallbackPath)
          }
          return originalReadFileSync(fallbackPath, options)
        }

        throw error
      }
    }

    return originalReadFileSync(...args)
  }) as ReadFileSync

  try {
    mutableFs.readFileSync = patchedReadFileSync
  } catch {
    Object.defineProperty(fs, 'readFileSync', {
      value: patchedReadFileSync,
      writable: true,
      configurable: true,
    })
  }

  return () => {
    try {
      mutableFs.readFileSync = originalReadFileSync
    } catch {
      Object.defineProperty(fs, 'readFileSync', {
        value: originalReadFileSync,
        writable: true,
        configurable: true,
      })
    }
  }
}

/**
 * 异步加载 photon 模块，后续调用命中缓存。
 *
 * 失败（未安装 / wasm 加载失败 / 运行时不支持）返回 null，由调用方降级。
 */
export async function loadPhoton(): Promise<typeof import('@silvia-odwyer/photon-node') | null> {
  if (photonModule) {
    return photonModule
  }

  if (loadPromise) {
    return loadPromise
  }

  loadPromise = (async () => {
    const restoreReadFileSync = patchPhotonWasmRead()
    try {
      photonModule = await import('@silvia-odwyer/photon-node')
      return photonModule
    } catch {
      photonModule = null
      return photonModule
    } finally {
      restoreReadFileSync()
    }
  })()

  return loadPromise
}
