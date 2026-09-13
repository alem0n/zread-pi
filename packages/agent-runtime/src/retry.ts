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
 * 重试分两层（与 pi coding-agent 的 `RetrySettings` / `ProviderRetrySettings` 同构）：
 *   · **Agent 层**（`RetryConfig.maxRetries`，harness 的 `RetryPolicy`）：
 *     一次失败的助手响应 → 指数退避后重跑本轮（失败尝试不会写进会话）；
 *     `maxRetries = 0` 会下发**显式禁用**的策略（不是 undefined —— 否则 harness 会用自己的
 *     默认值 3 重试）。
 *   · **Provider 层**（`RetryConfig.provider`，harness 的 `streamOptions`）：
 *     pi-ai 的 `retryProviderRequest` 在 SDK 请求内部重试，**会读取服务端
 *     `Retry-After` / `retry-after-ms`** 并按 `maxRetryDelayMs` 封顶
 *     （超过上限直接失败，错误文本带 "retry delay" 并交给 Agent 层继续退避）。
 *     429 高峰期因此不会再「重试过早」。
 *
 * `RetryConfig` 仍是**业务可见契约**（`~/.zread-pi/config.yaml` 的 `concurrency.max_retries`
 * 经 Orchestrator 下发），`toRetryPolicy()` / `toStreamOptions()` 负责把它翻译成 pi 的配置。
 */

import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type RetryPolicy } from "@earendil-works/pi-ai";

export {
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	isRetryableAssistantError,
	retryAssistantCall,
	retryDelayMs,
} from "@earendil-works/pi-ai";

/**
 * Provider 层重试设置（与 pi coding-agent 的 `ProviderRetrySettings` 同形）。
 *
 * 对应 pi-ai `StreamOptions` 的 `maxRetries` / `maxRetryDelayMs` / `timeoutMs`：
 * SDK 请求失败后由 pi 自己重试，且**尊重服务端 `Retry-After`**。
 */
export interface ProviderRetryConfig {
	/** provider 层重试次数（0/缺省 = 不重试；pi-ai 默认即 0） */
	maxRetries?: number;
	/** 服务端要求的等待上限（缺省 60000；0 = 不设上限）。超过上限立即失败并交由 Agent 层处理 */
	maxRetryDelayMs?: number;
	/** 单次请求超时（毫秒；缺省由 pi-ai 决定） */
	timeoutMs?: number;
}

/** 重试配置（与旧 @zread-pi/agent-sdk 完全一致，业务层事件依赖它） */
export interface RetryConfig {
	/** Agent 层重试次数（harness 的 `maxRetries`） */
	maxRetries: number;
	/** 单次退避基数：第 n 次重试等待 `baseDelayMs * 2^(n-1)` */
	baseDelayMs: number;
	/** 单次退避上限（harness 的 `maxAgentDelayMs`）；等于 `baseDelayMs` 时退化为固定延迟 */
	maxDelayMs: number;
	/**
	 * @deprecated 已不参与判定：可重试性由 pi-ai 的 `isRetryableAssistantError` 按错误文本/状态判定。
	 * 字段保留只为兼容旧配置形状（`config.concurrency` 只暴露次数，不暴露状态码白名单）。
	 */
	retryableStatusCodes: number[];
	/** Provider 层重试（pi-ai `retryProviderRequest`：读 Retry-After、按上限封顶） */
	provider?: ProviderRetryConfig;
	/** 重试前回调（用于通知 UI；目前由 harness 的 Agent 层重试事件触发） */
	onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; error: string }) => void;
}

/** Provider 层服务端等待上限的默认值（与 pi coding-agent 一致：60 秒） */
export const DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS = 60_000;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelayMs: 2000,
	maxDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504, 529],
	provider: {
		maxRetries: 3,
		maxRetryDelayMs: DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
	},
};

/**
 * 业务 `RetryConfig` → harness 的 `RetryPolicy`（pi-ai）。
 *
 * `maxRetries <= 0` 时返回**显式禁用**的策略（enabled=false / maxRetries=0），
 * 而不是 `undefined`：harness 对 `undefined` 会落回它自己的默认策略（maxRetries=3），
 * 那样 `concurrency.max_retries: 0`（默认值）这个「不重试」配置就会被静默放大成 3 次重试。
 */
export function toRetryPolicy(retryConfig: RetryConfig | undefined): RetryPolicy {
	const maxRetries = retryConfig?.maxRetries ?? 0;
	if (maxRetries <= 0) {
		return { enabled: false, maxRetries: 0, baseDelayMs: 0 };
	}
	return {
		enabled: true,
		maxRetries,
		baseDelayMs: retryConfig?.baseDelayMs ?? 2000,
		// 旧配置里 maxDelayMs 就是硬上限（create-agent 曾传 10000 = 固定延迟）
		maxAgentDelayMs: retryConfig?.maxDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	};
}

/** harness `streamOptions` 里与重试相关的子集（透传给 pi-ai 的 `SimpleStreamOptions`） */
export interface HarnessStreamRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	timeoutMs?: number;
}

/**
 * 业务 `RetryConfig` → harness 的 `streamOptions`（provider 层重试）。
 *
 * 只有显式配置了 provider 重试（`maxRetries > 0`）才下发，避免无意中改变
 * 「一次请求 = 一次尝试」的旧语义；`maxRetryDelayMs` 缺省时补 60 秒上限。
 */
export function toStreamOptions(retryConfig: RetryConfig | undefined): HarnessStreamRetryOptions | undefined {
	const provider = retryConfig?.provider;
	if (!provider || (provider.maxRetries ?? 0) <= 0) return undefined;
	return {
		maxRetries: provider.maxRetries,
		maxRetryDelayMs: provider.maxRetryDelayMs ?? DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
		...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
	};
}
