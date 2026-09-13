import { defineConfig } from 'tsup'
import { mdTextPlugin } from '../../tools/tsup-md-text'

export default defineConfig(() => {
  const isDev = process.env.NODE_ENV !== 'production'

  return {
    entry: ['src/index.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: isDev,
    minify: !isDev,
    clean: true,
    // 文风纪律提示词（src/prompts/*.md）以字符串形式内联进产物
    esbuildPlugins: [mdTextPlugin()],
    external: [
      '@zread-pi/agent',
      '@zread-pi/skeleton',
      '@zread-pi/core',
      '@zread-pi/types'
    ],
  }
})
