/**
 * ProgressBar - 进度条（纯文本 + ANSI）
 *
 * 用于「外部工具安装进度」等需要展示百分比的场景。
 * 宽度严格受控：只输出 `width` 个显示宽度为 1 的字符（█ / ░ / 空格），
 * 因此不会破坏页面宽度约束（render-all-routes 会断言没有超宽行）。
 */

import { style } from "../ansi";
import { theme } from "../../theme";

export interface ProgressBarOptions {
  /** 已完成比例（0-1，超出范围会被 clamp） */
  ratio: number;
  /** 进度条字符宽度（不含后续文本） */
  width: number;
  /** 已完成部分的颜色（默认主题主色） */
  color?: string;
}

/** 渲染进度条本体（不含百分比文本）。例如 `[██████░░░░░░]`。 */
export function renderProgressBar(options: ProgressBarOptions): string {
  const width = Math.max(4, options.width);
  const inner = width - 2; // 左右方括号
  const ratio = Number.isFinite(options.ratio) ? Math.min(1, Math.max(0, options.ratio)) : 0;
  const filled = Math.round(inner * ratio);
  const bar =
    style("█".repeat(filled), { color: options.color ?? theme.primary }) +
    style("░".repeat(Math.max(0, inner - filled)), { dim: true });
  return `[${bar}]`;
}

/**
 * 渲染一行进度：`[████░░░░] 40%  下载中 3.2MB/7.9MB`。
 * 超过 width 的部分会被截断（由调用方保证 width 足够）。
 */
export function renderProgressLine(
  width: number,
  ratio: number,
  percentText: string,
  detail?: string,
  color?: string,
): string {
  const suffix = `${percentText}${detail ? `  ${detail}` : ""}`;
  const barWidth = Math.max(8, Math.min(28, width - suffix.length - 2));
  const bar = renderProgressBar({ ratio, width: barWidth, color });
  return `${bar} ${suffix}`.slice(0, Math.max(1, width));
}

/** 人类可读的字节数（与 pi 的 formatSize 文案保持一致：KB/MB）。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
