/**
 * 图片缩放 Worker 入口（移植自 pi/packages/coding-agent/src/utils/image-resize-worker.ts）。
 *
 * 只负责「收一条消息 → 跑 resizeImageInProcess → 回一条消息」，
 * 把 WASM 解码 / 缩放 / 编码的 CPU 忙等挪出主线程（TUI 渲染不能被它卡住）。
 */

import { parentPort } from 'node:worker_threads'
import {
  resizeImageInProcess,
  type ImageResizeOptions,
  type ResizedImage,
} from './image-resize-core.js'

interface ResizeImageWorkerRequest {
  inputBytes: Uint8Array
  mimeType: string
  options?: ImageResizeOptions
}

interface ResizeImageWorkerResponse {
  result?: ResizedImage | null
  error?: string
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.inputBytes instanceof Uint8Array && typeof record.mimeType === 'string'
}

const port = parentPort
if (!port) {
  throw new Error('image resize worker requires parentPort')
}

port.once('message', (message: unknown) => {
  void (async () => {
    try {
      if (!isResizeImageWorkerRequest(message)) {
        throw new Error('Invalid image resize worker request')
      }
      const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options)
      const response: ResizeImageWorkerResponse = { result }
      port.postMessage(response)
    } catch (error) {
      const response: ResizeImageWorkerResponse = {
        error: error instanceof Error ? error.message : String(error),
      }
      port.postMessage(response)
    }
  })()
})
