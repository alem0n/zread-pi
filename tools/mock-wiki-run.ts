/**
 * mock-wiki-run.ts —— 离线全链路试跑：用本地 mock LLM 对任意目标仓库跑一遍
 * 「蓝图生成 -> 并行页面生成」，不需要任何真实 API Key。
 *
 * 用途：验证流水线是否正常（扫描/AST/工具落盘/事件/并发），或在没有额度时做回归。
 * 真实模型请用 `bun run cli`（读 ~/.zread/config.yaml）。
 *
 * 运行：bun run mock:wiki                     # 默认跑内置夹具 fixtures/hello-python
 *       bun run mock:wiki path/to/any/repo     # 也可指向任意目标仓库
 */

import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname, basename } from "node:path";

// ---------------------------------------------------------------------------
// 0) 目标仓库
// ---------------------------------------------------------------------------

const target = resolve(process.argv[2] ?? "./fixtures/hello-python");
if (!(await stat(target).catch(() => null))?.isDirectory()) {
	console.error(`目标目录不存在: ${target}`);
	process.exit(1);
}

const SOURCE_EXT = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".md"]);
const entries = (await readdir(target, { recursive: true, withFileTypes: true }))
	.filter((entry) => entry.isFile())
	.map((entry) => join(entry.parentPath ?? target, entry.name).slice(target.length + 1).replace(/\\/g, "/"))
	.filter((relative) => SOURCE_EXT.has(extname(relative)) && !relative.startsWith("."));

const slugify = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "page";

const pages = entries.slice(0, 5).map((relative, index) => ({
	slug: `${index + 1}-${slugify(basename(relative, extname(relative)))}`,
	title: basename(relative),
	file: `${index + 1}-${slugify(basename(relative, extname(relative)))}.md`,
	section: "模块",
	level: "Beginner",
	associatedFiles: [relative],
}));

if (pages.length === 0) {
	console.error(`目标目录没有可扫描的源文件: ${target}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 1) mock LLM（OpenAI 兼容）
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
function toolCall(id: string, name: string, args: unknown): string {
	return (
		chunk(baseChunk({ role: "assistant", content: "" }, null)) +
		chunk(
			baseChunk(
				{ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
				"tool_calls",
			),
		)
	);
}
function textChunk(text: string): string {
	return chunk(baseChunk({ role: "assistant", content: text }, null)) + chunk(baseChunk({}, "stop"));
}
const usageChunk = JSON.stringify({
	id: "chatcmpl-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model: "mock-model",
	choices: [],
	usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
});

let requestCount = 0;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requestCount += 1;
		const body = (await request.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
		const messages = body.messages ?? [];
		const prompt = JSON.stringify(messages.map((message) => message.content ?? ""));
		const hasToolResult = messages.some((message) => message.role === "tool");
		const isPageAgent = prompt.includes("当前页面任务");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));
				if (!hasToolResult) {
					if (isPageAgent) {
						const slug = /\*\*Slug\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? pages[0].slug;
						const page = pages.find((candidate) => candidate.slug === slug) ?? pages[0];
						const title = /\*\*标题\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? page.title;
						write(
							toolCall(`call_${page.slug}`, "write_page", {
								slug: page.slug,
								file: page.file,
								section: page.section,
								title,
								content: [
									`# ${title}`,
									"",
									`> 由 mock LLM 生成（离线试跑），真实内容请用 \`bun run cli\`。`,
									"",
									"```mermaid",
									"flowchart TB",
									`  A["${page.title}"] --> B["测试通过"]`,
									"```",
									"",
								].join("\n"),
							}),
						);
					} else {
						write(
							toolCall("call_blueprint", "generate_blueprint", {
								pages,
								techStackSummary: { 语言: "见目标仓库", 说明: "mock LLM 离线试跑" },
							}),
						);
					}
				} else {
					write(textChunk(isPageAgent ? "页面完成" : "蓝图完成"));
				}
				write(chunk(JSON.parse(usageChunk)));
				write("data: [DONE]\n\n");
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

// ---------------------------------------------------------------------------
// 2) 临时 HOME（~/.zread/config.yaml 指向 mock）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "open-zread-mock-home-"));
await mkdir(join(home, ".zread"), { recursive: true });
await writeFile(
	join(home, ".zread", "config.yaml"),
	[
		"language: zh",
		"doc_language: zh",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"concurrency:",
		"  max_concurrent: 3",
		"  max_retries: 1",
		"",
	].join("\n"),
	"utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(target);

const { generateWikiCatalog } = await import("../packages/orchestrator/src/orchestrator.js");
const { generateWikiContent } = await import("../packages/orchestrator/src/wiki/generate-wiki.js");

// ---------------------------------------------------------------------------
// 3) 跑流水线
// ---------------------------------------------------------------------------

console.log(`▶ 目标仓库: ${target}`);
console.log(`▶ 扫描到源文件: ${entries.length}，规划页面: ${pages.length}`);

const catalogEvents: string[] = [];
const catalog = await generateWikiCatalog((event) => catalogEvents.push(event.type));
console.log(`▶ 蓝图完成: ${catalog.durationMs}ms, usage=${JSON.stringify(catalog.tokenUsage)}`);
console.log(`  CatalogEvent: ${catalogEvents.join(",")}`);

const result = await generateWikiContent({
	maxConcurrent: 3,
	onProgress: (state) => {
		if (state.completed === state.total) console.log(`▶ 页面生成: ${state.completed}/${state.total}`);
	},
});

server.stop(true);

// ---------------------------------------------------------------------------
// 4) 汇报产物
// ---------------------------------------------------------------------------

const wikiDir = join(target, ".open-zread", "wiki");
const blueprint = JSON.parse(await readFile(join(wikiDir, "wiki.json"), "utf-8")) as { pages: Array<{ file: string; section: string }> };
console.log(`\n▶ 产物: ${wikiDir}`);
console.log(`   wiki.json（${blueprint.pages.length} 页）`);
for (const page of blueprint.pages) {
	const file = join(wikiDir, page.section, page.file);
	const exists = await stat(file).catch(() => null);
	console.log(`   ${exists ? "✓" : "✗"} ${page.section}/${page.file}`);
}
console.log(`\n结果：completed=${result.completed} failed=${result.failed}，mock 请求数=${requestCount}`);

process.chdir(join(target, ".."));
await rm(home, { recursive: true, force: true });

if (result.failed > 0 || result.completed !== pages.length) process.exit(1);
