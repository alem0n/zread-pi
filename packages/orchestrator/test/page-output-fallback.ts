/**
 * page-output-fallback.ts —— write_page「写错路径」落盘兜底专项
 *
 * 验证 rescuePageFile() 的救援链与安全边界（不经过 Agent，直接构造文件与调用记录）：
 *   1. write_page 报告过真实落盘路径 → 移动到 wiki.json 约定位置；
 *   2. 拿不到报告路径 → 按模型传入的 file/section 复算路径；
 *   3. 再退一步 → 在 .zread-pi/wiki 下按文件名扫描（跳过 archived/ 历史快照）；
 *   4. 找不到任何候选文件时返回 null，不误移其它文件。
 * 同时覆盖 resolvePageOutputPath() 的路径解析规则（与 WritePageTool 共用）。
 *
 * 运行：bun run packages/orchestrator/test/page-output-fallback.ts
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPage } from "@zread-pi/types";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const repo = await mkdtemp(join(tmpdir(), "zread-pi-page-fallback-"));
const wikiDir = join(repo, ".zread-pi", "wiki");
await mkdir(wikiDir, { recursive: true });

const { rescuePageFile } = await import("../src/wiki/generate-wiki.js");
const { resolvePageOutputPath } = await import("../src/tools/page-tools.js");

function makePage(slug: string, file: string, section: string): WikiPage {
	return { slug, title: slug, file, section, level: "Beginner" };
}

const readIfExists = (path: string): Promise<string> => readFile(path, "utf-8").catch(() => "");

// ---------------------------------------------------------------------------
// 1) write_page 报告过真实落盘路径：直接移动
// ---------------------------------------------------------------------------

const page1 = makePage("1-recorded", "1-recorded.md", "指南");
const wrong1 = join(wikiDir, "1-recorded.md");
const target1 = join(wikiDir, "指南", "1-recorded.md");
await writeFile(wrong1, "# recorded\n", "utf-8");

const rescuedFrom1 = await rescuePageFile(
	page1,
	[{ cwd: repo, slug: page1.slug, outputPath: wrong1 }],
	wikiDir,
);

check(
	"报告路径存在时被移动到约定位置（返回源路径、源文件已移除）",
	rescuedFrom1 === wrong1 &&
		(await readIfExists(target1)).includes("# recorded") &&
		(await readIfExists(wrong1)) === "",
	`rescuedFrom=${rescuedFrom1}`,
);

// ---------------------------------------------------------------------------
// 2) 没有报告路径：按模型传入参数复算路径
// ---------------------------------------------------------------------------

const page2 = makePage("2-derived", "2-derived.md", "指南");
const wrong2 = join(wikiDir, "错误章节", "2-derived.md");
const target2 = join(wikiDir, "指南", "2-derived.md");
await mkdir(join(wikiDir, "错误章节"), { recursive: true });
await writeFile(wrong2, "# derived\n", "utf-8");

const rescuedFrom2 = await rescuePageFile(
	page2,
	[{ cwd: repo, slug: page2.slug, file: page2.file, section: "错误章节" }],
	wikiDir,
);

check(
	"没有报告路径时按模型传入参数复算并移动",
	rescuedFrom2 === wrong2 &&
		(await readIfExists(target2)).includes("# derived") &&
		(await readIfExists(wrong2)) === "",
	`rescuedFrom=${rescuedFrom2}`,
);

// ---------------------------------------------------------------------------
// 3) 最后一层：在 wiki 目录下按文件名扫描
// ---------------------------------------------------------------------------

const page3 = makePage("3-scan", "3-scan.md", "指南");
const wrong3 = join(wikiDir, "深层", "嵌套", "3-scan.md");
const target3 = join(wikiDir, "指南", "3-scan.md");
await mkdir(join(wikiDir, "深层", "嵌套"), { recursive: true });
await writeFile(wrong3, "# scan\n", "utf-8");

const rescuedFrom3 = await rescuePageFile(page3, [{ cwd: repo, slug: page3.slug }], wikiDir);

check(
	"缺参数时按文件名扫描并移动到约定位置",
	rescuedFrom3 === wrong3 &&
		(await readIfExists(target3)).includes("# scan") &&
		(await readIfExists(wrong3)) === "",
	`rescuedFrom=${rescuedFrom3}`,
);

// ---------------------------------------------------------------------------
// 4) 找不到候选文件：返回 null，不误报、不误移
// ---------------------------------------------------------------------------

const page4 = makePage("4-none", "4-none.md", "指南");
const rescuedFrom4 = await rescuePageFile(page4, [{ cwd: repo, slug: page4.slug }], wikiDir);

check(
	"找不到候选文件时返回 null 且不产生目标文件",
	rescuedFrom4 === null && (await readIfExists(join(wikiDir, "指南", "4-none.md"))) === "",
	`rescuedFrom=${rescuedFrom4}`,
);

// ---------------------------------------------------------------------------
// 5) 安全边界：archived/ 是历史快照，不能当作本次产物
// ---------------------------------------------------------------------------

const page5 = makePage("5-arch", "5-arch.md", "指南");
const archived5 = join(wikiDir, "archived", "20260901", "5-arch.md");
await mkdir(join(wikiDir, "archived", "20260901"), { recursive: true });
await writeFile(archived5, "# archived\n", "utf-8");

const rescuedFrom5 = await rescuePageFile(page5, [{ cwd: repo, slug: page5.slug }], wikiDir);

check(
	"扫描跳过 archived/ 历史快照（返回 null 且快照原位保留）",
	rescuedFrom5 === null && (await readIfExists(archived5)).includes("# archived"),
	`rescuedFrom=${rescuedFrom5}`,
);

// ---------------------------------------------------------------------------
// 6) 路径解析规则（WritePageTool 与兜底共用）
// ---------------------------------------------------------------------------

check(
	"路径解析：file 含分隔符时忽略 section",
	resolvePageOutputPath(repo, { file: "a/b.md", section: "s", slug: "x" }) ===
		join(repo, ".zread-pi", "wiki", "a", "b.md"),
);
check(
	"路径解析：缺 file 时退回 <slug>.md",
	resolvePageOutputPath(repo, { slug: "x" }) === join(repo, ".zread-pi", "wiki", "x.md"),
);

// ---------------------------------------------------------------------------

await rm(repo, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
