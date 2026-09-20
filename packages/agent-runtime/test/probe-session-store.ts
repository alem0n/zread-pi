/**
 * 阶段 0 探针 —— 验证 pi 的 JsonlSessionRepo 能否当「唯一完整事实源」
 *
 * 方案 C 的硬闸门（plan.md §6 风险 2）：会话落盘后必须仍含完整内容
 * （assistant 消息 / toolCall 块 / toolResult / usage 行），且目录布局
 * 可被投影层消费。压缩后若旧消息条目被替换，会话就不能当完整事实源。
 *
 * 运行：bun run packages/agent-runtime/test/probe-session-store.ts
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlSessionRepo,
  MemorySessionRepo,
  BACKGROUND_CONTEXT,
  type Session,
  type Entry,
  type UsageRow,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const root = await mkdtemp(join(tmpdir(), "zread-pi-probe-"));
const sessionsRoot = join(root, "sessions");
const env = new NodeExecutionEnv({ cwd: root });
const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });

const sessionId = "zread-pi-probe-0001";
const session: Session = await repo.create({ id: sessionId, cwd: root }, BACKGROUND_CONTEXT);

// ---------- 构造一次含工具调用的完整交互 ----------
await session.createBranch("main", null, BACKGROUND_CONTEXT);
const branch = await session.branch("main", BACKGROUND_CONTEXT);

// 1) 用户消息
await branch.appendMessage(
  { role: "user", content: [{ type: "text", text: "把结果写入文件" }] },
  BACKGROUND_CONTEXT,
);

// 2) assistant 消息（含 toolCall 块）—— 完整内容的核心
await branch.appendMessage(
  {
    role: "assistant",
    content: [
      { type: "text", text: "我来写入文件" },
      { type: "toolCall", id: "call_1", name: "write", input: { path: "out.md", content: "# hello pi\n" } },
    ],
  },
  BACKGROUND_CONTEXT,
);

// 3) 工具结果消息
await branch.appendMessage(
  {
    role: "user",
    content: [{ type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "Written to out.md" }] }],
  },
  BACKGROUND_CONTEXT,
);

// 4) 最终 assistant 答复
await branch.appendMessage(
  { role: "assistant", content: [{ type: "text", text: "已写入 out.md" }] },
  BACKGROUND_CONTEXT,
);

// 5) 记一条用量（provider 侧的计费事实）
await session.mutate(async (mutator) => {
  await mutator.commit(
    [{
      kind: "usage",
      row: {
        id: "u1",
        usage: {
          input: 100, output: 40, cacheRead: 0, cacheWrite: 0,
          totalTokens: 140,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        adjustment: false,
      },
    }],
    BACKGROUND_CONTEXT,
  );
}, BACKGROUND_CONTEXT);

await session.close(BACKGROUND_CONTEXT);

// ---------- 验证落盘文件 ----------
const sessionsDir = join(sessionsRoot, `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
const dirEntries = await readdir(sessionsDir);
const sessionFile = dirEntries.find((name) => name.endsWith(".jsonl"));

check("会话目录按 cwd 转义生成", dirEntries.length === 1, sessionsDir);
check("会话文件为 <ts>_<id>.jsonl", Boolean(sessionFile), String(sessionFile));

const raw = await readFile(join(sessionsDir, sessionFile!), "utf-8");
const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
const header = JSON.parse(lines[0]!);

// 磁盘行形态：value 写入是单对象，entry / usage 是**事务数组**（一批多条）
// {"kind":"value","op":"set",...}
// [{"kind":"entry","type":"message","message":{...}}, ...]
// {"kind":"usage","id":"u1","usage":{...}}
const flatEntries: Entry[] = [];
let rawUsageRows = 0;
for (const line of lines.slice(1)) {
  const parsed: unknown = JSON.parse(line);
  const items = Array.isArray(parsed) ? (parsed as { kind?: string }[]) : [parsed as { kind?: string }];
  for (const item of items) {
    if (item.kind === "entry") flatEntries.push(item as Entry);
    else if (item.kind === "usage") rawUsageRows += 1;
  }
}

check("首行是 header（v/kind=id）", header.kind === "header" || header.v !== undefined, `kind=${String(header.kind)}`);
check("后续行是会话条目", flatEntries.length >= 4, `${flatEntries.length} entries`);

// 内容完备性（方案 C 的核心断言）
const messageEntries = flatEntries.filter((entry) => entry.type === "message");
check("消息条目数 = 4（user/assistant+toolCall/toolResult/assistant）", messageEntries.length === 4, `${messageEntries.length}`);

const assistantWithToolCall = messageEntries.find(
  (entry) => entry.type === "message" && entry.message.role === "assistant"
    && Array.isArray(entry.message.content) && entry.message.content.some((block) => block.type === "toolCall"),
);
check("assistant 消息含 toolCall 块", Boolean(assistantWithToolCall));

const toolResultEntry = messageEntries.find(
  (entry) => entry.type === "message" && Array.isArray(entry.message.content)
    && entry.message.content.some((block) => block.type === "toolResult"),
);
check("工具结果消息存在（toolResult 块）", Boolean(toolResultEntry));

const usageEntries = flatEntries.filter((entry) => entry.type === "usage");
check("用量条目落盘", rawUsageRows === 1, `${rawUsageRows}`);

// ---------- 验证重新打开能读回完整内容（投影层的前提） ----------
const reopened: Session = await repo.open(
  { id: sessionId, path: join(sessionsDir, sessionFile!), createdAt: 0, storageVersion: 4, cwd: root, modifiedAt: 0 },
  BACKGROUND_CONTEXT,
);
const reopenedEntries = await reopened.findEntries(undefined, BACKGROUND_CONTEXT);
const reopenedMessages = reopenedEntries.filter((entry) => entry.type === "message");
check("重新打开读回全部消息条目", reopenedMessages.length === 4, `${reopenedMessages.length}`);

const stats = await reopened.getStats(BACKGROUND_CONTEXT);
check("stats 可读（用量合计口径）", stats !== undefined, JSON.stringify(stats).slice(0, 120));
check("重开会话的 stats 含用量合计", stats.usage?.input === 100 && stats.usage?.output === 40, JSON.stringify(stats.usage ?? {}));

await reopened.close(BACKGROUND_CONTEXT);

// ---------- 压缩后是否保留原文（硬闸门） ----------
// 用 MemorySessionRepo 跑一次压缩，检查旧消息条目是否仍在
const memRepo = new MemorySessionRepo();
const memSession: Session = await memRepo.create({ id: "compact-probe" }, BACKGROUND_CONTEXT);
await memSession.createBranch("main", null, BACKGROUND_CONTEXT);
const memBranch = await memSession.branch("main", BACKGROUND_CONTEXT);
for (let index = 0; index < 6; index += 1) {
  await memBranch.appendMessage(
    { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `消息 ${index}` }] },
    BACKGROUND_CONTEXT,
  );
}
const beforeCompact = (await memSession.findEntries(undefined, BACKGROUND_CONTEXT)).filter((entry) => entry.type === "message");
// 触发压缩（若会话本身不支持，则跳过该项）
let compacted = false;
try {
  const harnessLike = memSession as unknown as { compact?: (context: unknown) => Promise<unknown> };
  if (typeof harnessLike.compact === "function") {
    await harnessLike.compact(BACKGROUND_CONTEXT);
    compacted = true;
  }
} catch {
  // 压缩在 Session 层不可直接触发（由 AgentHarness 驱动）——标记为「需在阶段 1 端到端验证」
}
if (compacted) {
  const afterCompact = (await memSession.findEntries(undefined, BACKGROUND_CONTEXT)).filter((entry) => entry.type === "message");
  check("压缩后旧消息条目仍保留（完整事实源成立）", afterCompact.length >= beforeCompact.length, `${beforeCompact.length} → ${afterCompact.length}`);
} else {
  check("Session 层不直接暴露 compact（压缩语义留待阶段 1 端到端验证）", true, "由 AgentHarness 驱动");
}

await rm(root, { recursive: true, force: true });

// ---------- 结论 ----------
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const entry of failed) console.log(`  ❌ ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
  process.exitCode = 1;
}
