/**
 * createAgent —— open_zread 业务层唯一依赖的 Agent 入口。
 *
 * 对外契约与旧 agent-sdk 完全一致：
 *   const agent = createAgent({ model, apiKey, baseURL, tools, systemPrompt, maxTurns, hooks, retryConfig })
 *   for await (const event of agent.query(prompt)) { ... }
 *   await agent.close()
 *
 * 内部实现全部交给 pi：
 *   - Agent 循环 / 事件 / 工具执行 / 取消：@earendil-works/pi-agent-core 的 Agent
 *   - 多提供商请求、API Key 注入、错误分类、退避计算：@earendil-works/pi-ai
 *   - 重试编排：本文件（pi 的 Agent 循环不内置重试，避免污染会话记录）
 *   - 上下文压缩：pi 的 `transformContext` + `prepareCompaction` / `compact`
 *     （超过 `model.contextWindow - reserveTokens` 时摘要历史，发出 `compact_boundary`）
 *   - 优雅停止：`shouldStopAfterTurn` 计数 `maxTurns`，并在上下文将满且压缩无法腾空时产出 `error_context_full`
 */

import {
	Agent as PiAgent,
	BACKGROUND_CONTEXT,
	compact,
	convertToLlm,
	createCompactionSummaryMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareCompaction,
	shouldCompact,
	withAbortSignal,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type CompactionSettings,
	type Entry,
	type ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model as PiModel,
	type MutableModels,
	type SimpleStreamOptions,
	type Usage,
	type Context as PiContext,
	type TSchema,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRuntimeModel, inferProviderId, type RuntimeModel } from "./pi/runtime-model.js";
import { hasZreadProvider } from "./pi/provider-catalog.js";
import { computeBackoff, isRetryableMessage, sleep, type RetryConfig } from "./retry.js";
import type { ThinkingLevel } from "@open-zread/types";
import type {
	ContentBlock,
	PermissionMode,
	SDKMessage,
	TokenUsage,
	ToolDefinition,
	ToolInputParams,
	ToolContext,
	ToolResult,
} from "./types.js";
import type { ApiType } from "./providers/types.js";

// ---------------------------------------------------------------------------
// 钩子契约（与旧 agent-sdk 的 hooks 配置形状一致）
// ---------------------------------------------------------------------------

type HookHandler = (
	input: Record<string, unknown>,
	toolUseId: string,
	context: { signal: AbortSignal },
) => Promise<unknown>;

interface HookMatcher {
	matcher?: string;
	hooks: HookHandler[];
	timeout?: number;
}

export type HookConfig = Record<string, HookMatcher[]>;

// ---------------------------------------------------------------------------
// 上下文压缩（pi compaction）
// ---------------------------------------------------------------------------

/**
 * 自动上下文压缩配置。
 *
 * 运行时在每次请求前（pi 的 `transformContext`）检查上下文用量，
 * 超过 `contextWindow - reserveTokens` 时调用 pi 的 `prepareCompaction` / `compact`
 * 生成结构化摘要，并用「摘要 + 保留的近期消息」继续请求；
 * 当压缩无法再腾出空间时，`shouldStopAfterTurn` 会在下一轮结束时优雅停止。
 */
export interface CompactionOptions {
	/** 是否启用自动压缩（缺省 true） */
	enabled?: boolean;
	/** 为摘要请求与下一次响应预留的 tokens（缺省 pi 默认值 16384） */
	reserveTokens?: number;
	/** 压缩后保留的近期上下文 tokens（缺省 pi 默认值 20000） */
	keepRecentTokens?: number;
}

/** 单次运行内的压缩状态（摘要 + 保留段 + 压缩时的消息位置） */
interface CompactionState {
	summary: string;
	tokensBefore: number;
	timestamp: number;
	/** 压缩后保留的近期消息（不含摘要消息） */
	tail: AgentMessage[];
	/** 压缩发生时 context.messages 的长度，用于拼接之后新增的消息 */
	fromIndex: number;
}

/** 把「摘要 + 保留段 + 新增消息」拼成当前请求的真实上下文 */
function buildEffectiveMessages(messages: AgentMessage[], state: CompactionState | undefined): AgentMessage[] {
	if (!state) return messages;
	const appended = messages.length > state.fromIndex ? messages.slice(state.fromIndex) : [];
	return [
		createCompactionSummaryMessage(state.summary, state.tokensBefore, state.timestamp),
		...state.tail,
		...appended,
	];
}

/**
 * 把消息列表转成 pi compaction 需要的 Entry[]。
 *
 * 已有压缩状态时，第一条合成一个 compaction 条目，让 pi 按「迭代压缩」语义
 * 复用 previousSummary 与 retainedTail，而不是把旧摘要再总结一遍。
 */
function toCompactionEntries(effective: AgentMessage[], state: CompactionState | undefined): Entry[] {
	const entries: Entry[] = [];
	if (state) {
		entries.push({
			type: "compaction",
			id: "open-zread-compaction",
			parentId: null,
			seq: 0,
			timestamp: state.timestamp,
			summary: state.summary,
			retainedTail: state.tail,
			tokensBefore: state.tokensBefore,
			fromHook: false,
		});
	}
	const offset = state ? state.tail.length + 1 : 0;
	for (let index = offset; index < effective.length; index++) {
		const message = effective[index];
		entries.push({
			type: "message",
			id: `open-zread-entry-${index}`,
			parentId: index === 0 ? null : `open-zread-entry-${index - 1}`,
			seq: index,
			timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
			message,
		});
	}
	return entries;
}

/** 逐条消息的字符启发式估算（用于比较压缩前后是否真的腾出空间） */
function sumEstimatedTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

// ---------------------------------------------------------------------------
// 选项（旧 AgentOptions 的子集 + 少量新增旋钮）
// ---------------------------------------------------------------------------

export interface AgentOptions {
	/** 模型 id */
	model?: string;
	/** providerId（anthropic / openai / deepseek / 任意 OpenAI 兼容网关） */
	providerId?: string;
	/** @deprecated 兼容旧字段；pi 版本里等价于显式指定 apiType */
	apiType?: ApiType;
	apiKey?: string;
	baseURL?: string;
	cwd?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	tools?: ToolDefinition[] | string[];
	/** 每次运行的最大轮次（缺省 30；业务默认来自 `config.agent.max_turns`） */
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
	 * 重试范围：
	 * - "stream"（默认）：仅在"本次 API 调用尚未产生任何内容"时重试，等价旧 SDK 的 API 级重试，不污染会话；
	 * - "stream+run"：允许在产生内容后整轮重跑该 prompt（更强健壮性，代价是重复消耗 Token）。
	 */
	retryScope?: "stream" | "stream+run";
	/** 模型上下文窗口（用于 pi 的上下文记账，缺省 200k） */
	contextWindow?: number;
	/**
	 * pi 的思考深度（thinking level）：off / minimal / low / medium / high / xhigh / max。
	 *
	 * 缺省 "off"（与迁移前行为一致，不发送 reasoning 参数）；
	 * 模型不支持所选等级时由 pi-ai 在请求时自动调整到最近的受支持等级。
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * 自动上下文压缩（pi compaction）。
	 *
	 * 缺省启用；上下文逼近模型窗口时在 `transformContext` 里生成摘要，
	 * 并在无法继续压缩时由 `shouldStopAfterTurn` 优雅停止。
	 */
	compaction?: CompactionOptions;
	/**
	 * 高级/测试用途：直接注入 pi 的 Model 与 streamFn（例如 pi-ai 的 faux provider），
	 * 跳过 provider / baseURL / apiKey 的解析。业务代码不设置该选项。
	 *
	 * `models` 仅用于上下文压缩时的摘要请求（`compact()` 需要 pi 的 Models 集合）；
	 * 不传时该次运行不进行自动压缩。
	 */
	runtimeOverride?: {
		model: PiModel<any>;
		streamFn: BaseStreamFn;
		models?: MutableModels;
	};
}

/** 与旧 Agent 对象一致的最小接口 */
export interface AgentInstance {
	query(prompt: string, overrides?: Partial<AgentOptions>): AsyncGenerator<SDKMessage, void>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 工具桥接：ToolDefinition（open_zread 契约）→ AgentTool（pi 契约）
// ---------------------------------------------------------------------------

interface ToolBridgeContext {
	cwd: string;
	model?: string;
	providerId?: string;
	apiType?: ApiType;
	hooks?: HookConfig;
	canUseTool?: AgentOptions["canUseTool"];
}

function toolResultToText(result: ToolResult): string {
	return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

async function runToolHooks(
	hooks: HookConfig | undefined,
	eventName: string,
	payload: Record<string, unknown>,
	toolUseId: string,
	signal: AbortSignal,
	toolName?: string,
): Promise<unknown[]> {
	const matchers = hooks?.[eventName];
	if (!matchers?.length) return [];

	const results: unknown[] = [];
	for (const matcher of matchers) {
		if (matcher.matcher && toolName) {
			try {
				if (!new RegExp(matcher.matcher).test(toolName)) continue;
			} catch {
				continue;
			}
		}
		for (const handler of matcher.hooks ?? []) {
			const executed = handler(payload, toolUseId, { signal });
			results.push(
				matcher.timeout
					? await Promise.race([
							executed,
							new Promise((resolve) => setTimeout(() => resolve(undefined), matcher.timeout)),
						])
					: await executed,
			);
		}
	}
	return results;
}

function toAgentTool(definition: ToolDefinition, context: ToolBridgeContext): AgentTool {
	return {
		name: definition.name,
		label: definition.name,
		description: definition.description,
		parameters: definition.inputSchema as unknown as TSchema,
		executionMode: definition.isConcurrencySafe?.() ? "parallel" : "sequential",
		async execute(toolCallId, params, signal, _onUpdate) {
			const toolContext: ToolContext = {
				cwd: context.cwd,
				abortSignal: signal,
				model: context.model,
				apiType: context.apiType,
			};
			const result = await definition.call(params as ToolInputParams, toolContext);
			const text = toolResultToText(result);
			if (result.is_error) {
				// pi 的工具以"抛异常"表达失败，错误文本仍会进入模型上下文
				throw new Error(text);
			}
			return { content: [{ type: "text", text }], details: { toolUseId: toolCallId } };
		},
	};
}

// ---------------------------------------------------------------------------
// 事件与用量映射：pi -> SDKMessage
// ---------------------------------------------------------------------------

function mapUsage(usage: Usage | undefined): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		input_tokens: usage.input,
		output_tokens: usage.output,
		cache_creation_input_tokens: usage.cacheWrite,
		cache_read_input_tokens: usage.cacheRead,
	};
}

function mapAssistantContent(message: AssistantMessage): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			blocks.push({ type: "thinking", thinking: block.thinking });
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: (block.arguments ?? {}) as ToolInputParams,
			});
		}
	}
	return blocks;
}

function mapPartial(event: AssistantMessageEvent): SDKMessage | undefined {
	switch (event.type) {
		case "text_delta":
			return { type: "partial_message", partial: { type: "text", text: event.delta } };
		case "toolcall_delta":
			return { type: "partial_message", partial: { type: "tool_use", input: event.delta } };
		default:
			return undefined;
	}
}

function toolResultText(content: AssistantMessage["content"] | unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
					return String((block as { text?: string }).text ?? "");
				}
				return "";
			})
			.join("")
			.trim();
	}
	return "";
}

// ---------------------------------------------------------------------------
// 流级重试：pi 的 Agent 循环不内置重试，这里在 streamFn 层补上
// ---------------------------------------------------------------------------

type BaseStreamFn = (
	model: PiModel<any>,
	context: PiContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * 判定一个流事件是否已经产生了"对用户可见/对上下文有影响"的内容。
 * 注意：text_start / text_end 即使内容为空也会被部分 provider 发出（如 faux、部分网关），
 * 因此只有非空的 delta 或带参数的 toolcall 才视为"已产出内容"。
 */
function hasMeaningfulContent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
			return event.content.length > 0;
		case "toolcall_end":
			return Object.keys(event.toolCall.arguments ?? {}).length > 0;
		default:
			return false;
	}
}

/**
 * 包一层"无内容即重试"的流：
 * 缓冲 start/终止事件，只有在确认本次尝试已经产出内容后才向 Agent 循环转发。
 * 这样重试不会向会话记录里塞入半截的失败消息。
 */
function createRetryingStreamFn(
	base: BaseStreamFn,
	policy: RetryConfig | undefined,
	signal: AbortSignal | undefined,
): BaseStreamFn {
	return (model, context, options) => {
		const outer = new AssistantMessageEventStream();

		void (async () => {
			let attempt = 0;
			for (;;) {
				const inner = base(model, context, options);
				const buffered: AssistantMessageEvent[] = [];
				let sawContent = false;
				let terminal: AssistantMessageEvent | undefined;
				let streamError: unknown;

				try {
					for await (const event of inner) {
						if (event.type === "done" || event.type === "error") {
							terminal = event;
							continue;
						}
						if (hasMeaningfulContent(event)) {
							sawContent = true;
							for (const pending of buffered.splice(0)) outer.push(pending);
							outer.push(event);
						} else if (sawContent) {
							outer.push(event);
						} else {
							buffered.push(event);
						}
					}
				} catch (error) {
					streamError = error;
				}

				const finalMessage = await inner.result().catch(() => undefined);
				const failed = finalMessage !== undefined && finalMessage.stopReason === "error";
				const retriable =
					policy !== undefined &&
					!sawContent &&
					((failed && isRetryableMessage(finalMessage as AssistantMessage, policy)) || streamError !== undefined);

				if (retriable && attempt < policy.maxRetries) {
					attempt += 1;
					const delay = computeBackoff(policy, attempt);
					const errorText =
						(failed ? (finalMessage as AssistantMessage).errorMessage : undefined) ??
						(streamError instanceof Error ? streamError.message : String(streamError ?? "unknown error"));
					policy.onRetry?.({ attempt, maxRetries: policy.maxRetries, delayMs: delay, error: errorText });
					await sleep(delay, signal);
					continue;
				}

				// 不再重试：把缓冲的事件按序补发，然后转发终止事件
				for (const pending of buffered) outer.push(pending);
				if (terminal) {
					outer.push(terminal); // push 终止事件即完成流并解析 result()
				} else if (finalMessage) {
					outer.end(finalMessage);
				} else {
					outer.end();
				}
				return;
			}
		})();

		return outer;
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
		const options = { ...this.options, ...overrides };
		const modelId = options.model;
		const override = options.runtimeOverride;
		if (!modelId && !override) throw new Error("Agent option `model` is required");
		if (!options.apiKey && !override) {
			// 新版配置的凭据在 ~/.zread/auth.json（pi CredentialStore），
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

		const cwd = options.cwd ?? process.cwd();

		// 运行时模型：默认由 open_zread 的 LLM 配置构建；测试可注入 pi 原生 Model/streamFn
		let model: PiModel<any>;
		let streamBase: BaseStreamFn;
		let apiTypeForContext: ApiType;
		let providerIdForContext: string;
		let compactionModels: MutableModels | undefined;
		if (override) {
			model = override.model;
			streamBase = override.streamFn;
			compactionModels = override.models;
			apiTypeForContext =
				override.model.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
			providerIdForContext = String(override.model.provider);
		} else {
			const runtime: RuntimeModel = createRuntimeModel({
				providerId: options.providerId,
				modelId: modelId as string,
				apiKey: options.apiKey,
				baseURL: options.baseURL,
				apiType: options.apiType,
				contextWindow: options.contextWindow,
				maxTokens: options.maxTokens,
			});
			model = runtime.model;
			apiTypeForContext = runtime.apiType;
			providerIdForContext = runtime.providerId;
			compactionModels = runtime.models;
			streamBase = (streamModel, streamContext, streamOptions) =>
				runtime.streamSimple(streamModel, streamContext, streamOptions);
		}

		const toolDefinitions = (options.tools ?? []).filter(
			(candidate): candidate is ToolDefinition => typeof candidate === "object",
		);

		const retryPolicy = options.retryConfig;
		const retryScope = options.retryScope ?? "stream";
		const compactionSettings: CompactionSettings = {
			enabled: options.compaction?.enabled ?? true,
			reserveTokens: options.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: options.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};
		const startedAt = Date.now();
		let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
		let runAttempt = 0;

		// 系统提示：等价旧 SDK 的 systemPrompt + appendSystemPrompt
		const systemPrompt = [options.systemPrompt, options.appendSystemPrompt].filter(Boolean).join("\n\n");

		for (;;) {
			const queue = new AsyncQueue<SDKMessage>();
			let turnCount = 0;
			let stoppedByMaxTurns = false;
			let stoppedByContextFull = false;
			let contextFullInfo: { tokens: number; window: number } | undefined;
			let lastAssistant: AssistantMessage | undefined;
			let resultEmitted = false;

			// 上下文压缩状态（每次运行重置：run 级重试会新建空会话的 Agent）
			let compactionState: CompactionState | undefined;
			let compactionExhausted = false;
			let compactionFailed = false;

			const bridge: ToolBridgeContext = {
				cwd,
				model: modelId,
				providerId: providerIdForContext,
				apiType: apiTypeForContext,
				hooks: options.hooks,
				canUseTool: options.canUseTool,
			};
			const tools = toolDefinitions.map((definition) => toAgentTool(definition, bridge));

			const streamFn = createRetryingStreamFn(streamBase, retryPolicy, this.abortController.signal);

			const agent = new PiAgent({
				initialState: {
					systemPrompt,
					model,
					thinkingLevel: options.thinkingLevel ?? "off",
					tools,
					messages: [],
				},
				streamFn,
				convertToLlm,
				transformContext: async (messages, signal) => {
					// 契约：不得抛出；失败时返回可用的回退值
					const effective = buildEffectiveMessages(messages, compactionState);
					if (!compactionSettings.enabled || !compactionModels || !(model.contextWindow > 0)) {
						return effective;
					}
					try {
						const tokensBefore = estimateContextTokens(effective).tokens;
						if (!shouldCompact(tokensBefore, model.contextWindow, compactionSettings)) return effective;

						const preparation = prepareCompaction(
							toCompactionEntries(effective, compactionState),
							compactionSettings,
						);
						if (
							!preparation.ok ||
							!preparation.value ||
							(preparation.value.messagesToSummarize.length === 0 &&
								preparation.value.turnPrefixMessages.length === 0)
						) {
							// 没有可总结的内容：压缩无法腾出空间
							compactionExhausted = true;
							return effective;
						}

						const piContext = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
						const compacted = await compact(
							preparation.value,
							compactionModels,
							model,
							undefined,
							options.thinkingLevel && options.thinkingLevel !== "off" ? options.thinkingLevel : undefined,
							undefined,
							undefined,
							piContext,
						);
						if (!compacted.ok) {
							compactionFailed = true;
							compactionExhausted = true;
							return effective;
						}

						compactionState = {
							summary: compacted.value.summary,
							tokensBefore: compacted.value.tokensBefore,
							timestamp: Date.now(),
							tail: compacted.value.retainedTail,
							fromIndex: messages.length,
						};
						const view = buildEffectiveMessages(messages, compactionState);
						// 压缩没腾出空间（摘要 + 保留段不小于原上下文）：下一轮结束优雅停止，避免反复压缩
						if (sumEstimatedTokens(view) >= sumEstimatedTokens(effective)) {
							compactionExhausted = true;
						}
						queue.push({ type: "system", subtype: "compact_boundary", summary: compacted.value.summary });
						return view;
					} catch {
						compactionFailed = true;
						compactionExhausted = true;
						return effective;
					}
				},
				beforeToolCall: async (context, signal) => {
					const toolName = context.toolCall.name;
					const abortSignal = signal ?? this.abortController.signal;

					if (options.canUseTool) {
						const definition = toolDefinitions.find((tool) => tool.name === toolName);
						if (definition) {
							const decision = await options.canUseTool(definition, context.args);
							if (decision.behavior === "deny") {
								return { block: true, reason: decision.message ?? `Tool ${toolName} denied` };
							}
						}
					}

					const hookResults = await runToolHooks(
						options.hooks,
						"PreToolUse",
						{ toolName, toolInput: context.args, toolUseId: context.toolCall.id },
						context.toolCall.id,
						abortSignal,
						toolName,
					);
					for (const result of hookResults) {
						if (result && typeof result === "object" && (result as { block?: boolean }).block === true) {
							const reason = (result as { message?: string }).message;
							return { block: true, reason: reason ?? `Blocked by PreToolUse hook: ${toolName}` };
						}
					}
					return undefined;
				},
				afterToolCall: async (context, signal) => {
					const abortSignal = signal ?? this.abortController.signal;
					await runToolHooks(
						options.hooks,
						"PostToolUse",
						{
							toolName: context.toolCall.name,
							toolInput: context.args,
							toolOutput: toolResultText(context.result?.content),
							toolUseId: context.toolCall.id,
							isError: context.isError,
						},
						context.toolCall.id,
						abortSignal,
						context.toolCall.name,
					);
					return undefined;
				},
				shouldStopAfterTurn: (turnContext: ShouldStopAfterTurnContext) => {
					turnCount += 1;
					const maxTurns = options.maxTurns ?? 30;
					if (turnCount >= maxTurns) {
						stoppedByMaxTurns = true;
						return true;
					}
					if (!(model.contextWindow > 0)) return false;
					try {
						const effective = buildEffectiveMessages(turnContext.context.messages, compactionState);
						const tokens = estimateContextTokens(effective).tokens;
						if (tokens < model.contextWindow - compactionSettings.reserveTokens) return false;

						// 上下文将满：只有「压缩仍能腾出空间」时才继续下一轮；
						// 否则在此优雅停止，不再向 provider 发一个必然溢出的请求。
						if (compactionSettings.enabled && compactionModels && !compactionExhausted && !compactionFailed) {
							const preparation = prepareCompaction(
								toCompactionEntries(effective, compactionState),
								compactionSettings,
							);
							if (
								preparation.ok &&
								preparation.value &&
								(preparation.value.messagesToSummarize.length > 0 ||
									preparation.value.turnPrefixMessages.length > 0)
							) {
								return false;
							}
							compactionExhausted = true;
						}
						stoppedByContextFull = true;
						contextFullInfo = { tokens, window: model.contextWindow };
						return true;
					} catch {
						stoppedByContextFull = true;
						contextFullInfo = { tokens: 0, window: model.contextWindow };
						return true;
					}
				},
				sessionId: `open-zread-${Date.now()}`,
				toolExecution: "parallel",
			});

			const unsubscribe = agent.subscribe((event: AgentEvent) => {
				switch (event.type) {
					case "message_update": {
						if (options.includePartialMessages === false) return;
						const partial = mapPartial(event.assistantMessageEvent);
						if (partial) queue.push(partial);
						return;
					}
					case "message_end": {
						const message = event.message;
						if (message.role === "assistant") {
							lastAssistant = message;
							const usage = mapUsage(message.usage);
							if (usage) totalUsage = usage;
							queue.push({
								type: "assistant",
								message: { role: "assistant", content: mapAssistantContent(message) },
								usage,
							});
						}
						return;
					}
					case "tool_execution_end": {
						queue.push({
							type: "tool_result",
							result: {
								tool_use_id: event.toolCallId,
								tool_name: event.toolName,
								output: toolResultText(event.result?.content),
							},
						});
						return;
					}
					case "agent_end": {
						// 一轮运行结束：关闭事件队列，让 query() 的 for-await 自然收敛
						queue.close();
						return;
					}
					default:
						return;
				}
			});

			// 会话初始化事件（与旧引擎的 system/init 对齐）
			queue.push({
				type: "system",
				subtype: "init",
				session_id: `open-zread-${startedAt}`,
				tools: toolDefinitions.map((tool) => tool.name),
				model: modelId ?? String(model.id),
				cwd,
				mcp_servers: [],
				permission_mode: options.permissionMode ?? "bypassPermissions",
			});

			const runPromise = agent
				.prompt(prompt)
				.catch((error: unknown) => {
					lastAssistant = lastAssistant ?? {
						role: "assistant",
						content: [],
						api: apiTypeForContext,
						provider: providerIdForContext,
						model: modelId ?? "unknown",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					};
				})
				.finally(() => {
					queue.close();
				});

			// 把 pi 的事件流转换为 SDKMessage 流
			for await (const message of queue) {
				yield message;
			}

			await runPromise;
			unsubscribe();

			const failure = lastAssistant as AssistantMessage | undefined;
			const failedRun =
				stoppedByMaxTurns ||
				stoppedByContextFull ||
				(failure !== undefined && failure.stopReason === "error") ||
				agent.state.errorMessage !== undefined;

			if (!resultEmitted) {
				resultEmitted = true;
				const subtype = stoppedByMaxTurns
					? "error_max_turns"
					: stoppedByContextFull
						? "error_context_full"
						: failure && failure.stopReason === "error"
							? "error_during_execution"
							: failure && failure.stopReason === "aborted"
								? "error_during_execution"
								: "success";

				const errors = stoppedByContextFull
					? [
							`Context window nearly full (estimated ${contextFullInfo?.tokens ?? 0} / ${contextFullInfo?.window ?? model.contextWindow} tokens); stopped gracefully before overflow.`,
						]
					: failure?.errorMessage
						? [failure.errorMessage]
						: undefined;
				yield {
					type: "result",
					subtype,
					is_error: subtype !== "success",
					num_turns: turnCount,
					usage: totalUsage,
					duration_ms: Date.now() - startedAt,
					stop_reason: failure?.stopReason ?? null,
					errors,
				};
			}

			if (!failedRun) return;

			// run 级重试（可选）：仅在允许且仍有预算时整轮重跑
			const canRetryRun =
				retryScope === "stream+run" &&
				!stoppedByMaxTurns &&
				!stoppedByContextFull &&
				retryPolicy !== undefined &&
				runAttempt < retryPolicy.maxRetries &&
				isRetryableMessage(failure as AssistantMessage, retryPolicy);

			if (!canRetryRun) return;

			runAttempt += 1;
			const delay = computeBackoff(retryPolicy, runAttempt);
			retryPolicy.onRetry?.({
				attempt: runAttempt,
				maxRetries: retryPolicy.maxRetries,
				delayMs: delay,
				error: failure?.errorMessage ?? "run failed",
			});
			await sleep(delay, this.abortController.signal);
		}
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

// ---------------------------------------------------------------------------
// 简易异步队列：把订阅式事件转成 AsyncGenerator
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ value: undefined as unknown as T, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				const item = this.items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}
