/**
 * 重试策略：保留旧 agent-sdk 的 RetryConfig 契约（业务层事件依赖它），
 * 判定与退避实现复用 pi-ai 的 isRetryableAssistantError / retryDelayMs。
 */

import {
	isRetryableAssistantError,
	retryDelayMs,
	type AssistantMessage,
} from "@earendil-works/pi-ai";

/** 重试配置（与旧 @zread-pi/agent-runtime 完全一致） */
export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
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
 * 旧配置里 retryableStatusCodes 是 HTTP 状态码白名单；pi 的错误分类器基于错误文本。
 * 这里做一次桥接：文本命中 pi 的分类器、或文本中出现配置中的状态码，都算可重试。
 */
export function isRetryableMessage(message: AssistantMessage, policy: RetryConfig | undefined): boolean {
	if (message.stopReason !== "error") return false;
	if (!policy) return false;
	if (isRetryableAssistantError(message)) return true;

	const text = message.errorMessage ?? "";
	if (!text) return false;
	return policy.retryableStatusCodes.some((code) => text.includes(String(code)));
}

/** 按旧配置计算退避（baseDelayMs 固定或指数，取决于 maxDelayMs） */
export function computeBackoff(policy: RetryConfig, attempt: number): number {
	if (policy.maxDelayMs === policy.baseDelayMs) return policy.baseDelayMs;
	return retryDelayMs(
		{ baseDelayMs: policy.baseDelayMs, maxAgentDelayMs: policy.maxDelayMs },
		attempt,
	);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}
