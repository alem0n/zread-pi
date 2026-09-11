/**
 * 外部工具状态的展示辅助（列表页与详情页共用）
 *
 * 状态文案与配色集中在这里，避免两个页面各写一份而逐渐不一致。
 */

import type { ToolStatus } from "@zread-pi/utils";
import { theme } from "../../theme";

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 状态文案 key → 翻译 */
export function toolStateLabel(t: TranslateFn, status: ToolStatus): string {
  if (status.state === "disabled") return t("tools.stateDisabled");
  if (status.state === "managed") return t("tools.stateManaged");
  if (status.state === "system") return t("tools.stateSystem");
  return t("tools.stateMissing");
}

/** 状态配色：可用 = 成功色，停用 = 弱化色，缺失 = 警告色 */
export function toolStateColor(status: ToolStatus): string {
  if (status.state === "managed" || status.state === "system") return theme.success;
  if (status.state === "disabled") return theme.muted;
  return theme.warning;
}

/** 状态提示（详情页用）：告诉用户当前状态下的可用动作 */
export function toolStateHint(t: TranslateFn, status: ToolStatus): string {
  if (status.state === "disabled") return t("tools.disabledHint");
  if (status.state === "managed") return t("tools.managedHint");
  if (status.state === "system") return t("tools.systemHint");
  if (!status.installable) return t("tools.notInstallable");
  return t("tools.missingHint");
}
