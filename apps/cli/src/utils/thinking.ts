/**
 * thinking - 思考深度（pi thinking level）的展示辅助
 *
 * 等级值本身来自 pi（off / minimal / low / medium / high / xhigh / max），
 * 这里只负责把它渲染成「本地化名称 (原始等级)」，例如 "中 (medium)"。
 */

import type { ThinkingLevel } from "@zread-pi/types";
import { normalizeThinkingLevel } from "@zread-pi/utils";
import type { TranslateFn } from "../i18n/types";

/** 取思考深度的展示文本（非法/缺省值按 off 处理） */
export function thinkingLevelLabel(
  level: ThinkingLevel | string | null | undefined,
  t: TranslateFn,
): string {
  const normalized = normalizeThinkingLevel(level);
  const name = t(`thinking.levels.${normalized}`);
  return name ? `${name} (${normalized})` : normalized;
}
