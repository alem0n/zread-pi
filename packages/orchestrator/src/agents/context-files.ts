/**
 * 目标仓库上下文文件（AGENTS.md / CLAUDE.md …）加载。
 *
 * 移植自 pi/packages/coding-agent/src/core/resource-loader.ts 的
 * `loadContextFileFromDir()` / `loadProjectContextFiles()`，保留其候选文件顺序与
 * 「先全局、后项目」的注入顺序；与上游的差异只有一处（已在下方标注）：
 * 只读取目标目录本身，不向上遍历父目录 —— zread-pi 的工作目录是被生成文档的仓库，
 * 父目录（如用户主目录）里的 AGENTS.md 与本次文档无关，注入反而增加噪音与 token。
 *
 * 用途：页面 / 蓝图 Agent 生成文档时，先把目标仓库自述（架构说明、约定、术语表）
 * 注入系统提示，让 wiki 与仓库自述保持一致，减少「纯靠读代码猜」。注入格式与 pi 的
 * `buildSystemPrompt({ contextFiles })` 一致（`<project_context>` 块）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 候选文件名（顺序即优先级；大小写变体覆盖 Linux 上常见的全大写写法） */
const CONTEXT_FILE_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

/** 单个上下文文件的注入上限（防止超长自述把每个页面 Agent 的上下文顶爆） */
export const CONTEXT_FILE_MAX_BYTES = 64 * 1024

export interface ProjectContextFile {
  /** 文件绝对路径 */
  path: string
  /** 文件内容（已去 BOM；超长时截断并追加说明） */
  content: string
}

/** 去掉 UTF-8 BOM（Windows 编辑器常见），避免注入后提示词首行出现不可见字符 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 按候选顺序读取目录下的第一个上下文文件；都没有时返回 null */
export function loadContextFileFromDir(dir: string): ProjectContextFile | null {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = join(dir, filename)
    if (!existsSync(filePath)) continue
    try {
      if (!statSync(filePath).isFile()) continue
      return {
        path: filePath,
        content: readContextFileContent(filePath),
      }
    } catch {
      // 读不了就试下一个候选（例如权限问题），不让上下文加载失败
    }
  }
  return null
}

function readContextFileContent(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8')
  const content = stripBom(raw)
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes <= CONTEXT_FILE_MAX_BYTES) return content

  // 按字节截断（可能切断多字节字符，用 Buffer 再 toString 保证不产生乱码）
  const truncated = Buffer.from(content, 'utf-8').subarray(0, CONTEXT_FILE_MAX_BYTES).toString('utf-8')
  return `${truncated}\n\n[... context file truncated at ${CONTEXT_FILE_MAX_BYTES / 1024} KiB ...]`
}

export interface LoadProjectContextFilesOptions {
  /** 目标项目目录（生成文档的仓库根目录） */
  cwd: string
  /** 全局配置目录（`~/.zread-pi`），同级目录下的 AGENTS.md / CLAUDE.md 对所有项目生效 */
  agentDir: string
}

/**
 * 加载「全局 + 目标目录」的上下文文件（后者覆盖优先语义：候选第一个命中的即用它）。
 *
 * 顺序：全局上下文在前，项目上下文在后（与 pi 一致，后出现的更贴近当前任务）。
 */
export function loadProjectContextFiles(options: LoadProjectContextFilesOptions): ProjectContextFile[] {
  const contextFiles: ProjectContextFile[] = []
  const seen = new Set<string>()

  const globalContext = loadContextFileFromDir(options.agentDir)
  if (globalContext) {
    contextFiles.push(globalContext)
    seen.add(globalContext.path)
  }

  const projectContext = loadContextFileFromDir(options.cwd)
  if (projectContext && !seen.has(projectContext.path)) {
    contextFiles.push(projectContext)
  }

  return contextFiles
}

/**
 * 把上下文文件拼成注入块（与 pi 的 `buildSystemPrompt` 完全同格式）。
 *
 * 没有上下文文件时返回空字符串，调用方直接拼接即可。
 */
export function formatContextFiles(contextFiles: ProjectContextFile[]): string {
  if (contextFiles.length === 0) return ''

  let block = '\n\n<project_context>\n\n'
  block += 'Project-specific instructions and guidelines:\n\n'
  for (const { path, content } of contextFiles) {
    block += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`
  }
  block += '</project_context>\n'
  return block
}

/** 「基础系统提示 + 目标仓库上下文」：create-agent 的唯一入口 */
export function withProjectContext(systemPrompt: string, contextFiles: ProjectContextFile[]): string {
  const block = formatContextFiles(contextFiles)
  return block ? `${systemPrompt}${block}` : systemPrompt
}
