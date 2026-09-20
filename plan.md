# 方案 C：pi 会话 = 唯一完整事实源，logger 退回纯诊断

> 演进执行方案。每阶段带闸门，闸门不过不进下一阶段。

---

## 0. 事实基础（已验证，执行的依据）

`agent_start` 三字段在 pi 中的归属：

| 字段 | 归属 | 落盘 |
| --- | --- | --- |
| `model` / `provider` / `thinkingLevel` | pi 会话 `LaneConfiguration`（`setValue(laneConfig(name))`） | ✅ |
| 消息 / 工具调用 / 工具结果 / 用量 / 压缩摘要 | pi 会话条目（`MessageEntry` / `UsageRow` / `CompactionEntry`） | ✅ |
| `systemPrompt` 全文 / `toolCatalog` schema / `tokenBudget` | harness 配置（进程局部） | ❌ → 迁入瘦业务层 |
| provider request id | 响应头，非模型可见内容 | ❌ → 迁入瘦业务层 |

结论：完整内容全在 pi 会话；非会话内容的事实（三个配置字段 + request id）落到瘦业务层。
node 侧 `FileSystem` 适配现成（`harness/env/nodejs.ts` 的 `NodeExecutionEnv`，`agent/src/node.ts` 导出）。

根因：`packages/agent-runtime/src/harness/driver.ts` 每次 query 都 `new MemorySessionRepo()`（L127），
权威会话用完即弃；业务层被迫在 `orchestrator/agents/create-agent.ts` 用 12 个 builder
+ 节流 + 预览 + sessionId 归属重建一份影子，影子被写进 `events.jsonl` 与 logger 两份。

---

## 1. 目标与不变量

**目标**：`run` 目录成为 session 的唯一完整事实源；logger 退回纯基础设施诊断；压缩摘要成为投影而非第二份存储。

| 不变量 | 含义 |
| --- | --- |
| 会话即事实源 | 模型可见的一切都在 pi 会话条目里；业务层不再重建内容 |
| logger 纯诊断 | run 生命周期内 logger 只发 warn/error 基础设施失败，内容结构上不经过业务层 |
| 视图皆投影 | 压缩摘要 / 轨迹回放 / UI 用量合计 / telemetry 全部从会话 + 瘦业务事件派生 |

---

## 2. 目标架构

```
createAgent(options)                                  ← 新增 sessionRoot 注入
  ↓
queryHarness(request)                                 ← 按 sessionRoot 构造 JsonlSessionRepo
  sessionsRoot = <repo>/.zread-pi/runs/<runId>/sessions/
  ↓ pi 自己写完整内容（一次、原子、可 fork、带版本）
  <runId>/sessions/--<cwd 转义>--/<ts>_<sessionId>.jsonl   ← 唯一完整事实源
  ↓
  ① events.jsonl（瘦业务层，只剩事实，零内容）
     run_start / run_end · stage · section · page_start / page_end
     failed_sections · scan_start / scan_end
     agent_config      ← systemPrompt 全文 + toolCatalog schema + tokenBudget
     provider_request  ← provider request id（排障关联）
  ② logger（纯基础设施诊断）
     config / lock / 原子写失败 / 保留期清理 / 自愈 / 安装器 / 版本守卫 / provider 同步 / wasm 引导
  ③ 视图（全部是投影）
     压缩摘要 digest / 轨迹回放 replay / TUI 用量合计 / telemetry
     ← 从「会话条目 + 瘦业务事件」join 派生
```

注入点：`HarnessQueryRequest` 加可选 `sessionRoot?: string`；`driver.ts` 有它就构造
`JsonlSessionRepo({ fileSystem: nodeEnv, sessionsRoot })`，缺省仍 `MemorySessionRepo`。

---

## 3. 分阶段执行

### 阶段 0 — 验证探针

**做**

- `test:agent` 加断言：`NodeExecutionEnv` + `JsonlSessionRepo` 指向临时目录跑一次 mock query，
  断言会话文件落盘且含完整内容（assistant 消息 / toolCall 块 / toolResult / usage 行）。
- 断言 open / list / fork 在 zread-pi 消费链路里可用。
- 产出「会话文件样例 + 字段清单」，作为后续投影层的输入规格。

**闸门**：会话含完整内容（压缩后旧消息条目仍保留），目录布局为 `<runId>/sessions/--<cwd>--/<ts>_<sid>.jsonl`。

**已验证（探针 `packages/agent-runtime/test/probe-session-store.ts`，12/12 通过）**

| 断言 | 结果 |
| --- | --- |
| 目录布局 `<root>/sessions/--<cwd 转义>--/<ts>_<id>.jsonl` | ✅ 与方案预期一致 |
| 首行 header（`v:4` / `kind:header`），后续行为条目 | ✅ |
| 消息条目完整（user / assistant+toolCall / toolResult / assistant） | ✅ 4 条全部落盘 |
| assistant 消息含 `toolCall` 块；toolResult 独立消息 | ✅ |
| 用量行落盘（`kind:usage`） | ✅ |
| `repo.open()` 重开读回全部消息条目（投影层前提） | ✅ |
| `getStats()` 含用量合计（与 `RunMeta.usage` 口径可对齐） | ✅ |

**磁盘格式要点（投影层必须按此解析）**

- `value` 写入是单对象行：`{"kind":"value","op":"set",...}`
- `entry` / `usage` 是**事务数组行**（一批多条）：
  `[{"kind":"entry","type":"message","message":{...}}, ...]`
- 解析时需展开数组行，并按 `kind` 区分 `entry` / `usage`；`Session` 公开 API 不直接
  暴露 `scanUsage`，用量合计走 `getStats()`。

**压缩闸门的源码级结论（`runtime/drive/structural.ts` L261–276）**

- 压缩是**追加**一个 `CompactionEntry`（`insertEntry(entry)` + `parentId: state.tipId`
  + `setValue(branchTip(lane.name), outcome.resultEntryId)`），**不删除任何旧消息条目**。
- `CompactionEntry` 自带 `retainedTail`（保留的近期消息原文）+ `summary` + `tokensBefore`。
- 回放语义（`branch-summarization.ts` 的 `getMessageFromEntry`）：从 tip 往回走，
  遇到 `compaction` 条目时**用摘要替代**更早的历史进模型上下文——但旧消息条目仍在磁盘上。
- **结论：完整事实源成立**。磁盘层保留全部原文（含压缩点之前的），模型上下文层用摘要；
  投影层若需「完整视图」读全部分支条目，若需「模型可见视图」在 compaction 处截断并接摘要。

### 阶段 1 — 注入 repo（双写并行，先不断旧链）

**做**

- `HarnessQueryRequest` 增 `sessionRoot?: string`；`driver.ts` 按它构造 `JsonlSessionRepo`。
- 适配层 `createAgent` 增 `sessionRoot?: string`，透传。
- 编排层 `withRunLog` / `RunLogWriter.create` 算出 `sessionsRoot = <runDir>/sessions/`，
  传给每个 Agent（每个 Agent 一个会话，用各自 sessionId 创建/打开）。
- 影子捕获层暂不删，双写并行，用于交叉验证。

**闸门**：`mock:wiki` 跑完，会话目录存在、每个 Agent 一个文件、内容与 `events.jsonl` 逐条对得上。

### 阶段 2 — 影子捕获层退役（删重复的根）

**做**：按「内容类删 / 配置类迁移 / 业务类留」处理 `create-agent.ts`。

| 现有事件 / 逻辑 | 处置 |
| --- | --- |
| `buildMessageStartEvent` / `buildMessageDeltaEvent` + 节流 + 预览 + streamText 状态机 | 删（会话条目自带流式原文） |
| `buildMessageEndEvent`（含挂在它上面的 `requestId` 字段） | 删（内容进会话条目） |
| `buildToolStartEvent` / `buildToolEndEvent` + `toolErrors` 缓冲 | 删（toolCall 在 assistant 消息内，toolResult 独立） |
| `buildCompactEvent` | 删（`CompactionEntry`） |
| `buildRetryEvent` | 删（会话操作记录） |
| `buildStatusEvent` | 删（会话操作状态） |
| `buildAgentStartEvent` 的 model / provider / thinkingLevel | 删（`LaneConfiguration`） |
| `buildAgentStartEvent` 的 systemPrompt / toolCatalog / tokenBudget | 迁移为瘦业务事件 `agent_config` |
| provider request id（`SDKAssistantMessage.request_id` 的落点） | 迁移为瘦业务事件 `provider_request`，见下 |
| `run-log-sink.ts` 的 sessionId 生成与归属 | 删（每会话一文件，无交错；sessionId 仍透传给 pi，不再用于归属） |
| 业务事件：run_start/end、stage、section、page_*、failed_sections、scan_* | 留在 `events.jsonl` |

**request id 迁移**（采集不动，只动落点）

- 采集链全部保留在适配层，零改动：`extractRequestId()` + `after_response` 订阅
  + `SDKAssistantMessage.request_id`（provider 协议知识，只有适配层看得到响应头）。
- 落点从 `message_end.requestId` 挪到独立排障事件 `provider_request`
  （`{ requestId, model, provider, agent }`，纯元数据零内容）。
- 不挂 `agent_end`：一 Agent 多响应是常态（既有 e2e 断言 14 条 message_end 各自不同），
  挂终态只能留最后一个，会丢前面的 id。
- replay 侧与 `status` 同级：run 级 context 记录，不产生消息。

**logger 清理**

- 删 `create-agent.ts` 的完整内容 printf（L451/L454/L472/L514）与重复 info
  （L305 retry、L206/L310/L322/L333/L334 配置摘要）。
- 删 `run-log-writer.ts` 的 run 开始/结束 info（`run_start/run_end` 已覆盖）。
- 留基础设施 warn：锁/原子写失败、自愈、保留期清理。
- 保留 `PreToolUse/PostToolUse` 钩子里的 `onEvent?.(...)` 分发（TUI 实时进度依赖），只删捕获写入。

**闸门**：`test:agent` / `test:blueprint` / `test:pages` 全绿。

### 阶段 3 — 读取层改投影

**做**

- `packages/trajectory` 的 `replay` 改为读会话条目（turn = 会话真实结构，不再机械推导）；
  page / stage / section 边界由瘦业务事件按 seq 与会话条目时间序 join。
- 并发归属结构性消失（每 Agent 一个会话文件，无交错）。
- `summarizeRunEvents`（digest 纯函数，落在 trajectory 包，无 node 依赖）：
  从「会话 + 业务事件」投影压缩视图（名字 / 大小 / 耗时 / 用量，不含内容）。
- 用量合计改读会话 `UsageRow`（harness ledger 权威累计），与 `RunMeta.usage` 口径对齐。
- `readEvents` 语义调整或新增 `readSessionFacts(runId)`；browse / logview 跟随。

**闸门**：`test:trajectory` / `test:browse` 全绿，digest 投影正确。

### 阶段 4 — logger 守卫 + 完整性不变量

**做**

- 源码守卫测试（`test:logger`）：扫 `packages/orchestrator/src/**`，禁止
  `logger.info('%s', …)` 传入 `block.text` / `output` / `toolInput` / `prompt` 等内容引用。
- 完整性不变量测试（`test:trajectory`）：从一个 run 重建完整视图，断言含
  模型正文 / 工具 I/O / 用量 / 压缩 / 扫描 / request id（证明会话 + 业务事件自足，logger 一行内容都没有）。
- 保留期：会话文件计进 run 保留期（默认 20 个 run）；并行副本消失，总磁盘占用下降。

**闸门**：`test:logger` 守卫 + 完整性重建测试通过。

### 阶段 5 — fork / resume 启用

**做**

- pi 会话已 durable，open / fork / resume 直接可用，关闭 AGENTS.md §6.7 的「会话语义差异」缺口。
- 中断续跑：编排层在 run 重开时按 sessionId 打开既有会话，不再新建。

**闸门**：中断后续跑能接上既有会话上下文。

---

## 4. 契约变更清单（需同步业务层与文档）

- `RunEvent` 联合：删内容类 kind（`message_*` / `tool_*` / `retry` / `compact` / `status` / `agent_start`）；
  新增 `agent_config`（systemPrompt + toolCatalog + tokenBudget）、`provider_request`（request id）、
  `scan_start` / `scan_end`（如未在更早阶段加）。
- `AppendRunEvent`、`RunLogWriter.append`、`build*Event` 系列大量删除（捕获层退役）。
- `MessageEndEvent.requestId` 随 `message_end` 一并删除；request id 改由 `provider_request` 承载。
- `readEvents` 语义变更 / 新增会话读取 API；browse 的 `/api/runs/:runId/events` 跟随调整。
- `packages/trajectory` 的 replay 输入源改变；`TrajectorySnapshot` 形态尽量保持（UI 少动）。
- `RunMeta` 不动（仍记录 agents / pages / usage / events / lastSeq 计数）。
- 适配层 `createAgent` 与 `HarnessQueryRequest` 增可选 `sessionRoot`。
- 旧 `events.jsonl` 的内容事件不再产生；replay 保留对旧 kind 的解析（历史 run 仍可读）。

---

## 5. 测试矩阵（按 AGENTS.md §3）

| 改动类型 | 命令 |
| --- | --- |
| 适配层 `agent-runtime/**` | `typecheck` + `test:agent` + `test:agent:http` + `test`（阶段 0 探针 `probe-session-store.ts` 随 `test:agent` 跑） |
| 业务层 orchestrator / utils / types | `typecheck` + `test` + `mock:wiki` |
| 轨迹视图 / 捕获点 / browse | `test:trajectory` + `test:browse` + `mock:wiki`（前端改动另跑 `browse:build` + `test:components`） |
| logger | `test:logger`（含新源码守卫） |
| 蓝图三阶段 / 页面 | `test:blueprint` + `test:pages` |
| 上下文 / 首尾机制 | `test:context`（预算与压缩语义改读会话后需复核） |
| CLI | `test:tui` |

---

## 6. 风险与应对

1. **吃 vendor 会话格式**：消费 pi format-4 JSONL，版本随 vendor 走；pi 自带 legacy-v3 迁移。
2. ~~**压缩是否保留原文**~~ **已解除**（阶段 0 源码级结论）：压缩追加 `CompactionEntry`、不删旧条目，
   磁盘保留全部原文；模型上下文层在 compaction 处接摘要。投影层按需选「全部分支条目」
   或「compaction 处截断 + 摘要」两种视图。
3. **会话目录布局不可控**：目录名由 cwd 转义、文件名由时间 + id 生成，阶段 0 确认实际布局并适配投影层。
4. **保留期体量**：会话文件是完整内容，单个 run 占用上升；并行副本消失，净占用下降。
5. **TUI 实时进度依赖 `onEvent`**：阶段 2 删捕获时必须保留 `onEvent` 分发，否则生成页进度断裂。
6. **双写期顺序**：events.jsonl 的 seq 单调由 RunLogWriter 保证，会话由 pi 的 commitQueue 保证，互不干扰。

---

## 7. 版本与分支

- 分支：`feat/session-as-source-of-truth`
- feat → 次版本 +1（破坏 `RunEvent` 联合 + 新增会话持久化 + logger 语义变更）
- tag 摘要：`vX.Y.Z —— pi 会话成为唯一完整事实源，影子捕获层退役，logger 退回纯诊断`
- 发布说明 `.github/release-notes/vX.Y.Z.md` 随分支提交；MIGRATION / AGENTS / README 同步（见 §4）

---

## 8. 执行次序

```
阶段 0  验证探针 ✅ 已通过（12/12；压缩闸门已用源码级证据解除）
   ▼
阶段 1  注入 repo（双写并行）──→ 闸门：mock:wiki 会话目录与 events.jsonl 内容一致
   ▼
阶段 2  影子捕获层退役（含 request id 落点迁移）──→ 闸门：test:agent / test:blueprint / test:pages 全绿
   ▼
阶段 3  读取层改投影 ──→ 闸门：test:trajectory / test:browse 全绿，digest 投影正确
   ▼
阶段 4  logger 守卫 + 完整性不变量 ──→ 闸门：守卫与重建测试通过
   ▼
阶段 5  fork / resume 启用 ──→ 闸门：中断续跑能接上既有会话
```
