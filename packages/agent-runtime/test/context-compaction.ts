/**
 * context-compaction.ts —— 上下文压缩与优雅停止冒烟测试（离线、不调用外部 API）
 *
 * 验证点：
 *  1. 上下文逼近模型窗口时，适配层在 pi 的 transformContext 里调用
 *     prepareCompaction / compact 生成摘要，并发出 system/compact_boundary；
 *  2. 压缩后的下一次请求使用「摘要 + 保留的近期消息」，运行继续并最终 success；
 *  3. 压缩无法腾出空间（单个巨大 turn / 没有可总结内容）时，
 *     shouldStopAfterTurn 优雅停止，结果为 error_context_full（不让 provider 报溢出）；
 *  4. maxTurns 计数仍然生效（配置界面 agent.max_turns 的最终落点）：
 *     倒数第 1 轮注入收尾提示，超限后允许 1 轮宽限；仍不收敛才 error_max_turns；
 *     `finalization.graceTurns: 0` 可回到「到达上限立即停止」的旧行为；
 *  5. `maxTurns: 0` = 不限制轮次：不发收尾提示、不因轮次停止（仍受上下文/取消约束）。
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
	/** 每次请求里所有 user 消息的文本（用于断言收尾提示注入） */
	capturedUserTexts: string[][];
	callCount: number;
}

/**
 * 用 faux provider 跑一次 createAgent（注入 models 以便压缩也走 faux）。
 */
async function runScenario(options: {
	contextWindow: number;
	maxTurns?: number;
	compaction: { enabled?: boolean; reserveTokens: number; keepRecentTokens: number };
	finalization?: { graceTurns?: number; notice?: string };
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
	const capturedUserTexts: string[][] = [];
	const systemEvents: string[] = [];
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
		compaction: options.compaction,
		finalization: options.finalization,
		tools: [bigTool],
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
		capturedUserTexts,
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
			// 宽限轮仍然调用工具（不收敛）
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_3" })]),
		],
	});

	check("结果为 error_max_turns", result.subtype === "error_max_turns", String(result.subtype));
	check(
		"错误信息为可读文案（含 max turns）",
		result.errors?.[0]?.includes("Reached max turns") === true,
		result.errors?.join(" | ") ?? "(无)",
	);
	check("错误信息标注了宽限轮", result.errors?.[0]?.includes("+ 1 grace turn") === true, result.errors?.[0] ?? "(无)");
	check("maxTurns=2 + 1 轮宽限，共 3 个 turn", result.numTurns === 3, String(result.numTurns));
	check("发出 3 次模型请求（含宽限轮）", result.callCount === 3, `callCount=${result.callCount}`);
}

// ---------------------------------------------------------------------------
// 场景 5：收尾提示生效，模型在宽限轮直接输出 → success
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 5：倒数第 1 轮 + 宽限轮提示 → 模型直接输出，success");
{
	const notice = "【收尾提示】立即输出最终结果";
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 2,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		finalization: { notice },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage("已立即输出"),
		],
	});

	check("模型在宽限轮输出后结果为 success", result.subtype === "success", String(result.subtype));
	check("共 3 个 turn（2 个工作轮 + 1 收尾轮）", result.numTurns === 3, String(result.numTurns));
	check("第 1 次请求没有收尾提示", result.capturedUserTexts[0]?.every((text) => !text.includes(notice)) === true, JSON.stringify(result.capturedUserTexts[0]));
	check(
		"最后一轮请求注入了软提示",
		result.capturedUserTexts[1]?.some((text) => text.includes(notice)) === true,
		JSON.stringify(result.capturedUserTexts[1]),
	);
	check(
		"宽限轮请求再次注入提示（共 2 次）",
		result.capturedUserTexts[2]?.filter((text) => text.includes(notice)).length === 2,
		JSON.stringify(result.capturedUserTexts[2]),
	);
}

// ---------------------------------------------------------------------------
// 场景 6：graceTurns=0 → 保持旧行为（到达上限立即停止，仅软提示）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 6：graceTurns=0 → 到达上限立即停止（旧行为）");
{
	const notice = "【收尾提示】立即输出最终结果";
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 2,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		finalization: { graceTurns: 0, notice },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage("不应该到达这里"),
		],
	});

	check("graceTurns=0 仍为 error_max_turns", result.subtype === "error_max_turns", String(result.subtype));
	check("错误信息不标注宽限轮", result.errors?.[0]?.includes("grace turn") === false, result.errors?.[0] ?? "(无)");
	check("恰好 2 个 turn", result.numTurns === 2, String(result.numTurns));
	check("没有第 3 次请求", result.callCount === 2, `callCount=${result.callCount}`);
	check(
		"最后一轮仍注入软提示",
		result.capturedUserTexts[1]?.some((text) => text.includes(notice)) === true,
		JSON.stringify(result.capturedUserTexts[1]),
	);
}

// ---------------------------------------------------------------------------
// 场景 7：模型恰好在最后一轮给出最终答复 → success（不因到达上限被记失败）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 7：最后一轮直接输出 → success");
{
	const notice = "【收尾提示】立即输出最终结果";
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 2,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		finalization: { notice },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage("在最后一轮输出完成"),
		],
	});

	check("最后一轮输出后结果为 success", result.subtype === "success", String(result.subtype));
	check("恰好 2 个 turn（不触发宽限）", result.numTurns === 2, String(result.numTurns));
	check("只发出 2 次模型请求", result.callCount === 2, `callCount=${result.callCount}`);
	check(
		"软提示已在第 2 轮注入",
		result.capturedUserTexts[1]?.some((text) => text.includes(notice)) === true,
		JSON.stringify(result.capturedUserTexts[1]),
	);
}

// ---------------------------------------------------------------------------
// 场景 8：maxTurns=1 且一次到位 → success
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 8：maxTurns=1 一次到位 → success");
{
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 1,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		prompt: "开始",
		responses: [fauxAssistantMessage("一次输出完成")],
	});

	check("maxTurns=1 且无工具调用 → success", result.subtype === "success", String(result.subtype));
	check("恰好 1 个 turn", result.numTurns === 1, String(result.numTurns));
}

// ---------------------------------------------------------------------------
// 场景 9：maxTurns=0 → 不限制轮次（不发收尾提示、不因轮次停止）
// ---------------------------------------------------------------------------
console.log("\n▶ 场景 9：maxTurns=0 → 不限制轮次");
{
	const notice = "【收尾提示】立即输出最终结果";
	const result = await runScenario({
		contextWindow: 200000,
		maxTurns: 0,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
		finalization: { notice },
		prompt: "开始",
		responses: [
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_1" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_2" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_3" })]),
			fauxAssistantMessage([fauxToolCall("Big", { size: 10 }, { id: "call_4" })]),
			fauxAssistantMessage("全部完成"),
		],
	});

	check("0 轮 = 不限制：4 个工作轮后仍继续（共 5 次模型请求）", result.callCount === 5, `callCount=${result.callCount}`);
	check("不限制轮次时不被 error_max_turns 打断", result.subtype === "success", String(result.subtype));
	check("numTurns = 5（4 工作轮 + 1 输出轮）", result.numTurns === 5, String(result.numTurns));
	check(
		"不限制轮次时不注入收尾提示",
		result.capturedUserTexts.every((texts) => texts.every((text) => !text.includes(notice))),
		JSON.stringify(result.capturedUserTexts),
	);
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
