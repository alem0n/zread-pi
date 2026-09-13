/**
 * blueprint-detail.ts —— 蓝图细节档位（blueprint.detail）验证
 *
 * A) 纯函数：五档规格 / 数量判定与常驻反馈 / 归并策略 / 缩编提示词 / 代码兜底 /
 *    minimal 单分类分支 / 提示词参数化。
 * B) 输出工具（无 LLM）：区间内也带数量反馈、越界不落盘且返回策略、两次未收敛 exhausted、
 *    minimal 确定性收尾、sync merge 上限语义（既有分类必留）。
 * C) mock LLM 端到端：
 *    C1 分类越界两次 → 缩编 subagent 收敛并落盘（第 3 轮成功径）；
 *    C2 某分类主题越界两次 → 缩编失败 → 代码兜底（每 group 保 1 再按序填充，日志带兜底注记）；
 *    C3 minimal：单分类 + 单篇 + 跳过标题精修。
 *
 * 运行：bun run packages/orchestrator/test/blueprint-detail.ts
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuantityToolState } from '../src/agents/blueprint-detail.js';
import type { WikiSection, WikiTopic } from '@zread-pi/types';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 0) 临时 HOME / 目标仓库 + mock LLM 服务（先于动态 import，logger 路径落在临时 HOME）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "zread-pi-detail-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-detail-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "README.md"), "# detail-fixture\n", "utf-8");

/** 基础分类（与代码强补的标题一致） */
const BASE_SECTIONS = [
	{ title: "概览", description: "项目定位与整体速览" },
	{ title: "快速开始", description: "安装与运行示例" },
	{ title: "核心架构", description: "核心模块与实现细节" },
];

/** C1：分类越界提交（9 个 > high 上限 8） */
const OVER_SECTIONS = [
	...BASE_SECTIONS,
	{ title: "领域A", description: "领域 A 说明" },
	{ title: "领域B", description: "领域 B 说明" },
	{ title: "领域C", description: "领域 C 说明" },
	{ title: "领域D", description: "领域 D 说明" },
	{ title: "领域E", description: "领域 E 说明" },
	{ title: "领域F", description: "领域 F 说明" },
];

/** C1：缩编 subagent 返回的收敛清单（5 个业务分类；落盘时再强补 3 个基础分类 → 8） */
const CONDENSED_SECTIONS = [
	{ title: "合并域A", description: "由领域 A/B 合并" },
	{ title: "合并域B", description: "由领域 C/D 合并" },
	{ title: "合并域C", description: "由领域 E 合并" },
	{ title: "合并域D", description: "补充的架构暗线" },
	{ title: "合并域E", description: "补充的运维链路" },
];

/** C2：合规分类（4 个，含核心模块） */
const COMPLIANT_SECTIONS = [...BASE_SECTIONS, { title: "核心模块", description: "问候模块实现" }];

/** C3：minimal 下模型仍返回 4 个分类（应被代码收敛到「概览」） */
const FOUR_SECTIONS = [...COMPLIANT_SECTIONS];

/** C2：核心模块的越界主题（12 篇 > high 上限 10；每 6 篇一个 group，验证 group-first 兜底） */
const OVER_TOPICS = Array.from({ length: 12 }, (_, index) => ({
	title: `主题${index + 1}`,
	slug: `topic-${index + 1}`,
	group: index < 6 ? "g1" : "g2",
	level: "Intermediate",
	associatedFiles: ["README.md"],
}));

function topicsFor(section: string): Array<Record<string, unknown>> {
	if (section === "核心模块") return OVER_TOPICS;
	return [1, 2, 3].map((index) => ({
		title: `${section}主题${index}`,
		slug: `${section === "概览" ? "overview" : section === "快速开始" ? "quickstart" : section === "核心架构" ? "architecture" : "topic"}-${index}`,
		level: "Intermediate",
		associatedFiles: ["README.md"],
	}));
}

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

type Scenario = "condense-ok" | "condense-fail" | "minimal";
let scenario: Scenario = "condense-ok";
/** 每次请求携带的工具集（逗号分隔） */
const seenToolSets: string[] = [];
/** 所有请求的文本（system + user + tool 结果），用于断言提示词与策略文本 */
const seenPromptTexts: string[] = [];
/** 工具结果内容（断言常驻反馈与策略文本） */
const seenToolResults: string[] = [];
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
		const toolNames = new Set(
			(body.tools ?? [])
				.map((tool) => tool?.function?.name)
				.filter((name): name is string => typeof name === "string"),
		);
		seenToolSets.push([...toolNames].sort().join(","));

		const promptText = messages.map((message) => contentToText(message.content)).join("\n");
		seenPromptTexts.push(promptText);
		for (const message of messages) {
			if (message.role === "tool") seenToolResults.push(contentToText(message.content));
		}

		const hasToolResult = messages.some((message) => message.role === "tool");
		const lastToolMessage = [...messages].reverse().find((message) => message.role === "tool");
		const lastToolText = lastToolMessage ? contentToText(lastToolMessage.content) : "";
		const section = /^- 分类: ([^\n]+)$/m.exec(promptText)?.[1]?.trim() ?? "";
		const retryWanted =
			(lastToolText.includes("超出上限") || lastToolText.includes("数量不足")) &&
			!lastToolText.includes("已连续");

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (toolNames.has("submit_condensed_sections")) {
					// 第 3 轮：缩编分类（condense-ok 返回收敛清单；condense-fail 不调用工具）
					if (scenario === "condense-ok" && !hasToolResult) {
						write(toolCall("call_condensed", "submit_condensed_sections", { sections: CONDENSED_SECTIONS }));
					} else {
						write(textChunk("不缩编"));
					}
				} else if (toolNames.has("submit_condensed_topics")) {
					// 缩编主题：本套用例一律不调用工具（验证失败降级到代码兜底）
					write(textChunk("不缩编"));
				} else if (toolNames.has("submit_sections")) {
					if (!hasToolResult) {
						const payload = scenario === "minimal" ? FOUR_SECTIONS : scenario === "condense-fail" ? COMPLIANT_SECTIONS : OVER_SECTIONS;
						write(toolCall("call_sections", "submit_sections", { sections: payload }));
					} else if (retryWanted) {
						// 原对话不收敛地再次提交（触发第 2 次越界 → exhausted）
						const payload = scenario === "minimal" ? FOUR_SECTIONS : scenario === "condense-fail" ? COMPLIANT_SECTIONS : OVER_SECTIONS;
						write(toolCall("call_sections_2", "submit_sections", { sections: payload }));
					} else {
						write(textChunk("停止重提"));
					}
				} else if (toolNames.has("submit_section_topics")) {
					if (!hasToolResult) {
						write(toolCall(`call_topics_${section}`, "submit_section_topics", { section, topics: topicsFor(section) }));
					} else if (retryWanted && section === "核心模块") {
						write(toolCall(`call_topics_${section}_2`, "submit_section_topics", { section, topics: OVER_TOPICS }));
					} else {
						write(textChunk("停止重提"));
					}
				} else if (toolNames.has("refine_section_titles")) {
					if (hasToolResult) {
						write(textChunk("标题完成"));
					} else {
						const titles = [...promptText.matchAll(/^- ([a-z0-9-]+): ([^\[\n（]+)/gm)].map((match) => ({
							slug: match[1],
							title: match[2].trim(),
						}));
						write(toolCall(`call_titles_${section}`, "refine_section_titles", { section, titles }));
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
		"  max_concurrent: 4",
		"  max_retries: 0",
		"",
	].join("\n"),
	"utf-8",
);

/** 场景切换时改写 blueprint.detail（loadConfig 每次都重新读盘） */
async function writeHomeConfig(detail?: "minimal" | "high"): Promise<void> {
	const lines = [
		"language: zh",
		"doc_language: zh",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
	];
	if (detail) lines.push("blueprint:", `  detail: ${detail}`);
	lines.push("concurrency:", "  max_concurrent: 4", "  max_retries: 0", "");
	await writeFile(join(home, ".zread-pi", "config.yaml"), lines.join("\n"), "utf-8");
}

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ZREAD_PI_HOME = join(home, ".zread-pi");
process.chdir(repo);

const {
	getDetailSpec,
	judgeQuantity,
	formatQuantityFeedback,
	buildSectionQuantityStrategy,
	buildTopicsQuantityStrategy,
	buildCondenseSectionTask,
	buildCondenseTopicsTask,
	codeFallbackSections,
	condenseTopicsToMax,
	BLUEPRINT_DETAIL_SPECS,
	MAX_QUANTITY_FEEDBACK_ROUNDS,
	QUANTITY_FALLBACK_NOTE,
	MINIMAL_PANORAMA_REQUIREMENT,
} = await import("../src/agents/blueprint-detail.js");
const { renderClassifyPrompt } = await import("../src/prompts/classify.js");
const { renderTopicsPrompt } = await import("../src/prompts/topics.js");
const {
	createSubmitSectionsTool,
	createSubmitSectionTopicsTool,
	createSubmitCondensedSectionsTool,
	createSubmitCondensedTopicsTool,
} = await import("../src/tools/output-tools.js");
const {
	loadConfig,
	loadWikiBlueprint,
	initWikiSkeleton,
	normalizeBlueprintSections,
	getWikiJsonPath,
	getLogFile,
} = await import("@zread-pi/utils");
const { generateWikiCatalog } = await import("../src/orchestrator.js");

const ctx = { cwd: repo, abortSignal: new AbortController().signal } as never;
const wikiJsonPath = getWikiJsonPath();
const resetWiki = async (): Promise<void> => {
	await rm(join(repo, ".zread-pi"), { recursive: true, force: true });
};
const wikiExists = async (): Promise<boolean> =>
	readFile(wikiJsonPath, "utf-8").then(
		() => true,
		() => false,
	);

// ---------------------------------------------------------------------------
// A) 纯函数
// ---------------------------------------------------------------------------

console.log("\n▶ A) 档位纯函数");

const minimal = getDetailSpec("minimal");
const low = getDetailSpec("low");
const medium = getDetailSpec("medium");
const high = getDetailSpec("high");
const max = getDetailSpec("max");

check(
	"A1 minimal 规格：1 分类 / 1 篇 / 跳标题 / 全景导览",
	minimal.sections.min === 1 &&
		minimal.sections.max === 1 &&
		minimal.topics.min === 1 &&
		minimal.topics.max === 1 &&
		!minimal.refineTitles &&
		minimal.panorama &&
		!minimal.exhaustive,
	JSON.stringify(minimal),
);
check(
	"A1 low 规格：3~5 / 1~3 / 跳标题",
	low.sections.min === 3 && low.sections.max === 5 && low.topics.min === 1 && low.topics.max === 3 && !low.refineTitles,
	JSON.stringify(low),
);
check(
	"A1 medium 规格：4~6 / 3~5 / 保留标题",
	medium.sections.min === 4 && medium.sections.max === 6 && medium.topics.min === 3 && medium.topics.max === 5 && medium.refineTitles,
	JSON.stringify(medium),
);
check(
	"A1 high 规格（默认）：4~8 / 3~10",
	high.sections.min === 4 && high.sections.max === 8 && high.topics.min === 3 && high.topics.max === 10 && high.refineTitles,
	JSON.stringify(high),
);
check(
	"A1 max 规格：4~8 / 5~12 / exhaustive",
	max.sections.min === 4 && max.sections.max === 8 && max.topics.min === 5 && max.topics.max === 12 && max.exhaustive && max.refineTitles,
	JSON.stringify(max),
);
check("A1 非法档位回退 high", getDetailSpec("bogus").level === "high");
check("A1 五档规格齐全", Object.keys(BLUEPRINT_DETAIL_SPECS).length === 5, Object.keys(BLUEPRINT_DETAIL_SPECS).join(","));

check("A2 区间内 ok", judgeQuantity(5, { min: 4, max: 8 }) === "ok");
check("A2 不足判 under", judgeQuantity(3, { min: 4, max: 8 }) === "under");
check("A2 超限判 over", judgeQuantity(9, { min: 4, max: 8 }) === "over");
check("A2 sync 忽略下限", judgeQuantity(1, { min: 4, max: 8 }, { enforceMin: false }) === "ok");
check(
	"A2 常驻反馈格式（区间内也发）",
	formatQuantityFeedback({ kind: "sections", count: 8, spec: high }) === "分类数量反馈：当前 8 / 要求 4~8（当前档位：high）",
	formatQuantityFeedback({ kind: "sections", count: 8, spec: high }),
);
check(
	"A2 minimal 反馈显示固定 1",
	formatQuantityFeedback({ kind: "topics", count: 1, spec: minimal }).includes("要求 1（固定）"),
);
check(
	"A2 sync 反馈注明只校验上限",
	formatQuantityFeedback({ kind: "sections", count: 6, spec: high, upperBoundOnly: true }).includes("只校验上限"),
);

check(
	"A3 分类过多策略：基础分类永不归并 + 请求重提",
	buildSectionQuantityStrategy("over", high).includes("基础分类") &&
		buildSectionQuantityStrategy("over", high).includes("重新调用 submit_sections"),
);
check(
	"A3 分类不足策略：拆分 / 补充",
	buildSectionQuantityStrategy("under", high).includes("拆分") && buildSectionQuantityStrategy("under", high).includes("补充"),
);
check(
	"A3 sync 分类策略：既有必留",
	buildSectionQuantityStrategy("over", high, { sync: true }).includes("既有分类必须全部保留") &&
		buildSectionQuantityStrategy("over", high, { sync: true }).includes("不得超上限"),
);
check(
	"A3 主题过多策略：保留高密度核心机制",
	buildTopicsQuantityStrategy("over", high).includes("同一领域的不同平台") &&
		buildTopicsQuantityStrategy("over", high).includes("高密度核心机制"),
);
check(
	"A3 sync 主题策略：旧页面逐字保留",
	buildTopicsQuantityStrategy("over", high, { sync: true }).includes("逐字保留"),
);

{
	const task = buildCondenseSectionTask({
		spec: high,
		sections: [{ title: "概览", description: "定位" }, { title: "领域A", description: "A" }],
	});
	check(
		"A4 缩编分类任务：数量 / 清单 / 输出工具",
		task.includes("要求数量为 4~8") && task.includes("- 概览：定位") && task.includes("submit_condensed_sections"),
	);
	check("A4 缩编分类任务（不足）：给拆分/补充规则", task.includes("拆成更细的子领域"));
	const overTask = buildCondenseSectionTask({
		spec: high,
		sections: Array.from({ length: 12 }, (_, index) => ({ title: `领域${index + 1}` })),
	});
	check("A4 缩编分类任务（过多）：给归并规则", overTask.includes("优先合并同一领域") && overTask.includes("永不合并"));
	const syncTask = buildCondenseSectionTask({
		spec: low,
		sections: [{ title: "领域A" }],
		sync: true,
	});
	check("A4 缩编分类任务（sync）：既有必留", syncTask.includes("既有分类必须全部保留"));
}
{
	const task = buildCondenseTopicsTask({
		spec: high,
		section: "核心架构",
		topics: [{ title: "主题1", group: "g1", associatedFiles: ["src/a.ts"] }],
	});
	check(
		"A4 缩编主题任务：数量 / 清单 / 输出工具",
		task.includes("分类「核心架构」") && task.includes("3~10") && task.includes("submit_condensed_topics") && task.includes("主题1"),
	);
}

{
	const many = ["领域A", "领域B", "领域C", "领域D", "领域E", "领域F"].map((title) => ({ title }));
	const fallback = codeFallbackSections({ input: many, language: "zh", spec: high });
	check(
		"A5 代码兜底：基础分类保序取前 N",
		fallback.length === 8 &&
			fallback[0].title === "概览" &&
			fallback[1].title === "快速开始" &&
			fallback[2].title === "核心架构" &&
			fallback[3].title === "领域A",
		JSON.stringify(fallback.map((section) => section.title)),
	);
	const minimalFallback = codeFallbackSections({ input: many, language: "zh", spec: minimal });
	check(
		"A5 minimal 代码兜底：只保留概览",
		minimalFallback.length === 1 && minimalFallback[0].title === "概览",
		JSON.stringify(minimalFallback),
	);
	const syncFallback = codeFallbackSections({
		input: many,
		language: "zh",
		spec: high,
		existing: [{ title: "概览" }, { title: "快速开始" }, { title: "核心架构" }, { title: "既有领域" }, { title: "既有领域2" }, { title: "既有领域3" }, { title: "既有领域4" }, { title: "既有领域5" }],
	});
	check(
		"A5 sync 代码兜底：既有分类必留且不超上限",
		syncFallback.length === 8 && syncFallback.every((section) => section.title.startsWith("既有") || section.title === "概览" || section.title === "快速开始" || section.title === "核心架构"),
		JSON.stringify(syncFallback.map((section) => section.title)),
	);
}

{
	const topics: WikiTopic[] = [
		{ title: "A1", group: "g1" },
		{ title: "A2", group: "g1" },
		{ title: "B1", group: "g2" },
		{ title: "A3", group: "g1" },
		{ title: "B2", group: "g2" },
		{ title: "C1" },
		{ title: "C2" },
	];
	const kept = condenseTopicsToMax(topics, 4);
	check(
		"A6 主题代码兜底：每 distinct group 保 1 篇再按序填充",
		kept.map((topic) => topic.title).join(",") === "A1,B1,C1,C2",
		kept.map((topic) => topic.title).join(","),
	);
	const preserved = condenseTopicsToMax(
		[{ title: "X1" }, { title: "X2" }, { title: "KEEP" }, { title: "X3" }],
		2,
		{ preserveTitles: ["keep"] },
	);
	check(
		"A6 sync 代码兜底：preserveTitles 优先保留",
		preserved.map((topic) => topic.title).join(",") === "KEEP,X1",
		preserved.map((topic) => topic.title).join(","),
	);
	check("A6 不超上限时原样返回", condenseTopicsToMax(topics, 10).length === 7);
}

{
	const zhMinimal = normalizeBlueprintSections([{ title: "任意" }, { title: "来源" }], "zh", 8, { minimal: true });
	check(
		"A7 normalizeBlueprintSections minimal：只保留概览",
		zhMinimal.length === 1 && zhMinimal[0].title === "概览",
		JSON.stringify(zhMinimal),
	);
	const enMinimal = normalizeBlueprintSections([], "en", 8, { minimal: true });
	check("A7 英文 minimal：Overview", enMinimal.length === 1 && enMinimal[0].title === "Overview", JSON.stringify(enMinimal));
	const zhDefault = normalizeBlueprintSections([{ title: "领域A" }], "zh", 8);
	check(
		"A7 非 minimal：仍强补三个基础分类",
		zhDefault.length === 4 && zhDefault[3].title === "领域A",
		JSON.stringify(zhDefault.map((section) => section.title)),
	);
}

{
	const classifyHigh = renderClassifyPrompt({ spec: high });
	const classifyMinimal = renderClassifyPrompt({ spec: minimal });
	const classifyMax = renderClassifyPrompt({ spec: max });
	check("A8 分类提示词 high：数量目标 4~8", classifyHigh.includes("数量 4~8 个"), "");
	check(
		"A8 分类提示词 minimal：固定 1 个概览",
		classifyMinimal.includes("数量固定 1 个") && classifyMinimal.includes("只输出「概览」这一个分类"),
	);
	check("A8 分类提示词 max：全面详尽附加要求", classifyMax.includes("全面详尽"));

	const topicsLow = renderTopicsPrompt({ spec: low });
	const topicsMax = renderTopicsPrompt({ spec: max });
	check("A8 主题提示词 low：1~3 篇", topicsLow.includes("1~3 篇"));
	check(
		"A8 主题提示词 max：5~12 篇 + 深挖关联文件",
		topicsMax.includes("5~12 篇") && topicsMax.includes("深挖关联路径"),
	);
}

check("A9 minimal 全景导览要求写死了 Mermaid 架构图", MINIMAL_PANORAMA_REQUIREMENT.includes("Mermaid 架构图") && MINIMAL_PANORAMA_REQUIREMENT.includes("quoted label"));
check("A9 越界上限轮数 = 2", MAX_QUANTITY_FEEDBACK_ROUNDS === 2);
check("A9 兜底注记文案", QUANTITY_FALLBACK_NOTE === "（已达到调整轮次上限，代码侧收尾）");

// ---------------------------------------------------------------------------
// B) 输出工具（无 LLM）
// ---------------------------------------------------------------------------

console.log("\n▶ B) 输出工具（越界不落盘 / 常驻反馈 / 代码收尾）");

{
	await resetWiki();
	const state: QuantityToolState<WikiSection[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionsTool({ detail: "high", state });

	const first = await tool.call({ sections: OVER_SECTIONS }, ctx);
	const firstText = String(first.content);
	check("B1 越界提交：不报错（is_error 未置位）", first.is_error !== true);
	check(
		"B1 越界提交：带数量反馈（当前 9 / 要求 4~8）",
		firstText.includes("分类数量反馈：当前 9 / 要求 4~8（当前档位：high）"),
		firstText.split("\n")[0],
	);
	check("B1 越界提交：返回归并策略并请求重提", firstText.includes("分类数超出上限") && firstText.includes("重新调用 submit_sections"));
	check("B1 越界提交：不落盘", !(await wikiExists()));
	check("B1 越界提交：state.outOfRange=1 且未 persisted", state.outOfRange === 1 && !state.persisted);

	const compliant = [...BASE_SECTIONS, { title: "领域A" }, { title: "领域B" }, { title: "领域C" }, { title: "领域D" }, { title: "领域E" }];
	const second = await tool.call({ sections: compliant }, ctx);
	const secondText = String(second.content);
	check("B1 第 2 轮合规：落盘成功", state.persisted === true);
	check("B1 第 2 轮合规：反馈当前 8", secondText.includes("分类数量反馈：当前 8 / 要求 4~8（当前档位：high）"));
	const blueprint = await loadWikiBlueprint();
	check("B1 第 2 轮合规：wiki.json sections=8", blueprint.sections?.length === 8, JSON.stringify(blueprint.sections?.map((section) => section.title)));
}

{
	await resetWiki();
	const state: QuantityToolState<WikiSection[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionsTool({ detail: "high", state });
	await tool.call({ sections: OVER_SECTIONS }, ctx);
	const second = await tool.call({ sections: OVER_SECTIONS }, ctx);
	check(
		"B2 两次越界：exhausted 且标记连续 2 次未收敛",
		state.exhausted === true && state.outOfRange === 2 && String(second.content).includes("已连续 2 次未收敛"),
		String(second.content).split("\n").find((line) => line.includes("未收敛")) ?? "",
	);
	check("B2 两次越界：仍未落盘", !(await wikiExists()));
}

{
	await resetWiki();
	const state: QuantityToolState<WikiSection[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionsTool({ detail: "minimal", state });
	const result = await tool.call({ sections: FOUR_SECTIONS }, ctx);
	const text = String(result.content);
	const blueprint = await loadWikiBlueprint();
	check(
		"B3 minimal：模型 4 个分类被代码收敛为「概览」",
		blueprint.sections?.length === 1 && blueprint.sections[0].title === "概览",
		JSON.stringify(blueprint.sections?.map((section) => section.title)),
	);
	check("B3 minimal：数量反馈显示固定 1", text.includes("要求 1（固定）"));
	check("B3 minimal：结果带代码收尾注记", text.includes(QUANTITY_FALLBACK_NOTE));
	check("B3 minimal：直接 persisted（无归并轮次）", state.persisted === true && state.outOfRange === 0);
}

{
	await resetWiki();
	const config = await loadConfig();
	await initWikiSkeleton(
		[...BASE_SECTIONS, { title: "领域A" }, { title: "领域B" }],
		config,
	);
	const state: QuantityToolState<WikiSection[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionsTool({ merge: true, detail: "low", state });

	const over = await tool.call({ sections: [{ title: "领域C" }, { title: "领域D" }] }, ctx);
	const overText = String(over.content);
	check(
		"B4 sync：越界（既有 5 + 新增 2 > 上限 5）返回 sync 策略",
		overText.includes("分类数超出上限") && overText.includes("sync") && overText.includes("既有分类必须全部保留"),
		overText.split("\n")[0],
	);
	const before = await loadWikiBlueprint();
	check("B4 sync：越界不落盘（仍 5 个分类）", before.sections?.length === 5, JSON.stringify(before.sections?.map((section) => section.title)));

	const ok = await tool.call({ sections: [{ title: "领域A" }] }, ctx);
	const after = await loadWikiBlueprint();
	const titles = (after.sections ?? []).map((section) => section.title);
	check("B4 sync：既有分类必留 + 合规合并成功", state.persisted === true && titles.includes("领域A") && titles.includes("领域B") && titles.length === 5, JSON.stringify(titles));
	check("B4 sync：成功结果带只校验上限的数量反馈", String(ok.content).includes("只校验上限"));
}

{
	await resetWiki();
	const config = await loadConfig();
	await initWikiSkeleton([...BASE_SECTIONS], config);
	const state: QuantityToolState<WikiTopic[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionTopicsTool({ title: "核心架构" }, { detail: "high", state });

	const over = await tool.call({ section: "核心架构", topics: OVER_TOPICS }, ctx);
	const overText = String(over.content);
	check(
		"B5 主题越界：策略文本 + 数量反馈",
		overText.includes("本分类主题数超出上限") && overText.includes("文章数量反馈：当前 12 / 要求 3~10（当前档位：high）"),
		overText.split("\n")[0],
	);
	const before = await loadWikiBlueprint();
	check("B5 主题越界：不落盘（pages=0）", before.pages.length === 0);

	await tool.call({ section: "核心架构", topics: OVER_TOPICS.slice(0, 4) }, ctx);
	const after = await loadWikiBlueprint();
	check("B5 第 2 轮合规：落盘 4 篇", state.persisted === true && after.pages.length === 4, `pages=${after.pages.length}`);
}

{
	await resetWiki();
	const config = await loadConfig();
	await initWikiSkeleton([...BASE_SECTIONS], config);
	const state: QuantityToolState<WikiTopic[]> = { called: false, persisted: false, outOfRange: 0, exhausted: false };
	const tool = createSubmitSectionTopicsTool({ title: "概览" }, { detail: "minimal", state });
	const result = await tool.call({ section: "概览", topics: topicsFor("概览") }, ctx);
	const blueprint = await loadWikiBlueprint();
	check(
		"B6 minimal 主题：只保留首篇 + 代码收尾注记",
		state.persisted === true && blueprint.pages.length === 1 && blueprint.pages[0].title === "概览主题1" && String(result.content).includes(QUANTITY_FALLBACK_NOTE),
		JSON.stringify(blueprint.pages.map((page) => page.title)),
	);
}

{
	const captured: { sections?: WikiSection[] } = {};
	const tool = createSubmitCondensedSectionsTool(captured);
	check("B7 缩编分类工具：只读、不落盘", tool.isReadOnly?.() === true);
	await tool.call({ sections: CONDENSED_SECTIONS }, ctx);
	check("B7 缩编分类工具：捕获结果", captured.sections?.length === CONDENSED_SECTIONS.length);

	const topicCapture: { topics?: WikiTopic[] } = {};
	const topicTool = createSubmitCondensedTopicsTool({ title: "核心架构" }, topicCapture);
	await topicTool.call({ section: "核心架构", topics: [{ title: "T1" }] }, ctx);
	check("B7 缩编主题工具：捕获结果", topicCapture.topics?.[0]?.title === "T1");
}

// ---------------------------------------------------------------------------
// C) mock LLM 端到端：缩编成功 / 缩编失败降级 / minimal
// ---------------------------------------------------------------------------

console.log("\n▶ C1) 分类越界 → 缩编 subagent 收敛");
{
	scenario = "condense-ok";
	await writeHomeConfig("high");
	await resetWiki();
	const result = await generateWikiCatalog();
	const blueprint = await loadWikiBlueprint();
	const titles = (blueprint.sections ?? []).map((section) => section.title);
	check(
		"C1 缩编结果落盘（基础 3 + 缩编 5 = 8）",
		titles.length === 8 && ["合并域A", "合并域B", "合并域C", "合并域D", "合并域E"].every((title) => titles.includes(title)),
		JSON.stringify(titles),
	);
	check(
		"C1 缩编 subagent 被真实调用（干净工具面）",
		seenToolSets.some((set) => set.includes("submit_condensed_sections")),
	);
	check(
		"C1 越界策略进入原对话（带数量反馈）",
		seenToolResults.some((text) => text.includes("分类数超出上限") && text.includes("分类数量反馈：当前 9 / 要求 4~8")),
	);
	check(
		"C1 两次不收敛后不再要求重提",
		seenToolResults.some((text) => text.includes("已连续 2 次未收敛")),
	);
	check("C1 最终页面数 = 8 分类 × 3 = 24", result.pagesCount === 24, String(result.pagesCount));
	check("C1 无失败分类", result.failedSections === undefined, JSON.stringify(result.failedSections));
}

console.log("\n▶ C2) 主题越界 → 缩编失败 → 代码兜底");
{
	scenario = "condense-fail";
	await writeHomeConfig("high");
	await resetWiki();
	const result = await generateWikiCatalog();
	const blueprint = await loadWikiBlueprint();
	const corePages = blueprint.pages.filter((page) => page.section === "核心模块");
	const keptTitles = corePages.map((page) => page.title);
	check(
		"C2 主题越界两次后代码兜底到上限 10 篇",
		corePages.length === 10,
		`pages=${corePages.length}`,
	);
	check(
		"C2 兜底保留每 group 首篇（g1/g2）并丢弃尾部",
		keptTitles.includes("主题1") && keptTitles.includes("主题7") && !keptTitles.includes("主题11") && !keptTitles.includes("主题12"),
		JSON.stringify(keptTitles),
	);
	check(
		"C2 主题越界策略进入原对话",
		seenToolResults.some((text) => text.includes("本分类主题数超出上限") && text.includes("文章数量反馈：当前 12 / 要求 3~10")),
	);
	const log = await readFile(getLogFile(), "utf-8").catch(() => "");
	check(
		"C2 兜底注记写入日志（已达到调整轮次上限，代码侧收尾）",
		log.includes(QUANTITY_FALLBACK_NOTE) && log.includes("代码兜底"),
		log.split("\n").filter((line) => line.includes("代码兜底")).slice(-1)[0] ?? "(无)",
	);
	check("C2 无失败分类（兜底不算页失败）", result.failedSections === undefined, JSON.stringify(result.failedSections));
}

console.log("\n▶ C3) minimal：单分类 + 单篇 + 跳过标题精修");
{
	scenario = "minimal";
	await writeHomeConfig("minimal");
	await resetWiki();
	const markTools = seenToolSets.length;
	const markPrompts = seenPromptTexts.length;
	const markResults = seenToolResults.length;
	const result = await generateWikiCatalog();
	const blueprint = await loadWikiBlueprint();
	check(
		"C3 只保留「概览」一个分类",
		blueprint.sections?.length === 1 && blueprint.sections[0].title === "概览",
		JSON.stringify(blueprint.sections?.map((section) => section.title)),
	);
	check("C3 只产出一篇全景导览", blueprint.pages.length === 1 && result.pagesCount === 1, `pages=${blueprint.pages.length}`);
	check(
		"C3 跳过标题精修阶段",
		!seenToolSets.slice(markTools).some((set) => set.includes("refine_section_titles")),
		seenToolSets.slice(markTools).filter((set) => set.includes("refine")).join("|") || "(无)",
	);
	check(
		"C3 分类提示词带 minimal 档位（固定 1 个）",
		seenPromptTexts.slice(markPrompts).some((text) => text.includes("数量固定 1 个") && text.includes("只输出「概览」这一个分类")),
	);
	check("C3 分类结果带代码收尾注记", seenToolResults.slice(markResults).some((text) => text.includes(QUANTITY_FALLBACK_NOTE)));
	check("C3 请求数可控（无缩编线程）", requestCount > 0, `requests=${requestCount}`);
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
