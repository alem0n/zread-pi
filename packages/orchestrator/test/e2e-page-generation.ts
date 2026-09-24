/**
 * e2e-page-generation.ts —— 并行页面生成端到端验证（多 Agent + p-limit + write_page 工具）
 *
 * 链路：generateWikiContent({ pages, maxConcurrent: 3 })
 *   -> 每个页面一个独立 Agent（业务并发模型未改动）
 *   -> @zread-pi/agent-runtime 适配层 -> pi Agent 循环
 *   -> mock LLM 返回 write_page 工具调用
 *   -> 真实工具执行：写出 .zread-pi/wiki/<variant>/<section>/<file>
 *
 * 运行：bun run packages/orchestrator/test/e2e-page-generation.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPage } from "@zread-pi/types";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const home = await mkdtemp(join(tmpdir(), "zread-pi-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });
await mkdir(join(repo, "src"), { recursive: true });
await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");

/** 默认配置档位 high：页面产物落在 `.zread-pi/wiki/high/` */
const wikiDir = join(repo, ".zread-pi", "wiki", "high");

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
	{
		slug: "1-overview",
		title: "概览",
		file: "1-overview.md",
		section: "入门指南",
		level: "Beginner",
		topicSummary: "以 src/a.ts 为证，说明项目的最小可用形态",
	},
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

/** 故意不调用 write_page（只输出文字），用于验证「Agent 正常结束但页面未落盘」被计为失败 */
const noWritePage = {
	slug: "5-no-write",
	title: "未落盘",
	file: "5-no-write.md",
	section: "参考",
	level: "Beginner",
};

/** 故意漏传 file/section（只传 slug），文件会落到 wiki 根，用于验证落盘兜底移回约定位置 */
const misplacedPage = {
	slug: "6-misplaced",
	title: "错位路径",
	file: "6-misplaced.md",
	section: "参考",
	level: "Beginner",
};

/**
 * 故意一直探索、不调用 write_page，直到 token 预算耗尽：
 * 用于验证「预算耗尽 → before_run_end 强制交卷 → 仍无产物 → 编排层照旧判页失败」
 */
const budgetPage = {
	slug: "7-budget",
	title: "预算耗尽",
	file: "7-budget.md",
	section: "参考",
	level: "Beginner",
};

/** 预算页的工具轮数（一直调 ls 探索，从不交卷） */
let budgetPageRounds = 0;

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
		const isNoWritePage = promptText.includes(noWritePage.slug);
		const isMisplacedPage = promptText.includes(misplacedPage.slug);
		const isBudgetPage = promptText.includes(budgetPage.slug);
		const page =
			(pages.find((candidate) => promptText.includes(candidate.slug)) ?? pages[0]) as
				| (typeof pages)[number]
				| typeof badPage
				| typeof noWritePage
				| typeof misplacedPage;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));
				if (isBudgetPage) {
					// 预算页：前三轮一直调 ls 探索（从不调 write_page），之后才给出文字收尾；
					// token 预算耗尽后工具会被 before_tool 熔断，最后仍无产物。
					budgetPageRounds += 1;
					if (budgetPageRounds <= 3) {
						write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
						write(
							chunk(
								baseChunk(
									{
										tool_calls: [
											{
												index: 0,
												id: `call_budget_${budgetPageRounds}`,
												type: "function",
												function: { name: "ls", arguments: JSON.stringify({ path: "." }) },
											},
										],
									},
									"tool_calls",
								),
							),
						);
					} else {
						write(chunk(baseChunk({ role: "assistant", content: "预算耗尽，仍未产出页面" }, null)));
						write(chunk(baseChunk({}, "stop")));
					}
				} else if (isNoWritePage) {
					// 不调工具，直接给出最终答复（模拟模型忘记/放弃调用 write_page）
					write(chunk(baseChunk({ role: "assistant", content: "未落盘 完成" }, null)));
					write(chunk(baseChunk({}, "stop")));
				} else if (!hasToolResult) {
					write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
					// misplacedPage 刻意漏传 file/section：模型把页面写到 .zread-pi/wiki/<variant>/<slug>.md
					const writeArgs = isMisplacedPage
						? {
							slug: page.slug,
							title: page.title,
							content: `# ${page.title}\n\n由 pi 驱动生成。\n`,
						}
						: {
							slug: page.slug,
							file: page.file,
							section: page.section,
							title: page.title,
							content: isBadPage ? badPageContent : `# ${page.title}\n\n由 pi 驱动生成。\n`,
						};
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
												arguments: JSON.stringify(writeArgs),
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
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: en",
		"doc_language: en",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		// token 预算：每次 mock 响应计 40 tokens（30+10）→ 120 tokens 时正好耗尽
		"agent:",
		"  token_budget: 120",
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

const { generateWikiContent, buildPagePrompt } = await import("../src/wiki/generate-wiki.js");
const { getDetailSpec } = await import("../src/agents/blueprint-detail.js");

const progress: string[] = [];
const events: string[] = [];
// 事件级用量快照：用于验证失败路径也带上「最后一次累计用量」（底部合计的依据）
const eventUsages = new Map<string, { input_tokens: number; output_tokens: number } | undefined>();
// 事件级上下文报表值：用于验证每个页面的「已用 / 窗口」（UI 的上下文占比依据）
const eventContexts = new Map<string, { contextTokens?: number; contextWindow?: number }>();
console.log("▶ generateWikiContent({ maxConcurrent: 3 }) …");
const result = await generateWikiContent({
	pages: [...pages, badPage, noWritePage, misplacedPage, budgetPage],
	maxConcurrent: 3,
	onEvent: (event) => {
		events.push(`${event.type}:${event.slug}`);
		eventUsages.set(
			`${event.type}:${event.slug}`,
			event.usage ? { input_tokens: event.usage.input_tokens, output_tokens: event.usage.output_tokens } : undefined,
		);
		eventContexts.set(`${event.type}:${event.slug}`, {
			contextTokens: event.contextTokens,
			contextWindow: event.contextWindow,
		});
	},
	onProgress: (state) => {
		progress.push(`${state.completed}/${state.total}`);
	},
});

server.stop(true);

console.log("\n▶ 断言");
const files = [
	join(wikiDir, "入门指南", "1-overview.md"),
	join(wikiDir, "入门指南", "2-arch.md"),
	join(wikiDir, "参考", "3-api.md"),
];
const contents = await Promise.all(files.map((file) => readFile(file, "utf-8").catch(() => "")));
check(
	"三个正常页面都被真实写出（按 section 分目录）",
	contents.every((content) => content.includes("由 pi 驱动生成")),
	contents.map((content) => content.slice(0, 18)).join(" | "),
);
check("frontmatter 标题被写入", contents[0].includes('title: "概览"'), contents[0].split("\n")[1] ?? "");
check(
	"并发任务：4 页成功，3 页因未落盘/预算耗尽被计为失败",
	result.completed === 4 && result.failed === 3,
	`completed=${result.completed} failed=${result.failed} (${result.results.map((entry) => `${entry.slug}:${entry.success}`).join(", ")})`,
);
check(
	"非法 Mermaid 被 WritePageTool 拦截：页面未落盘，其它页面不受影响",
	(await readFile(join(wikiDir, "参考", "4-bad-mermaid.md"), "utf-8").catch(() => "")) === "" &&
		contents.every((content) => content.includes("由 pi 驱动生成")),
	`badPageWritten=${(await readFile(join(wikiDir, "参考", "4-bad-mermaid.md"), "utf-8").catch(() => "")) !== ""}`,
);
check("进度回调被触发", progress.length >= 1, progress.join(","));
check(
	"非法 Mermaid 页面发出 page_error 且带原因",
	events.includes(`page_error:${badPage.slug}`) &&
		result.results.some((entry) => entry.slug === badPage.slug && entry.success === false),
	result.results.find((entry) => entry.slug === badPage.slug)?.error ?? "(无结果)",
);
check(
	"未调用 write_page 的页面发出 page_error（不再误报完成）",
	events.includes(`page_error:${noWritePage.slug}`) &&
		events.includes(`page_start:${noWritePage.slug}`) &&
		!events.includes(`page_complete:${noWritePage.slug}`),
	result.results.find((entry) => entry.slug === noWritePage.slug)?.error ?? "(无结果)",
);

// ---- 落盘兜底：write_page 写错路径时移回 wiki.json 约定位置 ----
const misplacedTarget = join(wikiDir, "参考", "6-misplaced.md");
const misplacedWrongPath = join(wikiDir, "6-misplaced.md");
const misplacedContent = await readFile(misplacedTarget, "utf-8").catch(() => "");
check(
	"write_page 写错路径时被兜底移动到 wiki.json 约定位置",
	misplacedContent.includes("由 pi 驱动生成"),
	misplacedContent.slice(0, 18) || "(目标文件不存在)",
);
check(
	"兜底成功后计为完成并发出 page_complete（不再误报失败）",
	events.includes(`page_complete:${misplacedPage.slug}`) &&
		result.results.some((entry) => entry.slug === misplacedPage.slug && entry.success === true),
	result.results.find((entry) => entry.slug === misplacedPage.slug)?.error ??
		`outputPath=${result.results.find((entry) => entry.slug === misplacedPage.slug)?.outputPath}`,
);
check(
	"错误路径不再残留文件",
	(await readFile(misplacedWrongPath, "utf-8").catch(() => "")) === "",
);
check("每个页面都发生了真实模型调用（>=8 次请求）", requests >= 8, `requests=${requests}`);

// ---- 预算耗尽：before_run_end 强制交卷后仍无 write_page → 编排层判页失败 ----
const budgetTarget = join(wikiDir, "参考", budgetPage.file);
const budgetResult = result.results.find((entry) => entry.slug === budgetPage.slug);
check(
	"预算耗尽且仍无 write_page：页面计为失败并发出 page_error",
	events.includes(`page_start:${budgetPage.slug}`) &&
		events.includes(`page_error:${budgetPage.slug}`) &&
		budgetResult?.success === false,
	budgetResult?.error ?? "(无结果)",
);
check(
	"失败原因来自内核的预算耗尽分类（编排层不依赖内核细节）",
	budgetResult?.error?.includes("Token budget exhausted") === true,
	budgetResult?.error ?? "(无结果)",
);
check(
	"预算耗尽的页面没有落盘",
	(await readFile(budgetTarget, "utf-8").catch(() => "")) === "",
	`budgetPageWritten=${(await readFile(budgetTarget, "utf-8").catch(() => "")) !== ""}`,
);
check(
	"预算耗尽后探索轮数有限（3 轮探索 + 1 轮熔断后收尾 + 1 轮强制交卷）",
	budgetPageRounds === 5,
	`budgetPageRounds=${budgetPageRounds}`,
);
check(
	"page_error 带上最后一次累计用量（失败页也计入合计）",
	(eventUsages.get(`page_error:${budgetPage.slug}`)?.input_tokens ?? 0) >= 120,
	JSON.stringify(eventUsages.get(`page_error:${budgetPage.slug}`) ?? null),
);
check(
	"页面事件带上下文报表值（已用 / 窗口；回退模型默认 200k）",
	(eventContexts.get(`page_complete:${pages[0].slug}`)?.contextTokens ?? 0) > 0 &&
		eventContexts.get(`page_complete:${pages[0].slug}`)?.contextWindow === 200000,
	JSON.stringify(eventContexts.get(`page_complete:${pages[0].slug}`) ?? null),
);
check(
	"失败页的 page_error 也带上下文报表值（失败行仍可显示上下文占比）",
	(eventContexts.get(`page_error:${budgetPage.slug}`)?.contextTokens ?? 0) > 0 &&
		eventContexts.get(`page_error:${budgetPage.slug}`)?.contextWindow === 200000,
	JSON.stringify(eventContexts.get(`page_error:${budgetPage.slug}`) ?? null),
);

// ---- blueprint.detail = minimal：页面提示词附加「全景导览」段（传递断言）----
{
	const minimalPrompt = buildPagePrompt(pages[0], getDetailSpec("minimal"));
	const highPrompt = buildPagePrompt(pages[0], getDetailSpec("high"));
	check(
		"minimal 档位：页面提示词附加「全景导览」段（Mermaid 架构图 + 数据流）",
		minimalPrompt.includes("全景导览附加要求") &&
			minimalPrompt.includes("Mermaid 架构图") &&
			minimalPrompt.includes("数据流"),
	);
	check("high 档位：页面提示词不附加全景导览段", !highPrompt.includes("全景导览附加要求"));
	check(
		"附加段不破坏既有段落（任务元数据 / 输出路径规范仍在）",
		minimalPrompt.includes("**Slug**: 1-overview") &&
			minimalPrompt.includes("输出路径规范") &&
			minimalPrompt.includes("write_page"),
	);

	const promptWithSummary = buildPagePrompt(pages[0], getDetailSpec("high"));
	const promptWithoutSummary = buildPagePrompt(pages[1], getDetailSpec("high"));
	check(
		"页面提示词注入主题摘要（topicSummary）",
		promptWithSummary.includes("**主题摘要**: 以 src/a.ts 为证，说明项目的最小可用形态"),
		promptWithSummary.split("\n").find((line) => line.includes("主题摘要")) ?? "(无)",
	);
	check(
		"页面提示词带范围纪律（主题摘要 + 关联路径划定范围）",
		promptWithSummary.includes("**范围纪律**:") && promptWithSummary.includes("不得超出"),
	);
	check(
		"旧产物无 topicSummary：省略摘要行，其余段落仍在",
		!promptWithoutSummary.includes("**主题摘要**:") &&
			promptWithoutSummary.includes("**关联路径**:") &&
			promptWithoutSummary.includes("**范围纪律**:"),
	);
}

// ---- 结构优先蓝图 v2：页面提示词注入 owns / refs / 缝合线三块（链 D）----
{
	const ownsPage: WikiPage = {
		...pages[0],
		ownsFiles: ["src/a.ts", "README.md"],
		refs: [
			{ path: "src/b.ts", reason: "import 来自 src/a.ts", ownerSlug: "2-arch" },
			{ path: "src/c.ts", reason: "reexport 来自 src/a.ts", ownerSlug: "3-api" },
		],
	};
	const prompt = buildPagePrompt(ownsPage, getDetailSpec("high"));
	check(
		"注入「本页拥有」块（ownsFiles 逐条列出）",
		prompt.includes("**本页拥有（ownsFiles）**:") &&
			prompt.includes("- src/a.ts") &&
			prompt.includes("- README.md"),
		prompt.split("\n").filter((line) => line.includes("ownsFiles") || line.startsWith("- src/")).join(" | "),
	);
	check(
		"注入「跨页引用」块（path / reason / ownerSlug 三要素）",
		prompt.includes("**跨页引用（refs）**:") &&
			prompt.includes("`src/b.ts`（import 来自 src/a.ts，归属页面 `2-arch`）"),
		prompt.split("\n").find((line) => line.includes("src/b.ts")) ?? "(无)",
	);
	check(
		"注入「缝合线」块（跨切片依赖 grounding 取数）",
		prompt.includes("**触及本页的缝合线**:") &&
			prompt.includes("`src/b.ts` ← 归属 `2-arch` 的缝合线"),
	);
	check(
		"三块都在范围纪律之后、输出路径规范之前",
		prompt.indexOf("**范围纪律**:") < prompt.indexOf("**本页拥有（ownsFiles）**:") &&
			prompt.indexOf("**触及本页的缝合线**:") < prompt.indexOf("## 输出路径规范"),
	);

	// 缺省时是空段而非删块（旧产物无 ownsFiles / refs）
	const legacyPrompt = buildPagePrompt(pages[1], getDetailSpec("high"));
	check(
		"旧产物无 ownsFiles / refs：三块仍在，且给出空段文案",
		legacyPrompt.includes("**本页拥有（ownsFiles）**:") &&
			legacyPrompt.includes("（无独占文件") &&
			legacyPrompt.includes("**跨页引用（refs）**:") &&
			legacyPrompt.includes("（无跨页引用）") &&
			legacyPrompt.includes("**触及本页的缝合线**:") &&
			legacyPrompt.includes("（本页文件未触及跨切片缝合线）"),
		legacyPrompt.split("\n").filter((line) => line.includes("（无") || line.includes("未触及")).join(" | "),
	);
}

process.chdir(join(repo, ".."));
await rm(repo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
