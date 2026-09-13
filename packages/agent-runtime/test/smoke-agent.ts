/**
 * smoke-agent.ts —— 适配层端到端冒烟测试（离线、不调用任何外部 API）
 *
 * 验证点：
 *  1. pi Agent 循环可被 createAgent 驱动，事件被正确映射为 SDKMessage；
 *  2. 工具（FileWriteTool）真的被执行，文件落盘；
 *  3. PreToolUse / PostToolUse 钩子被触发（Orchestrator 的 UI 进度就依赖它们）；
 *  4. 用量（usage）从 pi 映射回 TokenUsage；
 *  5. 流级重试：首次 429 错误 -> onRetry 回调 -> 第二次成功；
 *  5b. Provider 层重试配置透传（streamOptions.maxRetries / maxRetryDelayMs）
 *      与 toRetryPolicy / toStreamOptions 的纯函数映射；
 *  6. 最终 SDKResultMessage.subtype === 'success'。
 *
 * 运行：bun run tools/smoke-agent.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgent, FileReadTool, FileWriteTool, toRetryPolicy, toStreamOptions, addTokenUsage, emptyTokenUsage, sumTokenUsage, type SDKMessage } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const faux = fauxProvider({ tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel("faux-model") ?? faux.models[0];

const workdir = await mkdtemp(join(tmpdir(), "zread-pi-smoke-"));
const targetFile = join(workdir, "out.md");

faux.setResponses([
	// 第 1 次：可重试的 429 错误（无内容）→ 触发流级重试
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
	// 第 2 次：要求调用 Write 工具
	fauxAssistantMessage([fauxToolCall("Write", { file_path: targetFile, content: "# hello pi\n" }, { id: "call_1" })]),
	// 第 3 次：给最终答复
	fauxAssistantMessage("已写入 out.md"),
]);

const hookLog: string[] = [];
const retryLog: string[] = [];
const events: string[] = [];
let assistantTexts: string[] = [];
let finalUsage: { input_tokens: number; output_tokens: number } | undefined;
let resultSubtype: string | undefined;
let capturedReasoning: SimpleStreamOptions["reasoning"];
let capturedMaxRetries: number | undefined;
let capturedMaxRetryDelayMs: number | undefined;

const agent = createAgent({
	model: String(model.id),
	cwd: workdir,
	systemPrompt: "你是测试代理",
	maxTurns: 5,
	tools: [FileWriteTool, FileReadTool],
	includePartialMessages: true,
	// pi 思考深度：应作为 reasoning 传到 streamFn（pi-ai 在适配器内按模型能力 clamp）
	thinkingLevel: "high",
	runtimeOverride: {
		model,
		streamFn: (m, c, o) => {
			capturedReasoning = o?.reasoning;
			capturedMaxRetries = o?.maxRetries;
			capturedMaxRetryDelayMs = o?.maxRetryDelayMs;
			return models.streamSimple(m, c, o);
		},
	},
	hooks: {
		PreToolUse: [
			{
				hooks: [
					async (input: Record<string, unknown>) => {
						hookLog.push(`pre:${String(input.toolName)}`);
					},
				],
			},
		],
		PostToolUse: [
			{
				hooks: [
					async (input: Record<string, unknown>) => {
						hookLog.push(`post:${String(input.toolName)}`);
					},
				],
			},
		],
	},
	retryConfig: {
		maxRetries: 3,
		baseDelayMs: 5,
		maxDelayMs: 5,
		retryableStatusCodes: [429, 500, 503],
		// Provider 层重试：应透传为 harness streamOptions（pi-ai 读 Retry-After 的开关）
		provider: { maxRetries: 2, maxRetryDelayMs: 60_000 },
		onRetry: (info) => retryLog.push(`retry#${info.attempt}:${info.error.slice(0, 24)}`),
	},
});

console.log("▶ 运行 createAgent().query() …");
for await (const event of agent.query("把结果写入文件")) {
	const message = event as SDKMessage;
	events.push(message.type === "system" ? `system/${message.subtype}` : message.type);

	if (message.type === "assistant") {
		assistantTexts = message.message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text);
		if (message.usage) {
			finalUsage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
		}
	}
	if (message.type === "result") {
		resultSubtype = message.subtype;
		if (message.usage) {
			finalUsage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
		}
	}
}
await agent.close();

console.log("\n▶ 断言");
check("收到 system/init 事件", events.includes("system/init"));
check("收到 partial_message 流式事件", events.includes("partial_message"));
check("收到 tool_result 事件", events.includes("tool_result"));
check("PreToolUse 钩子被触发", hookLog.includes("pre:Write"), hookLog.join(","));
check("PostToolUse 钩子被触发", hookLog.includes("post:Write"), hookLog.join(","));
check("流级重试被触发（429）", retryLog.length === 1, retryLog.join(","));
check("最终结果为 success", resultSubtype === "success", String(resultSubtype));
check("usage 已从 pi 映射回 TokenUsage", finalUsage !== undefined, JSON.stringify(finalUsage));
check("thinkingLevel 作为 reasoning 传入 streamFn", capturedReasoning === "high", String(capturedReasoning));
check(
	"provider 层重试配置透传为 streamOptions.maxRetries",
	capturedMaxRetries === 2,
	String(capturedMaxRetries),
);
check(
	"provider 层重试上限透传为 streamOptions.maxRetryDelayMs",
	capturedMaxRetryDelayMs === 60_000,
	String(capturedMaxRetryDelayMs),
);
check("模型答复文本可见", assistantTexts.some((text) => text.includes("已写入")), assistantTexts.join("|"));

// 纯函数：RetryConfig → pi 的 RetryPolicy / streamOptions（不依赖运行）
const noRetry = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, retryableStatusCodes: [] };
check(
	"toRetryPolicy：maxRetries=0 显式禁用（不回退 harness 默认 3 次）",
	JSON.stringify(toRetryPolicy(noRetry)) === JSON.stringify({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
	JSON.stringify(toRetryPolicy(noRetry)),
);
check(
	"toRetryPolicy：指数退避参数按 pi 口径映射（maxAgentDelayMs）",
	JSON.stringify(toRetryPolicy({ maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60_000, retryableStatusCodes: [] })) ===
		JSON.stringify({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 }),
);
check(
	"toStreamOptions：未配置 provider 重试时返回 undefined",
	toStreamOptions({ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, retryableStatusCodes: [] }) === undefined,
);
check(
	"toStreamOptions：缺省补 60s 的服务端等待上限",
	JSON.stringify(toStreamOptions({
		maxRetries: 3,
		baseDelayMs: 1,
		maxDelayMs: 1,
		retryableStatusCodes: [],
		provider: { maxRetries: 2 },
	})) === JSON.stringify({ maxRetries: 2, maxRetryDelayMs: 60_000 }),
);

// 纯函数：TokenUsage 归并（每页累计 / 跨 Agent 合计共用，缺失缓存字段按 0）
const merged = addTokenUsage(
	{ input_tokens: 10, output_tokens: 2 },
	{ input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5 },
);
check(
	"addTokenUsage：逐字段相加，缓存字段缺失按 0",
	JSON.stringify(merged) ===
		JSON.stringify({ input_tokens: 30, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 }),
	JSON.stringify(merged),
);
const summed = sumTokenUsage([undefined, { input_tokens: 1, output_tokens: 1 }, undefined]);
check(
	"sumTokenUsage：跳过未上报的 undefined，空集合归零",
	JSON.stringify(sumTokenUsage([])) === JSON.stringify(emptyTokenUsage()) &&
		JSON.stringify(summed) ===
			JSON.stringify({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
	`empty=${JSON.stringify(sumTokenUsage([]))} summed=${JSON.stringify(summed)}`,
);

let fileContent = "";
try {
	fileContent = await readFile(targetFile, "utf-8");
} catch {
	fileContent = "";
}
check("工具真实写入了文件", fileContent === "# hello pi\n", JSON.stringify(fileContent));

await rm(workdir, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
