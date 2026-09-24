/**
 * e2e-sync.ts —— Orchestrator 结构优先增量同步端到端验证
 *
 * 链路：
 *   1. generateWikiCatalog()（结构 → 分类命名 → 页面命名）生成基线 wiki.json，并写缓存 manifest；
 *   2. 修改 src/a.ts、删除 src/b.ts、新增 src/c.ts；
 *   3. syncWiki()：diff → 结构重算 → reconcileBlueprint（命中页继承旧身份、分类按多数票协调）
 *      → 只命名「新增」的分类 / 页面 → 代码侧机械判定 new / updated / archived / unchanged。
 *
 * 与旧三阶段 sync 的关键差异（本测试即验它们）：
 * - 命中既有页面的机器页整份继承身份（slug / 标题 / 摘要），一个 Agent 都不为它们跑；
 * - 只有「新增分类 / 新增页面」才进 LLM（fence 会被 onlyIds 收窄）；
 * - 旧 slug 在新清单缺失 → 无条件归档。
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
await writeFile(join(home, ".zread-pi", "AGENTS.md"), "# global-agents-context\n", "utf-8");

// ---------------------------------------------------------------------------
// 2) mock LLM（按工具名分派：分类命名 / 页面命名；从 json fence 原样回填）
// ---------------------------------------------------------------------------

const BASE_SECTION_IDS = ["overview", "core"];
const NAMED_SUFFIX = "（命名）";

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

/** 从提示词里抠出第一个 json fence 的 payload */
function parseJsonFence(text: string, key: string): unknown[] {
	const match = /```json\n([\s\S]*?)\n```/.exec(text);
	if (!match) return [];
	try {
		const payload = JSON.parse(match[1]) as Record<string, unknown>;
		const value = payload[key];
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
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
/** sync 阶段带输出工具的请求数（每个命名 Agent 的首轮） */
let syncToolRequests = 0;
/** sync 阶段每个请求见到的分类（验证「只命名新增」） */
const syncSeenSections: string[] = [];
/** sync 阶段 submit_sections 提交的清单长度（onlyIds 收窄后应只剩新增分类） */
const syncSectionFenceSizes: number[] = [];
/** sync 阶段 submit_pages 提交的清单长度（onlyIds 收窄后应只剩新增页面） */
const syncPageFenceSizes: number[] = [];

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
		const section = /^- 分类：(.+)$/m.exec(promptText)?.[1]?.trim() ?? "";
		if (phase === "sync") {
			if (section) syncSeenSections.push(section);
			if (!hasToolResult && (toolNames.has("submit_sections") || toolNames.has("submit_pages"))) {
				syncToolRequests += 1;
			}
		}

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					if (toolNames.has("submit_sections")) {
						// 分类命名：从机器清单原样回填（基础分类只补 scope）
						const machineSections = parseJsonFence(promptText, "machineSections");
						if (phase === "sync") syncSectionFenceSizes.push(machineSections.length);
						write(
							toolCall("call_sections", "submit_sections", {
								sections: machineSections.map((entry) => {
									const item = entry as { id: string; title: string };
									const isBase = BASE_SECTION_IDS.includes(item.id);
									return {
										id: item.id,
										...(isBase
											? {}
											: { title: `${item.title}${NAMED_SUFFIX}`, description: `${item.title} 的命名说明` }),
										scope: [`包含：${item.title} 的能力域`, "不包含：相邻分类"],
									};
								}),
							}),
						);
					} else if (toolNames.has("submit_pages")) {
						const machinePages = parseJsonFence(promptText, "machinePages");
						if (phase === "sync") syncPageFenceSizes.push(machinePages.length);
						write(
							toolCall(`call_pages_${section}`, "submit_pages", {
								section,
								pages: machinePages.map((entry) => {
									const item = entry as { id: string; label: string };
									return {
										id: item.id,
										title: `${item.label}${NAMED_SUFFIX}`,
										summary: `${item.label} 的页面摘要`,
										level: "Intermediate",
									};
								}),
							}),
						);
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
interface BlueprintFile {
	sections?: Array<{ title: string; id?: string; scope?: string[]; description?: string }>;
	pages: Array<{
		slug: string;
		title: string;
		section: string;
		status?: string;
		associatedFiles?: string[];
		ownsFiles?: string[];
		topicSummary?: string;
	}>;
}
const readBlueprintFile = async (): Promise<BlueprintFile> =>
	JSON.parse(await readFile(wikiJsonPath, "utf-8"));

// ---------------------------------------------------------------------------
// 3) 基线生成
// ---------------------------------------------------------------------------

console.log("▶ 基线：generateWikiCatalog()（结构 → 命名）…");
const baselineResult = await generateWikiCatalog();
const baseline = await readBlueprintFile();
const structureSections = (baseline.sections ?? []).filter(
	(section) => section.id && !BASE_SECTION_IDS.includes(section.id),
);
const baselineModulePages = baseline.pages.filter((page) =>
	structureSections.some((section) => section.title === page.section),
);
console.log(
	`  基线：${baselineResult.sectionsCount} 个分类，${baselineResult.pagesCount} 个页面；` +
		`结构分类页 ${baselineModulePages.map((page) => `${page.slug}@${page.ownsFiles?.join(",")}`).join(" / ")}`,
);
check("基线生成页面数 = 2 个基础槽位页 + 每个切片 1 页", baselineResult.pagesCount === 2 + structureSections.length, String(baselineResult.pagesCount));
check(
	"基线每个结构分类页拥有一个源文件",
	baselineModulePages.length === 2 &&
		baselineModulePages.every((page) => (page.ownsFiles?.length ?? 0) === 1),
	JSON.stringify(baselineModulePages.map((page) => `${page.slug}:${page.ownsFiles}`)),
);
check(
	"基线结构分类页标题已被命名",
	baselineModulePages.every((page) => page.title.endsWith(NAMED_SUFFIX)),
	JSON.stringify(baselineModulePages.map((page) => page.title)),
);

// 模拟 CLI 控制器：生成后保存 manifest 缓存（同步依赖它做 diff）
await saveCachedManifest(await scanFiles());

const pageOwning = (file: string) => baseline.pages.find((page) => page.ownsFiles?.includes(file));
const pageA = pageOwning("src/a.ts");
const pageB = pageOwning("src/b.ts");
check("基线：src/a.ts 与 src/b.ts 各归一页", pageA !== undefined && pageB !== undefined && pageA.slug !== pageB.slug);

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

/** 命中页所属分类的标题（本例即 src/a.ts 所在分类）被旧产物多数票继承 */
function structreSectionInherited(
	next: BlueprintFile,
	baselineStructureTitles: string[],
): boolean {
	if (pageA === undefined) return false;
	const sectionExists = next.sections?.some((section) => section.title === pageA.section) === true;
	return sectionExists && baselineStructureTitles.includes(pageA.section);
}

check("SyncResult 回传 tokenUsage", syncResult.tokenUsage !== undefined, JSON.stringify(syncResult.tokenUsage));
check("SyncResult 回传 durationMs", typeof syncResult.durationMs === "number", String(syncResult.durationMs));

check(
	"修改文件的页面标记为 updated（slug 不变）",
	pageA !== undefined && syncResult.diff.updatedPages.some((entry) => entry.slug === pageA.slug),
	JSON.stringify(syncResult.diff.updatedPages.map((p) => p.slug)),
);
check(
	"命中页的 slug / 标题 / 摘要被整份继承（URL 漂移为 0）",
	pageA !== undefined &&
		findPage(pageA.slug)?.title === pageA.title &&
		findPage(pageA.slug)?.topicSummary === pageA.topicSummary,
	JSON.stringify(pageA && findPage(pageA.slug)),
);
check(
	"删除文件的页面无条件标记为 archived",
	pageB !== undefined && syncResult.diff.archivedPages.some((entry) => entry.slug === pageB.slug),
	JSON.stringify(syncResult.diff.archivedPages.map((p) => p.slug)),
);
check(
	"归档数 = 1（只有被删文件的页面）",
	syncResult.diff.archivedPages.length === 1 &&
		pageB !== undefined &&
		pageB.slug === syncResult.diff.archivedPages[0].slug,
	JSON.stringify(syncResult.diff.archivedPages.map((p) => p.slug)),
);
check(
	"新增文件产生 new 页面",
	syncResult.diff.newPages.length === 1 && (syncResult.diff.newPages[0].ownsFiles ?? []).includes("src/c.ts"),
	JSON.stringify(syncResult.diff.newPages.map((p) => `${p.slug}@${p.ownsFiles}`)),
);
check(
	"新增页面已被命名（走了页面命名 Agent）",
	syncResult.diff.newPages.length === 1 && syncResult.diff.newPages[0].title.endsWith(NAMED_SUFFIX),
	JSON.stringify(syncResult.diff.newPages.map((p) => p.title)),
);
check(
	"未受影响页面保持 unchanged",
	baseline.pages
		.filter((page) => page.slug !== pageB?.slug && page.slug !== pageA?.slug)
		.every((page) => findPage(page.slug)?.status === "unchanged"),
	JSON.stringify(
		baseline.pages
			.filter((page) => page.slug !== pageB?.slug && page.slug !== pageA?.slug)
			.map((page) => `${page.slug}:${findPage(page.slug)?.status}`),
	),
);
check(
	"归档页面仍保留在 wiki.json 并带 status=archived",
	syncResult.diff.archivedPages.length > 0 &&
		syncResult.diff.archivedPages.every((page) => findPage(page.slug)?.status === "archived"),
	JSON.stringify(syncResult.diff.archivedPages.map((page) => findPage(page.slug)?.status)),
);
check(
	"页面 ownsFiles 仍然互斥（一文件只归一页）",
	new Set(synced.pages.flatMap((page) => page.ownsFiles ?? [])).size ===
		synced.pages.flatMap((page) => page.ownsFiles ?? []).length,
	JSON.stringify(synced.pages.flatMap((page) => page.ownsFiles ?? [])),
);

// —— 「只命名新增」的核心断言 ——
check(
	"submit_sections 的机器清单只剩新增分类（onlyIds 收窄）",
	syncSectionFenceSizes.length === 1 && syncSectionFenceSizes[0] === 1,
	JSON.stringify(syncSectionFenceSizes),
);
check(
	"submit_pages 的机器清单只剩新增页面（onlyIds 收窄）",
	syncPageFenceSizes.length === 1 && syncPageFenceSizes[0] === 1,
	JSON.stringify(syncPageFenceSizes),
);
check(
	"只有新增分类跑了页面命名 Agent（既有分类未被触碰）",
	[...new Set(syncSeenSections)].length === 1 &&
		!baseline.sections?.some((section) => section.title === [...new Set(syncSeenSections)][0]),
	[...new Set(syncSeenSections)].join(","),
);
check(
	"sync 命名工具调用 = 2（1 次分类命名 + 1 次页面命名；命中页零请求）",
	syncToolRequests === 2,
	`toolRequests=${syncToolRequests} totalRequests=${requestCount - requestsBeforeSync}`,
);
check(
	"sync 后 sections 含新标题的结构分类（旧标题未保留）",
	synced.sections?.some(
		(section) =>
			section.id &&
			!BASE_SECTION_IDS.includes(section.id) &&
			!structureSections.some((old) => old.title === section.title),
	) === true,
	JSON.stringify(synced.sections?.map((section) => section.title)),
);
check(
	"仍有命中页的结构分类标题被多数票继承（保持不变）",
	structreSectionInherited(synced, structureSections.map((section) => section.title)),
	JSON.stringify(synced.sections?.map((section) => section.title)),
);
check(
	"sync 后命中页仍保留 topicSummary",
	pageA !== undefined && typeof findPage(pageA.slug)?.topicSummary === "string",
	JSON.stringify(pageA && findPage(pageA.slug)?.topicSummary),
);

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
// 6) 旧版 wiki.json（schemaVersion != 2）被拒绝
// ---------------------------------------------------------------------------

const legacyJson = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as BlueprintFile & { schemaVersion?: number };
legacyJson.schemaVersion = 1;
await writeFile(wikiJsonPath, JSON.stringify(legacyJson, null, 2), "utf-8");
const legacyFailure = await syncWiki().then(
	() => null,
	(err: unknown) => (err instanceof Error ? err.message : String(err)),
);
check(
	"旧版 wiki.json（schemaVersion != 2）被 sync 拒绝",
	typeof legacyFailure === "string" && legacyFailure.includes("schemaVersion"),
	legacyFailure ?? "(未报错)",
);

// ---------------------------------------------------------------------------
// 7) computeSyncDiff 纯函数边界（新语义：缺 slug 无条件归档）
// ---------------------------------------------------------------------------

{
	const oldPages = [
		{ slug: "1-a", title: "A", file: "1-a.md", section: "S", level: "Beginner" as const, ownsFiles: ["src/a.ts"], associatedFiles: ["src/a.ts"] },
		{ slug: "2-b", title: "B", file: "2-b.md", section: "S", level: "Beginner" as const, ownsFiles: ["src/b.ts"], associatedFiles: ["src/b.ts"] },
	];
	const dropped = computeSyncDiff({
		oldPages,
		newPages: [oldPages[0]],
		changedFiles: new Set(),
	});
	check(
		"新清单缺失的旧页面无条件归档",
		dropped.diff.archivedPages.some((page) => page.slug === "2-b") && dropped.pages.length === 2,
		JSON.stringify(dropped.pages.map((page) => `${page.slug}:${page.status}`)),
	);

	const titleOnly = computeSyncDiff({
		oldPages,
		newPages: [{ ...oldPages[1], title: "B（精修）" }],
		changedFiles: new Set(),
	});
	check(
		"仅标题变化也判 updated",
		titleOnly.diff.updatedPages.some((page) => page.slug === "2-b"),
		JSON.stringify(titleOnly.diff.updatedPages.map((page) => page.slug)),
	);
	const sectionOnly = computeSyncDiff({
		oldPages,
		newPages: [{ ...oldPages[1], section: "T" }],
		changedFiles: new Set(),
	});
	check(
		"所属分类变化也判 updated",
		sectionOnly.diff.updatedPages.some((page) => page.slug === "2-b"),
		JSON.stringify(sectionOnly.diff.updatedPages.map((page) => page.slug)),
	);
	const ownsChanged = computeSyncDiff({
		oldPages,
		newPages: [{ ...oldPages[1], ownsFiles: ["src/b.ts", "src/x.ts"] }],
		changedFiles: new Set(),
	});
	check(
		"ownsFiles 变化也判 updated",
		ownsChanged.diff.updatedPages.some((page) => page.slug === "2-b"),
		JSON.stringify(ownsChanged.diff.updatedPages.map((page) => page.slug)),
	);
	const hit = computeSyncDiff({
		oldPages,
		newPages: [oldPages[1]],
		changedFiles: new Set(["src/b.ts"]),
	});
	check(
		"关联路径命中本次 diff 也判 updated",
		hit.diff.updatedPages.some((page) => page.slug === "2-b"),
		JSON.stringify(hit.diff.updatedPages.map((page) => page.slug)),
	);
	const untouched = computeSyncDiff({
		oldPages,
		newPages: oldPages,
		changedFiles: new Set(),
	});
	check(
		"无变化的页面判 unchanged",
		untouched.pages.every((page) => page.status === "unchanged"),
		JSON.stringify(untouched.pages.map((page) => `${page.slug}:${page.status}`)),
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
