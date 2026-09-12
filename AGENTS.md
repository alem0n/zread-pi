# AGENTS.md — zread-pi 上下文与开发规则

本文件是 AI 代理与人类开发者在本仓库工作的**唯一入口约定**：先读这里，再动手。
与 `README.md`（怎么用）、`MIGRATION.md`（为什么这样迁移）配合使用；三者冲突时以本文件为准。

> **总则：跨平台优先。** 本仓库必须在 Windows、Linux、macOS 三类平台上等价可用。
> 任何新增或修改的内容——代码、脚本、命令、文档示例、路径约定——都必须考虑跨平台使用性（详见 §6.8）：
> 不假设 POSIX Shell 独占（`&&`/引号/通配符写法需在 Git Bash 与 POSIX sh 下都成立）、
> 不硬编码平台特定路径分隔符或家目录、不引入仅单平台可用的依赖。

---

## 1. 这个仓库是什么

**zread-pi 的业务层运行在 pi 的 agent 内核之上。**
原来的 `packages/agent-sdk`（自研 QueryEngine、API 级重试、整文件会话）被 `packages/agent-runtime` 适配层取代，
内部改由 `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` 驱动，**对外契约不变，业务逻辑零改动**。

```
apps/cli            pi-tui 全屏 TUI（不再依赖 Ink/React；布局与快捷键与迁移前一致）
apps/browse         React 19 + Vite 预览站（保留；依赖随根 bun install，见 §6.3）
packages/
  agent-runtime     ★ 适配层：createAgent / createProvider / 5 个文件工具 / SDKMessage 等类型
                    + pi/provider-catalog（pi-ai 内置 Provider 目录 / 登录 / 自定义模型）
                    + pi/auth-store（~/.zread-pi/auth.json 凭据）/ pi/models-store（模型目录缓存）
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
| 5 个文件工具**原样复制**而非改用 pi 内置工具 | 保持工具名/schema/提示文本不变，避免 LLM 行为漂移（**已由 §1.3 的工具层重写取代，工具名仍不变**） |
| 工具层按上游 pi 重写，新增 `Ls` | 旧工具是从 `agent-sdk` 原样拷来的糙版：`Glob` 依赖 Node 实验 API 且有 `spawn('bash')` 兜底（Windows 上等于不可用）、`Grep` 全量缓冲且 rg/grep 两分支输出不一致、`Read` 的图片只回一句字节数、`Edit` 在 CRLF 检出上必然匹配失败、`Write`/`Edit` 无同文件串行化（并行页面生成会丢更新）。现按上游实现重写，补齐 `Ls`（旧 `Read` 对目录的提示点名 `Bash`，而本仓库没有 Bash 工具），详见 §1.3 |
| rg / fd：**探测常驻、安装显式** | 上游会在工具缺失时静默联网下载并解包（tar/zip + chmod + Windows `tar.exe`/PowerShell 分支）。本仓库拆成两件事：① agent 运行期只探测（缺失时退回纯 JS 兜底，见 `file-walk.ts`），绝不隐式联网；② 安装只在用户显式动作（配置界面 `/config/tools` 或 `bun run tools:install`）时发生，解包用**纯 JS**（`zlib` + 自写 tar/zip 解析），不依赖 tar/unzip/PowerShell。 |
| 外部工具配置只存「是否启用」 | `config.yaml` 只记用户意图（`tools.<id>.enabled`）；「装没装 / 装在哪 / 什么版本」属于运行时探测到的事实（托管目录 `~/.zread-pi/bin` 与系统 PATH），不落配置，避免配置与实际文件系统状态不一致 |
| 工具结果新增可选 `details` 与图片内容块 | 截断信息 / diff / 命中上限需要结构化回传（不进模型上下文）；图片按 magic number 判型后以 image 块回传（仅当 `model.input` 含 `image`）。均为**新增可选字段**，旧调用点零改动 |
| 配置界面改用 pi-ai 的 Provider/登录/模型目录 | 不再自维护 provider registry；API Key 统一走 `Models.login('api_key')`，凭据落 `~/.zread-pi/auth.json`，天然支持多 Provider；Provider 详情页把 API Key 与模型选择并列在同一页面（不再有 OAuth 订阅选项）；自定义模型按 pi models.json 合并语义叠加 |
| 思考深度（thinking level）直接沿用 pi 的 7 档 | 配置界面新增 `/config/thinking`（`llm.thinking_level`，默认 off）；受支持等级由 pi-ai `getSupportedThinkingLevels` 计算，模型不支持时分界清楚标注、请求时由 pi 自动 clamp；运行时 `createAgent({ thinkingLevel })` 透传为 `options.reasoning` |
| 最大轮次进配置（不再硬编码） | 配置界面新增 `/config/max-turns`（`agent.max_turns`，0-100，默认 30；0 = 不限制轮次）；Orchestrator 的 `create-agent.ts` 读配置下发，`generate-wiki` 不再写死 `maxTurns: 30` |
| 轮次收尾：提示 + 宽限轮 | 倒数第 1 轮向模型注入收尾提示（steering user 消息，按文档语言点名输出工具 `write_page` / `generate_blueprint`），超限后允许 1 轮宽限（`finalization.graceTurns`，0=旧行为）；上下文将满时不给宽限，仍不收敛才 `error_max_turns`；`max_turns=0` = 不限制轮次（不发提示、不因轮次停止） |
| 上下文压缩用 pi 的 `transformContext` + `compaction` | 每次请求前按 `model.contextWindow - reserveTokens` 判定，超限时调用 pi 的 `prepareCompaction` / `compact` 生成摘要（发出 `system/compact_boundary`），用「摘要 + 保留的近期消息」继续；`shouldStopAfterTurn` 在压缩无法腾出空间时优雅停止（`error_context_full`），不让 provider 报上下文溢出 |
| 凭据不进 `config.yaml` | 用户配置（provider/model/base_url/自定义模型）在 `config.yaml`， 秘密（API Key / OAuth token）在 `auth.json`；旧扁平字段首次切换时自动迁移后清空 |
| 项目家目录只在一处定义 + 新增全局记忆 `history` | 家目录（`~/.zread-pi`）此前散落在 utils / agent-runtime / repo-analyzer 多处 `homedir()` 拼接中，现在统一到 `packages/utils/src/project-home.ts`（`ZREAD_PI_HOME` 可覆盖，测试隔离用）。开始生成文档（蓝图 / 页面两个入口）时把项目绝对路径写入 `<家目录>/history`：ZRH1 二进制（追加 O(1) / 顺序遍历 O(n) / 墓碑随机删除 O(1)，按需 compact，上限 1000 条）；`zread-pi history` 并发检查各项目 `.zread-pi` 是否还在，删除失效记录后展示剩余；重复生成同一项目去重只留最近一条。另：打开（默认 wiki / config / browse 均适用）已有完整文档的目录时，若路径不在名单则自动补录（`ensureProjectRecorded`，已在名单不刷位置不重复） |
| pi 以 vendor 源码 + dist 产物方式消费 | 可锁定版本、可局部调试，同时类型检查走 `.d.ts` 保持快 |
| 浏览文档：服务端返回的 URL 必须真实可访问 | 有构建产物（打包 `dist/browse` / 源码 `apps/browse/dist`）时 API + 静态资源同端口（SPA fallback）；源码运行且未构建时进程内启动 Vite dev server（`/api` 代理到 API 端口）。不再依赖用户另起 `browse:dev`，也不再返回没人监听的 5173；启动失败在 TUI 显示原因（`ZREAD_PI_BROWSE_DIST` / `ZREAD_PI_BROWSE_NO_OPEN` 供自定义与测试） |
| `apps/browse` 并入根 workspaces | 历史隔离原因（React 18/19 混装）随 CLI 换成 pi-tui 消失；并入后根 `bun install` 即装齐 Vite/React，源码运行「浏览文档」直接走进程内 Vite 兜底，不再依赖手动 `browse:install`（漏跑会以「未找到前端资源」启动失败，见 §6.3） |

### 1.2 契约冻结点（破坏即需同步改业务层）

```ts
createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt,
              tools, maxTurns, thinkingLevel, compaction, finalization, hooks, retryConfig, includePartialMessages })
  -> { query(prompt): AsyncGenerator<SDKMessage>, close(), abort() }

createProvider(providerIdOrApiType, { apiKey, baseURL })
  -> { apiType, createMessage({ model, maxTokens, system, messages }) }
```

- `SDKMessage` 联合类型与 `CatalogEvent` 时序（`requesting → responding → tool_start → tool_result → complete`）；`result.subtype` 新增 `error_context_full`（上下文将满时优雅停止）
- `TokenUsage` 字段名、`BlueprintResult.durationMs / tokenUsage`
- 工具名：`Read` / `Write` / `Edit` / `Glob` / `Grep` / `write_page` / `generate_blueprint`（提示词里写死了）；`Ls` 为新增工具名（见 §1.3）
- 工具结果新增**可选**字段（不破坏旧调用方）：`ToolResult.details` / `SDKToolResultMessage.result.details`（截断、diff、命中上限等元信息，不进入模型上下文）、`ToolResult.content` 允许内容块数组（图片回传）、`ToolContext.supportsImages`
- `AppConfig.llm` 的旧扁平字段（`provider/model/api_key/base_url`）仍可读；新增 `providers` 映射（`LlmProviderConfig`）与 `CustomModelConfig`；新增 `agent.max_turns`（旧配置缺省 30；`0` = 不限制轮次）。旧配置必须能直接启动（运行时自动迁移/回退）

---

## 1.3 工具层（第六步：对齐上游 pi）

落点：`packages/agent-runtime/src/tools/`（共享设施 + 5 个工具 + 新增 `Ls`）。

| 工具 | 状态 | 要点 |
| --- | --- | --- |
| `Ls` | **新增** | 目录列举：大小写不敏感排序、目录补 `/`、含 dotfile、条目/字节双上限；`Read` 的目录报错已改为点名 `Ls` |
| `Glob` | 替换 | 系统 `fd` 优先，无 fd 时纯 JS 遍历兜底；输出**相对搜索根的 POSIX 路径**并按字典序排序；尊重 `.gitignore`/`.ignore`/`.fdignore`（非 git 仓库内也生效）；跳过 `.git`/`node_modules`/`.zread-pi`；`limit` 可调 |
| `Grep` | 替换 | rg `--json` **流式**解析 + 命中上限立刻 kill；无 rg 时纯 JS 兜底（同输出格式）；新增 `ignoreCase`/`literal`/`context`/`limit`；长行截断 500 字符；保留 `output_mode`（content / files_with_matches / count） |
| `Read` | 替换 | 图片按 **magic number** 判型，模型支持图片时回传 image 块（否则文本说明）；`offset` 1-based；2000 行 / 50KB 双上限 + `Use offset=N to continue.`；目录报错点名 `Ls`；非图片二进制不灌乱码 |
| `Write` | 替换 | 同文件并发写串行化（`withFileMutationQueue`）；`details.created` 标记新建/覆盖；参数 `file_path`/`content` 不变 |
| `Edit` | 替换 | BOM/CRLF 归一化 + fuzzy 兜底；支持 `edits[]` 多段不相邻替换；`replace_all` 保留；回传 diff / patch / 首行变更行号；同文件并发编辑串行化；`file_path`/`old_string`/`new_string` 仍可用（并接受上游 `path`/`edits`/`oldText`/`newText`） |
| 输出截断 | 复用 | 直接用 vendor `@earendil-works/pi-agent-core` 已导出的 `truncateHead`/`truncateLine`/`formatSize` 等纯函数（`tools/truncate.ts` 薄封装 + 统一提示文案） |

约束：**不得重命名工具**（提示词与测试依赖名字）；新增/改行为必须补 `bun run test:tools` 断言；
移植上游实现时**逐条保留平台适配分支**（Windows 路径分隔符、macOS 文件名变体、gitignore 语义）。
移植自 `vendor/pi` 或上游 `pi/packages/**` 的文件必须在文件头注明来源（走「复制 + 改写」，不改 vendor）。

### 1.4 外部工具安装与配置界面（第七步：rg / fd）

| 位置 | 内容 |
| --- | --- |
| `packages/utils/src/tools/registry.ts` | **工具注册表（扩展点）**：新增工具只需加一条 `ToolSpec`（id / 仓库 / 资产名规则 / 版本探测参数组 / 用途），配置界面、安装器、状态探测、`tools:install` 全部自动跟上 |
| `packages/utils/src/tools/installer.ts` | 状态探测（`resolveToolBinary` / `getToolStatus`）、安装（解析版本 → 下载 → 校验指纹 → 解包 → 落盘 → **可执行性校验**，全程进度回调）、卸载、安装台账、变更广播（`onToolsChanged`） |
| `packages/utils/src/tools/archive.ts` | 纯 JS 解包（`.tar.gz` / `.zip`），带 zip-slip 防护（拒绝绝对路径 / `..` 越界） |
| `packages/types` 的 `ToolConfig`/`ToolsConfig` | `config.yaml` 的 `tools.<id>.enabled`（旧配置缺省 `true`，无需迁移） |
| CLI `/config/tools` | 列表页（总体就绪进度条 + 每个工具状态）+ 详情页（状态/版本/路径/用途、Enter 安装、d 卸载、t 启用/停用、**安装进度条**：百分比 + 字节数 + 阶段）；列表与详情均为注册表驱动 |
| CLI `bun run tools:install` | 无头入口：列状态 / 安装（可指定版本）/ 卸载；与配置界面走同一份实现 |
| 环境变量 | `ZREAD_PI_TOOLS_DIR`（托管目录，默认 `~/.zread-pi/bin`）、`ZREAD_PI_TOOLS_BASE_URL`（下载镜像，目录结构需与 GitHub Releases 一致）、`ZREAD_PI_<ID>_PATH`（显式指定二进制，测试用） |
| 供应链 | 只从固定仓库 HTTPS 下载；ripgrep 发布 `<asset>.sha256` 时先校验指纹再解包（fd 不发布，工具中不引入自签名的伪验证）；安装后必须能执行才算成功，否则删除半成品并报错 |

**可用性 ≠ 版本识别（硬约束）**：后续接入的工具可能没有 `--version`（或把版本写到 stderr、退出码非 0、版本格式不是 x.y.z）。因此：

- 工具是否可用**只看进程能否启动**（`BinaryProbeResult.runnable`），解析不出版本号**绝不**降级为「未安装」；
  同理，**输出过大（ENOBUFS）/ 超时也不算不可用**（除 ENOENT/EACCES/ENOEXEC 等启动类错误外都算已启动）；
- 版本探测按多组参数依次尝试（缺省 `[['--version'], ['-V'], ['version']]`，可由 `ToolSpec.versionProbeArgs` 覆盖），
  且在**专用空目录** + 短超时 + 关闭 stdin 下执行（避免把「版本参数」当模式/路径参数的工具去扫用户仓库）；
- 「当初装的是哪个版本」由**安装台账**（`~/.zread-pi/tools-state.json`）记录，不依赖探测结果；
  探测版本与台账不一致时只在 UI 提示（`versionMismatch`），不影响使用；二进制被手动删除后台账作废（状态回 `missing`）；
- UI 对「版本未知」的文案是「未识别（不影响使用）」，有台账时展示台账版本（如 `15.2.0 · 未识别`）。

---

## 2. 环境与命令

要求：Bun ≥ 1.3（验证用 1.3.14）、Node ≥ 22（pi 内核要求）、Python 3.x（仅夹具用）。
以上依赖在 Windows / Linux / macOS 上均可安装；命令统一经由 `bun run`（跨平台脚本入口）执行，
Windows 下推荐在 Git Bash 或 WSL 中操作（PowerShell/CMD 亦可跑 `bun run *`，但不要依赖 CMD 内建语法）。

```bash
bun install                # 安装依赖
bun run vendor:build       # 构建 pi 内核产物（全新 clone 后必须执行一次）
bun run typecheck          # tsc --noEmit（apps/cli/src + apps/cli/test + packages/*/src）
bun run test               # typecheck + 12 个测试套件（离线，无需 API Key）
bun run test:tui           # CLI(pi-tui) 专项：布局/快捷键 + 真实终端启动 + 目标目录参数 + mock LLM 生成/同步
bun run mock:wiki          # 用 mock LLM 对 fixtures/hello-python 跑全链路
bun run browse:build       # 预览站静态产物（打包 CLI / 免 Vite 预览；依赖随根 bun install）
bun run cli                # 真机 CLI（需 ~/.zread-pi/config.yaml）
bun run cli --dir <repo>   # 真机 CLI，-d/--dir 指定目标目录（缺省=当前目录）
bun run cli history        # 查看全局记忆：清理已失效项目并列出剩余（-c 指定并发，默认 8）
```

| 命令 | 覆盖内容 | 期望 |
| --- | --- | --- |
| `test:catalog` | pi-ai Provider 目录、api_key 登录写 auth.json、多 Provider、自定义模型、未内置 Provider、runtime model、思考深度支持列表、旧配置补 `agent.max_turns` 默认值（`0` 保留为不限制、负数回退 30）、logout | 34/34 |
| `test:agent` | pi 循环、工具执行、钩子、流式事件、429 重试、usage、thinkingLevel 透传、maxTurns | 11/11 |
| `test:tools` | 工具层专项：截断设施、glob 语义（与 fd `--glob` 对齐）、`Ls`/`Glob`/`Grep`/`Read`/`Write`/`Edit` 行为与错误文案、**rg/fd 与纯 JS 兜底两条路径结果一致**（含 .gitignore 行为）、同文件 16 路并发编辑不丢更新、`details` 与 image 块穿过桥接层进入模型上下文、外部工具启用开关→二进制解析联动 | 95/95 |
| `test:installer` | 外部工具：注册表与资产名（已对真实 release 列表）、归档解包（tar.gz/zip、stored+deflate、GNU LongName、zip-slip 防护）、配置归一化、安装全流程（本地 mock Releases + 注入探测，含进度阶段 / 百分比单调 / 指纹不匹配拒绝解包 / 校验失败清理）、卸载与启用开关 | 70/70 |
| `test:history` | 全局记忆：ZRH1 二进制结构（头部 / 追加 / 顺序遍历 / 偏移稳定 / 墓碑随机删除 / 去重移到末尾 / 压缩 / maxRecords 淘汰 / 半截尾部修复 / 损坏自愈 / UTF-8 与超长路径）、`ZREAD_PI_HOME` 唯一定义点、`pruneHistory` 并发检查 `.zread-pi` 并删除失效记录、`ensureProjectRecorded` 仅缺录不刷位置、`mapWithConcurrency` 保序；`zread-pi history` 命令（空记忆 / 清理 / 幂等 / `-c` / 损坏文件 / 帮助）；老旧项目自动登记（完整文档补录 / 已在名单不挪位 / 不完整不登记 / `--dir` 登记目标目录） | 61 + 24 + 10 |
| `test:context` | 上下文压缩：`transformContext` + pi `prepareCompaction`/`compact`、`system/compact_boundary`、压缩后继续、压缩无法腾出空间/关闭压缩时 `error_context_full`、`maxTurns` 收尾提示 + 宽限轮（最后一轮/宽限轮输出 → success，不收敛 → `error_max_turns`，`graceTurns=0` = 旧行为，`maxTurns=0` = 不限制轮次） | 39/39 |
| `test:agent:http` | 真实 HTTP/SSE：baseURL + apiKey 注入、增量 tool_call 解析 | 7/7 |
| `test:provider` | `createProvider().createMessage()`（browse-chat 路径） | 5/5 |
| `test:analyzer` | RepoAnalyzer 扫描 + Tree-sitter 解析 | 5/5 |
| `test:blueprint` | Orchestrator 端到端：`generateWikiCatalog()` 落盘 `wiki.json`；模型不产出蓝图时必须报错（不再假装目录完成） | 7/7 |
| `test:pages` | 并行页面生成：`generateWikiContent()` + `write_page` + Mermaid 校验；页面未落盘（未调用 `write_page` / 写入路径不符 / Mermaid 拦截）必须记失败并发出 `page_error` | 8/8 |
| `test:browse` | 「浏览文档」服务器 + pi-tui 浏览页：静态资源/API 同端口、SPA fallback、未知 API 404、`close()` 后可连性；页面显示真实地址、ESC 停止；源码无产物时进程内 Vite 兜底；无效资源目录报错 | 28/28（有 `apps/browse/dist` 时兜底 4 项自动跳过） |
| `test:tui` | `smoke-tui.ts`（布局/按键/输入框/长列表分页/终端自适应/按键重绘与 Kitty 松开过滤/Provider 详情页 API Key+模型焦点切换/多 Provider/自定义模型/思考深度页/最大轮次页（含 `0` = 不限制写回与落盘）/外部工具页/版本号与项目版本同步 187 项）、`render-all-routes.ts`（全部 19 个路由渲染不报错、无超宽行）、`real-run-check.ts`（真实 ProcessTerminal 启动/退出 9 项）、`cli-target-dir.ts`（`-d/--dir`：绝对/相对路径、`wiki --dir` 写法、产物落盘到目标目录、调用目录不被写入、缺省行为、无效目录报错 25 项）、`mock-generate.ts`（生成 + 同步全链路 + 全局记忆写入断言 21 项）、`browse-server.ts`（浏览文档服务 + 页面，24~28 项：有 `apps/browse/dist` 时兜底 4 项自动跳过） | 187 + 21 + 9 + 25 + 19 + 24 |
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
| 适配层 `packages/agent-runtime/**` | `bun run test`（全部套件）+ 新增/更新针对性断言 | 契约面改动必须同步 `MIGRATION.md` §3/§4 |
| 工具层 `packages/agent-runtime/src/tools/**` | `bun run typecheck` + `bun run test:tools` + `bun run test` | 新增/改工具行为必须补 `test:tools` 断言；工具改名会破坏提示词，**不要改** |
| 外部工具层 `packages/utils/src/tools/**`（注册表 / 安装器 / 归档） | `bun run typecheck` + `bun run test:installer` + `bun run test` | 新增工具只需加一条 `ToolSpec` 并补 `test:installer` 断言（含资产名，需对过真实 release 列表） |
| 项目家目录 / 全局记忆（`packages/utils/src/project-home.ts`、`packages/utils/src/history/**`、CLI `history` 命令） | `bun run typecheck` + `bun run test:history` + `bun run test` | 目录名 / 位置改动只改 `project-home.ts`；history 二进制布局变更必须升 `HISTORY_VERSION` 并补断言与读取兼容（当前只支持 v1） |
| pi vendor 源码（`vendor/pi/**/src`） | `vendor:src` → 改 → `vendor:dist` → `vendor:build` → `bun run test` | 见 §6.1；**不要手改 `dist/`** |
| 依赖变更 | `bun install` 后一并提交 `bun.lock`，并在 commit body 说明原因 | 不要把 `node_modules` 带进仓库 |
| 文档（`*.md`） | 至少 `bun run typecheck` | 若文档描述了命令，需实际执行一遍确认命令可用；命令示例必须跨平台可复制（见 §6.8） |
| 新增脚本 / 夹具 | 登记到根 `package.json` 的 `scripts`，并在 `README.md` 写明用途 | `tools/` 脚本用相对路径 import 工作区源码；`scripts` 一律用 `bun run xxx.ts` 形式，不写 `rm -rf` / `&&` 链等仅 POSIX 可用的 shell 逻辑（见 §6.8） |

---

## 4. Git 工作流（强制：手动合并 + 版本号管理）

### 4.0 铁律

1. **`master` 只接受合并，不接受直接提交。**
2. **每次改动都必须新建分支**，完成后走"验证 → 提请用户手动合并 → 用户合并后在 master 复验 → 删除分支"。
3. 只有**验证完全通过**（§2 对应命令全绿）才允许提请合并。
4. **合并 `master` 一律由用户手动执行**：AI 不得自行执行 `git checkout master` / `git merge`，只能把分支、验证结果、版本升级建议与合并命令准备好，交用户执行。
5. **每次合并都要按 §4.4 处理版本号**（主版本由用户定义），版本升级随分支提交。
6. 禁止：`git push --force`、`git commit --no-verify`、`git reset --hard` 丢弃他人改动。
7. 禁止提交生成物：`node_modules/`、`dist/`、`.zread-pi/`、`__pycache__/`（已在 `.gitignore`）。

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

# 4) 分支上完成版本升级（§4.4），建议独立提交
git add package.json && git commit -m "chore(version): 0.1.0 -> 0.2.0（新增 xxx 能力）"

# 5) 交付前复核：只包含预期改动
git log master..HEAD --oneline     # 提交清单
git diff master --stat             # 改动范围

# 6) 提请用户手动合并（AI 到此为止，不得自行 checkout / merge）
#    交付给用户的信息：分支名 / 验证结果 / 当前版本 → 目标版本 / 升级依据
#    用户在 master 上手动执行（保留分支脉络，不使用 fast-forward）：
#      git checkout master
#      git merge --no-ff docs/agents-md -m "merge: 补充 AGENTS.md 手动合并与版本号规则"
#      bun run test                 # 合并后复验（防止合并引入偏差）
#      git branch -d docs/agents-md # 复验通过后清理分支
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
| 用户未合并 / 打回 | 分支保留，继续修或补充说明后再次提请；不得自行合并 |
| 版本号冲突（多分支并行） | 以已合并进 master 的版本为基线重新计算，追加一次 `chore(version)` 提交，禁止改写历史 |

### 4.4 版本号管理

**格式：`主版本.次版本.修复版本`**（三段均为非负整数，如 `1.4.2`）。
唯一来源是根 `package.json` 的 `version` 字段（当前 `0.1.0`）；子包均为 `private: true`，不单独发版。

| 触发 | 版本变化 | 说明 |
| --- | --- | --- |
| 新增功能 / 能力 | 次版本 +1，修复版本归 0 | `feat/*` 分支默认按此处理 |
| 修复 bug | 修复版本 +1 | `fix/*` 分支默认按此处理 |
| 文档 / 重构 / 测试 / 依赖等无行为变化 | 修复版本 +1 | 避免版本停滞；用户明确要求时可不动版本 |
| 主版本 | **由用户定义** | AI 不得自行变更；用户要求升主版本时，次版本与修复版本归 0 |

执行要求：

- 合并进 `master` 之前，必须在分支上完成版本升级（只改根 `package.json`），建议独立提交：`chore(version): 0.1.0 -> 0.2.0（新增 xxx 能力）`。
- 提请手动合并时，必须报告"当前版本 → 目标版本"与升级依据（feat / fix / 用户指定）；主版本号与是否升版本由用户最终决定。
- 版本号只增不减，禁止回退或复用已用过的版本号。
- 多分支并行发生版本号冲突时，以先合并进 `master` 的版本为基线重新计算并追加提交，不做历史改写。

---

## 5. 完成定义（Definition of Done）

- [ ] 改动范围与需求一致，没有顺手改无关文件
- [ ] 没有破坏 §1.2 的契约冻结点（若必须改，业务层同步修改 + `MIGRATION.md` 更新）
- [ ] `bun run typecheck` 0 错误
- [ ] 与改动类型匹配的测试全绿（§3），且输出被真实记录
- [ ] 新增/变更的行为有对应断言（不留"只改实现不补测试"的改动）
- [ ] 文档同步：`README.md`（命令/用法）、`MIGRATION.md`（决策/行为差异/风险）
- [ ] 跨平台检查：代码/脚本/命令示例均遵循 §6.8（路径分隔符、家目录、换行符、shell 兼容性）
- [ ] 版本号已按 §4.4 升级（根 `package.json`），并在交付信息中写明"当前版本 → 目标版本"与依据
- [ ] 分支已提请用户手动合并（`--no-ff`），分支名 / 验证结果 / 合并命令已交付
- [ ] 用户合并后在 master 上复验通过、分支已删除（删除由用户执行，或经用户确认后由 AI 执行）
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

### 6.3 React 18 / 19 混合安装（历史约束，已解除）
`apps/cli` 在迁移到 pi-tui 之前使用 Ink 4 + React 18，与 `apps/browse`（React 19）在同一次 install 中解析时，
`ink` 的 `react-reconciler` 会拿到 React 19 变体，CLI 启动即崩：
`TypeError: undefined is not an object (evaluating 'ReactSharedInternals.ReactCurrentOwner')`。
CLI 换成 pi-tui（零 React 依赖）后该冲突不存在，因此 **`apps/browse` 已重新列入根 workspaces**：
根 `bun install` 即装齐浏览站依赖，源码运行「浏览文档」不需要再单独 `browse:install`
（历史上漏跑该步会以「未找到前端资源，也无法启动 Vite（apps/browse 依赖缺失）」失败）。

> 并入时已重跑 `bun run test:tui`（含真实 ProcessTerminal 启动检查与进程内 Vite 兜底断言）验证。

### 6.4 RepoAnalyzer 依赖 cwd
`parseFiles()` 以 `process.cwd()` 为根解析相对路径，`scanFiles()` 返回相对路径。
任何调用它的脚本/测试都必须先 `process.chdir(目标仓库)`（见 `packages/repo-analyzer/test/smoke-analyzer.ts`）。
首次解析某种语言会从 CDN 下载 WASM 到 `~/.zread-pi/parsers`。

### 6.5 生成的 Wiki 产物不入库
流水线会在**目标仓库**写出 `.zread-pi/wiki/**`；夹具里也一样。
它已被两处 `.gitignore` 覆盖，跑完测试或试跑后无需提交。

### 6.6 配置与凭据在 zread-pi 侧
- `~/.zread-pi/config.yaml`：非敏感配置。`llm.provider/model` 是当前生效项；`llm.providers.<id>` 保存每个 Provider 的 `base_url` / `api` / `auth_type` / 自定义模型 / 上次选择的模型；`llm.thinking_level` 是 pi 思考深度（缺省 `off`，配置界面 `/config/thinking` 维护）；`agent.max_turns` 是每次 Agent 运行的最大工作轮次（0-100，缺省 30，`0` = 不限制轮次，配置界面 `/config/max-turns` 维护）；`tools.<id>.enabled` 是外部工具（rg / fd）的启用开关（缺省 `true`，配置界面 `/config/tools` 维护，见 §1.4）。旧扁平 `llm.api_key`/`llm.base_url` 仍可读。
- `~/.zread-pi/bin/`：zread-pi 托管安装的外部工具（rg / fd）；探测顺序为「环境变量指定 → 托管目录 → 系统 PATH」，用户停用时直接不用（强制内置纯 JS 实现）。
- `~/.zread-pi/auth.json`：pi-ai 格式凭据（`{ "<providerId>": Credential }`），由 `Models.login()` 写入，可同时保存多个 Provider；配置界面只走 api_key，OAuth 凭据需手动写入（运行时仍会自动刷新）。
- `~/.zread-pi/models-store.json`：动态 Provider 的模型目录缓存。
- `~/.zread-pi/history`：全局记忆（ZRH1 二进制；开始生成文档时写入，`zread-pi history` 清理并展示，见 §1.1）。
- `ZREAD_PI_HOME`：覆盖项目家目录位置（默认 `~/.zread-pi`），测试隔离与同机多套配置用；路径本身只在 `packages/utils/src/project-home.ts` 定义。
- 适配层把这份配置翻译成 pi 的 Provider + Model（内置 Provider 直接用 `builtinProviders()`；未内置的用 `createProvider()` 动态注册；自定义模型按 pi models.json 语义合并）。
- 上下文压缩阈值不在 `config.yaml`，而是由适配层按 `model.contextWindow` + pi 默认值（`reserveTokens=16384` / `keepRecentTokens=20000`）自动判定；测试可通过 `createAgent({ compaction })` 调参。
- **未登记的 providerId 回退 OpenAI 兼容协议**（旧实现会抛 `Unsupported provider`）——这是有意的健壮性增强。

### 6.7 未完成事项（不要当成已完成）
- **尚未用真实 API Key 跑过完整 wiki 生成**：全部验证基于 faux / mock HTTP / 内置目录。
  首次真机验证：`bun run cli config` → 在目标仓库 `bun run cli`，重点看 retry 事件与长上下文下的 usage。
- **OAuth 登录界面已按需求移除**：配置界面只提供 API Key（Provider 详情页包含 API Key + 模型两块配置）；
  catalog/运行时仍保留 OAuth 能力（手写 `auth.json` 可用），但未在真机验证过完整授权流程。
- **CLI 的真机交互（键盘/鼠标/中文输入）仅做了自动化回归**：`test:tui` 用假终端注入按键 + 真实 ProcessTerminal 启动检查；
  真机 IME 定位、Windows 终端下的 Shift+Enter、剪贴板等仍需人工确认。
- **MCP / Skill / Task / Team / LSP / Cron 等能力未迁移**（原 `agent-sdk` 有，pi 文档无 MCP）。
- **`Bash` / `PowerShell` 等 shell 执行工具未迁移**（第六步只做「文件与搜索」工具）：因此工具文案一律不引用 shell
  （旧 `Read` 对目录曾提示「Use Bash with 'ls'」，现已改为点名 `Ls`）。若要引入 shell 能力，**先定方案再实现**
  （沙箱/审批/超时/输出截断/Windows 分支，见 `MIGRATION.md` §9.6）。
- **rg / fd 不会在 agent 运行期自动下载**（有意为之，见 §1.1）；缺失时走纯 JS 兜底，能力不降级但速度较差。
  安装必须由用户显式触发：配置界面 `/config/tools`（带进度条）或 `bun run tools:install -- <rg|fd>`（无头环境）。
- **会话语义差异**：旧 `saveSession/loadSession/tag/fork` 未迁移；pi 侧是 JSONL 会话树 + SQLite。

### 6.8 跨平台约束（Windows / Linux / macOS 等价可用）
所有代码、脚本、命令示例与文档都必须跨平台成立，常见注意点：

- **路径**：一律走 `node:path`（`join` / `resolve` / `sep`）或 POSIX 风格正斜杠；禁止手拼 `\` 或依赖 `path.sep` 字面量做判断。仓库内部约定：文件系统上接受两种分隔符，**落盘/比较前统一归一化为正斜杠**（参照 `tools/mock-wiki-run.ts` 的 `replace(/\\/g, "/")`）。
- **家目录 / 用户配置**：写 `~/.zread-pi/...` 只用于文档表述；代码中必须用 `os.homedir()`（或等价 API）展开，禁止假设 `C:\Users\...` 或 `/home/...`。
- **临时目录**：用 `os.tmpdir()` + `fs.mkdtemp`（参照 `tools/mock-wiki-run.ts`），不要写死 `/tmp`。
- **Shell 命令**：`package.json` 的 `scripts` 一律用 `bun run <file>.ts` 形式（跨平台安全），不要写 `rm -rf`、`cp -r`、`&&` 链、`$(...)` 等 CMD/PowerShell 不支持的写法；确需 shell 逻辑时放进 TS 脚本。文档中的 bash 示例假定在 Git Bash / WSL / POSIX shell 下执行。
- **换行符与编码**：源码与文档统一 LF（UTF-8 无 BOM）；Windows 侧依赖 `core.autocrlf` 的只影响本地检出，不要在代码里对 `\r\n` 做硬编码假设，读取外部文件时注意 strip `\r`。
- **大小写敏感**：Linux 文件系统大小写敏感，import 路径与文件名的大小写必须与磁盘完全一致，禁止依赖 Windows/macOS 的宽松匹配。
- **平台特定 API**：涉及终端/进程/权限的操作（TUI、ProcessTerminal、符号链接、可执行位）必须显式处理 `process.platform` 分支，并在至少一个非开发主力平台上跑过对应测试（`test:tui` 的 real-run-check 已覆盖 Windows）。
- **二进制/依赖**：不要引入仅单平台可用的依赖（如依赖 MSVC 的原生模块）；新增依赖时确认三平台均有预编译产物或可源码构建。

---

## 7. 后续方向（详见 MIGRATION.md §6）

1. 已接入 pi 的压缩能力（`transformContext` + `prepareCompaction`/`compact`，见 §1.1 / `packages/agent-runtime/test/context-compaction.ts`）；后续可考虑把压缩阈值（`reserveTokens` / `keepRecentTokens`）也暴露到配置界面。
2. 用 pi 的 usage ledger + 真实 `Model.cost` 替代旧 `estimateCost`。
3. 需要聊天/会话时接 pi 的 `JsonlStorage` 会话树，而不是回填旧实现。
4. 需要子代理/权限弹窗/计划模式时，走 pi 扩展 API（`registerTool` / `tool_call` 事件阻断）。
5. 工具层可选补强（未决，见 `MIGRATION.md` §9.6）：`Read` 图片缩放（上游 `processImage`）、`Grep` 的 `type` 参数、
   rg/fd 自动下载、以及「先用方案再实现」的 shell 执行能力。

---

## 8. 文档索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 用法、目录、验证矩阵、三个工程细节（browse 隔离 / vendor 模式 / 配置归属） |
| `MIGRATION.md` | 迁移决策、改动清单、契约冻结点、与旧实现的行为差异、风险与后续路径 |
| `AGENTS.md` | 本文件：上下文总结 + 开发 / Git（手动合并）/ 版本号流程（唯一入口约定） |
| `fixtures/hello-python/README.md` | 夹具说明与三种测试用法 |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **zread-pi** (3515 symbols, 8730 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
| `gitnexus://repo/zread-pi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/zread-pi/clusters` | All functional areas |
| `gitnexus://repo/zread-pi/processes` | All execution flows |
| `gitnexus://repo/zread-pi/process/{name}` | Step-by-step execution trace |

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
