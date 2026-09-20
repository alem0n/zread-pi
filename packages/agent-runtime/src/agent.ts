/**
 * createAgent —— zread-pi 业务层唯一依赖的 Agent 入口。
 *
 * 对外契约与旧 agent-sdk 完全一致（业务层 22 处 import 零改动）：
 *   const agent = createAgent({ model, apiKey, baseURL, tools, systemPrompt, hooks, retryConfig })
 *   for await (const event of agent.query(prompt)) { ... }
 *   await agent.close()
 *
 * 内部实现全部交给 pi 的 **AgentHarness**（不再是裸 agent loop）：
 *   - 会话 / 泳道 / 操作状态机 / 恢复：`AgentHarness` + `MemorySessionRepo`（每 query 一个内存会话，
 *     与迁移前「每次运行新建 Agent」的语义一致）
 *   - 请求、凭据、错误分类、重试编排：harness 的 retry policy（`drive/response.ts`）
 *   - 上下文压缩：harness 内建 threshold / overflow 压缩（`compaction` 设置）
 *   - 首尾机制：token 预算（usage 事件/ledger）替代轮数硬顶，
 *     `before_run` 注入两段式提示，`before_run_end` 决定终止或强制交卷
 *     —— 详见 `harness/budget.ts` 与 MIGRATION.md §12
 */

import type { Api, Model, Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { createRuntimeModel, inferProviderId, type RuntimeModel } from "./pi/runtime-model.js";
import { hasZreadProvider } from "./pi/provider-catalog.js";
import type { RetryConfig } from "./retry.js";
import { toRetryPolicy, toStreamOptions } from "./retry.js";
import type { ThinkingLevel } from "@zread-pi/types";
import type { SDKMessage, PermissionMode, ToolDefinition } from "./types.js";
import type { ApiType } from "./providers/types.js";
import {
	BudgetController,
	DEFAULT_HARD_BUDGET_NOTICE,
	DEFAULT_SOFT_BUDGET_NOTICE,
	type BudgetOptions,
} from "./harness/budget.js";import { queryHarness, type HarnessQueryRequest } from "./harness/driver.js";
import { bridgeModels, type HarnessStreamFn } from "./harness/models.js";
import type { HookConfig } from "./hooks.js";

export type { HookConfig } from "./hooks.js";
export { runToolHooks } from "./hooks.js";
export {
	BudgetController,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_HARD_BUDGET_NOTICE,
	DEFAULT_SOFT_BUDGET_NOTICE,
	usageTokens,
} from "./harness/budget.js";
export type { BudgetNotices, BudgetOptions, BudgetSnapshot } from "./harness/budget.js";

// ---------------------------------------------------------------------------
// 上下文压缩（harness 内建 compaction）
// ---------------------------------------------------------------------------

/**
 * 自动上下文压缩配置（与 harness 的 `CompactionSettings` 同形）。
 *
 * 运行时在每个 run 边界检查上下文用量，超过 `contextWindow - reserveTokens` 时
 * 生成结构化摘要并用「摘要 + 保留的近期消息」继续请求；
 * 泄漏到 provider 的溢出会被 harness 识别为 overflow 并做一次恢复压缩。
 */
export interface CompactionOptions {
	/** 是否启用自动压缩（缺省 true） */
	enabled?: boolean;
	/** 为摘要请求与下一次响应预留的 tokens（缺省 pi 默认值 16384） */
	reserveTokens?: number;
	/** 压缩后保留的近期上下文 tokens（缺省 pi 默认值 20000） */
	keepRecentTokens?: number;
}

// ---------------------------------------------------------------------------
// 首尾机制：token 预算 + 两段式提示（见 harness/budget.ts）
// ---------------------------------------------------------------------------

/** 兼容旧字段：`finalization.notice` 的缺省硬提示文案 */
export const DEFAULT_FINALIZATION_NOTICE = DEFAULT_HARD_BUDGET_NOTICE;

/** 兼容旧字段：收尾策略（已折叠进 token 预算） */
export interface FinalizationOptions {
	/**
	 * @deprecated 由 `budget.forcedTurns` 承担：预算耗尽后允许的强制交卷轮数
	 * （缺省 1；0 = 预算耗尽即终止，等同于旧「到达上限立即停止」）。
	 */
	graceTurns?: number;
	/**
	 * @deprecated 由 `budget.notices.hard` 承担：预算耗尽的硬提示文案。
	 * 缺省 `DEFAULT_HARD_BUDGET_NOTICE`；传空字符串关闭提示。
	 */
	notice?: string;
}

/** 每「轮」折算的 token 预算（兼容 `maxTurns` 配置时使用） */
export const TOKENS_PER_TURN = 25_000;

/** 缺省折算轮数（与迁移前适配层兜底值一致：`maxTurns ?? 30`） */
export const DEFAULT_MAX_TURNS_EQUIVALENT = 30;

/**
 * 把旧字段归一化成 token 预算。
 *
 * `maxTurns` 不再表示「轮数硬顶」，而是折算成 `maxTurns * TOKENS_PER_TURN` 的
 * 累计 token 预算（0 = 不限制）；显式 `budget.maxTokens` 优先。
 */
export function resolveBudgetOptions(options: Pick<AgentOptions, "budget" | "maxTurns" | "finalization">): BudgetOptions {
	const explicit = options.budget?.maxTokens;
	const maxTurns = options.maxTurns;
	const effectiveTurns = maxTurns === undefined ? DEFAULT_MAX_TURNS_EQUIVALENT : maxTurns;
	const derived =
		explicit !== undefined ? explicit : effectiveTurns > 0 ? effectiveTurns * TOKENS_PER_TURN : 0;
	const hardNotice = options.budget?.notices?.hard ?? options.finalization?.notice ?? DEFAULT_HARD_BUDGET_NOTICE;
	return {
		...options.budget,
		maxTokens: derived,
		notices: {
			soft: options.budget?.notices?.soft ?? DEFAULT_SOFT_BUDGET_NOTICE,
			hard: hardNotice,
		},
		...(options.budget?.forcedTurns === undefined && options.finalization?.graceTurns !== undefined
			? { forcedTurns: options.finalization.graceTurns }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// 选项（旧 AgentOptions 的子集 + 少量新增旋钮）
// ---------------------------------------------------------------------------

export interface AgentOptions {
	/** 模型 id */
	model?: string;
	/** providerId（anthropic / openai / deepseek / 任意 OpenAI 兼容网关） */
	providerId?: string;
	/** @deprecated 兼容旧字段；等价于显式指定 apiType */
	apiType?: ApiType;
	apiKey?: string;
	baseURL?: string;
	cwd?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	tools?: ToolDefinition[] | string[];
	/** @deprecated 由 `budget.maxTokens` 承担（缺省折算为 `maxTurns * TOKENS_PER_TURN`）；0 = 不限制 */
	maxTurns?: number;
	maxTokens?: number;
	canUseTool?: (tool: ToolDefinition, input: unknown) => Promise<{ behavior: "allow" | "deny"; message?: string }>;
	permissionMode?: PermissionMode;
	abortController?: AbortController;
	abortSignal?: AbortSignal;
	includePartialMessages?: boolean;
	hooks?: HookConfig;
	retryConfig?: RetryConfig;
	/**
	 * @deprecated harness 的重试发生在「本次响应尚未落地」的窗口内（等价旧 `"stream"`，
	 * 失败尝试不会写进会话）；`"stream+run"`（整轮重跑）已移除。
	 */
	retryScope?: "stream" | "stream+run";
	/** 模型上下文窗口（用于 harness 的上下文记账，缺省 200k） */
	contextWindow?: number;
	/** pi 的思考深度（thinking level），缺省 "off" */
	thinkingLevel?: ThinkingLevel;
	/**
	 * pi 会话 id：显式指定后，本次 query 的会话以此为 id（`system/init` 事件原样回带）。
	 * 缺省由适配层生成全局唯一值。编排层传入它作为轨迹回放的 session 归属键。
	 */
	sessionId?: string;
	/**
	 * pi 会话落盘根目录（`<runDir>/sessions/`）：给定后本次 query 的完整会话
	 * （消息 / 工具调用 / 用量 / 压缩摘要）由 pi 的 `JsonlSessionRepo` 写进
	 * `<sessionRoot>/--<cwd>--/<ts>_<sessionId>.jsonl`，成为唯一完整事实源。
	 * 缺省 = 内存会话（用完即弃，与迁移前一致）。编排层按 run 注入。
	 */
	sessionRoot?: string;
	/** 自动上下文压缩（harness 内建 compaction），缺省启用 */
	compaction?: CompactionOptions;
	/**
	 * token 预算 + 两段式提示 + 强制交卷（harness 首尾机制的配置面）。
	 * 缺省：不限制 token（但仍受上下文窗口约束）。
	 */
	budget?: BudgetOptions;
	/** @deprecated 已折叠进 `budget`（见 `resolveBudgetOptions`） */
	finalization?: FinalizationOptions;
	/**
	 * 高级/测试用途：直接注入 pi 的 Model 与 streamFn（例如 pi-ai 的 faux provider），
	 * 跳过 provider / baseURL / apiKey 的解析。业务代码不设置该选项。
	 */
	runtimeOverride?: {
		model: Model<Api>;
		streamFn: HarnessStreamFn;
		models?: Models;
	};
}

/** 与旧 Agent 对象一致的最小接口 */
export interface AgentInstance {
	query(prompt: string, overrides?: Partial<AgentOptions>): AsyncGenerator<SDKMessage, void>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

interface ResolvedRuntime {
	model: Model<Api>;
	models: Models;
	apiType: ApiType;
	providerId: string;
}

/**
 * 测试注入路径的最小 Models 回退：只需要 harness 真正会用到的两个入口
 * （`getModel` 解析模型、`streamSimple` 发请求）；其余方法不存在于测试语义中。
 * 生产路径永远走 catalog 的 `MutableModels`。
 */
function minimalModels(model: Model<Api>, streamSimple: HarnessStreamFn): Models {
	const provider = {
		id: model.provider,
		name: model.provider,
		baseUrl: model.baseUrl,
		getModels: () => [model],
	} as unknown as Provider;	return {
		getProviders: () => [provider],
		getProvider: (id: string) => (id === model.provider ? provider : undefined),
		getModels: () => [model],
		getModel: (providerId: string, id: string) => (providerId === model.provider && id === model.id ? model : undefined),
		getAuth: async () => undefined,
		getAvailable: async () => [model],
		checkAuth: async () => undefined,
		refresh: async () => ({ refreshed: [], failed: [] }) as never,
		login: async () => {
			throw new Error("runtimeOverride models do not support login");
		},
		logout: async () => undefined,
		stream: (m: Model<Api>, context: Parameters<HarnessStreamFn>[1], options?: Parameters<HarnessStreamFn>[2]) =>
			streamSimple(m, context, options),
		complete: async (m: Model<Api>, context: Parameters<HarnessStreamFn>[1], options?: Parameters<HarnessStreamFn>[2]) =>
			streamSimple(m, context, options).result(),
		streamSimple,
		completeSimple: async (
			m: Model<Api>,
			context: Parameters<HarnessStreamFn>[1],
			options?: Parameters<HarnessStreamFn>[2],
		) => streamSimple(m, context, options).result(),
		streamDeferred: () => {
			throw new Error("runtimeOverride models do not support deferred responses");
		},
		fetchDeferred: async () => {
			throw new Error("runtimeOverride models do not support deferred responses");
		},
		cancelDeferred: async () => undefined,
	} as unknown as Models;
}

/** 解析运行时（catalog 优先；测试可注入 runtimeOverride） */
function resolveRuntime(options: AgentOptions, modelId: string | undefined): ResolvedRuntime {
	const override = options.runtimeOverride;
	if (override) {
		return {
			model: override.model,
			models: bridgeModels(
				override.models ?? minimalModels(override.model, override.streamFn),
				{ resolved: override.model, streamSimple: override.streamFn },
			),
			apiType: override.model.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
			providerId: String(override.model.provider),
		};
	}

	const runtime: RuntimeModel = createRuntimeModel({
		providerId: options.providerId,
		modelId: modelId as string,
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		apiType: options.apiType,
		contextWindow: options.contextWindow,
		maxTokens: options.maxTokens,
	});
	return {
		model: runtime.model,
		models: bridgeModels(runtime.models, { resolved: runtime.model }),
		apiType: runtime.apiType,
		providerId: runtime.providerId,
	};
}

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

class AgentRuntimeImpl implements AgentInstance {
	private readonly abortController = new AbortController();
	private closed = false;

	constructor(private readonly options: AgentOptions) {
		const external = options.abortController ?? options.abortSignal;
		if (options.abortController) {
			options.abortController.signal.addEventListener("abort", () => this.abortController.abort(), { once: true });
		} else if (options.abortSignal) {
			options.abortSignal.addEventListener("abort", () => this.abortController.abort(), { once: true });
		}
		void external;
	}

	async *query(prompt: string, overrides?: Partial<AgentOptions>): AsyncGenerator<SDKMessage, void> {
		if (this.closed) throw new Error("Agent is closed");
		const options: AgentOptions = { ...this.options, ...overrides };
		const modelId = options.model;
		const override = options.runtimeOverride;
		if (!modelId && !override) throw new Error("Agent option `model` is required");
		if (!options.apiKey && !override) {
			// 新版配置的凭据在 ~/.zread-pi/auth.json（pi CredentialStore），
			// 只要 providerId 命中 catalog 就无需显式 apiKey。
			const providerId =
				options.providerId ??
				(modelId
					? inferProviderId({ modelId, baseURL: options.baseURL, apiType: options.apiType })
					: undefined);
			if (!providerId || !hasZreadProvider(providerId)) {
				throw new Error("LLM configuration incomplete: apiKey is required");
			}
		}

		const runtime = resolveRuntime(options, modelId);
		const budgetOptions = resolveBudgetOptions(options);
		const budget = new BudgetController(budgetOptions);
		const toolDefinitions = (options.tools ?? []).filter(
			(candidate): candidate is ToolDefinition => typeof candidate === "object",
		);
		const retryConfig = options.retryConfig;
		const retryPolicy = toRetryPolicy(retryConfig);
		const streamRetryOptions = toStreamOptions(retryConfig);

		const request: HarnessQueryRequest = {
			prompt,
			// pi 会话 id：显式传入 > 生成一个全局唯一值（编排层会传入，
			// 作为轨迹回放的 session 归属键）。单纯 `Date.now()` 在并发 Agent
			// 同时启动时会撞车，故补随机后缀。
			sessionId: options.sessionId ?? `zread-pi-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			cwd: options.cwd ?? process.cwd(),
			// 会话落盘根目录：编排层按 run 注入（`<runDir>/sessions/`）；
			// 缺省 = 内存会话。
			...(options.sessionRoot !== undefined ? { sessionRoot: options.sessionRoot } : {}),
			modelId: modelId ?? String(runtime.model.id),
			apiType: runtime.apiType,
			providerId: runtime.providerId,
			permissionMode: options.permissionMode ?? "bypassPermissions",
			includePartialMessages: options.includePartialMessages !== false,
			toolNames: toolDefinitions.map((tool) => tool.name),
			tools: toolDefinitions,
			models: runtime.models,
			model: runtime.model,
			systemPrompt: [options.systemPrompt, options.appendSystemPrompt].filter(Boolean).join("\n\n"),
			thinkingLevel: options.thinkingLevel ?? "off",
			retry: retryPolicy,
			...(streamRetryOptions ? { streamOptions: streamRetryOptions } : {}),
			compaction: {
				enabled: options.compaction?.enabled ?? true,
				reserveTokens: options.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
				keepRecentTokens: options.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
			},
			budget,
			hookConfig: options.hooks,
			canUseTool: options.canUseTool,
			signal: this.abortController.signal,
			onRetry: retryConfig?.onRetry
				? (info) =>
					retryConfig.onRetry?.({
						// harness 的 attempt 是「即将进行的第几次尝试」（1-based）；
						// 旧契约的 attempt 是「第几次重试」（1 = 首次重试）
						attempt: Math.max(1, info.attempt - 1),
						maxRetries: Math.max(0, info.maxRetries - 1),
						delayMs: info.delayMs,
						error: info.error,
					})
				: undefined,
		};

		yield* queryHarness(request);
	}

	close(): Promise<void> {
		this.closed = true;
		this.abortController.abort();
		return Promise.resolve();
	}

	abort(): void {
		this.abortController.abort();
	}
}

/** 与旧 SDK 同名同签名：同步返回 Agent 实例 */
export function createAgent(options: AgentOptions = {}): AgentInstance & { abort(): void } {
	return new AgentRuntimeImpl(options);
}

// 供诊断/测试复用的纯函数（token 口径与预算一致，见 harness/budget.ts 的重导出）
