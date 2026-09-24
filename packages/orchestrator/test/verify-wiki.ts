/**
 * verify-wiki.ts —— 交付闸门端到端验证
 *
 * 对齐 lecture-to-notes 的 verify_notes.py 的检查组结构（PASS/FAIL/SKIP + OVERALL），
 * 覆盖 zread-pi 的五个组（structure / content / mermaid / traceability / frontmatter）、
 * 遗留目录回退、无产物 SKIP，以及 `--enforce` 对 content 组的失败语义。
 *
 * 运行：bun run packages/orchestrator/test/verify-wiki.ts
 */

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 夹具：在临时仓库里构造 wiki.json + 页面文件
// ---------------------------------------------------------------------------

/** 生成足够通过内容密度门的散文（Beginner / 无关联文件 → 下限 1200） */
function fatProse(): string {
	// 单一段落（避免「重复句首」），长度 > 1300 字符
	const sentence = "本模块负责把扫描结果转成可读的讲解，读者在阅读之后应当能够复述核心流程。";
	return sentence.repeat(30);
}

type PageSpec = {
	slug: string;
	title: string;
	file: string;
	section: string;
	level?: "Beginner" | "Intermediate" | "Advanced";
	associatedFiles?: string[];
	/** 本页拥有的源文件（v2 覆盖台账） */
	ownsFiles?: string[];
	/** 页面正文（不含 frontmatter；由 buildWiki 自动加 frontmatter） */
	body: string;
	/** 覆盖 frontmatter（用于构造不一致场景） */
	frontmatter?: string;
	/** 不写文件（构造「缺失」场景） */
	skipFile?: boolean;
};

interface BuildOptions {
	variant?: string | null; // null = 遗留目录布局
	sections?: string[];
	/** 额外的源文件（相对仓库根）：路径 -> 内容行数组） */
	sourceFiles?: Record<string, string[]>;
	/** wiki.json 的 schemaVersion（v2 产物才填） */
	schemaVersion?: number;
	/** 覆盖台账（v2 产物才填） */
	coverage?: Record<string, unknown>;
}

/**
 * 构造一棵 wiki 树。返回 wiki.json 的反序列化结果与仓库根。
 *
 * - `variant = 'high'`（默认）→ `.zread-pi/wiki/high/{section}/{file}.md`
 * - `variant = null` → 遗留布局 `.zread-pi/wiki/{section}/{file}.md`
 */
async function buildWiki(pages: PageSpec[], options: BuildOptions = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "zread-pi-verify-"));
	const variant = options.variant === undefined ? "high" : options.variant;
	const wikiBase = variant ? join(root, ".zread-pi", "wiki", variant) : join(root, ".zread-pi", "wiki");

	// 源文件（traceability 用）
	for (const [path, lines] of Object.entries(options.sourceFiles ?? {})) {
		const abs = join(root, path);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, lines.join("\n") + "\n", "utf-8");
	}

	// 页面文件
	for (const page of pages) {
		if (page.skipFile) continue;
		const filePath = join(wikiBase, page.section, page.file);
		await mkdir(join(filePath, ".."), { recursive: true });
		const fm =
			page.frontmatter ??
			`---\ntitle: "${page.title}"\nslug: "${page.slug}"\n---\n\n`;
		await writeFile(filePath, fm + page.body, "utf-8");
	}

	// wiki.json
	const sections = (options.sections ?? [...new Set(pages.map((p) => p.section))]).map((title) => ({
		title,
		description: `${title} 的说明`,
	}));
	const blueprint = {
		id: "test",
		generated_at: new Date().toISOString(),
		language: "zh",
		detail: variant ?? undefined,
		...(options.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
		...(options.coverage ? { coverage: options.coverage } : {}),
		pages: pages.map((p) => ({
			slug: p.slug,
			title: p.title,
			file: p.file,
			section: p.section,
			level: p.level ?? "Beginner",
			associatedFiles: p.associatedFiles ?? [],
			...(p.ownsFiles ? { ownsFiles: p.ownsFiles } : {}),
		})),
		sections,
	};
	await mkdir(wikiBase, { recursive: true });
	await writeFile(join(wikiBase, "wiki.json"), JSON.stringify(blueprint, null, 2), "utf-8");
	return root;
}

/** 取一组的检查结果（同组可能多条，取第一条匹配 message 子串） */
function findCheck(
	report: { checks: Array<{ status: string; group: string; message: string; details?: string[] }> },
	group: string,
	messageContains?: string,
): { status: string; message: string; details?: string[] } | undefined {
	return report.checks.find(
		(c) => c.group === group && (!messageContains || c.message.includes(messageContains)),
	);
}

// ---------------------------------------------------------------------------
// A. parseSourceRefs 纯函数
// ---------------------------------------------------------------------------

console.log("\n▶ A. parseSourceRefs 纯函数");
{
	const { parseSourceRefs } = await import("../src/wiki/verify-wiki.js");
	const markdown = [
		"## 小节",
		"",
		"正文。",
		"",
		"Sources: [模块 a](src/a.ts#L1-2) · [文档 b](docs/b.md) · [外链](https://example.com/x) · [锚点](#anchor)",
	].join("\n");
	const refs = parseSourceRefs(markdown, "p1");
	check(
		"解析 2 个仓库内引用（外链与纯锚点排除）",
		refs.length === 2,
		JSON.stringify(refs.map((r) => r.path)),
	);
	check(
		"行号区间解析（#L1-2）",
		refs[0].path === "src/a.ts" && refs[0].lineFrom === 1 && refs[0].lineTo === 2,
		JSON.stringify(refs[0]),
	);
	check("无行号引用 lineFrom 为 undefined", refs[1].lineFrom === undefined, JSON.stringify(refs[1]));
	check("无 Sources 行时返回空数组", parseSourceRefs("正文，无溯源", "p1").length === 0);
	check(
		"单行号写法（#L5）解析为 5..5",
		parseSourceRefs("Sources: [x](src/a.ts#L5)", "p1")[0].lineTo === 5,
	);
}

// ---------------------------------------------------------------------------
// B. 全绿：五组全部 PASS
// ---------------------------------------------------------------------------

console.log("\n▶ B. 全绿 wiki（五组 PASS → OVERALL PASS）");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki(
		[
			{
				slug: "1-intro",
				title: "入门",
				file: "1-intro.md",
				section: "工具函数",
				body: ["# 入门", "", "## 核心流程", "", fatProse(), "", "Sources: [a](src/a.ts#L1-2)"].join("\n"),
			},
		],
		{ sourceFiles: { "src/a.ts": ["line1", "line2", "line3"] } },
	);
	const report = await verifyWiki({ root });

	check("structure PASS", findCheck(report, "structure")?.status === "PASS", report.checks.filter((c) => c.group === "structure").map((c) => c.message).join(" | "));
	check("content PASS（散文达标）", findCheck(report, "content")?.status === "PASS");
	check("mermaid PASS", findCheck(report, "mermaid")?.status === "PASS");
	check("frontmatter PASS", findCheck(report, "frontmatter")?.status === "PASS");
	check("traceability 路径 PASS", findCheck(report, "traceability", "溯源路径")?.status === "PASS");
	check("traceability 行号 PASS", findCheck(report, "traceability", "行号区间")?.status === "PASS");
	check("OVERALL PASS（ok=true）", report.ok === true);
	check("变体解析为 high", report.variant === "high" && report.legacy === false);

	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// C. structure 失败：页面文件缺失 / (section,file) 重复 / sections 集合不一致
// ---------------------------------------------------------------------------

console.log("\n▶ C. structure 失败");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki(
		[
			{
				slug: "1-a",
				title: "A",
				file: "1-a.md",
				section: "工具函数",
				body: "# A\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts)",
			},
			// 文件 2-b.md 不写 → 缺失（且不是重复，避免被重复检查掩盖）
			{ slug: "2-b", title: "B", file: "2-b.md", section: "工具函数", body: "# B\n", skipFile: true },
			// 与 1-a 同 (section, file) → 重复
			{ slug: "3-c", title: "C", file: "1-a.md", section: "工具函数", body: "# C\n" },
		],
		{ sections: ["别的分类"] },
	);
	const report = await verifyWiki({ root });

	check(
		"页面文件缺失 → structure FAIL",
		findCheck(report, "structure", "页面文件缺失")?.status === "FAIL",
		findCheck(report, "structure", "页面文件缺失")?.message,
	);
	check(
		"(section,file) 重复 → structure FAIL",
		findCheck(report, "structure", "重复")?.status === "FAIL",
		findCheck(report, "structure", "重复")?.message,
	);
	check(
		"sections 集合不一致 → structure FAIL",
		findCheck(report, "structure", "集合不一致")?.status === "FAIL",
		findCheck(report, "structure", "集合不一致")?.message,
	);
	check("OVERALL FAIL", report.ok === false);

	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// D. content 组：干瘪页面的 enforce / 非 enforce 语义
// ---------------------------------------------------------------------------

console.log("\n▶ D. content 组（干瘪页面）");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const thinPage = (): PageSpec => ({
		slug: "1-thin",
		title: "干瘪",
		file: "1-thin.md",
		section: "工具函数",
		// 只在散文上不达标：标题层级 / Sources / 路径都合法，
		// 保证 content 组是唯一失败项（非 enforce 时 OVERALL 必须仍是 PASS）
		body: "# 干瘪\n\n## 小节\n\n太短了。\n\nSources: [a](src/a.ts)",
	});

	// 非 enforce：只列出，不影响 OVERALL
	const root1 = await buildWiki([thinPage()], { sourceFiles: { "src/a.ts": ["l1"] } });
	const warnReport = await verifyWiki({ root: root1 });
	const warnCheck = findCheck(warnReport, "content", "未通过内容密度门");
	check(
		"非 enforce：content 组状态 PASS（仅列出）",
		warnCheck?.status === "PASS",
		`${warnCheck?.status} ${warnCheck?.message}`,
	);
	check("非 enforce：details 列出未达标页面", (warnCheck?.details?.length ?? 0) === 1, JSON.stringify(warnCheck?.details));
	check("非 enforce：OVERALL 仍为 PASS", warnReport.ok === true);
	await rm(root1, { recursive: true, force: true });

	// enforce：计为整体失败
	const root2 = await buildWiki([thinPage()], { sourceFiles: { "src/a.ts": ["l1"] } });
	const enforceReport = await verifyWiki({ root: root2, enforce: true });
	const enforceCheck = findCheck(enforceReport, "content", "未通过内容密度门");
	check(
		"--enforce：content 组状态 FAIL",
		enforceCheck?.status === "FAIL",
		`${enforceCheck?.status} ${enforceCheck?.message}`,
	);
	check("--enforce：OVERALL FAIL", enforceReport.ok === false);
	await rm(root2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// E. mermaid 失败：节点标签未加引号
// ---------------------------------------------------------------------------

console.log("\n▶ E. mermaid 失败");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki([
		{
			slug: "1-bad",
			title: "坏图",
			file: "1-bad.md",
			section: "工具函数",
			body: [
				"# 坏图",
				"",
				"## 小节",
				"",
				fatProse(),
				"",
				"```mermaid",
				"flowchart TB",
				"  A[用户(输入)] --> B[结果]",
				"```",
				"",
				"Sources: [a](src/a.ts)",
			].join("\n"),
		},
	]);
	const report = await verifyWiki({ root });
	const m = findCheck(report, "mermaid");
	check("非法 Mermaid 节点标签 → FAIL", m?.status === "FAIL", `${m?.status} ${m?.message}`);
	check("失败明细含页面与节点", (m?.details?.length ?? 0) > 0 && m!.details![0].includes("1-bad"));
	check("OVERALL FAIL", report.ok === false);
	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// F. frontmatter 失败：缺少 / 不一致
// ---------------------------------------------------------------------------

console.log("\n▶ F. frontmatter 失败");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki([
		{
			slug: "1-fm",
			title: "正确标题",
			file: "1-fm.md",
			section: "工具函数",
			// 故意写错 title 与 slug
			frontmatter: '---\ntitle: "错标题"\nslug: "wrong-slug"\n---\n\n',
			body: "# 正确标题\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts)",
		},
	]);
	const report = await verifyWiki({ root });
	const f = findCheck(report, "frontmatter");
	check("title / slug 与 wiki.json 不一致 → FAIL", f?.status === "FAIL", `${f?.status} ${f?.message}`);
	check("明细同时指出 title 与 slug 问题", (f?.details?.filter((d) => d.includes("title") || d.includes("slug")).length ?? 0) === 2, JSON.stringify(f?.details));
	await rm(root, { recursive: true, force: true });

	// 缺少 frontmatter 块
	const root2 = await buildWiki([
		{
			slug: "1-nofm",
			title: "无 frontmatter",
			file: "1-nofm.md",
			section: "工具函数",
			frontmatter: "",
			body: "# 无 frontmatter\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts)",
		},
	]);
	const report2 = await verifyWiki({ root: root2 });
	const fmMissing = findCheck(report2, "frontmatter");
	check(
		"缺少 frontmatter 块 → FAIL",
		fmMissing?.status === "FAIL" && (fmMissing.details?.some((d) => d.includes("缺少 frontmatter 块")) ?? false),
		JSON.stringify(fmMissing?.details),
	);
	await rm(root2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G. traceability 失败：路径不存在 / 行号越界 / 跨页重复（WARN）
// ---------------------------------------------------------------------------

console.log("\n▶ G. traceability 失败与重复声明");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki(
		[
			{
				slug: "1-trace",
				title: "溯源",
				file: "1-trace.md",
				section: "工具函数",
				body: [
					"# 溯源",
					"",
					"## 小节",
					"",
					fatProse(),
					"",
					// 坏路径 / 行号越界（文件只有 3 行）/ 正常引用
					"Sources: [缺](src/missing.ts#L1-2) · [越界](src/a.ts#L2-99) · [正常](src/a.ts#L1-2)",
				].join("\n"),
			},
		],
		{ sourceFiles: { "src/a.ts": ["l1", "l2", "l3"] } },
	);
	const report = await verifyWiki({ root });
	const badPath = findCheck(report, "traceability", "溯源路径不存在");
	const badLine = findCheck(report, "traceability", "行号区间越界");
	check("溯源路径不存在 → FAIL", badPath?.status === "FAIL", `${badPath?.status} ${badPath?.message}`);
	check("行号区间越界 → FAIL", badLine?.status === "FAIL", `${badLine?.status} ${badLine?.message}`);
	check("行号明细含文件总行数", (badLine?.details?.[0] ?? "").includes("共 3 行"), badLine?.details?.[0]);
	check("OVERALL FAIL", report.ok === false);
	await rm(root, { recursive: true, force: true });

	// 跨页重复声明：两页引用同一区间（WARN：列出来但不 FAIL）
	const root2 = await buildWiki(
		[
			{
				slug: "1-dup",
				title: "甲",
				file: "1-dup.md",
				section: "工具函数",
				body: "# 甲\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts#L1-2)",
			},
			{
				slug: "2-dup",
				title: "乙",
				file: "2-dup.md",
				section: "工具函数",
				body: "# 乙\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts#L1-2)",
			},
		],
		{ sourceFiles: { "src/a.ts": ["l1", "l2", "l3"] } },
	);
	const report2 = await verifyWiki({ root: root2 });
	const dup = findCheck(report2, "traceability", "重复声明");
	check("跨页重复声明只 WARN 不 FAIL", dup?.status === "PASS", `${dup?.status} ${dup?.message}`);
	check("重复声明明细列出两个页面", (dup?.details?.[0] ?? "").includes("1-dup") && dup!.details![0].includes("2-dup"), dup?.details?.[0]);
	check("跨页重复不影响 OVERALL", report2.ok === true);
	await rm(root2, { recursive: true, force: true });

	// 完全没有 Sources 引用 → traceability FAIL（页面 prompt 已强约束）
	const root3 = await buildWiki([
		{
			slug: "1-nosrc",
			title: "无溯源",
			file: "1-nosrc.md",
			section: "工具函数",
			body: "# 无溯源\n\n## 小节\n\n" + fatProse(),
		},
	]);
	const report3 = await verifyWiki({ root: root3 });
	check("无任何 Sources 引用 → traceability FAIL", findCheck(report3, "traceability", "没有任何 Sources")?.status === "FAIL");
	await rm(root3, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// H. 遗留目录回退（无档位子目录）
// ---------------------------------------------------------------------------

console.log("\n▶ H. 遗留目录回退");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki(
		[
			{
				slug: "1-legacy",
				title: "遗留",
				file: "1-legacy.md",
				section: "工具函数",
				body: "# 遗留\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts)",
			},
		],
		{ variant: null, sourceFiles: { "src/a.ts": ["l1"] } },
	);
	const report = await verifyWiki({ root });
	check("legacy=true 且 variant=null", report.legacy === true && report.variant === null);
	check("遗留目录页面文件被找到（structure PASS）", findCheck(report, "structure", "页面文件全部存在")?.status === "PASS");
	check("遗留目录 OVERALL PASS", report.ok === true);
	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// I. 无产物 → 整体 SKIP，不报 FAIL
// ---------------------------------------------------------------------------

console.log("\n▶ I. 无产物 SKIP");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await mkdtemp(join(tmpdir(), "zread-pi-empty-"));
	const report = await verifyWiki({ root });
	check("无 wiki.json 时 ok=true（不报 FAIL）", report.ok === true);
	check("structure 组 SKIP", findCheck(report, "structure")?.status === "SKIP");
	check("只发出一条检查", report.checks.length === 1, JSON.stringify(report.checks.length));
	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// J. 骨架（pages 为空）→ structure FAIL + 其余组 SKIP
// ---------------------------------------------------------------------------

console.log("\n▶ J. 骨架阶段（pages 为空）");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await mkdtemp(join(tmpdir(), "zread-pi-skel-"));
	const wikiDir = join(root, ".zread-pi", "wiki", "high");
	await mkdir(wikiDir, { recursive: true });
	await writeFile(
		join(wikiDir, "wiki.json"),
		JSON.stringify({ id: "t", generated_at: new Date().toISOString(), language: "zh", pages: [], sections: [{ title: "空" }] }),
		"utf-8",
	);
	const report = await verifyWiki({ root });
	check("pages 为空 → structure FAIL", findCheck(report, "structure", "pages 为空")?.status === "FAIL");
	check("content / mermaid / traceability / frontmatter 全部 SKIP", report.checks.filter((c) => c.status === "SKIP").length === 4, report.checks.map((c) => `${c.group}:${c.status}`).join(","));
	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// K. 显式 --detail 与自动解析
// ---------------------------------------------------------------------------

console.log("\n▶ K. 档位解析");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const root = await buildWiki([
		{
			slug: "1-low",
			title: "低档",
			file: "1-low.md",
			section: "工具函数",
			body: "# 低档\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts)",
		},
	]);
	// 把产物挪到 low 目录，high 目录不存在
	const highDir = join(root, ".zread-pi", "wiki", "high");
	const lowDir = join(root, ".zread-pi", "wiki", "low");
	await mkdir(join(lowDir, ".."), { recursive: true });
	const { rename } = await import("node:fs/promises");
	await rename(highDir, lowDir);

	const auto = await verifyWiki({ root });
	check("自动解析回退到第一个存在的档位（low）", auto.variant === "low", String(auto.variant));

	const explicit = await verifyWiki({ root, detail: "low" });
	check("显式 --detail low 命中", explicit.variant === "low", String(explicit.variant));

	const missing = await verifyWiki({ root, detail: "max" });
	check(
		"显式 --detail max（不存在）自动回退 low",
		missing.variant === "low",
		String(missing.variant),
	);

	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// L. verify.json 由 generateWikiContent 落盘（verifyAfterGenerate）
// ---------------------------------------------------------------------------

console.log("\n▶ L. generateWikiContent 的 verifyAfterGenerate 集成");
{
	const home = await mkdtemp(join(tmpdir(), "zread-pi-vfy-home-"));
	const repo = await mkdtemp(join(tmpdir(), "zread-pi-vfy-repo-"));
	await mkdir(join(home, ".zread-pi"), { recursive: true });
	await mkdir(join(repo, "src"), { recursive: true });
	await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "utf-8");

	const page = {
		slug: "1-intro",
		title: "入门",
		file: "1-intro.md",
		section: "工具函数",
		level: "Beginner" as const,
		associatedFiles: ["src/a.ts"],
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

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { messages?: Array<{ role?: string }> };
			const messages = body.messages ?? [];
			const hasToolResult = messages.some((m) => m.role === "tool");
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const write = (text: string) => controller.enqueue(encoder.encode(text));
					if (hasToolResult) {
						write(chunk(baseChunk({ role: "assistant", content: "完成" }, null)));
						write(chunk(baseChunk({}, "stop")));
					} else {
						write(chunk(baseChunk({ role: "assistant", content: "" }, null)));
						write(
							chunk(
								baseChunk(
									{
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												type: "function",
												function: {
													name: "write_page",
													arguments: JSON.stringify({
														slug: page.slug,
														file: page.file,
														section: page.section,
														title: page.title,
														content: [
															"# 入门",
															"",
															"## 核心流程",
															"",
															fatProse(),
															"",
															"Sources: [a](src/a.ts#L1-2)",
														].join("\n"),
													}),
												},
											},
										],
									},
									"tool_calls",
								),
							),
						);
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
			"language: zh",
			"doc_language: zh",
			"llm:",
			"  provider: openai-compatible",
			"  model: mock-model",
			"  api_key: sk-mock",
			`  base_url: http://127.0.0.1:${server.port}/v1`,
			"concurrency:",
			"  max_concurrent: 1",
			"  max_retries: 0",
			// 生成后自动校验（摘要落 verify.json，不写 run.json）
			"quality:",
			"  verifyAfterGenerate: true",
			"",
		].join("\n"),
		"utf-8",
	);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.chdir(repo);

	// 模拟真实流程：蓝图阶段已写 wiki.json（generateWikiContent 只补页面正文）
	const wikiDir = join(repo, ".zread-pi", "wiki", "high");
	await mkdir(wikiDir, { recursive: true });
	await writeFile(
		join(wikiDir, "wiki.json"),
		JSON.stringify(
			{
				id: "test",
				generated_at: new Date().toISOString(),
				language: "zh",
				detail: "high",
				pages: [page],
				sections: [{ title: page.section, description: "说明" }],
			},
			null,
			2,
		),
		"utf-8",
	);

	const { generateWikiContent } = await import("../src/wiki/generate-wiki.js");
	const result = await generateWikiContent({ pages: [page], maxConcurrent: 1 });
	server.stop(true);

	check("页面生成成功", result.completed === 1 && result.failed === 0, `completed=${result.completed} failed=${result.failed}`);

	// 找到 run 目录并检查 verify.json
	const { readdir, readFile: readF } = await import("node:fs/promises");
	const runsDir = join(repo, ".zread-pi", "runs");
	const runIds = await readdir(runsDir).catch(() => []);
	check("生成了 run 目录", runIds.length === 1, JSON.stringify(runIds));

	const verifyPath = join(runsDir, runIds[0], "verify.json");
	const verifyJson = await readFile(verifyPath, "utf-8").catch(() => "");
	check("verify.json 已落盘到 run 目录", verifyJson.length > 0, verifyPath);
	if (verifyJson.length > 0) {
		const report = JSON.parse(verifyJson) as { ok: boolean; variant: string; checks: Array<{ status: string; group: string }> };
		check("verify.json 的 ok 与闸门一致（mock 产物结构类应通过）", typeof report.ok === "boolean");
		check("verify.json 命中生成的档位", report.variant === "high", String(report.variant));
		check(
			"verify.json 含全部六个检查组",
			["structure", "content", "mermaid", "frontmatter", "traceability", "coverage"].every((g) =>
				report.checks.some((c) => c.group === g),
			),
			JSON.stringify(report.checks.map((c) => `${c.group}:${c.status}`)),
		);
	}

	// run.json 不含 verify 字段（契约不变）
	const runJson = await readF(join(runsDir, runIds[0], "run.json"), "utf-8").catch(() => "");
	check("run.json 不被注入 verify 字段（契约不变）", !/"verify"/.test(runJson), runJson.slice(0, 80));

	process.chdir(join(repo, ".."));
	await rm(repo, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// M. coverage 组（结构优先蓝图 v2）：等式 / 排他 / 行台账 / excluded / SKIP 分支
// ---------------------------------------------------------------------------

console.log("\n▶ M. coverage 组");
{
	const { verifyWiki } = await import("../src/wiki/verify-wiki.js");
	const { computeManifestHash } = await import("@zread-pi/repo-analyzer");

	const previousCwd = process.cwd();

	// 两个源文件 + 清单 / 符号缓存（缓存走 process.cwd()，verify 前先 chdir 到临时仓库）
	const manifestFiles = [
		{ path: "src/a.ts", hash: "h1", size: 30, language: "typescript" },
		{ path: "src/b.ts", hash: "h2", size: 10, language: "typescript" },
	];
	const symbols = [
		{
			file: "src/a.ts",
			exports: ["a"],
			functions: [{ name: "a", signature: "() => number" }],
			imports: [] as string[],
			docstrings: [] as string[],
			lineCount: 3,
			ranges: [
				{ name: "a", start: 1, end: 1 },
				{ name: "b", start: 2, end: 2 },
				{ name: "c", start: 3, end: 3 },
			],
		},
		{
			file: "src/b.ts",
			exports: ["d"],
			functions: [{ name: "d", signature: "() => number" }],
			imports: [] as string[],
			docstrings: [] as string[],
			lineCount: 1,
			ranges: [{ name: "d", start: 1, end: 1 }],
		},
	];
	const hash = computeManifestHash({ files: manifestFiles });

	async function writeCaches(root: string, opts: { manifest?: boolean; symbols?: boolean } = {}): Promise<void> {
		const cacheDir = join(root, ".zread-pi", "cache");
		await mkdir(cacheDir, { recursive: true });
		if (opts.manifest !== false) {
			await writeFile(
				join(cacheDir, "last_manifest.json"),
				JSON.stringify({ version: "1.0", generated_at: new Date().toISOString(), files: manifestFiles }, null, 2),
				"utf-8",
			);
		}
		if (opts.symbols !== false) {
			await writeFile(
				join(cacheDir, "last_symbols.json"),
				JSON.stringify({ version: "1.0", generated_at: new Date().toISOString(), symbols, loadedParsers: ["typescript"] }, null, 2),
				"utf-8",
			);
		}
	}

	// Windows 不能删除 cwd：清理前先切回原目录
	async function cleanup(target: string): Promise<void> {
		process.chdir(previousCwd);
		await rm(target, { recursive: true, force: true }).catch(() => {});
	}

	function coverageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			manifestHash: hash,
			universeCount: 2,
			excluded: [],
			fileOwner: { "src/a.ts": "1-a", "src/b.ts": "2-b" },
			slicesBySection: {},
			modularity: 0.5,
			seamCount: 1,
			lines: { measured: 2, total: 4, declared: 4, gap: 0 },
			...overrides,
		};
	}

	const pageA: PageSpec = {
		slug: "1-a",
		title: "甲",
		file: "1-a.md",
		section: "工具函数",
		ownsFiles: ["src/a.ts"],
		body: "# 甲\n\n## 小节\n\n" + fatProse() + "\n\nSources: [a](src/a.ts#L1-2)",
	};
	const pageB: PageSpec = {
		slug: "2-b",
		title: "乙",
		file: "2-b.md",
		section: "工具函数",
		ownsFiles: ["src/b.ts"],
		body: "# 乙\n\n## 小节\n\n" + fatProse() + "\n\nSources: [b](src/b.ts#L1)",
	};

	// M1 v2 正常：C1~C4 全 PASS
	{
		const root = await buildWiki([pageA, pageB], {
			schemaVersion: 2,
			coverage: coverageOf(),
			sourceFiles: { "src/a.ts": ["l1", "l2", "l3"], "src/b.ts": ["l1"] },
		});
		await writeCaches(root);
		process.chdir(root);
		const report = await verifyWiki({ root });
		check("C1 覆盖等式 PASS", findCheck(report, "coverage", "覆盖等式成立")?.status === "PASS", report.checks.filter((c) => c.group === "coverage").map((c) => c.message).join(" | "));
		check("C2 排他 PASS", findCheck(report, "coverage", "排他")?.status === "PASS");
		check("C3 行台账 PASS（且信息行含已测文件数）", findCheck(report, "coverage", "行台账一致")?.status === "PASS");
		check("C4 excluded PASS", findCheck(report, "coverage", "excluded 一致")?.status === "PASS");
		check("v2 产物 OVERALL PASS", report.ok === true, report.checks.map((c) => `${c.group}:${c.status}`).join(","));
		await cleanup(root);
	}

	// M2 旧版产物（无 schemaVersion）→ 整组 SKIP
	{
		const root = await buildWiki([pageA], { sourceFiles: { "src/a.ts": ["l1"] } });
		await writeCaches(root);
		process.chdir(root);
		const report = await verifyWiki({ root });
		const cov = report.checks.filter((c) => c.group === "coverage");
		check("旧版产物 coverage 组只发一条 SKIP", cov.length === 1 && cov[0].status === "SKIP", JSON.stringify(cov));
		check("SKIP 说明点名重新 generate", cov[0]?.message.includes("重新 generate"), cov[0]?.message);
		await cleanup(root);
	}

	// M3 清单哈希不一致 → SKIP（哈希点名）
	{
		const root = await buildWiki([pageA], {
			schemaVersion: 2,
			coverage: coverageOf({ manifestHash: "deadbeef" }),
			sourceFiles: { "src/a.ts": ["l1"] },
		});
		await writeCaches(root);
		process.chdir(root);
		const report = await verifyWiki({ root });
		const cov = report.checks.filter((c) => c.group === "coverage");
		check("清单哈希不一致 → SKIP", cov.length === 1 && cov[0].status === "SKIP", JSON.stringify(cov));
		check("SKIP 明细含产物哈希与当前哈希", cov[0]?.message.includes("deadbeef") && cov[0]?.message.includes(hash), cov[0]?.message);
		await cleanup(root);
	}

	// M4 无缓存清单 → SKIP
	{
		const root = await buildWiki([pageA], {
			schemaVersion: 2,
			coverage: coverageOf(),
			sourceFiles: { "src/a.ts": ["l1"] },
		});
		await writeCaches(root, { manifest: false });
		process.chdir(root);
		const report = await verifyWiki({ root });
		const cov = report.checks.filter((c) => c.group === "coverage");
		check("无缓存清单 → SKIP", cov.length === 1 && cov[0].status === "SKIP" && cov[0].message.includes("无缓存文件清单"), JSON.stringify(cov));
		await cleanup(root);
	}

	// M5 双归属 → C2 FAIL（details 点名两个页面）
	{
		const root = await buildWiki([pageA, { ...pageB, ownsFiles: ["src/b.ts", "src/a.ts"] }], {
			schemaVersion: 2,
			coverage: coverageOf(),
			sourceFiles: { "src/a.ts": ["l1", "l2", "l3"], "src/b.ts": ["l1"] },
		});
		await writeCaches(root);
		process.chdir(root);
		const report = await verifyWiki({ root });
		const c2 = findCheck(report, "coverage", "被多个页面同时拥有");
		check("双归属 → C2 FAIL", c2?.status === "FAIL", `${c2?.status} ${c2?.message}`);
		check("C2 明细点名两个页面", (c2?.details ?? []).some((d) => d.includes("1-a") && d.includes("2-b")), JSON.stringify(c2?.details));
		check("双归属导致 OVERALL FAIL", report.ok === false);
		await cleanup(root);
	}

	// M6 漏归属 → C1 FAIL（unclaimed）+ C4 FAIL（excluded 不一致）
	{
		const root = await buildWiki([pageA, { ...pageB, ownsFiles: [] }], {
			schemaVersion: 2,
			coverage: coverageOf(),
			sourceFiles: { "src/a.ts": ["l1", "l2", "l3"], "src/b.ts": ["l1"] },
		});
		await writeCaches(root);
		process.chdir(root);
		const report = await verifyWiki({ root });
		const c1 = findCheck(report, "coverage", "覆盖等式不成立");
		check("漏归属 → C1 FAIL", c1?.status === "FAIL", `${c1?.status} ${c1?.message} :: ${JSON.stringify(c1?.details)}`);
		check("C1 明细点名未归属文件", (c1?.details ?? []).some((d) => d.includes("src/b.ts")), JSON.stringify(c1?.details));
		const c4 = findCheck(report, "coverage", "excluded 与 (manifest − U) 不一致");
		check("漏归属 → C4 FAIL", c4?.status === "FAIL", `${c4?.status} ${c4?.message}`);
		await cleanup(root);
	}

	// M7 行台账：ranges 越界 + coverage.lines 与独立重算不符 → C3 FAIL
	{
		const root = await buildWiki([pageA], {
			schemaVersion: 2,
			coverage: coverageOf({ universeCount: 1, fileOwner: { "src/a.ts": "1-a" }, lines: { measured: 1, total: 3, declared: 3, gap: 0 } }),
			sourceFiles: { "src/a.ts": ["l1", "l2", "l3"] },
		});
		// 符号缓存里的区间越界（end > lineCount）
		await writeCaches(root);
		const symbolsPath = join(root, ".zread-pi", "cache", "last_symbols.json");
		const cached = JSON.parse(await readFile(symbolsPath, "utf-8")) as { symbols: Array<{ file: string; lineCount: number; ranges: Array<{ name: string; start: number; end: number }> }> };
		cached.symbols[0].ranges = [{ name: "a", start: 1, end: 99 }];
		await writeFile(symbolsPath, JSON.stringify(cached, null, 2), "utf-8");
		process.chdir(root);
		const report = await verifyWiki({ root });
		const c3 = findCheck(report, "coverage", "行台账不一致");
		check("ranges 越界 → C3 FAIL", c3?.status === "FAIL", `${c3?.status} ${c3?.message}`);
		check("C3 明细点名文件与区间", (c3?.details ?? []).some((d) => d.includes("src/a.ts") && d.includes("1-99")), JSON.stringify(c3?.details));
		await cleanup(root);
	}

	process.chdir(previousCwd);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
