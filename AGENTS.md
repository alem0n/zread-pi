# AGENTS.md — zread-pi 开发规则

本文件是 AI 代理与人类开发者在本仓库工作的**行为规则**：先读这里，再动手。
项目介绍与包结构见 `README.md`；包级修改要点见 `RULES.md`；视觉规范见 `DESIGN.md`。
冲突时以本文件为准。

> **总则：跨平台优先。** Windows / Linux / macOS 三平台必须等价可用（见 §7）。

## 1. 对话与提交

- 回答简洁直接，只写技术性内容；commit / 文档 / 注释禁止 emoji 与无信息量描述。
- 大范围改动前先读完整文件，不要只靠搜索片段。
- 用户问问题时，先回答，再动手改代码或跑命令。
- 一次提交 = 一个逻辑改动；commit 正文必须含**验证方式与实际结果**，没有验证的提交视为未完成。
- 没有用户明确要求，不删除看起来是有意设计的功能或代码。

## 2. 命令

要求：Bun ≥ 1.3、Node ≥ 22。命令统一经 `bun run`（跨平台入口），
Windows 下推荐 Git Bash / WSL（PowerShell 亦可跑 `bun run *`，但不要依赖 CMD 内建语法）。

> 全套测试、`mock:wiki` 与 CLI 均**不依赖 Python**：夹具是静态文件，由 Tree-sitter WASM 解析器扫描；
> 黄金值也硬编码在 `golden-parity.ts` 里。只有改黄金值样本时才需要 Python 3（见 §3「一致性校验」行）。

```bash
bun install                # 安装依赖
bun run vendor:build       # 构建 pi 内核产物（全新 clone 后必须执行一次）
bun run typecheck          # tsc --noEmit
bun run test               # typecheck + 全部测试套件（离线，无需 API Key）
bun run test:<套件>         # 针对性套件，按 §3 改动类型选择
bun run mock:wiki          # 用 mock LLM 跑全链路（产出可回放 run）
bun run browse:build       # 预览站静态产物
bun run cli                # 真机 CLI（需 ~/.zread-pi/config.yaml）
bun run cli --dir <repo>   # -d/--dir 指定目标目录
bun run cli history        # 全局记忆：清理失效项目并列出
```

- **任何改动都必须实际运行对应验证并贴出真实输出**；不允许在未运行的情况下声称"测试通过"。
- 改 `apps/browse` 组件或 `packages/trajectory` 展示层行为时**测试先行**（先写/改测试见红灯，再改实现到绿灯；流程见 `apps/browse/test/README.md`）；纯逻辑优先在模型层单测，只有渲染 / 交互 / 布局契约才进组件测试。
- 新增脚本 / 夹具：登记到根 `package.json` 的 `scripts` 并在 `README.md` 写明用途；`scripts` 一律 `bun run xxx.ts`，不写 `rm -rf` / `&&` 链等仅 POSIX 可用的 shell 逻辑。
- 依赖变更：`bun install` 后一并提交 `bun.lock` 并在 commit body 说明原因；不带 `node_modules`。

## 3. 改动类型 → 必做动作

| 改动 | 必做 |
|---|---|
| 业务层（orchestrator / repo-analyzer / utils / types / browse） | `typecheck` + `test`；触及 wiki 产物结构另跑 `mock:wiki` 并核对 `wiki.json` 与页面；**日志相关另跑 `test:logger`** |
| 配置结构 / Provider 目录（`types` 的 `LLMConfig`、agent-runtime 的 `pi/*`） | `typecheck` + `test:catalog` + `test`；旧 `config.yaml`（仅扁平字段）必须仍可启动；`auth.json` 损坏需自愈 |
| CLI TUI（`apps/cli/src/**`） | `typecheck` + `test:tui`；布局 / 快捷键 / 文案 / 列表分页改动必须同步 `smoke-tui.ts` 断言 |
| 适配层 `packages/agent-runtime/**` | `test`（全部套件）+ 针对性断言；契约面改动同步 §4；首尾机制（预算 / 提示 / 终止）改动补 `test:context` |
| 工具层 `agent-runtime/src/tools/**`（含图片管线 `image/**`） | `typecheck` + `test:tools` + `test`；**工具不得改名**（提示词与测试依赖名字）；图片管线改行为补 `test:tools` 的 6b 段；打包产物须保持 `apps/cli/dist/photon_rs_bg.wasm` |
| 蓝图三阶段 / sync（`prompts/**`、`tools/output-tools.ts`、`agents/blueprint-stages.ts`、`wiki/sync-wiki.ts`） | `typecheck` + `test:blueprint` + `test`；每阶段落盘保持 `loadWikiBlueprint` 可加载（骨架 pages 为空合法）；单 section 失败与 SyncDiff 语义必须有 e2e 断言 |
| 标题精修 / 蓝图档位 / 基础分类（`blueprint-detail.ts`、`prompts/classify.ts`、`prompts/topics.ts`、`BASE_SECTIONS`、`OVERVIEW_SECTIONS` 等） | `typecheck` + `test:blueprint` + `test:pages` + `mock:wiki` + `test`（配置界面另跑 `test:tui`）；增删基础分类须同步 ① sections 区间下限（`judgeQuantity` 判归一化后 count）② `OVERVIEW_SECTIONS` 的 Mermaid 强制角色 ③ 夹具里靠「基础分类 + 领域」凑越界的清单（少一个基础分类要补一个领域，否则缩编链路静默失效）④ mock 夹具页数与用量算术（`formatBytes` <1000 不带 k）⑤ `README.md` 档位区间描述 |
| 内容密度门（`wiki/content-gate.ts`、`tools/page-tools.ts`、`generate-wiki.ts` 降级落盘、`QualityConfig` 等） | `typecheck` + `test:pages` + `test:catalog` + `test:tui` + `test`；**降级落盘必须覆盖 `try` 与 `catch` 两条路径**（预算耗尽走 `catch`）；门限判定语义变动须声明为有意偏差；工具名 / schema / 提示文本不要改。**有意偏差（声明）**：① `mermaidRequiredFor` 语义已收紧为「要求架构图（flowchart）≥1」——架构图属于 flowchart 语法，序列图 / 状态图不能替代（minimal panorama 提示词已写死 `flowchart TB`，此处对齐）；② 图表校验 / 计数按**三类语法**（flowchart / sequence / state）做，选型按**四类语义**教（见 `diagram-guide`）；③ 题注（`**图｜<类型词>｜<标题>**`）只在 `write_page` 生成期强制，**verify-wiki 不查题注**（旧页面无题注，回溯会报新 FAIL）；④ `mermaidBlocks` 保留为**全部 mermaid 围栏数**（含 erDiagram / gantt / pie 等四类之外的图种），因此 `mermaidBlocks >= flowchartBlocks + sequenceBlocks + stateBlocks`——不重定义为三者之和，是为了不改变旧密度门对四类之外图种的计数（旧调用方不破）；⑤ `SEQ_LABEL_QUOTES` 是**可移植性守卫**而非 mermaid 12 的解析必需（实测 mermaid 12 能渲染未加引号的 `网关(入口)`；拦截它是因产物会被 GitHub / GitLab / Notion 内置的可能更旧的 mermaid 渲染），规则文案须按此口径维护 |
| 交付闸门（`wiki/verify-wiki.ts`、`commands/verify.ts`、`verifyAfterGenerate`） | `typecheck` + `test:verify` + `test`；**`verify-wiki.ts` 只读不写产物**；`RunMeta` 不得改；`verifyAfterGenerate` 缺省 false |
| 溯源台账（`wiki/traceability.ts`、verify-wiki 检查组） | `typecheck` + `test:traceability` + `test:verify` + `test`；**只读不写产物**；符号层保持 WARN，蓝图 `associatedFiles` 是 FAIL |
| 页面格式资产 / reader-first / 文风纪律 / 图表纪律（`prompts/page-format.*.md`、`prompts/reader-first.*.md`、`prompts/humanizer.*.md`、`prompts/diagram-guide.*.md`、`agents/{page-format,reader-first,style-discipline,diagram-guide}.ts`、`wiki/polish.ts`） | `typecheck` + `test:page-format` + `test:mermaid` + `test:pages` + `mock:wiki` + `test`；**zh / en 两份资产必须同步改动，条数与编号一一对应**；反注水三条（同义改写注水 / 不复制 README·AGENTS.md /「源里没有就应该是 0」）必须在双语都存在；改资产后 `mock:wiki` 须 `overall=PASS`；纪律文件保持 60~80 行 + 头部来源注释；图表选型纪律只在 `diagram-guide` 一处规定（page-format 只留格式契约 + 指向指针），避免两处规定打架 |
| 一致性校验 / 黄金值对照（`tools/golden-parity-gen.py`、`packages/orchestrator/test/golden-parity.ts`、`content-gate.ts` 的 `countCjkChars` / `numbersIn`） | `python3 tools/golden-parity-gen.py` 重新生成 + `typecheck` + `test:golden-parity` + `test`；样本变动必须**两边同步**（Python 脚本与 TS 测试逐字一致）并重新生成黄金值；判定语义变动须声明为有意偏差；带 `g` 标志的正则不得用于逐元素 `test()`（`lastIndex` 状态会跳过元素）。黄金值已硬编码在 `golden-parity.ts`，只有样本 / 判定语义变动时才需重跑生成器（生成器导入本机的 `lecture-to-notes` 仓库，路径硬编码在脚本头）；`test:golden-parity` **不在** `bun run test` 聚合内，按需单跑 |
| 重试策略（`agent-runtime/src/retry.ts`、`harness/driver.ts`、`create-agent.ts`） | `typecheck` + `test:agent` + `test:agent:http` + `test`；`RetryConfig` 形状改动同步 §4 |
| 多档共存 / 浏览（`utils/output/wiki-content.ts`、`browse-server.ts`、`apps/browse/src/**`） | `typecheck` + `test:blueprint` + `test:browse` + `test:tui` + `test`（前端另跑 `browse:build`）；**组件行为改动必须补 `test:components`（测试先行）** |
| 轨迹视图 / 会话投影（`packages/trajectory/**`、`trajectory-store/**`、捕获点、`/api/runs*`） | `typecheck` + `test:trajectory` + `test:browse` + `mock:wiki` + `test`；`packages/trajectory/src/session.ts` 必须**无 node 依赖**（被 Vite 打包）；捕获层改动跑 `mock:wiki` 核对「会话文件数 = `agent_config` 数」；新增事件 kind 不得是内容类 |
| 文件锁 / 日志 / 版本守卫 / 全局记忆（`lockfile.ts`、`logger/**`、`version-guard.ts`、`history/**`） | `typecheck` + 对应 `test:lock` / `test:logger` / `test:version-guard` / `test:history` + `test`；新增写入点必须包 `withFileLock*`；logger 渲染 / 哈希须与 cordis 逐字一致 |
| 外部工具（`packages/utils/src/tools/**`） | `typecheck` + `test:installer` + `test`；新增工具加一条 `ToolSpec`（资产名需对过真实 release 列表） |
| pi vendor 源码（`vendor/pi/**/src`） | `vendor:src` → 改 → `vendor:dist` → `vendor:build` → `test`；**不要手改 `dist/`**（见 §7） |
| 文档（`*.md`） | 至少 `typecheck`；若描述了命令需实际执行一遍；命令示例必须跨平台可复制 |

## 4. 契约冻结点（破坏即需同步改业务层）

- `createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt, tools, maxTurns, budget, thinkingLevel, compaction, finalization, hooks, retryConfig, includePartialMessages })` → `{ query(prompt): AsyncGenerator<SDKMessage>, close(), abort() }`
- `createProvider(providerIdOrApiType, { apiKey, baseURL })` → `{ apiType, createMessage({ model, maxTokens, system, messages }) }`
- `SDKMessage` 联合类型与 `CatalogEvent` 时序（`requesting → responding → tool_start → tool_result → complete`）
- 工具名：`read` / `write` / `edit` / `find` / `grep` / `ls` / `write_page` / `generate_blueprint`（提示词与测试依赖名字，不得改名）
- `TokenUsage` 字段名；归并只用 `emptyTokenUsage / addTokenUsage / sumTokenUsage`（`packages/agent-runtime/src/usage.ts`）
- `result.subtype` 含 `error_context_full`（上下文将满）与 `error_budget_exhausted`（预算耗尽强制交卷后仍无产物）
- `RetryConfig`：Agent 层指数退避 2s→60s + Provider 层 `streamOptions.maxRetries / maxRetryDelayMs`（读服务端 `Retry-After`）；`maxRetries=0` **显式禁用**
- `BlueprintResult.durationMs / tokenUsage / pagesCount / sectionsCount? / failedSections?`
- 蓝图输出工具：`submit_sections` / `submit_section_topics` / `refine_section_titles`（`generate_blueprint` / `generate_sync_blueprint` 仅归档）
- `WikiOutput.sections?`（旧 wiki.json 无字段时从 pages 推导）；路径口径 `getWikiDir(detail?)` / `getWikiJsonPath(detail?)` / `listWikiVariants()`
- 新增字段一律为**可选**，并保证旧配置 / 旧 wiki.json / 旧日志可读（运行时自动迁移 / 回退）

## 5. Git 工作流（强制：手动合并 + 版本号）

**铁律**：`master` 只接受合并，不接受直接提交；每次改动新建分支；只有验证全绿才提请合并；**合并由用户手动执行**（AI 不得自行 `checkout master` / `merge`）；禁止 `git push --force`、`git commit --no-verify`、`git reset --hard` 丢弃他人改动；禁止提交 `node_modules/` / `dist/` / `.zread-pi/`。

**分支流程**：建分支（`<type>/<scope>-<简述>`，type ∈ feat | fix | docs | refactor | test | chore）→ 小步提交 → 按 §3 验证 → 版本升级（独立提交）→ `git log master..HEAD --oneline` 复核 → 提请用户 `git merge --no-ff` → 用户在 master 复验后删分支。验证不通过就在当前分支追加提交，不要合并。

**commit 规范**：`<type>(<scope>): <简述>`，正文用中文分点说明**改了什么、为什么、验证了什么**。

**版本号**（唯一来源：根 `package.json`；子包均 `private: true`）：新增功能 → 次版本 +1、修复归 0；修 bug → 修复版本 +1；文档 / 重构 / 测试 / 依赖 → 修复版本 +1；**主版本由用户定义**。只增不减，禁止回退或复用。多分支冲突时以先合并的版本为基线重新计算，不改写历史。

**Tag / Release**（用户手动）：tag 名 `v<主>.<次>.<修>`，只打在 master，注释 tag 消息 `vX.Y.Z —— <一句话摘要>`；发布说明落 `.github/release-notes/<tag>.md`，**必须先于或与 tag 同批入库**（CI 读取它作 Release 正文，无文件时回落到自动变更列表）。AI 不得自行 `git tag` / `git push`。

## 6. 完成定义

- [ ] 改动范围与需求一致，没有顺手改无关文件
- [ ] 没有破坏 §4 契约冻结点（若必须改，业务层同步修改 + 本文件更新）
- [ ] `bun run typecheck` 0 错误
- [ ] 与改动类型匹配的测试全绿（§3），且输出被真实记录
- [ ] 新增 / 变更的行为有对应断言
- [ ] 文档同步：`README.md`（命令 / 用法）、本文件（规则 / 契约）
- [ ] 跨平台检查（见 §7）
- [ ] 版本号已升级并写明"当前版本 → 目标版本"与依据
- [ ] 发布说明已随分支提交，tag 摘要已建议
- [ ] 分支已提请用户手动合并，合并命令已交付
- [ ] 工作区干净：`git status --short` 为空

## 7. 已知约束（踩过，别重踩）

**vendor 是「源码 + 产物」双模式**：`vendor/pi/**/dist` 被 gitignore，全新 clone 后必须 `bun run vendor:build`（顺序 telemetry → chord → ai → agent → tui）。改 pi 源码走 `vendor:src` → 改 `src/` → `vendor:dist` → `vendor:build`。**不要手改 `dist/`**。本仓库对 vendor 源码的唯一改动在 `agent` 包的 `harness/env/nodejs.ts`（并发会话的 ENOENT 竞态，带 `// zread-pi:` 注释），改完必须重跑 `vendor:build` + `test:agent`（`session-persist.ts` 守卫）。打包后的 CLI 必须保留 `registerBunOAuthFlows()`（OAuth 动态 import 无法静态解析，否则登录时报找不到模块）。

**业务工具 schema**：`ToolDefinition.inputSchema` 原样传给 pi 的 `AgentTool.parameters`（JSON Schema 当 TypeBox 用，已验证），不要引入 TypeBox DSL。

**RepoAnalyzer 依赖 cwd**：`parseFiles()` / `scanFiles()` 以 `process.cwd()` 为根，调用前必须 `process.chdir(目标仓库)`；首次解析某语言会下载 WASM 到 `~/.zread-pi/parsers`。

**Wiki 产物不入库**：`.zread-pi/wiki/**` 已被 `.gitignore` 覆盖，跑完测试无需提交。

**配置与凭据**：非敏感配置在 `~/.zread-pi/config.yaml`，秘密在 `auth.json`（pi-ai 格式，`Models.login()` 写入，可多 Provider）。`ZREAD_PI_HOME` 覆盖家目录（路径只在 `project-home.ts` 定义）。`config.yaml` / `auth.json` / `tools-state.json` / `history` 的读-改-写都经 `lockfile.ts` 跨进程锁 + config 临时文件 rename 原子替换，锁失败报错不静默降级。未登记的 providerId 回退 OpenAI 兼容协议（有意的健壮性增强）。

**未完成事项（不要当成已完成）**：① 尚未用真实 API Key 跑过完整 wiki 生成（全部验证基于 faux / mock / 内置目录）；② OAuth 真机授权流程未验证（登录界面已移除，配置界面只留 API Key）；③ CLI 真机交互（IME 定位 / Windows 下 Shift+Enter / 剪贴板）仅做了自动化回归；④ MCP / Skill / shell 执行工具未迁移（工具文案一律不引用 shell；引入 shell 能力前先定方案）；⑤ 会话已 durable 但「中断续跑」未接线（driver 只 `create` 不 `open`）；⑥ rg / fd 不会在运行期自动下载（有意为之，安装走 `/config/tools` 或 `bun run tools:install`）；⑦ 浏览站轨迹页运行中无 partial 流式预览（方案 C 取舍，TUI 生成页进度不受影响）。

**跨平台约束**：路径走 `node:path` 或 POSIX 正斜杠，落盘 / 比较前归一化；家目录用 `os.homedir()`，临时目录用 `os.tmpdir()` + `fs.mkdtemp`；源码统一 LF（UTF-8 无 BOM）；Linux 大小写敏感，import 路径须与磁盘一致；平台特定 API（TUI / ProcessTerminal / 符号链接 / 可执行位）须处理 `process.platform` 分支并在至少一个非主力平台跑过对应测试；不引入仅单平台可用的依赖。

## 8. 后续方向

1. 压缩阈值（`reserveTokens` / `keepRecentTokens`）与 `agent.token_budget` 一起暴露到配置界面。
2. 用 pi 的 usage ledger + 真实 `Model.cost` 替代成本估算。
3. 聊天 / 会话接 pi 的 `JsonlStorage` 会话树；「中断续跑」接线（见 §7 ⑤）。
4. 子代理 / 权限弹窗 / 计划模式走 pi 扩展 API（`registerTool` / `tool_call` 事件阻断）。
5. 工具层补强（未决）：`Grep` 的 `type` 参数、shell 执行能力（先定方案再实现）。
6. 重试旋钮拆分（`concurrency.max_retries` 目前同时下发两层，最坏 `N(N+1)` 次请求）。
