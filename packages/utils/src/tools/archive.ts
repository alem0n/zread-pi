/**
 * 归档解包（纯 JS，无外部命令依赖）
 *
 * 为什么不用上游那套 `tar` / `unzip` / PowerShell `Expand-Archive`：
 *  - 三平台上最容易失败的正是这一段（上游为此写了 4 个回退分支）；
 *  - 本仓库总则要求跨平台等价可用，不应把「装工具」成功与否交给系统里是否有 unzip；
 *  - gzip 与 deflate 都能用 Node 内置的 `zlib` 完成，tar / zip 的容器格式本身很简单。
 *
 * 支持：`.tar.gz`（ustar + GNU LongName）与 `.zip`（stored / deflate）。
 * 安全：所有条目都做 zip-slip 校验（拒绝绝对路径、盘符、`..` 越界），
 * 解包目标被严格限制在传入的目录内。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export interface ExtractedEntry {
  /** 归档内的原始条目名 */
  name: string
  /** 落盘后的绝对路径 */
  path: string
  bytes: number
}

// ---------------------------------------------------------------------------
// 条目名校验（zip-slip 防护）
// ---------------------------------------------------------------------------

/**
 * 把归档条目名归一化成「相对目标目录的安全路径」。
 * 非法条目（绝对路径 / 盘符 / 越界 / 空）返回 null，由调用方跳过。
 */
export function safeEntryPath(rawName: string): string | null {
  if (!rawName) return null
  const normalizedSeparators = rawName.replace(/\\/g, '/')
  if (normalizedSeparators.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalizedSeparators)) return null

  const segments = normalizedSeparators.split('/')
  const safeSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    safeSegments.push(segment)
  }
  if (safeSegments.length === 0) return null
  return safeSegments.join('/')
}

// ---------------------------------------------------------------------------
// tar(.gz)
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size: number
  dataStart: number
  mode: number
}

function readString(buffer: Uint8Array, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  const bytes = end === -1 ? slice : slice.subarray(0, end)
  return Buffer.from(bytes).toString('utf-8')
}

function readOctal(buffer: Uint8Array, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim()
  if (text.length === 0) return 0
  return Number.parseInt(text, 8) || 0
}

const TAR_BLOCK = 512

/** 解析 tar 字节流（不含 gzip 解压）。 */
export function parseTarEntries(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let pendingLongName: string | undefined

  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // 两个连续的全零块表示归档结束；这里遇到一个全零块就收尾
    if (header.every((byte) => byte === 0)) break

    const rawName = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const prefix = readString(header, 345, 155)
    const mode = readOctal(header, 100, 8)
    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) {
      throw new ArchiveError('tar 归档已损坏：条目数据超出文件范围')
    }

    // GNU LongName：真实文件名放在随后的数据块里
    if (typeflag === 'L') {
      pendingLongName = readString(buffer, dataStart, size)
    } else {
      const ustarName = prefix ? `${prefix}/${rawName}` : rawName
      const name = pendingLongName ?? ustarName
      pendingLongName = undefined
      entries.push({
        name,
        type: typeflag === '5' ? 'directory' : typeflag === '0' || typeflag === '\0' || typeflag === '' ? 'file' : 'other',
        size,
        dataStart,
        mode,
      })
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return entries
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50

function readUint16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8)
}

function readUint32(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8) | ((buffer[offset + 2] ?? 0) << 16)) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  )
}

function findEndOfCentralDirectory(buffer: Uint8Array): number {
  const minimum = 22
  if (buffer.length < minimum) throw new ArchiveError('zip 归档已损坏：文件过小')
  const earliest = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - minimum; offset >= earliest; offset--) {
    if (readUint32(buffer, offset) === ZIP_EOCD_SIGNATURE) return offset
  }
  throw new ArchiveError('zip 归档已损坏：找不到中央目录')
}

/** 解析 zip 的中央目录（不负责解压条目数据）。 */
export function parseZipEntries(buffer: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = readUint16(buffer, eocd + 10)
  const centralOffset = readUint32(buffer, eocd + 16)
  const centralSize = readUint32(buffer, eocd + 12)

  // zip64：这两个字段会被写成 0xFFFFFFFF，需要从 zip64 记录里读（rg/fd 资产用不到）
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff || entryCount === 0xffff) {
    throw new ArchiveError('zip 归档使用了 zip64 扩展（暂不支持）')
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ArchiveError('zip 归档已损坏：中央目录越界')
  }

  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || readUint32(buffer, offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ArchiveError('zip 归档已损坏：中央目录条目签名不匹配')
    }
    const method = readUint16(buffer, offset + 10)
    const compressedSize = readUint32(buffer, offset + 20)
    const nameLength = readUint16(buffer, offset + 28)
    const extraLength = readUint16(buffer, offset + 30)
    const commentLength = readUint16(buffer, offset + 32)
    const localHeaderOffset = readUint32(buffer, offset + 42)
    const name = Buffer.from(buffer.subarray(offset + 46, offset + 46 + nameLength)).toString('utf-8')

    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntryData(buffer: Uint8Array, entry: ZipEntry): Uint8Array {
  const local = entry.localHeaderOffset
  if (local + 30 > buffer.length || readUint32(buffer, local) !== ZIP_LOCAL_SIGNATURE) {
    throw new ArchiveError(`zip 归档已损坏：条目 ${entry.name} 的本地头无效`)
  }
  const nameLength = readUint16(buffer, local + 26)
  const extraLength = readUint16(buffer, local + 28)
  const dataStart = local + 30 + nameLength + extraLength
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return data
  if (entry.method === 8) {
    try {
      return inflateRawSync(data)
    } catch (error) {
      throw new ArchiveError(
        `zip 归档已损坏：条目 ${entry.name} 解压失败（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }
  throw new ArchiveError(`zip 归档使用了不支持的压缩方式：${entry.method}`)
}

// ---------------------------------------------------------------------------

export type ArchiveKind = 'tar.gz' | 'zip'

/**
 * 解包归档到 `destDir`，返回落盘的文件条目。
 * 目录条目会被创建但不返回；非法条目（越界路径）被跳过。
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  kind: ArchiveKind,
): Promise<ExtractedEntry[]> {
  const raw = await readFile(archivePath)
  const destination = resolve(destDir)
  await mkdir(destination, { recursive: true })

  const extracted: ExtractedEntry[] = []
  const writeEntry = async (name: string, data: Uint8Array, mode?: number): Promise<void> => {
    const relative = safeEntryPath(name)
    if (!relative) return
    const target = resolve(join(destination, ...relative.split(posix.sep)))
    // 双保险：解析后的路径必须仍在目标目录内
    if (target !== destination && !target.startsWith(destination + sep)) return
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data, mode && mode > 0 ? { mode } : undefined)
    extracted.push({ name, path: target, bytes: data.byteLength })
  }

  if (kind === 'tar.gz') {
    const tar = gunzipSync(raw)
    for (const entry of parseTarEntries(tar)) {
      if (entry.type === 'directory') {
        const relative = safeEntryPath(entry.name)
        if (relative) await mkdir(resolve(join(destination, ...relative.split(posix.sep))), { recursive: true })
        continue
      }
      if (entry.type !== 'file') continue
      // 可执行位（0o755）由安装流程统一设置，这里保留归档里的权限位即可
      await writeEntry(entry.name, tar.subarray(entry.dataStart, entry.dataStart + entry.size), entry.mode)
    }
    return extracted
  }

  const entries = parseZipEntries(raw)
  for (const entry of entries) {
    if (entry.name.endsWith('/')) {
      const relative = safeEntryPath(entry.name)
      if (relative) await mkdir(resolve(join(destination, ...relative.split(posix.sep))), { recursive: true })
      continue
    }
    await writeEntry(entry.name, readZipEntryData(raw, entry))
  }
  return extracted
}
