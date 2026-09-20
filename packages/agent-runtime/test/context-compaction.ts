/**
 * context-compaction.ts —— 上下文压缩 + 首尾机制（token 预算 / 两段式提示 / before_run_end）冒烟测试
 *（离线、不调用外部 API）
 *
 * 迁移后的验证点（对应 AGENTS.md §4 的预算与压缩契约）：
 *  1. 上下文压缩由 harness 内建承担：run 边界处按 `contextWindow - reserveTokens` 触发摘要，
 *     发出 `system/compact_boundary`，压缩后继续运行并最终 success；
 *  2. 上下文溢出（provider 报错）→ harness 归类 overflow → 适配层映射回 `error_context_full`
 *     与「Context window nearly full」文案；
 *  3. token 预算：判据是 usage 事件/ledger 的**累计 tokens**（不是轮数）。
 *     本文件用「固定 usage 的 streamFn」把每一次响应的用量钉死，从而断言预算在
 *     精确的累计 token 数上生效：10 个 turn 的小用量不触发任何提示，
 *     2 个 turn 的大用量就会触发提示/终止；
 *  4. 两段式提示：软提示（默认 70% 预算）+ 硬提示（预算将尽），经 `before_run` 注入；
 *  5. `before_run_end`：不返回 followUp 即终止；预算耗尽时返回硬提示 followUp（强制交卷）；
 *     强制交卷后仍没有目标产物 → 内核 `error_budget_exhausted`，
 *     编排层照旧按「页面文件不存在」判页失败（见 packages/orchestrator/test/*）；
 *  6. `maxTurns` 兼容字段折算成 token 预算（`maxTurns * TOKENS_PER_TURN`，0 = 不限制）。
 *
 * 运行：bun run test:context
 */

import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgent,
	defineTool,
	resolveBudgetOptions,
	TOKENS_PER_TURN,
	type SDKMessage,
	type ToolDefinition,
} from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const BIG_PAYLOAD_CHARS = 4000;
const bigTool: ToolDefinition = defineTool({
	name: "Big",
	description: "返回固定长度的大段文本，用于撑大上下文",
	inputSchema: { type: "object", properties: { size: { type: "number" } } },
	isReadOnly: true,
	isConcurrencySafe: true,
	call: async () => "x".repeat(BIG_PAYLOAD_CHARS),
});

/** 目标输出工具（交卷判定的锚点；业务侧对应 write_page / generate_blueprint） */
const deliverCalls: string[] = [];
const deliverTool: ToolDefinition = defineTool({
	name: "Deliver",
	description: "产出最终结果（交卷）",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	call: async (input) => {
		deliverCalls.push(String(input.text ?? ""));
		return "delivered";
	},
});

// ---------------------------------------------------------------------------
// 固定 usage 的流包装：把 faux 的估算用量换成测试指定值
//
// 预算判定必须以 usage 事件为准，所以测试必须能精确控制每次响应的用量：
// 直接在终止事件上改写 usage 即可（harness 以 stream.result() 的消息为准）。
// ---------------------------------------------------------------------------

function fixedUsageStream(inner: AssistantMessageEventStream, usage: Usage): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		for await (const event of inner) {
			if (event.type === "done") {
				outer.push({ ...event, message: { ...event.message, usage } });
			} else if (event.type === "error") {
				outer.push({ ...event, error: { ...event.error, usage } });
			} else {
				outer.push(event as AssistantMessageEvent);
			}
		}
	})();
	return outer;
}

function makeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** 单个测试场景的公共返回值 */
interface ScenarioResult {
	subtype: string | undefined;
	numTurns: number | undefined;
	errors: string[] | undefined;
	systemEvents: string[];
	capturedRequestMessages: number[];
	capturedFirstUserTexts: string[];
	/** 每次请求里所有 user 消息的文本（用于断言提示注入） */
	capturedUserTexts: string[][];
	/** tool_result 事件的输出文本（断言熔断/错误结果） */
	toolOutputs: string[];
	toolNames: string[];
	/** 本场景里 Deliver 工具收到的参数（交卷断言） */
	deliverCalls: string[];
	callCount: number;
}

async function runScenario(options: {
	contextWindow: number;
	maxTurns?: number;
	budget?: {
		maxTokens?: number;
		softRatio?: number;
		forcedTurns?: number;
		notices?: { soft?: string; hard?: string };
		outputTools?: string[];
		continuePrompt?: string;
	};
	compaction: { enabled?: boolean; reserveTokens: number; keepRecentTokens: number };
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
	/** 每次响应的固定 usage（累计值 = 响应次数 × 该值） */
	usage?: Usage;
	prompt: string;
	tools?: ToolDefinition[];
}): Promise<ScenarioResult> {
	const faux = fauxProvider({
		tokensPerSecond: 0,
		models: [{ id: "faux-model", contextWindow: options.contextWindow, maxTokens: 512 }],
	});
	deliverCalls.length = 0;
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel("faux-model") ?? faux.models[0];
	faux.setResponses(options.responses);

	const capturedRequestMessages: number[] = [];
	const capturedFirstUserTexts: string[] = [];
	const capturedUserTexts: string[][] = [];
	const systemEvents: string[] = [];
	const toolOutputs: string[] = [];
	const toolNames: string[] = [];
	let subtype: string | undefined;
	let numTurns: number | undefined;
	let errors: string[] | undefined;

	const messageText = (message: { content?: unknown }): string => {
		const content = message.content;
		if (Array.isArray(content)) {
			return content.map((block) => (block.type === "text" ? block.text : "")).join("");
		}
		return String(content ?? "");
	};

	const agent = createAgent({
		model: String(model.id),
		systemPrompt: "sys",
		maxTurns: options.maxTurns,
		budget: options.budget,
		compaction: options.compaction,
		tools: options.tools ?? [bigTool],
		includePartialMessages: false,
		runtimeOverride: {
			model,
			models,
			streamFn: (streamModel, context, streamOptions) => {
				capturedRequestMessages.push(context.messages.length);
				capturedUserTexts.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) => messageText(message as { content?: unknown })),
				);
				const first = context.messages[0];
				if (first && first.role === "user") {
					capturedFirstUserTexts.push(messageText(first as { content?: unknown }));
				}
				const stream = models.streamSimple(streamModel, context, streamOptions);
				return options.usage ? fixedUsageStream(stream, options.usage) : stream;
			},
		},
	});

	for await (const event of agent.query(options.prompt) as AsyncIterable<SDKMessage>) {
		if (event.type === "system") systemEvents.push(event.subtype);
		if (event.type === "tool_result") {
			toolOutputs.push(event.result.output);
			toolNames.push(event.result.tool_name);
		}
		if (event.type === "result") {
			subtype = event.subtype;
			numTurns = event.num_turns;
			errors = event.errors;
		}
	}
	await agent.close();

	return {
		subtype,
		numTurns,
		errors,
		systemEvents,
		capturedRequestMessages,
		capturedFirstUserTexts,
		capturedUserTexts,
		toolOutputs,
		toolNames,
		deliverCalls: [...deliverCalls],
		callCount: faux.state.callCount,
	};
}

/** 某个字符串是否出现在第 index 次请求的上下文里 */
function injectedAt(result: ScenarioResult, index: number, needle: string): boolean {
	return result.capturedUserTexts[index]?.some((text) => text.includes(needle)) === true;
}

// ---------------------------------------------------------------------------
// 场景 1：harness 内建压缩（上下文将满 → 摘要 → 继续）
// ---------------------------------------------------------------------------
console.log("▶ 场景 1：上下文将满 → harness 内建 compaction 摘要 → 继续运行");
{
	const result = await runScenario({
		contextWindow: 4000,
		budget: { maxTokens: 0 },
		compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1600 },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_2" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_3" })]),
			fauxAssistantMessage("【压缩摘要】前三个 turn 已总结"),
			fauxAssistantMessage("全部完成"),
		],
	});

	check(
		"发出 system/compact_boundary 事件",
		result.systemEvents.includes("compact_boundary"),
		result.systemEvents.join(","),
	);
	check("压缩后的运行以 success 结束", result.subtype === "success", String(result.subtype));
	check("压缩占用了额外的摘要请求（5 次模型调用）", result.callCount === 5, `callCount=${result.callCount}`);
	check(
		"压缩前共 3 次请求、消息数递增",
		result.capturedRequestMessages.slice(0, 3).join(",") === "1,3,5",
		result.capturedRequestMessages.join(","),
	);
	check(
		"压缩后的请求使用「摘要 + 保留消息」（3 条）",
		result.capturedRequestMessages[3] === 3,
		result.capturedRequestMessages.join(","),
	);
	check(
		"压缩后的首条消息是摘要",
		result.capturedFirstUserTexts[3]?.includes("compacted") === true,
		result.capturedFirstUserTexts[3]?.slice(0, 60) ?? "(无)",
	);
	check("压缩后继续完成第 4 个 turn", result.numTurns === 4, String(result.numTurns));
}

// ---------------------------------------------------------------------------
// 场景 2：上下文溢出（provider 报错）→ error_context_full
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 2：provider 报上下文溢出 → error_context_full（文案保持）");
{
	const result = await runScenario({
		contextWindow: 1200,
		budget: { maxTokens: 0 },
		compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1600 },
		prompt: "开始",
		responses: [
			// 第 1 轮：一个极大的工具结果（不可压缩的单轮）
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_1" })]),
			// 第 2 轮：provider 直接报上下文溢出；无可压缩内容 → harness 归类 failure
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 999999 tokens > 1200 maximum",
			}),
		],
	});

	check("结果为 error_context_full", result.subtype === "error_context_full", String(result.subtype));
	check(
		"错误信息保持「Context window nearly full」前缀",
		result.errors?.[0]?.includes("Context window nearly full") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("溢出的错误原文被保留", result.errors?.[0]?.includes("prompt is too long") === true, result.errors?.[0] ?? "(无)");
}

// ---------------------------------------------------------------------------
// 场景 3：关闭压缩（compaction.enabled=false）→ 不发起任何摘要请求
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 3：compaction.enabled=false → 溢出也不摘要，直接优雅停止");
{
	const result = await runScenario({
		contextWindow: 1200,
		budget: { maxTokens: 0 },
		compaction: { enabled: false, reserveTokens: 200, keepRecentTokens: 1600 },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_1" })]),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 999999 tokens > 1200 maximum",
			}),
		],
	});

	check("关闭压缩后仍为 error_context_full", result.subtype === "error_context_full", String(result.subtype));
	check(
		"关闭压缩时没有任何摘要请求（before_compaction decline）",
		result.callCount === 2,
		`callCount=${result.callCount}`,
	);
	check(
		"关闭压缩的溢出同样归类为 error_context_full",
		result.errors?.[0]?.includes("Context window nearly full") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("没有 compact_boundary 事件", !result.systemEvents.includes("compact_boundary"), result.systemEvents.join(","));
}

// ---------------------------------------------------------------------------
// 场景 4：判据是 tokens 而不是轮次（10 个小 turn 不触发提示）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 4：10 个 turn 的小用量 → 预算不紧张，不注入任何提示");
{
	const soft = "【预算软提示】";
	const result = await runScenario({
		contextWindow: 200000,
		// 预算 100k tokens；每次响应只花 10 tokens → 10 个 turn 共 100 tokens，远未到 70%
		budget: { maxTokens: 100_000, notices: { soft, hard: "【预算硬提示】" }, outputTools: ["Deliver"] },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: makeUsage(6, 4),
		prompt: "开始",
		responses: [
			...Array.from({ length: 9 }, (_value, index) =>
				fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: `call_${index + 1}` })]),
			),
			fauxAssistantMessage("全部完成"),
		],
	});

	check("10 个 turn 后仍 success（没有轮数硬顶）", result.subtype === "success", String(result.subtype));
	check("共 10 次模型请求", result.callCount === 10, `callCount=${result.callCount}`);
	check("numTurns = 10", result.numTurns === 10, String(result.numTurns));
	check(
		"小用量下不注入软提示（判据是 token，不是轮数）",
		result.capturedUserTexts.every((texts) => texts.every((text) => !text.includes(soft))),
		JSON.stringify(result.capturedUserTexts),
	);
}

// ---------------------------------------------------------------------------
// 场景 4：2 个大用量 turn 就触发软提示（before_run 注入）+ 目标工具交卷 → success
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 5：2 个大用量 turn 越过 70% → before_run 注入软提示 → 交卷成功");
{
	const soft = "【预算软提示】请开始收敛";
	const hard = "【预算硬提示】预算即将耗尽";
	const result = await runScenario({
		contextWindow: 200000,
		// 预算 500：软阈值 350；每次响应 200 tokens
		budget: { maxTokens: 500, notices: { soft, hard }, outputTools: ["Deliver"] },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: makeUsage(150, 50),
		prompt: "开始",
		tools: [bigTool, deliverTool],
		responses: [
			// 1) 200
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			// 2) 400：越过软阈值 350，模型此时收尾 → run 结束 → driver 起新 run，
			//    由 before_run 注入软提示
			fauxAssistantMessage("我先停一下"),
			// 3) 600：模型接受提示后交卷
			fauxAssistantMessage([fauxToolCall("Deliver", { text: "页面正文" }, { id: "call_2" })]),
			// 4) 800：收尾
			fauxAssistantMessage("完成"),
		],
	});

	check("软提示注入前没有任何提示", !injectedAt(result, 0, soft) && !injectedAt(result, 1, soft), JSON.stringify(result.capturedUserTexts[1]));
	check("越过 70% 后由 before_run 注入软提示", injectedAt(result, 2, soft), JSON.stringify(result.capturedUserTexts[2]));
	check(
		"软提示以 user 消息进入上下文（随 checkpoint 落库）",
		result.capturedUserTexts[2]?.some((text) => text === soft) === true,
		JSON.stringify(result.capturedUserTexts[2]),
	);
	check("没有注入硬提示（预算尚未耗尽）", !injectedAt(result, 2, hard) && !injectedAt(result, 3, hard), "hard 未出现");
	check("目标工具已交卷 → success", result.subtype === "success", String(result.subtype));
	check("Deliver 工具真实执行", result.deliverCalls.includes("页面正文"), JSON.stringify(result.deliverCalls));
	check("共 4 次模型请求（2 工作 + 1 交卷 + 1 收尾）", result.callCount === 4, `callCount=${result.callCount}`);
}

// ---------------------------------------------------------------------------
// 场景 6：预算耗尽 + 模型仍不交卷 → before_tool 熔断 + 强制交卷 + error_budget_exhausted
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 6：预算耗尽 → before_tool 熔断 + before_run_end 强制交卷 → error_budget_exhausted");
{
	const hard = "【预算硬提示】立即交卷";
	const result = await runScenario({
		contextWindow: 200000,
		// 预算 300：第 2 次响应（400）即耗尽
		budget: { maxTokens: 300, forcedTurns: 1, notices: { soft: "【预算软提示】", hard }, outputTools: ["Deliver"] },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: makeUsage(150, 50),
		prompt: "开始",
		tools: [bigTool, deliverTool],
		responses: [
			// 1) 200
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			// 2) 400 → 耗尽；该次 tool call 会被 before_tool 熔断
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			// 3) 模型看到熔断原因后仍在 try to explore → may_finish 边界
			//     before_run_end 返回硬提示 followUp（强制交卷）
			fauxAssistantMessage("我还没写完"),
			// 4) 强制交卷轮：仍然不调用 Deliver → 终止
			fauxAssistantMessage("还是没有产物"),
		],
	});

	check("结果为 error_budget_exhausted", result.subtype === "error_budget_exhausted", String(result.subtype));
	check(
		"错误信息为可读文案（含累计 tokens / 预算）",
		result.errors?.[0]?.includes("Token budget exhausted") === true &&
			/\d+ \/ 300 tokens/.test(result.errors?.[0] ?? "") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("预算耗尽后的工具调用被熔断", result.toolNames.filter((name) => name === "Big").length === 2, JSON.stringify(result.toolNames));
	check(
		"熔断结果携带硬提示文案（模型可见）",
		result.toolOutputs.some((output) => output.includes(hard)) === true,
		JSON.stringify(result.toolOutputs.map((output) => output.slice(0, 40))),
	);
	check(
		"before_run_end 的强制交卷 followUp 进入第 4 次请求上下文",
		injectedAt(result, 3, hard),
		JSON.stringify(result.capturedUserTexts[3]),
	);
	check("目标工具从未执行（没有产物 → 编排层照旧判页失败）", result.deliverCalls.length === 0, JSON.stringify(result.deliverCalls));
	check("共 4 次模型请求（2 工作 + 1 被熔断 + 1 强制交卷）", result.callCount === 4, `callCount=${result.callCount}`);
	check("强制交卷轮用尽后不再请求", result.capturedUserTexts.length === 4, `${result.capturedUserTexts.length}`);
}

// ---------------------------------------------------------------------------
// 场景 6：预算耗尽前模型自行交卷 → success（不因预算被记失败）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 7：预算将尽但模型已交卷 → success");
{
	const result = await runScenario({
		contextWindow: 200000,
		budget: { maxTokens: 300, forcedTurns: 1, notices: { hard: "【预算硬提示】" }, outputTools: ["Deliver"] },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: makeUsage(150, 50),
		prompt: "开始",
		tools: [deliverTool],
		responses: [fauxAssistantMessage([fauxToolCall("Deliver", { text: "正文" }, { id: "call_1" })]), fauxAssistantMessage("完成")],
	});

	check("已交卷时预算耗尽不记失败", result.subtype === "success", String(result.subtype));
	check("Deliver 工具执行过", result.deliverCalls.includes("正文"), JSON.stringify(result.deliverCalls));
}

// ---------------------------------------------------------------------------
// 场景 8：不限制预算（maxTokens=0）→ 不注入提示、不因预算终止
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 8：未配置 token 预算（0）→ 不注入提示、不因预算终止");
{
	const notice = "【预算提示】";
	const result = await runScenario({
		contextWindow: 200000,
		budget: { maxTokens: 0, notices: { soft: notice, hard: notice } },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: makeUsage(100_000, 100_000),
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_3" })]),
			fauxAssistantMessage("全部完成"),
		],
	});

	check("不限制预算时不被预算打断", result.subtype === "success", String(result.subtype));
	check(
		"不限制预算时不注入任何提示",
		result.capturedUserTexts.every((texts) => texts.every((text) => !text.includes(notice))),
		JSON.stringify(result.capturedUserTexts),
	);
	check("3 个工作轮 + 输出轮 = 4 次请求", result.callCount === 4, `callCount=${result.callCount}`);
}

// ---------------------------------------------------------------------------
// 场景 9：usage 事件是权威来源（累计口径 = input+output+cache）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 9：usage 事件/ledger 提供权威累计用量");
{
	// 每次响应 200 input + 50 output + 50 cacheRead = 300 → 第 3 次即累计 900
	const result = await runScenario({
		contextWindow: 200000,
		budget: { maxTokens: 500, forcedTurns: 0, notices: { hard: "【预算硬提示】" }, outputTools: ["Deliver"] },
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		usage: { ...makeUsage(200, 50), cacheRead: 50 },
		prompt: "开始",
		tools: [bigTool, deliverTool],
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage("没有产物"),
		],
	});

	check("cacheRead 计入累计用量（900 > 500 → 耗尽）", result.subtype === "error_budget_exhausted", String(result.subtype));
	check(
		"错误信息里的累计 tokens 与 usage ledger 一致",
		result.errors?.[0]?.includes("900 / 500") === true,
		result.errors?.[0] ?? "(无)",
	);
	check("forcedTurns=0 时不再强制交卷/加段", result.callCount === 3, `callCount=${result.callCount}`);
}

// ---------------------------------------------------------------------------
// 场景 10：maxTurns 兼容折算（旧配置字段 → token 预算）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 10：maxTurns 折算成 token 预算");
{
	const derived = resolveBudgetOptions({ maxTurns: 30 });
	const unlimited = resolveBudgetOptions({ maxTurns: 0 });
	const explicit = resolveBudgetOptions({ maxTurns: 30, budget: { maxTokens: 1234 } });
	const fallback = resolveBudgetOptions({});

	check(`maxTurns=30 → ${30 * TOKENS_PER_TURN} tokens`, derived.maxTokens === 30 * TOKENS_PER_TURN, String(derived.maxTokens));
	check("maxTurns=0 → 不限制（0）", unlimited.maxTokens === 0, String(unlimited.maxTokens));
	check("显式 budget.maxTokens 优先", explicit.maxTokens === 1234, String(explicit.maxTokens));
	check(`未配置时按缺省 30 轮折算`, fallback.maxTokens === 30 * TOKENS_PER_TURN, String(fallback.maxTokens));
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
