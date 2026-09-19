/**
 * mock-wiki-run.ts —— 离线全链路试跑：用本地 mock LLM 对任意目标仓库跑一遍
 * 「三阶段蓝图（分类 → 分主题 → 标题） -> 并行页面生成」，不需要任何真实 API Key。
 *
 * 用途：验证流水线是否正常（扫描/AST/工具落盘/事件/并发），或在没有额度时做回归。
 * 真实模型请用 `bun run cli`（读 ~/.zread-pi/config.yaml）。
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

/** 夹具源文件的可用行数（供 mock 页面的 Sources 溯源行给出落在文件内的行号区间） */
const SOURCE_LINE_CAP: Record<string, number> = {};
for (const relative of entries) {
	if (["main.py", "calculator.py", "utils.py", "README.md"].includes(basename(relative))) {
		const text = await readFile(join(target, relative), "utf-8");
		SOURCE_LINE_CAP[relative] = Math.max(1, Math.floor(text.split("\n").length / 2) || 1);
	}
}

const slugify = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "page";

/** 分类阶段交给 mock LLM 的分类清单（概览/核心架构是强制基础分类；low 档位 2~5 个） */
const SECTIONS = [
	{ title: "概览", description: "项目定位与整体速览" },
	{ title: "核心架构", description: "核心模块与实现细节" },
];

/** 分主题阶段：每个分类的文章主题（low 档位每分类 1~3 篇；核心架构覆盖扫描到的源文件） */
const TOPICS_BY_SECTION: Record<string, Array<Record<string, unknown>>> = {
	概览: [
		{
			title: "项目概览",
			slug: "project-overview",
			level: "Beginner",
			associatedFiles: entries.filter((entry) => entry.toLowerCase().includes("readme")).slice(0, 1),
		},
	],
	核心架构: entries.slice(0, 3).map((relative) => ({
		title: basename(relative, extname(relative)),
		slug: slugify(basename(relative, extname(relative))),
		level: "Intermediate",
		associatedFiles: [relative],
	})),
};

const expectedPages = Object.values(TOPICS_BY_SECTION).reduce((sum, topics) => sum + topics.length, 0);

if (expectedPages === 0) {
	console.error(`目标目录没有可扫描的源文件: ${target}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 1) mock LLM（OpenAI 兼容）
// ---------------------------------------------------------------------------

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
					return (block as { text: string }).text;
				}
				return "";
			})
			.join("\n");
	}
	return "";
}

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
		const body = (await request.json()) as {
			messages?: Array<{ role?: string; content?: unknown }>;
			tools?: Array<{ function?: { name?: string } }>;
		};
		const messages = body.messages ?? [];
		const prompt = JSON.stringify(messages.map((message) => message.content ?? ""));
		const promptText = messages.map((message) => contentToText(message.content)).join("\n");
		const hasToolResult = messages.some((message) => message.role === "tool");
		const isPageAgent = prompt.includes("当前页面任务");
		const toolNames = new Set(
			(body.tools ?? [])
				.map((tool) => tool?.function?.name)
				.filter((name): name is string => typeof name === "string"),
		);
		const section = /^- 分类: ([^\n]+)$/m.exec(promptText)?.[1]?.trim() ?? "";

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					if (toolNames.has("submit_sections")) {
						write(toolCall("call_sections", "submit_sections", { sections: SECTIONS }));
					} else if (toolNames.has("submit_section_topics")) {
						write(
							toolCall(`call_topics_${section}`, "submit_section_topics", {
								section,
								topics: TOPICS_BY_SECTION[section] ?? [],
							}),
						);
					} else if (toolNames.has("refine_section_titles")) {
						const titles = [...promptText.matchAll(/^- ([a-z0-9-]+): ([^\[\n（]+)/gm)].map((match) => ({
							slug: match[1],
							title: match[2].trim(),
						}));
						write(toolCall(`call_titles_${section}`, "refine_section_titles", { section, titles }));
					} else if (isPageAgent || toolNames.has("write_page")) {
						const slug = /\*\*Slug\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? "page";
						const file = /\*\*文件名\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? `${slug}.md`;
						const title = /\*\*标题\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? slug;
						const pageSection = /\*\*章节\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? "";
						// 溯源行指向夹具里真实存在的源文件（让 verify 的 traceability 组可走全链路）
						// 路径取相对仓库根的 POSIX 写法（与 manifest / associatedFiles 同口径）；
						// 行号区间取文件行数的前 1/2，保证落在文件内（SOURCE_LINE_CAP 预计算）
						const sources = Object.keys(SOURCE_LINE_CAP)
							.slice(0, 2)
							.map((relative) => `[${basename(relative)}](${relative}#L1-L${SOURCE_LINE_CAP[relative]})`)
							.join(", ");
						write(
							toolCall(`call_${slug}`, "write_page", {
								slug,
								file,
								section: pageSection,
								title,
								content: [
									`# ${title}`,
									"",
									"> 由 mock LLM 生成（离线试跑），真实内容请用 `bun run cli`。",
									"",
									"```mermaid",
									"flowchart TB",
									`  A["${title}"] --> B["测试通过"]`,
									"```",
									"",
									...(sources ? [`Sources: ${sources}`] : []),
								].join("\n"),
							}),
						);
					} else {
						write(textChunk("完成"));
					}
				} else {
					write(textChunk(isPageAgent ? "页面完成" : "阶段完成"));
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
// 2) 临时 HOME（~/.zread-pi/config.yaml 指向 mock）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "zread-pi-mock-home-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
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
		// 离线试跑用 low 档位：3~5 个分类 · 每分类 1~3 篇，跳过标题精修（请求更少、产物更小）
		"blueprint:",
		"  detail: low",
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
const { verifyWiki } = await import("../packages/orchestrator/src/wiki/verify-wiki.js");
const { RunLogWriter } = await import("../packages/utils/src/trajectory-store/index.js");

// ---------------------------------------------------------------------------
// 3) 跑流水线（目录 + 页面共享同一个 run，与真实 CLI 流程一致）
// ---------------------------------------------------------------------------

console.log(`▶ 目标仓库: ${target}`);
console.log(`▶ 扫描到源文件: ${entries.length}，规划页面: ${expectedPages}`);

const runLog = await RunLogWriter.create(target, { kind: "generate", detail: "low" });
runLog.appendRunStart({ targetDir: target, detail: "low" });

const catalogEvents: string[] = [];
const catalog = await generateWikiCatalog((event) => catalogEvents.push(event.stage ? `${event.stage}:${event.type}` : event.type), { runLog });
console.log(`▶ 蓝图完成: ${catalog.durationMs}ms, sections=${catalog.sectionsCount}, pages=${catalog.pagesCount}, usage=${JSON.stringify(catalog.tokenUsage)}`);
if (catalog.failedSections?.length) {
	console.log(`  failedSections: ${JSON.stringify(catalog.failedSections)}`);
}
console.log(`  CatalogEvent: ${catalogEvents.join(",")}`);

const result = await generateWikiContent({
	runLog,
	maxConcurrent: 3,
	onProgress: (state) => {
		if (state.completed === state.total) console.log(`▶ 页面生成: ${state.completed}/${state.total}`);
	},
});

await runLog.end("completed");

server.stop(true);

// ---------------------------------------------------------------------------
// 4) 汇报产物
// ---------------------------------------------------------------------------

// low 档位变体目录（tools/mock-wiki-run.ts 的配置写入 `blueprint.detail: low`）
const wikiDir = join(target, ".zread-pi", "wiki", "low");
const blueprint = JSON.parse(await readFile(join(wikiDir, "wiki.json"), "utf-8")) as {
	sections?: Array<{ title: string }>;
	pages: Array<{ file: string; section: string }>;
};
console.log(`\n▶ 产物: ${wikiDir}`);
console.log(`   wiki.json（${blueprint.sections?.length ?? 0} 个分类 / ${blueprint.pages.length} 页）`);
for (const page of blueprint.pages) {
	const file = join(wikiDir, page.section, page.file);
	const exists = await stat(file).catch(() => null);
	console.log(`   ${exists ? "✓" : "✗"} ${page.section}/${page.file}`);
}
console.log(`\n结果：completed=${result.completed} failed=${result.failed}，mock 请求数=${requestCount}`);

// ---------------------------------------------------------------------------
// 5) 交付闸门核对（plan.md §3.2 / §6）：mock 产物只断言结构类检查全绿；
//    content 组以 warn 报告产出（mock LLM + 极小夹具过不了密度门，属预期）。
// ---------------------------------------------------------------------------
const verify = await verifyWiki({ root: target, detail: 'low' });
const structural = verify.checks.filter((c) => c.group !== 'content');
const contentChecks = verify.checks.filter((c) => c.group === 'content');
console.log(`\n▶ 交付闸门：overall=${verify.ok ? 'PASS' : 'FAIL'}（legacy=${verify.legacy}）`);
for (const c of structural) console.log(`   ${c.status === 'PASS' ? '✓' : c.status === 'SKIP' ? '○' : '✗'} [${c.group}] ${c.message}`);
if (contentChecks.length > 0) {
	console.log(`   （content 组 ${contentChecks.length} 项为 warn 报告，不作为达标依据）`);
}

process.chdir(join(target, ".."));
await rm(home, { recursive: true, force: true });

// 结构类检查必须全绿（SKIP 允许：mock 不产符号缓存，traceability 降级属预期）
const structuralFailures = structural.filter((c) => c.status === 'FAIL');
if (result.failed > 0 || result.completed !== expectedPages || structuralFailures.length > 0) {
	if (structuralFailures.length > 0) {
		console.log(`\n❌ 结构类检查失败 ${structuralFailures.length} 项`);
		for (const c of structuralFailures) console.log(`   ✗ [${c.group}] ${c.message}`);
	}
	process.exit(1);
}
