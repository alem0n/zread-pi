/**
 * e2e-sync.ts —— Orchestrator 三阶段增量同步端到端验证
 *
 * 链路：
 *   1. generateWikiCatalog()（mock 三阶段）生成基线 wiki.json，并写缓存 manifest；
 *   2. 修改 src/a.ts、删除 src/b.ts、新增 src/c.ts；
 *   3. syncWiki()：diff → （新增文件未覆盖）分类合并 → 只对「变更 section」分主题/标题；
 *      代码侧机械判定 new / updated / archived / unchanged → 产出 SyncDiff。
 *
 * 运行：bun run packages/orchestrator/test/e2e-sync.ts
 */

import { cp, mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 1) 临时 HOME + 目标仓库（预置解析器缓存，避免每次下载 WASM）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "zread-pi-sync-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-sync-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });

// 把真实家目录里的 tree-sitter 解析器缓存复制进临时 HOME（离线可跑）
const realParsers = join(homedir(), ".zread-pi", "parsers");
if (await stat(realParsers).catch(() => null)) {
	await cp(realParsers, join(home, ".zread-pi", "parsers"), { recursive: true });
}

await writeFile(join(repo, "README.md"), "# sync-fixture\n", "utf-8");
await writeFile(join(repo, "src", "a.ts"), 'export const a = (): string => "a";\n', "utf-8");
await writeFile(join(repo, "src", "b.ts"), 'export const b = (): string => "b";\n', "utf-8");

// ---------------------------------------------------------------------------
// 2) mock LLM（按工具名分派：分类 / 主题 / 标题）
// ---------------------------------------------------------------------------

const BASE_SECTIONS = [
	{ title: "概览", description: "项目定位与整体速览" },
	{ title: "快速开始", description: "安装与运行示例" },
	{ title: "核心架构", description: "核心模块与实现细节" },
];

/** generation 阶段的分类（多一个「模块」承载两个文件页） */
const GENERATE_SECTIONS = [...BASE_SECTIONS, { title: "模块", description: "源码模块说明" }];
/** sync 阶段的分类（新增未覆盖文件 → 补一个「新增模块」） */
const SYNC_SECTIONS = [...GENERATE_SECTIONS, { title: "新增模块", description: "本次新增文件的说明" }];

const GENERATE_TOPICS: Record<string, Array<Record<string, unknown>>> = {
	概览: [
		{ title: "项目概览", slug: "project-overview", level: "Beginner", associatedFiles: ["README.md"] },
		{ title: "核心特性", slug: "feature-tour", level: "Beginner", associatedFiles: ["README.md"] },
		{ title: "设计目标", slug: "design-goals", level: "Intermediate", associatedFiles: ["README.md"] },
	],
	快速开始: [
		{ title: "安装与运行", slug: "install-run", level: "Beginner", associatedFiles: ["README.md"] },
		{ title: "最小示例", slug: "minimal-example", level: "Beginner", associatedFiles: ["README.md"] },
		{ title: "常见问题", slug: "faq", level: "Beginner", associatedFiles: ["README.md"] },
	],
	核心架构: [
		{ title: "整体架构", slug: "architecture", level: "Intermediate", associatedFiles: ["README.md"] },
		{ title: "模块职责", slug: "module-responsibilities", level: "Intermediate", associatedFiles: ["README.md"] },
		{ title: "数据流", slug: "data-flow", level: "Advanced", associatedFiles: ["README.md"] },
	],
	模块: [
		{ title: "模块 A", slug: "module-a", level: "Intermediate", associatedFiles: ["src/a.ts"] },
		{ title: "模块 B", slug: "module-b", level: "Intermediate", associatedFiles: ["src/b.ts"] },
		{ title: "模块核心约定", slug: "module-core", level: "Intermediate", associatedFiles: ["README.md"] },
	],
};

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

let phase: "generate" | "sync" = "generate";
let requestCount = 0;
const syncSeenSections: string[] = [];

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requestCount += 1;
		const body = (await request.json()) as {
			messages?: Array<{ role?: string; content?: unknown }>;
			tools?: Array<{ function?: { name?: string } }>;
		};
		const messages = body.messages ?? [];
		const promptText = messages.map((message) => contentToText(message.content)).join("\n");
		const hasToolResult = messages.some((message) => message.role === "tool");
		const toolNames = new Set(
			(body.tools ?? [])
				.map((tool) => tool?.function?.name)
				.filter((name): name is string => typeof name === "string"),
		);
		const section = /^- 分类: ([^\n]+)$/m.exec(promptText)?.[1]?.trim() ?? "";
		if (phase === "sync" && section) syncSeenSections.push(section);

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					if (toolNames.has("submit_sections")) {
						write(
							toolCall("call_sections", "submit_sections", {
								sections: phase === "sync" ? SYNC_SECTIONS : GENERATE_SECTIONS,
							}),
						);
					} else if (toolNames.has("submit_section_topics")) {
						let topics: Array<Record<string, unknown>> = [];
						if (phase === "generate") {
							topics = GENERATE_TOPICS[section] ?? [];
						} else if (section === "模块") {
							// 解析旧页面清单（slug / title / files），原样带回 slug+title
							topics = [...promptText.matchAll(/^- ([a-z0-9-]+): ([^（\[\n]+)(?:（[^）]*）)?(?: \[files: ([^\]]*)\])?$/gm)].map(
								(match) => ({
									slug: match[1],
									title: match[2].trim(),
									level: "Intermediate",
									associatedFiles: match[3] ? match[3].split(", ").filter(Boolean) : [],
								}),
							);
						} else if (section === "新增模块") {
							topics = [
								{ title: "模块 C", slug: "module-c", level: "Beginner", associatedFiles: ["src/c.ts"] },
							];
						}
						write(toolCall(`call_topics_${section}`, "submit_section_topics", { section, topics }));
					} else if (toolNames.has("refine_section_titles")) {
						const titles = [...promptText.matchAll(/^- ([a-z0-9-]+): ([^\[\n（]+)/gm)].map((match) => ({
							slug: match[1],
							title: match[2].trim(),
						}));
						write(toolCall(`call_titles_${section}`, "refine_section_titles", { section, titles }));
					} else {
						write(textChunk("完成"));
					}
				} else {
					write(textChunk("阶段完成"));
				}

				write(
					chunk({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [],
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
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
		"concurrency:",
		"  max_concurrent: 2",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { generateWikiCatalog } = await import("../src/orchestrator.js");
const { syncWiki, computeSyncDiff } = await import("../src/wiki/sync-wiki.js");
const { scanFiles } = await import("@zread-pi/repo-analyzer");
const { saveCachedManifest } = await import("@zread-pi/utils");

// 默认配置档位 high：产物落在变体子目录 `.zread-pi/wiki/high/`
const wikiJsonPath = join(repo, ".zread-pi", "wiki", "high", "wiki.json");
const readBlueprintFile = async (): Promise<{
	sections?: Array<{ title: string }>;
	pages: Array<{ slug: string; title: string; section: string; status?: string; associatedFiles?: string[] }>;
}> => JSON.parse(await readFile(wikiJsonPath, "utf-8"));

// ---------------------------------------------------------------------------
// 3) 基线生成
// ---------------------------------------------------------------------------

console.log("▶ 基线：generateWikiCatalog()（三阶段）…");
const baselineResult = await generateWikiCatalog();
check("基线生成 12 个页面", baselineResult.pagesCount === 12, String(baselineResult.pagesCount));

// 模拟 CLI 控制器：生成后保存 manifest 缓存（同步依赖它做 diff）
await saveCachedManifest(await scanFiles());

const baseline = await readBlueprintFile();
const overviewPage = baseline.pages.find((page) => page.section === "概览");
const modulePages = baseline.pages.filter((page) => page.section === "模块");
check("基线含「概览」页", overviewPage !== undefined, JSON.stringify(baseline.pages.map((p) => p.slug)));
check(
	"基线含三个「模块」页（含待归档的模块 B）",
	modulePages.length === 3 && modulePages.some((page) => page.slug.endsWith("module-b")),
	JSON.stringify(modulePages.map((p) => p.slug)),
);

// ---------------------------------------------------------------------------
// 4) 变更文件 → 增量同步
// ---------------------------------------------------------------------------

await writeFile(join(repo, "src", "a.ts"), 'export const a = (): string => "a-changed";\n', "utf-8");
await rm(join(repo, "src", "b.ts"));
await writeFile(join(repo, "src", "c.ts"), 'export const c = (): string => "c";\n', "utf-8");

phase = "sync";
const requestsBeforeSync = requestCount;
console.log("\n▶ syncWiki()（修改 a / 删除 b / 新增 c）…");
const syncResult = await syncWiki();
const synced = await readBlueprintFile();

console.log("  diff:", JSON.stringify({
	new: syncResult.diff.newPages.map((p) => p.slug),
	updated: syncResult.diff.updatedPages.map((p) => p.slug),
	archived: syncResult.diff.archivedPages.map((p) => p.slug),
}));

const findPage = (slug: string) => synced.pages.find((page) => page.slug === slug);

check("SyncResult 回传 tokenUsage", syncResult.tokenUsage !== undefined, JSON.stringify(syncResult.tokenUsage));
check("SyncResult 回传 durationMs", typeof syncResult.durationMs === "number", String(syncResult.durationMs));

check(
	"修改文件的页面标记为 updated（slug 不变）",
	modulePages.some((page) => syncResult.diff.updatedPages.some((entry) => entry.slug === page.slug)),
	JSON.stringify({ modulePages: modulePages.map((p) => p.slug), updated: syncResult.diff.updatedPages.map((p) => p.slug) }),
);
check(
	"删除文件且关联全消失的页面标记为 archived",
	modulePages.some((page) => syncResult.diff.archivedPages.some((entry) => entry.slug === page.slug)),
	JSON.stringify(syncResult.diff.archivedPages.map((p) => p.slug)),
);
check(
	"新增文件产生 new 页面（归入新分类）",
	syncResult.diff.newPages.length === 1 && syncResult.diff.newPages[0].section === "新增模块",
	JSON.stringify(syncResult.diff.newPages.map((p) => `${p.slug}@${p.section}`)),
);
check(
	"归档数 = 1（只有被删文件的页面）",
	syncResult.diff.archivedPages.length === 1 &&
		modulePages.some((page) => page.slug === syncResult.diff.archivedPages[0].slug),
	JSON.stringify(syncResult.diff.archivedPages.map((p) => p.slug)),
);
check(
	"未受影响页面保持 unchanged 且不重生成",
	overviewPage !== undefined && findPage(overviewPage.slug)?.status === "unchanged",
	JSON.stringify(overviewPage && findPage(overviewPage.slug)),
);
check(
	"只有变更分类跑了主题/标题 Agent（概览未被触碰）",
	syncSeenSections.includes("模块") &&
		syncSeenSections.includes("新增模块") &&
		!syncSeenSections.includes("概览"),
	syncSeenSections.join(","),
);
check(
	"新增分类被合并进 sections",
	synced.sections?.some((section) => section.title === "新增模块") === true,
	JSON.stringify(synced.sections?.map((section) => section.title)),
);
check(
	"归档页面仍保留在 wiki.json 并带 status=archived",
	syncResult.diff.archivedPages.length > 0 &&
		syncResult.diff.archivedPages.every((page) => findPage(page.slug)?.status === "archived"),
	JSON.stringify(syncResult.diff.archivedPages.map((page) => findPage(page.slug)?.status)),
);
check(
	"sync 复用既有 slug（页面 URL 漂移为 0）",
	modulePages.every((page) => findPage(page.slug) !== undefined),
	JSON.stringify(synced.pages.map((p) => p.slug)),
);
check("sync 至少发生了一次真实 LLM 请求", requestCount > requestsBeforeSync, `requests=${requestCount - requestsBeforeSync}`);

// ---------------------------------------------------------------------------
// 5) 无变更：不调用 LLM，返回空 diff
// ---------------------------------------------------------------------------

const requestsBeforeNoop = requestCount;
const noop = await syncWiki();
check(
	"无变更时不调用 LLM 且返回空 diff",
	noop.diff.newPages.length === 0 &&
		noop.diff.updatedPages.length === 0 &&
		noop.diff.archivedPages.length === 0 &&
		requestCount === requestsBeforeNoop,
	`requests=${requestCount - requestsBeforeNoop}`,
);

// ---------------------------------------------------------------------------
// 6) computeSyncDiff 纯函数边界
// ---------------------------------------------------------------------------

{
	const oldPages = [
		{ slug: "1-a", title: "A", file: "1-a.md", section: "S", level: "Beginner" as const, associatedFiles: ["src/a.ts"] },
		{ slug: "2-b", title: "B", file: "2-b.md", section: "S", level: "Beginner" as const, associatedFiles: ["src/b.ts"] },
	];
	// 新清单里缺失 2-b（模型漏报），但文件仍在 → 原样保留为 unchanged
	const partial = computeSyncDiff({
		oldPages,
		newPages: [oldPages[0]],
		changedFiles: new Set(["src/a.ts"]),
		currentFiles: new Set(["src/a.ts", "src/b.ts"]),
	});
	check(
		"新清单缺失但文件仍在的旧页面被保留（漏报兜底）",
		partial.pages.some((page) => page.slug === "2-b" && page.status === "unchanged"),
		JSON.stringify(partial.pages.map((page) => `${page.slug}:${page.status}`)),
	);
	check(
		"缺失且文件已删除的旧页面判归档",
		computeSyncDiff({
			oldPages,
			newPages: [oldPages[0]],
			changedFiles: new Set(["src/b.ts"]),
			currentFiles: new Set(["src/a.ts"]),
		}).diff.archivedPages.some((page) => page.slug === "2-b"),
	);

	const titleOnly = computeSyncDiff({
		oldPages,
		newPages: [{ ...oldPages[1], title: "B（精修）" }],
		changedFiles: new Set(),
		currentFiles: new Set(["src/a.ts", "src/b.ts"]),
	});
	check(
		"仅标题变化也判 updated",
		titleOnly.diff.updatedPages.some((page) => page.slug === "2-b"),
		JSON.stringify(titleOnly.diff.updatedPages.map((page) => page.slug)),
	);
}

server.stop(true);

process.chdir(join(repo, ".."));
await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
