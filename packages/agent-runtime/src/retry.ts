/**
 * 重试：**判定与退避全部用 pi 的实现**，这里只保留业务侧的配置形状与桥接。
 *
 * 历史（已删除）：本文件曾自维护 `isRetryableMessage`（pi 分类器 + 旧 `retryableStatusCodes` 白名单）
 * 与 `computeBackoff`（自算指数退避）；现在两者都直接转出 pi-ai：
 *   · 可重试判定 → `isRetryableAssistantError`（`pi-ai/utils/retry.ts` 的权威分类器）
 *   · 退避计算   → `retryDelayMs`（`baseDelayMs * 2^(attempt-1)`，受 `maxAgentDelayMs` 封顶）
 *   · 单次调用重试循环 → `retryAssistantCall`（本仓库目前由 harness 的 retry policy 承担，
 *     不再自己写循环；导出以便业务侧需要时直接用 pi 的）
 *
 * `RetryConfig` 仍是**业务可见契约**（`~/.zread-pi/config.yaml` 的 `concurrency.max_retries`
 * 经 Orchestrator 下发），`toRetryPolicy()` 负责把它翻译成 pi 的 `RetryPolicy`。
 */

import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type RetryPolicy } from "@earendil-works/pi-ai";

export {
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	isRetryableAssistantError,
	retryAssistantCall,
	retryDelayMs,
} from "@earendil-works/pi-ai";

/** 重试配置（与旧 @zread-pi/agent-runtime 完全一致，业务层事件依赖它） */
export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	/** 单次退避上限；等于 `baseDelayMs` 时退化为固定延迟 */
	maxDelayMs: number;
	/**
	 * @deprecated 已不参与判定：可重试性由 pi-ai 的 `isRetryableAssistantError` 按错误文本/状态判定。
	 * 字段保留只为兼容旧配置形状（`config.concurrency` 只暴露次数，不暴露状态码白名单）。
	 */
	retryableStatusCodes: number[];
	/** 重试前回调（用于通知 UI） */
	onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; error: string }) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30_000,
	retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504, 529],
};

/**
 * 业务 `RetryConfig` → harness 的 `RetryPolicy`（pi-ai）。
 *
 * `maxRetries <= 0` 表示不重试，返回 `undefined`（harness 用默认策略；调用方不启用时
 * 适配层不再下发 retry，等价于一次尝试）。
 */
export function toRetryPolicy(retryConfig: RetryConfig | undefined): RetryPolicy | undefined {
	if (!retryConfig || retryConfig.maxRetries <= 0) return undefined;
	return {
		enabled: true,
		maxRetries: retryConfig.maxRetries,
		baseDelayMs: retryConfig.baseDelayMs,
		// 旧配置里 maxDelayMs 就是硬上限（create-agent 传 10000 = 固定延迟）
		maxAgentDelayMs: retryConfig.maxDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	};
}
