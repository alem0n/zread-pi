/**
 * 图片格式转换（移植自 pi/packages/coding-agent/src/utils/image-convert.ts）。
 *
 * provider 只接受 png / jpeg / gif / webp 四种内联格式；
 * 其他能解码的格式（典型是 BMP、TIFF）统一转成 PNG 后再回传，而不是直接拒绝。
 */

import { applyExifOrientation } from './exif-orientation.js'
import { loadPhoton } from './photon.js'

/** 把任意 photon 能解码的图片字节转成 PNG；失败（含 photon 不可用）返回 null。 */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const photon = await loadPhoton()
  if (!photon) {
    // photon 不可用，无法转换
    return null
  }

  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(bytes)
    const image = applyExifOrientation(photon, rawImage, bytes)
    if (image !== rawImage) rawImage.free()
    try {
      return new Uint8Array(image.get_bytes())
    } finally {
      image.free()
    }
  } catch {
    // 转换失败
    return null
  }
}

/**
 * 把 base64 图片转成 PNG（终端 Kitty 图形协议要求 PNG，f=100）。
 * 已是 PNG 时原样返回。
 */
export async function convertToPng(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (mimeType === 'image/png') {
    return { data: base64Data, mimeType }
  }

  const bytes = new Uint8Array(Buffer.from(base64Data, 'base64'))
  const pngBytes = await convertImageBytesToPng(bytes)
  if (!pngBytes) {
    return null
  }

  return {
    data: Buffer.from(pngBytes).toString('base64'),
    mimeType: 'image/png',
  }
}
