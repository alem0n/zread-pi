# zread-pi

把 **zread-pi 的业务层**（`cli` / `Orchestrator` / `Browse` / `RepoAnalyzer` / `Types`）搬到 **pi 的 agent 内核**（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）之上运行。

> 一句话：**只换运行时内核，业务逻辑一行不改。**
> 原来的 `packages/agent-sdk`（自研 QueryEngine + 薄重试 + 整文件会话）被 `packages/agent-runtime` 适配层取代，对外仍暴露同名同签名的 `createAgent()` / `createProvider()` / 5 个文件工具 / 同一批类型。

---

## 目录结构

```
zread-pi/
├─ packages/
│  ├─ agent-runtime/     ← 新：pi 适配层（替代 agent-sdk）
│  │  ├─ src/agent.ts             createAgent（pi Agent 循环 + 重试编排 + 事件/钩子映射）
│  │  ├─ src/pi/runtime-model.ts  配置（provider/model/apiKey/baseURL）→ pi Provider + Model
│  │  ├─ src/pi/provider-catalog.ts  pi-ai 内置 Provider 目录 + 登录 + 自定义模型
│  │  ├─ src/pi/auth-store.ts     ~/.zread-pi/auth.json 凭据存储（pi CredentialStore）
│  │  ├─ src/pi/models-store.ts   动态模型目录缓存（pi ModelsStore）
│  │  ├─ src/retry.ts             RetryConfig 契约 + pi-ai 错误分类/退避
│  │  ├─ src/providers/           createProvider（pi-ai Models，供 browse-chat 使用）
│  │  ├─ src/tools/               工具层：Read/Write/Edit/Glob/Grep/Ls + 截断/glob/遍历等共享设施
│  │  └─ test/                    冒烟测试（离线 faux + 本地 mock HTTP + provider + catalog）
│  ├─ orchestrator/      ← 保留：编排层（工具/提示词/并发/同步，仅把 import 指向 agent-runtime）
│  ├─ repo-analyzer/     ← 保留：Tree-sitter 分析（未改）
│  ├─ utils/             ← 保留：配置 / cache / wiki 落盘 / 版本快照 / 外部工具注册表与安装器
│  └─ types/             ← 保留：共享类型（provider/model 配置结构有新增字段）
├─ apps/
│  ├─ cli/               ← 保留：TUI（**pi-tui 实现**，不再依赖 Ink/React；仅 browse-chat 的 provider 改为 pi 实现）
│  └─ browse/            ← 保留：React 19 + Vite 预览站（**独立安装**，见下方说明）
├─ fixtures/hello-python/ ← 测试夹具：极简 Python 项目（离线全链路试跑的目标）
├─ vendor/pi/packages/   ← pi 内核源码（ai / agent / telemetry / chord / tui，上游零改动）
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

# 2) TUI 专项回归（pi-tui 迁移：布局/快捷键/生成与同步全链路，离线）
bun run test:tui

# 3) 离线全链路试跑：用 mock LLM 对任意仓库跑「扫描 -> 蓝图 -> 并行页面」
#    默认目标是内置夹具 fixtures/hello-python
bun run mock:wiki
bun run mock:wiki path/to/any/repo   # 也可指定其它仓库

# 4) 真机跑 CLI：先配置 LLM（config.yaml + auth.json）
#    配置界面直接使用 pi-ai 的 Provider 目录与 login（API Key / OAuth），
#    可以同时登录多个 Provider，并为任意 Provider 添加自定义模型。
bun run cli config
bun run cli            # 等价于 zread-pi wiki，目标 = 当前目录

# -d / --dir：不切换 shell 目录也能对指定仓库生成/浏览文档
bun run cli --dir fixtures/hello-python          # 相对路径按当前目录解析
bun run cli -d /path/to/repo                     # 绝对路径
bun run cli wiki --dir /path/to/repo             # 显式 wiki 子命令写法
bun run cli browse --dir /path/to/repo           # 预览站也看该目录的产物
# 目录无效（不存在/不是目录）时不进入 TUI：单行错误 + 退出码 1
#
# 「浏览文档」返回的地址一定真实可访问，并自动打开浏览器：
#   有构建产物（apps/browse/dist 或打包后的 dist/browse）→ API + 静态资源同端口；
#   源码运行且未构建 → 进程内自动启动 Vite dev server（/api 代理到 API 端口）。
#   启动失败（端口占用/资源缺失）时页面直接显示原因，不再静默显示一个打不开的地址。

# 5) 预览站（独立 React 19 环境，见「工程细节 1」）bun run browse:install      # 首次：安装 apps/browse 依赖
bun run browse:build        # 可选：构建静态产物（打包 CLI / 免 Vite 预览）
bun run browse:dev          # 可选：单独开发前端 UI（Vite HMR）
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
| `thinkingLevel`（pi 思考深度） | `createAgent({ thinkingLevel })` → pi `Agent` 的 `initialState.thinkingLevel`，随请求作为 `options.reasoning` 传给 pi-ai；`off` 不发送 reasoning。模型不支持所选档位时由 pi-ai 自动调整（clamp） |
| `maxTurns` | pi 的 `shouldStopAfterTurn` 计数；轮次由 `config.agent.max_turns` 提供（配置界面 `/config/max-turns`，旧实现硬编码 30）。倒数第 1 轮注入收尾提示、超限后允许 `finalization.graceTurns`（默认 1）轮宽限；仍不收敛才产出 `subtype: "error_max_turns"` |
| 上下文压缩 | pi 的 `transformContext` + `prepareCompaction` / `compact`：超过 `contextWindow - reserveTokens` 时生成摘要（发出 `system/compact_boundary`），用「摘要 + 保留的近期消息」继续；无法再腾出空间时 `shouldStopAfterTurn` 优雅停止，产出 `subtype: "error_context_full"`（不再等到 provider 报上下文溢出） |
| 5 个文件工具（Read/Write/Edit/Glob/Grep） | **按上游 pi 实现重写**（并新增 `Ls`）：见下方「工具层（对齐上游 pi）」；工具名与既有参数名保持不变，包装成 pi 的 `AgentTool`（JSON Schema 直接作为 TypeBox `TSchema` 使用） |
| `TokenUsage` | 由 pi `Usage` 映射（`cacheWrite`→`cache_creation_input_tokens`，`cacheRead`→`cache_read_input_tokens`） |
| `createProvider()`（browse-chat） | pi-ai `Models.completeSimple()` |
| 配置界面手工维护 provider 列表（LiteLLM 缓存） | pi-ai `builtinProviders()`（40 个内置 Provider）+ `Models.login()`（API Key / OAuth）+ `Models.refresh()`（模型目录刷新） |

业务侧唯一改动：`import ... from '@zread-pi/agent-sdk'` → `'@zread-pi/agent-runtime'`（22 个文件，纯机械替换）。
`Orchestrator` 的并发控制（p-limit）、错误隔离、三层 Repo Map 工具、prompt、`wiki.json` 契约、`WritePageTool` 的 Mermaid 校验**全部未改**。

### 工具层（对齐上游 pi）

| 工具 | 状态 | 要点 |
|---|---|---|
| `Ls` | 新增 | 目录列举：排序 + 目录补 `/` + dotfile + 条目/字节双上限 |
| `Glob` | 重写 | 系统 `fd` 优先、纯 JS 兜底；相对 POSIX 路径 + 字典序；尊重 `.gitignore`（非 git 仓库内也生效） |
| `Grep` | 重写 | rg `--json` 流式解析（命中上限立刻 kill）+ 纯 JS 兜底；`ignoreCase`/`literal`/`context`/`limit`；长行截断 500 字符 |
| `Read` | 重写 | 图片按 magic number 判型并回传 image 块（仅当模型支持图片）；`offset` 1-based；2000 行 / 50KB + `Use offset=N to continue.` |
| `Write` / `Edit` | 重写 | 同文件并发串行化；`Edit` 支持 BOM/CRLF 归一化、多段 `edits[]`、diff 回传 |

- **不引入 `pi-coding-agent`**：上游工具按「复制 + 改写」移植，`vendor/pi/**` 零改动；
  `truncateHead`/`truncateLine` 等纯函数直接复用 vendor 已导出的实现。
- **rg/fd 探测常驻、安装显式**：agent 运行期只探测，缺失时走纯 JS 兜底（`file-walk.ts` + `glob-match.ts`）；
  测试对同一条查询同时跑两条路径并断言结果一致。
- 细节与未决项见 `MIGRATION.md` §9。

### 外部工具安装（`/config/tools`）

| 能力 | 说明 |
|---|---|
| 列表页 | 总体就绪进度条 + 每个工具的状态（系统已安装 / 已由 zread-pi 安装 / 未安装 / 已停用）与版本、用途 |
| 详情页 | 状态、版本、路径、用途、安装目录；Enter 安装/重装（**进度条 + 百分比 + 字节数 + 阶段**）、`d` 卸载（只删托管副本）、`t` 启用/停用（写入 `tools.<id>.enabled`） |
| 无头入口 | `bun run tools:install`（列状态）、`bun run tools:install -- fd`、`bun run tools:install -- rg 15.2.0`、`-- --remove` |
| 托管目录 | `~/.zread-pi/bin`（`ZREAD_PI_TOOLS_DIR` 可覆盖）；下载源可用 `ZREAD_PI_TOOLS_BASE_URL` 指向内网镜像 |
| 安全 | 只从固定仓库 HTTPS 下载；ripgrep 提供 `.sha256` 时先校验指纹再解包（fd 不提供则跳过）；解包带 zip-slip 防护；安装后必须能执行 `--version` 才算成功 |
| 扩展 | 新增工具只需在 `packages/utils/src/tools/registry.ts` 加一条 `ToolSpec`，界面 / 安装器 / 探测自动跟上 |

> 真机验证（手动执行）：对真实 GitHub Releases 安装成功并可直接运行——`ripgrep 15.2.0 (rev e89fff89ac)`、`fd 10.5.0`。
> 离线回归：`bun run test:installer`（70/70，本地 mock Releases + 注入探测）。

---

## 验证结果（`bun run test`）

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `test:catalog` | **pi-ai Provider 目录**：内置 Provider 列表、api_key 登录写 `auth.json`、多 Provider 同时配置、自定义模型合并、未内置 Provider 注册、runtime model 元数据、思考深度支持列表、旧配置补 `agent.max_turns` 默认值、logout 隔离 | 32/32 |
| `test:agent` | pi Agent 循环、工具执行、钩子、流式事件、**429 重试**、usage 映射、thinkingLevel → reasoning 透传、maxTurns | 11/11 |
| `test:tools` | **工具层专项**：截断设施、glob 语义、`Ls`/`Glob`/`Grep`/`Read`/`Write`/`Edit` 行为与错误文案、**rg/fd 与纯 JS 兜底两条路径结果一致**（含 .gitignore 行为）、同文件 16 路并发编辑不丢更新、`details` 与图片内容块穿过桥接层进入模型上下文、外部工具启用开关 → 二进制解析联动 | 95/95 |
| `test:installer` | **外部工具安装**：注册表与资产名（对过真实 release 列表）、归档解包（tar.gz/zip、stored+deflate、GNU LongName、zip-slip 防护）、配置归一化（旧配置零迁移）、安装全流程（本地 mock Releases + 注入探测：进度阶段 / 百分比单调 / 指纹不匹配拒绝解包 / 校验失败清理）、卸载与启用开关、**版本探测与可用性解耦**（多组参数回退 / 识别不出版本仍可用 / 安装台账与不一致提示） | 70/70 |
| `test:context` | **上下文压缩 + 优雅停止**：`transformContext` 调用 pi `prepareCompaction`/`compact`、`system/compact_boundary`、压缩后继续成功；单个巨大 turn（压缩无法腾出空间）与 `compaction.enabled=false` 时产出 `error_context_full`；`maxTurns` 收尾提示 + 宽限轮：模型最后一轮/宽限轮输出 → success，仍不收敛 → `error_max_turns`，`graceTurns=0` 回到旧行为 | 35/35 |
| `test:agent:http` | 真实 HTTP/SSE 路径：baseURL + apiKey 注入、增量 tool_call 参数解析、第二轮请求 | 7/7 |
| `test:provider` | `createProvider().createMessage()`（browse-chat 路径）、system 透传、usage | 5/5 |
| `test:analyzer` | RepoAnalyzer 扫描 + Tree-sitter 解析（未改动包仍可运行） | 5/5 |
| `test:bluprint` | **Orchestrator 端到端**：`generateWikiCatalog()` → 工具落盘 `wiki.json` → CatalogEvent 进度事件；模型不产出蓝图时报错 | 7/7 |
| `test:pages` | **并行页面生成**：`generateWikiContent({maxConcurrent:3})` → `write_page` 落盘、frontmatter、Mermaid 校验拦截；页面未落盘时必须记失败并发出 `page_error`（不再误报完成） | 8/8 |
| `test:browse` | **「浏览文档」服务器 + pi-tui 浏览页**：静态资源与 API 同端口、SPA fallback、未知 API 404、`close()` 后端口不可连；页面显示「服务器已启动」+ 真实访问地址、ESC 停止；源码无产物时进程内 Vite 兜底（`/api` 代理）；无效 `ZREAD_PI_BROWSE_DIST` 直接报错 | 28/28（apps/browse 有 dist 时兜底 4 项自动跳过） |
| `test:tui` | **CLI (pi-tui)**：布局/快捷键/输入框/分页 + 版本号与项目版本同步 + Provider 详情页（API Key + 模型）冒烟 + 多 Provider/自定义模型 + 思考深度页 + 最大轮次页 + 外部工具页（安装/卸载/启停 + 进度条）+ 全部路由渲染 + 真实 ProcessTerminal 启动与退出 + **`-d/--dir` 目标目录（相对/绝对路径、产物落盘、无效目录报错）** + mock LLM 的生成/同步全链路 + 「浏览文档」服务与页面（`test:browse`） | 185 + 19 + 9 + 25 + 19 + 24 |

另有诊断脚本 `packages/agent-runtime/test/debug-events.ts`（打印 pi 原始事件）。

### 离线全链路试跑（mock LLM）

`bun run mock:wiki <目标仓库>` 会用本地 mock OpenAI 服务驱动真实编排层，验证：
目录扫描 → 蓝图 `wiki.json` 落盘 → 并行页面 Agent → `write_page` 落盘，全程不联网、不需要 API Key。

已用测试夹具 `fixtures/hello-python` 验证通过：4 个 Python 源文件 → 4 页 Wiki，`completed=4 failed=0`，mock 请求 10 次。
（该目录下的 `.zread-pi/` 就是生成产物，已 gitignore；真实内容请用 `bun run cli`。）

---

## TUI 迁移（Ink → pi-tui）

`apps/cli` 的终端界面已从 **Ink 4 + React 18 + react-router** 换成 **pi-tui**（`vendor/pi/packages/tui`），
**布局、快捷键、文案、业务逻辑保持不变**，只替换渲染与输入底座。

```
apps/cli/src/
├─ index.ts          CLI 入口（commander，同迁移前；全局选项 -d/--dir 指定目标目录）
├─ app.ts            应用启动（对应迁移前的 App.tsx）
├─ routes.ts         路由表（对应 <Routes> 声明，含 /config/provider/custom 优先等顺序约束）
├─ state/            ConfigStore / I18nStore / WikiStore（替代 ConfigProvider / I18nProvider / WikiProvider）
├─ tui/
│  ├─ app.ts         App：路由栈、onEnter/onDestroy、全局按键（ctrl+c 退出、ESC 返回/退出）
│  ├─ layout.ts      项目信息框 + 介绍文字 + 页面插槽（对应 layout/layout.tsx）
│  ├─ router.ts      内存路由（navigate(path) / navigate(-1) / replace）
│  ├─ screen.ts      页面基类（render / handleKey / claimEsc）
│  ├─ ansi.ts        ANSI 样式（对齐 Ink <Text> 的 color / dimColor / bold）
│  └─ components/    Divider / RoundedBox / Select / StatusIcon / TextField
└─ views/            15 个页面（wiki-home / wiki-generate / wiki-sync / browse / 11 个 config 页面）
```

配置模块页面（`/config/provider` 系列）已改为 pi-ai 驱动的 Provider/模型/API Key 流程：

```
/config/provider                     Provider 列表（内置目录 + 已配置的自定义端点，带登录状态）
/config/provider/:id                 Provider 详情页：API Key 配置 + 模型选择并列（同一页面）
                                     tab / shift+tab 切换焦点；r 刷新模型；a 添加自定义模型
/config/provider/:id/model-new       为指定 Provider 添加自定义模型
/config/provider/custom              完全自定义端点（Base URL → 模型 → API Key）
/config/provider/:id/custom          兼容旧路由 → 等同于 model-new
/config/thinking                     思考深度（pi thinking level：off/minimal/low/medium/high/xhigh/max）
/config/max-turns                    最大轮次（agent.max_turns：1-100，默认 30）
```

登录只提供 API Key（写入 `~/.zread-pi/auth.json`，走 pi-ai `Models.login`）；不再提供 OAuth 订阅选项。

对照关系与判定条件：

| 迁移前 | 迁移后 |
|---|---|
| `withFullScreen(<App/>)`（备用屏幕） | `TuiAltScreen` + `tui.setLayoutRoot(layout)` |
| `<Box borderStyle="round">` 项目信息框 | `tui/components/rounded-box.ts`（撑满宽度、`╭─╮` 边框） |
| `ink-select-input` | `tui/components/select.ts`（↑↓/k/j 回绕、值变化重置选中项、onHighlight） |
| `ink-text-input` | `tui/components/text-field.ts`（包 pi-tui `Input`：↑↓/Tab 忽略、Delete=向前删、光标置尾） |
| `ink-spinner` | Browse 页 80ms 帧定时器（`⠋⠙⠹…`） |
| `useInput` 全局 ESC（由 Layout 统一处理） | `App.handleGlobalEscape()`（`key==="default"` 时根页面退出，否则 `navigate(-1)`） |
| `EscHandlerProvider.claimEsc()`（搜索/多步骤页面抢占 ESC） | `App.claimEsc()/releaseEsc()` + `Screen.handleKey()` 返回 `true` |
| react-router `navigate(-1)` / `replace` | `tui/router.ts` 的路由栈（首条目 key = `default`） |
| `useImmer` + Context | 普通 store 类 + `requestRender()`（pi-tui 每帧重新 `render(width)`） |

业务逻辑（Orchestrator 调用、并发、落盘、提示词、文案）零改动；
原先的 `views/*/mapper.ts`、`state.ts`、`types.ts`（纯函数）原样保留并继续被 `__tests__` 覆盖。

### 目标目录参数（`-d` / `--dir`）

迁移前必须先 `cd` 到目标仓库再运行 CLI。现在入口提供全局选项 `-d, --dir <path>`：

```bash
zread-pi --dir /path/to/repo        # 默认命令（wiki）
zread-pi wiki --dir /path/to/repo   # 显式子命令写法
zread-pi browse -d /path/to/repo    # 预览站也读这份产物
```

- 业务层所有路径都以 `process.cwd()` 为根（RepoAnalyzer 扫描、`.zread-pi` 落盘、Agent 的 cwd），
  所以实现是在进入 TUI 之前**切一次进程工作目录**（`apps/cli/src/utils/target-dir.ts`），业务层零改动；
  TUI 头部的「目录」行会显示实际生效的绝对路径。
- 相对路径按「调用时的当前目录」解析；目录不存在或不是目录时**不进入 TUI**，只输出单行错误并以退出码 1 结束。
- 未指定时保持旧行为（目标 = 当前目录）。`test:tui` 覆盖了绝对/相对路径、显式子命令写法、产物落盘位置与两类无效目录。

### 列表分页与刷新（pi-tui 版本的可用性补强）

迁移前 ink-select-input 会把整张表铺开写入全屏缓冲，超过终端高度的部分既看不见也无法导航（选中项跑到屏幕外、界面看起来「卡住不刷新」）。现在：

- **窗口化渲染**：列表只渲染可见窗口，选中项始终在窗口内（`tui/components/select.ts` 的 `computeItemWindow` / `scrollIndicator`，自绘列表的 Provider / Model 页复用同一套函数）。
- **位置指示**：被裁剪时在列表末尾追加 `↑ (12/63) ↓`（沿用迁移前 `VirtualSelect` 的 `(n/总数)` 格式）。
- **翻页按键**：`PageUp` / `PageDown` 整页翻，`Home` / `End` 到首/末项（原有 `↑↓` `j` `k` `Enter` 行为不变）。备用屏幕默认会吃掉这几个键，应用启动时用 `setKeybindings` 释放（`tui/app.ts`）。
- **终端自适应**：窗口行数 = 终端行数 − 布局头部 − 列表上下文案，窗口缩小（拖窗口）时自动重算，整页渲染不再超出终端高度。
- **异步加载都能刷到屏幕**：加载态、进度态、保存态、重试倒计时都走 `requestRender()`；`test:tui` 用假终端断言了「加载中 → 列表」「目录完成 → 文章列表」等中间态确实被渲染。
- **按键立即重绘**：页面按键交给 pi-tui 的聚焦分发（`Screen.handleInput` → `Screen.handleKey`），pi-tui 分发后会自动请求一次立即重绘，页面无需手动 `refresh()`；同时 Kitty 键盘协议的上报松开事件被统一过滤，一次按键只处理一次（此前用原始输入监听器自行转发，改状态后不重绘，需点一下鼠标才看到切换）。
- **直接进入子路由时先加载 `wiki.json`**：`/wiki/generate`、`/wiki/sync` 的 `onEnter` 会 `await wiki.load()` 再启动流程（否则会误判为「无目录」而重新扫描）。
- **防止杂散输出花屏**：TUI 期间 `console.*` 被接管并转存到 `~/.zread-pi/logs/zread-pi-*.log`（典型来源：provider-registry 同步失败时的 `console.error`），退出时还原（`tui/console-guard.ts`）。

---

## 需要知道的三个工程细节

### 1. `apps/browse` 独立安装（历史原因：React 18/19 隔离）
迁移到 pi-tui 之前，`apps/cli`（Ink 4 + React 18）与 `apps/browse`（React 19 + Vite）混装时，bun 会为 `ink` 的 `react-reconciler` 选到 React 19 变体，导致 CLI 启动即崩：
`TypeError: undefined is not an object (evaluating 'ReactSharedInternals.ReactCurrentOwner')`。
因此 **`apps/browse` 不列入根 workspaces**，单独 `bun install`（`bun run browse:install`）。它不引用任何 `@zread-pi/*` 包，隔离无副作用。

> 现状：CLI 已不再依赖 React/Ink，该冲突不再存在；但本次迁移刻意不改动 browse 的安装方式（保持零风险）。如后续要合并，只需把它加回根 `workspaces` 并验证 CLI 启动。

### 2. vendor 管理模式（src ⇄ dist）
`vendor/pi/packages/*` 是 pi 上游源码快照，两种消费方式：

- **dist 模式（默认）**：`exports` 指向已构建的 `dist/*.js|.d.ts`；类型检查走 `.d.ts`，速度快。
  `dist/` **不入库**，因此全新 clone 后必须先跑一次：`bun run vendor:build`（顺序：telemetry → chord → ai → agent → tui）。
- **src 模式（免构建）**：`exports` 指向 `src/*.ts`，Bun 直接跑 TS，适合修改 pi 源码。
  切换：`bun run vendor:src`（免构建）/ `bun run vendor:dist`（需紧接 `vendor:build`）。

`ai` 包用 `tsconfig.app.json` 构建。历史上只编译 `index.ts` + 三个 api lazy 入口的闭包，因为 pi 上游的 `providers/*.models.ts` 依赖构建期生成的 `src/providers/data/*.json`（仓库快照里不存在）。
现在为了把 pi-ai 的 **内置 Provider 目录 + OAuth 登录流程**接进配置界面：

- `src/providers/data/*.json`（内含 `.manifest.json`）已从同版本（0.85.1）的 npm 发布包补齐并入库（0.6MB）；
- `tsconfig.app.json` 额外 include：`src/providers/all.ts`（40 个 Provider + 模型目录）、`src/bun-oauth.ts`（静态注册 OAuth 流程，解决打包后动态 specifier 不可解析的问题）、`src/auth/oauth/*.ts`；
- `packages/agent-runtime` 导入 `@earendil-works/pi-ai/providers/all` 与 `bun-oauth`，因此 `vendor:build` 产物必须包含这些文件（重建只需重新跑 `bun run vendor:build`）。

另：`vendor/pi/packages/ai/package.json` 显式补了 `@smithy/types`（上游靠 aws-sdk 传递获得，孤岛安装模式下需显式声明）。
`tui` 包的上游构建脚本是 `tsgo`；本仓库改用 `tsc`，因此其 `tsconfig.build.json` 把 `target/lib` 提到 `ES2024`（`utils.ts` 里用了 `v` 正则标志，`ES2022` 下 TS 会报 TS1501）。

### 3. 配置与凭据（config.yaml + auth.json）

配置分两层，均归 zread-pi 自己管理：

- `~/.zread-pi/config.yaml`：非敏感配置。`llm.provider` / `llm.model` 是当前生效的 Provider/模型；
  `llm.providers.<providerId>` 保存每个 Provider 的 `base_url` / `api` / `auth_type` / 自定义模型（`models`）与上次选择的模型；
  `llm.thinking_level` 是 pi 的思考深度（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，旧配置缺省 `off`），
  由配置界面 `/config/thinking` 维护，生成/同步时传给 Agent（模型不支持时 pi 自动调整）；
  `agent.max_turns` 是每次 Agent 运行的最大轮次（1-100，默认 30），由配置界面 `/config/max-turns` 维护，
  旧配置缺省 30（迁移前硬编码值）；
  它是「工作轮数」：倒数第 1 轮会提示模型立即调用输出工具，超限后自动允许 1 轮收尾宽限（可用 `finalization.graceTurns` 调），
  因此实际最多可能跑到 `max_turns + 1` 轮；仍不收敛才以 `error_max_turns` 结束。
  旧字段 `llm.api_key` / `llm.base_url` 仍然兼容读取，首次在新界面切换模型时会自动迁移到下面两个位置。
- `~/.zread-pi/auth.json`：pi-ai 格式的凭据（`{ "<providerId>": Credential }`），由 `Models.login()` 写入，
  可同时保存多个 Provider 的 API Key；OAuth 凭据（手动写入时）也由 pi 自动刷新。
- `~/.zread-pi/models-store.json`：动态 Provider 的模型目录缓存（pi `ModelsStore`）。

`packages/agent-runtime/src/pi/provider-catalog.ts` 把这份配置翻译成 pi 的 Provider + Model：
内置 Provider 直接用 pi-ai 的 `builtinProviders()`，未内置的（自定义端点 / 旧 `openai-compatible`）用 `createProvider()` 动态注册；
配置里的自定义模型按 pi models.json 的合并语义（同 id 覆盖、否则追加）叠加到 `getModels()` 上。
运行时（`createRuntimeModel`）优先走 catalog：模型元数据、OAuth 自动刷新、多 Provider 凭据全部生效；
unknown providerId 仍然回退为 OpenAI 兼容协议（旧实现会直接抛 `Unsupported provider`）——这是有意的健壮性增强。

上下文管理（自动压缩 + 优雅停止）无需配置：适配层在 pi 的 `transformContext` 里用模型元数据的
`contextWindow` 判定（`pi` 默认预留 16384 / 保留近期 20000 tokens），压缩成功会向业务侧发 `system/compact_boundary`；
无法再腾出空间时由 `shouldStopAfterTurn` 在轮次边界停止（`error_context_full`）。
可通过 `createAgent({ compaction: { enabled, reserveTokens, keepRecentTokens } })` 调参（测试用，业务默认不传）。

---

## 二进制构建（GitHub Actions）

`.github/workflows/build-binary.yml` 在三平台构建 standalone 二进制并打 zip：
推送 `v*` tag 自动构建并创建 Release；也可在 Actions 页面手动触发（workflow_dispatch）。

产物布局（**wasm 必须与二进制同目录**，运行时按可执行文件同目录查找，见
`packages/repo-analyzer/src/parser/wasm-loader.ts`）：

```text
zread-pi-v<版本>-<os>-<arch>.zip
├── zread-pi(.exe)
├── tree-sitter.wasm
├── mappings.wasm
└── browse/            # 「浏览文档」前端静态资源
```

本地手动构建（前置：vendor:build → workspace 包 tsup → browse:build → apps/cli build）：

```bash
bun run build:binary -- --target windows-x64   # linux-x64 | macos-arm64 等经交叉编译产出
```

支持目标：windows-x64 / linux-x64 / linux-arm64 / macos-x64 / macos-arm64（bun compile 交叉编译）。

---

## 未迁移（当前业务链路未使用）

原 `agent-sdk` 的以下能力**没有**搬过来，需要时再按需补：

- **MCP**（stdio/SSE/HTTP/进程内）—— pi 文档中无 MCP 能力，若需要应作为独立扩展实现；
- **Skill 系统 / Task / Team / Cron / LSP / WebSearch / Notebook / Worktree / Plan 模式 / AskUser 等 27 个内置工具**；
- **会话持久化**（`~/.open-agent-sdk/sessions/*.json`、tag/rename/fork/list）—— pi 侧是 JSONL 会话树 + SQLite，语义不同；当前 wiki 生成是"每次运行一次性 agent"，不需要该能力。

补充阅读：`AGENTS.md`（上下文总结 + 开发与 Git 流程，协作唯一入口）、`MIGRATION.md`（迁移决策、风险、后续路径）。
