/**
 * Status 展示组件（对齐 Ink 版本 StatusIcon / StatusRow）
 */

import { style } from "../ansi";
import { renderTwoColumn } from "../text-layout";
import { theme } from "../../theme";

export type Status = "waiting" | "loading" | "completed" | "failed";

/**
 * 状态图标
 * - loading: 静态加载符号（避免全屏模式下定时重绘）
 * - completed: ✓ 绿色
 * - failed: ✗ 红色
 * - waiting: ○ 灰色
 */
export function statusIcon(status: Status, variant: "default" | "active" = "default"): string {
  const isActive = variant === "active";

  if (status === "loading") {
    return style("⠴", { color: isActive ? theme.primary : theme.warning });
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
