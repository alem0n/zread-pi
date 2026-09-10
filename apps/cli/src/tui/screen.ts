/**
 * Screen - 页面基类
 *
 * 迁移前的每个 Ink 页面组件（含 useInput / useImmer 逻辑）在这里被改写成一个类：
 * - render(width)      → 返回该页面占用的行
 * - handleKey(data)    → 页面级按键处理（返回值只对 ESC 有意义，true = 已消费）
 * - onEnter/onDestroy  → 挂载 / 卸载副作用
 *
 * 所有页面都运行在 Layout 预留的内容区里（宽度 = 终端宽度 - 4）。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { App } from "./app";
import type { InterpolationParams } from "../i18n/types";

export abstract class Screen implements Component {
  protected app!: App;

  bind(app: App): void {
    this.app = app;
    this.init();
  }

  /** 构造阶段拿不到 app 时，把依赖 app 的初始化写在这里 */
  protected init(): void {
    // 默认无副作用
  }

  /** 页面进入时调用（可执行异步初始化） */
  onEnter(): void | Promise<void> {
    // 默认无副作用
  }

  /** 页面离开时调用（清理定时器等） */
  onDestroy(): void {
    // 默认无副作用
  }

  abstract render(width: number): string[];

  /**
   * 页面级按键处理。
   * @returns 仅当返回 true 时表示「已消费 ESC」，全局 ESC 逻辑不再执行。
   */
  handleKey(_data: string): boolean {
    return false;
  }

  invalidate(): void {
    // 默认无缓存状态
  }

  /** 请求重绘 */
  protected refresh(): void {
    this.app.requestRender();
  }

  /** 翻译快捷方法 */
  protected t(key: string, params?: InterpolationParams): string {
    return this.app.t(key, params);
  }
}
