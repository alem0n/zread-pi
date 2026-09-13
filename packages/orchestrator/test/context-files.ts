/**
 * context-files.ts —— 目标仓库上下文文件（AGENTS.md / CLAUDE.md）加载的专项回归
 *
 * 纯函数级验证（不需要 mock 服务）：
 *  - 候选文件优先级（AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD）
 *  - UTF-8 BOM 去除、大小写变体、目录不存在 / 非法条目不炸
 *  - 全局（agentDir）在前、项目（cwd）在后
 *  - 超过 64 KiB 截断并附加标记
 *  - 注入块格式与 pi 的 `<project_context>` 完全一致
 *
 * 运行：bun run packages/orchestrator/test/context-files.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_FILE_MAX_BYTES,
  formatContextFiles,
  loadContextFileFromDir,
  loadProjectContextFiles,
  withProjectContext,
} from "../src/agents/context-files.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const root = await mkdtemp(join(tmpdir(), "zread-pi-context-"));
const projectDir = join(root, "project");
const globalDir = join(root, "home");
await mkdir(projectDir, { recursive: true });
await mkdir(globalDir, { recursive: true });

// 1) 无上下文文件
check("目录无候选文件时返回 null", loadContextFileFromDir(projectDir) === null);

// 2) 候选优先级：AGENTS.override.md 压过 AGENTS.md
await writeFile(join(projectDir, "AGENTS.md"), "# plain agents\n", "utf-8");
await writeFile(join(projectDir, "CLAUDE.md"), "# claude\n", "utf-8");
const withAgents = loadContextFileFromDir(projectDir);
check(
  "AGENTS.md 优先于 CLAUDE.md",
  withAgents?.content.includes("plain agents") === true && withAgents.path === join(projectDir, "AGENTS.md"),
  withAgents?.path,
);

await writeFile(join(projectDir, "AGENTS.override.md"), "# override agents\n", "utf-8");
const withOverride = loadContextFileFromDir(projectDir);
check(
  "AGENTS.override.md 优先于 AGENTS.md",
  withOverride?.content.includes("override agents") === true,
  withOverride?.path,
);

// 3) 大小写变体（Linux 上的全大写写法）与 BOM
const variantDir = join(root, "variant");
await mkdir(variantDir, { recursive: true });
await writeFile(join(variantDir, "AGENTS.MD"), "\uFEFF# upper agents md\n", "utf-8");
const variant = loadContextFileFromDir(variantDir);
check(
  "AGENTS.MD 大写变体可识别，且 BOM 被去掉",
  variant?.content.startsWith("# upper agents md") === true && !variant.content.includes("\uFEFF"),
  JSON.stringify(variant?.content.slice(0, 24)),
);

// 4) 全局 + 项目：顺序与去重
await writeFile(join(globalDir, "AGENTS.md"), "# global context\n", "utf-8");
const merged = loadProjectContextFiles({ cwd: projectDir, agentDir: globalDir });
check(
  "全局上下文在前、项目上下文在后",
  merged.length === 2 &&
    merged[0]!.content.includes("global context") &&
    merged[1]!.content.includes("override agents"),
  merged.map((file) => file.path).join(" | "),
);

// 同目录（agentDir === cwd）时同一文件只注入一次
const sameDir = loadProjectContextFiles({ cwd: projectDir, agentDir: projectDir });
check("agentDir 与 cwd 相同时不重复注入", sameDir.length === 1, `count=${sameDir.length}`);

// 5) 注入块格式（与 pi buildSystemPrompt 同格式）
const block = formatContextFiles(merged);
check(
  "注入块使用 <project_context> / <project_instructions> 格式",
  block.startsWith("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n") &&
    block.includes(`<project_instructions path="${join(globalDir, "AGENTS.md")}">`) &&
    block.trimEnd().endsWith("</project_context>"),
  JSON.stringify(block.slice(0, 80)),
);
check("无上下文文件时注入块为空字符串", formatContextFiles([]) === "");
check(
  "withProjectContext 直接拼接到系统提示尾部",
  withProjectContext("BASE", merged) === `BASE${block}` && withProjectContext("BASE", []) === "BASE",
);

// 6) 超长截断：64 KiB 上限 + 标记
const hugeDir = join(root, "huge");
await mkdir(hugeDir, { recursive: true });
await writeFile(join(hugeDir, "AGENTS.md"), "x".repeat(CONTEXT_FILE_MAX_BYTES + 4096), "utf-8");
const huge = loadContextFileFromDir(hugeDir);
check(
  "超长上下文文件被截断到 64 KiB 并带标记",
  huge !== null &&
    Buffer.byteLength(huge.content, "utf-8") <= CONTEXT_FILE_MAX_BYTES + 64 &&
    huge.content.includes("[... context file truncated at 64 KiB ...]"),
  `bytes=${Buffer.byteLength(huge?.content ?? "", "utf-8")}`,
);

// 7) 目录不存在时静默返回 null（数据缺失不阻塞生成）
check("agentDir 不存在时返回空列表", loadProjectContextFiles({ cwd: projectDir, agentDir: join(root, "nope") }).length === 1);

await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error("失败项：", failed.map((entry) => entry.name).join(", "));
  process.exit(1);
}
