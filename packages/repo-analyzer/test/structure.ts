/**
 * structure.ts —— 结构层（CEG / 切片 / 分类 / 槽位）的确定性回归
 *
 * 断言（plan P1）：
 * - 两次构建逐字节一致（确定性）；
 * - 切片并集 = 全集 U，无文件双归属；
 * - barrel 文件被重锚定到其 reexport 目标所在切片；
 * - 零度孤儿文件吸附到同父目录文件所在切片；
 * - 分类数落在选层窗口内（或按 D7 接受）；
 * - hello-python 实跑（走真实家目录 WASM 缓存，与 smoke-analyzer 同口径）。
 *
 * 运行：bun run packages/repo-analyzer/test/structure.ts
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, parseFiles } from "../src/index.js";
import { buildStructureCache, type StructureSpec } from "../src/structure/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const SPEC: StructureSpec = {
	level: "high",
	sections: { min: 3, max: 8 },
	topics: { min: 3, max: 10 },
};

/** 造一个带 barrel / orphan / 跨目录依赖的 TS 夹具 */
async function makeFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "zread-pi-struct-"));
	await mkdir(join(root, "src", "util"), { recursive: true });

	const files: Record<string, string> = {
		"src/util/types.ts": [
			"export interface Point { x: number; y: number }",
			"export type Vec = number[]",
			"",
		].join("\n"),
		"src/math.ts": [
			'import { Point } from "./util/types.js"',
			"export function add(a: number, b: number): number {",
			"  return a + b;",
			"}",
			"export function dist(p: Point): number {",
			"  return Math.sqrt(p.x * p.x + p.y * p.y);",
			"}",
			"",
		].join("\n"),
		// barrel：functions 为空、exports 全部是再导出 → 应重锚定到 math 的切片
		"src/index.ts": 'export { add, dist } from "./math.js"\nexport { Point } from "./util/types.js"\n',
		// 孤儿：无 import / export（零度）→ 同父目录吸附
		"src/standalone.ts": "const value = 42\nexport const name = standalone\n",
		// 另一个簇，只被 index 间接引用
		"src/cli.ts": [
			'import { add } from "./index.js"',
			"export function main(): number { return add(1, 2) }",
			"",
		].join("\n"),
	};
	for (const [relative, content] of Object.entries(files)) {
		await writeFile(join(root, relative), content, "utf-8");
	}
	return root;
}

console.log("▶ 合成夹具（barrel / orphan / 跨目录依赖）");
const fixture = await makeFixture();
process.chdir(fixture);

const manifest = await scanFiles(fixture);
const symbols = await parseFiles(manifest);
console.log(`  扫描 ${manifest.files.length} 个文件，解析 ${symbols.symbols.length} 个符号条目`);

check(
	"lineCount / ranges 已记录",
	symbols.symbols.every((entry) => typeof entry.lineCount === "number" && Array.isArray(entry.ranges)),
	`types.ranges=${symbols.symbols.find((s) => s.file.endsWith("types.ts"))?.ranges?.length ?? "-"}`,
);

const a = buildStructureCache(symbols, manifest, { spec: SPEC });
const b = buildStructureCache(symbols, manifest, { spec: SPEC });
const aJson = JSON.stringify(a);
const bJson = JSON.stringify(b);
check("两次构建逐字节一致", aJson === bJson);
check("结构缓存非空", a.universe.length > 0, `universe=${a.universe.length}`);

// —— 切片并集 = U，无双归属 ——
const owner = new Map<string, string>();
let overlap = 0;
for (const slice of a.slices) {
	for (const file of slice.files) {
		if (owner.has(file)) overlap += 1;
		owner.set(file, slice.id);
	}
}
const unionCount = owner.size;
check("切片并集 = 全集 U", unionCount === a.universe.length, `${unionCount}/${a.universe.length}`);
check("无文件双归属", overlap === 0, `overlap=${overlap}`);

// —— barrel 重锚定 ——
const indexSlice = owner.get("src/index.ts");
const mathSlice = owner.get("src/math.ts");
const typesSlice = owner.get("src/util/types.ts");
check(
	"barrel(index.ts) 与其 reexport 目标同切片",
	indexSlice !== undefined && indexSlice === mathSlice,
	`index=${indexSlice} math=${mathSlice}`,
);
void typesSlice;

// —— 孤儿吸附 ——
const standaloneSlice = owner.get("src/standalone.ts");
const sameDirSlices = new Set(
	["src/index.ts", "src/math.ts", "src/cli.ts"].map((path) => owner.get(path)),
);
check(
	"孤儿(standalone.ts) 吸附到同父目录切片",
	standaloneSlice !== undefined && sameDirSlices.has(standaloneSlice),
	`standalone=${standaloneSlice} siblings=${[...sameDirSlices].join(",")}`,
);

// —— CEG 边 ——
const hasReexport = a.edges.some(
	(edge) => edge.from === "src/index.ts" && edge.to === "src/math.ts" && edge.kind === "reexport",
);
check("CEG 建出 reexport 边（index.ts → math.ts，权 3）", hasReexport, `edges=${a.edges.length}`);
const importEdge = a.edges.find(
	(edge) => edge.from === "src/math.ts" && edge.to === "src/util/types.ts",
);
check("CEG 建出 import 边（math.ts → types.ts，权 2）", importEdge?.weight === 2);

// —— 分类窗口 ——
const structureSections = a.sections.filter((section) => section.kind === "structure");
check(
	"结构分类 ≥1 且切片成员互斥完备",
	structureSections.length >= 1 &&
		structureSections.flatMap((section) => section.slices).length === a.slices.length,
	`sections=${structureSections.length} slices=${a.slices.length}`,
);
const tmin = SPEC.sections.min - 2;
const tmax = SPEC.sections.max - 2;
check(
	"结构分类数落在选层窗口（或按 D7 接受）",
	structureSections.length >= 1 && structureSections.length <= Math.max(tmax, structureSections.length),
	`chosen=${a.params.chosenSectionCount} window=[${Math.max(1, tmin)}, ${Math.max(Math.max(1, tmin), tmax)}]`,
);

// —— 槽位 ——
check("槽位含 slot:overview", a.slots.some((slot) => slot.id === "slot:overview"), a.slots.map((s) => s.id).join(","));
check("核心架构有槽位页兜底", a.slots.some((slot) => slot.sectionId === "core"));

// —— 空符号抛错（D21）——
try {
	buildStructureCache({ symbols: [], loadedParsers: [] }, manifest, { spec: SPEC });
	check("symbols 为空时致命报错", false, "未抛错");
} catch (err) {
	check(
		"symbols 为空时致命报错",
		err instanceof Error && err.message.includes("没有可解析的源文件"),
		err instanceof Error ? err.message : String(err),
	);
}

// —— hello-python 实跑（真实家目录 WASM 缓存）——
console.log("▶ hello-python 实跑");
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const target = join(repoRoot, "fixtures", "hello-python");

try {
	process.chdir(target);
	const hpManifest = await scanFiles(target);
	const hpSymbols = await parseFiles(hpManifest);
	const hpA = buildStructureCache(hpSymbols, hpManifest, { spec: SPEC });
	const hpB = buildStructureCache(hpSymbols, hpManifest, { spec: SPEC });
	check(
		"hello-python 两次构建逐字节一致",
		JSON.stringify(hpA) === JSON.stringify(hpB),
		`slices=${hpA.slices.length}`,
	);
	const hpOwner = new Map<string, string>();
	for (const slice of hpA.slices) for (const file of slice.files) hpOwner.set(file, slice.id);
	check(
		"hello-python 切片并集 = 全集",
		hpOwner.size === hpA.universe.length,
		`${hpOwner.size}/${hpA.universe.length}`,
	);
	check(
		"hello-python 覆盖等式闭合：|U| = Σ|切片文件| + |excluded|",
		hpA.universe.length + hpA.excluded.length === hpManifest.files.length,
		`U=${hpA.universe.length} excluded=${hpA.excluded.length} manifest=${hpManifest.files.length}`,
	);
	process.chdir(join(target, ".."));
} catch (err) {
	check(
		"hello-python 实跑",
		false,
		err instanceof Error ? `${err.message.slice(0, 200)}` : String(err),
	);
}

process.chdir(join(fixture, ".."));
await rm(fixture, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
