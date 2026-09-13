/**
 * *.md 文本导入的类型声明。
 *
 * 文风纪律提示词以 `.md` 形式 vendored 在 `prompts/` 下（人类可读 + 便于与上游对照），
 * 通过 `import ... with { type: 'text' }` 作为字符串引入：
 * - Bun（源码运行 / 测试）：原生支持 import attributes 的 text 类型；
 * - tsup / esbuild（打包）：由 tsup 配置的 `loader: { '.md': 'text' }` 处理。
 */
declare module '*.md' {
  const content: string
  export default content
}
