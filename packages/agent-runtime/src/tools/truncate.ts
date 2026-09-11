/**
 * 工具输出截断设施（共享基线）
 *
 * 决策（见 AGENTS.md §1.1）：**不重新实现**，直接复用 vendor 里
 * `@earendil-works/pi-agent-core` 已导出的纯函数实现（`harness/utils/truncate.ts`）。
 * 该实现与上游 `pi/packages/coding-agent/src/core/tools/truncate.ts` 同源，
 * 额外做了「无 Buffer 运行时」的兜底（`utf8ByteLength`），比上游版本更健壮。
 *
 * 之所以保留这一层薄封装而不是在工具里直接 import vendor：
 *  1. 工具层只需要一个稳定的 import 站点，vendor 子路径变化时改一处；
 *  2. 截断提示文案（`[50.0KB limit reached]` 等）在这里统一拼装，避免各工具各写一份；
 *  3. 单测可以直接引用本模块验证截断语义（见 test/tools-smoke.ts）。
 *
 * 约定的两个独立上限，先到先触发：
 *  - 行数上限（DEFAULT_MAX_LINES = 2000）
 *  - 字节上限（DEFAULT_MAX_BYTES = 50KB）
 * 行截断永不返回半行（bash 尾部截断的边角情况除外）。
 */

export {
	truncateHead,
	truncateTail,
	truncateLine,
	formatSize,
	utf8ByteLength,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_BYTES,
	GREP_MAX_LINE_LENGTH,
} from "@earendil-works/pi-agent-core";
export type { TruncationResult, TruncationOptions } from "@earendil-works/pi-agent-core";

import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "@earendil-works/pi-agent-core";

/**
 * 把若干条提示追加到工具输出的末尾（与上游格式一致：空行 + 方括号包裹）。
 * 没有任何提示时原样返回，避免在输出尾部留空行。
 */
export function appendToolNotices(output: string, notices: string[]): string {
	const effective = notices.filter((notice) => notice.length > 0);
	if (effective.length === 0) return output;
	return `${output}\n\n[${effective.join(". ")}]`;
}

/** 字节上限提示（所有工具共用的文案）。 */
export function byteLimitNotice(): string {
	return `${formatSize(DEFAULT_MAX_BYTES)} limit reached`;
}

/**
 * 截断信息进入 `tool_result.details` 时只保留关键字段。
 *
 * `TruncationResult.content` 是截断后的文本本身，工具结果里已经有了一份，
 * 再放进 details 会让会话/内存里出现两份同样的长文本，所以这里刻意裁掉。
 */
export function toTruncationDetails(truncation: TruncationResult) {
	return {
		truncatedBy: truncation.truncatedBy,
		totalLines: truncation.totalLines,
		totalBytes: truncation.totalBytes,
		outputLines: truncation.outputLines,
		outputBytes: truncation.outputBytes,
		maxLines: truncation.maxLines,
		maxBytes: truncation.maxBytes,
		firstLineExceedsLimit: truncation.firstLineExceedsLimit,
	};
}
