# open-zread-pi

把 **open_zread 的业务层**（`cli` / `Orchestrator` / `Browse` / `RepoAnalyzer` / `Types`）搬到 **pi 的 agent 内核**（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）之上运行。

> 一句话：**只换运行时内核，业务逻辑一行不改。**
> 原来的 `packages/agent-sdk`（自研 QueryEngine + 薄重试 + 整文件会话）被 `packages/agent-runtime` 适配层取代，对外仍暴露同名同签名的 `createAgent()` / `createProvider()` / 5 个文件工具 / 同一批类型。

---

## 目录结构

```
open-zread-pi/
├─ packages/
│  ├─ agent-runtime/     ← 新：pi 适配层（替代 agent-sdk）
│  │  ├─ src/agent.ts             createAgent（pi Agent 循环 + 重试编排 + 事件/钩子映射）
│  │  ├─ src/pi/runtime-model.ts  配置（provider/model/apiKey/baseURL）→ pi Provider + Model
│  │  ├─ src/retry.ts             RetryConfig 契约 + pi-ai 错误分类/退避
│  │  ├─ src/providers/           createProvider（pi-ai Models，供 browse-chat 使用）
│  │  ├─ src/tools/               原样复用的 Read/Write/Edit/Glob/Grep + defineTool
│  │  └─ test/                    冒烟测试（离线 faux + 本地 mock HTTP + provider）
│  ├─ orchestrator/      ← 保留：编排层（工具/提示词/并发/同步，仅把 import 指向 agent-runtime）
│  ├─ repo-analyzer/     ← 保留：Tree-sitter 分析（未改）
│  ├─ utils/             ← 保留：配置/cache/wiki 落盘/版本快照/provider-registry（未改）
│  └─ types/             ← 保留：共享类型（未改）
├─ apps/
│  ├─ cli/               ← 保留：Ink TUI（仅 browse-chat 的 provider 改为 pi 实现）
│  └─ browse/            ← 保留：React 19 + Vite 预览站（**独立安装**，见下方说明）
├─ fixtures/hello-python/ ← 测试夹具：极简 Python 项目（离线全链路试跑的目标）
├─ vendor/pi/packages/   ← pi 内核源码（ai / agent / telemetry / chord，上游零改动）
└─ tools/                ← vendor 管理模式切换脚本
```

---

## 快速开始

```bash
# 0) 全新 clone 后：安装依赖 + 构建 pi 内核 vendor 产物（vendor/pi/**/dist 不入库）
bun install
bun run vendor:build

# 1) 类型检查 + 全部冒烟测试（离线，不需要任何 API Key）
bun run test

# 3) 离线全链路试跑：用 mock LLM 对任意仓库跑「扫描 -> 蓝图 -> 并行页面」
#    默认目标是内置夹具 fixtures/hello-python
bun run mock:wiki
bun run mock:wiki path/to/any/repo   # 也可指定其它仓库

# 4) 真机跑 CLI：先配置 LLM（写入 ~/.zread/config.yaml）
bun run cli config
bun run cli            # 等价于 open-zread wiki

# 5) 预览站（独立 React 19 环境）
bun run browse:install
bun run browse:dev
```

要求：Bun ≥ 1.3（本仓库用 1.3.14 验证）、Node ≥ 22（pi 内核文档要求）。

---

## 内核替换说明（映射关系）

| 旧 agent-sdk | 新 agent-runtime（pi 实现） |
|---|---|
| 自研 `QueryEngine` 循环 | `pi-agent-core` 的 `Agent` + `runAgentLoop` |
| `openai.ts` / `anthropic.ts` 手写协议适配 | `pi-ai` 的 `openai-completions` / `anthropic-messages` API 实现 |
| `utils/retry.ts` + 引擎内重试 | **流级重试**（未产出内容时重试，不污染会话）+ 可选 **run 级重试**；判定/退避复用 `pi-ai` 的 `isRetryableAssistantError` / `retryDelayMs` |
| `hooks.ts`（PreToolUse/PostToolUse） | 映射到 pi `Agent` 的 `beforeToolCall` / `afterToolCall` |
| `query(): AsyncGenerator<SDKMessage>` | 订阅 pi `AgentEvent` → 归一化为同一套 `SDKMessage`（含 `system/init`、`assistant`、`partial_message`、`tool_result`、`result`） |
| `maxTurns` | pi 的 `shouldStopAfterTurn` 计数，超限产出 `subtype: "error_max_turns"` |
| 5 个文件工具（Read/Write/Edit/Glob/Grep） | 实现原样复用，仅包装成 pi 的 `AgentTool`（JSON Schema 直接作为 TypeBox `TSchema` 使用） |
| `TokenUsage` | 由 pi `Usage` 映射（`cacheWrite`→`cache_creation_input_tokens`，`cacheRead`→`cache_read_input_tokens`） |
| `createProvider()`（browse-chat） | pi-ai `Models.completeSimple()` |

业务侧唯一改动：`import ... from '@open-zread/agent-sdk'` → `'@open-zread/agent-runtime'`（22 个文件，纯机械替换）。
`Orchestrator` 的并发控制（p-limit）、错误隔离、三层 Repo Map 工具、prompt、`wiki.json` 契约、`WritePageTool` 的 Mermaid 校验**全部未改**。

---

## 验证结果（`bun run test`）

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `test:agent` | pi Agent 循环、工具执行、钩子、流式事件、**429 重试**、usage 映射、maxTurns | 10/10 |
| `test:agent:http` | 真实 HTTP/SSE 路径：baseURL + apiKey 注入、增量 tool_call 参数解析、第二轮请求 | 7/7 |
| `test:provider` | `createProvider().createMessage()`（browse-chat 路径）、system 透传、usage | 5/5 |
| `test:analyzer` | RepoAnalyzer 扫描 + Tree-sitter 解析（未改动包仍可运行） | 5/5 |
| `test:bluprint` | **Orchestrator 端到端**：`generateWikiCatalog()` → 工具落盘 `wiki.json` → CatalogEvent 进度事件 | 6/6 |
| `test:pages` | **并行页面生成**：`generateWikiContent({maxConcurrent:3})` → `write_page` 落盘、frontmatter、Mermaid 校验拦截 | 6/6 |

另有诊断脚本 `packages/agent-runtime/test/debug-events.ts`（打印 pi 原始事件）。

### 离线全链路试跑（mock LLM）

`bun run mock:wiki <目标仓库>` 会用本地 mock OpenAI 服务驱动真实编排层，验证：
目录扫描 → 蓝图 `wiki.json` 落盘 → 并行页面 Agent → `write_page` 落盘，全程不联网、不需要 API Key。

已用测试夹具 `fixtures/hello-python` 验证通过：4 个 Python 源文件 → 4 页 Wiki，`completed=4 failed=0`，mock 请求 10 次。
（该目录下的 `.open-zread/` 就是生成产物，已 gitignore；真实内容请用 `bun run cli`。）

---

## 需要知道的三个工程细节

### 1. `apps/browse` 独立安装（React 18/19 隔离）
`apps/cli`（Ink 4 + React 18）与 `apps/browse`（React 19 + Vite）混装时，bun 会为 `ink` 的 `react-reconciler` 选到 React 19 变体，导致 CLI 启动即崩：
`TypeError: undefined is not an object (evaluating 'ReactSharedInternals.ReactCurrentOwner')`。
因此 **`apps/browse` 不列入根 workspaces**，单独 `bun install`（`bun run browse:install`）。它不引用任何 `@open-zread/*` 包，隔离无副作用。

### 2. vendor 管理模式（src ⇄ dist）
`vendor/pi/packages/*` 是 pi 上游源码快照，两种消费方式：

- **dist 模式（默认）**：`exports` 指向已构建的 `dist/*.js|.d.ts`；类型检查走 `.d.ts`，速度快。
  `dist/` **不入库**，因此全新 clone 后必须先跑一次：`bun run vendor:build`（顺序：telemetry → chord → ai → agent）。
- **src 模式（免构建）**：`exports` 指向 `src/*.ts`，Bun 直接跑 TS，适合修改 pi 源码。
  切换：`bun run vendor:src`（免构建）/ `bun run vendor:dist`（需紧接 `vendor:build`）。

`ai` 包用 `tsconfig.app.json` 构建（只编译 `index.ts` + 三个 api lazy 入口的闭包），
因为 pi 上游的 `providers/*.models.ts` 依赖构建期生成的 `src/providers/data/*.json`（仓库快照里不存在）；本工程不需要模型目录，因为我们自己构造 `Model`。
另：`vendor/pi/packages/ai/package.json` 显式补了 `@smithy/types`（上游靠 aws-sdk 传递获得，孤岛安装模式下需显式声明）。

### 3. 配置与凭据仍在 open_zread 侧
`~/.zread/config.yaml`（provider / model / api_key / base_url / concurrency）与 CLI 配置 UI 未改动；
适配层把这份配置翻译成 pi 的 Provider + Model + ApiKeyAuth（`baseUrl` 经 `auth.resolve()` 注入，等价 pi 官方 provider 工厂的做法）。
未登记过的 providerId 回退为 OpenAI 兼容协议（旧实现会直接抛 `Unsupported provider`）——这是有意的健壮性增强。

---

## 未迁移（当前业务链路未使用）

原 `agent-sdk` 的以下能力**没有**搬过来，需要时再按需补：

- **MCP**（stdio/SSE/HTTP/进程内）—— pi 文档中无 MCP 能力，若需要应作为独立扩展实现；
- **Skill 系统 / Task / Team / Cron / LSP / WebSearch / Notebook / Worktree / Plan 模式 / AskUser 等 27 个内置工具**；
- **会话持久化**（`~/.open-agent-sdk/sessions/*.json`、tag/rename/fork/list）—— pi 侧是 JSONL 会话树 + SQLite，语义不同；当前 wiki 生成是"每次运行一次性 agent"，不需要该能力。

补充阅读：`AGENTS.md`（上下文总结 + 开发与 Git 流程，协作唯一入口）、`MIGRATION.md`（迁移决策、风险、后续路径）。
