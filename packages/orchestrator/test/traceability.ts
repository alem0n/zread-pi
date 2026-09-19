/**
 * traceability.ts —— 溯源台账纯函数验证
 *
 * 对齐 lecture-to-notes 的 extract_claims.py 的两段式「提取 → 逐条 check」
 * （见 plan.md §3.3 / §5.5）：先解析页面声称的全部溯源声明，再逐条对照
 * 仓库事实（manifest / 磁盘 / 符号缓存 / 文件行数）。
 *
 * 运行：bun run packages/orchestrator/test/traceability.ts
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SymbolManifest } from "@zread-pi/types";
import {
	parseSourceRefs,
	collectKnownSymbols,
	findUnresolvedSymbols,
	collectManifestPaths,
	isPathReal,
	countLines,
	checkAssociatedFiles,
	checkTraceability,
} from "../src/wiki/traceability.js";
import type { WikiPage } from "@zread-pi/types";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ==================== B. 符号解析 ====================

console.log("\n▶ B. collectKnownSymbols / findUnresolvedSymbols");

{
	const symbols: SymbolManifest = {
		symbols: [
			{
				file: "src/a.ts",
				exports: ["foo", "Bar"],
				functions: [{ name: "baz", signature: "() => void" }],
				imports: ["qux"],
				docstrings: [],
			},
		],
		loadedParsers: ["typescript"],
	};
	const known = collectKnownSymbols(symbols);
	check("exports / functions / imports 全部进已知集合", ["foo", "Bar", "baz", "qux"].every((n) => known.has(n)));
	check("空清单返回空集合（size=0 → 调用方 SKIP）", collectKnownSymbols(null).size === 0);
	check("空清单返回空集合（undefined）", collectKnownSymbols(undefined).size === 0);

	const ok = findUnresolvedSymbols("调用 `foo`、`baz`（已定义）与 `qux`", known);
	check("全部已知的标识符不报", ok.length === 0, JSON.stringify(ok));

	const mixed = findUnresolvedSymbols("真的有 `foo`，幻觉了 `doesNotExistYet`", known);
	check("幻觉标识符被列出", mixed.length === 1 && mixed[0] === "doesNotExistYet", JSON.stringify(mixed));

	// 围栏剥离：代码块内的标识符不当成溯源引用
	const fenced = findUnresolvedSymbols(
		["散文里的 `foo` 是真的", "", "```ts", "const foo = doesNotExistAlso;", "```"].join("\n"),
		known,
	);
	check("围栏代码块内的标识符被剥离", fenced.length === 0, JSON.stringify(fenced));

	// 短名 / 非标识符不报（噪声）
	const noise = findUnresolvedSymbols("`ab` `1x` `foo-bar` `with space`", known);
	check("非标识符 / 过短名不报", noise.length === 0, JSON.stringify(noise));

	// 已知集合为空时整体跳过（没有台账就无据可判）
	check("known 为空时 findUnresolvedSymbols 返回空", findUnresolvedSymbols("`anything`", new Set()).length === 0);

	// 上限保护
	const many = findUnresolvedSymbols(
		Array.from({ length: 60 }, (_, i) => `\`sym${i}\``).join(" "),
		new Set(["sym0"]),
		24,
	);
	check("上报数量有上限（24）", many.length === 24, String(many.length));
}

// ==================== C. 路径台账 ====================

console.log("\n▶ C. collectManifestPaths / isPathReal");

let repo: string;
{
	repo = await mkdtemp(join(tmpdir(), "zread-trace-repo-"));
	await mkdir(join(repo, "src"), { recursive: true });
	await writeFile(join(repo, "src", "a.ts"), "export const foo = 1;\n", "utf-8");

	const manifestPaths = collectManifestPaths({
		version: "1.0",
		files: [{ path: "src/a.ts", hash: "h1", size: 10 }],
	});
	check("manifest 路径集合包含已扫描文件", manifestPaths.has("src/a.ts"));
	check("manifest 路径集合不含未扫描文件", !manifestPaths.has("src/b.ts"));
	check("manifest 里的反斜杠路径归一化为正斜杠", collectManifestPaths({
		version: "1.0",
		files: [{ path: "src\\a.ts", hash: "h1", size: 10 }],
	}).has("src/a.ts"));
	check("manifest 命中即真实", isPathReal(repo, "src/a.ts", manifestPaths));
	check("manifest 未命中但磁盘存在也算真实（非源文件兜底）", isPathReal(repo, "src", manifestPaths));
	check("既不在 manifest 也不在磁盘 → 不真实", !isPathReal(repo, "src/nope.ts", manifestPaths));
	check("空 manifest 时纯走磁盘", isPathReal(repo, "src/a.ts", collectManifestPaths(null)));
}

// ==================== D. countLines ====================

console.log("\n▶ D. countLines（流式按行计数）");

{
	const multi = join(repo, "src", "multi.ts");
	await writeFile(multi, ["line1", "line2", "line3"].join("\n") + "\n", "utf-8");
	const counted = await countLines(multi);
	check("多行文件计数正确", counted === 3, String(counted));

	const empty = join(repo, "src", "empty.ts");
	await writeFile(empty, "", "utf-8");
	const emptyCount = await countLines(empty);
	check("空文件计数为 0", emptyCount === 0, String(emptyCount));

	check("不存在的文件返回 undefined", (await countLines(join(repo, "src", "nope.ts"))) === undefined);
}

// ==================== E. checkAssociatedFiles ====================

console.log("\n▶ E. checkAssociatedFiles（蓝图维度，复活 validate_blueprint）");

{
	const pages: WikiPage[] = [
		{ slug: "p1", title: "P1", section: "s", file: "p1.md", associatedFiles: ["src/a.ts"] },
		{ slug: "p2", title: "P2", section: "s", file: "p2.md", associatedFiles: ["src/a.ts", "src/nope.ts"] },
		{ slug: "p3", title: "P3", section: "s", file: "p3.md", associatedFiles: [] },
	];
	const manifestPaths = collectManifestPaths(null);
	const issues = checkAssociatedFiles(pages, repo, manifestPaths);
	check("存在的关联文件不报", !issues.some((i) => i.slug === "p1"));
	check("缺失的关联文件被列出", issues.length === 1 && issues[0].slug === "p2" && issues[0].missing[0] === "src/nope.ts", JSON.stringify(issues));
	check("无 associatedFiles 的页面不报（缺省即空数组）", !issues.some((i) => i.slug === "p3"));
}

// ==================== F. checkTraceability 端到端 ====================

console.log("\n▶ F. checkTraceability（提取 → 逐条 check）");

{
	// 造源文件：a.ts 3 行（有效区间）、b.ts 3 行（越界区间）、c.ts 缺失
	await writeFile(join(repo, "src", "a.ts"), "l1\nl2\nl3\n", "utf-8");
	await writeFile(join(repo, "src", "b.ts"), "l1\nl2\nl3\n", "utf-8");
	await mkdir(join(repo, "wiki", "high", "s"), { recursive: true });

	const goodPage: WikiPage = { slug: "good", title: "Good", section: "s", file: "good.md" };
	const badLinePage: WikiPage = { slug: "badline", title: "BadLine", section: "s", file: "badline.md" };
	const badPathPage: WikiPage = { slug: "badpath", title: "BadPath", section: "s", file: "badpath.md" };
	const dupPage: WikiPage = { slug: "dup", title: "Dup", section: "s", file: "dup.md" };

	const contents = new Map<string, string>([
		[goodPage.slug, "正文\n\nSources: [a](src/a.ts#L1-3)"],
		[badLinePage.slug, "正文\n\nSources: [b](src/b.ts#L100-200)"],
		[badPathPage.slug, "正文\n\nSources: [missing](src/c.ts#L1-2)"],
		// 与 goodPage 声明同一区间 → 跨页重复
		[dupPage.slug, "正文\n\nSources: [a-again](src/a.ts#L1-3)"],
	]);

	const noSymbols = await checkTraceability({
		root: repo,
		pages: [goodPage, badLinePage, badPathPage, dupPage],
		contents,
		manifest: null,
		symbols: null,
	});

	check("提取到全部 4 个引用", noSymbols.refs.length === 4, String(noSymbols.refs.length));
	check("badPaths 计 1（src/c.ts）", noSymbols.badPaths.length === 1, JSON.stringify(noSymbols.badPaths));
	check("badLines 计 1（L100-200 越界）", noSymbols.badLines.length === 1, JSON.stringify(noSymbols.badLines));
	check("badLines 带文件总行数信息", noSymbols.badLines[0].includes("共 3 行"), noSymbols.badLines[0]);
	check("duplicateClaims 计 1（good 与 dup 同一区间）", noSymbols.duplicateClaims.length === 1, JSON.stringify(noSymbols.duplicateClaims));
	check("无符号缓存 → symbolsUnavailable=true（调用方 SKIP）", noSymbols.symbolsUnavailable === true);
	check("无符号缓存 → 不做符号检查", noSymbols.unresolvedSymbols.length === 0);
	check("noSources=false（有 Sources 行）", noSymbols.noSources === false);

	// 反转区间（x > y）也该判失败
	const reversed = await checkTraceability({
		root: repo,
		pages: [goodPage],
		contents: new Map([[goodPage.slug, "Sources: [a](src/a.ts#L3-1)"]]),
		manifest: null,
		symbols: null,
	});
	check("反转区间（L3-1）判行号无效", reversed.badLines.length === 1, JSON.stringify(reversed.badLines));

	// 单行 #L2 形式
	const single = await checkTraceability({
		root: repo,
		pages: [goodPage],
		contents: new Map([[goodPage.slug, "Sources: [a](src/a.ts#L2)"]]),
		manifest: null,
		symbols: null,
	});
	check("单行 #L2 解析为 2..2 且有效", single.refs[0].lineFrom === 2 && single.refs[0].lineTo === 2 && single.badLines.length === 0, JSON.stringify(single.refs));

	// noSources
	const none = await checkTraceability({
		root: repo,
		pages: [goodPage],
		contents: new Map([[goodPage.slug, "正文，无 Sources 行"]]),
		manifest: null,
		symbols: null,
	});
	check("无 Sources 行 → noSources=true", none.noSources === true && none.refs.length === 0);
}

// ==================== G. checkTraceability 符号维度 ====================

console.log("\n▶ G. checkTraceability 符号维度（WARN）");

{
	const page: WikiPage = { slug: "sym", title: "Sym", section: "s", file: "sym.md" };
	await writeFile(join(repo, "src", "a.ts"), "export const foo = 1;\n", "utf-8");
	const symbols: SymbolManifest = {
		symbols: [{ file: "src/a.ts", exports: ["foo"], functions: [], imports: [], docstrings: [] }],
		loadedParsers: ["typescript"],
	};

	const clean = await checkTraceability({
		root: repo,
		pages: [page],
		contents: new Map([[page.slug, "正文引用 `foo`，是真的\n\nSources: [a](src/a.ts)"]]),
		manifest: null,
		symbols,
	});
	check("符号缓存存在 → symbolsUnavailable=false", clean.symbolsUnavailable === false);
	check("全部符号可溯 → 无未解析项", clean.unresolvedSymbols.length === 0, JSON.stringify(clean.unresolvedSymbols));

	const hallucinated = await checkTraceability({
		root: repo,
		pages: [page],
		contents: new Map([[page.slug, "引用 `foo` 与幻觉的 `totallyMadeUp`\n\nSources: [a](src/a.ts)"]]),
		manifest: null,
		symbols,
	});
	check(
		"幻觉符号被列入 unresolvedSymbols（带页面 slug）",
		hallucinated.unresolvedSymbols.length === 1 && hallucinated.unresolvedSymbols[0].includes("totallyMadeUp"),
		JSON.stringify(hallucinated.unresolvedSymbols),
	);
}

// ==================== H. 外链 / 锚点排除 ====================

console.log("\n▶ H. 外链与纯锚点不参与校验");

{
	const page: WikiPage = { slug: "ext", title: "Ext", section: "s", file: "ext.md" };
	const refs = parseSourceRefs(
		"Sources: [外链](https://example.com/x) · [邮箱](mailto:a@b.c) · [锚点](#sec) · [真](src/a.ts)",
		page.slug,
	);
	check("外链 / 邮箱 / 纯锚点被排除，只留仓库内引用", refs.length === 1 && refs[0].path === "src/a.ts", JSON.stringify(refs.map((r) => r.path)));
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
