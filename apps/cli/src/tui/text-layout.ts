/**
 * 文本排版小工具
 *
 * pi-tui 的渲染器要求每一行的显示宽度不超过终端宽度，
 * 这里统一提供「按显示宽度补齐 / 截断 / 换行」的辅助函数。
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** 按终端显示宽度在右侧补齐空格 */
export function padRight(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/** 保证单行不超过 width（对齐 Ink 的截断行为：不追加省略号） */
export function clampLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return truncateToWidth(text, width, "");
}

/**
 * 把一段可能很长的文本按宽度换行（对齐 Ink <Text> 的自动换行）
 * @returns 每个元素都是已经带样式、且不超过 width 的一行
 */
export function wrapStyled(text: string, width: number): string[] {
  if (!text) return [];
  const maxWidth = Math.max(1, width);
  return wrapTextWithAnsi(text, maxWidth).map((line) => clampLine(line, maxWidth));
}

/**
 * 单行 row 渲染：左右两栏，右栏贴右对齐。
 * 等价于 Ink 的 <StatusRow>（中间用 flexGrow 填充）。
 */
export function renderTwoColumn(width: number, left: string, right: string): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const gap = Math.max(1, width - leftWidth - rightWidth);
  return clampLine(left + " ".repeat(gap) + right, width);
}
