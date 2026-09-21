# 浏览站组件级测试

`bun:test` + `happy-dom` + `@testing-library/react` + `@testing-library/jest-dom`。

## 运行

```bash
bun run test:components          # 运行全部组件测试（等价于 cd apps/browse && bun test）
bun run test:components -- --watch  # 监听（bun test 自带 watch 模式）
```

组件测试在 `bun run test`（经 `test:tui → test:browse`）与 `bun run typecheck`
（`apps/browse/tsconfig.test.json`）里都会跑到。

## 写一个组件测试

文件放 `src/<feature>/__tests__/<Component>.test.tsx`，与被测组件同目录：

```tsx
import { describe, it, expect } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { MyComponent } from '../MyComponent';

describe('MyComponent', () => {
  it('点击按钮自增', () => {
    render(<MyComponent />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
```

## 基建做了什么（`test/setup.ts`，由 `bunfig.toml` 的 preload 自动加载）

- **happy-dom 全局注册**：React / RTL 只认 `globalThis` 上的 DOM，setup 把
  happy-dom 的 `Window` 实例摊到全局（不覆盖 Node/Bun 已有的）。
- **jest-dom matcher 注册**：`toBeInTheDocument` / `toHaveStyle` / `toBeVisible` …。
- **测试间自动清理**：RTL 的自动 cleanup 在 `bun:test` 下不会注册，setup 显式
  `afterEach(cleanup)`，否则 `screen` 查询会撞上前一个测试残留的 DOM。
- **布局桩 `stubElementLayout({ width, height })`**：happy-dom 不做布局，
  `clientWidth` / `clientHeight` 恒为 0；默认给 800×600，需要别的尺寸在
  `render` **之前**调用（组件在挂载时就测量）。

## 踩过的坑（写新测试前读一遍）

1. **`getByText` 只匹配元素的「直接文本子节点」**。键名冒号在嵌结 span 里时
   （`<span>"name"<span>:</span></span>`）不能拼成 `'"name":'`，要按键名与值
   分别断言，或用 `container.querySelector`。

2. **触发状态变更必须用 `fireEvent`**（或 `user-event`）。直接 `el.click()`
   不会同步刷新 React 状态，紧接着的断言读到的是旧 DOM。

3. **依赖 `document` 的模块要晚于全局注册导入**。`@testing-library/dom` 的
   `screen` 在「模块求值时」就缓存了 document 是否存在，所以 setup 里 happy-dom
   注册完成之前不能静态导入它——jest-dom matcher 与 RTL 都用动态导入。

4. **`useT()` 有默认 Context**，组件不用包 `I18nProvider` 就能渲染（默认 en-US）。
   期望文案用 `createTranslate('en-US')` 派生，不要硬编码字符串，改字典时才不会漏。

5. **虚拟化开关**：行数低于 `VIRTUALIZATION_THRESHOLD`（100）时不窗口化，
   小数据集测窗口行为会失真；要测窗口数学去 `packages/trajectory` 的模型层单测。

6. **happy-dom 的 `WheelEvent` 不从 init 读 `clientX`**（MouseEvent 会读）。
   时间线的缩放以光标位置为中心，`valueAt(undefined)` 会算出 NaN 把缩放视口
   设成 NaN——**整条时间线的 span 塌成一条 `left: NaN` 的色块**。真实浏览器的
   WheelEvent 恒有数值 clientX，这是 happy-dom 的限制。滚轮事件这样发：

   ```ts
   const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
   Object.defineProperty(event, 'clientX', { value: 400 });
   act(() => { container.dispatchEvent(event); });
   ```

   `dispatchEvent` 不走 act，不包的话 setState 不会同步刷新（`fireEvent` 自带包裹，
   所以 mouse 系列事件没有这个问题）。

7. **布局桩包含 `getBoundingClientRect`**：`stubElementLayout` 现在同时桩
   `clientWidth/clientHeight` 与 `getBoundingClientRect`。只桩前者的话，
   `valueAt` 的光标比例会被 `Math.min(1, x/0)` 钳到 1，光标恒在右缘，
   缩放几何不可复现。

8. **原生事件**：组件用 `addEventListener('wheel', …, { passive: false })` 挂的
   监听（时间线缩放）用 `fireEvent.wheel(el, { deltaY: 120 })` 触发即可，
   `dispatchEvent` 同样走原生监听——但见第 6 条，WheelEvent 的 clientX 要手动塞、
   且必须包 `act`。

9. **Node 22 原生提供全局 `Event` / `CustomEvent`，与 happy-dom 的不是同一个类**
   （不同 realm；其余事件类只有 happy-dom 提供）。组件库往 happy-dom 节点上
   派发 `new CustomEvent(...)` 时（Radix 的 `FocusScope` 在 `Dialog.Content`
   挂载时就会派发 `AUTOFOCUS_ON_MOUNT`），happy-dom 的 `dispatchEvent` 做
   `instanceof Event` 校验会失败，抛
   `Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'`，
   整棵 React 树在 `commitHookPassiveMountEffects` 里炸掉。测试的 DOM 就是
   happy-dom，事件类必须同 realm——`test/setup.ts` 已显式把全局
   `Event` / `CustomEvent` 覆盖到 happy-dom 的实现，不用再在测试里处理。

10. **mermaid 的组件测试必须在 `beforeAll` 里 `mermaid.initialize`**：弹窗类组件
    （`MermaidPreviewModal`）自己不初始化 mermaid，生产环境里它只在
    `MarkdownRenderer` 挂载后才可能被打开。测试不复现这个前置条件时，happy-dom
    下未初始化的首帧 `mermaid.render` 会**静默返回空 svg**（不报错），断言
    「渲染出 `<svg>`」的用例会一直卡到 `waitFor` 超时。用与
    `MarkdownRenderer` 相同的参数初始化即可。

## 测试先行（TDD）

改 `apps/browse` 的组件行为时，顺序是：

1. **先写 / 改组件测试**（描述期望的新行为或回归点），跑一遍确认**红**；
2. 再改实现，跑到**绿**；
3. `bun run typecheck` + `bun run browse:build` 确认构建没破。

纯逻辑优先在 `packages/trajectory` 的模型层单测里覆盖（无 DOM、更快）；
只有渲染/交互/布局相关的行为才进组件测试。组件测试不是越多越好——
覆盖「会回归的视觉与交互契约」（sticky 表头位置、span 合并、折叠、选中态）。
