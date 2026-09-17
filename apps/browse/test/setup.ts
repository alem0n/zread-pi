/**
 * 组件级测试的公共前置：happy-dom 全局注册 + 布局桩 + jest-dom matcher 注册。
 *
 * 由 bunfig.toml 的 [test].preload 在每个测试文件之前执行一次。
 * React / @testing-library/react 只认 globalThis 上的 DOM，所以要把
 * happy-dom 的 Window 实例摊到全局；Node/Bun 已有的（MessageChannel、
 * queueMicrotask、navigator …）不覆盖。
 *
 * 注意：jest-dom 的 matcher 会传递导入 @testing-library/dom，它的 screen
 * 在「模块求值时」就缓存了 document 是否存在。因此必须先把全局 DOM 注册好，
 * 再动态导入 matcher——静态 import 的求值顺序不可控。
 */

import { Window } from 'happy-dom';

const domWindow = new Window();

// happy-dom 暴露 400+ 个 DOM 全局（HTMLElement / document / TextEncoder …）；
// 只补 globalThis 上还没有的，避免覆盖 Node/Bun 原生实现。
const globals = domWindow as unknown as Record<string, unknown>;
const target = globalThis as Record<string, unknown>;
for (const key of Object.keys(globals)) {
  if (key === 'window' || key === 'self' || key === 'top' || key === 'parent' || key === 'globalThis') continue;
  if (target[key] !== undefined) continue;
  // 少数宿主全局被声明为 { value: undefined, configurable: false }，跳过
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor !== undefined && !descriptor.configurable) continue;
  Object.defineProperty(target, key, {
    value: globals[key],
    writable: true,
    configurable: true,
  });
}

target.window = domWindow as unknown as Window;
target.document = domWindow.document;
// navigator / getComputedStyle 不是 Window 的自有可枚举键，显式补
if (target.navigator === undefined) target.navigator = (domWindow as unknown as { navigator: Navigator }).navigator;
if (target.getComputedStyle === undefined) {
  target.getComputedStyle = (domWindow as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle.bind(domWindow);
}

/**
 * happy-dom 不做布局，clientWidth / clientHeight / getBoundingClientRect 恒为 0，
 * 依赖测量的组件（时间线宽度 / 虚拟化视口高度 / 光标坐标换算）无法测。
 * 默认给 800×600；需要别的尺寸时在 render 之前调用
 * stubElementLayout({ width: 200 }) 覆盖。getBoundingClientRect 同步返回该尺寸，
 * 否则 valueAt(clientX) 的 ratio 会被钳到 0/1，缩放总是贴到边缘。
 */
export function stubElementLayout(dimensions: { width?: number; height?: number }): void {
  const width = dimensions.width;
  const height = dimensions.height;
  if (width !== undefined) {
    Object.defineProperty(globalThis.HTMLElement.prototype, 'clientWidth', {
      get(): number {
        return width;
      },
      configurable: true,
    });
  }
  if (height !== undefined) {
    Object.defineProperty(globalThis.HTMLElement.prototype, 'clientHeight', {
      get(): number {
        return height;
      },
      configurable: true,
    });
  }
  if (width !== undefined || height !== undefined) {
    Object.defineProperty(globalThis.HTMLElement.prototype, 'getBoundingClientRect', {
      value(): DOMRect {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width ?? 0,
          bottom: height ?? 0,
          width: width ?? 0,
          height: height ?? 0,
          toJSON(): unknown {
            return this;
          },
        };
      },
      configurable: true,
    });
  }
}

stubElementLayout({ width: 800, height: 600 });

// 全局 DOM 就位之后才能导入会缓存 document 的模块
const { expect, afterEach } = await import('bun:test');
const matchers = await import('@testing-library/jest-dom/matchers');
expect.extend(
  matchers as unknown as Record<
    string,
    (actual: unknown, ...rest: unknown[]) => { pass: boolean; message: () => string }
  >,
);

// RTL 的自动 cleanup 依赖宿主框架的 afterEach 钩子，在 bun:test 下不会自动注册；
// 不清理的话 document 会跨测试累积，screen 查询全部变成「找到多个元素」。
const { cleanup } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
});
