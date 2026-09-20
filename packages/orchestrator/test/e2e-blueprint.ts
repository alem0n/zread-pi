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
/** 记录每次请求的输出上限（验证 llm.max_tokens 覆盖下发；openai-completions 依 compat 用 max_tokens 或 max_completion_tokens） */
const seenMaxTokens: Array<number | undefined> = [];
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
const { loadWikiBlueprint } = await import("@zread-pi/utils");

// 默认配置档位 high：产物落在变体子目录 `.zread-pi/wiki/high/`
const WIKI_DETAIL = "high";
const wikiJsonPath = join(repo, ".zread-pi", "wiki", WIKI_DETAIL, "wiki.json");

console.log("▶ generateWikiCatalog()（三阶段）…");
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
let skeletonCheck: Promise<{ pages: number; sections: number }> | undefined;

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
	if (event.stage === "classify" && event.type === "tool_result" && !skeletonCheck) {
		skeletonCheck = loadWikiBlueprint(undefined, WIKI_DETAIL).then((blueprint) => ({
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
check("页面数与主题阶段一致", pages.length === 9, `实际 ${pages.length}`);
check("sectionsCount 已回传", result.sectionsCount === 3, String(result.sectionsCount));
check("pagesCount 已回传", result.pagesCount === 9, String(result.pagesCount));
check("failedSections 为空", result.failedSections === undefined, JSON.stringify(result.failedSections));

check(
	"分类清单含强制基础分类（Overview/Core Architecture）",
	["Overview", "Core Architecture"].every((title) => sections.some((section) => section.title === title)),
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
	"分主题事件带分类级进度（total=3）",
	events.some((event) => event.stage === "topics" && event.progressTotal === 3),
	JSON.stringify(events.filter((event) => event.progressTotal !== undefined).slice(0, 5)),
);

// 逐 Agent 行：每个 Agent 的事件带稳定 key / 角色 / 生命周期 / 行内用量 / 上下文窗口
// （UI 据此把「目录」展开成每个 Agent 一行）
const agentEvents = events.filter((event) => event.agentKey !== undefined);
const agentKeys = [...new Set(agentEvents.map((event) => event.agentKey))];
const topicsKeys = [...new Set(agentEvents.filter((event) => event.agentRole === "topics").map((event) => event.agentKey))];
const titlesKeys = [...new Set(agentEvents.filter((event) => event.agentRole === "titles").map((event) => event.agentKey))];
check(
	"分类别 Agent 有独立行（agentKey=classify）",
	agentKeys.includes("classify"),
	JSON.stringify(agentKeys),
);
check(
	"每个分类一个主题 Agent 行（3 行）",
	topicsKeys.length === 3,
	JSON.stringify(topicsKeys),
);
check(
	"每个有页面的分类一个标题 Agent 行（3 行）",
	titlesKeys.length === 3,
	JSON.stringify(titlesKeys),
);
check(
	"每个 Agent 行都有 running 与 completed 终态（UI 行状态依据）",
	topicsKeys.every(
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
	"每个分类都跑到了主题/标题阶段",
	["Overview", "Core Architecture", "核心模块"].every((title) => visitedSections.has(title)),
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
		content.includes("分类数量反馈：当前 3 / 要求 3~8（当前档位：high）"),
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
	"失败分类被记录到 failedSections（topics）",
	partial.failedSections?.some((entry) => entry.section === "核心模块" && entry.stage === "topics") === true,
	JSON.stringify(partial.failedSections),
);
check("失败分类不阻断其余分类", partialPages.length === 6, `实际 ${partialPages.length}`);
check("失败后 wiki.json 仍可加载", partialBlueprint !== undefined);
check("失败后 pagesCount 反映实际页面数", partial.pagesCount === 6, String(partial.pagesCount));
check(
	"未产出工具的分类其 Agent 行被标为 failed（业务判定，不是运行状态）",
	partialAgentEvents.some(
		(event) =>
			event.agentKey !== undefined &&
			event.agentKey.includes("核心模块") &&
			event.agentKey.startsWith("topics:") &&
			event.agentStatus === "failed",
	),
	JSON.stringify(partialAgentEvents.filter((event) => event.agentStatus !== undefined).slice(-4)),
);

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
console.log("\n▶ generateWikiCatalog()（llm.context_window/max_tokens 覆盖）…");
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
console.log("\n▶ generateWikiCatalog()（runLog 自动落盘 + 并发归属）…");
const {
	listRuns,
	readEvents,
	readRunMeta,
} = await import("@zread-pi/utils");
const { replayRunEvents } = await import("../../trajectory/src/index.js");
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
const agentStarts = logEvents.filter((event) => event.kind === "agent_start");
check("有 agent_start 事件（1 分类 + N 主题 + N 标题）", agentStarts.length >= 7, `count=${agentStarts.length}`);
const sessions = agentStarts
	.map((event) => event.agent?.sessionId)
	.filter((value): value is string => typeof value === "string");
check("agent_start 全部携带 sessionId", sessions.length === agentStarts.length, `missing=${agentStarts.length - sessions.length}`);
check("各 Agent 的 sessionId 互不相同（并发会话隔离）", new Set(sessions).size === sessions.length, `${sessions.length} sessions`);
check("agent_start 携带 role / key", agentStarts.every((event) => event.agent?.role !== undefined && event.agent?.key !== undefined));

// provider 响应头的 request id 落进轨迹日志（排障关联：mock-req-<n> 每请求自增）
const messageEnds = logEvents.filter((event) => event.kind === "message_end");
const requestIds = messageEnds
	.map((event) => (event.kind === "message_end" ? event.requestId : undefined))
	.filter((value): value is string => typeof value === "string");
check(
	"message_end 事件携带 requestId（provider 响应头）",
	requestIds.length === messageEnds.length && messageEnds.length > 0,
	`with=${requestIds.length} / total=${messageEnds.length}`,
);
check(
	"requestId 与请求数一致且互不相同（每响应一个）",
	new Set(requestIds).size === requestIds.length && requestIds.every((id) => id.startsWith("mock-req-")),
	`${new Set(requestIds).size} unique / ${requestIds.length} total`,
);

// 真实捕获的交错事件流直接即回归 replay 并发归属
const snapshot = replayRunEvents(logEvents);
const seqToKey = new Map<number, string>();
for (const event of logEvents) {
	if (event.agent !== undefined && event.agent.role !== "run") seqToKey.set(event.seq, event.agent.key);
}
let misattributed = 0;
for (const record of snapshot.records) {
	const expected = seqToKey.get(record.seq);
	if (expected !== undefined && record.turnKey !== expected) misattributed += 1;
}
check(
	"端到端：max_concurrent=4 的交错事件流 replay 归托全部正确",
	misattributed === 0,
	`misattributed=${misattributed} / ${snapshot.records.length} records`,
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


