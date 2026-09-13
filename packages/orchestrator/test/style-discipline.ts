/**
 * style-discipline.ts —— 文风纪律（humanizer）注入的专项回归
 *
 * 纯函数级验证（不需要 mock 服务）：
 *  - 按 doc_language 选择纪律文本（en → humanizer，其余 → humanizer-zh）
 *  - 注入块格式（`<writing_discipline>` 包裹、可开关）
 *  - polish Agent 的系统提示 = 纪律 + Embedded mode；任务提示带文件路径
 *  - 保护性约束（Sources 行 / frontmatter / Mermaid 引号）出现在两份纪律里
 *  - vendored 文件头部注明来源、行数保持在 60~80 行的精炼区间
 *
 * 运行：bun run packages/orchestrator/test/style-discipline.ts
 */

import { readFileSync } from "node:fs";
import {
  POLISH_EMBEDDED_MODE,
  STYLE_DISCIPLINE_TAG,
  buildPolishSystemPrompt,
  buildPolishTaskPrompt,
  formatStyleDiscipline,
  getStyleDiscipline,
  withStyleDiscipline,
} from "../src/agents/style-discipline.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1) 语言选择
const en = getStyleDiscipline("en");
const zh = getStyleDiscipline("zh");
check("en → humanizer（英文纪律）", en.includes("Writing discipline") && en.includes("Sources:"), en.slice(0, 40));
check("zh → humanizer-zh（中文纪律）", zh.includes("文风纪律") && zh.includes("Sources:"), zh.slice(0, 40));
check("未知/缺省 doc_language 回退中文纪律", getStyleDiscipline(undefined) === zh && getStyleDiscipline("ja") === zh);
check("两份纪律互不相同", en !== zh);

// 2) 注入块格式
const block = formatStyleDiscipline("en");
check(
  "注入块使用 <writing_discipline> 包裹且前后留空行",
  block.startsWith(`\n\n<${STYLE_DISCIPLINE_TAG}>\n`) && block.trimEnd().endsWith(`</${STYLE_DISCIPLINE_TAG}>`),
  JSON.stringify(block.slice(0, 44)),
);
check(
  "withStyleDiscipline：基础提示 + 纪律块",
  withStyleDiscipline("BASE", "zh") === `BASE${formatStyleDiscipline("zh")}`,
);
check("withStyleDiscipline(enabled=false) 完全关闭预防层", withStyleDiscipline("BASE", "zh", false) === "BASE");

// 3) polish Agent 提示词
const polishSystem = buildPolishSystemPrompt("en");
check(
  "polish 系统提示 = 纪律 + Embedded mode 输出约定",
  polishSystem.startsWith(en.trim()) && polishSystem.includes(POLISH_EMBEDDED_MODE) && polishSystem.includes("POLISHED"),
);
check("Embedded mode 只允许一行状态词", POLISH_EMBEDDED_MODE.includes("NO_CHANGE") && POLISH_EMBEDDED_MODE.includes("只允许一行"));
const task = buildPolishTaskPrompt({ filePath: "/tmp/repo/.zread-pi/wiki/入门指南/1-overview.md", slug: "1-overview", title: "概览" });
check(
  "polish 任务提示带文件路径 / slug / 标题",
  task.includes("1-overview.md") && task.includes("1-overview") && task.includes("概览"),
  task.split("\n")[2] ?? "",
);
check(
  "polish 任务提示在无标题时也不炸",
  buildPolishTaskPrompt({ filePath: "/tmp/a.md", slug: "a" }).includes("/tmp/a.md"),
);

// 4) 保护性约束（本项目与通用 humanizer 的最大差异点）
for (const [label, text] of [
  ["en", en],
  ["zh", zh],
] as const) {
  check(
    `${label} 纪律含保护性约束（代码块 / Sources 行 / frontmatter / Mermaid 引号）`,
    text.includes("Sources:") &&
      text.toLowerCase().includes("frontmatter") &&
      text.includes("Mermaid") &&
      (label === "en" ? text.includes("Never touch") : text.includes("绝对不许动")),
  );
}

// 5) vendored 文件：来源注释 + 精炼行数（60~80 行）
for (const name of ["humanizer.en.md", "humanizer.zh.md"]) {
  const raw = readFileSync(new URL(`../src/prompts/${name}`, import.meta.url), "utf-8");
  const lines = raw.split("\n").length;
  check(`${name} 头部注明来源（humanizer）`, raw.slice(0, 400).includes("humanizer"), raw.split("\n")[0]);
  check(`${name} 行数保持在 60~80 行`, lines >= 60 && lines <= 80, `lines=${lines}`);
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error("失败项：", failed.map((entry) => entry.name).join(", "));
  process.exit(1);
}
