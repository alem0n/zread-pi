/**
 * page-polish.ts —— 页面级 polish 后处理（第 2 层兜底）端到端验证
 *
 * 链路：generateWikiContent({ pages }) -> 页面 Agent 调 write_page 落盘
 *   -> polishPageFile：同一模型换一套系统提示（纪律 + Embedded mode），工具只给 Read / Edit / Ls
 *   -> 真实 Edit 工具改文件 -> Mermaid 复检：改坏则回滚；Agent 失败不判页失败
 *
 * 覆盖：
 *  - polish.mode = 'full'：正常润色生效、polish 提示含纪律、页面系统提示含 <writing_discipline>
 *  - Mermaid 被 polish 改坏 -> 回滚到润色前内容并记 mermaid-rollback（页面仍成功）
 *  - polish 不调用 Edit -> no-change（页面仍成功）
 *  - polish Agent 请求失败 -> error（页面仍成功，文件保持原样）
 *  - polish.mode = 'prompt-only'：只注入纪律，不再调用 polish Agent
 *  - polish.enabled = false：连纪律块都不注入
 *
 * 运行：bun run packages/orchestrator/test/page-polish.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const home = await mkdtemp(join(tmpdir(), "zread-pi-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-repo-"));
await mkdir(join(home, ".zread-pi"), { recursive: true });

// ---------------------------------------------------------------------------
// 页面定义
// ---------------------------------------------------------------------------

const originalProse = "此外，这是一个至关重要的组件——它展示了持久的价值。";
const polishedProse = "这个组件负责渲染页面。";
const mermaidFence = ["```mermaid", "flowchart TB", '  A["用户(输入)"] --> B["结果"]', "```"].join("\n");

const pages = [
	{ slug: "1-good", title: "润色页", file: "1-good.md", section: "参考", level: "Beginner" },
	{ slug: "2-mermaid", title: "图表页", file: "2-mermaid.md", section: "参考", level: "Beginner" },
	{ slug: "3-nochange", title: "无改动页", file: "3-nochange.md", section: "参考", level: "Beginner" },
	{ slug: "4-fail", title: "失败页", file: "4-fail.md", section: "参考", level: "Beginner" },
	{ slug: "5-promptonly", title: "仅提示页", file: "5-promptonly.md", section: "参考", level: "Beginner" },
	{ slug: "6-disabled", title: "关闭页", file: "6-disabled.md", section: "参考", level: "Beginner" },
];

const pageContent = (slug: string): string => {
	switch (slug) {
		case "1-good":
			return `# 润色页\n\n${originalProse}`;
		case "2-mermaid":
			return `# 图表页\n\n${mermaidFence}\n\n正文。`;
		case "3-nochange":
			return "# 无改动页\n\n正文。";
		case "4-fail":
			return "# 失败页\n\n正文。";
		default:
			return `# ${slug}\n\n正文。`;
	}
};

const pagePath = (slug: string): string => {
	const page = pages.find((candidate) => candidate.slug === slug)!;
	return join(repo, ".zread-pi", "wiki", "high", page.section, page.file);
};

// ---------------------------------------------------------------------------
// mock LLM：区分「页面 Agent」与「polish Agent」（后者系统提示含 Embedded mode）
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

function sse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const text of chunks) controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function usageChunk(): string {
	return chunk({
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "mock-model",
		choices: [],
		usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
	});
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): string[] => [
	chunk(baseChunk({ role: "assistant", content: "" }, null)),
	chunk(
		baseChunk(
			{
				tool_calls: [
					{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
				],
			},
			"tool_calls",
		),
	),
	usageChunk(),
	"data: [DONE]\n\n",
];

const finalText = (text: string): string[] => [
	chunk(baseChunk({ role: "assistant", content: text }, null)),
	chunk(baseChunk({}, "stop")),
	usageChunk(),
	"data: [DONE]\n\n",
];

let pageRequests = 0;
let polishRequests = 0;
const polishSystemPrompts: string[] = [];
const pageSystemPrompts: string[] = [];

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as {
			messages?: Array<{ role?: string; content?: unknown }>;
		};
		const messages = body.messages ?? [];
		const system = messages.find((message) => message.role === "system")?.content;
		const systemText = typeof system === "string" ? system : "";
		const isPolish = systemText.includes("Embedded mode");
		const promptText = JSON.stringify(messages.find((message) => message.role === "user")?.content ?? "");
		const hasToolResult = messages.some((message) => message.role === "tool");
		const slug = pages.map((page) => page.slug).find((candidate) => promptText.includes(candidate));

		if (isPolish) {
			polishRequests += 1;
			polishSystemPrompts.push(systemText);
			// polish Agent 请求失败：页面必须仍然成功（polish 是增强不是必需）
			if (slug === "4-fail") {
				return new Response("polish upstream boom", { status: 500 });
			}
			if (hasToolResult) return sse(finalText("POLISHED"));
			if (slug === "1-good") {
				return sse(
					toolCall("call_polish_good", "Edit", {
						file_path: pagePath("1-good"),
						old_string: originalProse,
						new_string: polishedProse,
					}),
				);
			}
			if (slug === "2-mermaid") {
				// 故意把合法引号标签改成裸写（Edit 工具不做 Mermaid 校验，由 polish 后的复检兜底）
				return sse(
					toolCall("call_polish_mermaid", "Edit", {
						file_path: pagePath("2-mermaid"),
						old_string: 'A["用户(输入)"]',
						new_string: "A[用户(输入)]",
					}),
				);
			}
			return sse(finalText("NO_CHANGE"));
		}

		pageRequests += 1;
		pageSystemPrompts.push(systemText);
		if (hasToolResult) return sse(finalText(`${slug ?? "page"} 完成`));
		const page = pages.find((candidate) => candidate.slug === slug) ?? pages[0];
		return sse(
			toolCall(`call_${page.slug}`, "write_page", {
				slug: page.slug,
				file: page.file,
				section: page.section,
				title: page.title,
				content: pageContent(page.slug),
			}),
		);
	},
});

function configYaml(polishLines: string[]): string {
	return [
		"language: en",
		"doc_language: zh",
		"llm:",
		"  provider: openai-compatible",
		"  model: mock-model",
		"  api_key: sk-mock",
		`  base_url: http://127.0.0.1:${server.port}/v1`,
		"agent:",
		"  max_turns: 30",
		"polish:",
		...polishLines,
		"concurrency:",
		"  max_concurrent: 2",
		"  max_retries: 0",
		"",
	].join("\n");
}

await writeFile(join(home, ".zread-pi", "config.yaml"), configYaml(["  enabled: true", "  mode: full"]), "utf-8");

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { generateWikiContent } = await import("../src/wiki/generate-wiki.js");

// ---------------------------------------------------------------------------
// 第一轮：polish.mode = full
// ---------------------------------------------------------------------------

console.log("▶ 第一轮：polish.mode = full（4 页）…");
const first = await generateWikiContent({ pages: pages.slice(0, 4), maxConcurrent: 2 });
const bySlug = (slug: string) => first.results.find((entry) => entry.slug === slug);

console.log("\n▶ 断言（第一轮）");

// 1) 正常润色
const goodContent = await readFile(pagePath("1-good"), "utf-8");
check(
	"polish 生效：页面内容被 Edit 工具真实改写",
	goodContent.includes(polishedProse) && !goodContent.includes(originalProse),
	goodContent.replace(/\n/g, "\\n").slice(0, 80),
);
check(
	"polish 生效时 PageResult.polish.applied = true",
	bySlug("1-good")?.polish?.applied === true && bySlug("1-good")?.success === true,
	JSON.stringify(bySlug("1-good")?.polish ?? null),
);
check(
	"polish Agent 的系统提示来自纪律文件（Embedded mode + Sources 保护）",
	polishSystemPrompts.some((prompt) => prompt.includes("Embedded mode") && prompt.includes("Sources:")),
	`polish prompts=${polishSystemPrompts.length}`,
);

// 2) Mermaid 回滚
const mermaidContent = await readFile(pagePath("2-mermaid"), "utf-8");
check(
	"polish 改坏 Mermaid 后回滚到润色前内容（引号标签恢复）",
	mermaidContent.includes('A["用户(输入)"]') && !mermaidContent.includes("A[用户(输入)]"),
	mermaidContent.replace(/\n/g, "\\n").slice(0, 90),
);
check(
	"Mermaid 回滚记为 mermaid-rollback 且页面仍成功",
	bySlug("2-mermaid")?.polish?.reason === "mermaid-rollback" &&
		bySlug("2-mermaid")?.polish?.applied === false &&
		bySlug("2-mermaid")?.success === true,
	JSON.stringify(bySlug("2-mermaid")?.polish ?? null).slice(0, 120),
);

// 3) 无改动
check(
	"polish 未改动文件时记为 no-change 且页面成功",
	bySlug("3-nochange")?.polish?.reason === "no-change" &&
		bySlug("3-nochange")?.polish?.applied === false &&
		bySlug("3-nochange")?.success === true,
	JSON.stringify(bySlug("3-nochange")?.polish ?? null),
);

// 4) polish 失败不判页失败
const failContent = await readFile(pagePath("4-fail"), "utf-8");
check(
	"polish Agent 失败：页面仍成功，文件保持原样",
	bySlug("4-fail")?.success === true &&
		bySlug("4-fail")?.polish?.reason === "error" &&
		bySlug("4-fail")?.polish?.applied === false &&
		(failContent.includes("正文") || failContent.includes("失败页")),
	`success=${bySlug("4-fail")?.success} polishReason=${bySlug("4-fail")?.polish?.reason} file=${failContent.replace(/\n/g, "\\n").slice(0, 40)}`,
);

// 5) 预防层：页面 Agent 的系统提示带 <writing_discipline>（doc_language=zh -> 中文纪律）
check(
	"页面 Agent 系统提示注入 <writing_discipline>（第 1 层预防，zh 版）",
	pageSystemPrompts.every((prompt) => prompt.includes("<writing_discipline>") && prompt.includes("文风纪律")),
	`page prompts=${pageSystemPrompts.length}`,
);
check(
	"polish Agent 的 token 用量记入 PageResult.polish",
	(bySlug("1-good")?.polish?.tokenUsage?.input_tokens ?? 0) > 0,
	JSON.stringify(bySlug("1-good")?.polish?.tokenUsage ?? null),
);

// 6) 调用次数：页面 4 页各 2 次；polish：好页 2 次、图表页 2 次、无改动 1 次、失败 1 次
check(
	"页面与 polish Agent 的调用次数符合预期",
	pageRequests === 8 && polishRequests === 6,
	`pageRequests=${pageRequests} polishRequests=${polishRequests}`,
);

// ---------------------------------------------------------------------------
// 第二轮：polish.mode = prompt-only（只预防，不跑 polish Agent）
// ---------------------------------------------------------------------------

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	configYaml(["  enabled: true", "  mode: prompt-only"]),
	"utf-8",
);
const polishBefore = polishRequests;
console.log("\n▶ 第二轮：polish.mode = prompt-only（1 页）…");
const second = await generateWikiContent({ pages: [pages[4]!], maxConcurrent: 1 });
const promptOnlyContent = await readFile(pagePath("5-promptonly"), "utf-8");
check(
	"prompt-only：不再调用 polish Agent",
	polishRequests === polishBefore,
	`polishRequests=${polishRequests}（之前 ${polishBefore}）`,
);
check(
	"prompt-only：PageResult.polish.reason = mode，页面成功且内容未被润色",
	second.results[0]?.success === true &&
		second.results[0]?.polish?.reason === "mode" &&
		second.results[0]?.polish?.applied === false &&
		promptOnlyContent.includes("正文"),
	JSON.stringify(second.results[0]?.polish ?? null),
);
check(
	"prompt-only：页面 Agent 仍然注入纪律块",
	pageSystemPrompts.at(-1)?.includes("<writing_discipline>") === true,
);

// ---------------------------------------------------------------------------
// 第三轮：polish.enabled = false（完全关闭）
// ---------------------------------------------------------------------------

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	configYaml(["  enabled: false", "  mode: full"]),
	"utf-8",
);
const polishBeforeDisabled = polishRequests;
console.log("\n▶ 第三轮：polish.enabled = false（1 页）…");
const third = await generateWikiContent({ pages: [pages[5]!], maxConcurrent: 1 });
check(
	"关闭后：不调用 polish Agent",
	polishRequests === polishBeforeDisabled,
	`polishRequests=${polishRequests}（之前 ${polishBeforeDisabled}）`,
);
check(
	"关闭后：连纪律块都不注入",
	pageSystemPrompts.at(-1)?.includes("<writing_discipline>") === false,
);
check(
	"关闭后：PageResult.polish.reason = disabled，页面成功",
	third.results[0]?.success === true && third.results[0]?.polish?.reason === "disabled",
	JSON.stringify(third.results[0]?.polish ?? null),
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
