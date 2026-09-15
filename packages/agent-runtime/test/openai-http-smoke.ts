/**
 * openai-http-smoke.ts —— 真实 HTTP 协议路径冒烟测试（本地 mock OpenAI 兼容服务）
 *
 * 与 faux 测试互补：faux 绕过协议层，本测试验证
 *   createRuntimeModel -> pi-ai openai-completions adapter -> 真实 fetch/SSE 解析
 * 这条生产链路，包括：
 *   - baseURL 注入（打到本地 mock 服务）
 *   - apiKey 注入（Authorization: Bearer）
 *   - 流式 tool_call 解析 → 工具执行 → 第二轮请求 → 最终文本
 *   - **Provider 层重试：429 + Retry-After 被尊重**（而不是退化到 agent 层退避）
 *   - Retry-After 超过 maxRetryDelayMs 时立即失败，错误文本可识别
 *
 * 运行：bun run packages/agent-runtime/test/openai-http-smoke.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, FileWriteTool, type SDKMessage } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const workdir = await mkdtemp(join(tmpdir(), "zread-pi-http-smoke-"));
const targetFile = join(workdir, "http-out.md").replace(/\\/g, "/");
const seenAuth: string[] = [];
const seenBodies: Array<Record<string, unknown>> = [];
/** 下一次请求是否回 429（用于 Retry-After 断言） */
let rateLimitPending: string | undefined;
const requestStartTimes: number[] = [];

function chunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function baseChunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
	return {
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "mock-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (!url.pathname.endsWith("/chat/completions")) {
			return new Response("not found", { status: 404 });
		}
		seenAuth.push(request.headers.get("authorization") ?? "");
		requestStartTimes.push(Date.now());
		// Retry-After 断言：开关打开时先回一次 429（带服务端要求的等待秒数）
		if (rateLimitPending !== undefined) {
			const retryAfter = rateLimitPending;
			rateLimitPending = undefined;
			return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": retryAfter },
			});
		}
		const body = (await request.json()) as Record<string, unknown>;
		seenBodies.push(body);

		const messages = (body.messages ?? []) as Array<{ role?: string }>;
		const hasToolResult = messages.some((message) => message.role === "tool");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					// 第一次：流式返回一个 tool_call（参数分两片，模拟真实增量）
					write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											id: "call_mock_1",
											type: "function",
											function: { name: "write", arguments: '{"path":' },
										},
									],
								},
								null,
							),
						),
					);
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											function: { arguments: `${JSON.stringify(targetFile)},` },
										},
									],
								},
								null,
							),
						),
					);
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											function: { arguments: '"content":"# via http\\n"}' },
										},
									],
								},
								null,
							),
						),
					);
					write(chunk(baseChunk({}, "tool_calls")));
				} else {
					// 第二次：返回最终文本
					write(chunk(baseChunk({ role: "assistant", content: "已通过 HTTP 完成" }, null)));
					write(chunk(baseChunk({}, "stop")));
				}

				write(
					chunk({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [],
						usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
					}),
				);
				write("data: [DONE]\n\n");
				controller.close();
			},
		});

		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	},
});

const baseURL = `http://127.0.0.1:${server.port}/v1`;

const events: string[] = [];
let resultSubtype: string | undefined;
let usage: { input_tokens: number; output_tokens: number } | undefined;
const assistantUsages: Array<{ input_tokens: number; output_tokens: number }> = [];

const agent = createAgent({
	providerId: "openai-compatible",
	model: "mock-model",
	apiKey: "sk-mock-key",
	baseURL,
	cwd: workdir,
	systemPrompt: "测试",
	maxTurns: 5,
	tools: [FileWriteTool],
	hooks: {
		PreToolUse: [{ hooks: [async () => {}] }],
	},
});

console.log("▶ 通过本地 mock OpenAI 服务运行 createAgent().query() …");
for await (const event of agent.query("写文件")) {
	const message = event as SDKMessage;
	events.push(message.type === "system" ? `system/${message.subtype}` : message.type);
	if (message.type === "assistant" && message.usage) {
		assistantUsages.push({
			input_tokens: message.usage.input_tokens,
			output_tokens: message.usage.output_tokens,
		});
	}
	if (message.type === "result") {
		resultSubtype = message.subtype;
		usage = message.usage ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } : undefined;
	}
}
await agent.close();

// 阶段 1 快照：后续 Retry-After 用例会往同一个 mock 服务发更多请求
const phase1BodyCount = seenBodies.length;

// ---------------------------------------------------------------------------
// 第二阶段：Provider 层重试（429 + Retry-After）
// ---------------------------------------------------------------------------
console.log("\n▶ Provider 层重试：服务端 Retry-After 被尊重（不发 agent 层退避）");

rateLimitPending = "0.05"; // 50ms，远小于 agent 层 baseDelayMs 的 5s
requestStartTimes.length = 0;
const retryAgent = createAgent({
	providerId: "openai-compatible",
	model: "mock-model",
	apiKey: "sk-mock-key",
	baseURL,
	cwd: workdir,
	systemPrompt: "测试",
	tools: [FileWriteTool],
	retryConfig: {
		maxRetries: 1,
		baseDelayMs: 5000, // 若不走 Provider 层，agent 层会等 5 秒（断言可区分）
		maxDelayMs: 5000,
		retryableStatusCodes: [429],
		provider: { maxRetries: 1, maxRetryDelayMs: 60_000 },
	},
});
const retryStartedAt = Date.now();
let retrySubtype: string | undefined;
for await (const event of retryAgent.query("写文件")) {
	if (event.type === "result") retrySubtype = (event as { subtype?: string }).subtype;
}
const retryElapsedMs = Date.now() - retryStartedAt;
await retryAgent.close();

check(
	"429 触发 Provider 层重试（多了一次请求）",
	requestStartTimes.length === 3,
	`requests=${requestStartTimes.length}`,
);
check(
	"重试等待按 Retry-After（~50ms），而不是 agent 层 5s 退避",
	requestStartTimes.length === 3 && requestStartTimes[1]! - requestStartTimes[0]! < 1000,
	`gap=${requestStartTimes.length === 3 ? requestStartTimes[1]! - requestStartTimes[0]! : -1}ms elapsed=${retryElapsedMs}ms`,
);
check("Retry-After 重试后任务成功", retrySubtype === "success", String(retrySubtype));

// ---------------------------------------------------------------------------
// 第三阶段：Retry-After 超过 maxRetryDelayMs → 立即失败（错误可直接识别）
// ---------------------------------------------------------------------------
console.log("\n▶ Retry-After 超过上限：立即失败且错误可识别");

rateLimitPending = "120"; // 120s，超过 maxRetryDelayMs=1s
const cappedAgent = createAgent({
	providerId: "openai-compatible",
	model: "mock-model",
	apiKey: "sk-mock-key",
	baseURL,
	cwd: workdir,
	systemPrompt: "测试",
	tools: [FileWriteTool],
	retryConfig: {
		maxRetries: 0, // 关掉 agent 层重试，只看 Provider 层行为
		baseDelayMs: 1,
		maxDelayMs: 1,
		retryableStatusCodes: [429],
		provider: { maxRetries: 3, maxRetryDelayMs: 1000 },
	},
});
let cappedSubtype: string | undefined;
let cappedErrors: string[] | undefined;
for await (const event of cappedAgent.query("写文件")) {
	if (event.type === "result") {
		cappedSubtype = (event as { subtype?: string }).subtype;
		cappedErrors = (event as { errors?: string[] }).errors;
	}
}
await cappedAgent.close();

check(
	"超上限的 Retry-After 不被重试，失败文本含 retry delay",
	cappedSubtype === "error_during_execution" &&
		(cappedErrors ?? []).some((message) => /retry delay/i.test(message)),
	`${String(cappedSubtype)} · ${(cappedErrors ?? []).join(" | ")}`,
);

server.stop(true);

console.log("\n▶ 断言");
check("命中本地 mock 服务两次（工具调用 + 后续答复）", phase1BodyCount === 2, `requests=${phase1BodyCount}`);
check("apiKey 以 Authorization: Bearer 注入", seenAuth.every((value) => value === "Bearer sk-mock-key"), seenAuth.join("|"));
check("请求体带 model 与 stream:true", seenBodies[0]?.model === "mock-model" && seenBodies[0]?.stream === true);
check("工具被真实执行并写入文件", (await readFile(targetFile, "utf-8").catch(() => "")) === "# via http\n");
check("tool_result 事件已映射", events.includes("tool_result"), events.join(","));
check("最终结果为 success", resultSubtype === "success", String(resultSubtype));
check(
	"每次 assistant 事件的 usage 来自该次 HTTP 分片",
	assistantUsages.length === 2 && assistantUsages.every((entry) => entry.input_tokens === 42 && entry.output_tokens === 7),
	JSON.stringify(assistantUsages),
);
check(
	"result.usage 是 harness usage ledger 的累计值（2 次请求 × 42/7）",
	usage?.input_tokens === 84 && usage?.output_tokens === 14,
	JSON.stringify(usage),
);

await rm(workdir, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
