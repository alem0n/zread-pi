/**
 * e2e-page-generation.ts —— 并行页面生成端到端验证（多 Agent + p-limit + write_page 工具）
 *
 * 链路：generateWikiContent({ pages, maxConcurrent: 3 })
 *   -> 每个页面一个独立 Agent（业务并发模型未改动）
 *   -> @open-zread/agent-runtime 适配层 -> pi Agent 循环
 *   -> mock LLM 返回 write_page 工具调用
 *   -> 真实工具执行：写出 .open-zread/wiki/<section>/<file>
 *
 * 运行：bun run packages/orchestrator/test/e2e-page-generation.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const home = await mkdtemp(join(tmpdir(), "open-zread-home-"));
const repo = await mkdtemp(join(tmpdir(), "open-zread-repo-"));
await mkdir(join(home, ".zread"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");

// ---------------------------------------------------------------------------
// mock LLM：对每个页面 Agent 返回一次 write_page 工具调用，再返回收尾文本
// ---------------------------------------------------------------------------

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

const pages = [
	{ slug: "1-overview", title: "概览", file: "1-overview.md", section: "入门指南", level: "Beginner" },
	{ slug: "2-arch", title: "架构", file: "2-arch.md", section: "入门指南", level: "Intermediate" },
	{ slug: "3-api", title: "接口", file: "3-api.md", section: "参考", level: "Advanced" },
];

/** 故意写入非法 Mermaid（节点标签含括号但未加引号），用于验证 WritePageTool 内置校验与错误隔离 */
const badPage = {
	slug: "4-bad-mermaid",
	title: "非法图表",
	file: "4-bad-mermaid.md",
	section: "参考",
	level: "Advanced",
};
const badPageContent = ["# 非法图表", "", "```mermaid", "flowchart TB", "  A[用户(输入)] --> B[结果]", "```", ""].join("\n");

let requests = 0;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requests += 1;
		const body = (await request.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
		const messages = body.messages ?? [];
		const hasToolResult = messages.some((message) => message.role === "tool");
		const promptText = JSON.stringify(messages.find((message) => message.role === "user")?.content ?? "");
		const isBadPage = promptText.includes(badPage.slug);
		const page =
			(pages.find((candidate) => promptText.includes(candidate.slug)) ?? pages[0]) as (typeof pages)[number] | typeof badPage;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));
				if (!hasToolResult) {
					write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											id: `call_${page.slug}`,
											type: "function",
											function: {
												name: "write_page",
												arguments: JSON.stringify({
													slug: page.slug,
													file: page.file,
													section: page.section,
													title: page.title,
													content: isBadPage ? badPageContent : `# ${page.title}\n\n由 pi 驱动生成。\n`,
												}),
											},
										},
									],
								},
								"tool_calls",
							),
						),
					);
				} else {
					write(chunk(baseChunk({ role: "assistant", content: `${page.title} 完成` }, null)));
					write(chunk(baseChunk({}, "stop")));
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
	join(home, ".zread", "config.yaml"),
	[
		"language: en",
		"doc_language: en",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"concurrency:",
		"  max_concurrent: 3",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { generateWikiContent } = await import("../src/wiki/generate-wiki.js");

const progress: string[] = [];
console.log("▶ generateWikiContent({ maxConcurrent: 3 }) …");
const result = await generateWikiContent({
	pages: [...pages, badPage],
	maxConcurrent: 3,
	onProgress: (state) => {
		progress.push(`${state.completed}/${state.total}`);
	},
});

server.stop(true);

console.log("\n▶ 断言");
const files = [
	join(repo, ".open-zread", "wiki", "入门指南", "1-overview.md"),
	join(repo, ".open-zread", "wiki", "入门指南", "2-arch.md"),
	join(repo, ".open-zread", "wiki", "参考", "3-api.md"),
];
const contents = await Promise.all(files.map((file) => readFile(file, "utf-8").catch(() => "")));
check(
	"三个正常页面都被真实写出（按 section 分目录）",
	contents.every((content) => content.includes("由 pi 驱动生成")),
	contents.map((content) => content.slice(0, 18)).join(" | "),
);
check("frontmatter 标题被写入", contents[0].includes('title: "概览"'), contents[0].split("\n")[1] ?? "");
check("并发任务全部成功", result.completed === 4 && result.failed === 0, `completed=${result.completed} failed=${result.failed}`);
check(
	"非法 Mermaid 被 WritePageTool 拦截：页面未落盘，其它页面不受影响",
	(await readFile(join(repo, ".open-zread", "wiki", "参考", "4-bad-mermaid.md"), "utf-8").catch(() => "")) === "" &&
		contents.every((content) => content.includes("由 pi 驱动生成")),
	`badPageWritten=${(await readFile(join(repo, ".open-zread", "wiki", "参考", "4-bad-mermaid.md"), "utf-8").catch(() => "")) !== ""}`,
);
check("进度回调被触发", progress.length >= 1, progress.join(","));
check("每个页面都发生了真实模型调用（>=8 次请求）", requests >= 8, `requests=${requests}`);

process.chdir(join(repo, ".."));
await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
