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

/**
 * 版本展示文案（探测不到版本号时给出信息，而不是当成“没装”）。
 *
 * 设计前提：版本探测只是「尽力而为」——不同工具的版本 flag、输出位置（stdout/stderr）、
 * 退出码、版本格式都可能不同，未来工具甚至可能没有版本开关。
 * 因此这里的原则是：**可用性由「能不能执行」决定，版本号缺失只影响展示**。
 */
export function toolVersionLabel(t: TranslateFn, status: ToolStatus): string {
  if (status.version) {
    return status.versionMismatch
      ? `${status.version} · ${t("tools.versionMismatch", {
          expected: status.versionMismatch.expected,
          actual: status.versionMismatch.actual,
        })}`
      : status.version
  }
  // 探测不到版本号：如果台账里记了「当初装的版本」，用它兜底展示
  if (status.installedVersion) {
    return `${status.installedVersion} · ${t("tools.versionUnknown")}`
  }
  if (status.state === "missing" || status.state === "disabled") return t("tools.notInstalled")
  return t("tools.versionUnknown")
}

/** 状态提示（详情页用）：告诉用户当前状态下的可用动作 */
export function toolStateHint(t: TranslateFn, status: ToolStatus): string {
  if (status.state === "disabled") return t("tools.disabledHint");
  if (status.state === "managed") return t("tools.managedHint");
  if (status.state === "system") return t("tools.systemHint");
  if (!status.installable) return t("tools.notInstallable");
  return t("tools.missingHint");
}
