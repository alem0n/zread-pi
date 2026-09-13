/**
 * tsup / esbuild 插件：把 `.md` 文件打成字符串模块（`export default "..."`）。
 *
 * 背景：文风纪律提示词以 `.md` vendored（人类可读、便于与上游 humanizer 对照），
 * 源码里用 `import ... with { type: 'text' }` 引入：
 * - Bun（`bun run cli` / 测试）：原生支持 import attributes 的 text 类型，直接得到字符串；
 * - tsup / esbuild：**原生 text loader 不接受 `type: 'text'` 属性**
 *   （`Importing with a type attribute of "text" is not supported`），
 *   因此这里用插件接管 `.md` 的解析与加载，绕过属性校验并直接生成字符串模块。
 *
 * zread-pi 的 `apps/cli` 与 `packages/orchestrator` 两处 tsup 配置共用本插件。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Plugin } from 'esbuild'

export function mdTextPlugin(): Plugin {
  return {
    name: 'zread-pi-md-text',
    setup(build) {
      build.onResolve({ filter: /\.md$/ }, (args) => {
        // 只处理相对/绝对路径的提示词文件；裸包名（如依赖里的 .md）不接管
        if (!args.path.startsWith('.') && !isAbsolute(args.path)) return null
        return { path: resolve(args.resolveDir, args.path) }
      })
      build.onLoad({ filter: /\.md$/ }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf-8'))}`,
        loader: 'js',
        watchFiles: [args.path],
      }))
    },
  }
}
