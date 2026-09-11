/**
 * 外部工具注册表
 *
 * 目前登记 rg（ripgrep）与 fd；**新增工具只需在这里加一条 ToolSpec**，
 * 配置界面、安装器、状态探测与 agent-runtime 的搜索工具都会自动跟上：
 *  - 配置：`config.yaml` 的 `tools.<id>.enabled`（`validateConfig` 按注册表补默认值）
 *  - 安装：`installer.ts` 的 install/uninstall（按 spec 选择 release 资产）
 *  - 探测：`resolveToolBinary()`（托管目录 → 系统 PATH）
 *  - UI：`apps/cli/src/views/config-tools`（列表与详情页都是注册表驱动）
 *
 * 资产命名与镜像策略参考上游 pi 的 `utils/tools-manager.ts`：
 *   资产名 = spec.getAssetName(version, platform, arch)
 *   下载地址 = ${ZREAD_PI_TOOLS_BASE_URL|https://github.com}/${repo}/releases/download/${tagPrefix}${version}/${asset}
 */

export type ToolId = string

export interface ToolSpec {
  /** 稳定 id（配置键、路由参数、日志都用它） */
  id: ToolId
  /** 展示名（如 ripgrep） */
  displayName: string
  /** 命令行 / 托管文件名（如 rg） */
  binaryName: string
  /** 系统 PATH 里可能出现的其它命令名（Debian 系把 fd 命名为 fdfind） */
  systemBinaryNames: string[]
  /** GitHub 仓库（owner/name） */
  repo: string
  /** release tag 前缀（'v' 或 ''） */
  tagPrefix: string
  /**
   * 版本探测：按顺序尝试的参数组合。
   *
   * 缺省 `[['--version'], ['-V'], ['version']]`——不同工具的习惯差异很大
   * （`-V` / `-v` / `version` 子命令都有），且有的工具压根没有版本开关。
   * **探测失败不影响「工具是否可用」的判定**：只要进程能启动即视为可用，
   * 版本号只是 UI 上的附加信息（见 installer.probeBinary）。
   */
  versionProbeArgs?: string[][]
  /** 从探测输出里提取版本号（缺省：宽松匹配 1.2 / 1.2.3 / v1.2.3-rc1 / 2024.01.2） */
  versionPattern?: RegExp
  /**
   * 该工具驱动哪些 Agent 工具（UI 展示与文档用）
   */
  usedBy: string[]
  /** 工具的用途说明（i18n key 后缀，见 i18n 的 tools.usage.<id>） */
  usageKey: string
  /** 允许通过环境变量显式指定二进制路径（打包/离线/测试用） */
  envPathVar: string
  /** 选择 release 资产；返回 null 表示该平台没有可用资产 */
  getAssetName: (version: string, platform: NodeJS.Platform, arch: string) => string | null
  /**
   * 可选的校验文件（同目录下的 `.sha256` 之类）。
   * 返回文件名时，安装流程会先校验归档指纹再解包（rg 提供，fd 不提供）。
   */
  checksumAsset?: (version: string, assetName: string) => string | undefined
  /** 固定版本（部分平台没有 latest 解析能力的兜底） */
  pinnedVersion?: (platform: NodeJS.Platform, arch: string) => string | undefined
}

function unixAsset(project: string, version: string, arch: string, target: string): string {
  return `${project}-${version}-${arch}-${target}.tar.gz`
}

function windowsAsset(project: string, version: string, arch: string): string {
  return `${project}-${version}-${arch}-pc-windows-msvc.zip`
}

function rustArch(arch: string): string {
  return arch === 'arm64' ? 'aarch64' : 'x86_64'
}

export const RG_TOOL: ToolSpec = {
  id: 'rg',
  displayName: 'ripgrep',
  binaryName: 'rg',
  systemBinaryNames: ['rg'],
  repo: 'BurntSushi/ripgrep',
  tagPrefix: '',
  versionPattern: /ripgrep\s+(\d+(?:\.\d+)+(?:[-+][\w.]+)?)/i,
  usedBy: ['Grep'],
  usageKey: 'rg',
  envPathVar: 'ZREAD_PI_RG_PATH',
  getAssetName: (version, platform, arch) => {
    const archStr = rustArch(arch)
    if (platform === 'darwin') return unixAsset('ripgrep', version, archStr, 'apple-darwin')
    if (platform === 'linux') return unixAsset('ripgrep', version, archStr, 'unknown-linux-musl')
    if (platform === 'win32') return windowsAsset('ripgrep', version, archStr)
    return null
  },
  // ripgrep 为每个资产同时发布 `<asset>.sha256`，可以校验后再解包
  checksumAsset: (_version, assetName) => `${assetName}.sha256`,
}

export const FD_TOOL: ToolSpec = {
  id: 'fd',
  displayName: 'fd',
  binaryName: 'fd',
  systemBinaryNames: ['fd', 'fdfind'],
  repo: 'sharkdp/fd',
  tagPrefix: 'v',
  versionPattern: /\bfd\s+(\d+(?:\.\d+)+(?:[-+][\w.]+)?)/i,
  usedBy: ['Glob'],
  usageKey: 'fd',
  envPathVar: 'ZREAD_PI_FD_PATH',
  // 注意：fd 的资产名带 v 前缀（fd-v10.5.0-x86_64-pc-windows-msvc.zip），
  // ripgrep 则不带（ripgrep-15.2.0-x86_64-pc-windows-msvc.zip）；两者不能共用同一个命名模板
  getAssetName: (version, platform, arch) => {
    const project = `fd-v${version}`
    const archStr = rustArch(arch)
    if (platform === 'darwin') return `${project}-${archStr}-apple-darwin.tar.gz`
    if (platform === 'linux') return `${project}-${archStr}-unknown-linux-musl.tar.gz`
    if (platform === 'win32') return `${project}-${archStr}-pc-windows-msvc.zip`
    return null
  },
  // 与上游一致：darwin/x64 固定 10.3.0（fd 在 macOS x64 上的兼容性保守选择）
  pinnedVersion: (platform, arch) => (platform === 'darwin' && arch === 'x64' ? '10.3.0' : undefined),
}

/** 注册表（顺序即 UI 展示顺序） */
export const TOOL_REGISTRY: ToolSpec[] = [RG_TOOL, FD_TOOL]

export function listTools(): ToolSpec[] {
  return [...TOOL_REGISTRY]
}

export function getToolSpec(id: ToolId): ToolSpec | undefined {
  return TOOL_REGISTRY.find((spec) => spec.id === id)
}

export function toolIds(): ToolId[] {
  return TOOL_REGISTRY.map((spec) => spec.id)
}

/** 归档类型 → 解包实现（见 archive.ts） */
export function archiveKindOf(assetName: string): 'tar.gz' | 'zip' | null {
  if (assetName.endsWith('.tar.gz')) return 'tar.gz'
  if (assetName.endsWith('.zip')) return 'zip'
  return null
}
