/**
 * smoke-analyzer.ts —— 验证未改动的 RepoAnalyzer（含 web-tree-sitter WASM 解析）在新工程中仍可运行
 *
 * 注意：解析器 WASM 首次运行会从 CDN 下载并缓存到 ~/.zread/parsers（这是原仓库既有行为，未改动）。
 *
 * 运行：bun run packages/repo-analyzer/test/smoke-analyzer.ts
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, parseFiles } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const fixture = await mkdtemp(join(tmpdir(), "open-zread-fixture-"));
// RepoAnalyzer 的既有行为：parseFiles 以 process.cwd() 为根解析相对路径，
// 因此使用它的工作流必须先切到目标仓库根目录（Orchestrator 也遵循这一约定）。
process.chdir(fixture);
await mkdir(join(fixture, "src"), { recursive: true });
await writeFile(
	join(fixture, "src", "math.ts"),
	[
		"export interface Point { x: number; y: number }",
		"export function add(a: number, b: number): number {",
		"  return a + b;",
		"}",
		"export class Calc {",
		"  sum(p: Point): number { return p.x + p.y; }",
		"}",
		"",
	].join("\n"),
	"utf-8",
);
await writeFile(
	join(fixture, "src", "index.ts"),
	'import { add } from "./math.js"\nexport const five = add(2, 3)\n',
	"utf-8",
);

console.log("▶ scanFiles() …");
const manifest = await scanFiles(fixture);
console.log(`  文件数: ${manifest.files.length}`);
for (const file of manifest.files) console.log(`   - ${file.path} [${file.language}]`);

console.log("▶ parseFiles() …");
const symbols = await parseFiles(manifest);
for (const entry of symbols.symbols) {
	console.log(`   - ${entry.file}: exports=${entry.exports.join(",") || "-"}`);
}

check("scanFiles 找到 2 个源文件", manifest.files.length === 2, String(manifest.files.length));check(
	"文件均被识别为 TypeScript",
	manifest.files.every((file) => file.language === "typescript"),
	manifest.files.map((file) => file.language).join(","),
);
const mathFile = symbols.symbols.find((entry) => entry.file.includes("math"));
check(
	"parseFiles 提取到导出声明（含 add）",
	Boolean(mathFile?.exports.some((declaration) => /\badd\b/.test(declaration))),
	mathFile?.exports.join(" | "),
);
check(
	"parseFiles 提取到带签名的符号",
	Boolean(mathFile?.functions.some((fn) => fn.name === "sum")),
	mathFile?.functions.map((fn) => `${fn.name}: ${fn.signature}`).join(" | "),
);
check("解析器已加载", symbols.loadedParsers.length > 0, symbols.loadedParsers.join(","));

process.chdir(join(fixture, ".."));
await rm(fixture, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
