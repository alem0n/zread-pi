/**
 * 把 @testing-library/jest-dom 的 matcher 类型桥接到 bun:test 的 expect。
 *
 * jest-dom v7 只为 jest / vitest 提供现成的 globals 类型；bun:test 的
 * Matchers 接口需要手动声明合并，否则 `.toBeInTheDocument()` / `.toHaveStyle()`
 * 编译不过（运行时由 setup.ts 的 expect.extend 注册，不缺实现，只缺类型）。
 */

import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'bun:test' {
  interface Matchers<R = unknown> extends TestingLibraryMatchers<unknown, R> {}
}
