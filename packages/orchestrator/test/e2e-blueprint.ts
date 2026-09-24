/**
 * e2e-blueprint.ts —— Orchestrator 蓝图端到端验证（结构 → 分类命名 → 页面命名）
 *
 * 链路：generateWikiCatalog()
 *   -> 阶段 0 结构：代码扫描符号 → 切片 / 归并 → 机器骨架落盘（无 LLM）
 *   -> 阶段 1 分类命名：submit_sections 写 title / description / scope
 *   -> 阶段 2 页面命名：每个 section 一个 Agent，submit_pages 写 title / summary / group / level
 *   -> 最后校验 wiki.json 可加载
 *
 * mock LLM 依据请求里的工具名区分两个命名角色（sections / pages），
 * 并从提示词的 json fence 里解析机器骨架原样回填命名。
 *
 * 运行：bun run packages/orchestrator/test/e2e-blueprint.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.error(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 1) 准备临时 HOME（.zread-pi/config.yaml）与目标仓库
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "zread-pi-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(
	join(repo, "src", "greet.ts"),
	"export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
	"utf-8",
);
await writeFile(
	join(repo, "src", "math.ts"),
	"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
	"utf-8",
);
await writeFile(
	join(repo, "README.md"),
	"# mock-repo\n一个用于端到端验证的最小仓库。\n",
	"utf-8",
);
// 目标仓库自述：应被注入系统提示（AGENTS.md 优先于无）
await writeFile(
	join(repo, "AGENTS.md"),
	"# repo-agents-context\n本项目约定：所有模块使用 TypeScript。\n",
	"utf-8",
);
// 全局上下文（~/.zread-pi/AGENTS.md）：对所有项目生效，排在项目上下文之前
await writeFile(
	join(home, ".zread-pi", "AGENTS.md"),
	"# global-agents-context\n全局约定：文档用中文标题。\n",
	"utf-8",
);

// ---------------------------------------------------------------------------
// 2) 启动 mock OpenAI 兼容服务（按工具名分派两个命名角色）
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
				{
					tool_calls: [
						{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
					],
				},
				"tool_calls",
			),
		)
	);
}

function textChunk(text: string): string {
	return chunk(baseChunk({ role: "assistant", content: text }, null)) + chunk(baseChunk({}, "stop"));
}

/** 场景：ok（正常命名）| section-skip（某分类页面不调工具）| no-structure（无可解析源文件，致命） */
let mode: "ok" | "section-skip" | "no-structure" = "ok";
/** section-skip 场景下要跳过的分类标题 */
let skipSection = "";
/** 记录每次请求的 system 消息（验证上下文文件注入） */
const seenSystemPrompts: string[] = [];
const seenSections: string[] = [];
/** 记录每次请求的输出上限（验证 llm.max_tokens 覆盖下发；openai-completions 依 compat 用 max_tokens 或 max_completion_tokens） */
const seenMaxTokens: Array<number | undefined> = [];
let requestCount = 0;
/** 单次请求的 mock 用量（断言「跨 Agent 聚合」时按请求数换算） */
let totalInputTokens = 0;
let totalOutputTokens = 0;

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requestCount += 1;
		const body = (await request.json()) as {
			messages?: Array<{ role?: string; content?: unknown }> ;
			tools?: Array<{ function?: { name?: string } }>;
			max_tokens?: number;
			max_completion_tokens?: number;
		};
		seenMaxTokens.push(body.max_tokens ?? body.max_completion_tokens);
		const messages = body.messages ?? [];
		const promptText = messages
			.map((message) => contentToText(message.content))
			.join("\n");
		const rawSystem = messages
			.map((message) => (message.role === "system" && typeof message.content === "string" ? message.content : ""))
			.join("\n");
		if (rawSystem) seenSystemPrompts.push(rawSystem);

		const toolNames = new Set(
			(body.tools ?? [])
				.map((tool) => tool?.function?.name)
				.filter((name): name is string => typeof name === "string"),
		);
		const hasToolResult = messages.some((message) => message.role === "tool");
		const section = /^- 分类：(.+)$/m.exec(promptText)?.[1]?.trim() ?? "";
		if (section) seenSections.push(section);

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					if (toolNames.has("submit_sections")) {
						// 分类命名：从机器清单原样回填（基础分类只补 scope）
						const machineSections = parseJsonFence(promptText, "machineSections");
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
						}));
					} else if (toolNames.has("submit_pages")) {
						if (mode === "section-skip" && section === skipSection) {
							write(textChunk("本分类暂不命名"));
						} else {
							const machinePages = parseJsonFence(promptText, "machinePages");
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
						}
					} else {
						write(textChunk("done"));
					}
				} else {
					write(textChunk("完成"));
				}

				write(
					chunk({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "mock-model",
						choices: [],
						usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
					}),
				);
				totalInputTokens += 123;
				totalOutputTokens += 45;
				write("data: [DONE]\n\n");
				controller.close();
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				// 模拟真实 provider 回传 request id（排障关联用）：每请求自增，
				// 验证它经 after_response 钩子落进轨迹日志的 message_end.requestId
				"x-request-id": `mock-req-${requestCount}`,
			},
		});
	},
});

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: en",
		"doc_language: en",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"concurrency:",
		"  max_concurrent: 4",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

// CONFIG_PATH 在模块加载时由 homedir() 计算，因此必须在 import 业务代码之前改 HOME
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

// ---------------------------------------------------------------------------
// 3) 运行 Orchestrator（正向场景）
// ---------------------------------------------------------------------------

const { generateWikiCatalog } = await import("../src/orchestrator.js");

// 默认配置档位 high：产物落在变体子目录 `.zread-pi/wiki/high/`
const WIKI_DETAIL = "high";
const wikiJsonPath = join(repo, ".zread-pi", "wiki", WIKI_DETAIL, "wiki.json");

console.error("▶ generateWikiCatalog()（结构 → 命名）…");
const events: Array<{
	type: string;
	stage?: string;
	section?: string;
	progressTotal?: number;
	agentKey?: string;
	agentRole?: string;
	agentStatus?: string;
	agentInputTokens?: number;
	agentOutputTokens?: number;
	contextTokens?: number;
	contextWindow?: number;
}> = [];
let skeletonSnapshot: { pages: unknown[]; sections: unknown[] } | undefined;

const result = await generateWikiCatalog((event) => {
	events.push({
		type: event.type,
		stage: event.stage,
		section: event.section,
		progressTotal: event.progress?.total,
		agentKey: event.agentKey,
		agentRole: event.agentRole,
		agentStatus: event.agentStatus,
		agentInputTokens: event.agentUsage?.input_tokens,
		agentOutputTokens: event.agentUsage?.output_tokens,
		contextTokens: event.contextTokens,
		contextWindow: event.contextWindow,
	});
	// 结构阶段落盘后骨架即可加载（sections / pages / coverage 一起落盘，永不悬挂）
	// 同步快照：promise 的 resolve 时机晚于后续阶段，会读到命名后的页面
	if (event.stage === "structure" && event.agentStatus === "completed" && !skeletonSnapshot) {
		try {
			skeletonSnapshot = JSON.parse(readFileSync(wikiJsonPath, "utf-8")) as {
				pages: unknown[];
				sections: unknown[];
			};
		} catch {
			skeletonSnapshot = undefined;
		}
	}
});

// ---------------------------------------------------------------------------
// 4) 断言（正向场景）
// ---------------------------------------------------------------------------

let blueprint: Record<string, unknown> | undefined;
try {
	blueprint = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as Record<string, unknown>;
} catch {
	blueprint = undefined;
}

interface PageShape {
	slug: string;
	title: string;
	file: string;
	section: string;
	level?: string;
	topicSummary?: string;
	ownsFiles?: string[];
}

const pages = ((blueprint?.pages as PageShape[] | undefined) ?? []).slice();
const sections = ((blueprint?.sections as Array<{ title: string; id?: string; scope?: string[] }> | undefined) ?? []).slice();
const structureSections = sections.filter((section) => section.id && !BASE_SECTION_IDS.includes(section.id));

console.error("\n▶ 断言（结构优先正向）");
check("wiki.json 已写出", blueprint !== undefined, wikiJsonPath);
check("schemaVersion = 2", blueprint?.schemaVersion === 2, String(blueprint?.schemaVersion));
check("sectionsCount 已回传", result.sectionsCount === sections.length, `${result.sectionsCount} / ${sections.length}`);
check("pagesCount 已回传", result.pagesCount === pages.length, `${result.pagesCount} / ${pages.length}`);
check("failedSections 为空", result.failedSections === undefined, JSON.stringify(result.failedSections));

check(
	"分类清单含强制基础分类（Overview / Core Architecture）",
	["Overview", "Core Architecture"].every((title) => sections.some((section) => section.title === title)),
	JSON.stringify(sections.map((section) => section.title)),
);
check(
	"存在机器切出的结构分类（id 形如 sec-*）",
	structureSections.length >= 1,
	JSON.stringify(sections.map((section) => `${section.id}:${section.title}`)),
);
check(
	"每个页面的 section 都在分类清单里",
	pages.length > 0 && pages.every((page) => sections.some((section) => section.title === page.section)),
	JSON.stringify(pages.map((page) => `${page.slug}@${page.section}`)),
);
check(
	"每个结构分类至少有一个切片页",
	structureSections.every((section) => pages.some((page) => page.section === section.title)),
	JSON.stringify(structureSections.map((section) => section.title)),
);

const skeleton = skeletonSnapshot;
check(
	"结构阶段落盘后骨架即可加载（sections / pages 数量齐备，页面为机器标题）",
	skeleton !== undefined &&
		skeleton.sections.length === sections.length &&
		skeleton.pages.length === pages.length &&
		(skeleton.pages as Array<{ title: string }>).every((page) => !page.title.endsWith(NAMED_SUFFIX)),
	JSON.stringify(
		skeleton === undefined
			? null
			: { sections: skeleton.sections.length, pages: skeleton.pages.length },
	) + ` final sections=${sections.length} pages=${pages.length}`,
);

check(
	"slug/file 由代码分配（数字前缀 + .md）",
	pages.every((page) => /^\d+-[a-z0-9-]+$/.test(page.slug) && page.file === `${page.slug}.md`),
	JSON.stringify(pages.map((page) => `${page.slug}/${page.file}`)),
);
check(
	"页面命名写回生效（结构分类页标题带命名后缀）",
	pages.filter((page) => structureSections.some((section) => section.title === page.section)).every((page) => page.title.endsWith(NAMED_SUFFIX)),
	JSON.stringify(pages.map((page) => page.title)),
);
check(
	"页面命名写回 topicSummary",
	pages.every((page) => typeof page.topicSummary === "string" && page.topicSummary.length > 0),
	JSON.stringify(pages.map((page) => page.topicSummary)),
);
check(
	"难度等级被归一化（Beginner/Intermediate/Advanced）",
	pages.every((page) => ["Beginner", "Intermediate", "Advanced"].includes(page.level ?? "")),
	JSON.stringify(pages.map((page) => page.level)),
);
check(
	"结构分类页拥有源文件（ownsFiles 非空）",
	pages.filter((page) => structureSections.some((section) => section.title === page.section)).every((page) => (page.ownsFiles?.length ?? 0) > 0),
	JSON.stringify(pages.map((page) => `${page.slug}:${page.ownsFiles?.length ?? 0}`)),
);
check(
	"页面 ownsFiles 互斥（一文件只归一页）",
	new Set(pages.flatMap((page) => page.ownsFiles ?? [])).size === pages.flatMap((page) => page.ownsFiles ?? []).length,
	JSON.stringify(pages.flatMap((page) => page.ownsFiles ?? [])),
);

const stages = new Set(events.filter((event) => event.stage).map((event) => event.stage));
check(
	"进度事件带 stage（structure / sections / pages）",
	stages.has("structure") && stages.has("sections") && stages.has("pages"),
	[...stages].join(","),
);
check(
	"页面命名事件带分类级进度（total = 分类数）",
	events.some((event) => event.stage === "pages" && event.progressTotal === sections.length),
	JSON.stringify(events.filter((event) => event.progressTotal !== undefined).slice(0, 5)),
);

// 逐 Agent 行：每个 Agent 的事件带稳定 key / 角色 / 生命周期 / 行内用量 / 上下文窗口
// （UI 据此把「目录」展开成每个 Agent 一行）
const agentEvents = events.filter((event) => event.agentKey !== undefined);
const agentKeys = [...new Set(agentEvents.map((event) => event.agentKey))];
const sectionsKeys = [...new Set(agentEvents.filter((event) => event.agentRole === "sections").map((event) => event.agentKey))];
const pagesKeys = [...new Set(agentEvents.filter((event) => event.agentRole === "pages").map((event) => event.agentKey))];
check(
	"结构阶段有独立 Agent 行（agentKey=structure）",
	agentKeys.includes("structure"),
	JSON.stringify(agentKeys),
);
check(
	"分类命名只有 1 个 Agent 行（单 Agent）",
	sectionsKeys.length === 1,
	JSON.stringify(sectionsKeys),
);
check(
	"每个分类一个页面命名 Agent 行",
	pagesKeys.length === sections.length,
	JSON.stringify(pagesKeys),
);
check(
	"每个 Agent 行都有 running 与 completed 终态（UI 行状态依据）",
	pagesKeys.every(
		(key) =>
			agentEvents.some((event) => event.agentKey === key && event.agentStatus === "running") &&
			agentEvents.some((event) => event.agentKey === key && event.agentStatus === "completed"),
	),
	JSON.stringify(agentEvents.filter((event) => event.agentStatus === "completed").map((event) => event.agentKey)),
);
check(
	"Agent 事件带行内用量（agentUsage）",
	agentEvents.some((event) => (event.agentInputTokens ?? 0) > 0 && (event.agentOutputTokens ?? 0) > 0),
	JSON.stringify(agentEvents.find((event) => (event.agentInputTokens ?? 0) > 0) ?? null),
);
check(
	"Agent 事件带上下文窗口与上下文已用（回退模型默认 200k）",
	agentEvents.some((event) => event.contextWindow === 200000) &&
		agentEvents.some((event) => (event.contextTokens ?? 0) > 0),
	JSON.stringify(agentEvents.filter((event) => event.contextWindow !== undefined).slice(0, 2)),
);
const visitedSections = new Set(seenSections);
check(
	"每个分类都跑到了页面命名阶段",
	sections.every((section) => visitedSections.has(section.title)),
	[...visitedSections].join(","),
);

check("Aggregate tokenUsage 已回传", result.tokenUsage !== undefined, JSON.stringify(result.tokenUsage));
check(
	"跨 Agent 聚合用量 = 所有请求之和（不是最后一个 Agent）",
	result.tokenUsage?.input_tokens === totalInputTokens &&
		result.tokenUsage?.output_tokens === totalOutputTokens,
	`usage=${JSON.stringify(result.tokenUsage)} mockTotals=${totalInputTokens}/${totalOutputTokens} requests=${requestCount}`,
);
check("durationMs 已回传", typeof result.durationMs === "number" && result.durationMs >= 0, String(result.durationMs));

check(
	"目标仓库 AGENTS.md 被注入系统提示（<project_context> 块）",
	seenSystemPrompts.some(
		(prompt) =>
			prompt.includes("<project_context>") &&
			prompt.includes("repo-agents-context") &&
			prompt.includes(`<project_instructions path="${join(repo, "AGENTS.md")}">`),
	),
	`prompts=${seenSystemPrompts.length}`,
);
check(
	"全局 ~/.zread-pi/AGENTS.md 也注入，且排在项目上下文之前",
	seenSystemPrompts.some((prompt) => {
		const globalIndex = prompt.indexOf("global-agents-context");
		const projectIndex = prompt.indexOf("repo-agents-context");
		return globalIndex >= 0 && projectIndex >= 0 && globalIndex < projectIndex;
	}),
	`prompts=${seenSystemPrompts.length}`,
);
check(
	"文风纪律（humanizer）注入系统提示，且排在 <project_context> 之后",
	seenSystemPrompts.some(
		(prompt) =>
			prompt.includes("<writing_discipline>") &&
			prompt.indexOf("<writing_discipline>") > prompt.indexOf("<project_context>") &&
			prompt.includes("Writing discipline"),
	),
	`prompts=${seenSystemPrompts.length}`,
);

// ---------------------------------------------------------------------------
// 5) 失败语义：某分类不调用 submit_pages —— 记录 failedSections 但不阻断
// ---------------------------------------------------------------------------

mode = "section-skip";
skipSection = structureSections[0]?.title ?? "";
console.error(`\n▶ generateWikiCatalog()（「${skipSection}」不调用工具）…`);
const partialAgentEvents: Array<{ agentKey?: string; agentStatus?: string }> = [];
const partial = await generateWikiCatalog((event) => {
	partialAgentEvents.push({ agentKey: event.agentKey, agentStatus: event.agentStatus });
});
let partialBlueprint: Record<string, unknown> | undefined;
try {
	partialBlueprint = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as Record<string, unknown>;
} catch {
	partialBlueprint = undefined;
}
const partialPages = ((partialBlueprint?.pages as PageShape[] | undefined) ?? []).slice();

check(
	"失败分类被记录到 failedSections（pages）",
	partial.failedSections?.some((entry) => entry.section === skipSection && entry.stage === "pages") === true,
	JSON.stringify(partial.failedSections),
);
check("失败分类不阻断其余分类（页面数不变）", partialPages.length === pages.length, `实际 ${partialPages.length} / 期望 ${pages.length}`);
check("失败后 wiki.json 仍可加载", partialBlueprint !== undefined);
check("失败后 pagesCount 反映实际页面数", partial.pagesCount === pages.length, String(partial.pagesCount));
check(
	"失败分类的页面保留机器标题（不带命名后缀）",
	partialPages
		.filter((page) => page.section === skipSection)
		.every((page) => !page.title.endsWith(NAMED_SUFFIX)),
	JSON.stringify(partialPages.filter((page) => page.section === skipSection).map((page) => page.title)),
);
check(
	"未产出工具的分类其 Agent 行被标为 failed（业务判定，不是运行状态）",
	partialAgentEvents.some(
		(event) =>
			event.agentKey !== undefined &&
			event.agentKey === `pages:${skipSection}` &&
			event.agentStatus === "failed",
	),
	JSON.stringify(partialAgentEvents.filter((event) => event.agentStatus !== undefined).slice(-4)),
);

// ---------------------------------------------------------------------------
// 6) 失败语义 2：无可解析源文件 —— 结构层致命报错（D21，不静默回退）
// ---------------------------------------------------------------------------

mode = "no-structure";
const emptyRepo = await mkdtemp(join(tmpdir(), "zread-pi-empty-"));
await writeFile(join(emptyRepo, "README.md"), "# empty\n只有自述，没有可解析源文件。\n", "utf-8");
const structureErrorCwd = process.cwd();
process.chdir(emptyRepo);
const structureFailure = await generateWikiCatalog().then(
	() => null,
	(err: unknown) => (err instanceof Error ? err.message : String(err)),
);
check(
	"无可解析源文件时结构层致命报错",
	typeof structureFailure === "string" && structureFailure.includes("没有可解析的源文件"),
	structureFailure ?? "(未报错)",
);
process.chdir(structureErrorCwd);
await rm(emptyRepo, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 7) 模型大小覆盖：llm.context_window / llm.max_tokens 下发到运行时
// ---------------------------------------------------------------------------

mode = "ok";
await rm(wikiJsonPath, { force: true });
await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: en",
		"doc_language: en",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"  context_window: 99999",
		"  max_tokens: 1234",
		"concurrency:",
		"  max_concurrent: 4",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);
console.error("\n▶ generateWikiCatalog()（llm.context_window/max_tokens 覆盖）…");
const overrideEvents: Array<{ contextWindow?: number }> = [];
const overrideMaxTokensSeen = [...seenMaxTokens];
await generateWikiCatalog((event) => {
	if (event.contextWindow !== undefined) overrideEvents.push({ contextWindow: event.contextWindow });
});
check(
	"llm.context_window 覆盖模型目录值（system/init 上报 99999）",
	overrideEvents.some((event) => event.contextWindow === 99999),
	JSON.stringify(overrideEvents.slice(0, 2)),
);
check(
	"llm.max_tokens 作为请求输出上限下发（max_tokens=1234）",
	seenMaxTokens.slice(overrideMaxTokensSeen.length).includes(1234),
	JSON.stringify(seenMaxTokens.slice(overrideMaxTokensSeen.length).filter((value, index, array) => array.indexOf(value) === index)),
);


// ---------------------------------------------------------------------------
// 8) 捕获点：runLog 自动落盘 + 并发事件的 replay 归属（max_concurrent=4）
// ---------------------------------------------------------------------------

mode = "ok";
await rm(wikiJsonPath, { force: true });
console.error("\n▶ generateWikiCatalog()（runLog 自动落盘 + 并发归属）…");
const {
	listRuns,
	readEvents,
	readRunMeta,
	readSessionFacts,
} = await import("@zread-pi/utils");
const { replayRun } = await import("../../trajectory/src/index.js");
// 不传 runLog：withRunLog 自动建 run（与真实 CLI 路径一致）
// 失败时把根因带进断言 detail：withRunLog 只把异常记成 run failed，
// 断言本身看不到根因，间歇失败会无法定位
let scenario8Error = "(none)";
try {
	await generateWikiCatalog();
} catch (err) {
	scenario8Error = err instanceof Error ? err.message : String(err);
	console.error(`  ! generateWikiCatalog() 抛出：${scenario8Error}`);
}
const runs = await listRuns(repo);
check("runs 目录非空（自动创建 run）", runs.length > 0, `runs=${runs.length}`);
const latest = runs[0];
check(
	"run 状态 = completed",
	latest?.status === "completed",
	`${latest?.status ?? "(none)"}${scenario8Error !== "(none)" ? ` error=${scenario8Error}` : ""}`,
);
const runMeta = await readRunMeta(latest!.id, repo);
check("run.json 记录 kind=generate", runMeta?.kind === "generate");
check("run.json 记录 detail=high", runMeta?.detail === "high");
check("run.json 记录 model", typeof runMeta?.model === "string");

const { events: logEvents } = await readEvents(latest!.id, { limit: 600 }, repo);
check("events.jsonl 非空", logEvents.length > 0, `count=${logEvents.length}`);
const seqs = logEvents.map((event) => event.seq);
check("seq 从 1 开始单调递增", seqs.every((seq, index) => seq === index + 1));
check("首事件是 run_start", logEvents[0]?.kind === "run_start");
check("末事件是 run_end", logEvents[logEvents.length - 1]?.kind === "run_end");

// 事件携带 agent 身份与 sessionId（轨迹回放并发归属的依据）
const agentConfigs = logEvents.filter((event) => event.kind === "agent_config");
check(
	"有 agent_config 事件（1 分类 + N 页面命名；结构阶段是代码无 Agent）",
	agentConfigs.length === sections.length + 1,
	`count=${agentConfigs.length} 期望=${sections.length + 1}`,
);
const sessions = agentConfigs
	.map((event) => event.agent?.sessionId)
	.filter((value): value is string => typeof value === "string");
check("agent_config 全部携带 sessionId", sessions.length === agentConfigs.length, `missing=${agentConfigs.length - sessions.length}`);
check("各 Agent 的 sessionId 互不相同（并发会话隔离）", new Set(sessions).size === sessions.length, `${sessions.length} sessions`);
check("agent_config 携带 role / key", agentConfigs.every((event) => event.agent?.role !== undefined && event.agent?.key !== undefined));

// pi 会话目录：一个 Agent 一个会话文件（方案 C：会话 = 唯一完整事实源）
const facts = await readSessionFacts(latest!.id, repo);
check("会话文件数 = agent_config 数", facts.length === agentConfigs.length, `${facts.length} / ${agentConfigs.length}`);
const factIds = new Set(facts.map((fact) => fact.sessionId));
check("会话 id 与 agent_config 的 sessionId 一一对应", sessions.every((id) => factIds.has(id)), `matched=${sessions.filter((id) => factIds.has(id)).length}`);
// 内容事件已退役：events.jsonl 只剩瘦业务事件（内容在会话里）
const retiredKinds = new Set(["agent_start", "message_start", "message_delta", "message_end", "tool_start", "tool_end", "retry", "compact", "status"]);
const leaked = logEvents.filter((event) => retiredKinds.has(event.kind));
check("内容类事件不再出现在 events.jsonl", leaked.length === 0, `leaked=${leaked.length}`);

// provider 响应头的 request id 落进轨迹日志（排障关联：mock-req-<n> 每请求自增）
const providerRequests = logEvents.filter((event) => event.kind === "provider_request");
const requestIds = providerRequests
	.map((event) => (event.kind === "provider_request" ? event.requestId : undefined))
	.filter((value): value is string => typeof value === "string");
check(
	"provider_request 事件携带 requestId（provider 响应头）",
	providerRequests.length > 0 && requestIds.length === providerRequests.length,
	`with=${requestIds.length} / total=${providerRequests.length}`,
);
check(
	"requestId 与响应数一致且互不相同（每响应一个）",
	new Set(requestIds).size === requestIds.length && requestIds.every((id) => id.startsWith("mock-req-")),
	`${new Set(requestIds).size} unique / ${requestIds.length} total`,
);

// 真实捕获的事件流 + 会话文件直接回归方案 C 的 join（max_concurrent=4 交错）
const sessionSnapshot = replayRun({ events: logEvents, sessions: facts });
check("replay 的 turn 数 = agent_config 数", sessionSnapshot.turns.length === agentConfigs.length, `${sessionSnapshot.turns.length} / ${agentConfigs.length}`);
const assistantBySession = new Map(
	facts.map((fact) => [
		fact.sessionId,
		facts.length === 0 ? 0 : fact.entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length,
	]),
);
let mismatches = 0;
for (const turn of sessionSnapshot.turns) {
	const expected = assistantBySession.get(turn.sessionId);
	const actual = sessionSnapshot.records.filter((record) => record.kind === "message" && record.turn === turn.number).length;
	if (expected !== actual) mismatches += 1;
}
check(
	"端到端：会话内容按 sessionId 正确归入各 turn",
	mismatches === 0,
	`mismatch=${mismatches}`,
);

// 旧格式回退路径不抛错（无会话事实时走事件 replay；新 run 的内容事件已退役，
// 旧格式解析的覆盖在 trajectory-model / session-replay 里）
const snapshot = replayRun({ events: logEvents });
check("replay 在无会话事实时仍可运行", snapshot !== null && snapshot.records !== null);

server.stop(true);

process.chdir(join(repo, ".."));
await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.error(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
