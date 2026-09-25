/**
 * machine-blueprint.ts —— 结构优先蓝图 P2：机器骨架 + 命名阶段不变性
 *
 * 断言（plan P2 / §6）：
 * - 机器蓝图 sections = 概览 + 核心架构 + 结构分类（id / title 逐项对应结构层）；
 * - 页号顺序：slot:overview(0) → slot:seams(1) → hub(2..) → 切片页(续)；
 * - 切片页 ownsFiles 互斥且并集 = U；associatedFiles ⊇ ownsFiles；refs 只指向他分类页；
 * - coverage 与 pages 逐项一致（fileOwner / slicesBySection）；
 * - applySectionNames 只改 title / description / scope，且改名传播到 pages[].section；
 *   基础分类的 title / description 提交被忽略；id / slices / 顺序不变；
 * - applyPageNames 只改 title / topicSummary / group / level，
 *   slug / file / section / ownsFiles / associatedFiles / refs 恒不变；
 * - minimal：1 分类 1 页，ownsFiles = U。
 *
 * 运行：bun run packages/orchestrator/test/machine-blueprint.ts
 */

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, parseFiles, buildStructureCache } from "../../repo-analyzer/src/index.js";
import {
	buildMachineBlueprint,
	initWikiBlueprint,
	applySectionNames,
	applyPageNames,
	loadWikiBlueprint,
} from "../../utils/src/output/wiki-content.js";
import type { AppConfig, WikiOutput, WikiPage } from "@zread-pi/types";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const SPEC = {
	level: "high",
	sections: { min: 3, max: 8 },
	topics: { min: 3, max: 10 },
} as const;

const CONFIG: AppConfig = { doc_language: "zh" } as AppConfig;

/** 复用 P1 的夹具形态：barrel / orphan / 跨目录依赖 / 两个簇 */
async function makeFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "zread-mb-"));
	await mkdir(join(root, "src", "util"), { recursive: true });
	await mkdir(join(root, "src", "web"), { recursive: true });

	const files: Record<string, string> = {
		"src/util/types.ts": "export interface Point { x: number; y: number }\nexport type Vec = number[]\n",
		"src/util/math.ts": 'import { Point } from "./types.js"\nexport function dist(p: Point): number {\n  return Math.sqrt(p.x * p.x + p.y * p.y)\n}\n',
		"src/util/index.ts": 'export { dist } from "./math.js"\nexport { Point } from "./types.js"\n',
		"src/web/server.ts": 'import { dist } from "../util/index.js"\nexport function serve(): number { return dist({ x: 1, y: 2 }) }\n',
		"src/web/handler.ts": 'import { Point } from "../util/types.js"\nexport function handle(p: Point): void { void p }\n',
		"src/standalone.ts": "const value = 42\n",
	};
	for (const [relative, content] of Object.entries(files)) {
		await writeFile(join(root, relative), content, "utf-8");
	}
	return root;
}

const fixture = await makeFixture();
process.chdir(fixture);

const manifest = await scanFiles(fixture);
const symbols = await parseFiles(manifest);
const cache = buildStructureCache(symbols, manifest, { spec: SPEC, language: "zh" });

console.log("▶ 机器蓝图（非 minimal）");
const blueprint = buildMachineBlueprint(cache, CONFIG, { variant: "high" });

const sectionIds = blueprint.sections.map((section) => section.id ?? "");
check(
	"sections = 概览 + 核心架构 + 结构分类",
	sectionIds[0] === "overview" && sectionIds[1] === "core" && sectionIds.length >= 3,
	sectionIds.join(","),
);
check(
	"结构分类 id / title / slices 与结构层一致",
	blueprint.sections.slice(2).every((section) => {
		const machine = cache.sections.find((entry) => entry.id === section.id);
		return (
			machine !== undefined &&
			machine.title === section.title &&
			machine.slices.join(",") === (section.slices ?? []).join(",")
		);
	}),
);

const ids = blueprint.pages.map((entry) => entry.id);
const overviewIndex = ids.indexOf("slot:overview");
const sliceStart = ids.findIndex((id) => id.startsWith("slice:"));
check(
	"页号顺序：slot:overview 在最前，切片页在槽位页之后",
	overviewIndex === 0 && sliceStart > overviewIndex && sliceStart === ids.filter((id) => id.startsWith("slot:")).length,
	ids.join(","),
);
check("每个机器页 slug / file 一致（file = slug.md）",
	blueprint.pages.every((entry) => entry.page.file === `${entry.page.slug}.md`));

// —— 切片页互斥完备 ——
const slicePages = blueprint.pages.filter((entry) => entry.id.startsWith("slice:"));
const owner = new Map<string, string>();
let overlap = 0;
for (const entry of slicePages) {
	for (const file of entry.page.ownsFiles ?? []) {
		if (owner.has(file)) overlap += 1;
		owner.set(file, entry.page.slug);
	}
}
check("切片页 ownsFiles 并集 = U", owner.size === cache.universe.length, `${owner.size}/${cache.universe.length}`);
check("切片页 ownsFiles 互斥", overlap === 0, `overlap=${overlap}`);
check(
	"切片页 associatedFiles ⊇ ownsFiles",
	slicePages.every((entry) => {
		const own = new Set(entry.page.ownsFiles ?? []);
		return [...own].every((file) => (entry.page.associatedFiles ?? []).includes(file));
	}),
);
check(
	"切片页 refs 只指向他分类（ownerSlug ≠ 自己且在 pages 内）",
	slicePages.every((entry) =>
		(entry.page.refs ?? []).every((ref) => {
			const target = blueprint.pages.find((other) => other.page.slug === ref.ownerSlug);
			return target !== undefined && target.page.slug !== entry.page.slug;
		}),
	),
);

// —— coverage 一致性 ——
const fileOwnerCount = Object.keys(blueprint.coverage.fileOwner).length;
check(
	"coverage.fileOwner 与切片页 ownsFiles 逐项一致",
	fileOwnerCount === owner.size &&
		Object.entries(blueprint.coverage.fileOwner).every(([file, slug]) => owner.get(file) === slug),
	`${fileOwnerCount} 项`,
);
check(
	"coverage.slicesBySection 覆盖全部切片",
	cache.slices.every((slice) =>
		Object.values(blueprint.coverage.slicesBySection).flat().includes(slice.id),
	),
);
check(
	"coverage 基本字段（manifestHash / modularity / seamCount）",
	blueprint.coverage.manifestHash === cache.manifestHash &&
		blueprint.coverage.seamCount === cache.seams.length &&
		blueprint.coverage.modularity === cache.modularity,
);

// —— 落盘 ——
await initWikiBlueprint(blueprint, CONFIG, undefined, { variant: "high" });
const output = JSON.parse(await readFile(join(fixture, ".zread-pi", "wiki", "high", "wiki.json"), "utf-8")) as WikiOutput;
check("落盘 schemaVersion = 2", output.schemaVersion === 2);
check("落盘 pages 与机器页一致", output.pages.length === blueprint.pages.length);
check("loadWikiBlueprint 可加载（骨架 pages 非空）", (await loadWikiBlueprint(undefined, "high")).pages.length > 0);

// —— applySectionNames ——
console.log("▶ 命名阶段：applySectionNames");
const structureSection = blueprint.sections[2];
const oldTitle = structureSection.title;
const sectionNames = [
	{ id: "overview", title: "不该被接受", description: "也不该被接受" },
	{ id: structureSection.id, title: "数据与工具层", description: "由命名阶段给出的说明", scope: ["包含：util", "不包含：web"] },
	{ id: "sec-does-not-exist", title: "未知 id" },
];
const sectionResult = await applySectionNames(sectionNames, { variant: "high" });
const afterSections = JSON.parse(await readFile(join(fixture, ".zread-pi", "wiki", "high", "wiki.json"), "utf-8")) as WikiOutput;
const renamed = afterSections.sections.find((section) => section.id === structureSection.id);
const overview = afterSections.sections.find((section) => section.id === "overview");
check(
	"结构分类 title / description 被写入",
	renamed?.title === "数据与工具层" && renamed?.description === "由命名阶段给出的说明",
	`${renamed?.title} | ${renamed?.description}`,
);
check("基础分类 title / description 提交被忽略", overview?.title === "概览" && !overview?.description?.includes("不该"));
check("scope 所有分类都接受", renamed?.scope?.join(",") === "包含：util,不包含：web");
check("id / slices / 顺序不变", renamed?.slices?.join(",") === (structureSection.slices ?? []).join(","));
check(
	"分类改名传播到 pages[].section",
	afterSections.pages.filter((page) => page.section === "数据与工具层").length ===
		output.pages.filter((page) => page.section === oldTitle).length,
);
check("未知 id 计入 unknown", sectionResult.unknown === 1, JSON.stringify(sectionResult));

// —— applyPageNames ——
console.log("▶ 命名阶段：applyPageNames");
const sliceEntry = blueprint.pages.find((entry) => entry.id.startsWith("slice:"))!;
const beforePage: WikiPage = JSON.parse(
	JSON.stringify(afterSections.pages.find((page) => page.slug === sliceEntry.page.slug)),
);
const pageNames = [
	{ id: sliceEntry.id, title: "工具层核心", summary: "一句话摘要", group: "util", level: "Advanced" },
	{ id: "slice:S99", title: "不存在的切片" },
];
const pageResult = await applyPageNames(pageNames, { variant: "high", machinePages: blueprint.pages });
const afterPage = JSON.parse(await readFile(join(fixture, ".zread-pi", "wiki", "high", "wiki.json"), "utf-8")).pages.find(
	(page: WikiPage) => page.slug === sliceEntry.page.slug,
);
check(
	"页面命名写入 title / summary / group / level",
	afterPage.title === "工具层核心" &&
		afterPage.topicSummary === "一句话摘要" &&
		afterPage.group === "util" &&
		afterPage.level === "Advanced",
	`${afterPage.title} | ${afterPage.group} | ${afterPage.level}`,
);
check(
	"结构性字段恒不变（slug / file / section / ownsFiles / associatedFiles / refs）",
	afterPage.slug === beforePage.slug &&
		afterPage.file === beforePage.file &&
		afterPage.section === beforePage.section &&
		JSON.stringify(afterPage.ownsFiles) === JSON.stringify(beforePage.ownsFiles) &&
		JSON.stringify(afterPage.associatedFiles) === JSON.stringify(beforePage.associatedFiles) &&
		JSON.stringify(afterPage.refs) === JSON.stringify(beforePage.refs),
);
check("未知页面 id 计入 unknown", pageResult.unknown === 1, JSON.stringify(pageResult));

// —— onlyIds 门禁 ——
const gated = await applyPageNames(
	[{ id: sliceEntry.id, title: "应被门禁拦截" }],
	{ variant: "high", machinePages: blueprint.pages, onlyIds: new Set<string>() },
);
check("onlyIds 门禁：不在集合内的提交被跳过", gated.skipped === 1 && gated.updated === 0, JSON.stringify(gated));

// —— minimal ——
console.log("▶ minimal 档位");
const minimal = buildMachineBlueprint(cache, CONFIG, { variant: "minimal", minimal: true });
check(
	"minimal：1 分类 1 页",
	minimal.sections.length === 1 && minimal.pages.length === 1 && minimal.sections[0].id === "overview",
	`${minimal.sections.length} 分类 / ${minimal.pages.length} 页`,
);
check(
	"minimal：单页 ownsFiles = U",
	minimal.pages[0].page.ownsFiles?.length === cache.universe.length &&
		minimal.pages[0].page.ownsFiles?.every((file) => cache.universe.includes(file)),
);
check(
	"minimal：coverage.fileOwner 全指向该页",
	Object.values(minimal.coverage.fileOwner).every((slug) => slug === minimal.pages[0].page.slug) &&
		Object.keys(minimal.coverage.fileOwner).length === cache.universe.length,
);

process.chdir(join(fixture, ".."));
await rm(fixture, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
	console.error("失败项：", failed.map((entry) => entry.name).join(", "));
	process.exit(1);
}
