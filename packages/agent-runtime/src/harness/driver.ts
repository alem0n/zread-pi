/**
 * HarnessAgentDriver —— 用 pi 的 AgentHarness 替换裸 agent loop。
 *
 * 结构（低耦合：每个关注点一个模块，driver 只做装配与驱动）：
 *
 *   budget.ts    token 预算           before_run / before_run_end / before_tool 三处钩子
 *   tools.ts     ToolDefinition    → AgentHarnessTool
 *   events.ts    HarnessEvent       → SDKMessage
 *   models.ts    Models 桥           getModel 覆盖 + streamFn 注入
 *   queue.ts     订阅事件           → AsyncGenerator
 *   driver.ts    ← 本文件：会话/泳道生命周期（MemorySessionRepo → Session → AgentHarness
 *                → AgentLane）、注册钩子与事件、驱动「预算分段」、归类结果
 *
 * 对外契约（SDKMessage 时序 / result.subtype / TokenUsage 字段名）与裸 loop 时期一致；
 * 差异只在首尾机制：轮数 → token 预算、一次性提示 → 两段式提示、
 * shouldStopAfterTurn → before_run_end、error_max_turns → error_budget_exhausted + 编排层判页失败。
 */

import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	MemorySessionRepo,
	type AgentHarnessTool,
	type CompactionSettings,
	type Context,
	type OperationResultRecord,
	type Session,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { BudgetController, usageTokens } from "./budget.js";
import { mapAssistantContent, mapPartialEvent, mapToolResult, mapUsage } from "./events.js";
import { AsyncQueue } from "./queue.js";
import { toHarnessTools, unwrapBridgedDetails, type BridgedToolDetails, type ToolBridgeContext } from "./tools.js";
import { blockedByHookResult, runToolHooks, type HookConfig } from "../hooks.js";
import type { ApiType } from "../providers/types.js";
import type { PermissionMode, SDKMessage, TokenUsage, ToolDefinition } from "../types.js";

/** 结果归类：这是 SDK 层唯一对外可见的终局分类 */
export type HarnessSubtype =
	| "success"
	| "error_budget_exhausted"
	| "error_context_full"
	| "error_during_execution";

export interface HarnessQueryRequest {
	/** 首个 run 段的用户提示 */
	prompt: string;
	sessionId: string;
	cwd: string;
	/** 展示用模型 id */
	modelId: string;
	apiType: ApiType;
	providerId: string;
	permissionMode: PermissionMode;
	includePartialMessages: boolean;
	toolNames: string[];
	tools: ToolDefinition[];
	models: Models;
	model: Model<Api>;
	systemPrompt: string;
	thinkingLevel: ThinkingLevel;
	retry?: RetryPolicy;
	compaction: CompactionSettings;
	budget: BudgetController;
	/** 旧 PreToolUse / PostToolUse 钩子（编排层 UI 进度） */
	hookConfig?: HookConfig;
	canUseTool?: (tool: ToolDefinition, input: unknown) => Promise<{ behavior: "allow" | "deny"; message?: string }>;
	/** 外部取消信号（durable 取消走 lane.abort，不打断本地观察） */
	signal?: AbortSignal;
	/** 重试回调（业务 UI 的 retry 事件） */
	onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; error: string }) => void;
}

const ROOT_CONTEXT: Context = BACKGROUND_CONTEXT;

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 旧 `error_context_full` 文案（首句与迁移前一致，便于既有断言/日志检索） */
function contextFullMessage(providerMessage: string | undefined): string {
	return `Context window nearly full; stopped gracefully before overflow.${
		providerMessage ? ` Provider reported: ${providerMessage}` : ""
	}`;
}

/** 预算耗尽文案（权威用量来自 usage ledger 的累计 totals） */
function budgetExhaustedMessage(spent: number, maxTokens: number, forcedTurns: number): string {
	return `Token budget exhausted (${spent} / ${maxTokens} tokens${
		forcedTurns > 0 ? `, after ${forcedTurns} forced finalization turn${forcedTurns > 1 ? "s" : ""}` : ""
	}); stopped before the task completed.`;
}

/**
 * 用 pi-ai 的权威溢出判定复用：`isContextOverflow` 接受 AssistantMessage，
 * 这里只需要它的 error/stopReason 两个字段。
 *
 * 另外补上 harness 自己的溢出文案：关闭压缩时 overflow 恢复压缩被 `before_compaction`
 * 拒绝，harness 以 `"Overflow compaction was declined"` 失败 —— 根因仍是上下文溢出。
 */
function looksLikeContextOverflow(message: string): boolean {
	if (/overflow compaction was declined/i.test(message)) return true;
	const probe = { stopReason: "error", errorMessage: message } as unknown as AssistantMessage;
	return isContextOverflow(probe);
}

/**
 * 跑一次生成（一个 query）。
 *
 * 分段驱动（budget segments）：`before_run` 只在 run 起点触发，因此当一次 run 结束
 * 而两段式提示又「已到期但未注入」时，driver 再起一个 run —— 提示由 `before_run`
 * 注入到新 run 的 checkpoint 里（durable），而不是像旧实现那样用 `agent.steer()`
 * 在裸循环里插话。整段生成对业务层仍是一次 query、一个 result 事件。
 */
export async function* queryHarness(request: HarnessQueryRequest): AsyncGenerator<SDKMessage, void> {
	const startedAt = Date.now();
	const repo = new MemorySessionRepo();
	const unsubscribe: Array<() => void> = [];
	let harness: AgentHarness<ToolBridgeContext> | undefined;
	let session: Session | undefined;
	let currentQueue: AsyncQueue<SDKMessage> | undefined;
	let totals: Usage | undefined;
	let lastAssistant: AssistantMessage | undefined;

	const push = (message: SDKMessage): void => currentQueue?.push(message);

	try {
		session = await repo.create({ id: request.sessionId }, ROOT_CONTEXT);

		const toolBridge: ToolBridgeContext = {
			cwd: request.cwd,
			model: request.modelId,
			providerId: request.providerId,
			apiType: request.apiType,
			supportsImages: Array.isArray(request.model.input) ? request.model.input.includes("image") : undefined,
		};
		const tools: AgentHarnessTool<ToolBridgeContext, TSchema, BridgedToolDetails>[] = toHarnessTools(
			request.tools,
		);
		const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));

		const created = await AgentHarness.create<ToolBridgeContext>(
			{
				session,
				models: request.models,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				tools,
				toolContext: toolBridge,
				systemPrompt: request.systemPrompt,
				retry: request.retry,
				compaction: request.compaction,
				toolExecution: "parallel",
			},
			ROOT_CONTEXT,
		);
		harness = created.harness;
		const lane = await harness.lane("main", ROOT_CONTEXT);

		// ----------------------------------------------------------------
		// 钩子：预算（before_run / before_run_end / before_tool）+ 旧工具钩子
		// ----------------------------------------------------------------
		unsubscribe.push(
			harness.hooks.on("before_run", () => request.budget.beforeRun(), { id: "zread-pi-budget-notices" }),
			harness.hooks.on("before_run_end", () => request.budget.beforeRunEnd(), { id: "zread-pi-budget-finish" }),
			harness.hooks.on(
				"before_compaction",
				() => {
					// `compaction.enabled === false` = 彻底不摘要（含 overflow 恢复压缩；
					// harness 的 threshold 路径已由 shouldCompact 拦住，overflow 路径需要在这里拒绝）
					return request.compaction.enabled ? undefined : { decline: true };
				},
				{ id: "zread-pi-compaction-switch" },
			),
			harness.hooks.on(
				"before_tool",
				async (event, context) => {
					// 1) 预算熔断：预算耗尽后不再放行新的探索工具（目标输出工具例外）
					const blockedByBudget = request.budget.beforeTool(event.toolName);
					if (blockedByBudget) return blockedByBudget;

					// 2) 权限回调（旧 canUseTool 语义）
					if (request.canUseTool) {
						const definition = toolsByName.get(event.toolName);
						if (definition) {
							const decision = await request.canUseTool(definition, event.args);
							if (decision.behavior === "deny") {
								return { block: { reason: decision.message ?? `Tool ${event.toolName} denied` } };
							}
						}
					}

					// 3) 旧 PreToolUse 钩子（UI 进度 + 可阻断）
					const signal = context.abortSignal ?? new AbortController().signal;
					const results = await runToolHooks(
						request.hookConfig,
						"PreToolUse",
						{ toolName: event.toolName, toolInput: event.args, toolUseId: event.toolCallId },
						event.toolCallId,
						signal,
						event.toolName,
					);
					const blockedReason = blockedByHookResult(results);
					return blockedReason === undefined
						? undefined
						: { block: { reason: blockedReason } };
				},
				{ id: "zread-pi-tool-hooks" },
			),
			harness.hooks.on(
				"after_tool",
				async (event, context) => {
					const signal = context.abortSignal ?? new AbortController().signal;
					await runToolHooks(
						request.hookConfig,
						"PostToolUse",
						{
							toolName: event.toolName,
							toolInput: event.args,
							toolOutput: toolOutputText(event.content),
							toolUseId: event.toolCallId,
							isError: event.isError,
						},
						event.toolCallId,
						signal,
						event.toolName,
					);
					return undefined;
				},
				{ id: "zread-pi-tool-result-hooks" },
			),
		);

		// ----------------------------------------------------------------
		// 事件：harness → SDKMessage（含权威 usage ledger）
		// ----------------------------------------------------------------
		unsubscribe.push(
			harness.events.on("usage", (event) => {
				totals = event.totals;
				request.budget.observeUsage(event.totals);
			}),
			harness.events.on("turn_end", () => {
				request.budget.observeTurn();
			}),
			harness.events.on("message_update", (event) => {
				if (!request.includePartialMessages) return;
				const partial = mapPartialEvent(event.event);
				if (partial) push(partial);
			}),
			harness.events.on("message_end", (event) => {
				const message = event.message;
				if (message.role !== "assistant") return;
				lastAssistant = message;
				push({
					type: "assistant",
					message: { role: "assistant", content: mapAssistantContent(message) },
					usage: mapUsage(message.usage),
				});
			}),
			harness.events.on("tool_end", (event) => {
				request.budget.observeToolEnd(event.toolName, event.isError);
				push(
					mapToolResult(
						event.toolCallId,
						event.toolName,
						event.result?.content,
						unwrapBridgedDetails(event.result?.details),
					),
				);
			}),
			harness.events.on("retry_scheduled", (event) => {
				request.onRetry?.({
					attempt: event.attempt,
					maxRetries: event.maxAttempts,
					delayMs: event.delayMs,
					error: event.errorMessage,
				});
			}),
			harness.events.on("compaction_end", async (event) => {
				if (event.status !== "completed") return;
				// in-run 压缩段：与迁移前的 system/compact_boundary 事件对齐
				const summary = await readCompactionSummary(session as Session, event.entryId);
				push({ type: "system", subtype: "compact_boundary", ...(summary ? { summary } : {}) });
			}),
			harness.events.on("handler_error", (event) => {
				// 钩子/监听器失败不改变结果，但要可见（harness 的 handler_error 事件）
				const source = event.kind === "hook" ? event.hook : event.event;
				push({
					type: "system",
					subtype: "status",
					message: `[harness] ${event.kind} ${source} 失败：${event.error}`,
				});
			}),
		);

		// 会话初始化事件（与旧引擎的 system/init 对齐；首个 run 段开始前发出）
		const initMessage: SDKMessage = {
			type: "system",
			subtype: "init",
			session_id: request.sessionId,
			tools: request.toolNames,
			model: request.modelId,
			cwd: request.cwd,
			mcp_servers: [],
			permission_mode: request.permissionMode,
		};

		// ----------------------------------------------------------------
		// 驱动：预算分段
		// ----------------------------------------------------------------
		const abortListener = (): void => {
			// durable 取消：只写取消标记并等待同一 id 的收敛，不打断本地 for-await
			void lane.abort(ROOT_CONTEXT).catch(() => undefined);
		};
		if (request.signal) {
			if (request.signal.aborted) abortListener();
			else request.signal.addEventListener("abort", abortListener, { once: true });
		}

		let record: OperationResultRecord | undefined;
		let suspended = false;
		let failure: string | undefined;
		let promptText = request.prompt;
		let segment = 0;

		try {
			while (true) {
				const queue = new AsyncQueue<SDKMessage>();
				currentQueue = queue;
				if (segment === 0) queue.push(initMessage);
				const settle = lane
					.prompt(promptText, undefined, ROOT_CONTEXT)
					.then(
						(result) => {
							if (!result.ok) {
								failure = describeAdmissionError(result.error);
								return;
							}
							if ("status" in result.value && result.value.status === "suspended") {
								suspended = true;
								return;
							}
							record = result.value as OperationResultRecord;
						},
						(error: unknown) => {
							failure = toErrorMessage(error);
						},
					)
					.finally(() => queue.close());

				for await (const message of queue) yield message;
				await settle;
				currentQueue = undefined;

				if (failure !== undefined || suspended || record === undefined) break;
				if (record.status !== "completed") break;
				if (!request.budget.pendingNotice()) break;
				// 提示到期：再起一个 run，让 before_run 把它写进 checkpoint
				promptText = request.budget.continuePrompt;
				segment += 1;
			}
		} finally {
			request.signal?.removeEventListener("abort", abortListener);
		}

		yield buildResultMessage({
			record,
			suspended,
			failure,
			budget: request.budget,
			lastAssistant,
			totals,
			startedAt,
			fallbackModelId: request.modelId,
		});
	} finally {
		for (const off of unsubscribe.splice(0)) off();
		currentQueue?.close();
		if (harness) await harness.close(ROOT_CONTEXT).catch(() => undefined);
		if (session) await session.close(ROOT_CONTEXT).catch(() => undefined);
		await repo.close(ROOT_CONTEXT).catch(() => undefined);
	}
}

/** 结果归类：把 OperationResultRecord + 预算状态翻译成 SDKResultMessage */
function buildResultMessage(input: {
	record: OperationResultRecord | undefined;
	suspended: boolean;
	failure: string | undefined;
	budget: BudgetController;
	lastAssistant: AssistantMessage | undefined;
	totals: Usage | undefined;
	startedAt: number;
	fallbackModelId: string;
}): SDKMessage {
	const { record, suspended, failure, budget } = input;
	const snapshot = budget.snapshot();
	const cumulativeUsage: TokenUsage | undefined = mapUsage(input.totals);
	const duration = Math.round(Date.now() - input.startedAt);
	const stopReason = input.lastAssistant?.stopReason ?? null;
	const errors: string[] = [];

	let subtype: HarnessSubtype = "success";
	if (suspended) {
		subtype = "error_during_execution";
		errors.push("Run suspended on a deferred provider response; this runtime does not poll deferred responses.");
	} else if (failure !== undefined) {
		subtype = "error_during_execution";
		errors.push(failure);
	} else if (record === undefined) {
		subtype = "error_during_execution";
		errors.push("Run produced no terminal record.");
	} else if (record.status === "aborted") {
		subtype = "error_during_execution";
		errors.push(record.error?.message ?? "Run aborted.");
	} else if (record.status === "failed") {
		const message = record.error?.message;
		if (message !== undefined && looksLikeContextOverflow(message)) {
			subtype = "error_context_full";
			errors.push(contextFullMessage(message));
		} else {
			subtype = "error_during_execution";
			errors.push(message ?? "Run failed.");
		}
	} else if (budget.budgetExhausted && budget.requiresOutput && !budget.deliveredOutput) {
		// 预算耗尽、强制交卷后仍没有目标产物：内核判「预算耗尽」，
		// 业务层照旧按「页面文件不存在」判页失败（两层互不依赖）
		subtype = "error_budget_exhausted";
		errors.push(budgetExhaustedMessage(snapshot.spent, snapshot.maxTokens, snapshot.forcedTurnsUsed));
	}

	return {
		type: "result",
		subtype,
		is_error: subtype !== "success",
		num_turns: snapshot.turns,
		usage: cumulativeUsage,
		duration_ms: duration,
		stop_reason: stopReason,
		...(errors.length > 0 ? { errors } : {}),
	};
}

/** 入队失败的失败原因（LaneBusy / InvalidMessage / Closed ...） */
function describeAdmissionError(error: unknown): string {
	if (error && typeof error === "object") {
		const candidate = error as { type?: string; kind?: string; message?: string };
		if (typeof candidate.message === "string" && candidate.message.length > 0) return candidate.message;
		if (typeof candidate.kind === "string") return candidate.kind;
		if (typeof candidate.type === "string") return candidate.type;
	}
	return String(error);
}

/** 工具结果内容块 → 纯文本（PostToolUse 钩子的 toolOutput 字段） */
function toolOutputText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: string; text?: string; mimeType?: string };
			if (typed.type === "text") return typed.text ?? "";
			if (typed.type === "image") return `[image ${typed.mimeType ?? "image"}]`;
			return "";
		})
		.join("");
}

/** 读取 in-run 压缩条目的摘要（compact_boundary 事件载荷） */
async function readCompactionSummary(session: Session, entryId: string | undefined): Promise<string | undefined> {
	if (entryId === undefined) return undefined;
	try {
		const entry = await session.getEntry(entryId, ROOT_CONTEXT);
		return entry?.type === "compaction" ? entry.summary : undefined;
	} catch {
		return undefined;
	}
}

/** 供测试/诊断：当前累计用量（token 口径与预算一致） */
export function spentTokens(totals: Usage | undefined): number {
	return usageTokens(totals);
}
