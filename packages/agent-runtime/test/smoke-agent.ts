/**
 * smoke-agent.ts —— 适配层端到端冒烟测试（离线、不调用任何外部 API）
 *
 * 验证点：
 *  1. pi Agent 循环可被 createAgent 驱动，事件被正确映射为 SDKMessage；
 *  2. 工具（FileWriteTool）真的被执行，文件落盘；
 *  3. PreToolUse / PostToolUse 钩子被触发（Orchestrator 的 UI 进度就依赖它们）；
 *  4. 用量（usage）从 pi 映射回 TokenUsage；
 *  5. 流级重试：首次 429 错误 -> onRetry 回调 -> 第二次成功；
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
import { createAgent, FileReadTool, FileWriteTool, type SDKMessage } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const faux = fauxProvider({ tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel("faux-model") ?? faux.models[0];

const workdir = await mkdtemp(join(tmpdir(), "open-zread-smoke-"));
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
check("模型答复文本可见", assistantTexts.some((text) => text.includes("已写入")), assistantTexts.join("|"));

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
