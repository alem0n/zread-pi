/**
 * Divider - 分割线组件（pi-tui 版）
 *
 * 支持两种格式（与 Ink 版本逐字符一致）：
 * 1. 简单分割线：────────────────────────────────────
 * 2. 带标题分割线：── 目录 ───────────────────────────
 *
 * 动态适配终端宽度，确保单行不换行。
 */

import type { Component } from "@earendil-works/pi-tui";
import { getDisplayWidth, truncateByDisplayWidth } from "../../utils/display";
import { dim, style } from "../ansi";
import { clampLine } from "../text-layout";

export class Divider implements Component {
  private title?: string;
  private color?: string;

  constructor(title?: string, color?: string) {
    this.title = title;
    this.color = color;
  }

  setTitle(title?: string): void {
    this.title = title;
  }

  setColor(color?: string): void {
    this.color = color;
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    const line = this.buildLine(Math.max(1, width));
    const decorated = this.color ? style(line, { color: this.color }) : dim(line);
    // 对齐 Ink 的 marginTop={1}：分割线上方空一行
    return ["", clampLine(decorated, Math.max(1, width))];
  }

  private buildLine(width: number): string {
    if (this.title) {
      // 带标题格式：── 标题 ───────────────────────
      const prefix = "── ";
      const middle = " ─";
      const usedWidth =
        getDisplayWidth(prefix) + getDisplayWidth(this.title) + getDisplayWidth(middle);
      const fillWidth = Math.max(0, width - usedWidth);
      const line = prefix + this.title + middle + "─".repeat(fillWidth);
      return truncateByDisplayWidth(line, width);
    }

    return "─".repeat(width);
  }
}
