/**
 * RoundedBox - 圆角边框容器（对齐 Ink 的 <Box borderStyle="round" paddingX={1}>）
 *
 * 因为父容器是纵向 flex 且默认 align-items: stretch，
 * Ink 里这个盒子会撑满可用宽度，这里保持一致：始终渲染到 width。
 */

import type { Component } from "@earendil-works/pi-tui";
import { style } from "../ansi";
import { padRight } from "../text-layout";

const BORDER_COLOR = "gray";

export class RoundedBox implements Component {
  private children: Component[] = [];
  private paddingX: number;

  constructor(paddingX = 1) {
    this.paddingX = paddingX;
  }

  addChild(component: Component): void {
    this.children.push(component);
  }

  clear(): void {
    this.children = [];
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  render(width: number): string[] {
    const total = Math.max(2, width);
    const border = (text: string): string => style(text, { color: BORDER_COLOR });
    const innerWidth = Math.max(0, total - 2);
    const contentWidth = Math.max(1, innerWidth - this.paddingX * 2);
    const pad = " ".repeat(this.paddingX);

    const lines: string[] = [];
    lines.push(border("╭" + "─".repeat(innerWidth) + "╮"));

    for (const child of this.children) {
      for (const line of child.render(contentWidth)) {
        const body = pad + padRight(line, contentWidth) + pad;
        lines.push(border("│") + body + border("│"));
      }
    }

    lines.push(border("╰" + "─".repeat(innerWidth) + "╯"));
    return lines;
  }
}
