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
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { archiveKindOf, getToolSpec, listTools, type ToolId, type ToolSpec } from './registry.js'
import { extractArchive } from './archive.js'
import { loadConfigSync } from '../config/index.js'
import { withFileLockSync } from '../lockfile.js'
import { projectHomePath } from '../project-home.js'

export const DEFAULT_NETWORK_TIMEOUT_MS = 15_000
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000

/** 托管二进制目录（后续新增工具共用同一目录） */
export function getManagedBinDir(): string {
  const override = process.env.ZREAD_PI_TOOLS_DIR
  if (override && override.trim().length > 0) return resolve(override.trim())
  return projectHomePath('bin')
}

/** 托管二进制路径（Windows 带 .exe 后缀） */
export function getManagedBinaryPath(spec: ToolSpec): string {
  return join(getManagedBinDir(), spec.binaryName + (process.platform === 'win32' ? '.exe' : ''))
}

// ---------------------------------------------------------------------------
// 安装台账（~/.zread-pi/tools-state.json）
//
// 为什么需要它：版本探测只能算「尽力而为」（不同工具的版本 flag 与输出格式各异，
// 未来工具甚至可能没有版本开关）。因此「当初装的是哪个版本」必须由我们自己记一笔：
//  - 探测能识别出版本 → 以探测为准，台账用于发现不一致（例如手动手换过二进制）；
//  - 探测识别不出 → 台账版本仍是可展示的信息（“由 zread-pi 安装 10.5.0，版本输出未识别”）。
// 台账**不参与可用性判定**：二进制是否存在由文件系统决定，文件没了台账就作废。
// ---------------------------------------------------------------------------

const LEDGER_VERSION = 1

export interface ToolLedgerEntry {
  version: string
  installedAt: string
  /** 安装资产文件名（排查问题时用） */
  asset?: string
  /** 二进制相对托管目录的位置（目前固定为文件名） */
  binary: string
}

interface ToolLedger {
  version: number
  installed: Record<ToolId, ToolLedgerEntry>
}

/** 台账路径（与托管目录同级，测试可用 ZREAD_PI_TOOLS_DIR 一并隔离） */
export function getToolLedgerPath(): string {
  return join(dirname(getManagedBinDir()), 'tools-state.json')
}

function emptyLedger(): ToolLedger {
  return { version: LEDGER_VERSION, installed: {} }
}

/** 读取台账（损坏/缺失时返回空台账，不抛异常）。 */
export function readToolLedger(): ToolLedger {
  try {
    const raw = readFileSync(getToolLedgerPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ToolLedger>
    const installed: Record<ToolId, ToolLedgerEntry> = {}
    for (const [id, entry] of Object.entries(parsed?.installed ?? {})) {
      if (!entry || typeof entry !== 'object') continue
      const candidate = entry as Partial<ToolLedgerEntry>
      if (typeof candidate.version !== 'string' || !candidate.version) continue
      installed[id] = {
        version: candidate.version,
        installedAt: typeof candidate.installedAt === 'string' ? candidate.installedAt : '',
        asset: typeof candidate.asset === 'string' ? candidate.asset : undefined,
        binary: typeof candidate.binary === 'string' ? candidate.binary : '',
      }
    }
    return { version: LEDGER_VERSION, installed }
  } catch {
    return emptyLedger()
  }
}

function writeToolLedger(ledger: ToolLedger): void {
  try {
    mkdirSync(dirname(getToolLedgerPath()), { recursive: true })
    writeFileSync(getToolLedgerPath(), `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8')
  } catch {
    // 台账写失败不能影响安装本身（下次安装会重试）
  }
}

/** 记录一次托管安装（安装成功后调用）。 */
export function recordToolInstall(id: ToolId, entry: ToolLedgerEntry): void {
  // 跨进程锁：`tools:install` 与 TUI 安装可能同时在改台账（读-改-写整体保护）
  try {
    withFileLockSync(getToolLedgerPath(), () => {
      const ledger = readToolLedger()
      ledger.installed[id] = entry
      writeToolLedger(ledger)
    })
  } catch {
    // 台账写失败不能影响安装本身（下次安装会重试），与 writeToolLedger 的容错一致
  }
}

/** 清除某个工具的托管安装记录（卸载后调用）。 */
export function clearToolInstall(id: ToolId): void {
  try {
    withFileLockSync(getToolLedgerPath(), () => {
      const ledger = readToolLedger()
      if (!(id in ledger.installed)) return
      delete ledger.installed[id]
      writeToolLedger(ledger)
    })
  } catch {
    // 同上：台账失败不影响卸载结果
  }
}

export type ToolSource = 'system' | 'managed'

/** 一个被判定为「可执行」的二进制解析结果（含探测细节） */
export interface ResolvedToolBinary {
  /** 可直接 spawn 的路径或命令名 */
  path: string
  source: ToolSource
  /** `--version` 类探测里解析出的版本号（识别不到时为空，**不影响可用性**） */
  version?: string
  /** 进程能否被启动（目前始终为 true：不能启动的候选不会被返回） */
  runnable: true
  /** 探测细节（参数、退出码、输出摘要），供 UI / 日志展示 */
  probe: BinaryProbeResult
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
//
// 设计要点（避免把「版本管理」绑死在一个 flag 上）：
//  1. **可用性 ≠ 版本识别**：只要进程能被启动（spawn 无错、未超时）就视为可用，
//     即使 `--version` 退出码非 0、把版本写到 stderr、或输出根本没有版本号；
//  2. 版本号只是附加信息：按 `spec.versionProbeArgs`（缺省多组参数）依次尝试，
//     解析不出就返回 undefined，不影响工具能否使用；
//  3. 探测一律在临时目录里、带短超时、stdin 关闭的情况下执行——
//     避免把「版本参数」当路径参数的工具去扫描用户仓库。
// ---------------------------------------------------------------------------

/** 缺省版本探测参数（多家工具的习惯差异都盖住；仍可由 spec 覆盖） */
export const DEFAULT_VERSION_PROBE_ARGS: string[][] = [['--version'], ['-V'], ['version']]

/** 宽松版本号：1.2 / 1.2.3 / v1.2.3 / 1.2.3-rc1 / 2024.01.2 */
const DEFAULT_VERSION_PATTERN = /(\d+(?:\.\d+)+(?:[-+][\w.]+)?)/

const PROBE_TIMEOUT_MS = 3_000
const PROBE_OUTPUT_LIMIT = 200

/**
 * 探测专用的空目录（惰性创建，全进程复用）。
 *
 * 把 `version` 当子命令的工具不存在，但把 `version` 当**搜索模式**的工具（rg / find 类）很多：
 * 在用户 cwd 里跑会把整个仓库扫一遍；在临时目录里跑也可能扫到一堆无关文件（实测 rg 会输出到
 * 撞上 maxBuffer）。因此探测固定在一个空目录里执行。
 */
let probeCwd: string | undefined

function getProbeCwd(): string | undefined {
  if (probeCwd) return probeCwd
  try {
    probeCwd = mkdtempSync(join(tmpdir(), 'zread-pi-probe-'))
  } catch {
    probeCwd = tmpdir()
  }
  return probeCwd
}

/**
 * 哪些 spawn 错误算「启动失败」。
 *
 * 其余错误（ENOBUFS / ETIMEDOUT / 未知）都意味着**进程已经启动**，
 * 不能因为“输出太多”或“没及时退出”就把工具判成不可用。
 */
const LAUNCH_FAILURE_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'EISDIR',
  'ELOOP',
  'ENOEXEC',
  'EINVAL',
])

function isLaunchFailure(error: NodeJS.ErrnoException | undefined): boolean {
  if (!error) return false
  return LAUNCH_FAILURE_CODES.has(String(error.code ?? ''))
}

/** 单次探测的结果（永不抛异常；失败也返回结构化信息）。 */
export interface BinaryProbeResult {
  /** 进程成功启动（无 spawn 错误、未超时）——**可用性只看这个** */
  runnable: boolean
  /** 识别到的版本号（识别不出时为 undefined，不影响可用性） */
  version?: string
  /** 实际使用的探测参数（用于 UI/日志诊断） */
  args?: string[]
  /** 子进程退出码 */
  exitCode?: number | null
  /** 探测输出（stdout + stderr 首行，已截断） */
  output?: string
  /** 失败原因（ENOENT / 超时 / 其它） */
  error?: string
}

function truncateProbeOutput(text: string): string | undefined {
  const trimmed = text.trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' · ')
  if (!trimmed) return undefined
  return trimmed.length > PROBE_OUTPUT_LIMIT ? `${trimmed.slice(0, PROBE_OUTPUT_LIMIT)}…` : trimmed
}

function parseVersion(text: string, spec: ToolSpec): string | undefined {
  const pattern = spec.versionPattern ?? DEFAULT_VERSION_PATTERN
  return pattern.exec(text)?.[1]
}

/**
 * 探测一个具体二进制。
 *
 * 返回的 `runnable` 只看「进程能不能被启动」；`version` 依次尝试
 * `spec.versionProbeArgs`（缺省 `[['--version'], ['-V'], ['version']]`），
 * 任意一组成功且能解析出版本号即返回，否则 `version` 为 undefined。
 */
export function probeBinary(path: string, spec: ToolSpec): BinaryProbeResult {
  const argSets = spec.versionProbeArgs ?? DEFAULT_VERSION_PROBE_ARGS
  let last: BinaryProbeResult = { runnable: false, error: '未执行任何探测' }

  for (const args of argSets) {
    const result = spawnSync(path, args, {
      stdio: 'pipe',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      cwd: getProbeCwd(),
    })

    const output = truncateProbeOutput(`${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`)
    // 启动失败（找不到 / 无权限 / 非法可执行文件）才是“不可用”；
    // 超时、输出过大（ENOBUFS）等一律视为“已启动但读不出版本”
    const launchFailure = isLaunchFailure(result.error)
    const runnable = !launchFailure && (result.status !== null || result.error === undefined || Boolean(output))
    const probe: BinaryProbeResult = {
      runnable,
      args: [...args],
      exitCode: result.status,
      output,
      ...(result.error ? { error: result.error.message } : {}),
    }

    if (!runnable) {
      last = probe
      continue
    }
    const version = output ? parseVersion(output, spec) : undefined
    if (version) return { ...probe, version }
    // 能跑但没有可识别版本号：记下来，继续试其它参数组（可能只是这组参数不输出版本）
    last = probe
  }

  return last
}

/**
 * 测试钩子：替换二进制探测实现。
 *
 * 生产路径永远是 `probeBinary`（spawnSync 执行版本探测）；测试里注入假实现后，
 * 就不需要在三平台上造一个真的可执行文件（Windows 无法直接 spawn .cmd 脚本），
 * 同时安装/状态/卸载全链路仍然走真实代码。
 */
export type BinaryProbe = (path: string, spec: ToolSpec) => BinaryProbeResult

let binaryProbeOverride: BinaryProbe | undefined

export function setBinaryProbeForTesting(probe: BinaryProbe | undefined): void {
  binaryProbeOverride = probe
}

function runProbe(path: string, spec: ToolSpec): BinaryProbeResult {
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
 * **可用性只看进程能否启动**（`probe.runnable`），与能否识别出版本号无关：
 * 未来接入没有 `--version`（或把版本写到别处、退出码非 0、输出不是 x.y.z）的工具，
 * 依然会被当成可用，只是 `version` 为空。
 *
 * `options.enabled` 用于配置界面的「未保存预览」：覆盖 config.yaml 里的启用状态。
 */
export function resolveToolBinary(id: ToolId, options?: { enabled?: boolean }): ResolvedToolBinary | undefined {
  const spec = getToolSpec(id)
  if (!spec) return undefined
  if (!(options?.enabled ?? isToolEnabled(id))) return undefined

  const fromProbe = (path: string, source: ToolSource, probe: BinaryProbeResult): ResolvedToolBinary => ({
    path,
    source,
    // 健壮性：即使自定义探测（如测试钩子）只给了原始输出，也尝试再解析一次版本号
    version: probe.version ?? (probe.output ? parseVersion(probe.output, spec) : undefined),
    runnable: true,
    probe,
  })

  const override = process.env[spec.envPathVar]
  if (override && override.trim().length > 0) {
    const candidate = override.trim()
    const probe = runProbe(candidate, spec)
    return probe.runnable ? fromProbe(candidate, 'system', probe) : undefined
  }

  const managedPath = getManagedBinaryPath(spec)
  if (existsSync(managedPath)) {
    const probe = runProbe(managedPath, spec)
    if (probe.runnable) return fromProbe(managedPath, 'managed', probe)
  }

  for (const candidate of spec.systemBinaryNames) {
    const probe = runProbe(candidate, spec)
    if (probe.runnable) return fromProbe(candidate, 'system', probe)
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
  /** 探测到的版本号；识别不出时为空（**不影响可用性**） */
  version?: string
  /** 版本探测输出（首行摘要），版本号识别失败时用于诊断展示 */
  versionOutput?: string
  /** 实际生效的版本探测参数 */
  versionProbeArgs?: string[]
  /** 安装台账里记录的「当初装的是哪个版本」（与探测结果互补，见 tools-state.json） */
  installedVersion?: string
  /** 仅当同时有台账版本与探测版本且两者不同时给出（不阻断使用，仅提示） */
  versionMismatch?: { expected: string; actual: string }
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
  // 台账只在“托管安装存在”时可信：文件被手动删除时不能再拿它当事实
  const ledgerVersion = managedExists ? readToolLedger().installed[spec.id]?.version : undefined
  const version = resolved?.version
  const versionMismatch =
    version && ledgerVersion && version !== ledgerVersion ? { expected: ledgerVersion, actual: version } : undefined

  return {
    id: spec.id,
    displayName: spec.displayName,
    state,
    path: resolved?.path,
    version,
    versionOutput: resolved?.probe?.output,
    versionProbeArgs: resolved?.probe?.args && resolved.probe.args.length > 0 ? resolved.probe.args : undefined,
    installedVersion: ledgerVersion,
    ...(versionMismatch ? { versionMismatch } : {}),
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
 * 流程：解析版本 → 下载资产 → 校验指纹 → 解包到临时目录 → 找到二进制 → 落到 ~/.zread-pi/bin
 * → **可执行性**校验（只看进程能否启动）→ 写入安装台账 → 广播变更。
 * 任何一步失败都会清理临时文件并抛出可读错误。
 *
 * 注意：校验不再要求「能读出版本号」——未来接入没有版本开关的工具也能安装成功，
 * 只是 `version` 为空（此时台账里的“当初装的版本”仍然可展示）。
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
    if (!verified.runnable) {
      rmSync(target, { force: true })
      const reason = verified.error ? `（${verified.error}）` : ''
      throw new ToolInstallError(`安装校验失败：${target} 无法执行${reason}`)
    }

    // 台账记录「当初装的是哪个版本」：探测不到时它就是唯一可展示的版本信息
    recordToolInstall(spec.id, {
      version,
      installedAt: new Date().toISOString(),
      asset: assetName,
      binary: basename(target),
    })

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

/** 卸载：只删除托管目录里的二进制（系统安装不受影响），并清掉台账记录。 */
export async function uninstallTool(id: ToolId): Promise<boolean> {
  const spec = getToolSpec(id)
  if (!spec) throw new ToolInstallError(`未登记的工具：${id}`)
  const target = getManagedBinaryPath(spec)
  if (!existsSync(target)) {
    // 文件已被手动删除：台账也要一起清，避免状态不一致
    clearToolInstall(spec.id)
    return false
  }
  rmSync(target, { force: true })
  clearToolInstall(spec.id)
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
