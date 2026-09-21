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

// Node 22 原生提供全局 Event / CustomEvent（其余事件类只有 happy-dom 提供），
// 它们与 happy-dom 的 Event 不是同一个类（不同 realm）。组件库（如 Radix 的
// FocusScope）用全局 new CustomEvent(...) 派发到 happy-dom 的节点上时，
// happy-dom 的 dispatchEvent 做 instanceof Event 校验会失败并抛
// "parameter 1 is not of type 'Event'"。测试的 DOM 就是 happy-dom，
// 事件类必须同 realm，这里显式覆盖到 happy-dom 的实现。
target.Event = domWindow.Event;
target.CustomEvent = domWindow.CustomEvent;

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

/**
 * happy-dom 的 SVGElement.getBBox 同样恒返回 0x0（不做任何文本布局），而
 * mermaid 的 sequence / state 在排版前要用它量文本宽度，0x0 会抛
 * "svg element not in render tree"。按字符数给一个合理尺寸，让这两类图在
 * 测试环境也能真正渲染（真实浏览器无需此补丁）。
 *
 * **已知边界**：dagre 的**边标签**几何求解（`-->|标签|` / `A --> B : 标签`）
 * 需要精确的文本包围盒，粗略桩过不了「Could not find a suitable point for the
 * given distance」；flowchart 与 state 的边标签在 happy-dom 下都渲染不出来，
 * 与 dagre 布局锁定无关。带边标签的图只做结构性路由断言，不做渲染断言。
 */
const SVG_TEXT_PROTO = Object.getPrototypeOf(
  document.createElementNS('http://www.w3.org/2000/svg', 'text'),
) as SVGTextElement;
SVG_TEXT_PROTO.getBBox = function getBBox(): DOMRect {
  const chars = (this.textContent ?? '').length;
  const width = Math.max(chars * 8, 4);
  return {
    x: 0,
    y: -16,
    width,
    height: 16,
    top: -16,
    right: width,
    bottom: 0,
    left: 0,
    toJSON(): unknown {
      return this;
    },
  };
};

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
