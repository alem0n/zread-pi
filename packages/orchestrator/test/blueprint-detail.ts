/**
 * blueprint-detail.ts —— 蓝图细节档位（blueprint.detail）验证
 *
 * 结构优先蓝图里档位是**机器目标参数**（plan D7）：
 *   A) 纯函数：五档规格表（区间 + panorama + exhaustive）、非法值回退 high、
 *      MINIMAL_PANORAMA_REQUIREMENT 文案（minimal 页面提示词注入）；
 *   B) 端到端：minimal 档位跳过两个命名 Agent（D16），1 分类 1 页且单页拥有全量文件；
 *      非 minimal 档位照常跑命名 Agent。
 *
 * 运行：bun run packages/orchestrator/test/blueprint-detail.ts
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { homedir } from "node:os";

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

// 预置解析器缓存（离线可跑）
const realParsers = join(homedir(), ".zread-pi", "parsers");
if (await import("node:fs/promises").then((fs) => fs.stat(realParsers).catch(() => null))) {
	await cp(realParsers, join(home, ".zread-pi", "parsers"), { recursive: true });
}

await writeFile(join(repo, "README.md"), "# detail-fixture\n", "utf-8");
await writeFile(join(repo, "src", "a.ts"), 'export const a = (): string => "a";\n', "utf-8");
await writeFile(join(repo, "src", "b.ts"), 'export const b = (): string => "b";\n', "utf-8");

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
		const hasToolResult = messages.some((message) => message.role === "tool");
		const toolNames = new Set(
			(body.tools ?? [])
				.map((tool) => tool?.function?.name)
				.filter((name): name is string => typeof name === "string"),
		);

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string): void => controller.enqueue(encoder.encode(text));

				if (!hasToolResult) {
					// 命名工具被调用时永远「成功」一次（验证：minimal 根本不会走到这里）
					write(textChunk("done"));
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
function textChunk(text: string): string {
	return chunk(baseChunk({ role: "assistant", content: text }, null)) + chunk(baseChunk({}, "stop"));
}

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: zh",
		"doc_language: zh",
		"blueprint:",
		"  detail: minimal",
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

// ---------------------------------------------------------------------------
// A) 纯函数：五档规格 / 回退 / minimal 全景导览文案
// ---------------------------------------------------------------------------

const { getDetailSpec, BLUEPRINT_DETAIL_SPECS, MINIMAL_PANORAMA_REQUIREMENT } = await import(
	"../src/agents/blueprint-detail.js"
);
const { BLUEPRINT_DETAIL_LEVELS } = await import("@zread-pi/utils");

const minimal = getDetailSpec("minimal");
const low = getDetailSpec("low");
const medium = getDetailSpec("medium");
const high = getDetailSpec("high");
const max = getDetailSpec("max");

check(
	"A1 minimal：固定 1 分类 1 页 + 全景导览",
	minimal.sections.min === 1 &&
		minimal.sections.max === 1 &&
		minimal.topics.min === 1 &&
		minimal.topics.max === 1 &&
		minimal.panorama === true,
	JSON.stringify(minimal),
);
check(
	"A1 low：2~5 分类、1~3 页、无附加要求",
	low.sections.min === 2 && low.sections.max === 5 && low.topics.min === 1 && low.topics.max === 3 && low.panorama === false,
	JSON.stringify(low),
);
check(
	"A1 medium：3~6 分类、3~5 页",
	medium.sections.min === 3 && medium.sections.max === 6 && medium.topics.min === 3 && medium.topics.max === 5,
	JSON.stringify(medium),
);
check(
	"A1 high：3~8 分类、3~10 页（默认档位）",
	high.sections.min === 3 && high.sections.max === 8 && high.topics.min === 3 && high.topics.max === 10,
	JSON.stringify(high),
);
check(
	"A1 max：3~8 分类、5~12 页 + exhaustive",
	max.sections.min === 3 && max.sections.max === 8 && max.topics.min === 5 && max.topics.max === 12 && max.exhaustive === true,
	JSON.stringify(max),
);
check(
	"A1 规格表键集合与 BLUEPRINT_DETAIL_LEVELS 一致",
	Object.keys(BLUEPRINT_DETAIL_SPECS).join(",") === BLUEPRINT_DETAIL_LEVELS.join(","),
	`${Object.keys(BLUEPRINT_DETAIL_SPECS).join(",")} vs ${BLUEPRINT_DETAIL_LEVELS.join(",")}`,
);
check("A1 非法档位回退 high", getDetailSpec("bogus").level === "high");
check("A1 缺省档位回退 high", getDetailSpec(undefined).level === "high");
check(
	"A1 规格表不含已删除的 refineTitles / 数量回路字段",
	!("refineTitles" in minimal) && !("quantityFeedback" in minimal),
	JSON.stringify(Object.keys(minimal)),
);
check(
	"A2 MINIMAL_PANORAMA_REQUIREMENT 要求 Mermaid 架构图",
	typeof MINIMAL_PANORAMA_REQUIREMENT === "string" &&
		MINIMAL_PANORAMA_REQUIREMENT.includes("Mermaid") &&
		MINIMAL_PANORAMA_REQUIREMENT.length > 0,
	MINIMAL_PANORAMA_REQUIREMENT.slice(0, 60),
);

// ---------------------------------------------------------------------------
// B) minimal 端到端：跳过两个命名 Agent（D16），1 分类 1 页拥有全量文件
// ---------------------------------------------------------------------------

const { generateWikiCatalog } = await import("../src/orchestrator.js");

console.log("\n▶ generateWikiCatalog()（minimal 档位）…");
const minimalResult = await generateWikiCatalog();
const minimalBlueprint = JSON.parse(
	await readFile(join(repo, ".zread-pi", "wiki", "minimal", "wiki.json"), "utf-8"),
) as {
	sections: Array<{ title: string }>;
	pages: Array<{ slug: string; section: string; ownsFiles?: string[] }>;
};
const minimalPages = minimalBlueprint.pages;
console.log(
	`  minimal：${minimalResult.sectionsCount} 个分类，${minimalResult.pagesCount} 个页面，${requestCount} 次 LLM 请求`,
);

check("B1 minimal 只产出 1 个分类", minimalResult.sectionsCount === 1, String(minimalResult.sectionsCount));
check("B1 minimal 只产出 1 个页面", minimalResult.pagesCount === 1, String(minimalResult.pagesCount));
check(
	"B1 minimal 单页拥有全部源文件（等式平凡闭合）",
	minimalPages.length === 1 &&
		minimalPages[0].ownsFiles?.length === 2 &&
		minimalPages[0].ownsFiles?.includes("src/a.ts") &&
		minimalPages[0].ownsFiles?.includes("src/b.ts"),
	JSON.stringify(minimalPages[0]?.ownsFiles),
);
check("B1 minimal 零 LLM 请求（跳过两个命名 Agent）", requestCount === 0, `requests=${requestCount}`);
check("B1 minimal 页面归属唯一分类", minimalPages.every((page) => page.section === minimalBlueprint.sections[0].title));

// ---------------------------------------------------------------------------
// C) 非 minimal 档位照常跑命名 Agent（对照 B1）
// ---------------------------------------------------------------------------

await writeFile(
	join(home, ".zread-pi", "config.yaml"),
	[
		"language: zh",
		"doc_language: zh",
		"blueprint:",
		"  detail: high",
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

requestCount = 0;
console.log("\n▶ generateWikiCatalog()（high 档位，对照）…");
const highResult = await generateWikiCatalog();
console.log(`  high：${highResult.sectionsCount} 个分类，${highResult.pagesCount} 个页面，${requestCount} 次 LLM 请求`);

check("C1 high 产出的页面数多于 minimal", highResult.pagesCount > minimalResult.pagesCount, `${highResult.pagesCount} > ${minimalResult.pagesCount}`);
check("C1 high 跑了命名 Agent（有 LLM 请求）", requestCount > 0, `requests=${requestCount}`);

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
