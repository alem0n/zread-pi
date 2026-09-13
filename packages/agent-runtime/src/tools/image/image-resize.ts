/**
 * 图片缩放入口（移植自 pi/packages/coding-agent/src/utils/image-resize.ts）。
 *
 * 优先在 Worker 线程里跑 photon（WASM 解码 / 缩放 / 编码不阻塞 TUI 事件循环）；
 * Worker 起不来（打包产物里 worker 文件缺失、运行时不支持等）时退回进程内实现，
 * 保证「图片读取仍然可用」，只是会短暂阻塞主线程。
 */

import { Worker } from 'node:worker_threads'
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from './image-resize-core.js'

export type { ImageResizeOptions, ResizedImage } from './image-resize-core.js'

interface ResizeImageWorkerResponse {
  result?: ResizedImage | null
  error?: string
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  // transfer 会 detach 原 buffer，因此复制一份给 worker，调用方的字节保持可用
  return new Uint8Array(input)
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
  return value !== null && typeof value === 'object'
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
  return new Worker(workerSpecifier)
}

async function resizeImageInWorker(
  workerSpecifier: string | URL,
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const worker = createResizeWorker(workerSpecifier)
  try {
    const inputBytesForWorker = toTransferableBytes(inputBytes)
    return await new Promise<ResizedImage | null>((resolve, reject) => {
      let settled = false
      const settle = (result: ResizedImage | null): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }

      worker.once('message', (message: unknown) => {
        if (!isResizeImageWorkerResponse(message)) {
          fail(new Error('Invalid image resize worker response'))
          return
        }
        if (message.error) {
          fail(new Error(message.error))
          return
        }
        settle(message.result ?? null)
      })
      worker.once('error', fail)
      worker.once('exit', (code) => {
        if (!settled) {
          fail(new Error(`Image resize worker exited with code ${code}`))
        }
      })
      worker.postMessage(
        {
          inputBytes: inputBytesForWorker,
          mimeType,
          options,
        },
        [inputBytesForWorker.buffer],
      )
    })
  } finally {
    void worker.terminate().catch(() => undefined)
  }
}

/**
 * 把图片压到 2000×2000 / 4.5MB base64 以内（默认值，可由 options 覆盖）。
 *
 * 返回 null 表示无法压到限制内（或 photon 不可用）；调用方据此降级为文本说明。
 */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const isTypeScriptRuntime = import.meta.url.endsWith('.ts')
  const workerUrl = new URL(
    isTypeScriptRuntime ? './image-resize-worker.ts' : './image-resize-worker.js',
    import.meta.url,
  )

  // 与上游的差异：pi 还会在 Bun 下先试一个相对仓库源码的字符串路径
  // （`./src/utils/image-resize-worker.ts`）。zread-pi 的工作目录是**被生成文档的目标仓库**，
  // 该相对路径没有意义，因此只保留「基于 import.meta.url 的 URL」这一条路径；
  // 打包产物里 worker 文件不存在时会自然落到进程内兜底（能力不降级）。
  try {
    return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options)
  } catch {
    return resizeImageInProcess(inputBytes, mimeType, options)
  }
}

/**
 * 生成「坐标映射」提示：图片被缩放过时告诉模型按比例换算坐标。
 * 这让模型对截图中的像素坐标（如点击位置）仍能对应到原图。
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined
  }

  const scale = result.originalWidth / result.width
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
}
