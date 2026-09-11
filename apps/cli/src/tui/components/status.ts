/**
 * Status 展示组件（对齐 Ink 版本 StatusIcon / StatusRow）
 */

import { style } from "../ansi";
import { renderTwoColumn } from "../text-layout";
import { theme } from "../../theme";

export type Status = "waiting" | "loading" | "completed" | "failed";

/** ink-spinner 的 dots 动画帧（loading 图标轮换用） */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** spinner 动画帧间隔（毫秒） */
export const SPINNER_INTERVAL_MS = 80;

/**
 * 状态图标
 * - loading: 按 frame 轮换的加载动画（页面需定时刷新驱动）
 * - completed: ✓ 绿色
 * - failed: ✗ 红色
 * - waiting: ○ 灰色
 */
export function statusIcon(
  status: Status,
  variant: "default" | "active" = "default",
  frame = 0,
): string {
  const isActive = variant === "active";

  if (status === "loading") {
    const icon = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    return style(icon, { color: isActive ? theme.primary : theme.warning });
  }
  if (status === "completed") {
    return style("✓", { color: theme.success });
  }
  if (status === "failed") {
    return style("✗", { color: theme.error });
  }
  return style("○", { color: isActive ? theme.primary : theme.muted });
}

/** 两栏布局：左栏标题，右栏状态贴右 */
export function statusRow(width: number, left: string, right: string): string {
  return renderTwoColumn(width, left, right);
}
