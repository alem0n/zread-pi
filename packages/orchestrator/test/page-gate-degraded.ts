/**
 * page-gate-degraded.ts —— 内容门 enforce 降级落盘端到端验证
 *
 * 场景（§3.1 / §5.1）：`quality.contentGate.mode = enforce` 时，模型持续产出干瘪内容、
 * 在 token 预算内无法通过内容门 → write_page 被 is_error 拦截、文件不落盘 →
 * 预算耗尽强制交卷后仍无产物 → generate-wiki 的 best-effort 分支把**最近一次被拦截的
 * 内容**写入约定路径并标记 `gate.mode = 'enforce-degraded'`，页面计为成功 + 告警。
 *
 * 这与 lecture-to-notes 的「OVERALL FAIL 不许交付」是**有意偏差**：
 * zread-pi 的哲学是「生成永不悬挂」，门判死也必须把产物交到用户手里。
 *
 * 运行：bun run packages/orchestrator/test/page-gate-degraded.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const home = await mkdtemp(join(tmpdir(), "zread-pi-gate-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-gate-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");

const wikiDir = join(repo, ".zread-pi", "wiki", "high");

/** 干瘪页面：永远产出低于散文下限的内容，enforce 模式必然拦截 */
const gatePage = {
	slug: "1-thin",
	title: "干瘪页",
	file: "1-thin.md",
	section: "工具函数",
	level: "Intermediate" as const,
	associatedFiles: ["src/a.ts"],
};

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

let requests = 0;
let writeCalls = 0;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requests += 1;
		const body = (await request.json()) as { messages?: Array<{ role?: string }> };
		const messages = body.messages ?? [];
		const hasToolResult = messages.some((message) => message.role === "tool");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));
				// 无论是否被拦截，模型都再次调用 write_page（内容始终干瘪），
				// 直至 token 预算耗尽、内核强制交卷。
				if (hasToolResult && writeCalls >= 4) {
					// 强制交卷轮：放弃工具，输出纯文字（仍无产物）
					write(chunk(baseChunk({ role: "assistant", content: "放弃交卷" }, null)));
					write(chunk(baseChunk({}, "stop")));
				} else {
					writeCalls += 1;
					write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											id: `call_${writeCalls}`,
											type: "function",
											function: {
												name: "write_page",
												arguments: JSON.stringify({
													slug: gatePage.slug,
													file: gatePage.file,
													section: gatePage.section,
													title: gatePage.title,
													content: "# 干瘪页\n\n太短了。\n\nSources: [a](src/a.ts)",
												}),
											},
										},
									],
								},
								"tool_calls",
							),
						),
					);
				}
				write(
					chunk({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [],
						usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
					}),
				);
				write("data: [DONE]\n\n");
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: zh",
		"doc_language: zh",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"agent:",
		"  token_budget: 200",
		// 内容门：enforce（未达标拦截；预算用尽后 best-effort 降级落盘）
		"quality:",
		"  contentGate:",
		"    enabled: true",
		"    mode: enforce",
		"concurrency:",
		"  max_concurrent: 1",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { generateWikiContent } = await import("../src/wiki/generate-wiki.js");

const events: string[] = [];
console.log("▶ generateWikiContent（enforce 内容门 + 干瘪内容）…");
const result = await generateWikiContent({
	pages: [gatePage],
	maxConcurrent: 1,
	onEvent: (event) => {
		events.push(`${event.type}:${event.slug}`);
	},
});

server.stop(true);

console.log("\n▶ 断言");

const target = join(wikiDir, gatePage.section, gatePage.file);
const pageResult = result.results.find((entry) => entry.slug === gatePage.slug);

// 降级落盘的核心断言
const landed = await readFile(target, "utf-8").catch(() => "");
check(
	"best-effort 落盘：被拦截的内容最终写回约定路径",
	landed.includes("太短了"),
	landed.slice(0, 40) || "(文件不存在)",
);
check(
	"降级文件带 gate 注释（标明未达标）",
	landed.includes("<!-- gate:") && landed.includes("散文篇幅不足"),
	landed.split("\n").find((line) => line.startsWith("<!-- gate:"))?.slice(0, 60) ?? "(无 gate 注释)",
);
check(
	"页面计为成功（不判页失败：生成永不悬挂）",
	pageResult?.success === true && result.completed === 1 && result.failed === 0,
	`completed=${result.completed} failed=${result.failed}`,
);
check(
	"PageResult.gate.mode = enforce-degraded",
	pageResult?.gate?.mode === "enforce-degraded",
	JSON.stringify(pageResult?.gate?.mode),
);
check(
	"PageResult.gate.passed = false（质量告警仍在）",
	pageResult?.gate?.passed === false,
	JSON.stringify(pageResult?.gate?.failures),
);
check(
	"降级文件的 frontmatter 被重建",
	landed.includes('title: "干瘪页"') && landed.includes('slug: "1-thin"'),
	landed.split("\n").slice(0, 4).join(" | "),
);
check(
	"发出的是 page_complete 而非 page_error（降级不计失败）",
	events.includes(`page_complete:${gatePage.slug}`) && !events.includes(`page_error:${gatePage.slug}`),
	events.join(","),
);
check("模型确实多次尝试被拦截（>=4 次 write_page）", writeCalls >= 4, `writeCalls=${writeCalls}`);

process.chdir(join(repo, ".."));
await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
