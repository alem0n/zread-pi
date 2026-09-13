/**
 * 图片缩放核心（移植自 pi/packages/coding-agent/src/utils/image-resize-core.ts）。
 *
 * 目标：把图片压到「provider 能内联接收」的尺寸与体积，省 token、避免请求被拒：
 *  1. 尺寸上限默认 2000×2000（超出按比例缩放）；
 *  2. base64 体积上限默认 4.5MB（低于 Anthropic 的 5MB 硬限，留出余量）；
 *  3. 先试 PNG，再试多档 JPEG 质量，仍超标就按 0.75 逐级缩小，直到 1×1 或放弃。
 *
 * 全部处理交给 photon（Rust/WASM）；photon 不可用时返回 null（调用方降级）。
 *
 * 本文件是**同步 CPU 密集**实现：由 `image-resize.ts` 放进 Worker 线程执行，
 * 避免阻塞 TUI 事件循环；Worker 不可用时退回进程内调用。
 */

import { applyExifOrientation } from './exif-orientation.js'
import { loadPhoton } from './photon.js'

export interface ImageResizeOptions {
  /** 最大宽度（默认 2000） */
  maxWidth?: number
  /** 最大高度（默认 2000） */
  maxHeight?: number
  /** base64 体积上限（默认 4.5MB，低于 Anthropic 的 5MB 限制） */
  maxBytes?: number
  /** 初始 JPEG 质量（默认 80） */
  jpegQuality?: number
}

export interface ResizedImage {
  /** base64 编码后的图片数据 */
  data: string
  mimeType: string
  originalWidth: number
  originalHeight: number
  width: number
  height: number
  wasResized: boolean
}

// 4.5MB 的 base64 体积，给 Anthropic 的 5MB 硬限留余量
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: DEFAULT_MAX_BYTES,
  jpegQuality: 80,
}

interface EncodedCandidate {
  data: string
  encodedSize: number
  mimeType: string
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
  const data = Buffer.from(buffer).toString('base64')
  return {
    data,
    encodedSize: Buffer.byteLength(data, 'utf-8'),
    mimeType,
  }
}

/**
 * 在进程内缩放图片（CPU 密集，Worker 不可用时的兜底路径）。
 *
 * 返回 null 表示「无法压到 maxBytes 以内」或 photon 不可用；调用方据此降级。
 */
export async function resizeImageInProcess(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4

  const photon = await loadPhoton()
  if (!photon) {
    return null
  }

  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes)
    image = applyExifOrientation(photon, rawImage, inputBytes)
    if (image !== rawImage) rawImage.free()

    const originalWidth = image.get_width()
    const originalHeight = image.get_height()
    const format = mimeType.split('/')[1] ?? 'png'

    // 尺寸与体积都已达标：原样返回（不重新编码，避免无谓的质量损失）
    if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
      return {
        data: Buffer.from(inputBytes).toString('base64'),
        mimeType: mimeType || `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      }
    }

    // 按上限等比计算目标尺寸
    let targetWidth = originalWidth
    let targetHeight = originalHeight

    if (targetWidth > opts.maxWidth) {
      targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth)
      targetWidth = opts.maxWidth
    }
    if (targetHeight > opts.maxHeight) {
      targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight)
      targetHeight = opts.maxHeight
    }

    function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
      const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3)

      try {
        const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), 'image/png')]
        for (const quality of jpegQualities) {
          candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), 'image/jpeg'))
        }
        return candidates
      } finally {
        resized.free()
      }
    }

    const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]))
    let currentWidth = targetWidth
    let currentHeight = targetHeight

    while (true) {
      const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps)
      for (const candidate of candidates) {
        if (candidate.encodedSize < opts.maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width: currentWidth,
            height: currentHeight,
            wasResized: true,
          }
        }
      }

      if (currentWidth === 1 && currentHeight === 1) {
        break
      }

      const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75))
      const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75))
      if (nextWidth === currentWidth && nextHeight === currentHeight) {
        break
      }

      currentWidth = nextWidth
      currentHeight = nextHeight
    }

    return null
  } catch {
    return null
  } finally {
    if (image) {
      image.free()
    }
  }
}
