import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { cp } from 'fs/promises'
import { join, resolve } from 'path'
import { defineConfig } from 'tsup'
import { mdTextPlugin } from '../../tools/tsup-md-text'

function findFileRecursively(dir: string, target: string): string | null {
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile() && entry === target) return fullPath
        if (stat.isDirectory()) {
          const found = findFileRecursively(fullPath, target)
          if (found) return found
        }
      } catch { /* skip */ continue }
    }
  } catch { /* skip */ }
  return null
}

export default defineConfig(() => {
  // 版本号以仓库根 package.json 为准（AGENTS.md §4.4），确保界面显示的项目版本一致
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string }

  return {
    entry: ['src/index.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: false,
    minify: true,
    clean: true,
    bundle: true,
    noExternal: [/.*/],
    platform: 'node',
    // 文风纪律提示词（orchestrator 的 prompts/*.md）以字符串形式内联进产物
    esbuildPlugins: [mdTextPlugin()],
    define: {
      // 替换 globalThis.CLI_VERSION 为版本号常量
      'globalThis.CLI_VERSION': JSON.stringify(pkg.version),
      // 标记这是打包后的版本（运行时不需要 NODE_ENV）
      'globalThis.IS_PACKAGED': 'true',
    },
    banner: {
      js: '#!/usr/bin/env node\nimport{createRequire as __createRequire}from"module";import{fileURLToPath as __fileURLToPath}from"url";import{dirname as __dirnameFn}from"path";const require=__createRequire(import.meta.url);const __filename=__fileURLToPath(import.meta.url);const __dirname=__dirnameFn(__filename);',
    },
    onSuccess: async () => {
      const cwd = process.cwd()

      // 复制 browse 的构建产物到 dist/browse
      const browseDistPath = resolve(cwd, '../browse/dist')
      const browseTargetPath = join(cwd, 'dist/browse')
      if (existsSync(browseDistPath)) {
        await cp(browseDistPath, browseTargetPath, { recursive: true })
      } else {
        console.warn(
          '[cli] 未找到 apps/browse/dist；打包产物将缺少「浏览文档」前端资源。' +
            '请先运行 bun install 与 bun run browse:build。',
        )
      }

      // 复制 WASM 文件（repo-analyzer 的 Tree-sitter 需要）
      const nmPath = resolve(cwd, '../../node_modules')
      const copyWasm = async (name: string) => {
        const found = findFileRecursively(nmPath, name)
        if (found && existsSync(found)) {
          await cp(found, join(cwd, `dist/${name}`))
        }
      }
      await Promise.all([
        copyWasm('tree-sitter.wasm'),
        copyWasm('mappings.wasm'),
        // 图片处理管线（photon / Rust WASM）：打包后按 __dirname 读取，必须与 dist 同目录
        copyWasm('photon_rs_bg.wasm'),
      ])
    },
  }
})
