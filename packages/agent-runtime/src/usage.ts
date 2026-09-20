/**
 * TokenUsage 归并（纯函数）——「每页累计」与「跨 Agent 合计」共用的唯一口径。
 *
 * 为什么不直接用 pi 的 `addUsage`：`@earendil-works/pi-agent-core` 的
 * `harness/utils/usage.ts` 里确实有等价的 `emptyUsage` / `addUsage`，但它作用于
 * pi 内部的 `Usage`（input/output/cacheRead/cacheWrite/totalTokens/cost），
 * 且未从包根导出（只有 compaction 用）。业务契约是字段名已冻结的 `TokenUsage`
 * （见 AGENTS.md §4），这里按同一加法语义实现，让「页面 Agent 的累计展示」与
 * 「CLI 的跨 Agent 合计」不再各写一遍。
 *
 * 口径说明（与 pi 的 usage ledger 一致）：
 * - `input_tokens` 只是「非缓存输入」——pi 把缓存读写单独记账
 *   （Anthropic 的 `input_tokens`、OpenAI 的 `prompt_tokens - cached_tokens` 都是如此）；
 * - 「输入侧总量」= input + cache_creation + cache_read，需要展示合计时由调用方相加；
 * - 缓存占比的分母是「输入侧总量」而不是 `input_tokens`。
 */

import type { TokenUsage } from "./types.js";

/** 全 0 的 TokenUsage（累加起点；缓存字段显式归零，便于求和与比较） */
export function emptyTokenUsage(): TokenUsage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

/** 逐字段相加（缓存字段缺失按 0 处理） */
export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
	return {
		input_tokens: left.input_tokens + right.input_tokens,
		output_tokens: left.output_tokens + right.output_tokens,
		cache_creation_input_tokens:
			(left.cache_creation_input_tokens ?? 0) + (right.cache_creation_input_tokens ?? 0),
		cache_read_input_tokens:
			(left.cache_read_input_tokens ?? 0) + (right.cache_read_input_tokens ?? 0),
	};
}

/** 归并一组用量（`undefined` = 尚未上报，跳过）；空集合返回全 0 */
export function sumTokenUsage(usages: Iterable<TokenUsage | undefined>): TokenUsage {
	let total = emptyTokenUsage();
	for (const usage of usages) {
		if (usage) total = addTokenUsage(total, usage);
	}
	return total;
}
