#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '../dist')
const pkgPath = resolve(__dirname, '../../../package.json')

// 读取仓库根 package.json 获取项目版本号（AGENTS.md §4.4：根 package.json 是唯一版本来源）
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
const version = pkg.version

mkdirSync(distDir, { recursive: true })

// 注入 CLI_VERSION 常量（模拟 tsup 的 define 功能）
const entryContent = `#!/usr/bin/env bun
const CLI_VERSION = "${version}";
import '../src/index.ts';
`

writeFileSync(resolve(distDir, 'index.js'), entryContent)

console.log(`Generated dist/index.js (version: ${version})`)
