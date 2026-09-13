/**
 * 图片处理管线（移植自 pi/packages/coding-agent/src/utils/image-process.ts）。
 *
 * `Read` 工具把图片交给这里的唯一入口 `processImage()`，管线做三件事：
 *  1. 归一化格式：png/jpeg/gif/webp 原样放行；其余（BMP/TIFF 等）用 photon 转 PNG；
 *  2. 自动缩放：默认压到 2000×2000 / 4.5MB base64 以内，避免大图烧 token / 被 provider 拒收；
 *  3. 生成提示：格式转换说明 + 缩放后的坐标映射说明（不改变模型看到的图片内容）。
 *
 * 处理失败时不抛错，而是返回 `{ ok: false, message }`，由调用方回退成文本说明——
 * 图片读不了不应该让整个工具调用失败。
 */

import { convertImageBytesToPng } from './image-convert.js'
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from './image-resize.js'

export interface ProcessImageOptions {
  /** 是否缩放到 provider 内联限制内。默认：true */
  autoResizeImages?: boolean
  /** 缩放参数覆盖；缺省用 resizeImage 的默认值（2000×2000 / 4.5MB / JPEG 80） */
  resizeOptions?: ImageResizeOptions
}

export type ProcessImageResult =
  | {
      ok: true
      data: string
      mimeType: string
      hints: string[]
    }
  | {
      ok: false
      message: string
    }

interface NormalizedImage {
  bytes: Uint8Array
  mimeType: string
  convertedFrom?: string
}

function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType.toLowerCase()
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
  switch (baseMimeType(mimeType)) {
    case 'image/png':
      return 'image/png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg'
    case 'image/gif':
      return 'image/gif'
    case 'image/webp':
      return 'image/webp'
    default:
      return null
  }
}

async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage | null> {
  const normalizedMimeType = normalizeSupportedImageMimeType(mimeType)
  if (normalizedMimeType) {
    return { bytes, mimeType: normalizedMimeType }
  }

  const pngBytes = await convertImageBytesToPng(bytes)
  if (!pngBytes) {
    return null
  }

  return {
    bytes: pngBytes,
    mimeType: 'image/png',
    convertedFrom: baseMimeType(mimeType),
  }
}

function conversionHint(from: string | undefined, to: string): string | undefined {
  if (!from || from === to) return undefined
  return `[Image converted from ${from} to ${to}.]`
}

/**
 * 处理一张待内联回传的图片。
 *
 * 成功时 `data` 是 base64、`mimeType` 是归一化后的格式、`hints` 是需要拼进文本说明的提示；
 * 失败时 `message` 是给模型的降级说明。
 */
export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  const autoResizeImages = options?.autoResizeImages ?? true
  const normalized = await normalizeImage(bytes, mimeType)
  if (!normalized) {
    return {
      ok: false,
      message: '[Image omitted: could not be converted to a supported inline image format.]',
    }
  }

  if (autoResizeImages) {
    const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions)
    if (!resized) {
      return {
        ok: false,
        message: '[Image omitted: could not be resized below the inline image size limit.]',
      }
    }

    const hints: string[] = []
    const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType)
    if (convertedHint) hints.push(convertedHint)
    const dimensionNote = formatDimensionNote(resized)
    if (dimensionNote) hints.push(dimensionNote)

    return {
      ok: true,
      data: resized.data,
      mimeType: resized.mimeType,
      hints,
    }
  }

  const hints: string[] = []
  const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType)
  if (convertedHint) hints.push(convertedHint)

  return {
    ok: true,
    data: Buffer.from(normalized.bytes).toString('base64'),
    mimeType: normalized.mimeType,
    hints,
  }
}
