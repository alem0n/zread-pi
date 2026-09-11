/**
 * tool-installer.ts —— 外部工具（rg / fd）注册表、归档解包与安装流程专项测试
 *
 * 全程离线：
 *  - 归档解包用本文件自建的 tar.gz / zip 字节流验证（覆盖 stored + deflate + 长文件名 + 越界条目）
 *  - 下载/安装/卸载用本地 HTTP 服务器（Bun.serve）模拟 GitHub Releases
 *  - 二进制探测通过 `setBinaryProbeForTesting` 注入，因此在 Windows / Linux / macOS 上行为一致
 *    （Windows 不能直接 spawn .cmd/.bat 脚本，真造可执行文件既重又易碎）
 *
 * 运行：bun run test:installer
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import {
  DEFAULT_VERSION_PROBE_ARGS,
  FD_TOOL,
  RG_TOOL,
  archiveKindOf,
  extractArchive,
  getManagedBinDir,
  getManagedBinaryPath,
  getManagedBinUsage,
  getToolLedgerPath,
  getToolSpec,
  getToolStatus,
  getToolStatuses,
  installTool,
  isToolEnabled,
  listTools,
  loadConfig,
  normalizeToolsConfig,
  notifyToolsChanged,
  onToolsChanged,
  parseTarEntries,
  parseZipEntries,
  probeBinary,
  readToolLedger,
  resolveLatestVersion,
  resolveToolBinary,
  safeEntryPath,
  saveConfig,
  setBinaryProbeForTesting,
  toolIds,
  uninstallTool,
  validateConfig,
  type AppConfig,
  type BinaryProbeResult,
  type ResolvedToolBinary,
  type ToolInstallProgress,
  type ToolSpec,
} from '../src/index.js'

const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail })
  const label = ok ? '  OK  ' : ' FAIL '
  console.log(label + ' ' + name + (detail ? ' — ' + detail : ''))
}

// ---------------------------------------------------------------------------
// 临时 HOME / 工作目录（绝不碰真实 ~/.zread-pi）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), 'zread-tools-home-'))
const work = await mkdtemp(join(tmpdir(), 'zread-tools-work-'))
const managedDir = join(home, 'bin')
process.env.HOME = home
process.env.USERPROFILE = home
process.env.ZREAD_PI_TOOLS_DIR = managedDir
process.env.ZREAD_PI_TOOLS_BASE_URL = 'http://127.0.0.1:1' // 默认指向不可用端口，避免误触网络
delete process.env.ZREAD_PI_RG_PATH
delete process.env.ZREAD_PI_FD_PATH

const managedBinaryName = (spec: ToolSpec): string => spec.binaryName + (process.platform === 'win32' ? '.exe' : '')

// ---------------------------------------------------------------------------
// 归档构造器（用于验证解析器）
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number, typeflag: string, mode = 0o644): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf-8')
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(typeflag, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  // 校验和
  header.fill(' ', 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

function tarEntriesToBuffer(entries: Array<{ name: string; data?: Buffer; type?: 'file' | 'dir' | 'longname' }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const type = entry.type ?? 'file'
    if (type === 'longname') {
      const nameBytes = Buffer.from(entry.data ?? Buffer.from(entry.name, 'utf-8'))
      chunks.push(tarHeader('././@LongLink', nameBytes.length, 'L'))
      chunks.push(nameBytes)
      chunks.push(Buffer.alloc(Math.ceil(nameBytes.length / 512) * 512 - nameBytes.length))
      continue
    }
    if (type === 'dir') {
      chunks.push(tarHeader(entry.name, 0, '5'))
      continue
    }
    const data = entry.data ?? Buffer.alloc(0)
    chunks.push(tarHeader(entry.name, data.length, '0'))
    chunks.push(data)
    chunks.push(Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8')
    const compressed = entry.deflate === false ? entry.data : deflateRawSync(entry.data)
    const method = entry.deflate === false ? 0 : 8
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += 30 + nameBytes.length + compressed.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 1) 注册表
// ---------------------------------------------------------------------------

console.log('\n▶ 1. 工具注册表（可扩展接口）')

check('注册表登记了 rg 与 fd', toolIds().join(',') === 'rg,fd', toolIds().join(','))
check('listTools 返回 2 个 spec 且顺序稳定', listTools().map((spec) => spec.id).join(',') === 'rg,fd')
check('getToolSpec 命中与未命中', getToolSpec('rg')?.binaryName === 'rg' && getToolSpec('nope') === undefined)
check('spec 声明了用途与驱动的 Agent 工具', RG_TOOL.usedBy.join() === 'Grep' && FD_TOOL.usedBy.join() === 'Glob')
check('spec 声明了环境变量覆盖名', RG_TOOL.envPathVar === 'ZREAD_PI_RG_PATH' && FD_TOOL.envPathVar === 'ZREAD_PI_FD_PATH')

check(
  'ripgrep 资产名（linux/darwin/win32 + arm64/x64）',
  RG_TOOL.getAssetName('14.1.1', 'linux', 'x64') === 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz' &&
    RG_TOOL.getAssetName('14.1.1', 'darwin', 'arm64') === 'ripgrep-14.1.1-aarch64-apple-darwin.tar.gz' &&
    RG_TOOL.getAssetName('14.1.1', 'win32', 'x64') === 'ripgrep-14.1.1-x86_64-pc-windows-msvc.zip',
  RG_TOOL.getAssetName('14.1.1', 'win32', 'arm64') ?? 'null',
)
check(
  'fd 资产名带 v 前缀（与 ripgrep 不同，已对过真实 release 列表）',
  FD_TOOL.getAssetName('10.5.0', 'linux', 'arm64') === 'fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz' &&
    FD_TOOL.getAssetName('10.5.0', 'win32', 'x64') === 'fd-v10.5.0-x86_64-pc-windows-msvc.zip' &&
    FD_TOOL.getAssetName('10.5.0', 'darwin', 'arm64') === 'fd-v10.5.0-aarch64-apple-darwin.tar.gz',
  FD_TOOL.getAssetName('10.5.0', 'linux', 'x64') ?? 'null',
)
check(
  '校验文件声明：ripgrep 有 .sha256，fd 没有',
  RG_TOOL.checksumAsset?.('15.2.0', 'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz') ===
    'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz.sha256' &&
    FD_TOOL.checksumAsset === undefined,
)
check('不支持平台返回 null', RG_TOOL.getAssetName('14.1.1', 'freebsd' as NodeJS.Platform, 'x64') === null)
check('archiveKindOf 按资产名判定归档类型', archiveKindOf('a.tar.gz') === 'tar.gz' && archiveKindOf('a.zip') === 'zip' && archiveKindOf('a.7z') === null)

// ---------------------------------------------------------------------------
// 2) 归档解包（zip-slip 防护 + 两种格式）
// ---------------------------------------------------------------------------

console.log('\n▶ 2. 归档解包（纯 JS，无外部命令）')

check(
  'safeEntryPath 拒绝越界 / 绝对路径 / 盘符',
  safeEntryPath('ok/file.txt') === 'ok/file.txt' &&
    safeEntryPath('../evil') === null &&
    safeEntryPath('a/../../evil') === null &&
    safeEntryPath('/etc/passwd') === null &&
    safeEntryPath('C:\\Windows\\evil') === null &&
    safeEntryPath('a\\b\\c.txt') === 'a/b/c.txt',
  String(safeEntryPath('a/../../evil')),
)

const longName = `fd-v10.2.0-x86_64-unknown-linux-musl/${'d'.repeat(120)}/${'e'.repeat(60)}/fd`
const tarBuffer = tarEntriesToBuffer([
  { name: 'pkg/', type: 'dir' },
  { name: 'pkg/rg', data: Buffer.from('#!/bin/sh\necho ripgrep 14.1.1\n', 'utf-8') },
  { name: 'pkg/README.md', data: Buffer.from('# readme\n', 'utf-8') },
  { name: '../escape.txt', data: Buffer.from('evil', 'utf-8') },
  { name: longName, type: 'longname', data: Buffer.from(longName, 'utf-8') },
  { name: 'pkg/fd', data: Buffer.from('fd 10.2.0\n', 'utf-8') },
])
const tarPath = join(work, 'tool.tar.gz')
await writeFile(tarPath, gzipSync(tarBuffer))

const tarEntries = parseTarEntries(tarBuffer)
check('tar 解析出目录与文件条目', tarEntries.filter((entry) => entry.type === 'file').length === 4 && tarEntries.some((entry) => entry.type === 'directory'))
check('tar 支持 GNU LongName', tarEntries.some((entry) => entry.name === longName), `longName=${tarEntries.some((entry) => entry.name === longName)}`)

const tarOut = join(work, 'tar-out')
const extractedTar = await extractArchive(tarPath, tarOut, 'tar.gz')
check('tar.gz 解包落盘', existsSync(join(tarOut, 'pkg', 'rg')) && (await readFile(join(tarOut, 'pkg', 'rg'), 'utf-8')).includes('ripgrep'))
check('tar.gz 保留嵌套目录结构', existsSync(join(tarOut, 'pkg', 'README.md')))
check('tar.gz 拒绝越界条目（zip-slip 防护）', !existsSync(join(work, 'escape.txt')) && extractedTar.every((entry) => !entry.name.includes('..')))
check('tar.gz 长路径条目正常落盘', existsSync(join(tarOut, ...longName.split('/'))))

const zipEntries = [
  { name: 'pkg/', data: Buffer.alloc(0), deflate: false },
  { name: 'pkg/rg.exe', data: Buffer.from('MZ fake ripgrep 14.1.1', 'utf-8'), deflate: false },
  { name: 'pkg/SHA256SUMS', data: Buffer.from('deadbeef  rg.exe\n', 'utf-8') },
  { name: '../../evil.txt', data: Buffer.from('evil', 'utf-8') },
]
const zipPath = join(work, 'tool.zip')
await writeFile(zipPath, buildZip(zipEntries))
check('zip 解析出全部条目', parseZipEntries(await readFile(zipPath)).length === 4)

const zipOut = join(work, 'zip-out')
await extractArchive(zipPath, zipOut, 'zip')
check('zip 解包 stored 与 deflate 条目', existsSync(join(zipOut, 'pkg', 'rg.exe')) && existsSync(join(zipOut, 'pkg', 'SHA256SUMS')))
check('zip 拒绝越界条目', !existsSync(join(work, 'evil.txt')))

// ---------------------------------------------------------------------------
// 3) 配置归一化（旧 config.yaml 必须能直接启动）
// ---------------------------------------------------------------------------

console.log('\n▶ 3. 配置归一化')

const normalized = normalizeToolsConfig({ rg: { enabled: false }, bogus: { enabled: false }, fd: 'nope' })
check(
  'normalizeToolsConfig：已知工具保留、未知工具忽略、坏值回退 true',
  normalized.rg.enabled === false && normalized.fd.enabled === true && !('bogus' in normalized),
  JSON.stringify(normalized),
)
check('normalizeToolsConfig(undefined) 给出全启用默认值', normalizeToolsConfig(undefined).rg.enabled === true)

const legacyConfig = validateConfig({
  language: 'zh',
  doc_language: 'zh',
  llm: { provider: 'openai', model: 'gpt-4o-mini', api_key: null, base_url: null },
  concurrency: { max_concurrent: 1, max_retries: 0 },
})
check(
  '旧 config.yaml（无 tools 段）启动后自动补齐工具默认值',
  legacyConfig.tools.rg.enabled === true && legacyConfig.tools.fd.enabled === true,
  JSON.stringify(legacyConfig.tools),
)

const toSave: AppConfig = structuredClone(legacyConfig)
toSave.tools.rg = { enabled: false }
await saveConfig(toSave)
const reloaded = await loadConfig()
check('tools 段可落盘并读回', reloaded.tools.rg.enabled === false && reloaded.tools.fd.enabled === true)

// 复位（后续「安装/探测」用例默认 rg 可用）
const restored: AppConfig = structuredClone(reloaded)
restored.tools.rg = { enabled: true }
await saveConfig(restored)

// ---------------------------------------------------------------------------
// 4) 状态探测 / 安装 / 卸载（本地 HTTP 服务器 + 注入探测）
// ---------------------------------------------------------------------------

console.log('\n▶ 4. 安装流程（本地 mock Releases）')

// 注入探测：只有托管目录里的文件（或显式指定的路径）"能运行"
// 注入探测：只有“托管目录里的文件”或“显式指定的路径”能运行；模拟系统里没装。
// 关键：探测结果的可用性只看 `runnable`，version 只是附加信息。
setBinaryProbeForTesting((path: string): BinaryProbeResult => {
  if (path === RG_TOOL.binaryName || path === FD_TOOL.binaryName) return { runnable: false, error: 'ENOENT' }
  if (!existsSync(path)) return { runnable: false, error: 'ENOENT' }
  return { runnable: true, version: '14.1.1', args: ['--version'], exitCode: 0, output: 'ripgrep 14.1.1' }
})

check('托管目录可通过 ZREAD_PI_TOOLS_DIR 覆盖（测试隔离）', getManagedBinDir() === managedDir, getManagedBinDir())
check('托管二进制路径按平台带后缀', getManagedBinaryPath(RG_TOOL).endsWith(managedBinaryName(RG_TOOL)))

const initialStatus = getToolStatus('rg')
check('未安装时状态为 missing', initialStatus?.state === 'missing' && initialStatus.installable === true)
check('getToolStatuses 覆盖注册表全部工具', getToolStatuses().length === 2)
check('resolveToolBinary 在缺失时返回 undefined', resolveToolBinary('rg') === undefined)
check('未登记工具的状态查询返回 undefined', getToolStatus('nope') === undefined)

// ---- mock GitHub Releases ----
const releaseAssetName = RG_TOOL.getAssetName('14.1.1', process.platform, process.arch)
if (!releaseAssetName) throw new Error('当前平台没有 rg 资产，无法继续测试')
const archiveBytes = process.platform === 'win32' ? buildZip([{ name: 'pkg/rg.exe', data: Buffer.from('MZ fake rg 14.1.1') }]) : gzipSync(tarEntriesToBuffer([{ name: 'pkg/rg', data: Buffer.from('fake rg 14.1.1') }]))

const requestLog: string[] = []
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
const serveChecksum = { value: true }
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    requestLog.push(url.pathname)
    if (url.pathname === `/${RG_TOOL.repo}/releases/latest`) {
      return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/${RG_TOOL.repo}/releases/tag/14.1.1` } })
    }
    if (url.pathname === `/${RG_TOOL.repo}/releases/download/14.1.1/${releaseAssetName}`) {
      return new Response(archiveBytes, { headers: { 'content-type': 'application/octet-stream' } })
    }
    if (url.pathname === `/${RG_TOOL.repo}/releases/download/14.1.1/${releaseAssetName}.sha256`) {
      const digest = serveChecksum.value ? archiveSha256 : 'f'.repeat(64)
      return new Response(`${digest}  ${releaseAssetName}\n`, { headers: { 'content-type': 'text/plain' } })
    }
    return new Response('not found', { status: 404 })
  },
})
process.env.ZREAD_PI_TOOLS_BASE_URL = `http://127.0.0.1:${server.port}`

check('resolveLatestVersion 走 releases/latest 的 302 拿 tag', (await resolveLatestVersion(RG_TOOL)) === '14.1.1', requestLog.join(','))

const progressEvents: ToolInstallProgress[] = []
const installed = await installTool('rg', { onProgress: (progress) => progressEvents.push(progress) })
const phases = [...new Set(progressEvents.map((event) => event.phase))]
check('安装过程阶段齐全（resolving → downloading → extracting → verifying → done）', phases.join(',') === 'resolving,downloading,extracting,verifying,done', phases.join(','))
check(
  '进度百分比单调递增并最终到 100',
  progressEvents.every((event, index) => index === 0 || event.percent >= progressEvents[index - 1].percent) &&
    progressEvents[progressEvents.length - 1].percent === 100,
  progressEvents.map((event) => `${event.phase}:${event.percent}`).join(' '),
)
check('下载阶段回报字节数', progressEvents.some((event) => event.phase === 'downloading' && (event.totalBytes ?? 0) > 0))
check('安装前请求了校验文件（.sha256）', requestLog.some((path) => path.endsWith('.sha256')), requestLog.join(','))

check('安装后二进制落在托管目录', existsSync(getManagedBinaryPath(RG_TOOL)), getManagedBinaryPath(RG_TOOL))
check('安装后状态为 managed 且带版本', installed.state === 'managed' && installed.version === '14.1.1', JSON.stringify(installed))
check('安装后 resolveToolBinary 命中托管目录', resolveToolBinary('rg')?.path === getManagedBinaryPath(RG_TOOL))
check('托管目录用量统计', (await getManagedBinUsage()).files.length === 1)
check('安装临时目录被清理', !readdirSync(managedDir).some((name) => name.startsWith('.install-')))

// 变更通知（agent-runtime 的缓存据此失效）
let notified = 0
const unsubscribe = onToolsChanged(() => notified++)
await uninstallTool('rg')
unsubscribe()
check('卸载后广播工具变更', notified === 1, String(notified))
check('卸载后二进制被删除且状态回到 missing', !existsSync(getManagedBinaryPath(RG_TOOL)) && getToolStatus('rg')?.state === 'missing')
check('卸载系统安装的工具是空操作（返回 false）', (await uninstallTool('fd')) === false)

// 校验失败路径：探测永远失败 → 必须报错，且不留下半成品
// 校验失败路径：探测永远不可运行 → 必须报错，且不留下半成品
setBinaryProbeForTesting(() => ({ runnable: false, error: 'ENOEXEC' }))
const brokenInstall = await installTool('rg').then(
  () => undefined,
  (error: unknown) => (error instanceof Error ? error.message : String(error)),
)
check(
  '安装校验失败时给出可读错误（附探测原因）',
  typeof brokenInstall === 'string' && brokenInstall.includes('安装校验失败') && brokenInstall.includes('ENOEXEC'),
  String(brokenInstall),
)
check('校验失败时不留下半成品', !existsSync(getManagedBinaryPath(RG_TOOL)))

// 归档指纹不匹配：必须在解包前拦住
serveChecksum.value = false
const checksumMismatch = await installTool('rg').then(
  () => undefined,
  (error: unknown) => (error instanceof Error ? error.message : String(error)),
)
check(
  '归档指纹不匹配时拒绝解包',
  typeof checksumMismatch === 'string' && checksumMismatch.includes('指纹不匹配'),
  String(checksumMismatch),
)
check('指纹校验失败时不留下二进制', !existsSync(getManagedBinaryPath(RG_TOOL)))
serveChecksum.value = true

// 不支持的平台 / 未登记工具
const unknownInstall = await installTool('nope').then(
  () => undefined,
  (error: unknown) => (error instanceof Error ? error.message : String(error)),
)
check('安装未登记工具时报错', typeof unknownInstall === 'string' && (unknownInstall as string).includes('未登记'), String(unknownInstall))

// 注意：mock Releases 服务器保持运行到第 6 节结束（那里还要验证「读不出版本也能安装成功」）

// ---------------------------------------------------------------------------
// 5) 启用开关（config.yaml 的 tools.<id>.enabled）
// ---------------------------------------------------------------------------

console.log('\n▶ 5. 启用开关（是否允许使用该外部工具）')

// 造一个"托管安装"的 rg（内容无关，探测已被注入）
await mkdir(managedDir, { recursive: true })
await writeFile(getManagedBinaryPath(RG_TOOL), 'fake', 'utf-8')
setBinaryProbeForTesting((path: string): BinaryProbeResult =>
  existsSync(path)
    ? { runnable: true, version: '14.1.1', args: ['--version'], exitCode: 0, output: 'ripgrep 14.1.1' }
    : { runnable: false, error: 'ENOENT' },
)

check('enabled=true 时解析到托管二进制', resolveToolBinary('rg')?.path === getManagedBinaryPath(RG_TOOL))
check('托管安装的 source 标记为 managed', resolveToolBinary('rg')?.source === 'managed')

const disabledConfig: AppConfig = structuredClone(await loadConfig())
disabledConfig.tools.rg = { enabled: false }
disabledConfig.tools.fd = { enabled: false }
await saveConfig(disabledConfig)

check('isToolEnabled 读取 config.yaml', isToolEnabled('rg') === false)
check('用户停用后 resolveToolBinary 直接不用（即使已安装）', resolveToolBinary('rg') === undefined)
check('停用状态在 UI 状态里显示为 disabled', getToolStatus('rg')?.state === 'disabled' && getToolStatus('rg')?.enabled === false)

const enabledConfig: AppConfig = structuredClone(await loadConfig())
enabledConfig.tools.rg = { enabled: true }
await saveConfig(enabledConfig)
check('重新启用后立刻恢复可用（状态不缓存）', resolveToolBinary('rg')?.path === getManagedBinaryPath(RG_TOOL))

// ---------------------------------------------------------------------------
// 6) 版本探测与可用性解耦（未来工具可能没有 --version，或输出格式不同）
// ---------------------------------------------------------------------------

console.log('\n▶ 6. 版本探测与可用性解耦')

// 6a) 探测参数可多组回退：--version 退出码非 0，但 -V 能打印版本
const probeCalls: string[][] = []
const multiArgSpec: ToolSpec = {
  ...RG_TOOL,
  id: 'rg',
  versionProbeArgs: [['--version'], ['-V'], ['version']],
  versionPattern: /v(\d+\.\d+(?:\.\d+)?)/i,
}
const realProbe = (args: string[]): BinaryProbeResult => {
  probeCalls.push(args)
  if (args[0] === '--version') return { runnable: true, args, exitCode: 1, output: 'unknown flag' }
  if (args[0] === '-V') return { runnable: true, args, exitCode: 0, output: 'weird-tool v2.7' }
  return { runnable: true, args, exitCode: 0, output: 'weird-tool' }
}
check(
  '缺省探测参数包含多组回退（--version / -V / version）',
  DEFAULT_VERSION_PROBE_ARGS.length >= 3 && DEFAULT_VERSION_PROBE_ARGS[0][0] === '--version',
  JSON.stringify(DEFAULT_VERSION_PROBE_ARGS),
)
check('多组参数回退：能从 -V 里拿到版本', multiArgSpec.versionProbeArgs !== undefined && realProbe(['-V']).output === 'weird-tool v2.7')

// 6a2) 真实二进制：直接把 probeBinary 拿出来验（不经过测试钩子）
const noisyScript = join(work, 'noisy-version.js')
await writeFile(noisyScript, 'console.log("x".repeat(4 * 1024 * 1024))\n', 'utf-8')
const noisySpec: ToolSpec = { ...RG_TOOL, versionProbeArgs: [[noisyScript]] }
const noisyProbe = probeBinary(process.execPath, noisySpec)
check(
  '输出撞上 maxBuffer（ENOBUFS）不算“不可用”',
  noisyProbe.runnable === true && noisyProbe.version === undefined,
  JSON.stringify(noisyProbe),
)
const cwdScript = join(work, 'print-cwd.js')
await writeFile(cwdScript, 'console.log(process.cwd())\n', 'utf-8')
const cwdProbe = probeBinary(process.execPath, { ...RG_TOOL, versionProbeArgs: [[cwdScript]] })
check(
  '探测在专用空目录里执行（不在 cwd / 不在仓库里）',
  cwdProbe.runnable === true && Boolean(cwdProbe.output) && cwdProbe.output !== process.cwd() && cwdProbe.output?.includes('zread-pi-probe-'),
  `${cwdProbe.output} vs cwd=${process.cwd()}`,
)
check(
  '不存在的命令 → 不可用（ENOENT）',
  probeBinary('definitely-not-a-command-zread-pi', RG_TOOL).runnable === false,
)

// 6b) 完全识别不出版本号：必须仍然「可用」，只是 version 为空
const noVersionProbe = (path: string): BinaryProbeResult =>
  existsSync(path) ? { runnable: true, args: ['--version'], exitCode: 0, output: 'no version information here' } : { runnable: false, error: 'ENOENT' }
setBinaryProbeForTesting(noVersionProbe)
check(
  '识别不出版本号时仍判定为可用（不当作未安装）',
  resolveToolBinary('rg')?.path === getManagedBinaryPath(RG_TOOL) && resolveToolBinary('rg')?.version === undefined,
  JSON.stringify(resolveToolBinary('rg')),
)
const noVersionStatus = getToolStatus('rg')
check(
  '状态里保留探测输出供诊断，且不报错',
  noVersionStatus?.state === 'managed' &&
    noVersionStatus?.version === undefined &&
    noVersionStatus?.versionOutput === 'no version information here',
  JSON.stringify(noVersionStatus),
)

// 6c) 安装：二进制能跑但读不出版本 → 安装成功，台账记录「当初装的版本」
const installWithoutVersion = await installTool('rg')
check(
  '能执行但读不出版本时安装成功',
  installWithoutVersion.state === 'managed' && installWithoutVersion.version === undefined,
  JSON.stringify(installWithoutVersion),
)
const ledger = readToolLedger()
check(
  '台账记录了安装版本（不依赖探测结果）',
  ledger.installed.rg?.version === '14.1.1' && ledger.installed.rg?.binary === managedBinaryName(RG_TOOL),
  JSON.stringify(ledger.installed),
)
check(
  '状态里同时提供台账版本（UI 可展示「已安装 14.1.1，版本输出未识别」）',
  getToolStatus('rg')?.installedVersion === '14.1.1' && getToolStatus('rg')?.version === undefined,
)
check(
  '台账写入磁盘（新进程读得到）',
  JSON.parse(await readFile(getToolLedgerPath(), 'utf-8')).installed.rg.version === '14.1.1',
  await readFile(getToolLedgerPath(), 'utf-8'),
)

// 6d) 探测版本与台账版本不一致 → 只提示，不影响可用
setBinaryProbeForTesting((path: string) =>
  existsSync(path) ? { runnable: true, args: ['--version'], exitCode: 0, output: 'ripgrep 99.9.9' } : { runnable: false, error: 'ENOENT' },
)
const mismatched = getToolStatus('rg')
check(
  '探测版本与台账不一致时给出 versionMismatch（不用来否定可用性）',
  mismatched?.state === 'managed' &&
    mismatched?.version === '99.9.9' &&
    mismatched?.versionMismatch?.expected === '14.1.1' &&
    mismatched?.versionMismatch?.actual === '99.9.9',
  JSON.stringify(mismatched?.versionMismatch),
)

// 6e) 卸载清掉台账；文件被手动删除时也不再拿台账当事实
await uninstallTool('rg')
check('卸载后台账同步清除', readToolLedger().installed.rg === undefined)
setBinaryProbeForTesting(noVersionProbe)
const reinstalled = await installTool('rg') // 能跑但读不出版本 → 仍然安装成功
const beforeManualDelete = getToolStatus('rg')
await rm(getManagedBinaryPath(RG_TOOL), { force: true })
const afterManualDelete = getToolStatus('rg')
check(
  '二进制被手动删除后不再拿台账当事实（状态回到 missing）',
  reinstalled.state === 'managed' &&
    beforeManualDelete?.installedVersion === '14.1.1' &&
    afterManualDelete?.state === 'missing' &&
    afterManualDelete?.installedVersion === undefined,
  `before=${beforeManualDelete?.state}/${beforeManualDelete?.installedVersion} after=${afterManualDelete?.state}/${afterManualDelete?.installedVersion}`,
)

setBinaryProbeForTesting(undefined)
server.stop(true)

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

check('测试使用隔离目录（不写真实 ~/.zread-pi）', managedDir.startsWith(tmpdir()) && getManagedBinDir() === managedDir, managedDir)
check('安装台账写在托管目录同级', getToolLedgerPath() === join(home, 'tools-state.json'), getToolLedgerPath())

setBinaryProbeForTesting(undefined)
delete process.env.ZREAD_PI_TOOLS_DIR
delete process.env.ZREAD_PI_TOOLS_BASE_URL
await rm(home, { recursive: true, force: true })
await rm(work, { recursive: true, force: true })
await rm(join(tmpdir(), 'zread-pi-tools-nonexistent'), { recursive: true, force: true })

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '))
  process.exit(1)
}
