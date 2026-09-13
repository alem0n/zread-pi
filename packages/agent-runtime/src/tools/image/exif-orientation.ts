/**
 * EXIF 方向矫正（移植自 pi/packages/coding-agent/src/utils/exif-orientation.ts）。
 *
 * 手机截图 / 相机照片的 JPEG、WebP 常带 EXIF Orientation：像素数据本身是旋转过的，
 * 靠 EXIF 标签告诉查看器转多少度。直接送去 resize 会得到躺倒/镜像的图片，
 * 因此这里先解析 EXIF，再让 photon 把像素真正旋转过来。
 *
 * 只处理 JPEG（APP1 段）与 WebP（EXIF chunk），其余格式返回原图；
 * 解析失败一律退回 orientation=1（不转），绝不因坏 EXIF 让图片读取失败。
 */

import type { PhotonImageType } from './photon.js'

type Photon = typeof import('@silvia-odwyer/photon-node')

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
  if (tiffStart + 8 > bytes.length) return 1

  const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1]
  const le = byteOrder === 0x4949

  const read16 = (pos: number): number => {
    if (le) return bytes[pos] | (bytes[pos + 1] << 8)
    return (bytes[pos] << 8) | bytes[pos + 1]
  }

  const read32 = (pos: number): number => {
    if (le) return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)
    return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0
  }

  const ifdOffset = read32(tiffStart + 4)
  const ifdStart = tiffStart + ifdOffset
  if (ifdStart + 2 > bytes.length) return 1

  const entryCount = read16(ifdStart)
  for (let i = 0; i < entryCount; i++) {
    const entryPos = ifdStart + 2 + i * 12
    if (entryPos + 12 > bytes.length) return 1

    if (read16(entryPos) === 0x0112) {
      const value = read16(entryPos + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }

  return 1
}

function findJpegTiffOffset(bytes: Uint8Array): number {
  let offset = 2
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) return -1
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }

    if (marker === 0xe1) {
      if (offset + 4 >= bytes.length) return -1
      const segmentStart = offset + 4
      if (segmentStart + 6 > bytes.length) return -1
      if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6
    }

    if (offset + 4 > bytes.length) return -1
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    offset += 2 + length
  }

  return -1
}

function findWebpTiffOffset(bytes: Uint8Array): number {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const chunkSize =
      bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)
    const dataStart = offset + 8

    if (chunkId === 'EXIF') {
      if (dataStart + chunkSize > bytes.length) return -1
      // 部分 WebP 文件在 TIFF 头前有 "Exif\0\0" 前缀
      const tiffStart = chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart
      return tiffStart
    }

    // RIFF chunk 按偶数长度对齐
    offset = dataStart + chunkSize + (chunkSize % 2)
  }

  return -1
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === 0x45 &&
    bytes[offset + 1] === 0x78 &&
    bytes[offset + 2] === 0x69 &&
    bytes[offset + 3] === 0x66 &&
    bytes[offset + 4] === 0x00 &&
    bytes[offset + 5] === 0x00
  )
}

function getExifOrientation(bytes: Uint8Array): number {
  let tiffOffset = -1

  // JPEG: FF D8 开头
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    tiffOffset = findJpegTiffOffset(bytes)
  }
  // WebP: RIFF....WEBP 开头
  else if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    tiffOffset = findWebpTiffOffset(bytes)
  }

  if (tiffOffset === -1) return 1
  return readOrientationFromTiff(bytes, tiffOffset)
}

type DstIndexFn = (x: number, y: number, w: number, h: number) => number

function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
  const w = image.get_width()
  const h = image.get_height()
  const src = image.get_raw_pixels()
  const dst = new Uint8Array(src.length)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4
      const dstIdx = dstIndex(x, y, w, h) * 4
      dst[dstIdx] = src[srcIdx]
      dst[dstIdx + 1] = src[srcIdx + 1]
      dst[dstIdx + 2] = src[srcIdx + 2]
      dst[dstIdx + 3] = src[srcIdx + 3]
    }
  }

  return new photon.PhotonImage(dst, h, w)
}

/**
 * 按 EXIF Orientation 矫正图片。
 *
 * flip 类方向原地修改并返回原图；rotate 类方向返回新图，调用方必须在返回值与原图不同时释放原图。
 */
export function applyExifOrientation(
  photon: Photon,
  image: PhotonImageType,
  originalBytes: Uint8Array,
): PhotonImageType {
  const orientation = getExifOrientation(originalBytes)
  if (orientation === 1) return image

  switch (orientation) {
    case 2:
      photon.fliph(image)
      return image
    case 3:
      photon.fliph(image)
      photon.flipv(image)
      return image
    case 4:
      photon.flipv(image)
      return image
    case 5: {
      const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y))
      photon.fliph(rotated)
      return rotated
    }
    case 6:
      return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y))
    case 7: {
      const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y)
      photon.fliph(rotated)
      return rotated
    }
    case 8:
      return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y)
    default:
      return image
  }
}
