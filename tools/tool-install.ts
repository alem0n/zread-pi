/**
 * tool-install.ts —— 无需启动 TUI 的外部工具安装/卸载入口
 *
 * 用途：
 *  - 无头环境（CI / 服务器）里预装 rg / fd；
 *  - 手动验证真实 GitHub Releases 的下载与校验链路（配置界面走的是同一份实现）。
 *
 * 用法（跨平台，经由 bun run）：
 *   bun run tools:install                 # 列出状态
 *   bun run tools:install -- fd           # 安装 fd（最新版）
 *   bun run tools:install -- rg 15.2.0    # 安装指定版本
 *   bun run tools:install -- fd --remove  # 卸载（只删 zread-pi 托管副本）
 *
 * 安装目录默认 ~/.zread-pi/bin，可用 ZREAD_PI_TOOLS_DIR 覆盖；
 * 下载源默认 https://github.com，可用 ZREAD_PI_TOOLS_BASE_URL 指向内网镜像。
 */

import {
  getToolStatuses,
  getManagedBinDir,
  getToolSpec,
  installTool,
  uninstallTool,
  type ToolInstallProgress,
} from '../packages/utils/src/index.js'

const argv = process.argv.slice(2)
const remove = argv.includes('--remove')
const positional = argv.filter((argument) => !argument.startsWith('--'))
const [toolId, version] = positional

if (!toolId) {
  console.log(`外部工具状态（安装目录：${getManagedBinDir()}）`)
  for (const status of getToolStatuses()) {
    const detail = [status.state, status.version, status.path].filter(Boolean).join(' · ')
    console.log(`  ${status.id.padEnd(3)} ${status.displayName.padEnd(10)} ${detail}`)
  }
  console.log('\n用法：bun run tools:install -- <rg|fd> [版本] [--remove]')
  process.exit(0)
}

if (!getToolSpec(toolId)) {
  console.error(`未登记的工具：${toolId}`)
  process.exit(1)
}

if (remove) {
  const removed = await uninstallTool(toolId)
  console.log(removed ? `已卸载 ${toolId}` : `${toolId} 没有 zread-pi 托管副本`)
  process.exit(0)
}

const phases: Record<ToolInstallProgress['phase'], string> = {
  resolving: '解析版本',
  downloading: '下载中',
  extracting: '解包中',
  verifying: '校验中',
  done: '完成',
}

let stage = ''
try {
  const status = await installTool(toolId, {
    version,
    onProgress: (progress) => {
      const line = `[${String(progress.percent).padStart(3)}%] ${phases[progress.phase]}`
      if (line !== stage) {
        stage = line
        console.log(line)
      }
    },
  })
  console.log(`已安装 ${status.id} ${status.version ?? ''} → ${status.path}`)
} catch (error) {
  console.error(`安装失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
