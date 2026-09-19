/**
 * 标题诊断信号 + refine_section_titles 自检 —— plan.md §3.5 验证
 *
 * 对齐 lecture-to-notes 的 `structure-reorder.md`：诊断信号表（7 条）+
 * 两项真正机械的工具侧自检（数量一致性 + 重写率统计）。
 *
 * 覆盖：
 * - 提示词含 7 条诊断信号、收敛优先策略、不得新增/删除页面
 * - 数量一致性自检：陌生 slug / 漏 slug → is_error 且**不落盘**
 * - 正确提交 → 落盘 + 只改 title（slug/file/section/associatedFiles 逐字不变）
 * - onResult 重写率回调带正确的 updated/skipped/unknown
 *
 * 运行：bun run packages/orchestrator/test/titles-diagnostic.ts
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiSection, WikiPage, BlueprintDetailLevel } from "@zread-pi/types";
import {
	loadWikiBlueprint,
	type ApplyTitlesResult,
} from "@zread-pi/utils";
import { createRefineSectionTitlesTool } from "../src/tools/output-tools.js";
import TitlesPrompt from "../src/prompts/titles";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ==================== A. 提示词含诊断信号 ====================

console.log("\n▶ A. 提示词含 7 条诊断信号与策略");

{
	check("含「诊断信号」段", TitlesPrompt.includes("诊断信号"));
	check("信号 1：子层级编号", TitlesPrompt.includes("子层级编号"));
	check("信号 2：续接词", TitlesPrompt.includes("续接词"));
	check("信号 3：相邻标题同属一个母题", TitlesPrompt.includes("同属一个母题"));
	check("信号 4：字数量级悬殊（1/5）", TitlesPrompt.includes("1/5"));
	check("信号 5：具体技术点而非主题块", TitlesPrompt.includes("具体技术点"));
	check("信号 6：母题名词反复出现", TitlesPrompt.includes("反复出现"));
	check("信号 7：命名风格不统一", TitlesPrompt.includes("命名风格不统一"));
	check("策略：优先收敛合并、少拆分", TitlesPrompt.includes("收敛合并") && TitlesPrompt.includes("少做「拆分」"));
	check("边界：不得新增、删除、调换页面", TitlesPrompt.includes("不得新增、删除、调换页面"));
	check("对齐来源标注（structure-reorder）", TitlesPrompt.includes("structure-reorder"));
}

// ==================== B. 数量一致性自检（不落盘） ====================

console.log("\n▶ B. 数量一致性自检：陌生 slug / 漏 slug → is_error 且不落盘");

let repo: string;
const variant: BlueprintDetailLevel = "high";
const section: WikiSection = { title: "核心网络引擎", description: "网络层" };
const pages: WikiPage[] = [
	{ slug: "4-tcp-pool", title: "TCP 连接池", section: "核心网络引擎", file: "4-tcp-pool.md", associatedFiles: ["src/tcp.ts"] },
	{ slug: "5-http-router", title: "HTTP 路由", section: "核心网络引擎", file: "5-http-router.md", associatedFiles: ["src/router.ts"] },
	{ slug: "6-dns-cache", title: "DNS 缓存", section: "核心网络引擎", file: "6-dns-cache.md", associatedFiles: ["src/dns.ts"] },
];

async function writeWikiJson(): Promise<void> {
	const wikiDir = join(repo, ".zread-pi", "wiki", variant);
	await mkdir(wikiDir, { recursive: true });
	await writeFile(
		join(wikiDir, "wiki.json"),
		JSON.stringify(
			{ id: "t", generated_at: new Date().toISOString(), language: "zh", detail: variant, sections: [section], pages },
			null,
			2,
		),
		"utf-8",
	);
}

async function readTitles(): Promise<Map<string, string>> {
	const blueprint = await loadWikiBlueprint(undefined, variant);
	const map = new Map<string, string>();
	for (const page of blueprint?.pages ?? []) map.set(page.slug, page.title);
	return map;
}

{
	repo = await mkdtemp(join(tmpdir(), "zread-titles-repo-"));
	process.chdir(repo);
	await writeWikiJson();

	const tool = createRefineSectionTitlesTool(section, {
		variant,
		expectedSlugs: pages.map((p) => p.slug),
	});
	const ctx = {} as never;

	// 陌生 slug
	const unknownResult = await tool.call(
		{ section: section.title, titles: [
			{ slug: "4-tcp-pool", title: "TCP 底层传输：连接池" },
			{ slug: "99-not-a-page", title: "幽灵页面" },
			{ slug: "5-http-router", title: "HTTP 路由栈" },
			{ slug: "6-dns-cache", title: "DNS 缓存层" },
		] } as never,
		ctx,
	);
	check("陌生 slug → is_error", unknownResult.is_error === true);
	check("陌生 slug → 错误信息含「陌生 slug 1」", String(unknownResult.content).includes("陌生 slug 1"), String(unknownResult.content).split("\n")[0]);
	const afterUnknown = await readTitles();
	check("陌生 slug → 不落盘（标题未变）", afterUnknown.get("4-tcp-pool") === "TCP 连接池");

	// 漏 slug
	const missingResult = await tool.call(
		{ section: section.title, titles: [
			{ slug: "4-tcp-pool", title: "TCP 底层传输：连接池" },
			{ slug: "5-http-router", title: "HTTP 路由栈" },
		] } as never,
		ctx,
	);
	check("漏 slug → is_error", missingResult.is_error === true);
	check("漏 slug → 错误信息含「遗漏 slug 1」", String(missingResult.content).includes("遗漏 slug 1"), String(missingResult.content).split("\n")[0]);
	const afterMissing = await readTitles();
	check("漏 slug → 不落盘（标题未变）", afterMissing.get("6-dns-cache") === "DNS 缓存");
}

// ==================== C. 正确提交 → 落盘 + 只改 title ====================

console.log("\n▶ C. 正确提交：落盘 + 字段不可变性 + onResult 回调");

{
	let applied: ApplyTitlesResult | undefined;
	const tool = createRefineSectionTitlesTool(section, {
		variant,
		expectedSlugs: pages.map((p) => p.slug),
		onResult: (result) => {
			applied = result;
		},
	});
	const ctx = {} as never;

	const okResult = await tool.call(
		{ section: section.title, titles: [
			{ slug: "4-tcp-pool", title: "TCP 底层传输：高并发连接池" },
			{ slug: "5-http-router", title: "HTTP 路由栈：动态树形解析" },
			{ slug: "6-dns-cache", title: "DNS 缓存" }, // 相同标题 → skipped
		] } as never,
		ctx,
	);
	check("正确提交 → 不是 error", okResult.is_error !== true, String(okResult.content).split("\n")[0]);
	check("回执含「更新 2，跳过 1」", String(okResult.content).includes("更新 2") && String(okResult.content).includes("跳过 1"), String(okResult.content).split("\n")[0]);

	const after = await readTitles();
	check("两页标题被改写", after.get("4-tcp-pool") === "TCP 底层传输：高并发连接池" && after.get("5-http-router") === "HTTP 路由栈：动态树形解析");
	check("未变标题保持原样（skipped）", after.get("6-dns-cache") === "DNS 缓存");

	// 字段不可变性：除 title 外逐字不变（实现保证，见 applySectionTitles 注释）
	const blueprint = await loadWikiBlueprint(undefined, variant);
	const changed = blueprint?.pages.find((p) => p.slug === "4-tcp-pool");
	check("slug / file / section / associatedFiles 逐字不变",
		changed?.file === "4-tcp-pool.md" &&
			changed?.section === "核心网络引擎" &&
			JSON.stringify(changed?.associatedFiles) === JSON.stringify(["src/tcp.ts"]));

	// 重写率回调
	check("onResult 回调被调用", applied !== undefined);
	check("onResult 带 updated=2 / skipped=1 / unknown=0",
		applied?.updated === 2 && applied?.skipped === 1 && applied?.unknown === 0,
		JSON.stringify(applied));
}

// ==================== D. expectedSlugs 缺省时跳过数量自检（兼容） ====================

console.log("\n▶ D. expectedSlugs 缺省时不做数量自检（旧调用点兼容）");

{
	const tool = createRefineSectionTitlesTool(section, { variant });
	const ctx = {} as never;
	const result = await tool.call(
		{ section: section.title, titles: [{ slug: "4-tcp-pool", title: "TCP 连接池管理器" }] } as never,
		ctx,
	);
	check("不传 expectedSlugs → 只提交一页也不报错（applySectionTitles 自身的 unknown/skipped 语义兜底）",
		result.is_error !== true,
		String(result.content).split("\n")[0]);
	const after = await readTitles();
	check("单页标题已写回", after.get("4-tcp-pool") === "TCP 连接池管理器");
}

// ==================== E. 诊断信号的纯函数：可检出的两类坏标题 ====================

console.log("\n▶ E. 诊断信号示例可被正则检出（提示词自洽性）");

{
	// 提示词的示例与规则本身不冲突：续接词与编号在示例里都是「反例」
	check("示例「2.3 注意力」被信号 1 覆盖", TitlesPrompt.includes("「2.3 注意力」"));
	check("示例「（续）」被信号 2 覆盖", TitlesPrompt.includes("（续）"));
}

// ==================== 汇总 ====================

console.log("");
const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
	console.log(`❌ ${failed.length} 项失败：`);
	for (const c of failed) console.log(`  - ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
	process.exitCode = 1;
}
console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);
