/**
 * e2e-blueprint.ts —— Orchestrator 端到端验证（业务逻辑未改动，仅底层运行时换成 pi）
 *
 * 链路：generateWikiCatalog()
 *   -> Orchestrator/createAgent（业务编排，原样保留）
 *   -> @zread-pi/agent-runtime 适配层
 *   -> pi Agent 循环
 *   -> pi-ai openai-completions adapter -> 本地 mock OpenAI 服务
 *   -> 模型返回 generate_blueprint 工具调用
 *   -> 真实工具执行：generateWikiJson() 写出 .zread-pi/wiki/wiki.json
 *   -> 第二轮：模型返回收尾文本 -> SDKResultMessage(success)
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
// 2) 启动 mock OpenAI 兼容服务
// ---------------------------------------------------------------------------

const pagePayload = {
	pages: [
		{
			slug: "1-project-overview",
			title: "项目概览",
			file: "1-project-overview.md",
			section: "入门指南",
			level: "Beginner",
			associatedFiles: ["src/"],
		},
	],
	techStackSummary: { 核心框架: "TypeScript" },
};

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

let toolCallServed = false;
/** 第二轮场景：模型不调用 generate_blueprint，只输出文字 */
let mode: "ok" | "no-blueprint" = "ok";
/** 记录每次请求的 system 消息（验证上下文文件注入） */
const seenSystemPrompts: string[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
		const systemMessage = (body.messages ?? []).find((message) => message.role === "system");
		if (typeof systemMessage?.content === "string") seenSystemPrompts.push(systemMessage.content);
		const hasToolResult = (body.messages ?? []).some((message) => message.role === "tool");
		const encoder = new TextEncoder();

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => controller.enqueue(encoder.encode(text));

				if (mode === "ok" && !hasToolResult && !toolCallServed) {
					toolCallServed = true;
					write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
					write(
						chunk(
							baseChunk(
								{
									tool_calls: [
										{
											index: 0,
											id: "call_blueprint",
											type: "function",
											function: {
												name: "generate_blueprint",
												arguments: JSON.stringify(pagePayload),
											},
										},
									],
								},
								"tool_calls",
							),
						),
					);
				} else {
					write(chunk(baseChunk({ role: "assistant", content: "蓝图已生成" }, null)));
					write(chunk(baseChunk({}, "stop")));
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
		"  max_concurrent: 1",
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
// 3) 运行 Orchestrator
// ---------------------------------------------------------------------------

const { generateWikiCatalog } = await import("../src/orchestrator.js");

const catalogEvents: string[] = [];
console.log("▶ generateWikiCatalog() …");
const result = await generateWikiCatalog((event) => {
	catalogEvents.push(event.type);
});

// ---------------------------------------------------------------------------
// 4) 断言（正向场景：模型调用 generate_blueprint 产出 wiki.json）
// ---------------------------------------------------------------------------

const wikiJsonPath = join(repo, ".zread-pi", "wiki", "wiki.json");
let blueprint: Record<string, unknown> | undefined;
try {
	blueprint = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as Record<string, unknown>;
} catch {
	blueprint = undefined;
}

console.log("\n▶ 断言");
check("工具被真实执行：wiki.json 已写出", blueprint !== undefined, wikiJsonPath);
check(
	"wiki.json 页面结构与模型返回一致",
	JSON.stringify((blueprint?.pages as unknown[]) ?? []) .includes("1-project-overview"),
	JSON.stringify(blueprint?.pages ?? null).slice(0, 160),
);
check("蓝图语言字段来自配置", blueprint?.language === "en", String(blueprint?.language));
check(
	"Orchestrator 进度事件映射正常",
	catalogEvents.includes("requesting") && catalogEvents.includes("tool_start") && catalogEvents.includes("complete"),
	catalogEvents.join(","),
);
check("tokenUsage 已回传", result.tokenUsage !== undefined, JSON.stringify(result.tokenUsage));
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
// 5) 反向场景：模型不产出 wiki.json 时必须报错（不能假装目录完成）
// ---------------------------------------------------------------------------

mode = "no-blueprint";
await rm(wikiJsonPath, { force: true });
console.log("\n▶ generateWikiCatalog()（模型不调用 generate_blueprint）…");
const blueprintFailure = await generateWikiCatalog().then(
	() => null,
	(err: unknown) => (err instanceof Error ? err.message : String(err)),
);
check(
	"未产出有效 wiki.json 时报错而不是假装完成",
	typeof blueprintFailure === "string" && blueprintFailure.includes("wiki.json"),
	blueprintFailure ?? "(未报错)",
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
