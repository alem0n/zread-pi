/**
 * 外部工具安装器（rg / fd …）
 *
 * 职责：
 *  - 状态探测：`resolveToolBinary`（托管目录 → 系统 PATH，用户停用则直接不用）
 *  - 安装：`installTool`（解析版本 → 下载 → 解包 → 落盘 → 校验 → 进度回调）
 *  - 卸载：`uninstallTool`（只删托管目录里的二进制，不动系统安装）
 *  - 变更通知：`onToolsChanged`（agent-runtime 的二进制探测缓存据此失效）
 *
 * 与上游 pi `utils/tools-manager.ts` 的差异（有意为之）：
 *  1. **不静默下载**：只有用户在配置界面（/config/tools）里显式点安装才联网；
 *     搜索工具在缺失时仍旧走纯 JS 兜底，行为不变。
 *  2. **纯 JS 解包**（见 archive.ts），不依赖 tar / unzip / PowerShell。
 *  3. `ZREAD_PI_TOOLS_DIR` / `ZREAD_PI_TOOLS_BASE_URL` 可覆盖目录与下载源
 *     （测试、离线内网镜像用；镜像同样要求 HTTPS 且目录结构与 GitHub Releases 一致）。
 *
 * 安装目录：`~/.zread-pi/bin`（与 `~/.zread-pi/parsers` 同级，全部由 zread-pi 托管）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, rmSync, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  archiveKindOf,
  getToolSpec,
  listTools,
  type ToolId,
  type ToolSpec,
} from './registry.js'
import { extractArchive } from './archive.js'
import { loadConfigSync } from '../config/index.js'

export const DEFAULT_NETWORK_TIMEOUT_MS = 15_000
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000

/** 托管二进制目录（后续新增工具共用同一目录） */
export function getManagedBinDir(): string {
  const override = process.env.ZREAD_PI_TOOLS_DIR
  if (override && override.trim().length > 0) return resolve(override.trim())
  return join(homedir(), '.zread-pi', 'bin')
}

/** 托管二进制路径（Windows 带 .exe 后缀） */
export function getManagedBinaryPath(spec: ToolSpec): string {
  return join(getManagedBinDir(), spec.binaryName + (process.platform === 'win32' ? '.exe' : ''))
}

export type ToolSource = 'system' | 'managed'

export interface ResolvedToolBinary {
  /** 可直接 spawn 的路径或命令名 */
  path: string
  source: ToolSource
  /** `--version` 里解析出的版本号（探测失败时为空） */
  version?: string
}

// ---------------------------------------------------------------------------
// 变更通知（安装 / 卸载 / 启用状态变化后触发）
// ---------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

/** 订阅「工具可用性发生变化」；返回取消订阅函数（预留：后续新增工具共用）。 */
export function onToolsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/** 广播变更（安装器内部调用；配置界面切换启用状态时也应调用）。 */
export function notifyToolsChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener()
    } catch {
      // 监听器异常不应影响安装流程
    }
  }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

function parseVersion(text: string, spec: ToolSpec): string | undefined {
  const pattern = spec.versionPattern ?? /(\d+\.\d+\.\d+)/
  const match = pattern.exec(text)
  return match?.[1]
}

function probeCommand(command: string, args: string[]): { ok: boolean; version?: string; error?: string } {
  const result = spawnSync(command, args, { stdio: 'pipe', timeout: 10_000, windowsHide: true })
  if (result.error) return { ok: false, error: result.error.message }
  const output = `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`
  if (result.status !== 0) return { ok: false, error: output.trim() || `退出码 ${result.status}` }
  return { ok: true, version: output.trim().split('\n')[0] }
}

/** 探测一个具体二进制是否可用，并解析版本号。 */
export function probeBinary(path: string, spec: ToolSpec): ResolvedToolBinary | undefined {
  const result = probeCommand(path, spec.versionArgs)
  if (!result.ok) return undefined
  return { path, version: result.version ? parseVersion(result.version, spec) ?? result.version : undefined, source: 'system' }
}

/**
 * 测试钩子：替换二进制探测实现。
 *
 * 生产路径永远是 `probeBinary`（spawnSync 执行 `--version`）；测试里注入假实现后，
 * 就不需要在三平台上造一个真的可执行文件（Windows 无法直接 spawn .cmd 脚本），
 * 同时安装/状态/卸载全链路仍然走真实代码。
 */
export type BinaryProbe = (path: string, spec: ToolSpec) => ResolvedToolBinary | undefined

let binaryProbeOverride: BinaryProbe | undefined

export function setBinaryProbeForTesting(probe: BinaryProbe | undefined): void {
  binaryProbeOverride = probe
}

function runProbe(path: string, spec: ToolSpec): ResolvedToolBinary | undefined {
  return binaryProbeOverride ? binaryProbeOverride(path, spec) : probeBinary(path, spec)
}

/** 用户是否允许使用该工具（旧配置缺省 true）。 */
export function isToolEnabled(id: ToolId): boolean {
  const config = loadConfigSync()
  const entry = config?.tools?.[id]
  return entry?.enabled ?? true
}

/**
 * 解析某个工具当前可用的二进制（同步探测，供工具热路径与配置界面共用）。
 *
 * 优先级：环境变量显式指定 → 托管目录 → 系统 PATH。
 * 用户停用时直接返回 undefined（即使系统里装了也不用，强制内置兜底实现）。
 *
 * `options.enabled` 用于配置界面的「未保存预览」：覆盖 config.yaml 里的启用状态。
 */
export function resolveToolBinary(id: ToolId, options?: { enabled?: boolean }): ResolvedToolBinary | undefined {
  const spec = getToolSpec(id)
  if (!spec) return undefined
  if (!(options?.enabled ?? isToolEnabled(id))) return undefined

  const override = process.env[spec.envPathVar]
  if (override && override.trim().length > 0) {
    const resolved = runProbe(override.trim(), spec)
    return resolved ? { ...resolved, source: 'system' } : undefined
  }

  const managedPath = getManagedBinaryPath(spec)
  if (existsSync(managedPath)) {
    const managed = runProbe(managedPath, spec)
    if (managed) return { ...managed, path: managedPath, source: 'managed' }
  }

  for (const candidate of spec.systemBinaryNames) {
    const found = runProbe(candidate, spec)
    if (found) return found
  }
  return undefined
}

export type ToolState = 'missing' | 'system' | 'managed' | 'disabled'

export interface ToolStatus {
  id: ToolId
  displayName: string
  state: ToolState
  /** 可用二进制的路径（命令名或绝对路径） */
  path?: string
  version?: string
  /** 用途说明用的 Agent 工具名（Glob / Grep …） */
  usedBy: string[]
  /** 用户是否允许使用 */
  enabled: boolean
  /** 托管目录里是否存在该二进制（用于判断能否卸载） */
  managed: boolean
  /** 该平台是否支持自动安装（不支持时 UI 只展示手动安装提示） */
  installable: boolean
}

/**
 * 收集单个工具的完整状态（不做任何网络请求）。
 *
 * `options.enabled` 覆盖 config.yaml 里的启用状态，供配置界面预览「未保存」的切换；
 * 不传时完全以磁盘配置为准（agent 运行期走的就是这条路径）。
 */
export function getToolStatus(id: ToolId, options?: { enabled?: boolean }): ToolStatus | undefined {
  const spec = getToolSpec(id)
  if (!spec) return undefined
  const enabled = options?.enabled ?? isToolEnabled(id)
  const managedPath = getManagedBinaryPath(spec)
  const managedExists = existsSync(managedPath)
  const resolved = resolveToolBinary(id, { enabled })

  const state: ToolState = !enabled ? 'disabled' : !resolved ? 'missing' : resolved.source
  return {
    id: spec.id,
    displayName: spec.displayName,
    state,
    path: resolved?.path,
    version: resolved?.version,
    usedBy: [...spec.usedBy],
    enabled,
    managed: managedExists,
    installable: spec.getAssetName('0.0.0', process.platform, process.arch) !== null,
  }
}

/** 所有已登记工具的状态（UI 列表用；`enabledOverrides` 用于预览未保存的切换）。 */
export function getToolStatuses(enabledOverrides?: Record<ToolId, boolean>): ToolStatus[] {
  return listTools()
    .map((spec) => getToolStatus(spec.id, { enabled: enabledOverrides?.[spec.id] }))
    .filter((status): status is ToolStatus => status !== undefined)
}

// ---------------------------------------------------------------------------
// 下载 / 安装
// ---------------------------------------------------------------------------

export type ToolInstallPhase = 'resolving' | 'downloading' | 'extracting' | 'verifying' | 'done'

export interface ToolInstallProgress {
  phase: ToolInstallPhase
  /** 0-100 的总体进度（阶段已按权重折算） */
  percent: number
  receivedBytes?: number
  totalBytes?: number
  /** 阶段内的补充文案（版本号 / 资产名 / 错误信息） */
  message?: string
}

export interface InstallToolOptions {
  onProgress?: (progress: ToolInstallProgress) => void
  signal?: AbortSignal
  /** 指定版本（缺省解析 latest）；配置界面「重装」时可复用 */
  version?: string
}

/** 各阶段的进度权重（下载占大头） */
const PHASE_WEIGHTS = {
  resolving: [0, 5],
  downloading: [5, 80],
  extracting: [80, 92],
  verifying: [92, 98],
} as const

function phasePercent(phase: Exclude<ToolInstallPhase, 'done'>, fraction = 0): number {
  const [start, end] = PHASE_WEIGHTS[phase]
  return Math.round(start + (end - start) * Math.min(1, Math.max(0, fraction)))
}

function toolsBaseUrl(): string {
  const override = process.env.ZREAD_PI_TOOLS_BASE_URL
  if (override && override.trim().length > 0) return override.trim().replace(/\/+$/, '')
  return 'https://github.com'
}

function userAgent(): string {
  return 'zread-pi-tools'
}

class ToolInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInstallError'
  }
}

/**
 * 解析 latest tag。
 *
 * 参考上游：走 `releases/latest` 的 302 重定向拿 tag，而不是 api.github.com
 * （未认证的 API 配额只有 60 次/小时，共享出口 IP 上基本必然耗尽）。
 */
export async function resolveLatestVersion(spec: ToolSpec, signal?: AbortSignal): Promise<string> {
  const url = `${toolsBaseUrl()}/${spec.repo}/releases/latest`
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': userAgent() },
    redirect: 'manual',
    signal,
  })
  try {
    await response.body?.cancel()
  } catch {
    // 丢弃响应体是尽力而为
  }
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
  if (!location) {
    throw new ToolInstallError(`无法解析最新版本：HTTP ${response.status}（${url}）`)
  }
  const tag = new URL(location, 'https://github.com').pathname.split('/').pop()
  if (!tag || !location.includes('/releases/tag/')) {
    throw new ToolInstallError(`无法解析最新版本：重定向到 ${location}`)
  }
  return decodeURIComponent(tag).replace(/^v/, '')
}

async function fetchWithTimeout(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  const timeout = AbortSignal.timeout(DEFAULT_NETWORK_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  try {
    return await fetch(url, { ...init, signal })
  } catch (error) {
    throw new ToolInstallError(`网络请求失败：${describeError(error)}`)
  }
}

function describeError(error: unknown): string {
  const messages: string[] = []
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (!messages.includes(current.message)) messages.push(current.message)
  }
  return messages.length > 0 ? messages.join(': ') : String(error)
}

/** 下载小文本文件（校验文件），带超时与可读错误 */
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(DEFAULT_NETWORK_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, { headers: { 'User-Agent': userAgent() }, redirect: 'follow', signal: combined })
  } catch (error) {
    throw new ToolInstallError(`请求失败：${describeError(error)}（${url}）`)
  }
  if (!response.ok) throw new ToolInstallError(`请求失败：HTTP ${response.status}（${url}）`)
  return await response.text()
}

/**
 * 校验归档指纹。
 *
 * ripgrep 为每个资产发布 `<asset>.sha256`，就顺手校验一下（供应链最低成本的一道防线）；
 * fd 不发布校验文件，跳过（工具里不引入自签名的“伪验证”）。
 */
async function verifyArchiveChecksum(
  spec: ToolSpec,
  options: { archivePath: string; downloadUrl: string; version: string; assetName: string; signal?: AbortSignal },
): Promise<void> {
  if (!spec.checksumAsset) return
  const checksumName = spec.checksumAsset(options.version, options.assetName)
  if (!checksumName) return

  const checksumUrl = `${options.downloadUrl.slice(0, options.downloadUrl.lastIndexOf('/') + 1)}${checksumName}`
  const text = await fetchText(checksumUrl, options.signal)
  const expected = /\b([0-9a-f]{64})\b/i.exec(text)?.[1]?.toLowerCase()
  if (!expected) {
    throw new ToolInstallError(`校验文件格式无法识别：${checksumUrl}`)
  }

  const actual = createHash('sha256').update(await readFile(options.archivePath)).digest('hex')
  if (actual !== expected) {
    throw new ToolInstallError(`归档指纹不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }
}

/** 流式下载并回调进度。 */
async function downloadFile(
  url: string,
  destination: string,
  onProgress: (received: number, total: number | undefined) => void,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(url, { headers: { 'User-Agent': userAgent() }, redirect: 'follow', signal: combined })
  } catch (error) {
    throw new ToolInstallError(`下载失败：${describeError(error)}`)
  }
  if (!response.ok) {
    throw new ToolInstallError(`下载失败：HTTP ${response.status}（${url}）`)
  }
  if (!response.body) {
    throw new ToolInstallError('下载失败：响应没有内容')
  }

  const lengthHeader = response.headers.get('content-length')
  const total = lengthHeader && Number.isFinite(Number(lengthHeader)) ? Number(lengthHeader) : undefined
  let received = 0

  const stream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  stream.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress(received, total)
  })

  try {
    await pipeline(stream, createWriteStream(destination))
  } catch (error) {
    throw new ToolInstallError(`下载失败：${describeError(error)}`)
  }
}

/** 在解包目录里递归找二进制（归档结构在不同版本/平台之间会变）。 */
async function findBinary(root: string, fileName: string): Promise<string | undefined> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isFile() && entry.name === fileName) return full
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return undefined
}

/**
 * 安装（或重装）一个工具。
 *
 * 流程：解析版本 → 下载资产 → 解包到临时目录 → 找到二进制 → 落到 ~/.zread-pi/bin
 * → `--version` 校验 → 广播变更。任何一步失败都会清理临时文件并抛出可读错误。
 */
export async function installTool(id: ToolId, options: InstallToolOptions = {}): Promise<ToolStatus> {
  const spec = getToolSpec(id)
  if (!spec) throw new ToolInstallError(`未登记的工具：${id}`)

  const report = (phase: ToolInstallPhase, fractionOrMessage?: number, message?: string, extra?: Partial<ToolInstallProgress>) => {
    const percent = phase === 'done' ? 100 : phasePercent(phase, typeof fractionOrMessage === 'number' ? fractionOrMessage : 0)
    options.onProgress?.({ phase, percent, message, ...extra })
  }

  const ensureNotAborted = (): void => {
    if (options.signal?.aborted) throw new ToolInstallError('安装已取消')
  }

  ensureNotAborted()
  report('resolving', 0, spec.displayName)

  const version = options.version ?? spec.pinnedVersion?.(process.platform, process.arch) ?? (await resolveLatestVersion(spec, options.signal))
  ensureNotAborted()

  const assetName = spec.getAssetName(version, process.platform, process.arch)
  if (!assetName) {
    throw new ToolInstallError(`当前平台不支持自动安装：${process.platform}/${process.arch}`)
  }
  const kind = archiveKindOf(assetName)
  if (!kind) throw new ToolInstallError(`不支持的归档格式：${assetName}`)

  const url = `${toolsBaseUrl()}/${spec.repo}/releases/download/${spec.tagPrefix}${version}/${assetName}`
  report('resolving', 1, `${version} · ${assetName}`)

  const managedDir = getManagedBinDir()
  await mkdir(managedDir, { recursive: true })
  const workDir = await mkdtemp(join(managedDir, `.install-${spec.id}-`))
  const archivePath = join(workDir, basename(assetName))

  try {
    await downloadFile(
      url,
      archivePath,
      (received, total) => {
        const fraction = total && total > 0 ? received / total : 0
        report('downloading', fraction, undefined, { receivedBytes: received, totalBytes: total })
      },
      options.signal,
    )
    ensureNotAborted()

    // 先校验归档指纹（若上游提供），再解包，避免把损坏/被篡改的归档展开到磁盘
    await verifyArchiveChecksum(spec, { archivePath, downloadUrl: url, version, assetName, signal: options.signal })
    ensureNotAborted()

    const extractDir = join(workDir, 'extract')
    report('extracting', 0)
    await extractArchive(archivePath, extractDir, kind)
    ensureNotAborted()

    const binaryFileName = spec.binaryName + (process.platform === 'win32' ? '.exe' : '')
    const extracted = await findBinary(extractDir, binaryFileName)
    if (!extracted) {
      throw new ToolInstallError(`归档里找不到 ${binaryFileName}（${assetName}）`)
    }

    const target = getManagedBinaryPath(spec)
    await mkdir(dirname(target), { recursive: true })
    await copyFileOverwrite(extracted, target)
    if (process.platform !== 'win32') {
      chmodSync(target, 0o755)
    }
    report('verifying', 0, target)

    const verified = runProbe(target, spec)
    if (!verified) {
      rmSync(target, { force: true })
      throw new ToolInstallError(`安装校验失败：${target} 无法执行`)
    }

    report('done', 100, verified.version ?? version)
    notifyToolsChanged()
    const status = getToolStatus(spec.id)
    if (!status) throw new ToolInstallError(`安装后无法读取状态：${id}`)
    return status
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function copyFileOverwrite(source: string, destination: string): Promise<void> {
  const { copyFile } = await import('node:fs/promises')
  await copyFile(source, destination)
}

/** 卸载：只删除托管目录里的二进制（系统安装不受影响）。 */
export async function uninstallTool(id: ToolId): Promise<boolean> {
  const spec = getToolSpec(id)
  if (!spec) throw new ToolInstallError(`未登记的工具：${id}`)
  const target = getManagedBinaryPath(spec)
  if (!existsSync(target)) return false
  rmSync(target, { force: true })
  notifyToolsChanged()
  return true
}

/** 托管目录当前的占用情况（UI 展示用）。 */
export async function getManagedBinUsage(): Promise<{ files: string[]; bytes: number }> {
  const dir = getManagedBinDir()
  if (!existsSync(dir)) return { files: [], bytes: 0 }
  const files: string[] = []
  let bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    files.push(entry.name)
    try {
      bytes += (await stat(join(dir, entry.name))).size
    } catch {
      // 忽略无法读取的条目
    }
  }
  return { files, bytes }
}

export { ToolInstallError }
