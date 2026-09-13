/**
 * e2e-blueprint.ts —— Orchestrator 蓝图三阶段端到端验证（分类 → 分主题 → 标题）
 *
 * 链路：generateWikiCatalog()
 *   -> 阶段 1 分类：submit_sections 写 wiki.json 骨架（sections + 空 pages）
 *   -> 阶段 2 分主题：每个 section 一个 Agent，submit_section_topics 增量归并页面
 *   -> 阶段 3 标题：每个 section 一个 Agent，refine_section_titles 写回精修标题
 *   -> 最后校验 wiki.json 可加载
 *
 * mock LLM 依据请求里的工具名区分四个角色（classify / topics / titles / page）。
 *
 * 运行：bun run packages/orchestrator/test/e2e-blueprint.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
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
// 2) 启动 mock OpenAI 兼容服务（按工具名分派四个角色）
// ---------------------------------------------------------------------------

const SECTIONS = [
	{ title: "Overview", description: "项目定位与速览" },
	{ title: "Quick Start", description: "安装配置与最小示例" },
	{ title: "Core Architecture", description: "整体架构与模块协作" },
	{ title: "核心模块", description: "问候模块的实现细节" },
];

const TOPICS: Record<string, Array<Record<string, unknown>>> = {
	Overview: [
		{
			title: "项目概览",
			slug: "project-overview",
			level: "Beginner",
			associatedFiles: ["README.md"],
		},
		{
			title: "核心特性速览",
			slug: "feature-tour",
			level: "Beginner",
			associatedFiles: ["src/"],
		},
		{
			title: "设计目标与边界",
			slug: "design-goals",
			level: "Intermediate",
			associatedFiles: ["README.md"],
		},
	],
	"Quick Start": [
		{
			title: "快速开始指南",
			slug: "quick-start",
			level: "Beginner",
			associatedFiles: ["src/greet.ts"],
		},
		{
			title: "环境与安装",
			slug: "environment-setup",
			level: "Beginner",
			associatedFiles: ["src/greet.ts"],
		},
		{
			title: "最小可运行示例",
			slug: "minimal-example",
			level: "Beginner",
			associatedFiles: ["src/greet.ts"],
		},
	],
	"Core Architecture": [
		{
			title: "整体架构设计",
			slug: "architecture",
			level: "Intermediate",
			associatedFiles: ["src/"],
		},
		{
			title: "模块职责划分",
			slug: "module-responsibilities",
			level: "Intermediate",
			associatedFiles: ["src/"],
		},
		{
			title: "数据流与调用链",
			slug: "data-flow",
			level: "Advanced",
			associatedFiles: ["src/"],
		},
	],
	核心模块: [
		{
			title: "问候模块实现",
			slug: "greet-module",
			level: "Intermediate",
			associatedFiles: ["src/greet.ts"],
		},
		{
			title: "问候模块 API",
			slug: "greet-api",
			level: "Intermediate",
			associatedFiles: ["src/greet.ts"],
		},
		{
			title: "问候模块扩展点",
			slug: "greet-extension",
			level: "Advanced",
			associatedFiles: ["src/greet.ts"],
		},
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

/** 场景：ok（正常三阶段）| no-sections（分类不调工具）| section-skip（某分类不调工具） */
let mode: "ok" | "no-sections" | "section-skip" = "ok";
/** 记录每次请求的 system 消息（验证上下文文件注入） */
const seenSystemPrompts: string[] = [];
const seenSections: string[] = [];
/** 记录工具结果内容（验证常驻数量反馈） */
const seenToolResults: string[] = [];
let requestCount = 0;
/** 单次请求的 mock 用量（断言「跨 Agent 聚合」时按请求数换算） */
let totalInputTokens = 0;
let totalOutputTokens = 0;

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		requestCount += 1;
		const body = (await request.json()) as {
			messages?: Array<{ role?: string; content?: unknown }>;
			tools?: Array<{ function?: { name?: string } }>;
		};
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
		for (const message of messages) {
			if (message.role === "tool") seenToolResults.push(contentToText(message.content));
		}
		const section = /^- 分类: ([^\n]+)$/m.exec(promptText)?.[1]?.trim() ?? "";
		if (section) seenSections.push(section);

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					if (toolNames.has("submit_sections")) {
						if (mode === "no-sections") {
							write(textChunk("分类完成"));
						} else {
							write(toolCall("call_sections", "submit_sections", { sections: SECTIONS }));
						}
					} else if (toolNames.has("submit_section_topics")) {
						if (mode === "section-skip" && section === "核心模块") {
							write(textChunk("本分类暂不规划"));
						} else {
							write(
								toolCall(`call_topics_${section}`, "submit_section_topics", {
									section,
									topics: TOPICS[section] ?? [],
								}),
							);
						}
					} else if (toolNames.has("refine_section_titles")) {
						const titles = [...promptText.matchAll(/^- ([a-z0-9-]+): ([^\[\n（]+)/gm)].map((match) => ({
							slug: match[1],
							title: `${match[2].trim()}（精修）`,
						}));
						write(toolCall(`call_titles_${section}`, "refine_section_titles", { section, titles }));
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

		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
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
const { loadWikiBlueprint } = await import("@zread-pi/utils");

const wikiJsonPath = join(repo, ".zread-pi", "wiki", "wiki.json");

console.log("▶ generateWikiCatalog()（三阶段）…");
const events: Array<{ type: string; stage?: string; section?: string; progressTotal?: number }> = [];
let skeletonCheck: Promise<{ pages: number; sections: number }> | undefined;

const result = await generateWikiCatalog((event) => {
	events.push({
		type: event.type,
		stage: event.stage,
		section: event.section,
		progressTotal: event.progress?.total,
	});
	if (event.stage === "classify" && event.type === "tool_result" && !skeletonCheck) {
		skeletonCheck = loadWikiBlueprint().then((blueprint) => ({
			pages: blueprint.pages.length,
			sections: blueprint.sections?.length ?? 0,
		}));
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
	associatedFiles?: string[];
}

const pages = ((blueprint?.pages as PageShape[] | undefined) ?? []).slice();
const sections = ((blueprint?.sections as Array<{ title: string }> | undefined) ?? []).slice();

console.log("\n▶ 断言（三阶段正向）");
check("wiki.json 已写出", blueprint !== undefined, wikiJsonPath);
check("页面数与主题阶段一致", pages.length === 12, `实际 ${pages.length}`);
check("sectionsCount 已回传", result.sectionsCount === 4, String(result.sectionsCount));
check("pagesCount 已回传", result.pagesCount === 12, String(result.pagesCount));
check("failedSections 为空", result.failedSections === undefined, JSON.stringify(result.failedSections));

check(
	"分类清单含强制基础分类（Overview/Quick Start/Core Architecture）",
	["Overview", "Quick Start", "Core Architecture"].every((title) =>
		sections.some((section) => section.title === title),
	),
	JSON.stringify(sections.map((section) => section.title)),
);
check(
	"模型新增的“核心模块”分类被保留",
	sections.some((section) => section.title === "核心模块"),
	JSON.stringify(sections.map((section) => section.title)),
);
check(
	"阶段 1 落盘后骨架即可加载（sections 非空、pages 为空）",
	skeletonCheck !== undefined,
);
const skeleton = skeletonCheck ? await skeletonCheck : undefined;
check(
	"骨架快照：sections>=3 且 pages=0",
	skeleton !== undefined && skeleton.sections >= 3 && skeleton.pages === 0,
	JSON.stringify(skeleton),
);

check(
	"slug/file 由代码分配（数字前缀 + .md）",
	pages.every((page) => /^\d+-[a-z0-9-]+$/.test(page.slug) && page.file === `${page.slug}.md`),
	JSON.stringify(pages.map((page) => `${page.slug}/${page.file}`)),
);
check(
	"标题阶段写回生效（全部标题被精修）",
	pages.every((page) => page.title.endsWith("（精修）")),
	JSON.stringify(pages.map((page) => page.title)),
);
check(
	"每个页面的 section 都在分类清单里",
	pages.every((page) => sections.some((section) => section.title === page.section)),
	JSON.stringify(pages.map((page) => `${page.slug}@${page.section}`)),
);
check(
	"难度等级被归一化（Beginner/Intermediate/Advanced）",
	pages.every((page) => ["Beginner", "Intermediate", "Advanced"].includes(page.level ?? "")),
	JSON.stringify(pages.map((page) => page.level)),
);

const stages = new Set(events.filter((event) => event.stage).map((event) => event.stage));
check(
	"进度事件带 stage（classify / topics / titles）",
	stages.has("classify") && stages.has("topics") && stages.has("titles"),
	[...stages].join(","),
);
check(
	"分主题事件带分类级进度（total=4）",
	events.some((event) => event.stage === "topics" && event.progressTotal === 4),
	JSON.stringify(events.filter((event) => event.progressTotal !== undefined).slice(0, 5)),
);
const visitedSections = new Set(seenSections);
check(
	"每个分类都跑到了主题/标题阶段",
	["Overview", "Quick Start", "Core Architecture", "核心模块"].every((title) => visitedSections.has(title)),
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
	"submit_sections 成功结果带常驻数量反馈（区间内也发）",
	seenToolResults.some((content) =>
		content.includes("分类数量反馈：当前 4 / 要求 4~8（当前档位：high）"),
	),
	seenToolResults.filter((content) => content.includes("数量反馈")).slice(0, 2).join(" || "),
);
check(
	"submit_section_topics 成功结果带常驻数量反馈（区间内也发）",
	seenToolResults.some((content) =>
		content.includes("文章数量反馈：当前 3 / 要求 3~10（当前档位：high）"),
	),
	seenToolResults.filter((content) => content.includes("数量反馈")).slice(0, 2).join(" || "),
);

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
// 5) 失败语义 1：某分类不调用 submit_section_topics —— 记录 failedSections 但不阻断
// ---------------------------------------------------------------------------

mode = "section-skip";
console.log("\n▶ generateWikiCatalog()（核心模块不调用工具）…");
const partial = await generateWikiCatalog();
let partialBlueprint: Record<string, unknown> | undefined;
try {
	partialBlueprint = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as Record<string, unknown>;
} catch {
	partialBlueprint = undefined;
}
const partialPages = ((partialBlueprint?.pages as PageShape[] | undefined) ?? []).slice();

check(
	"失败分类被记录到 failedSections（topics）",
	partial.failedSections?.some((entry) => entry.section === "核心模块" && entry.stage === "topics") === true,
	JSON.stringify(partial.failedSections),
);
check("失败分类不阻断其余分类", partialPages.length === 9, `实际 ${partialPages.length}`);
check("失败后 wiki.json 仍可加载", partialBlueprint !== undefined);
check("失败后 pagesCount 反映实际页面数", partial.pagesCount === 9, String(partial.pagesCount));

// ---------------------------------------------------------------------------
// 6) 失败语义 2：分类阶段不产出 sections —— 必须报错
// ---------------------------------------------------------------------------

mode = "no-sections";
await rm(wikiJsonPath, { force: true });
console.log("\n▶ generateWikiCatalog()（分类不调用 submit_sections）…");
const sectionsFailure = await generateWikiCatalog().then(
	() => null,
	(err: unknown) => (err instanceof Error ? err.message : String(err)),
);
check(
	"分类阶段未产出有效 wiki.json 时报错",
	typeof sectionsFailure === "string" && sectionsFailure.includes("wiki.json"),
	sectionsFailure ?? "(未报错)",
);

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


