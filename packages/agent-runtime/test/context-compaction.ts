/**
 * context-compaction.ts —— 上下文压缩与优雅停止冒烟测试（离线、不调用外部 API）
 *
 * 验证点：
 *  1. 上下文逼近模型窗口时，适配层在 pi 的 transformContext 里调用
 *     prepareCompaction / compact 生成摘要，并发出 system/compact_boundary；
 *  2. 压缩后的下一次请求使用「摘要 + 保留的近期消息」，运行继续并最终 success；
 *  3. 压缩无法腾出空间（单个巨大 turn / 没有可总结内容）时，
 *     shouldStopAfterTurn 优雅停止，结果为 error_context_full（不让 provider 报溢出）；
 *  4. maxTurns 计数仍然生效（配置界面 agent.max_turns 的最终落点）。
 *
 * 运行：bun run test:context
 */

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgent, defineTool, type SDKMessage, type ToolDefinition } from "../src/index.js";

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

/** 单个测试场景的公共返回值 */
interface ScenarioResult {
	subtype: string | undefined;
	numTurns: number | undefined;
	errors: string[] | undefined;
	systemEvents: string[];
	capturedRequestMessages: number[];
	capturedFirstUserTexts: string[];
	callCount: number;
}

/**
 * 用 faux provider 跑一次 createAgent（注入 models 以便压缩也走 faux）。
 */
async function runScenario(options: {
	contextWindow: number;
	maxTurns?: number;
	compaction: { enabled?: boolean; reserveTokens: number; keepRecentTokens: number };
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];
	prompt: string;
}): Promise<ScenarioResult> {
	const faux = fauxProvider({
		tokensPerSecond: 0,
		models: [{ id: "faux-model", contextWindow: options.contextWindow, maxTokens: 512 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel("faux-model") ?? faux.models[0];
	faux.setResponses(options.responses);

	const capturedRequestMessages: number[] = [];
	const capturedFirstUserTexts: string[] = [];
	const systemEvents: string[] = [];
	let subtype: string | undefined;
	let numTurns: number | undefined;
	let errors: string[] | undefined;

	const agent = createAgent({
		model: String(model.id),
		systemPrompt: "sys",
		maxTurns: options.maxTurns,
		compaction: options.compaction,
		tools: [bigTool],
		includePartialMessages: false,
		runtimeOverride: {
			model,
			models,
			streamFn: (streamModel, context, streamOptions) => {
				capturedRequestMessages.push(context.messages.length);
				const first = context.messages[0];
				if (first && first.role === "user") {
					const text = Array.isArray(first.content)
						? first.content
								.map((block) => (block.type === "text" ? block.text : ""))
								.join("")
						: String(first.content);
					capturedFirstUserTexts.push(text);
				}
				return models.streamSimple(streamModel, context, streamOptions);
			},
		},
	});

	for await (const event of agent.query(options.prompt) as AsyncIterable<SDKMessage>) {
		if (event.type === "system") systemEvents.push(event.subtype);
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
		callCount: faux.state.callCount,
	};
}

// ---------------------------------------------------------------------------
// 场景 1：压缩成功，运行继续
// ---------------------------------------------------------------------------
console.log("▶ 场景 1：上下文将满 → pi compaction 摘要 → 继续运行");
{
	const result = await runScenario({
		contextWindow: 4000,
		maxTurns: 8,
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

	check("发出 system/compact_boundary 事件", result.systemEvents.includes("compact_boundary"), result.systemEvents.join(","));
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
		result.capturedFirstUserTexts[3]?.includes("【压缩摘要】") === true,
		result.capturedFirstUserTexts[3]?.slice(0, 60) ?? "(无)",
	);

	check("压缩后继续完成第 4 个 turn", result.numTurns === 4, String(result.numTurns));
}

// ---------------------------------------------------------------------------
// 场景 2：单个巨大 turn，压缩无法腾出空间 → 优雅停止
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 2：压缩无法腾出空间 → shouldStopAfterTurn 优雅停止");
{
	const result = await runScenario({
		contextWindow: 1200,
		maxTurns: 8,
		compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1600 },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_1" })]),
			// 不应该再被消费
			fauxAssistantMessage("不应该到达这里"),
		],
	});

	check("结果为 error_context_full", result.subtype === "error_context_full", String(result.subtype));
	check(
		"错误信息包含上下文用量",
		result.errors?.[0]?.includes("Context window nearly full") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("没有发生压缩（只有 1 次模型调用）", result.callCount === 1, `callCount=${result.callCount}`);
	check("没有 compact_boundary 事件", !result.systemEvents.includes("compact_boundary"), result.systemEvents.join(","));
	check("只执行了 1 个 turn", result.numTurns === 1, String(result.numTurns));
}

// ---------------------------------------------------------------------------
// 场景 3：显式关闭压缩 → 上下文将满时同样优雅停止
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 3：compaction.enabled=false → 上下文将满时优雅停止");
{
	const result = await runScenario({
		contextWindow: 1200,
		maxTurns: 8,
		compaction: { enabled: false, reserveTokens: 200, keepRecentTokens: 1600 },
		prompt: "开始",
		responses: [fauxAssistantMessage([fauxToolCall("Big", { size: BIG_PAYLOAD_CHARS }, { id: "call_1" })])],
	});

	check("关闭压缩后仍为 error_context_full", result.subtype === "error_context_full", String(result.subtype));
	check("关闭压缩时没有摘要请求", result.callCount === 1, `callCount=${result.callCount}`);
}

// ---------------------------------------------------------------------------
// 场景 4：maxTurns 计数（agent.max_turns 的运行时落点）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 4：maxTurns 到达上限 → error_max_turns");
{
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 2,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage("不应该到达这里"),
		],
	});

	check("结果为 error_max_turns", result.subtype === "error_max_turns", String(result.subtype));
	check(
		"错误信息为可读文案（含 max turns）",
		result.errors?.[0]?.includes("Reached max turns") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("恰好执行 maxTurns=2 个 turn", result.numTurns === 2, String(result.numTurns));
	check("只发出 2 次模型请求", result.callCount === 2, `callCount=${result.callCount}`);
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
