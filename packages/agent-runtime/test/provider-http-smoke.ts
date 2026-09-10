/**
 * provider-http-smoke.ts —— createProvider（browse-chat / 一次性补全）冒烟测试
 *
 * 覆盖 apps/cli/src/commands/browse-chat.ts 依赖的 LLMProvider 契约：
 *   createProvider(providerId, { apiKey, baseURL }).createMessage({ model, maxTokens, system, messages })
 *   -> { content: [...], stopReason, usage }
 *
 * 运行：bun run packages/agent-runtime/test/provider-http-smoke.ts
 */

import { createProvider } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

let seenSystem = "";

function chunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { messages?: Array<{ role: string; content: string }> };
		seenSystem = String(body.messages?.find((message) => message.role === "system")?.content ?? "");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						chunk({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: { role: "assistant", content: "这篇文档讲的是会话持久化。" }, finish_reason: null }],
						}),
					),
				);
				controller.enqueue(
					encoder.encode(
						chunk({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						}),
					),
				);
				controller.enqueue(
					encoder.encode(
						chunk({
							id: "chatcmpl-mock",
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: "mock-model",
							choices: [],
							usage: { prompt_tokens: 88, completion_tokens: 12, total_tokens: 100 },
						}),
					),
				);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

const provider = createProvider("openai-compatible", {
	apiKey: "sk-mock",
	baseURL: `http://127.0.0.1:${server.port}/v1`,
});

console.log("▶ createProvider().createMessage() …");
const response = await provider.createMessage({
	model: "mock-model",
	maxTokens: 1200,
	system: "You are a documentation reading assistant.",
	messages: [
		{ role: "user", content: "这一页讲了什么？" },
		{ role: "assistant", content: "请具体一点。" },
		{ role: "user", content: "一句话总结。" },
	],
});
server.stop(true);

const text = response.content
	.filter((block): block is { type: "text"; text: string } => block.type === "text")
	.map((block) => block.text)
	.join("");

console.log("\n▶ 断言");
check("provider.apiType 为 openai-completions", provider.apiType === "openai-completions", provider.apiType);
check("返回文本内容", text.includes("会话持久化"), text);
check("stopReason 映射为 end_turn/stop 类取值", response.stopReason === "stop", String(response.stopReason));
check(
	"usage 映射为 input_tokens/output_tokens",
	response.usage.input_tokens === 88 && response.usage.output_tokens === 12,
	JSON.stringify(response.usage),
);
check("system 提示透传", seenSystem.includes("documentation reading assistant"), seenSystem.slice(0, 40));

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
