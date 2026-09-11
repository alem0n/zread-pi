import { defineConfig } from 'tsup'

export default defineConfig(() => {
  const isDev = process.env.NODE_ENV !== 'production'

  return {
    entry: ['src/index.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: isDev,
    minify: !isDev,
    clean: true,
    external: [
      '@zread-pi/agent',
      '@zread-pi/skeleton',
      '@zread-pi/core',
      '@zread-pi/types'
    ],
  }
})
