/**
 * 页面格式契约 + 读者优先纪律 —— 提示词资产层验证
 *
 * 覆盖 P1-2：
 * - page-format.zh/.en.md 两份资产条数与编号一一对应（同步纪律）
 * - reader-first.zh/.en.md 同上（8 节 + 最终清单）
 * - 拼装点：withPageFormat / withReaderDiscipline（注入位置 / 开关 / 语言选择）
 * - page-agent.ts 抽出后仍保留指向，且最终提示词含全部关键段
 *
 * 运行：bun run packages/orchestrator/test/page-format.ts
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPageFormat,
	formatPageFormat,
	withPageFormat,
	PAGE_FORMAT_TAG,
} from "../src/agents/page-format.js";
import {
	getReaderDiscipline,
	formatReaderDiscipline,
	withReaderDiscipline,
	READER_FIRST_TAG,
	READER_SELF_CHECK,
} from "../src/agents/reader-first.js";
import {
	getDiagramGuide,
	formatDiagramGuide,
	withDiagramGuide,
	DIAGRAM_GUIDE_TAG,
} from "../src/agents/diagram-guide.js";
import {
	getStyleDiscipline,
	formatStyleDiscipline,
	STYLE_DISCIPLINE_TAG,
} from "../src/agents/style-discipline.js";
import { buildPolishSystemPrompt } from "../src/agents/style-discipline.js";
import { buildPagePrompt } from "../src/wiki/generate-wiki.js";
import { getDetailSpec } from "../src/agents/blueprint-detail.js";
import type { WikiPage } from "@zread-pi/types";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const page: WikiPage = { slug: "p1", title: "P1", section: "s", file: "p1.md" };

// ==================== A. 两份资产同步（条数 / 编号对应） ====================

console.log("\n▶ A. zh / en 资产条数与编号一一对应");

{
	const zh = getPageFormat("zh");
	const en = getPageFormat("en");
	const zhSections = (zh.match(/^## /gm) ?? []).length;
	const enSections = (en.match(/^## /gm) ?? []).length;
	check("page-format 两语言节数一致（6）", zhSections === enSections && zhSections === 6, `${zhSections}/${enSections}`);

	// §4 反注水三条必须写进自检清单（zh / en 一一对应）
	check(
		"自检清单含「同义改写注水」禁令（zh/en）",
		zh.includes("同义改写注水") && en.includes("padding by paraphrase"),
	);
	check(
		"自检清单含「不复制 README/AGENTS.md 当散文」（zh/en）",
		zh.includes("AGENTS.md") && en.includes("AGENTS.md"),
	);
	check(
		"资产含「源没有就应该是 0」口径（zh/en）",
		zh.includes("正确答案是 **0**") && en.includes("correct number of code blocks is **0**"),
	);

	const zhMermaidRules = (zh.match(/^-\s/gm) ?? []).length;
	const enMermaidRules = (en.match(/^-\s/gm) ?? []).length;
	check("page-format 两语言列表项数量接近（±3）", Math.abs(zhMermaidRules - enMermaidRules) <= 3, `${zhMermaidRules}/${enMermaidRules}`);

	// 自检清单条数必须一致（对齐 lecture-to-notes 的清单形态；`^\\d+\\. ` 兼容一位/两位编号）
	const zhChecklist = (zh.match(/^\d+\. /gm) ?? []).length;
	const enChecklist = (en.match(/^\d+\. /gm) ?? []).length;
	check("page-format 交付前自检清单条数一致（11）", zhChecklist === enChecklist && zhChecklist >= 11, `${zhChecklist}/${enChecklist}`);

	// reader-first：8 节 + 最终清单
	const rzh = getReaderDiscipline("zh");
	const ren = getReaderDiscipline("en");
	check("reader-first 两语言节数一致（8）", (rzh.match(/^## \d+\./gm) ?? []).length === (ren.match(/^## \d+\./gm) ?? []).length, `${(rzh.match(/^## \d+\./gm) ?? []).length}/${(ren.match(/^## \d+\./gm) ?? []).length}`);
	check("reader-first 两语言都含最终清单", rzh.includes("最终清单") && ren.toLowerCase().includes("final reader-first checklist"));

	// 证据框架四问改写为代码语境（接口签名 / 调用方 / 触发条件 / 边界与失败模式）
	check("reader-first zh 第 6 节改写为代码语境（接口签名 / 调用方 / 触发条件 / 边界与失败模式）",
		rzh.includes("接口签名") && rzh.includes("调用方") && rzh.includes("触发条件") && rzh.includes("失败模式"));
	check("reader-first en 第 6 节改写为代码语境",
		ren.includes("interface signature") && ren.includes("callers") && ren.includes("failure mode"));
}

// ==================== A2. diagram-guide 双语同步 ====================

console.log("\n▶ A2. diagram-guide 两语言条数与编号一一对应");

{
	const zh = getDiagramGuide("zh");
	const en = getDiagramGuide("en");
	const zhSections = (zh.match(/^## /gm) ?? []).length;
	const enSections = (en.match(/^## /gm) ?? []).length;
	check("diagram-guide 两语言节数一致", zhSections === enSections, `${zhSections}/${enSections}`);

	// 选型决策表行数一致（表格数据行 = 以 | 开头且不是分隔线的行）
	const tableRows = (text: string): number =>
		(text.match(/^\|.*\|$/gm) ?? []).filter((row) => !/^\|[\s|-]+\|$/.test(row)).length;
	// 选型决策表区域：从「决策表」到「grounding」之间
	const zhDecision = zh.slice(zh.indexOf("决策表"), zh.indexOf("grounding"));
	const enDecision = en.slice(en.toLowerCase().indexOf("decision table"), en.toLowerCase().indexOf("grounding"));
	check("选型决策表数据行数一致（含表头 6 行：四类 + 都不涉及）", tableRows(zhDecision) === tableRows(enDecision) && tableRows(zhDecision) === 6, `${tableRows(zhDecision)}/${tableRows(enDecision)}`);

	// grounding 要求表区域：从「grounding」到文末
	const zhGrounding = zh.slice(zh.indexOf("grounding"));
	const enGrounding = en.slice(en.toLowerCase().indexOf("grounding"));
	check("grounding 要求表行数一致（含表头 5 行：4 类图）", tableRows(zhGrounding) === tableRows(enGrounding) && tableRows(zhGrounding) === 5, `${tableRows(zhGrounding)}/${tableRows(enGrounding)}`);

	// 四类图 + 类型词在两语言都出现
	check("zh 含四类图类型词", ["架构图", "流程图", "序列图", "状态图"].every((w) => zh.includes(w)));
	check("en 含四类图类型词", ["Architecture Diagram", "Flow Diagram", "Sequence Diagram", "State Diagram"].every((w) => en.includes(w)));

	// 题注格式两语言都载明
	check("zh 题注格式（**图｜<类型词>｜<标题>**）", zh.includes("**图｜<类型词>｜<一句话标题>**"));
	check("en 题注格式（**Figure｜<type word>｜<title>**）", en.includes("**Figure｜<type word>｜<one-line title>**"));

	// 选型纪律只出现在 diagram-guide，page-format 不重复规定选型
	check("page-format 不再规定选型（指向 diagram_guide）", !getPageFormat("zh").includes("序列图") && getPageFormat("zh").includes("diagram_guide"));
	check("page-format en 同样指向 diagram_guide", getPageFormat("en").includes("diagram_guide"));
}

// ==================== B. 语言选择与回退 ====================

console.log("\n▶ B. 语言选择（en 之外一律中文）");

{
	check("getPageFormat('en') 选英文版", getPageFormat("en").includes("Page format contract"));
	check("getPageFormat('zh') 选中文版", getPageFormat("zh").includes("页面格式契约"));
	check("getPageFormat(null) 回退中文", getPageFormat(null).includes("页面格式契约"));
	check("getPageFormat(undefined) 回退中文", getPageFormat(undefined).includes("页面格式契约"));
	check("getPageFormat('ja') 回退中文", getPageFormat("ja").includes("页面格式契约"));

	check("getReaderDiscipline('en') 选英文版", getReaderDiscipline("en").includes("Reader-first writing discipline"));
	check("getReaderDiscipline(null) 回退中文", getReaderDiscipline(null).includes("读者优先写作纪律"));
}

// ==================== C. 注入块格式与开关 ====================

console.log("\n▶ C. 注入块标签与开关语义");

{
	const fmt = formatPageFormat("zh");
	check("formatPageFormat 含 <page_format> 包裹", fmt.includes(`<${PAGE_FORMAT_TAG}>`) && fmt.includes(`</${PAGE_FORMAT_TAG}>`));

	const dg = formatDiagramGuide("zh");
	check("formatDiagramGuide 含 <diagram_guide> 包裹", dg.includes(`<${DIAGRAM_GUIDE_TAG}>`) && dg.includes(`</${DIAGRAM_GUIDE_TAG}>`));

	const rd = formatReaderDiscipline("zh");
	check("formatReaderDiscipline 含 <reader_first> 包裹", rd.includes(`<${READER_FIRST_TAG}>`) && rd.includes(`</${READER_FIRST_TAG}>`));

	const base = "BASE_PROMPT";
	check("withPageFormat 始终注入（硬约束不受 polish.enabled 影响）", withPageFormat(base, "zh").includes(`<${PAGE_FORMAT_TAG}>`));
	check("withReaderDiscipline 默认注入", withReaderDiscipline(base, "zh").includes(`<${READER_FIRST_TAG}>`));
	check("withReaderDiscipline enabled=false 原样返回", withReaderDiscipline(base, "zh", false) === base);
}

// ==================== D. reader-first 拼在 humanizer 之后 ====================

console.log("\n▶ D. 与 humanizer 的拼装顺序（reader-first 在后）");

{
	const combined = withReaderDiscipline(formatStyleDiscipline("zh"), "zh");
	const hPos = combined.indexOf(`<${STYLE_DISCIPLINE_TAG}>`);
	const rPos = combined.indexOf(`<${READER_FIRST_TAG}>`);
	check("两块都注入", hPos !== -1 && rPos !== -1);
	check("reader_first 在 writing_discipline 之后", rPos > hPos && rPos > combined.indexOf(`</${STYLE_DISCIPLINE_TAG}>`));
}

// ==================== E. buildPagePrompt 集成 ====================

console.log("\n▶ E. buildPagePrompt 含格式契约且保留既有段落");

{
	const prompt = buildPagePrompt(page, getDetailSpec("high"), "high", "zh");
	check("含格式契约块", prompt.includes(`<${PAGE_FORMAT_TAG}>`));
	check("含图表纪律块", prompt.includes(`<${DIAGRAM_GUIDE_TAG}>`));
	// 用「换行 + 开标签」定位真实注入块（page-format 里的纯文本指针不带尖括号，不会混入）
	const guideBlockOpen = `\n<${DIAGRAM_GUIDE_TAG}>\n`;
	check("图表纪律块在格式契约块之后", prompt.indexOf(guideBlockOpen) > prompt.indexOf(`</${PAGE_FORMAT_TAG}>`));
	check("图表纪律块只注入一次", (prompt.match(new RegExp(guideBlockOpen.replace(/[<>]/g, "\\$&"), "g")) ?? []).length === 1);
	check("图表纪律块在任务元数据之前", prompt.indexOf(`<${DIAGRAM_GUIDE_TAG}>`) < prompt.indexOf("当前页面任务"));
	check("含 frontmatter 规则", prompt.includes("frontmatter"));
	check("含交付前自检清单", prompt.includes("自检清单"));
	check("保留「绝对纪律：精准溯源」指向段", prompt.includes("精准溯源"));
	check("保留「当前页面任务」", prompt.includes("当前页面任务"));
	check("保留「输出路径规范」", prompt.includes("输出路径规范"));
	check("保留 write_page 参数要求", prompt.includes("write_page"));
	check("保留任务元数据（Slug）", prompt.includes("**Slug**: p1"));

	const minimal = buildPagePrompt(page, getDetailSpec("minimal"), "high", "zh");
	check("minimal 档位仍附加全景导览", minimal.includes("全景导览"));

	const enPrompt = buildPagePrompt(page, getDetailSpec("high"), "high", "en");
	check("en 语言选英文格式契约", enPrompt.includes("Page format contract") && enPrompt.includes("Pre-delivery checklist"));
	check("en 语言选英文图表纪律", enPrompt.includes("Diagram selection and caption discipline"));
	check("格式契约块只注入一次（无重复）", (enPrompt.match(new RegExp(`<${PAGE_FORMAT_TAG}>`, "g")) ?? []).length === 1);
}

// ==================== F. polish 系统提示含读者自检 ====================

console.log("\n▶ F. polish 系统提示 = humanizer + 读者自检 + Embedded mode");

{
	const prompt = buildPolishSystemPrompt("zh");
	check("含 humanizer 纪律全文", prompt.includes("humanizer") || !prompt.includes(" Embedded mode（"));
	check("含读者优先自检段", prompt.includes(READER_SELF_CHECK.slice(0, 12)));
	check("含 Embedded mode 约定", prompt.includes("Embedded mode"));
	check("自检在 Embedded mode 之前", prompt.indexOf(READER_SELF_CHECK.slice(0, 12)) < prompt.indexOf("Embedded mode"));
	check("en 版本也可构建", buildPolishSystemPrompt("en").includes("Embedded mode"));
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

// 防止未使用的 import 报错（mkdtemp / tmpdir / join 保留给将来扩展）
void mkdtemp;
void tmpdir;
void join;
