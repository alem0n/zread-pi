# AGENTS.md — open-zread-pi 上下文与开发规则

本文件是 AI 代理与人类开发者在本仓库工作的**唯一入口约定**：先读这里，再动手。
与 `README.md`（怎么用）、`MIGRATION.md`（为什么这样迁移）配合使用；三者冲突时以本文件为准。

---

## 1. 这个仓库是什么

**open_zread 的业务层运行在 pi 的 agent 内核之上。**
原来的 `packages/agent-sdk`（自研 QueryEngine、API 级重试、整文件会话）被 `packages/agent-runtime` 适配层取代，
内部改由 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` 驱动，**对外契约不变，业务逻辑零改动**。

```
apps/cli            pi-tui 全屏 TUI（不再依赖 Ink/React；布局与快捷键与迁移前一致）
apps/browse         React 19 + Vite 预览站（保留；独立安装，见 §6.3）
packages/
  agent-runtime     ★ 适配层：createAgent / createProvider / 5 个文件工具 / SDKMessage 等类型
                    + pi/provider-catalog（pi-ai 内置 Provider 目录 / 登录 / 自定义模型）
                    + pi/auth-store（~/.zread/auth.json 凭据）/ pi/models-store（模型目录缓存）
  orchestrator      ★ 编排层：三层 Repo Map 工作流、prompts、p-limit 并发、wiki.json 契约（仅 import 改指向）
  repo-analyzer     ★ Tree-sitter 扫描与解析（未改）
  utils             ★ 配置 / cache / wiki 落盘 / 版本快照 / provider-registry（未改）
  types             ★ 共享类型（未改）
fixtures/hello-python  测试夹具：极简 Python 项目，离线全链路试跑的目标
vendor/pi/packages/    pi 内核源码（ai / agent / telemetry / chord / tui，上游零改动）
tools/                 vendor 模式切换脚本、mock LLM 全链路脚本
```

### 1.1 关键设计决策（改动前必须理解）

| 决策 | 原因 |
| --- | --- |
| 只替换运行时内核，不动业务层 | 业务层（编排/并发/落盘/提示词）已验证可用；换底座是为了健壮性 |
| CLI 从 Ink 换成 pi-tui，**布局/快捷键/文案不变** | 与内核同一生态，去掉 React 18/Ink 依赖；业务逻辑在 `views/*/mapper.ts`、`state.ts` 等纯函数层原样保留 |
| 适配层保持 `agent-sdk` 的**同名同签名**契约 | 业务侧 22 处 import 机械替换即可，行为可回退对比 |
| 重试放在 `streamFn` 层，且只在"未产出内容"时重试 | pi 的 Agent 循环刻意不内置重试；这样失败尝试不会写进会话记录 |
| 钩子映射到 pi 的 `beforeToolCall` / `afterToolCall` | 与旧 `PreToolUse` / `PostToolUse` 语义一一对应，UI 进度事件零改动 |
| 5 个文件工具**原样复制**而非改用 pi 内置工具 | 保持工具名/schema/提示文本不变，避免 LLM 行为漂移 |
| 配置界面改用 pi-ai 的 Provider/登录/模型目录 | 不再自维护 provider registry；API Key 统一走 `Models.login('api_key')`，凭据落 `~/.zread/auth.json`，天然支持多 Provider；Provider 详情页把 API Key 与模型选择并列在同一页面（不再有 OAuth 订阅选项）；自定义模型按 pi models.json 合并语义叠加 |
| 凭据不进 `config.yaml` | 用户配置（provider/model/base_url/自定义模型）在 `config.yaml`， 秘密（API Key / OAuth token）在 `auth.json`；旧扁平字段首次切换时自动迁移后清空 |
| pi 以 vendor 源码 + dist 产物方式消费 | 可锁定版本、可局部调试，同时类型检查走 `.d.ts` 保持快 |
| `apps/browse` 不进根 workspaces | React 19（browse）与 React 18（ink）混装会让 CLI 启动即崩，见 §6.3 |

### 1.2 契约冻结点（破坏即需同步改业务层）

```ts
createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt,
              tools, maxTurns, hooks, retryConfig, includePartialMessages })
  -> { query(prompt): AsyncGenerator<SDKMessage>, close(), abort() }

createProvider(providerIdOrApiType, { apiKey, baseURL })
  -> { apiType, createMessage({ model, maxTokens, system, messages }) }
```

- `SDKMessage` 联合类型与 `CatalogEvent` 时序（`requesting → responding → tool_start → tool_result → complete`）
- `TokenUsage` 字段名、`BlueprintResult.durationMs / tokenUsage`
- 工具名：`Read` / `Write` / `Edit` / `Glob` / `Grep` / `write_page` / `generate_blueprint`（提示词里写死了）
- `AppConfig.llm` 的旧扁平字段（`provider/model/api_key/base_url`）仍可读；新增 `providers` 映射（`LlmProviderConfig`）与 `CustomModelConfig`。旧配置必须能直接启动（运行时自动迁移/回退）

---

## 2. 环境与命令

要求：Bun ≥ 1.3（验证用 1.3.14）、Node ≥ 22（pi 内核要求）、Python 3.x（仅夹具用）。

```bash
bun install                # 安装依赖
bun run vendor:build       # 构建 pi 内核产物（全新 clone 后必须执行一次）
bun run typecheck          # tsc --noEmit（apps/cli/src + apps/cli/test + packages/*/src）
bun run test               # typecheck + 8 个测试套件（离线，无需 API Key）
bun run test:tui           # CLI(pi-tui) 专项：布局/快捷键 + 真实终端启动 + mock LLM 生成/同步
bun run mock:wiki          # 用 mock LLM 对 fixtures/hello-python 跑全链路
bun run cli                # 真机 CLI（需 ~/.zread/config.yaml）
```

| 命令 | 覆盖内容 | 期望 |
| --- | --- | --- |
| `test:catalog` | pi-ai Provider 目录、api_key 登录写 auth.json、多 Provider、自定义模型、未内置 Provider、runtime model、logout | 25/25 |
| `test:agent` | pi 循环、工具执行、钩子、流式事件、429 重试、usage、maxTurns | 10/10 |
| `test:agent:http` | 真实 HTTP/SSE：baseURL + apiKey 注入、增量 tool_call 解析 | 7/7 |
| `test:provider` | `createProvider().createMessage()`（browse-chat 路径） | 5/5 |
| `test:analyzer` | RepoAnalyzer 扫描 + Tree-sitter 解析 | 5/5 |
| `test:blueprint` | Orchestrator 端到端：`generateWikiCatalog()` 落盘 `wiki.json` | 6/6 |
| `test:pages` | 并行页面生成：`generateWikiContent()` + `write_page` + Mermaid 校验 | 6/6 |
| `test:tui` | `smoke-tui.ts`（布局/按键/输入框/长列表分页/终端自适应/按键重绘与 Kitty 松开过滤/Provider 详情页 API Key+模型焦点切换/多 Provider/自定义模型 124 项）、`render-all-routes.ts`（全部 14 个路由渲染不报错、无超宽行）、`real-run-check.ts`（真实 ProcessTerminal 启动/退出 9 项）、`mock-generate.ts`（生成 + 同步全链路 19 项） | 124 + 14 + 9 + 19 |
| `mock:wiki [path]` | 蓝图 + 页面全链路（mock LLM，请求可数） | `completed=N failed=0` |

> **硬性要求**：任何改动都必须实际运行对应验证并贴出真实输出。
> **不允许**在未运行的情况下声称"测试通过"。

---

## 3. 改动类型 → 必须执行的动作

| 改动 | 必做 | 说明 |
| --- | --- | --- |
| 业务层（orchestrator / repo-analyzer / utils / types / browse） | `bun run typecheck` + `bun run test` | 若触及 wiki 产物结构，额外跑 `bun run mock:wiki` 并核对 `wiki.json` 与页面文件 |
| 配置结构 / Provider 目录（types 的 `LLMConfig`、agent-runtime 的 `pi/*`） | `bun run typecheck` + `bun run test:catalog` + `bun run test` | 旧 `config.yaml`（仅扁平字段）必须仍可启动；`auth.json` 损坏需自愈 |
| CLI TUI（`apps/cli/src/**`） | `bun run typecheck` + `bun run test:tui` | 布局/快捷键/文案改动必须同步 `smoke-tui.ts` 的断言；列表分页行为（窗口/位置指示/PageUp·PageDown·Home·End）也归该套断言覆盖 |
| 适配层 `packages/agent-runtime/**` | `bun run test`（全部 8 套）+ 新增/更新针对性断言 | 契约面改动必须同步 `MIGRATION.md` §3/§4 |
| pi vendor 源码（`vendor/pi/**/src`） | `vendor:src` → 改 → `vendor:dist` → `vendor:build` → `bun run test` | 见 §6.1；**不要手改 `dist/`** |
| 依赖变更 | `bun install` 后一并提交 `bun.lock`，并在 commit body 说明原因 | 不要把 `node_modules` 带进仓库 |
| 文档（`*.md`） | 至少 `bun run typecheck` | 若文档描述了命令，需实际执行一遍确认命令可用 |
| 新增脚本 / 夹具 | 登记到根 `package.json` 的 `scripts`，并在 `README.md` 写明用途 | `tools/` 脚本用相对路径 import 工作区源码 |

---

## 4. Git 工作流（强制）

### 4.0 铁律

1. **`master` 只接受合并，不接受直接提交。**
2. **每次改动都必须新建分支**，完成后走"验证 → 合并 → 删除分支"。
3. 只有**验证完全通过**（§2 对应命令全绿）才允许合并。
4. 禁止：`git push --force`、`git commit --no-verify`、`git reset --hard` 丢弃他人改动。
5. 禁止提交生成物：`node_modules/`、`dist/`、`.open-zread/`、`__pycache__/`（已在 `.gitignore`）。

### 4.1 标准流程

```bash
# 0) 起点检查：工作区必须干净，且基于最新 master
git status --short                 # 应为空
git checkout master && git pull    # 无远端时跳过 pull
git log --oneline -3               # 确认基线

# 1) 建分支（命名：<type>/<scope>-<简述>）
git checkout -b feat/agent-retry-scope
#    type ∈ feat | fix | docs | refactor | test | chore
#    scope 建议用包名或模块：agent-runtime / orchestrator / cli / browse / vendor / docs

# 2) 小步提交（一个提交只做一件事）
git add packages/agent-runtime/src/agent.ts packages/agent-runtime/test/smoke-agent.ts
git status --short                 # 复核：只暂存自己改的文件
git commit                         # 见 §4.2 消息规范

# 3) 验证（改动类型对应 §3 的命令，必须真实执行）
bun run test

# 4) 合并回 master（保留分支脉络，不使用 fast-forward）
git checkout master
git merge --no-ff docs/agents-md -m "docs: add AGENTS.md with context and git workflow"

# 5) 合并后再次验证（防止合并引入偏差）
bun run test

# 6) 清理分支
git branch -d docs/agents-md
```

### 4.2 Commit 消息规范

格式：`<type>(<scope>): <简述>`，正文用中文分点说明**改了什么、为什么、验证了什么**。

```text
fix(agent-runtime): 修正重试判定，空 text_delta 不再视为已产出内容

- 问题：faux/部分网关在失败响应前会发空 text_delta，导致 429 不触发重试
- 方案：只有非空 delta 或带参数的 toolCall 才算"已产出内容"，并缓冲 start/终止事件
- 验证：bun run test（test:agent 10/10，429 重试断言通过），bun run mock:wiki completed=4 failed=0

Refs: MIGRATION.md §4
```

要求：

- 一次提交 = 一个逻辑改动；不要把"改功能 + 改格式 + 升依赖"混在一起。
- 正文必须包含**验证方式与实际结果**；没有验证的提交视为未完成。
- 禁止 emoji、禁止"update code"这类无信息量的描述。

### 4.3 分支生命周期与异常处理

| 情况 | 处理 |
| --- | --- |
| 验证不通过 | 继续在当前分支修，追加提交（不要合并） |
| 分支方向错了 | 切回 master，`git branch -D <branch>` 丢弃，不污染 master |
| 已合并但发现问题 | 在 master 上新建 `fix/...` 分支，用 `git revert <merge-commit>` 或前向修复，禁止改写历史 |
| 合并冲突 | 只解决自己改动涉及的文件；冲突落在无关文件时停下询问，不要强推 |

---

## 5. 完成定义（Definition of Done）

- [ ] 改动范围与需求一致，没有顺手改无关文件
- [ ] 没有破坏 §1.2 的契约冻结点（若必须改，业务层同步修改 + `MIGRATION.md` 更新）
- [ ] `bun run typecheck` 0 错误
- [ ] 与改动类型匹配的测试全绿（§3），且输出被真实记录
- [ ] 新增/变更的行为有对应断言（不留"只改实现不补测试"的改动）
- [ ] 文档同步：`README.md`（命令/用法）、`MIGRATION.md`（决策/行为差异/风险）
- [ ] 分支已合并（`--no-ff`）、master 上复验通过、分支已删除
- [ ] 工作区干净：`git status --short` 为空

---

## 6. 已知坑与约束（踩过，别重踩）

### 6.1 vendor 是"源码 + 产物"双模式，产物不入库
- `vendor/pi/packages/*/package.json` 的 `exports` 指向 `dist/*.js|.d.ts`；`dist/` 被 gitignore。
- 全新 clone：`bun install && bun run vendor:build`（顺序 telemetry → chord → ai → agent → tui）。
- 要改 pi 源码：`bun run vendor:src`（免构建，Bun 直接跑 TS）→ 改 `src/` → `bun run vendor:dist` → `bun run vendor:build`。
- **不要手改 `dist/`**：会被下次 `vendor:build` 覆盖。
- `ai` 包用 `tsconfig.app.json` 构建，现包含：`src/index.ts`、3 个 api lazy 入口、`src/providers/all.ts`（40 个内置 Provider + 模型目录）、`src/bun-oauth.ts`（静态注册 OAuth 流程）、`src/auth/oauth/*.ts`。
  对应的 `src/providers/data/*.json`（含 `.manifest.json`，0.6MB）已从**同版本 0.85.1** 的 npm 发布包补齐并入库（上游是构建期生成，快照里原本没有）。
  OAuth 流程在 pi 里是「变量 specifier 动态 import」，打包器无法静态解析，所以 `provider-catalog.ts` 在构建 catalog 前调用 `registerBunOAuthFlows()`——**打包后的 CLI 也必须保留这一步**，否则 OAuth 登录会在运行时报找不到模块。
- `vendor/pi/packages/ai/package.json` 显式声明了 `@smithy/types`（上游靠 aws-sdk 传递获得；孤岛安装模式下必须显式写）。

### 6.2 业务工具的 schema 是"JSON Schema 直接当 TypeBox 用"
`ToolDefinition.inputSchema` 原样传给 pi 的 `AgentTool.parameters`，pi 用 TypeBox 的编译/校验器处理这类纯 JSON Schema 是可行的（已验证）。新增工具时按旧风格写 `inputSchema` 即可，不要引入 TypeBox DSL。

### 6.3 React 18 / 19 不能混装（历史约束，现已缓解）
`apps/cli` 在迁移到 pi-tui 之前使用 Ink 4 + React 18，与 `apps/browse`（React 19）在同一次 install 中解析时，
`ink` 的 `react-reconciler` 会拿到 React 19 变体，CLI 启动即崩：
`TypeError: undefined is not an object (evaluating 'ReactSharedInternals.ReactCurrentOwner')`。
因此 `apps/browse` **不在根 workspaces 内**，用 `bun run browse:install` / `bun run browse:dev` 独立处理。

> CLI 已换成 pi-tui（零 React 依赖），该冲突不再存在；但保持现状不动（本次迁移不碰 browse）。
> 若日后要合并：把 browse 加回 workspaces 后重跑 `bun run test:tui`（含真实 ProcessTerminal 启动检查）验证。

### 6.4 RepoAnalyzer 依赖 cwd
`parseFiles()` 以 `process.cwd()` 为根解析相对路径，`scanFiles()` 返回相对路径。
任何调用它的脚本/测试都必须先 `process.chdir(目标仓库)`（见 `packages/repo-analyzer/test/smoke-analyzer.ts`）。
首次解析某种语言会从 CDN 下载 WASM 到 `~/.zread/parsers`。

### 6.5 生成的 Wiki 产物不入库
流水线会在**目标仓库**写出 `.open-zread/wiki/**`；夹具里也一样。
它已被两处 `.gitignore` 覆盖，跑完测试或试跑后无需提交。

### 6.6 配置与凭据在 open_zread 侧
- `~/.zread/config.yaml`：非敏感配置。`llm.provider/model` 是当前生效项；`llm.providers.<id>` 保存每个 Provider 的 `base_url` / `api` / `auth_type` / 自定义模型 / 上次选择的模型。旧扁平 `llm.api_key`/`llm.base_url` 仍可读。
- `~/.zread/auth.json`：pi-ai 格式凭据（`{ "<providerId>": Credential }`），由 `Models.login()` 写入，可同时保存多个 Provider；配置界面只走 api_key，OAuth 凭据需手动写入（运行时仍会自动刷新）。
- `~/.zread/models-store.json`：动态 Provider 的模型目录缓存。
- 适配层把这份配置翻译成 pi 的 Provider + Model（内置 Provider 直接用 `builtinProviders()`；未内置的用 `createProvider()` 动态注册；自定义模型按 pi models.json 语义合并）。
- **未登记的 providerId 回退 OpenAI 兼容协议**（旧实现会抛 `Unsupported provider`）——这是有意的健壮性增强。

### 6.7 未完成事项（不要当成已完成）
- **尚未用真实 API Key 跑过完整 wiki 生成**：全部验证基于 faux / mock HTTP / 内置目录。
  首次真机验证：`bun run cli config` → 在目标仓库 `bun run cli`，重点看 retry 事件与长上下文下的 usage。
- **OAuth 登录界面已按需求移除**：配置界面只提供 API Key（Provider 详情页包含 API Key + 模型两块配置）；
  catalog/运行时仍保留 OAuth 能力（手写 `auth.json` 可用），但未在真机验证过完整授权流程。
- **CLI 的真机交互（键盘/鼠标/中文输入）仅做了自动化回归**：`test:tui` 用假终端注入按键 + 真实 ProcessTerminal 启动检查；
  真机 IME 定位、Windows 终端下的 Shift+Enter、剪贴板等仍需人工确认。
- **MCP / Skill / Task / Team / LSP / Cron 等能力未迁移**（原 `agent-sdk` 有，pi 文档无 MCP）。
- **会话语义差异**：旧 `saveSession/loadSession/tag/fork` 未迁移；pi 侧是 JSONL 会话树 + SQLite。

---

## 7. 后续方向（详见 MIGRATION.md §6）

1. 接 pi 的压缩能力（`transformContext` / `compaction`）以对等旧的"自动压缩"。
2. 用 pi 的 usage ledger + 真实 `Model.cost` 替代旧 `estimateCost`。
3. 需要聊天/会话时接 pi 的 `JsonlStorage` 会话树，而不是回填旧实现。
4. 需要子代理/权限弹窗/计划模式时，走 pi 扩展 API（`registerTool` / `tool_call` 事件阻断）。

---

## 8. 文档索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 用法、目录、验证矩阵、三个工程细节（browse 隔离 / vendor 模式 / 配置归属） |
| `MIGRATION.md` | 迁移决策、改动清单、契约冻结点、与旧实现的行为差异、风险与后续路径 |
| `AGENTS.md` | 本文件：上下文总结 + 开发与 Git 流程（唯一入口约定） |
| `fixtures/hello-python/README.md` | 夹具说明与三种测试用法 |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **open-zread-pi** (2587 symbols, 4557 relationships, 174 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/open-zread-pi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/open-zread-pi/clusters` | All functional areas |
| `gitnexus://repo/open-zread-pi/processes` | All execution flows |
| `gitnexus://repo/open-zread-pi/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
