/**
 * 阶段 1 —— 适配层 sessionRoot 注入：完整会话落盘并可重开
 *
 * 方案 C 的注入点（plan.md §2）：createAgent({ sessionRoot }) → driver 构造
 * JsonlSessionRepo，把本次 query 的完整会话（消息 / 工具调用 / 工具结果 /
 * 用量 / 压缩摘要）写进 `<sessionRoot>/--<cwd>--/<ts>_<sessionId>.jsonl`。
 * 本测试跑一次真实 mock query，断言磁盘上能读回完整内容（投影层的前提）。
 *
 * 运行：bun run packages/agent-runtime/test/session-persist.ts
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  JsonlSessionRepo,
  BACKGROUND_CONTEXT,
  type Entry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createAgent, FileWriteTool, type SDKMessage } from "../src/index.js";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const faux = fauxProvider({ tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel("faux-model") ?? faux.models[0];

const workdir = await mkdtemp(join(tmpdir(), "zread-pi-session-"));
const sessionsRoot = join(workdir, "runs", "2026-01-01T00-00-00-abcd", "sessions");
const targetFile = join(workdir, "out.md");
const sessionId = "zread-pi-session-persist-0001";

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("write", { path: targetFile, content: "# hello pi\n" }, { id: "call_1" })]),
  fauxAssistantMessage("已写入 out.md"),
]);

let resultSubtype: string | undefined;
const agent = createAgent({
  model: String(model.id),
  cwd: workdir,
  systemPrompt: "你是测试代理",
  maxTurns: 5,
  tools: [FileWriteTool],
  sessionId,
  sessionRoot: sessionsRoot,
  runtimeOverride: { model, streamFn: (m, c, o) => models.streamSimple(m, c, o) },
});

for await (const event of agent.query("把结果写入文件")) {
  const message = event as SDKMessage;
  if (message.type === "result") resultSubtype = message.subtype;
}
await agent.close();

check("query 正常完成（success）", resultSubtype === "success", String(resultSubtype));

// ---------- 定位会话文件 ----------
function sessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
const sessionsDir = join(sessionsRoot, sessionDirectoryName(workdir));
let dirEntries: string[] = [];
try {
  dirEntries = await readdir(sessionsDir);
} catch {
  dirEntries = [];
}
const sessionFile = dirEntries.find((name) => name.endsWith(`_${sessionId}.jsonl`));
check("会话目录按 cwd 转义生成", dirEntries.length === 1, sessionsDir);
check("会话文件为 <ts>_<sessionId>.jsonl", Boolean(sessionFile), String(sessionFile));

if (!sessionFile) {
  console.log("\n结果：缺失会话文件，终止后续断言");
  process.exit(1);
}

// ---------- 解析磁盘行（value 单对象 / entry+usage 事务数组） ----------
const raw = await readFile(join(sessionsDir, sessionFile!), "utf-8");
const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
const header = JSON.parse(lines[0]!);
const flatEntries: Entry[] = [];
let usageRows = 0;
for (const line of lines.slice(1)) {
  const parsed: unknown = JSON.parse(line);
  const items = Array.isArray(parsed) ? (parsed as { kind?: string }[]) : [parsed as { kind?: string }];
  for (const item of items) {
    if (item.kind === "entry") flatEntries.push(item as Entry);
    else if (item.kind === "usage") usageRows += 1;
  }
}
check("首行是 header", header.kind === "header", `kind=${String(header.kind)}`);

const messageEntries = flatEntries.filter((entry) => entry.type === "message");
const assistantWithToolCall = messageEntries.find(
  (entry) =>
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    Array.isArray(entry.message.content) &&
    entry.message.content.some((block) => block.type === "toolCall"),
);
// pi 的存储格式：工具结果是 role="toolResult" 的独立消息（内容块为 text），
// 不是 user 消息里的 toolResult 块（后者是 pi-ai 的线路格式）
const toolResultEntry = messageEntries.find(
  (entry) => entry.type === "message" && entry.message.role === "toolResult",
);
check("assistant 消息含 toolCall 块", Boolean(assistantWithToolCall));
check("工具结果消息存在（role=toolResult 的独立消息）", Boolean(toolResultEntry));
check("用量行落盘（usage row）", usageRows >= 1, `${usageRows}`);

// ---------- repo.open() 重开读回完整内容（投影层前提） ----------
const env = new NodeExecutionEnv({ cwd: workdir });
const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
const reopened = await repo.open(
  {
    id: sessionId,
    path: join(sessionsDir, sessionFile!),
    createdAt: 0,
    storageVersion: 4,
    cwd: workdir,
    modifiedAt: 0,
  },
  BACKGROUND_CONTEXT,
);
const reopenedEntries = await reopened.findEntries(undefined, BACKGROUND_CONTEXT);
const reopenedMessages = reopenedEntries.filter((entry) => entry.type === "message");
check("repo.open() 重开读回全部消息条目", reopenedMessages.length === messageEntries.length, `${reopenedMessages.length}`);
const stats = await reopened.getStats(BACKGROUND_CONTEXT);
check("重开会话的 stats 含用量合计", stats.usage !== undefined && stats.usage.totalTokens > 0, JSON.stringify(stats.usage ?? {}));
await reopened.close(BACKGROUND_CONTEXT);
await repo.close(BACKGROUND_CONTEXT);

await rm(workdir, { recursive: true, force: true });

// ---------- 结论 ----------
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const entry of failed) console.log(`  ❌ ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
  process.exitCode = 1;
}
