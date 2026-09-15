# MIGRATION.md — 把 zread-pi 的 Agent 内核换成 pi

## 1. 目标与判定

**目标**：`agent-sdk` 过于单薄（自研 QueryEngine、API 级重试、整文件会话、无副作用/取消语义），
希望换成 pi 的健壮内核，同时**业务逻辑不变**。

**判定**：按"运行时换芯"执行，而不是"项目搬迁"。

- 只切一刀：`packages/agent-sdk` → `packages/agent-runtime`（pi 实现），对外契约保持不变；
- **不**引入 `pi-coding-agent` 应用层（那会把 Ink TUI 换成 pi-tui，等于重写 `cli`）；
- 依据：pi 文档明确 agent 内核"完全无状态……可在命令行工具、Web 服务、桌面应用中复用"。

> 第二步（本文 §7）：`apps/cli` 的 TUI 已单独从 Ink 换成 pi-tui，**只换渲染/输入底座，布局、快捷键、文案与业务逻辑不变**。

## 2. 改动清单

| 动作 | 对象 |
|---|---|
| 新增 | `packages/agent-runtime`（`src/agent.ts`、`src/pi/runtime-model.ts`、`src/retry.ts`、`src/providers/*`、`src/tools/*`、`src/types.ts`、`src/hooks.ts`、`src/utils/retry.ts`） |
| 新增 vendor | `vendor/pi/packages/{ai,agent,telemetry,chord}`（pi 上游源码，**零改动**）+ `vendor/pi/tsconfig.base.json` |
| 新增 vendor（第二步） | `vendor/pi/packages/tui`（pi-tui，供 CLI 使用；仅 `tsconfig.build.json` 将 target/lib 提到 ES2024） |
| 机械替换 import | 22 个文件：`@zread-pi/agent-sdk` → `@zread-pi/agent-runtime`（orchestrator 17、cli 3、tsconfig/package.json 等） |
| 未改动 | `orchestrator` 的 prompts / 三层 Repo Map 工具 / 并发与错误隔离 / wiki 契约；`repo-analyzer`；`utils`；`types`；`browse` 全部前端代码（`cli` 的 TUI 在第二步换成 pi-tui，见 §7） |
| 依赖修正 | `apps/cli` 补 `@types/express`；`vendor/pi/packages/ai` 补 `@smithy/types` |
| 配置界面（第三步） | `apps/cli` 的 Provider/模型页面改为 pi-ai 目录 + `Models.login`；Provider 详情页为「API Key 配置 + 模型选择」并列布局（只提供 API Key）；`agent-runtime` 新增 `src/pi/{provider-catalog,auth-store,models-store}.ts`；配置结构新增 `llm.providers`，凭据落 `~/.zread-pi/auth.json`（详见 §8） |
| 上下文与轮次（第五步） | `agent-runtime` 接入 pi compaction（`transformContext` + `prepareCompaction`/`compact`）与 `shouldStopAfterTurn` 优雅停止；配置结构新增 `agent.max_turns`，CLI 新增 `/config/max-turns`，Orchestrator 不再硬编码 30（详见 §8.6）。**第十步已被 harness 版本取代，见 §12** |
| 首尾机制 harness 化（第十步） | `agent-runtime` 内部由裸 agent loop 换成 pi 的 `AgentHarness`：会话/泳道/操作状态机/压缩/重试/事件全部交给 harness；轮数硬顶→token 预算、一次性提示→两段式提示（`before_run` 注入）、`shouldStopAfterTurn`→`before_run_end` 终止、`error_max_turns`→`error_budget_exhausted` + 编排层判页失败；新增 `agent.token_budget`（详见 §12） |

工具与类型的**原样复制**（非重写）：
`packages/agent-runtime/src/types.ts`、`src/tools/{types,read,write,edit,glob,grep}.ts`、`src/providers/types.ts`
均直接取自 `archive/zread-pi/packages/agent-sdk/src`，因此 Read/Write/Edit/Glob/Grep 的 schema、提示文本、行为与旧版一字不差。

## 3. 契约冻结点（业务可见面）

```ts
createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt,
              tools, maxTurns, thinkingLevel, compaction, finalization, hooks, retryConfig, includePartialMessages })
  -> { query(prompt): AsyncGenerator<SDKMessage>, close(): Promise<void>, abort() }

createProvider(providerIdOrApiType, { apiKey, baseURL })
  -> { apiType, createMessage({ model, maxTokens, system, messages }) }
```

`SDKMessage` 联合类型、`CatalogEvent` 触发时序（requesting → responding → tool_start → tool_result → complete）、
`TokenUsage` 字段名、`BlueprintResult.durationMs/tokenUsage` 全部保持；
`result.subtype` 新增 `error_context_full`（上下文将满优雅停止，见 §8.6/§12）与 `error_budget_exhausted`
（token 预算耗尽且强制交卷后仍无目标产物，见 §12）；
`result.usage` 在第十步起为 **harness usage ledger 的累计值**（单次响应用量仍在 `assistant` 事件上，见 §12.5）。

第十九步的展示层扩展（均为**新增可选字段**，旧调用点零改动，见 §21）：
`system/init` 新增 `context_window?`（本次解析出的模型上下文窗口）；
`CatalogEvent` 新增 `contextTokens?` / `contextWindow?`（该 Agent 最近一次响应的上下文体量）与
`agentKey?` / `agentRole?` / `agentStatus?` / `agentUsage?`（逐 Agent 行；带 `agentKey` 的 `complete` / `error`
是**单个 Agent 的终态**，不带才是目录整体终态）；`ArticleEventPayload` 新增 `contextTokens?` / `contextWindow?`。

## 4. 与旧实现的行为差异（有意为之，均已验证）

| 差异 | 说明 |
|---|---|
| 重试位置 | 第十步起重试直接交给 harness 的 retry policy（失败尝试在 settlement 前不落库，语义与旧 `"stream"` 等价）；旧适配层自研的 `streamFn` 包装与 `retryScope: "stream+run"` 已移除（见 §12.5）。 |
| 重试判定 | 复用 pi-ai 的错误分类器；旧配置里的 `retryableStatusCodes` 白名单不再参与判定，`maxDelayMs` 映射为 `maxAgentDelayMs`。 |
| 未登记 providerId | 旧实现抛 `Unsupported provider`；新实现回退 OpenAI 兼容协议（健壮性增强）。 |
| 思考深度 | 新增 `thinkingLevel` 选项（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，缺省 `off` = 旧行为）与 `config.llm.thinking_level`：pi 以 `options.reasoning` 下发，模型不支持时 pi-ai 在请求时自动 clamp。 |
| 会话 | 旧实现的 `saveSession/loadSession/tag/rename/fork` 未迁移；wiki 生成是一次性 agent，不需要。若 CLI 后续要做"会话聊天"，需接 pi 的 JSONL 会话树。 |
| 上下文窗口/定价 | 旧 `MODEL_PRICING` 表未迁移，`Model` 用保守默认（200k 窗口 / 8k 输出、cost=0）。pi 的 usage 记账照常工作，只是成本字段为 0。 |
| 最大轮次 | 第十步起内核**不再数轮次**：`config.agent.max_turns`（缺省 30，`0` = 不限制）折算成 token 预算（`max_turns * 25000`），软提示（70% 预算）+ 硬提示（预算将尽）经 harness 的 `before_run` 注入，`before_run_end` 决定终止或强制交卷（详见 §12.4）。新增 `agent.token_budget` 可直接配置 token 预算。 |
| 上下文压缩 | 第十步起用 harness 内建压缩（run 边界按 `model.contextWindow - reserveTokens` 触发；`system/compact_boundary` 事件不变，摘要请求额外消耗一次模型调用）；泄漏到 provider 的上下文溢出按 pi-ai 的 `isContextOverflow` 归类并映射回 `error_context_full` 与既有「Context window nearly full」文案；`compaction.enabled=false` 用 `before_compaction` decline 保证一个摘要请求都不发（详见 §12.4）。 |
| 事件粒度 | `assistant` 事件在 `message_end` 产出（完整内容 + usage）；流式增量以 `partial_message` 产出（旧引擎同形）。 |
| 成功判定以落盘为准 | `generateWikiCatalog()` 在 Agent 正常结束后校验 `wiki.json` 可加载；`generateWikiContent()` 校验 `.zread-pi/wiki/<section>/<file>` 真实存在，否则记为失败（抛错/`page_error`）。旧实现把「Agent 循环正常结束」当作完成，模型只输出文字、写到错误路径或被 Mermaid 校验拦截时会显示完成，但首页按文件检查仍显示未完成；现以磁盘产物为唯一判定依据。**落盘兜底**：`write_page` 已成功但文件不在约定路径时（典型：漏传 `section` 落到 wiki 根、只传 `slug` 写成 `<slug>.md`），按「write_page 报告的真实路径 → 模型传入参数复算 → wiki 目录按文件名扫描（跳过 `archived/` 快照）」三层候选找到文件并移动回约定位置，移动成功仍计为完成，不再误报「写入路径与 wiki.json 不一致」。 |
| 浏览文档服务器 | 旧实现源码运行（非打包）时固定返回 `http://localhost:5173`（外部 Vite dev server 的地址），未另起 Vite 时浏览器 ERR_CONNECTION_REFUSED。现返回的一定是真实监听地址：有构建产物（打包 `dist/browse` 或源码 `apps/browse/dist`）时 API + 静态资源同端口（SPA fallback）；源码且未构建时进程内启动 Vite dev server，并把 `/api` 代理到 API 端口；启动失败（端口占用/资源缺失）在 TUI 直接显示原因。 |

## 5. 风险与未决项

1. **MCP 缺失**：pi 文档无 MCP 能力。当前 wiki 链路不需要；若 `cli`/browse-chat 需要用户配置的 MCP 工具，应把 `agent-sdk/src/mcp/client.ts` + `tool-helper.ts` 作为独立小包保留并适配成 pi 工具（pi 支持运行时 `registerTool`）。
2. **会话能力缺口**：tag/rename/list/fork 在 pi 文档中无直接对应，需用值存储/自定义条目实现或放弃。
3. **React 18/19 混装（已解除）**：原因为 Ink（React 18）与 browse（React 19）冲突。
   CLI 换成 pi-tui 后已不再依赖 React，`apps/browse` 已重新列入根 workspaces（依赖随根 `bun install`）；
   修复了源码运行「浏览文档」因漏跑 `bun run browse:install` 而报「未找到前端资源，也无法启动 Vite」的问题。
4. **pi 内核版本**：vendor 快照为 0.85.1（与 npm 发布版同版本号）。升级 pi 时需重跑 `bun run vendor:build` 与 `bun run test`。
   `ai` 包现在编译到 `providers/all.ts` + `auth/oauth/*` + `providers/data/*.json`（为了配置界面的 Provider 目录与 pi-ai 登录能力，见 §8）；升级后需同步更新 data JSON。
5. **真机联调**：全部测试使用离线 faux / 本地 mock HTTP；**尚未用真实 API Key 跑过完整 wiki 生成**。建议首次验证：`bun run cli config` 配好 key → 在目标仓库执行 `bun run cli`，重点观察 retry 事件、压缩触发（`system/compact_boundary`）与**真实 usage**（据此调整 `agent.token_budget`，见 §12.8）。

## 6. 后续可选路径

1. **pi 的压缩能力已接入**（第十步起为 harness 内建压缩：threshold + overflow 恢复，见 §12）；后续可把 `compaction.reserveTokens` / `keepRecentTokens` 与 `agent.token_budget` 一起暴露到配置界面。
2. **接入 pi 的用量与成本**：`Model.cost` 填真实定价后，`usage.cost` 可直接回传 UI（旧 `estimateCost` 的替代）。
3. **会话化**：把 `cli` 的聊天类命令接到 pi 的 `JsonlStorage` 会话树，得到分支/压缩/恢复能力。
4. **扩展点**：需要子代理/权限弹窗/计划模式时，优先用 pi 的扩展 API（`registerTool` / `tool_call` 事件 / `beforeToolCall` 阻断），而不是回填旧工具。

---

## 7. CLI TUI 迁移（Ink 4 + React 18 → pi-tui）

### 7.1 原则

**只换底座，不改业务与观感**：页面的选项列表、状态文案、颜色、快捷键（↑↓/j k/Enter/ESC/s/r// ]、ctrl+c 退出）
以及所有编排/落盘逻辑保持与迁移前一致；被替换的只有「渲染 + 输入」层。

### 7.2 改动清单

| 动作 | 对象 |
|---|---|
| 新增 vendor | `vendor/pi/packages/tui`（pi-tui 0.85.1：`src/` + `native/` + `package.json` + `tsconfig.build.json`） |
| 新增 | `apps/cli/src/tui/`（App / Layout / Router / Screen + Divider、RoundedBox、Select、TextField、StatusIcon、ANSI） |
| 新增 | `apps/cli/src/state/`（ConfigStore / I18nStore / WikiStore，替代原 React Context + useImmer） |
| 改写 | 11 个页面：`views/*/index.tsx` → `views/*/index.ts`（Screen 子类）；`wiki-generate`、`wiki-sync` 的 Hook 合并为 `controller.ts` |
| 保留不动 | `views/*/mapper.ts`、`state.ts`、`types.ts`（纯函数）与 `views/wiki-sync/__tests__/*`；`commands/browse-server.ts`、`browse-chat*.ts`；i18n 字典；`theme.ts` |
| 删除 | `App.tsx`、`index.tsx`、`layout/*.tsx`、`provider/**`、`components/*.tsx`、`i18n/useI18n.ts`、`views/wiki-generate/{components,hooks}`、`views/wiki-sync/hooks` |
| 依赖变更 | `apps/cli` 新增 `@earendil-works/pi-tui`；移除 `ink`、`ink-*`、`fullscreen-ink`、`react`、`react-router`、`zustand`、`use-immer`、`@types/react`、`ink-testing-library` |
| 构建 | `tsup` 入口 `src/index.tsx` → `src/index.ts`，去掉 ink 的 react-devtools mock 与 yoga.wasm 拷贝；`scripts/dev.ts` 同步 |
| 验证 | 新增 `bun run test:tui`（151 + 16 + 9 + 25 + 19 + 28 项），并纳入根 `bun run test` |
| 可用性补强 | 列表窗口化分页（`computeItemWindow` / `scrollIndicator`）、PageUp·PageDown·Home·End、终端高度自适应、console 接管（`console-guard.ts`） |
| 新增全局选项 | `-d, --dir <path>`：入口切一次 `process.cwd()`（业务层零改动），TUI 头部显示实际目标；目录不存在/不是目录时不进入 TUI，单行错误 + 退出码 1。实现 `apps/cli/src/utils/target-dir.ts`，回归 `apps/cli/test/cli-target-dir.ts` |

### 7.3 映射关系与语义对齐

| 迁移前 | 迁移后 | 对齐要点 |
|---|---|---|
| `withFullScreen()`（备用屏幕） | `TuiAltScreen` + `setLayoutRoot` | 全屏渲染，`[?1049h/l` 进出备用屏幕 |
| Ink `<Box borderStyle="round">` | `components/rounded-box.ts` | 撑满宽度、`╭─╮` 边框、paddingX=1 |
| Ink `<Text>` 自动换行/截断 | `ansi.ts` + `text-layout.ts`（`visibleWidth`/`truncateToWidth`） | 逐行不超出终端宽度（pi-tui 渲染器会抛错） |
| `useInput`（多个 handler 同时触发） | pi-tui 聚焦分发 → `Screen.handleInput` → `Screen.handleKey` | `App` 只拦截全局键（ctrl+c / ESC）并 consume，其余按键交给 pi-tui 分发给聚焦页面；pi-tui 分发后会自动请求重绘，Kitty 协议的松开事件也由它统一过滤。ESC 由 `Screen.handleKey` 返回 `true` 抢占，等价原 `claimEsc` |
| Layout 的统一 ESC 逻辑 | `App.handleGlobalEscape()` | `location.key !== "default"` → `navigate(-1)`；根页面退出 |
| `ink-select-input` | `components/select.ts` | ↑↓/k/j 回绕、`return` 确认、值列表变化重置选中项、`onHighlight` |
| `ink-text-input` | `components/text-field.ts` | ↑↓/Tab/Shift+Tab 忽略；Delete 同 Backspace；Enter 提交；光标置尾（pi-tui 的 `setValue` 不移动光标，已补 End 键） |
| `useImmer` 状态 | 普通 store 类 | 原有 `setField`/`hasChanges`/`save` 语义保留（`originalConfig` 用深拷贝做基线） |
| WikiProvider 的 `reload()` | `WikiStore.reload()` | 目录生成完成/同步完成后重新读取 `wiki.json`；各 wiki 页面在 `onEnter` 先 `load()` 再启动流程 |
| `useWikiGenerate`/`useWikiSync` 三/两个 Hook | `views/*/controller.ts` | 流程与判定条件逐条保留（含 `flowState` 与 `pagesInitializedRef`/`articlesStartedRef` 等防重入语义） |
| react-router `navigate(-1)`、`replace` | `tui/router.ts` | 首条目 key = `"default"`；`replace` 用新 key 替换当前条目 |

### 7.4 已知差异（有意为之）

| 差异 | 说明 |
|---|---|
| Delete 键 | pi-tui 的 `delete` 是向后删除；`TextField` 将其映射为 Backspace，保持 ink-text-input 的行为。 |
| `ConfigConcurrencyPage` / `ConfigRetryPage` 的 `s` 键 | 与 Ink 版一致：页面级按键使用「按键前」的值（React 闭包语义），输入框同时收到按键。 |
| 长列表溢出 | 不再把整张表铺开：只渲染窗口内的项，选中项始终可见，末尾显示 `↑ (n/总数) ↓`。这是对迁移前行为的**有意修正**（Ink 版会把选中项跑到屏幕外，看起来「不刷新」）。 |
| 翻页按键 | 新增 `PageUp`/`PageDown`/`Home`/`End`；同时释放备用屏幕默认占用的这些键（`setKeybindings`），否则会被视口滚动吞掉。原有 `↑↓` `j` `k` `Enter` `r` `/` `s` `esc` `ctrl+c` 行为不变。 |
| 杂散输出 | TUI 期间 `console.*` 被转存到 `~/.zread-pi/logs/zread-pi-*.log`（防止花屏），退出时还原。 |
| 直接进入子路由 | `/wiki/generate`、`/wiki/sync` 先 `await wiki.load()` 再启动流程，避免误判「无 wiki.json」而触发扫描（Ink 版由 WikiProvider 挂载保证）。 |
| 硬件光标 | 仍使用反色假光标（与 Ink 一致），未开启真实硬件光标；`CURSOR_MARKER` 已保留以备后续 IME 定位。 |
| 按键重绘与松开事件 | 页面按键必须走 pi-tui 聚焦分发（`Screen.handleInput`），由 pi-tui 在分发后自动 `requestRender`；页面不得自行转发后依赖手动 `refresh()`（否则 ↑↓ 改了选中项但屏幕不动，需点鼠标才刷新）。`ProcessTerminal` 启用 Kitty 协议（flags=7）时会同时上报松开事件，由 pi-tui 按未声明 `wantsKeyRelease` 过滤，一次按键只处理一次。 |
| 鼠标 | pi-tui 提供鼠标能力，但本 CLI 未接入（迁移前也没有）。 |

### 7.5 风险与未决项

1. **真机交互未人工验证**：自动化回归覆盖了按键注入、全部路由渲染、长列表分页、终端高度变化、真实 `ProcessTerminal` 启动/退出，但 IME 候选框定位、Windows 下的 Shift+Enter、剪贴板、鼠标仍未人工确认。
2. **页内其他内容不滚动**：分页只作用于列表；若页面非列表部分（如自定义 Provider 的多个步骤）本身就超过终端高度，仍会被裁剪（与迁移前一致）。
3. **`parseFiles` 期间的卡顿**：Tree-sitter 首次解析会同步下载/初始化 WASM，主线程被占用时加载动画无法刷新（迁移前同样存在）；本次未改 repo-analyzer。
4. **pi-tui 与上游同版本（0.85.1）**：后续升级需重跑 `bun run vendor:build && bun run test:tui`。
5. **`tui` 包的构建差异**：上游用 `tsgo`，本仓库用 `tsc` 并把 target/lib 提到 ES2024（`utils.ts` 里用了 `v` 正则标志，ES2022 下 TS 报 TS1501）。
6. **`apps/browse` 已并入根 workspaces**：CLI 无 React 依赖后合并没有冲突；根 `bun install` 即装齐浏览站依赖，
   源码运行「浏览文档」直接走进程内 Vite 兜底（此前为独立安装，漏跑 `browse:install` 会导致启动失败）。

---

## 8. 配置界面接入 pi-ai Provider 目录 / 登录 / 自定义模型（第三步）

### 8.1 目标

要求把「配置界面 → 模型提供商」从自维护的 provider registry（LiteLLM 缓存）换成 **pi-ai 原生能力**：

1. 使用 pi-ai 的内置 Provider 目录与 `Providers.login()`（配置界面只提供 API Key；OAuth 能力保留在 catalog/运行时，可手写 `auth.json` 使用）；
2. 同时配置多个 Provider；
3. 按 Provider 刷新模型目录；
4. 为指定 Provider 添加自定义模型。

### 8.2 改动清单

| 动作 | 对象 |
|---|---|
| vendor ai 构建扩容 | `tsconfig.app.json` include `providers/all.ts`、`bun-oauth.ts`、`auth/oauth/*`；补齐同版本 `src/providers/data/*.json`（0.6MB，来自 npm 0.85.1 发布包） |
| 新增 | `packages/agent-runtime/src/pi/provider-catalog.ts`：`builtinProviders()` + 配置叠加 + 自定义模型 + 刷新 + 登录（api_key）/登出 |
| 新增 | `packages/agent-runtime/src/pi/auth-store.ts`（`~/.zread-pi/auth.json` 的 CredentialStore）、`models-store.ts`（`~/.zread-pi/models-store.json` 的 ModelsStore） |
| 新增 | `packages/agent-runtime/test/provider-catalog-smoke.ts`（25 项，离线） |
| 配置结构 | `LLMConfig` 新增 `providers: Record<string, LlmProviderConfig>`（name / base_url / api / auth_type / model / models）；`CustomModelConfig` 支持窗口/输出/推理/图片 |
| 配置工具 | `packages/utils` 新增 `getZreadAuthPath()` / `getZreadModelsStorePath()` / `getProviderConfig()` / `normalizeProviderConfigs()`；`isFirstTimeConfig` 改为「provider+model 已选即已配置」 |
| 运行时 | `createRuntimeModel()` 优先走 catalog（真实模型元数据 + OAuth 刷新 + 自定义模型），未命中回退单模型 Provider；`createAgent` 无 apiKey 时若 provider 在 catalog 中不再报错 |
| CLI | `views/config-provider`、`views/config-provider-detail`（API Key + 模型并列，替换 config-model + config-auth）；新增 `views/config-custom-model`（自定义模型表单）；`ConfigStore` 新增 per-provider 与自定义模型写入；`utils/llm-config.ts` 负责旧字段迁移；`utils/provider-id.ts` 负责把自定义 Provider 的显示名 slug 化并去重（纯函数） |
| 旧路由兼容 | `/config/provider/:id/custom` 仍可用（等价 model-new） |

### 8.3 与旧实现的行为差异

| 差异 | 说明 |
|---|---|
| Provider 列表来源 | 由 LiteLLM 在线目录（`~/.zread-pi/providers.json`，24h 缓存）改为 pi-ai 内置目录（离线可用、40 个 Provider），未内置的已配置端点仍会列在末尾 |
| 登录方式 | 配置界面只提供 API Key（写入 `auth.json`，同一 Provider 只保留一份凭据）；Provider 详情页把「API Key 配置」与「模型选择」并列在同一页面（tab/Shift+Tab 或 ↑ 切换焦点，仅 `Models.login('api_key')`）；OAuth 订阅流程仍保留在 provider-catalog/运行时中（可手写 `auth.json` 使用），但界面不再提供 |
| 多 Provider | `llm.providers.<id>` 保存每个 Provider 的名称（`name`，缺省用 id）/ 端点 / 模型 / 自定义模型；`auth.json` 可同时保存多份凭据；provider 列表逐项显示登录状态（自定义 Provider 带 `[自定义]` 徽标） |
| 自定义模型 | 新增独立表单（id / 名称 / 上下文窗口 / 最大输出 / 思考 / 图片），按 pi models.json 语义覆盖或追加 |
| 模型刷新 | 详情页 `r` 调用 pi-ai `Models.refresh()`（动态 Provider 请求远端目录并缓存到 `models-store.json`；静态目录提示「无需刷新」） |
| 旧配置兼容 | 首次在新界面切换 Provider/模型时，`llm.api_key` → `auth.json`、`llm.base_url` → `llm.providers.<id>.base_url`，然后清空旧字段；未知 providerId 仍回退 OpenAI 兼容协议 |
| 未内置 Provider | 仍可从零配置，实现改为 pi `createProvider()` 动态注册。**自定义 Provider 流程已升级为「名称 → Base URL → 协议 → 详情页」**：新建时可填写显示名称（id 由名称自动 slug 化并与内置/已配置 id 去重）、Base URL 与 API 协议（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`，`t` 切换）；保存后直接进入与内置 Provider 同一款的详情页，API Key 录入与**多个**自定义模型都在详情页完成。详情页对自定义 Provider 额外提供 `e` 编辑入口（`/config/provider/:id/edit`，改名称/端点/协议，id 与凭据/模型不变） |

### 8.4 验证

```bash
bun run typecheck
bun run test:catalog    # 45/45
bun run test            # 全部套件（含 test:context 35/35、TUI 151 + 路由 16 + 真实终端 9 + mock 全链路 19）
```

### 8.5 思考深度（pi thinking level，第四步）

配置界面新增 `/config/thinking`（配置首页「思考深度」项），把 pi 的 7 个等级暴露出来：

- 配置字段：`LLMConfig.thinking_level`（`ThinkingLevel`），旧 `config.yaml` 缺少该字段时 `validateConfig` 归一化为 `off`；
- UI：`apps/cli/src/views/config-thinking` 列出全部等级；已选模型时用 `getZreadThinkingLevels(provider, model)`
  （内部为 pi-ai `getSupportedThinkingLevels`）标注「当前模型不支持，请求时自动调整」；
- 运行时：`createAgent({ thinkingLevel })` → pi `Agent` 的 `initialState.thinkingLevel`，
  `off` 不发送 reasoning，其余作为 `options.reasoning` 传给适配器（pi-ai 内部 clamp）；
- Orchestrator 的 `create-agent.ts` 读取 `config.llm.thinking_level` 并随每次 Agent 创建下发；
- 项目信息框新增「思考深度」一行，直接展示当前生效档位。

### 8.6 最大轮次配置 + pi 上下文压缩（第五步）

> **已被 §12（第十步）取代**：裸 agent loop 换成 `AgentHarness` 后，轮次不再参与判定（`max_turns` 只作为
> token 预算的折算依据）、收尾提示改由 `before_run` 注入、压缩由 harness 内建承担。
> 本节保留当年的实现记录与决策理由，**当前实现以 §12 为准**。

两个相关的运行时能力一起落地：

**a) `agent.max_turns` 不再硬编码**

- 配置：`AppConfig.agent.max_turns`（0-100，默认 30；`0` = 不限制轮次）；`validateConfig` 对旧 `config.yaml` 自动补齐；
- UI：配置首页「最大轮次」项 → `/config/max-turns`（`apps/cli/src/views/config-max-turns`）；
- Orchestrator：`agents/create-agent.ts` 改为 `options.maxTurns ?? config.agent.max_turns ?? 30`，`wiki/generate-wiki.ts` 删除写死的 `maxTurns: 30`（`GenerateWikiOptions.maxTurns` 仍可显式覆盖）。

**a2) 轮次收尾：提示 + 宽限轮（`finalization`）**

- 适配层在 `shouldStopAfterTurn` 中倒数第 1 轮/每个宽限轮前通过 `agent.steer()` 注入一条 user 消息（`FinalizationOptions.notice`，缺省英文文案）；
- Orchestrator 按 `doc_language` 下发本地化文案并点名输出工具（`write_page` / `generate_blueprint`）；
- 宽限轮数 `graceTurns` 缺省 1（因此实际最多 `max_turns + 1` 轮），`0` 可回到旧行为；上下文将满时优先压缩/优雅停止，**不**发宽限轮；
- `max_turns = 0` = 不限制轮次：适配层跳过全部轮次收尾逻辑（不发提示、不因轮次停止），上下文保护仍然生效；Orchestrator 也不下发收尾提示；
- 本轮无工具调用（模型已给出最终答复）时不受轮次/上下文预算影响，避免把「刚好在最后一轮完成」误判为失败。

**b) 上下文压缩与优雅停止（pi `transformContext` + `compaction`）**

- `packages/agent-runtime/src/agent.ts` 在每次请求前（`transformContext`）用 `estimateContextTokens` + `shouldCompact`
  判定，超阈值时把消息转成 pi 的 `Entry[]` 调 `prepareCompaction` / `compact` 生成结构化摘要，
  并以「`compactionSummary` + `retainedTail` + 压缩后新增的消息」作为后续请求的上下文；
- 压缩成功向业务侧发 `system/compact_boundary`（`SDKCompactBoundaryMessage`，与旧 SDK 消息类型对齐）；
- `shouldStopAfterTurn` 仍负责轮次计数（`maxTurns`），同时检查上下文用量：
  如果上下文将满且压缩已无法腾出空间（单个巨大 turn、可总结内容为空、摘要请求失败/关闭压缩），
  在轮次边界优雅停止并产出 `subtype: "error_context_full"`；
- `convertToLlm` 改用 pi harness 版本，保证 `compactionSummary` 消息能转成模型可见的 user 消息；
- 测试：`packages/agent-runtime/test/context-compaction.ts`（`bun run test:context`，39 项）覆盖
  「压缩后继续 success」「压缩无法腾空 → error_context_full」「关闭压缩 → error_context_full」
  「最后一轮软提示 + 宽限轮提示 → success」「仍不收敛 → error_max_turns」「graceTurns=0 = 旧行为」「最后一轮完成不误报失败」
  「maxTurns=0 = 不限制轮次（不发收尾提示、不因轮次停止）」。

---

## 9. 工具层对齐上游 pi（第六步）

目标：把 Agent **可见的工具层**从「迁移时原样拷贝的 5 个文件工具」升级为「按上游 pi 实现重写 + 补齐缺失能力」，
让工具在 Windows / Linux / macOS 上等价可用，且不再依赖 POSIX-only 命令（旧实现里 `spawn('bash')` 的兜底分支在 Windows 上等于不可用）。

### 9.1 决策：不引入 `pi-coding-agent`，能力走「复制 + 改写」

上游工具实现分散在 `packages/coding-agent/src/core/tools/*` 与 `packages/agent/src/harness/tools/*`；
前者所在的 `pi-coding-agent` 包未在 `exports` 里暴露工具子路径，且与既有「不引入 pi-coding-agent」的迁移决策冲突。
因此本轮全部按「复制 + 改写」移植，并在文件头注明来源；`vendor/pi/**` 源码零改动。

可直接复用的部分（vendor 已导出）**不复制**：`@earendil-works/pi-agent-core` 已导出
`truncateHead` / `truncateTail` / `truncateLine` / `formatSize` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`
（`tools/truncate.ts` 只是薄封装 + 统一的提示文案拼装）。

### 9.2 决策：rg / fd 只探测、不下载

上游 `utils/tools-manager.ts` 在缺失时从 GitHub Releases 自动下载并解包（tar.gz/zip、chmod、
Windows 用 `System32\tar.exe` 或 PowerShell `Expand-Archive`）。本轮**刻意不移植这段**：

| 方案 | 取舍 |
|---|---|
| 自动下载（上游做法） | 运行期静默联网 + 解包可执行文件，失败面大；解包分支依赖 tar/unzip/PowerShell，是三平台最易碎的一段 |
| **探测已有 → 有则用，没有则纯 JS 兜底（采用）** | 无联网、无解包；能力不降级（`file-walk.ts` + `glob-match.ts` 实现同一套语义），只牺牲一点速度 |
| 缺失即报错 | 在没装 rg/fd 的机器上直接失去搜索能力，与「开箱可用」冲突 |

两条路径**必须给出同一套可见文件集合**，因此：

- 都用 `.gitignore` / `.ignore` / `.fdignore`，并且**不在 git 仓库内也生效**
  （fd 加 `--no-require-git`；rg 加 `--no-require-git`；JS 兜底天然生效）；
- 都跳过 `.git` / `node_modules` / `.zread-pi`（fd 用 `--exclude`，rg 用 `--glob '!**/<dir>/**'`）；
- 都输出「相对搜索根的 POSIX 风格路径」，并按字典序排序；
- 单测 `test:tools` 对同一条查询跑两条路径并断言结果一致。

环境变量 `ZREAD_PI_RG_PATH` / `ZREAD_PI_FD_PATH` 可显式指定二进制（测试用它模拟缺失，也便于打包/离线场景）。

### 9.3 工具变化清单

| 工具 | 动作 | 关键变化 |
|---|---|---|
| `Ls` | **新增** | 目录列举（排序 + 目录后缀 + 条目/字节双上限）。补齐能力缺口：旧 `Read` 对目录的报错文案点名 `Bash`，而本仓库**从未注册 Bash 工具** |
| `Glob` | 替换 | 去掉 Node 实验 API + `spawn('bash')` 兜底；改为 fd 优先 + 纯 JS 兜底；输出相对 POSIX 路径并排序；尊重 .gitignore；`limit` 可调 |
| `Grep` | 替换 | rg `--json` **流式**解析（旧实现全量缓冲，命中上限形同虚设）；输出相对路径；rg/grep 双分支不一致 → 「rg + 纯 JS 兜底」同格式；新增 `ignoreCase` / `literal` / `context` / `limit`；长行截断 500 字符；保留 `output_mode`（content / files_with_matches / count） |
| `Read` | 替换 | 图片按 **magic number** 判型（不再只看扩展名），模型支持图片时回传 image 内容块；1-based `offset`；行/字节双上限 + `Use offset=N to continue.` 续读提示；目录报错点名 `Ls`；非图片二进制不再灌乱码；参数 `file_path` 保留，并接受上游别名 `path` |
| `Write` | 替换 | 同文件并发写**串行化**（`withFileMutationQueue`）；结果文本用请求路径；`details.created` 标记新建/覆盖 |
| `Edit` | 替换 | BOM / CRLF 归一化（旧实现在 CRLF 检出上必然匹配失败）+ fuzzy 兜底；支持 `edits[]` 多段不相邻替换；`replace_all` 保留；回传 diff / unified patch / 首行变更行号；同文件并发编辑串行化 |
| 输出截断设施 | 复用 | 统一 2000 行 / 50KB 双上限，替换旧工具里的硬编码（旧 `Read` 只有 2000 行、旧 `Grep` 只有 250 条且无字节上限） |

### 9.4 契约扩展（均为向后兼容的「新增可选」）

```ts
ToolContext.supportsImages?: boolean      // 由 createAgent 按 model.input 注入；undefined = 无法判定
ToolResult.details?: JsonValue            // 结构化元信息（截断/diff/命中上限），不进入模型上下文
SDKToolResultMessage.result.details?: ... // 同上，透传到 SDK 事件，供钩子/UI 消费
```

- `ToolResult.content` 从「只当字符串用」扩展为「可以是内容块数组」，从而支持 image 回传
  （此前非字符串会被 `JSON.stringify` 成文本，图片会变成 base64 垃圾）；
- `Read` 仅在 `context.supportsImages === true` 时发送 image 块；未知或不支持时退化为文本说明，
  避免把图片发给不支持图片输入的模型导致请求被 provider 拒绝；
- `defineTool({ call })` 的返回值新增 `{ content, details }` 形态；原有的 `string` 与 `{ data, is_error }`
  两种形态保持不变（`write_page` / `generate_blueprint` 等业务工具零改动）。

### 9.5 验证

- `bun run test:tools`（新增，95 项）：截断设施、glob 语义、Ls / Glob / Grep / Read / Write / Edit 的行为与错误文案、
  **rg/fd 与纯 JS 兜底两条路径结果一致**（同时在「非 git 仓库」与「git 仓库内」两种搜索根上覆盖
  `.gitignore` 语义）、同文件 16 路并发编辑不丢更新、`details` 与 image 块真的穿过桥接层进入模型上下文。
- 回归：`bun run test`（typecheck + catalog 32/32、agent 11/11、tools 95/95、installer 70/70、agent:http 7/7、provider 5/5、
  analyzer 5/5、blueprint 7/7、pages 8/8、context 35/35、tui 185+19+9+25+19+24）；`bun run mock:wiki`（completed=4 failed=0）。

### 9.6 未决项（需要人类拍板）

1. **`Bash` / `PowerShell` 未迁移**：本轮只做「文件与搜索」工具。若后续要 shell 执行能力，需先定方案
   （沙箱/审批/超时/输出截断/Windows 分支），本仓库现状**不应**在提示词里引用 shell 工具。
2. **rg/fd 自动下载**：若确认要「开箱即用且更快」，可后续按上游 `tools-manager.ts` 走 vendor 流程移植，
   但需接受三平台解包失败面与运行期联网。
3. **`Read` 的图片缩放**：上游有 `processImage`（自动缩放到 2000x2000，依赖 photon）；本轮未引入该依赖，
   大图直接按原字节发送。若真机出现「图片过大被 provider 拒绝」，再补缩放。
4. **`Grep` 的 `type` 参数**：旧实现有 `type`（rg `--type ts`）；上游无该参数，本轮用 `glob` 覆盖该场景，
   若模型习惯用 `type` 可再加回（映射到 `--type` 或扩展名 glob）。

---

## 10. 外部工具安装与配置界面（第七步：rg / fd）

### 10.1 目标

第六步把搜索工具改成「有 rg/fd 就用、没有就纯 JS 兜底」，但用户无法在应用内获得这两个二进制。
本步补齐「安装」这一环，并且**把安装的决定权交给用户**：agent 运行期仍然绝不隐式联网，
安装只能在配置界面（或等价的命令行入口）里由用户显式触发。

### 10.2 分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 注册表（扩展点） | `packages/utils/src/tools/registry.ts` | `ToolSpec`：id / 仓库 / 资产名规则 / 版本探测 / 用途 / 校验文件。**新增工具只需加一条**，配置界面、安装器、状态探测、CLI 入口都会自动跟上 |
| 安装器 | `packages/utils/src/tools/installer.ts` | `resolveToolBinary` / `getToolStatus`（同步探测：环境变量 → 托管目录 → 系统 PATH，用户停用即不用）、`installTool`（解析版本 → 下载 → 校验指纹 → 解包 → 落盘 → `--version` 校验）、`uninstallTool`、`onToolsChanged`（变更广播，用于让 agent-runtime 的探测缓存失效） |
| 归档解包 | `packages/utils/src/tools/archive.ts` | 纯 JS 的 `.tar.gz`（ustar + GNU LongName）与 `.zip`（stored / deflate）解析，含 zip-slip 防护 |
| 配置 | `packages/types` + `packages/utils/src/config` | `tools.<id>.enabled`（旧 `config.yaml` 缺省 `true`，零迁移）；`normalizeToolsConfig` 以注册表为准合并 |
| 运行时 | `packages/agent-runtime/src/tools/search-binaries.ts` | 薄缓存层，委托 `resolveToolBinary`，并订阅 `onToolsChanged` 失效缓存（同一进程内装完即可用） |
| TUI | `apps/cli/src/views/config-tools/` | 列表页（总体就绪进度条 + 每工具状态）+ 详情页（字段展示、安装/卸载/启用停用、**安装进度条**） |
| CLI 入口 | `tools/tool-install.ts`（`bun run tools:install`） | 无头环境：列状态 / 安装（可指定版本）/ 卸载，与界面同一份实现 |

### 10.3 与上游 `utils/tools-manager.ts` 的差异（有意为之）

| 项 | 上游 | 本仓库 |
| --- | --- | --- |
| 触发时机 | agent 启动时静默下载缺失工具 | **仅用户显式触发**（配置界面 / `tools:install`）；运行期只探测 |
| 解包 | 依次尝试 `tar` / `unzip` / `unzip+tar` / `System32\tar.exe` / PowerShell `Expand-Archive` | **纯 JS**（`zlib.gunzipSync` / `inflateRawSync` + 自写容器解析），无外部命令依赖，三平台一致 |
| 完整性 | 不校验 | ripgrep 发布 `<asset>.sha256` 时**先校验指纹再解包**；fd 不发布则跳过（不做自签名的伪验证）；安装后必须能执行 `--version`，否则删除半成品并报错 |
| 进度 | 仅状态文案（`onStatus`） | 结构化进度回调（阶段 + 百分比 + 已下载字节），界面用进度条 + 百分比 + 字节展示；同时打开终端原生忙指示（OSC 9;4） |
| 安装位置 | `getBinDir()` | `~/.zread-pi/bin`（可用 `ZREAD_PI_TOOLS_DIR` 覆盖；与 `~/.zread-pi/parsers` 同级） |
| 镜像 | 无 | `ZREAD_PI_TOOLS_BASE_URL` 可指向目录结构与 GitHub Releases 一致的内网镜像 |

### 10.4 资产名踩坑记录（真实 release 对过）

- **fd 的资产名带 `v` 前缀**：`fd-v10.5.0-x86_64-pc-windows-msvc.zip`；
- **ripgrep 不带**：`ripgrep-15.2.0-x86_64-pc-windows-msvc.zip`；
- 两者不能共用同一个命名模板（首次真机验证时 fd 下载 404 就是这个原因，现已固化为 `test:installer` 的断言）。

### 10.5 版本探测与可用性解耦（第八步：不再依赖 `--version`）

问题：早期实现把「`--version` 能跑通并输出 x.y.z」同时当成了三件事——可用性判定、安装校验、版本展示。
只要未来接入的工具不符合这个习惯（无版本开关 / 版本写 stderr / 退出码非 0 / 输出不是 x.y.z），
就会出现「工具明明能跑，却被当成未安装」或「安装完了却报校验失败」。

| 维度 | 旧行为 | 现行为 |
| --- | --- | --- |
| 可用性判定 | `probeBinary` 返回 undefined ⇐ 探测失败 | 只看 `BinaryProbeResult.runnable`（进程能否启动）；版本缺失不影响 |
| 版本参数 | 单一 `spec.versionArgs`（缺省 `['--version']`） | `spec.versionProbeArgs: string[][]`，缺省 `[['--version'], ['-V'], ['version']]` 依次尝试，任一组解析出即用 |
| 版本正则 | 只认 `x.y.z` | 缺省 `1.2 / 1.2.3 / 1.2.3-rc1`，并可由 `spec.versionPattern` 覆盖 |
| 探测环境 | 在进程 cwd 执行 | 在 `os.tmpdir()` 执行 + 3s 超时 + stdin 关闭（避免把“版本参数”当路径参数的工具去扫用户仓库） |
| 安装校验 | 必须能读出版本号，否则删二进制报错 | 只要能执行即通过；失败时附上探测原因（如 `ENOEXEC`） |
| 版本记录 | 无（只靠探测） | 安装台账 `~/.zread-pi/tools-state.json` 记录「当初装的版本/资产/时间」 |
| 不一致 | 无概念 | 探测版本≠台账版本 → `versionMismatch` 仅在 UI 提醒（黄色），不阻断；二进制被手动删除 → 台账作废，状态回 `missing` |
| UI | 没版本号就什么都不显 | 台账版本 + 「未识别（不影响使用）」，并在识别失败时展示探测参数与输出首行供诊断 |

测试（`test:installer` 第 6 节）覆盖：多组参数回退、识别不出版本仍可用、
读不出版本也能安装成功且台账记录了版本、台账落盘可新进程读取、版本不一致只提示、
台账不参与可用性（文件被删后状态回 `missing`）；`smoke-tui` 覆盖「版本未知」的展示文案。

真机踩到的两个边角（已固化为断言）：

1. **探测输出过大**：把 `version` 当搜索模式的工具会输出大量内容，撞上 `spawnSync` 的 maxBuffer
   → 旧代码会因 `error` 存在而判为不可用；现改为「除启动类错误（ENOENT/EACCES/ENOEXEC/…）外，
   其余错误（ENOBUFS/超时）都算已启动，只是读不出版本」。
2. **探测位置**：探测固定在一个专用空目录（`os.tmpdir()/zread-pi-probe-*`）里执行，
   不在用户 cwd 也不在共享 tmpdir，避免“版本参数被当模式参数”时扫到一堆无关文件（断言：
   探测脚本打印的 cwd 必须是该专用目录）。

### 10.6 验证

- `bun run test:installer`（新增，70 项，离线）：注册表与资产名、归档解包（含 zip-slip 与长路径）、
  配置归一化（旧配置零迁移）、安装全流程（本地 mock Releases + 注入探测：阶段齐全 / 百分比单调 / 指纹不匹配拒绝解包 /
  校验失败不留下半成品）、卸载、启用开关。
- `bun run test:tools`（95 项）：追加「启用开关 → `findSearchBinary` → 纯 JS 兜底」的联动与缓存失效断言。
- `bun run test:tui`（185 项）：新增工具列表页与详情页的布局、导航、启用/停用/保存、进度条字符断言；
  `render-all-routes` 覆盖到 19 条路由（无超宽行）。
- **真机验证**（本次手动执行，非 CI）：对真实 GitHub Releases 安装并执行成功——
  `ripgrep 15.2.0 (rev e89fff89ac)`、`fd 10.5.0`；卸载后状态回落到 `system`/`missing`。

### 10.7 未决项

1. **代理 / 自签证书环境**：首次真机验证时遇到过 `unknown certificate verification error`（该环境经代理，
   Bun 的 TLS 校验偶发失败，重试即恢复）。目前只能靠镜像变量或手动安装绕过；后续可考虑读取
   `HTTPS_PROXY` / 自定义 CA 的显式支持。
2. **无增量进度与断点续传**：下载失败需重来（资产只有 1~2MB，暂不做 Range 续传）。
3. **不支持 zip64 / 7z / xz 资产**：当前两个工具的资产不需要；新增工具若用这些格式需扩展 `archive.ts`。
4. **未做版本升级提示的自动检查**：详情页只在用户点安装时才解析 latest（避免 UI 打开即联网）。

---

## 11. 全局记忆 + 项目家目录唯一定义（第九步）

### 11.1 目标

1. 把字符串 `~/.zread-pi` 收敛为「项目家目录」的唯一定义点：改家目录名 / 位置只改一处；
2. 新增「全局记忆」：每当开始生成文档，把项目绝对路径写入 `<项目家目录>/history`；
3. 用一个二进制数据结构存这些路径（高效遍历 / 末尾插入 / 随机删除）；
4. 新增启动参数 `zread-pi history`：遍历记录，删除那些项目目录下已没有 `.zread-pi` 的记录，再展示剩余项；
5. 遍历允许并发（I/O 等待型任务）；
6. 后续增量：打开目标目录时如果发现已有生成好的文档且路径不在名单里，自动补录（§11.5）。

### 11.2 改动清单

| 位置 | 内容 |
| --- | --- |
| `packages/utils/src/project-home.ts` | 家目录唯一定义点：`ZREAD_PI_DIR_NAME`（`.zread-pi`）、`ZREAD_PI_HOME_ENV`（`ZREAD_PI_HOME`）、`getProjectHome()`、`projectHomePath()`。全部家目录路径（config / auth / models-store / logs / parsers / bin / tools-state / history）改为从这里派生 |
| `packages/utils/src/history/binary-log.ts` | ZRH1 二进制结构：定长头部 + 变长记录（tag / length / UTF-8 payload）；追加 O(1)、顺序遍历 O(n)、墓碑随机删除 O(1)、阈值自动 compact、半截尾部修复、损坏抛 `HistoryFormatError` |
| `packages/utils/src/history/index.ts` | 全局记忆语义层：`rememberProject`（去重移到末尾）、`readHistory`、`forgetProject`、`clearHistory`、`pruneHistory`（并发检查 `<项目>/.zread-pi` 并删除失效项，默认并发 8） |
| `packages/utils/src/history/concurrency.ts` | `mapWithConcurrency`（零依赖固定并发、结果保序） |
| `packages/orchestrator/src/wiki/memory.ts` + 两个生成入口 | `generateWikiCatalog()` / `generateWikiContent()` 开始时 `await rememberCurrentProject()`；写入失败只告警，不阻断生成 |
| `apps/cli/src/commands/history.ts` + `index.ts` + i18n | `zread-pi history [-c <n>]`：清理 + 展示；中英文案齐全 |
| `apps/cli/src/app.ts` + `utils/generated-docs.ts` | **打开旧项目自动登记**：`runApp()` 启动时判断目标目录是否已有完整文档（与首页共用 `countGeneratedPages`），缺录时 `ensureProjectRecorded()` 补一条 |

### 11.3 二进制格式决策（为什么是「追加日志 + 墓碑」）

历史记录的模式只有三种：追加、顺序遍历、随机删除。因此选最直接的组合：

```text
头部 16B: magic "ZRH1" | version u16=1 | flags u16 | headerSize u32 | reserved u32
记录:      tag u8 (1=有效 / 0=墓碑) | length u32 (UTF-8 字节数) | path[length]
```

- **不选定长槽位**：槽位大小必须覆盖最长路径（Windows 长路径上限 32767B），要么浪费空间，要么
  截断路径 —— 路径必须无损，所以变长；
- **不选 B 树 / 哈希索引**：历史量级小（上限 1000 条）且模式简单，索引只会带来写放大与损坏面；
- **删除留墓碑**：随机删除只改 1 个字节，不搬移后续记录；墓碑数 ≥ 16 且墓碑字节 ≥ 存活字节时
  自动 `compact()`（写临时文件 + rename 原子替换）；记录超限淘汰最旧，文件体积有界；
- **损坏 / 半截写入**：进程在 append 中途被杀会留下半截尾部记录，打开时按 `length` 判定并截断，
  只丢最后一条；magic / version 不符则备份为 `history.corrupt-<ts>` 后重建（记忆可丢，生成不能被阻塞）；
- **不跨进程加锁**：同一时刻两个 CLI 写同一份记忆属于异常用法；同进程内每次读改写经 Promise 串行链。

### 11.4 验证

- `bun run test:history`（新增，61 + 24 + 10 项，离线）：二进制头部 / 追加 / 遍历 / 偏移 / 墓碑删除 / 去重 /
  压缩 / 淘汰 / 半截修复 / 损坏自愈 / 超长与 NUL 拒绝；`pruneHistory` 并发清理；`ensureProjectRecorded`
  仅缺录不刷位置；`ZREAD_PI_HOME` 覆盖；`zread-pi history` 空记忆、清理、幂等、`-c`、损坏文件自愈、帮助；
  老旧项目自动登记（完整文档补录 / 已在名单不挪位 / 不完整不登记 / `--dir` 登记目标目录）。
- `bun run test` 全量回归：`mock-generate.ts` 增加「开始生成文档写入全局记忆」与「蓝图 + 页面只留一条」断言。
- 项目家目录改名回归路径：`grep homedir()` / `.zread-pi` 只剩 `project-home.ts` 的定义与注释。

### 11.5 打开旧项目自动登记（后续增量）

- **触发**：`runApp()` 启动时（默认 wiki / config / browse 三条命令共用，在 `applyTargetDir()` 切换 cwd 之后）。
- **判据**：`<目标目录>/.zread-pi/wiki/wiki.json` 可解析、`pages` 非空、且全部页面已落盘；
  复用首页的 `countGeneratedPages`（即 UI 的「文档已生成 (N 篇)」），不另造一套判定。
- **写入**：`ensureProjectRecorded()` —— 已在名单中**不做任何写入**（不刷位置、不重复），
  仅在缺录时追加；与生成时 `rememberProject()` 的「移到最近」语义区分开。
- **容错**：wiki.json 损坏 / 读取失败 / 记忆不可写时静默忽略，不阻断 TUI 启动。
- **决策**：没有采用「只要 wiki.json 存在就登记」的更宽松判据 —— 与首页状态保持一致，
  避免把中途失败 / 半成品项目误记为「已生成」；部分生成的项目仍可通过继续生成时写入记忆。

### 11.6 风险与未决

1. **跨进程并发写**未加锁：两个进程同时 remember 时后写覆盖（历史最多丢最近几条，可接受）；
   若将来做多实例共享，再考虑文件锁 / 原子追加目录。
2. **格式只有 v1**：读取遇到未知 version 会走「备份 + 重建」；将来扩展布局时需保留旧版本读取或显式迁移。
3. **`.zread-pi` 存在性作为失效判据**：项目还在但用户手动删了产物目录时记录会被清掉 —— 这符合
   「memory 只记生成过的项目」的语义；若将来想按项目目录本身判活，需改 `hasLocalOutput`。
---

## 12. agent loop → AgentHarness（第十步：harness 化重写首尾机制）

### 12.1 目标与判定

**目标**：把 `packages/agent-runtime` 内部的「裸 agent loop」（`pi-agent-core` 的 `Agent` +
`shouldStopAfterTurn` / 手写 `transformContext` 压缩 / `agent.steer()` 插话）替换为 pi 的
**AgentHarness**（`vendor/pi/packages/agent/src/harness`），并借这次替换把首尾机制升级为
harness 形态，而不是原样搬运。

**判定**：harness 化 = 「换内核 + 升级首尾机制」；业务层（orchestrator / CLI / browse / 工具层 / wiki 契约）零改动。

- 会话/泳道/操作状态机/恢复/压缩/重试/事件/钩子全部交给 `AgentHarness`；
- 轮数硬顶升级为 **token 预算**（usage 事件/ledger 为权威来源）；
- 一次性收尾提示升级为 **两段式提示**（软 70% + 硬将尽），在 `before_run` 注入；
- `shouldStopAfterTurn` 停止升级为 **`before_run_end` 不返回 followUp 即终止**；
- `error_max_turns` 升级为 **预算耗尽 → before_run_end 强制交卷 → 编排层照旧判页失败**。

### 12.2 架构（模块划分与职责边界）

模块落在 `packages/agent-runtime/src/harness/`，依赖方向单向向下（每个关注点一个模块，
driver 只做装配与驱动，不承载业务语义）：

```text
apps/cli ──► orchestrator ──► agent-runtime ──► vendor/pi（AgentHarness）
                                  │
      ┌───────────────────────────┴────────────────────────────┐
      │ agent.ts        装配层：选项归一化 / 运行时模型 / 契约出口     │
      │ harness/driver.ts   驱动层：会话装配 + 钩子/事件注册 + 分段驱动  │
      │ harness/budget.ts   首尾机制：token 预算 + 两段式提示 + 终止   │
      │ harness/tools.ts    工具桥：ToolDefinition → AgentHarnessTool│
      │ harness/events.ts   事件桥：HarnessEvent → SDKMessage        │
      │ harness/models.ts   Models 桥：模型解析覆盖 + streamFn 注入    │
      │ harness/queue.ts    订阅事件 → AsyncGenerator 的队列         │
      └─────────────────────────────────────────────────────────┘
```

| 模块 | 职责 | 明确不做 |
|---|---|---|
| `agent.ts` | 对外契约（`createAgent/query/close`）；解析 provider/凭据/模型；把旧选项（`maxTurns` / `finalization` / `retryConfig`）归一化成 harness 选项；构造 `BudgetController` | 不碰 loop、不碰钩子时序 |
| `harness/driver.ts` | 建会话（`MemorySessionRepo` → `Session` → `AgentHarness` → `AgentLane`）；注册钩子与事件订阅；按预算分段驱动 run；把 `OperationResultRecord` 归类成 `result.subtype`；关闭资源 | 不做预算判定（交给 budget）、不做消息映射（交给 events） |
| `harness/budget.ts` | token 预算的唯一判据与状态机；`before_run` / `before_run_end` / `before_tool` 三处钩子实现；`pendingNotice()` 供 driver 决定是否分段 | 不直接调用 lane / 不发事件 / 不读会话存储 |
| `harness/tools.ts` | 工具契约桥接（错误语义、内容块、details、执行模式） | 不执行策略（权限/预算由钩子承担） |
| `harness/events.ts` | 纯映射函数（usage / 内容块 / 流式增量 / tool_result） | 不做状态累积 |
| `harness/models.ts` | 让 harness 按 `{provider, modelId}` 解析到**本次解析出的模型对象**（保住 baseURL / contextWindow / maxTokens 覆盖），并支持测试注入 streamFn | 不改写凭据解析 |

会话生命周期：每 `query()` 一个内存会话（与迁移前「每次运行新建 Agent」语义一致），
`harness.close()` + `session.close()` + `repo.close()` 在生成器 finally 里收尾；
`abort()` 走 harness 的 **durable 取消**（`lane.abort()`），不靠打断本地观察。

### 12.3 钩子接入点

| 钩子 | 本层用途 | durability |
|---|---|---|
| `before_run` | **两段式提示的唯一注入点**：按累计 tokens 判断软/硬提示，返回 `{ messages }`，与 run 的 checkpoint 同事务落库 | transition-consumed |
| `before_run_end` | **正常收尾边界的决策点**：目标产物已产出 → 不返回 followUp（终止）；预算耗尽且强制交卷轮未用完 → 返回硬提示 followUp（强制交卷）；其余 → 不返回 followUp（终止） | transition-consumed |
| `before_tool` | 旧 `PreToolUse` + `canUseTool` + **预算熔断**（耗尽后拦截探索类工具，目标输出工具例外） | transition-consumed |
| `after_tool` | 旧 `PostToolUse`（UI 进度；不改结果） | transition-consumed |
| `before_compaction` | 承载 `compaction.enabled=false`（decline，含 overflow 恢复压缩） | transition-consumed |
| 事件 `usage` | 预算的**权威用量**（committed ledger 的累计 totals） | 只读 |
| 事件 `turn_end` / `tool_end` | 轮次统计 / 目标产物判定（成功的 `write_page` / `generate_blueprint` 调用） | 只读 |
| 事件 `message_update` / `message_end` / `tool_end` / `compaction_end` / `retry_scheduled` / `handler_error` | 映射为既有 `SDKMessage` 与业务 `retry` 回调 | 只读 |

### 12.4 首尾机制差异映射（逐项落点）

| 现有机制 | harness 下的升级形态 | 落点 | 理由 |
|---|---|---|---|
| 轮数预算（30 轮硬顶） | **token 预算**：`before_run` / `before_run_end` / `before_tool` 里按 `usage` 事件的累计 tokens 判定（口径 = input + output + cacheWrite + cacheRead） | `harness/budget.ts` + driver 的 `usage` 订阅 | 轮数≠成本：一条 100k 上下文的轮次与一条 1k 的轮次代价差两个数量级；usage ledger 是 harness 已经落库的权威成本事实，不需要另造计数器 |
| 倒数第 1 轮一次性硬提示 | **两段式提示**：软提示（默认 70% 预算）+ 硬提示（预算将尽），都由 `before_run` 注入 `messages` | `budget.beforeRun()` | 早提示让模型有机会收敛（而不是到最后一轮才救火）；`before_run` 的注入是 transition-consumed 的 durable 消息，随 checkpoint 提交，崩溃重放安全 |
| `shouldStopAfterTurn` 返回 true 停止 | `before_run_end` **不返回 followUp 即终止**（正常收尾边界）；预算耗尽时返回 followUp = 强制交卷 | `budget.beforeRunEnd()` | `before_run_end` 是 harness 明确规定的「无排队输入时的收尾决策点」；返回值本身既是「继续」也是「终止」信号，不需要再维护 turn 计数器或额外内核字段 |
| 收尾失败 → `error_max_turns` | 预算耗尽 → `before_run_end` 强制交卷；仍无 `write_page` → 编排层照旧判页失败（产物存在性判定，不依赖内核） | `budget` + `driver.buildResultMessage()` + `orchestrator/wiki/generate-wiki.ts` | 内核只负责「预算与强制交卷」；「页面成不成」是业务语义，编排层已按 `.zread-pi/wiki/<section>/<file>` 是否存在判定，两层解耦 |

补充说明（首尾机制的完整行为）：

1. **软提示的落地时机**：软阈值可能在 run 中途越过，而 `before_run` 只在 run 起点触发。
   driver 因此在 run 正常结束时检查 `pendingNotice()`：若提示已到期且目标产物未产出，
   就再起一个 run（同一 lane、同一 transcript），由 `before_run` 把提示写进上下文。
   这样「提示只经 `before_run` 注入」与「提示一定能送到模型」同时成立。
2. **硬提示与强制交卷**：预算耗尽时 `before_run_end` 直接返回硬提示 followUp（同一 hook 的
   继续语义），`forcedTurns`（缺省 1，0 = 立即终止）控制允许几次强制交卷。
3. **熔断（backstop）**：模型可能一直调用工具、永不回到 `before_run_end`。预算耗尽后
   `before_tool` 拦截探索类工具（返回 `{ block: { reason: 硬提示 } }`），把它推到收尾边界；
   **目标输出工具例外**，否则强制交卷会被自己的熔断打掉。
4. **`compaction.enabled=false`**：harness 的 overflow 恢复压缩不走 `shouldCompact`，
   因此额外用 `before_compaction` decline 保证「关闭压缩 = 一次摘要请求都不发」。

### 12.5 契约与行为差异（有意为之）

| 差异 | 说明 |
|---|---|
| `result.subtype` 新增 `error_budget_exhausted` | `error_max_turns` 由「预算耗尽且强制交卷后仍无目标产物」取代；旧 subtype 保留在类型联合里（向后兼容），内核不再产出。 |
| `result.usage` 语义 | 迁移前是「最后一次响应的 usage」（覆盖式赋值，接口在最后一条消息上）；现在是 **harness usage ledger 的累计值**（本次生成的全部 tokens）。`assistant` 事件仍是单次响应的 usage，UI 的实时增量不变。 |
| 预算耗尽判定 | 迁移前的 `error_max_turns` 只是「到达轮数上限」；现在必须同时满足「预算耗尽」+「目标工具未成功调用」，交卷成功则算 success（场景验证见 §12.7 场景 7）。 |
| `maxTurns` | 不再是轮数硬顶：`resolveBudgetOptions()` 折算成 `maxTurns * TOKENS_PER_TURN`（25k/轮，缺省 30 → 750k tokens），`0` = 不限制预算。配置界面 `/config/max-turns` 与 `config.agent.max_turns` 保持可用；新增 `agent.token_budget` 可直接配置 token 预算（0 = 按 max_turns 折算）。 |
| `finalization` | 保留为兼容选项：`finalization.notice` → 硬提示文案，`graceTurns` → `forcedTurns`；新代码请用 `budget.notices` / `budget.forcedTurns`。 |
| 重试 | 迁移前是适配层自研的 `streamFn` 包装（`createRetryingStreamFn` + `retryableStatusCodes` 白名单 + `retryScope: "stream+run"` 整轮重跑）；现在直接用 harness 的 retry policy（pi-ai 的分类器 + 退避上限，`maxDelayMs` → `maxAgentDelayMs`）。**失败尝试不落库**的语义不变（响应只有在 settlement 时才写会话）。`retryScope` 保留字段但已无用（harness 无「整轮重跑」概念）。 |
| 上下文溢出 | 迁移前靠 `estimateContextTokens` 提前预判并优雅停止（faux provider 也会停）；现在靠 harness 的 threshold 压缩 + overflow 恢复压缩，泄漏到 provider 的溢出按 pi-ai 的 `isContextOverflow` 归类，适配层映射回 `error_context_full` 与既有「Context window nearly full」文案。 |
| 折叠提示的 k 数 | 迁移前硬编码 30 轮；现在缺省折算 750k tokens（等价口径见上）。真机首次运行建议观察 usage 后调整 `agent.token_budget`。 |

### 12.6 改动清单

| 动作 | 对象 |
|---|---|
| 新增 | `packages/agent-runtime/src/harness/{driver,budget,tools,events,models,queue}.ts` |
| 重写 | `packages/agent-runtime/src/agent.ts`（裸 loop → 装配层）、`src/hooks.ts`（钩子配置与执行，原为兼容垫片） |
| 修改 | `packages/agent-runtime/src/index.ts`（导出预算能力）、`packages/orchestrator/src/agents/create-agent.ts`（构造 `budget`，两段式提示按文档语言本地化）、`packages/types/src/config.ts` + `packages/utils/src/config/index.ts`（新增 `agent.token_budget`） |
| 未改动 | 工具层（5 个文件工具 + `Ls`）、orchestrator 的 prompts / wiki 契约 / 并发与错误隔离、CLI TUI、browse、repo-analyzer |

### 12.7 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:context` | **45/45**（harness 内建压缩 + 溢出归类 + token 预算 + 两段式提示 + `before_run_end` 终止 + 强制交卷 + 权威 usage 口径 + `maxTurns` 折算） |
| `bun run test:agent` | 11/11（含钩子映射、429 流级重试、thinkingLevel、工具落盘） |
| `bun run test:agent:http` | 8/8（真实 HTTP/SSE：单次 usage 与累计 usage 分别断言） |
| `bun run test:pages` | 15/15 + 7/7（含新增预算页：预算耗尽 → 工具熔断 → 强制交卷后仍无 write_page → `page_error`，页面未落盘） |
| `bun run test:blueprint` / `test:tools` / `test:catalog` / `test:installer` / `test:history` / `test:provider` / `test:analyzer` | 7/7 · 95/95 · 34/34 · 70/70 · 61+24+10 · 5/5 · 5/5 |
| `bun run test:tui` | 187 + 9 + 25 + 21 + 28 全绿（含真实终端启动与 mock LLM 全链路） |
| `bun run mock:wiki` | `completed=4 failed=0` |

### 12.8 风险与未决

1. **软提示的时机**：软提示最早也要等到「模型停止但未交卷」的边界（或下一次 run 起点）才注入，
   而不是像旧的 `agent.steer()` 那样精确插在第 N 轮之后。这是 harness 的注入语义所决定的
   （`before_run` = run 起点；run 中途的 durable 通道是 steer 队列）。若将来需要更早介入，
   可在 `usage` 事件里用 `lane.steer()` 补一条（当前未启用，避免多一条提示来源）。
2. **预算口径**：累计 tokens 把 cacheRead 也算进去（长对话下占比很高）。若希望「只算真金白银」，
   可把 `usageTokens()` 改成只累加 input + output。
3. **`maxTurns` 折算系数**（25k/轮）是经验值，不是从旧行为反推的精确等价；真机首次运行后按
   usage 调整 `agent.token_budget` 更靠谱。
4. **会话仍是内存态**：harness 的 durable 能力（JSONL/SQLite 后端、恢复、fork）尚未启用；
   wiki 生成是一次性任务，暂不需要。将来要做「中断续跑」时，把 `MemorySessionRepo` 换成
   `JsonlSessionRepo` 即可，driver 的分段驱动天然兼容（`create` 会返回 open operations）。
5. **`watchSession` 未用**：harness 的 `watchSession` 在 vendor 版本里仍是 `SliceNotImplemented`
   桩，本层只用 `watch` 之外的显式事件订阅。
---

## 13. 去掉手工副本/手工实现，改用 pi 原生功能（第十一步）

### 13.1 目标

`packages/agent-runtime` 里有几处「从 pi 拷过来的副本」与「自己写的等价实现」：
一旦上游修 bug（编辑模糊匹配、图片判型、写队列竞态、重试分类）它们不会跟上游一起修。
本轮把这几处换成 **pi 的原生实现**，本地只保留必要的薄适配。

### 13.2 逐项落地

| 本地（迁移前） | 现在用的 pi 实现 | 处理方式 |
|---|---|---|
| `agent-runtime/src/tools/edit-diff.ts`（257 行副本，逐行等于上游） | `@earendil-works/pi-agent-core/harness/tools/edit-diff` | **删除本地文件**，`tools/edit.ts` 直接 import pi 的实现（BOM/CRLF 归一化、fuzzy 兜底、多段编辑、diff/patch 全部由 pi 提供） |
| `agent-runtime/src/tools/image.ts`（副本） | `@earendil-works/pi-agent-core/harness/tools/image` | **删除本地文件**，`tools/read.ts` + `tools/index.ts` 直接 re-export pi 的 `detectSupportedImageMimeType` / `encodeBase64` |
| `agent-runtime/src/tools/file-mutation-queue.ts`（自写队列） | `@earendil-works/pi-agent-core/harness/tools/file-mutation-queue` + `.../harness/env/nodejs` 的 `NodeExecutionEnv` | 保留**薄适配**：本文件只提供「进程级共享的 `NodeExecutionEnv`」与「把 `abortSignal` 包进 `Context`」，排队键（canonical path）与队列状态全在 pi 里 |
| `agent-runtime/src/retry.ts` 的 `isRetryableMessage` / `computeBackoff` | pi-ai 的 `isRetryableAssistantError` / `retryDelayMs` / `retryAssistantCall` | **删除自写判定与退避**；`retry.ts` 只剩业务契约（`RetryConfig`）与桥接（`toRetryPolicy`，从 `agent.ts` 移入） |
| Repo Map 的上下文 token 估算：`repo-analyzer/src/repo-map/token-counter.ts`（「行数 × 10」）、`formatter.ts` 的 `lines * 10`、`index.ts` 的 `lines * 10` | `@earendil-works/pi-agent-core` 的 `estimateTokens`（chars/4 启发式，与 harness 判定上下文压力同一算法） | 三处全部改为 `estimateTextTokens()`；`estimateTokens(symbol, referenceCount)` 估算「真正会输出到 Repo Map 的文本」（树缩进 + 文件行 + Ref 标签 + 符号行），内容行由 `formatter.formatSymbolContentLines()` 提供（渲染与估算共用一份构造，不会漂移） |

### 13.3 为什么给 vendor 加了 3 个子路径导出

上游把 `edit-diff` / `image` / `file-mutation-queue` 当**内部实现**：`harness/tools/index.ts` 与包根入口都不 re-export，
`pi-coding-agent` 里是自己又拷一份。本仓库不引入 `pi-coding-agent`（见 §1 判定），所以选择在
`vendor/pi/packages/agent/package.json` 的 `exports` 里补 3 个指向 `dist/` 的子路径：

```json
"./harness/tools/edit-diff": { "types": "./dist/harness/tools/edit-diff.d.ts", "import": "./dist/harness/tools/edit-diff.js" }
"./harness/tools/image":       { ... }
"./harness/tools/file-mutation-queue": { ... }
```

- 只动 vendor 包的 manifest（该文件本来就已是裁剪版：`private: true` + 去掉上游 scripts/files），**源码零改动**；
- 消费的是 `bun run vendor:build` 产出的同一份 dist，升级 pi 快照时无需额外步骤（新版本若重命名文件需同步这 3 行）；
- 除这三个子路径外，其余 pi 能力仍从包根入口消费。

### 13.4 行为差异（有意为之）

| 差异 | 说明 |
|---|---|
| Repo Map 的 token 估算口径 | 从「行数 × 10」改为 pi 的 chars/4（并计入树缩进 + Ref 标签）。同一份 mock 数据下，单文件估算从 60 → 34 tokens：预算内的页面/符号选择会变化，但**预算语义不变**（同一个 `tokenBudget` 参数，同一套 estimator 用于选择与最终统计，自洽），且与 harness 的上下文估算同源 |
| `RetryConfig.retryableStatusCodes` | 不再参与判定（判定统一走 pi 的 `isRetryableAssistantError`）；字段保留只为兼容旧配置形状 |
| `isRetryableMessage` / `computeBackoff` / `estimateTotalTokens` | 已删除（前者只有 index.ts 的公共转发，后者是死代码）；如需判定/退避请直接用 `isRetryableAssistantError` / `retryDelayMs` / `retryAssistantCall` |
| 写队列 | 行为不变：仍按 canonical path（realpath，软链接归一）串行化，不同文件仍并行；`withFileMutationQueue(path, fn, signal?)` 签名不变，调用点只多了 `context.abortSignal` |

### 13.5 改动清单

| 动作 | 对象 |
|---|---|
| 删除 | `packages/agent-runtime/src/tools/edit-diff.ts`、`src/tools/image.ts` |
| 薄适配 | `packages/agent-runtime/src/tools/file-mutation-queue.ts`（pi 队列 + `NodeExecutionEnv`）、`src/retry.ts`（pi 判定/退避 + 业务契约桥接） |
| 修改 | `src/tools/{edit,read,index,write}.ts`、`src/agent.ts`（`toRetryPolicy` 移到 retry.ts）、`src/index.ts`（导出 pi 重试原语） |
| 修改 | `packages/repo-analyzer/src/repo-map/{token-counter,formatter,index,prioritizer}.ts` + 单测；`packages/repo-analyzer/package.json`（新增 `@earendil-works/pi-agent-core` 依赖） |
| vendor | `vendor/pi/packages/agent/package.json`（3 个子路径导出） |

### 13.6 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误（子路径导出的类型解析正常） |
| `bun run test:tools` | 95/95（含 16 路并发编辑不丢更新、图片 magic number 判型与 image 块回传、Edit 的 BOM/CRLF/fuzzy 行为） |
| `bun test packages/repo-analyzer/src/repo-map` | 17/17（`estimateTokens` 断言已改为「pi 的 chars/4 + 渲染文本」） |
| `bun run test` | 全部套件通过（test:analyzer 5/5、test:agent 11/11、test:context 45/45、test:pages 15/15 + 7/7、test:tui 187+9+25+21+28） |
| `bun run mock:wiki` | `completed=4 failed=0`（真实跑过 buildRepoMap + 页面生成） |

## 14. 对齐 pi coding-agent 的五项高价值改进（第十二步）

### 14.1 目标

`pi/packages/coding-agent` 里有五块已被真实用户长期打磨的能力，而 zread-pi 的等价位置是手工实现或缺失：

| # | 能力 | 迁移前 | 迁移后 |
|---|---|---|---|
| 1 | 图片处理管线 | `Read` 只做 magic number 判型后原样回传 image 块：大图按原始尺寸烧 token，BMP 直接被拒 | 格式归一化 + 自动缩放（2000×2000 / 4.5MB base64）+ 转换/缩放提示 |
| 2 | 目标仓库上下文注入 | 页面 / 蓝图 Agent 只看代码，仓库自己的 `AGENTS.md` / `CLAUDE.md` 里写好的架构说明与约定完全没用上 | 候选文件（`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`）+ 全局 `~/.zread-pi` 上下文注入系统提示 |
| 3 | 重试策略 | Agent 层固定 10 秒延迟、忽略服务端 `Retry-After`；`concurrency.max_retries: 0` 还会被 harness 默认策略放大成 3 次 | Agent 层指数退避（2s→4s→…，60s 封顶）+ Provider 层 `retryProviderRequest`（读 `Retry-After`，超上限立即失败）+ 显式禁用语义 |
| 4 | 配置写入加锁 | 配置 / 凭据 / 安装台账 / history 都是进程内串行化，多 CLI 实例并发写会互相覆盖（history 整文件写尤其危险） | `<file>.lock` 跨进程锁把「读-改-写」包成临界区，配置写入额外做临时文件 + rename 原子替换 |
| 5 | TUI stdout 保护 | 只接管了 `console.*`；第三方库直接 `process.stdout.write` 仍会把全屏界面打花 | 接管 `process.stdout.write`：TUI 自身写入走放行窗口直达原生 stdout，杂散写入进日志文件 |

采纳方式与 §13 一致：**先从 `pi/packages/coding-agent` 复制对应模块（含来源注释），再把原实现接入/替换掉**，
不引入 `pi-coding-agent` 包（依赖面与 TUI 生态不匹配，见 §1 判定）。

### 14.2 逐项落地

#### 14.2.1 图片处理管线（`packages/agent-runtime/src/tools/image/`）

移植自 `pi/packages/coding-agent/src/utils/{image-process,image-resize,image-resize-core,image-resize-worker,image-convert,photon,exif-orientation}.ts`，共 7 个文件：

| 文件 | 职责 | 与上游的差异 |
|---|---|---|
| `photon.ts` | 加载 `@silvia-odwyer/photon-node`（Rust/WASM）；修补 Bun 编译产物里 wasm 的绝对路径 | 无 |
| `exif-orientation.ts` | 解析 JPEG/WebP 的 EXIF Orientation 并真正旋转像素 | 无 |
| `image-resize-core.ts` | 缩放策略：先 PNG 再多档 JPEG，仍超标按 0.75 逐级缩小 | 无 |
| `image-resize-worker.ts` | Worker 线程入口（CPU 密集不阻塞 TUI） | 无 |
| `image-resize.ts` | 优先 Worker、失败回退进程内；坐标换算提示 | 去掉上游的「Bun 下先试相对仓库源码路径」分支（zread-pi 的 cwd 是被生成文档的目标仓库，该路径无意义）；打包产物里 worker 文件缺失时自然回退进程内 |
| `image-convert.ts` | BMP/TIFF 等转 PNG | 无 |
| `image-process.ts` | 管线入口：归一化 → 缩放 → 提示 | 无 |

接入点：`tools/read.ts` 仅在「模型支持图片」时调用 `processImage()`（不支持图片的模型不做无谓的 CPU 工作），
失败时回退为文本说明（`[Image omitted: …]`），而不是让工具调用失败。

#### 14.2.2 目标仓库上下文注入（`packages/orchestrator/src/agents/context-files.ts`）

移植自 `pi/packages/coding-agent/src/core/resource-loader.ts` 的 `loadContextFileFromDir()` / `loadProjectContextFiles()`
与 `system-prompt.ts` 的 `<project_context>` 注入格式。

- 候选顺序与上游一致：`AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`；
- 注入顺序：全局（`~/.zread-pi`）在前、目标仓库（cwd）在后；
- **差异（有意）**：不向上遍历父目录。zread-pi 的工作目录就是被生成文档的仓库根，
  父目录（例如用户主目录）里的 `AGENTS.md` 与本次文档无关，注入只会增加噪音与 token；
- **差异（有意）**：单文件 64 KiB 上限，超出部分截断并附 `[... context file truncated at 64 KiB ...]`
  （页面 Agent 是 N 个并发实例，每个都会吃这份上下文）；
- 接入点：`agents/create-agent.ts`（蓝图与页面 Agent 共用），系统提示 = 语言规则 + `<project_context>` 块。

#### 14.2.3 重试策略：两层退避 + Retry-After

`RetryConfig` 新增可选 `provider: { maxRetries, maxRetryDelayMs, timeoutMs }`（与 pi 的 `ProviderRetrySettings` 同形），
`retry.ts` 新增 `toStreamOptions()` 把它翻译成 harness 的 `streamOptions`，由 `driver.ts` 传给 `AgentHarness.create`。

| 层 | 迁移前 | 迁移后 |
|---|---|---|
| Agent 层（harness `RetryPolicy`） | `baseDelayMs = maxDelayMs = 10000`（固定 10s） | `baseDelayMs = 2000`、`maxDelayMs = 60000`（指数退避 + 封顶） |
| Provider 层（pi-ai `retryProviderRequest`） | 未启用（`maxRetries` 默认 0） | `maxRetries = concurrency.max_retries`、`maxRetryDelayMs = 60000`，**读取服务端 `Retry-After` / `retry-after-ms`** |
| `maxRetries = 0` | `toRetryPolicy` 返回 `undefined` → harness 落回**默认策略（3 次）**，配置失效 | 返回**显式禁用**策略（`enabled: false`），配置生效 |

超上限的服务端延迟（例如 `Retry-After: 120` vs 上限 60s）会被 pi-ai 立即判定失败，
错误文本带 `Server requested 120s retry delay (max: 60s)`（匹配 `isRetryableAssistantError` 的 `retry delay` 模式），
由 Agent 层决定是否继续退避 —— 与 pi 的行为一致。

#### 14.2.4 配置写入加锁（`packages/utils/src/lockfile.ts`）

移植自 `pi/packages/coding-agent/src/core/settings-manager.ts` 的 `FileSettingsStorage.withLock`（`proper-lockfile`），
语义保持一致（`realpath: false`、`ELOCKED` 重试 10 × 20ms、文件不存在也能先加锁）。

| 目标文件 | 调用点 | 保护方式 |
|---|---|---|
| `config.yaml` | `saveConfig()` | 跨进程锁 + 临时文件 rename 原子替换 |
| `auth.json` | `FileCredentialStore.modify()/delete()` | 跨进程锁包住整个「读-改-写」（进程内每 Provider 队列保留） |
| `tools-state.json` | `recordToolInstall()/clearToolInstall()` | 跨进程同步锁包住「读-改-写」 |
| `history` | `rememberProject/ensureProjectRecorded/forgetProject/clearHistory/readHistory/pruneHistory` | 跨进程锁包住 open + 变更 + 落盘；prune 的目录检查放在锁外并发执行，回到锁内重新 open 后应用删除 |

**差异（有意）**：锁获取失败（重试耗尽）按写入失败处理并向上抛错（`saveConfig` 会提示「保存失败」），
不做「静默退化为无锁写」——无锁写的后果是数据损坏，比明确失败更糟。

#### 14.2.5 TUI stdout 保护（`apps/cli/src/tui/{output-guard,guarded-terminal}.ts`）

移植自 `pi/packages/coding-agent/src/core/output-guard.ts`，保留全部原语
（`takeOverStdout` / `restoreStdout` / `isStdoutTakenOver` / `writeRawStdout` / `flushRawStdout`、ENOBUFS/EAGAIN 重试队列）。

zread-pi 侧的接入差异：

| 差异 | 原因 |
|---|---|
| `takeOverStdout({ redirect })` 可选 `"stderr"`（默认，pi 语义）/ `"log"` / 回调 | 全屏 TUI 里 stderr 与 stdout 是同一终端，杂散输出写 stderr 一样会在备用屏幕滚动花屏；zread-pi 既有的 console-guard 约定是「TUI 期间杂散输出进日志文件」，两者统一 |
| `runWithRawStdout(fn)` 放行窗口 + `GuardedProcessTerminal` | pi-tui 的终端组件直接调 `process.stdout.write`；放行窗口让渲染帧与控制序列直达原生 stdout，保持顺序 |
| `passthroughTerminalSequences`（ESC 开头整块放行） | pi-tui 的 Kitty/modifyOtherKeys 协商发生在异步回调里，拿不到放行窗口；ESC 前缀既是它们共同的特征，也不会被普通日志误用 |
| TUI 渲染默认换成 `GuardedProcessTerminal` | 与接管配套；测试注入的终端不受影响 |
| `zread-pi history` 也接管 stdout | 该命令输出是「可被脚本消费」的路径清单；杂散写入转 stderr，清单走 `writeRawStdout` |

### 14.3 依赖变更

| 包 | 版本 | 位置 | 说明 |
|---|---|---|---|
| `@silvia-odwyer/photon-node` | 0.3.4 | `packages/agent-runtime` | Rust/WASM 图片处理；三平台均有 wasm，无原生编译 |
| `proper-lockfile` | 4.1.2（+ `@types/proper-lockfile` 4.1.4） | `packages/utils` | 基于 mkdir 的跨进程锁，纯 JS |

打包相关：`apps/cli` 的 tsup `onSuccess` 会把 `photon_rs_bg.wasm` 复制进 `dist/`（打包后按 `__dirname` 读取），
`tools/build-binary.ts` 会把它复制到 standalone 二进制旁（photon 兜底路径按 `process.execPath` 同目录查找）。

### 14.4 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:tools` | 102/102（新增 7 项：大图缩放 + 坐标提示、BMP→PNG、`autoResizeImages=false` 原样回传、无法解码降级、损坏图片回退文本） |
| `bun run test:agent` | 17/17（新增 6 项：provider 重试配置透传为 `streamOptions`、`toRetryPolicy`/`toStreamOptions` 纯函数映射、`maxRetries=0` 显式禁用） |
| `bun run test:agent:http` | 12/12（新增 3 项：429+`Retry-After: 0.05` 实际等待 ~60ms 完成重试、超上限 `Retry-After: 120` 立即失败且错误含 `retry delay`） |
| `bun run test:lock` | 10/10（新增套件：互斥、异常释放、`ELOCKED` 失败、`saveConfig` 并发写、**6 个真实子进程并发写 history 一条不丢**） |
| `bun run test:blueprint` | 9/9 + 11/11（新增：e2e 断言系统提示带 `<project_context>` 且全局在前；context-files 纯函数 11 项） |
| `bun run test` | 全部套件通过（catalog 34、tools 102、installer 70、history 61+24+10、lock 10、http 12、provider 5、analyzer 5+17、blueprint 9+11、pages 15+7、context 45、tui 187+9+10+25+21+28） |
| `bun run mock:wiki` | `completed=4 failed=0` |
| `cd apps/cli && bun run build` | 成功；`dist/photon_rs_bg.wasm` 已随构建产出 |

### 14.5 风险与未决

- **Provider 层重试的等待对 UI 不可见**：`retryProviderRequest` 在请求内部退避（可能等待数秒），
  TUI 的 `retry` 事件只在 Agent 层重试时发出。pi coding-agent 相同；如需可见再走 `onRetry` 扩展。
- **两层重试的放大系数**：`concurrency.max_retries = N` 同时下发到两层，最坏情况下请求数为 `N(N+1)`。
  配置界面上限为 5，且 token 预算/上下文窗口仍会兜底；后续可在配置里拆成两个旋钮。
- **图片缩放的 CPU 成本**：Worker 不可用（打包产物缺 worker 文件）时回退进程内执行，大图会短暂阻塞主线程。
- **history 锁的粒度**：锁包住整个「open → 变更 → 落盘」。多实例同时生成大量项目时会出现短暂排队；
  prune 的目录探测已移出锁外，主要耗时不在锁内。
- **`AutoCompact` 与锁**：`HistoryLog` 自身的 compact / 修复写仍在锁内执行（经公开入口进入），
  直接使用 `HistoryLog` 的外部调用方需要自行持锁（当前仓库没有这种调用方）。

## 15. 引入 humanizer 文风纪律与页面级 polish（第十三步）

### 15.1 目标

把两份外部 humanizer skill（`humanizer` / `humanizer-zh`，基于 Wikipedia "Signs of AI writing"）引入编排器，
让生成的 wiki 读起来更像人写的，同时**不破坏本项目的文档结构约定**（代码块、`Sources:` 溯源行、
Mermaid 引号标签、YAML frontmatter）。分两层落地：零成本的预防层（默认开）+ 可选的兜底层。

| 层 | 时机 | 成本 | 默认 |
|---|---|---|---|
| 1 预防 | 蓝图 / 页面 Agent 的系统提示注入 | 0 次额外调用（只是提示词变长） | 开（`polish.enabled: true`） |
| 2 兜底 | 页面 `write_page` 成功 + 落盘兜底之后 | 每页多 1 次 polish Agent（成功时通常 2 次请求） | 关（`polish.mode: prompt-only`） |

### 15.2 第 1 层：vendored 纪律文件 + 提示注入

- `packages/orchestrator/src/prompts/humanizer.en.md`（来源：blader/humanizer SKILL.md v3.0.0，MIT）
- `packages/orchestrator/src/prompts/humanizer.zh.md`（来源：humanizer-zh，翻译自 blader/humanizer）

精炼规则：保留模式清单（§1–§25）+ 核心规则 + 交付前检查清单，**删除教学式 before/after 长例**，
并新增本项目专属的「绝对不许动」保护段（代码块 / 行内代码 / `Sources:` 行 / Mermaid 引号标签 / YAML frontmatter /
标题层级与表格结构）。两份文件各 60~80 行，文件头 HTML 注释注明来源与精炼方式（`test:blueprint` 有断言守门）。

| 模块 | 职责 |
|---|---|
| `agents/style-discipline.ts` | 加载两份 `.md`（`import ... with { type: 'text' }`）、按 `doc_language` 选择、生成 `<writing_discipline>` 注入块与 polish 提示词 |
| `agents/create-agent.ts` | 系统提示 = 语言提示 + `<project_context>` + `<writing_discipline>`（纪律块**排在 project_context 之后**）；`polish.enabled=false` 时整块不注入 |
| 蓝图 / 页面 Agent | 共用 `createAgent`，因此两层入口同时生效，零业务改动 |

`create-agent.ts` 另新增可选 `systemPrompt`：给定后完全替换默认组合（供 polish Agent 自备系统提示）。

### 15.3 第 2 层：`wiki/polish.ts` 的兜底润色

`generate-wiki.ts` 在页面文件确认落盘（含写错路径的兜底移动）之后调用 `polishPageFile()`：

- **同一模型、换一套系统提示**：纪律全文 + Embedded mode 输出约定（humanizer skill 自带的概念：
  只回最终文本；这里进一步收缩为「用 Read/Edit 就地改文件，最终只回一行 `POLISHED` / `NO_CHANGE`」）；
- **工具只给 `Read` / `Edit` / `Ls`**：没有 `write_page`，防止 polish Agent 重写整页；
- **独立小 token 预算**：`DEFAULT_POLISH_TOKEN_BUDGET = 60000`，不占用页面 Agent 的预算；
- **失败语义**：polish 失败不判页失败（页面产物已存在，polish 是增强不是必需，与 history 写入「失败不阻断」同一哲学）。
  Agent 抛错只会写进 `PageResult.polish.error` 与日志；
- **唯一的结构性复检**：polish 完成后重跑 `validateMermaidContent`（从 `page-tools.ts` 导出），
  若改坏 Mermaid 则把文件回滚到 polish 前的内容并告警（`reason: 'mermaid-rollback'`）；
- **结果回传**：`PageResult.polish`（新增可选字段）记录 `applied / reason / error / durationMs / tokenUsage`。

### 15.4 配置面

```yaml
polish:
  enabled: true      # 总开关；false = 既不注入纪律也不跑 polish Agent
  mode: prompt-only  # prompt-only（默认）| full
```

- 旧 `config.yaml` 无 `polish` 段：`normalizePolishConfig()` 补齐 `{ enabled: true, mode: 'prompt-only' }`；
  `polish.mode = 'full'` 但 `enabled = false` 时以 `enabled` 为准（不会跑 Agent）。
- 配置界面新增 `/config/polish`：↑↓ 选择模式、Enter 应用并返回、`t` 启用/停用、`s` 保存并返回；
  `ConfigStore.setPolish()` 整体写回（避免 `setField` 的 `string | number` 限制）。
- 默认不开 `full` 的原因：它每页多一次 LLM 调用，成本接近翻倍，留给用户显式选择。

### 15.5 打包与跨平台

- `.md` 文本导入：Bun（源码运行 / 测试）走 import attributes `with { type: 'text' }`；
  tsup / esbuild **原生 text loader 不接受该属性**（`Importing with a type attribute of "text" is not supported`），
  因此由共用插件 `tools/tsup-md-text.ts`（`apps/cli` 与 `packages/orchestrator` 两处 tsup 配置的 `esbuildPlugins`）
  接管 `.md` 的 resolve/load，直接生成 `export default "..."` 字符串模块；
  `packages/orchestrator/src/prompts/md.d.ts` 提供 `*.md` 的类型声明。打包产物不依赖运行时读文件，天然跨平台。
- polish Agent 打开的是绝对路径，Edit 工具的 CRLF/BOM 归一化与同文件串行化沿用既有实现（见 §1.3）。

### 15.6 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:blueprint` | 10/10 + 11/11 + 17/17（新增：蓝图系统提示带 `<writing_discipline>` 且排在 `<project_context>` 之后；纪律纯函数 17 项含 vendored 行数守门） |
| `bun run test:pages` | 15/15 + 7/7 + 16/16（新增 `page-polish.ts`：Edit 真实生效、Mermaid 回滚、no-change / Agent 失败不判页失败、prompt-only / enabled=false 开关语义） |
| `bun run test:tui` | smoke-tui 209 项（新增文风润色页 19 项断言，含开关/模式写回与落盘）、全部 20 个路由渲染无超宽行 |
| `bun run test` | 全部套件通过（catalog 34、tools 102、installer 70、history 61+24+10、lock 10、http 12、provider 5、analyzer 5+17、blueprint 10+11+17、pages 15+7+16、context 45、tui 209+9+10+25+21+28） |
| `bun run mock:wiki` | `completed=4 failed=0` |
| `cd apps/cli && bun run build` | 成功（`.md` 纪律已内联进产物） |

### 15.7 风险与未决

- **prompt-only 的效果依赖模型**：纪律是提示而非硬校验，弱模型可能仍写出 AI 腔；需要更硬的保证时用户可切 `full`。
- **polish 的评估成本**：`AppConfig` 里没有「每页最大润色轮数」，只靠 60k token 预算与 Embedded mode 约束；
  极端情况下 polish Agent 可能反复小改。后续可把它并入配置界面（模型/预算）。
- **Mermaid 是唯一的结构性复检**：polish 若删掉 `Sources:` 行或改坏 frontmatter 不会被自动发现
  （纪律里明确禁止，但无程序化校验）；后续可加「frontmatter 字段与溯源行数量不减」的校验。
- **成本不透明**：`PageResult.polish.tokenUsage` 目前只进日志与结果对象，生成界面尚未展示 polish 用量（第十四步的底部合计同样不含它，见 §16.6）。

## 16. 生成页底部展示用量合计（第十四步）

### 16.1 目标

生成文档界面（`/wiki/generate`）最下方实时展示**全部 Agent 的合计用量**：输入 token、输出 token、缓存读占比。
口径是**成功 + 失败 + 重试**：失败页的消耗不会消失，按 `r` 重新生成/重试也不会把已消耗的 token 清零。

### 16.2 pi 提供了什么（先分析、优先复用）

| pi 能力 | 内容 | 本次怎么用 |
|---|---|---|
| `pi-ai` 的 `Usage` | `input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens` / `cost`；缓存读写单独记账 | 适配层 `harness/events.ts` 已映射为 `TokenUsage`（字段名冻结），直接沿用 |
| harness 的 `usage` 事件 | `{ row: UsageRow, totals: Usage }`，`totals` = 该会话 usage ledger 的累计值 | `harness/driver.ts` 已在消费（预算判定 + `result.usage`），本次不新开销 |
| `pi-agent-core` 的 `emptyUsage` / `addUsage` | 归并 pi `Usage` 的纯函数 | **不可直接用**：未从包根导出（只服务 compaction），且作用在 pi 内部形状上 |
| 跨 Agent / 跨会话聚合器 | —— | **pi 未提供**：每个页面 Agent 是独立 session + 独立 ledger，合计属于业务层 |

结论：**每个 Agent 的累计值继续取 pi 的 usage ledger（已有链路），跨 Agent 合计由业务层做纯函数 reduce。**
在 `packages/agent-runtime/src/usage.ts` 提供了 `emptyTokenUsage` / `addTokenUsage` / `sumTokenUsage`
作为唯一归并口径（与 pi `addUsage` 同一加法语义，但作用于业务契约的 `TokenUsage`）。

### 16.3 口径

- `input_tokens` 是**非缓存输入**（pi 口径：Anthropic `input_tokens`、OpenAI `prompt_tokens - cached_tokens`）；
- **输入侧总量** = `input + cache_read + cache_creation`（展示的「输入」就是这个值）；
- **缓存占比** = `cache_read / 输入侧总量`（没有输入时为 0，不出现 NaN / Infinity）；
- **槽位两段式**：`usage` = 本轮运行累计快照，`carryUsage` = 历史轮次结转；
  展示口径 = `carryUsage + usage`，即成功 + 失败 + 重试的总量。
- 失败页 / 失败目录带**最后一次累计快照**：原先失败事件不带 usage，会让已消耗的 token 记成 0；
  重试/重新生成时把上一轮 `usage` 结转到 `carryUsage`（幂等），而不是清空槽位。
- 「重试」指本轮运行里已上报的累计快照（含失败前已消耗的部分）。pi 的 ledger **不记录失败的 provider 尝试**
  （429 等未落地响应没有 usage，也不会进入 `result.usage`）——这一点与 token 预算口径保持一致；
  若服务端确实为失败请求计费，需要另行走 `harness.recordUsage()` 记账（当前未做，见 §16.8）。

### 16.4 并发正确性（多页 p-limit 同时生成）

合计**不是**共享计数器上的增量累加，而是渲染时对「每页自己的累计快照」做一次**幂等 reduce**
（`apps/cli/src/views/wiki-generate/usage.ts` 的 `collectUsageTotals`）：

| 并发问题 | 派生 reduce 的答案 |
|---|---|
| 多页事件交错到达 | 每页的用量只写自己的 state 槽位；单线程事件循环内顺序应用，互不覆盖 |
| 同一份快照重复上报（`requesting` / `responding` / `tool_*` 携带同一快照） | reduce 重算不变；增量累加会重复计数 |
| 事件到达顺序 | 与顺序无关（加法可交换） |
| 页面重新生成 / 目录重试 | 槽位分两段：重试时把上一轮 `usage` 幂等结转到 `carryUsage`，清零的只是本轮快照（合计 = carry + 本轮） |
| 同一页正在生成时再按 `r` | `regeneratePage` 直接忽略（两次运行写同一槽位会让快照交错、合计失真） |
| 失败页 / 失败目录 | 事件带最后一次快照 + mapper `event.usage ?? 旧值` 兜底 |
| 运行中快照不是累计值 | `create-agent.ts` 把 assistant 事件的**单次响应用量**累加成累计快照（最终由 result 的 ledger 值覆盖） |

### 16.5 改动清单

| 位置 | 改动 |
|---|---|
| `packages/agent-runtime/src/usage.ts`（新增） | `emptyTokenUsage` / `addTokenUsage` / `sumTokenUsage` |
| `packages/agent-runtime/src/index.ts` | 导出上述三个纯函数 |
| `packages/orchestrator/src/agents/create-agent.ts` | assistant 的 usage 从「覆盖为最后一次响应」改为**累加**；`error` 事件带上累计用量 |
| `packages/orchestrator/src/wiki/generate-wiki.ts` | 页面 `onEvent` 记录 `lastUsage`；`page_error` 带上它 |
| `apps/cli/src/views/wiki-generate/usage.ts`（新增） | `toUsageTotals` / `slotUsageTotal` / `collectUsageTotals` / `cacheHitRatio` / `formatPercent` |
| `apps/cli/src/views/wiki-generate/types.ts` | `CatalogState` / `PageStatus` 新增 `carryUsage`（历史轮次结转） |
| `apps/cli/src/views/wiki-generate/mapper.ts` | `scanning` / `parsing` / `page_start` 把上一轮 `usage` 结转到 `carryUsage`（幂等）；失败/完成/重试事件缺用量时保留旧快照，且不丢 `carryUsage` |
| `apps/cli/src/views/wiki-generate/controller.ts` | 重试时不清理槽位用量；同一页生成中忽略重复的 `r` 触发；目录失败/扫描异常的赋值改成保留 carry |
| `apps/cli/src/views/wiki-generate/index.ts` | 底部导航下方渲染合计行（用量为 0 时不渲染、不占行）；行内用量也改用「结转 + 本轮」口径；i18n `wikiGenerate.usageTotals` |
| `package.json` | `test:tui` 增加 `bun test apps/cli/src/views/wiki-generate/__tests__` |

### 16.6 行为差异 / 边界

- 中间事件的 `usage` 从「最后一次响应的用量」变为「该 Agent 运行至今的累计快照」：单行显示随生成推进单调增长，
  与底部合计同一口径（契约字段没变，语义更贴合 mapper 里既有的「usage 已是累积总量」注释）。
- **重试/重新生成不清零**：按 `r` 后合计只增不减（上一轮结转 + 本轮快照）；失败页的消耗也一直留在槽位里。
  同一页正在生成时再按 `r` 会被忽略（避免两次运行写同一槽位）。
- **polish 用量不在合计里**：`polish.mode=full` 的 polish Agent 用量记在 `PageResult.polish.tokenUsage`，
  没有进入 TUI 事件（见 §15.7），合计只覆盖目录 Agent + 页面 Agent。
- `mode=manage` 打开的文档全部已存在时没有任何用量，合计行不渲染（不占屏幕行）。
- 复用 `usage` / `carryUsage` 是**展示账本，不参与预算**：每轮 Agent 的 token 预算仍由 harness 按该轮 ledger 判定。

### 16.7 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:agent` | 19/19（新增 `addTokenUsage` / `sumTokenUsage` 纯函数断言） |
| `bun run test:pages` | 16/16 + 7/7 + 16/16（新增：预算耗尽页的 `page_error` 带累计用量 `{"input_tokens":150,"output_tokens":50}`） |
| `bun test apps/cli/src/views/wiki-generate/__tests__` | 25/25（事件映射 + 用量合计 + 槽位结转：幂等 / 重试不清零 / 失败快照 / 0 分母边界 / 生成中忽略重复触发） |
| `bun run test:tui` | smoke-tui 209、real-run 9、output-guard 10、target-dir 25、**wiki-generate 单测 25**、mock-generate 28（新增 7 项：底部合计的输入 / 输出 / 缓存占比 + 「合计行是最后一行」+ 重新生成后 720→960 继续累加）、browse-server 28 |
| `bun run test` | 全部套件通过（catalog 34、agent 19、tools 102、installer 70、history 61+24+10、lock 10、http 12、provider 5、analyzer 5+17、blueprint 10+11+17、pages 16+7+16、context 45、tui 209+9+10+25+25+28+28） |
| `bun run mock:wiki` | `completed=4 failed=0` |

### 16.8 风险与未决

- **缺失末轮用量**：Agent 抛错（非 result 事件路径）时 `page_error` 带的是最后一次事件快照，
  不是 ledger 终值；对合计是可接受的近似（失败页仍会计入），后续可让适配层在异常路径也回报 ledger。
- **失败的 provider 尝试不计入**：pi ledger 只在响应落地时记账，429 等失败尝试没有 usage；
  若服务端为失败请求计费，需要在适配层用 `harness.recordUsage()` 补一笔（同时会影响预算口径，需先定方案）。
- **polish 用量未并入**：需要改 `ArticleEventPayload` / `PageStatus` 才能把 `polish.tokenUsage` 带进 TUI（未做）。
- **合计不区别模型计价**：只统计 token，不折算费用（`TokenUsage` 不含 cost；pi 的 `Usage.cost` 在映射时被丢弃）。


## 17. 蓝图生成改为三阶段多重循环（第十五步）

### 17.1 目标与判定

旧实现是「单 Agent 一次性吐全量蓝图」（`generate_blueprint`）：模型要在一段有限的输出预算里既要分类、又要给每篇页面起名、填 group/level/associatedFiles。
实践上模型会提前收敛——**输出轮次过多导致文章数偏少**（一个分类塞成一两篇），且一次失败就要整段重来。

第十五步把它拆成**分类 → 分主题 → 标题**三阶段多重循环：

| 阶段 | 执行方式 | AI 输出工具 | 代码侧动作 |
|---|---|---|---|
| 1 分类 | 1 个 Agent（Repo Map 全局分析） | `submit_sections`（4~8 个 section：title + description） | 写 wiki.json 骨架（sections + 空 pages），强制包含概览/快速开始/核心架构 |
| 2 分主题 | 遍历 sections，每 section 1 个 Agent，p-limit 并发 | `submit_section_topics`（title 草稿 + slug + group + level + associatedFiles） | 统一分配 slug 序号与 file 名、去重，加锁读-改-写合并进 wiki.json；单 section 失败记 `failedSections` 不阻断其余 |
| 3 标题 | 遍历 sections（有页面的），每 section 1 个 Agent | `refine_section_titles`（仅 slug + title） | 写回 title；输出量极小，失败保留原 title |
| 4 文章 | 现有 `generateWikiContent` | `write_page`（不变） | 不改 |

**不变量**：每阶段落盘后 `loadWikiBlueprint` 始终可加载（`pages` 为空时只要 `sections` 非空就合法）；slug/file 编号与去重由代码管理；每阶段失败的 section 不阻断整体。

### 17.2 契约变化（均为向后兼容的「新增可选」）

- `WikiOutput.sections?: WikiSection[]`（旧 wiki.json 没有该字段；读取方按「从 pages 推导」回退，`sectionsFromBlueprint`）；
- `WikiTopic`（主题阶段草稿）；`WikiSection`；
- `BlueprintResult` 新增 `pagesCount` 语义（最终页面数）、`sectionsCount?`、`failedSections?`；
- `CatalogEvent` 新增 `stage?: 'classify'|'topics'|'titles'`、`section?: string`、`progress`（带 stage 时为分类级进度）、`failedSections?`（complete 事件携带）；
- utils 新增：`initWikiSkeleton` / `mergeWikiSections` / `mergeSectionTopics` / `applySectionTitles` / `writeWikiPages` / `normalizeBlueprintSections` / `mergeBlueprintSections` / `deriveSectionsFromPages` / `sectionsFromBlueprint` / `slugStem` / `nextPageIndex` / `normalizeLevel`（唯一落盘口径：文件锁 + 临时文件 rename 原子替换）；
- `loadWikiBlueprint` 放宽：`pages` 为空但 `sections` 非空时可加载（骨架阶段）。

### 17.3 为什么 slug 由代码分配

模型只输出「这个分类下应该写哪些文章」与元数据；slug 由「全局序号 + 英文词干（topic.slug 提示，缺省从 title 派生，非 ASCII 回退为 `page`）」生成，
同分类内 title 去重、全库 slug 去重。这样：
- 编号连续、URL 稳定，不受模型命名漂移影响；
- p-limit 并发 section 时，文件锁内的「读-改-写」保证编号不撞车（见 `mergeSectionTopics`）。

### 17.4 sync-wiki 迁移到新机制（增量修补）

`syncWiki` 不再让模型一次性重排整个 wiki.json：

1. 文件 diff（沿用 manifest/hash）；
2. 变更命中既有页面关联路径的 section + （未覆盖的新增文件触发的）分类合并结果 = 「变更 section」；
3. 只对变更 section 跑主题 / 标题阶段（主题阶段 `reuseExisting: true`：按 slug/title 复用旧 slug/file，URL 漂移为 0）；
4. 页面状态（`new` / `updated` / `archived` / `unchanged`）由代码比较新旧页面机械判定（`computeSyncDiff`），不再由模型输出 status；SyncDiff 语义不变；
5. 新增文件不属于任何既有页面时，才额外跑一次分类阶段（merge 模式：保留既有分类与页面，只补新分类）；
6. 归档判定按**文件系统实际存在**（README 等不入 manifest 的关联路径不会被误判为删除）。

模型漏报旧页面时（新清单缺失），只要文件仍在就原样保留为 `unchanged`，避免增量修补丢页面。

### 17.5 CLI 展示

生成页（`/wiki/generate`）按 `stage` / `section` / 分类级 `progress` 渲染阶段切换：
`规划主题中` → `拟定标题 {current}/{total}` → `精修标题 {current}/{total}`（第十九步起 Agent 行标签与阶段进度同词，
内部 stage 名仍是 `classify` / `topics` / `titles`，见 §21.3）；
完成时若有失败分类，显示 `完成 · N 个分类失败`。目录状态新增 `stage/section/sectionsProgress/failedSections` 槽位（mapper 纯函数可单测）。

`loadWikiBlueprint` 放宽后，只有骨架（pages 为空）的 wiki.json 在首页视同「尚无目录」，不会再出现「文档已生成 (0 篇)」的卡死状态。

### 17.6 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:blueprint` | e2e-blueprint 27/27（三阶段正向 + 骨架可加载 + 聚合用量 = 所有请求之和 + 失败语义）；e2e-sync 19/19（updated/archived/new/unchanged、URL 不漂移、无变更不调 LLM、漏报兜底）；context-files 11/11；style-discipline 17/17 |
| `bun test apps/cli/src/views/wiki-generate/__tests__` | 28/28（新增 stage/section/进度映射 + scanning 清空 + failedSections） |
| `bun run test:tui` | smoke-tui 209、real-run 9、output-guard 10、target-dir 26、wiki-generate 单测 28、mock-generate 31（新增「生成页渲染三阶段进度文案」）、browse-server 28 |
| `bun run test` | 全部套件通过 |
| `bun run mock:wiki` | `completed=6 failed=0`（夹具 hello-python：3 分类 / 6 页） |

### 17.7 风险与未决

- **分类阶段是单点**：只有 1 个 Agent，失败即整段重试（成本可控——分类输出很小）；后续可考虑「分类失败时回退到从旧 wiki.json / 目录树机械推导基础分类」。
- **slug 编号顺序不稳定**：section 并发完成顺序决定页面在 wiki.json 中的先后与编号（编号本身连续、无碰撞）；如需稳定顺序，可在阶段 2 结束后按 section 顺序重排并重编号。
- **sync 的分类刷新是条件触发**：只有「新增文件不属于任何既有页面」时才跑分类阶段；纯重命名/移动目录但未新增文件时，分类不会重划（变更文件仍会落到受影响 section 的增量修补里）。
- **标题精修会触发重生成**：sync 中标题变化按 `updated` 处理（保证 .md 的 frontmatter 与目录一致）；弱模型若反复微调标题，可能造成不必要的重生成。
- **归档判定是「关联路径全部消失」**：associatedFiles 填得过宽（例如关联整个仓库根目录）会延迟归档；这属于主题阶段提示词质量问题，不是状态机问题。

---

## 18. 蓝图细节档位（blueprint.detail，第十六步）

### 18.1 目标与判定

把「项目理解深度」交给用户：快速了解用低档，完整交付用高档；默认 `high` = 旧行为零变化。
三阶段管线（分类 → 分主题 → 标题）对所有档位统一保留，**不回退旧单 Agent 方案**
（§17 已废弃：提前收敛、一次失败全重来）。数量控制 = 「提示词数量目标 + 常驻数量反馈 +
AI 归并 + 代码兜底」四层机制，代码不替 AI 做语义决策。

| 档位 | 分类数 | 每分类文章数 | 标题精修 | 附加要求 |
| --- | --- | --- | --- | --- |
| `minimal` | 固定 1（概览） | 固定 1 | 跳过 | 页面提示词附加「全景导览」：必须用 Mermaid 架构图梳理模块关系与数据流 |
| `low` | 3~5（基础分类已强占 3） | 1~3 | 跳过 | — |
| `medium` | 4~6 | 3~5 | 保留 | — |
| `high`（默认） | 4~8 | 3~10 | 保留 | — |
| `max` | 4~8 | 5~12 | 保留 | 强调全面详尽、鼓励更深关联文件探索 |

### 18.2 四层数量防线（代码落点）

1. **提示词数量目标**：`renderClassifyPrompt` / `renderTopicsPrompt`
   （`orchestrator/src/prompts/classify.ts` / `topics.ts`）按档位参数化「数量」段落；
   minimal 的「固定 1 个」与 max 的「深挖关联路径」都在这里。
2. **常驻数量反馈**：`submit_sections` / `submit_section_topics` 的**每次**返回都带
   `分类数量反馈：当前 N / 要求 min~max（当前档位：X）`；区间内也发（零额外成本，模型随时自我校准）。
   sync（merge / reuseExisting）时反馈注明「只校验上限，既有内容必留」。
3. **AI 归并（主路径）**：越界提交**不落盘、不报错**（`is_error` 不置位），返回策略文本请求重提：
   过多 → 归并策略（基础分类 / 高密度核心机制永不归并；sync 下既有分类必留、新增优先并入）；
   不足 → 拆分 / 补充策略；最多 `MAX_QUANTITY_FEEDBACK_ROUNDS = 2` 轮。第 3 轮改为
   **缩编 subagent**：`createAgent` + 覆盖 `systemPrompt`（`CONDENSE_SYSTEM_PROMPT`）+ 独立小预算
   （`DEFAULT_CONDENSE_TOKEN_BUDGET = 60_000`）+ 一次性只读输出工具
   （`submit_condensed_sections` / `submit_condensed_topics`，只捕获不落盘）；工具面只有输出工具、
   只看清单本身，打破自我锚定；其结果仍由阶段驱动器走 `mergeWikiSections` / `initWikiSkeleton` /
   `mergeSectionTopics` 落盘（文件锁与编号单点），失败静默降级。
4. **代码确定性兜底（永不悬挂）**：分类 = 基础分类保序取前 N（`normalizeBlueprintSections` /
   `mergeBlueprintSections`）；主题 = 每 distinct group 保 1 篇再按序填充（`condenseTopicsToMax`，
   sync 下用 `preserveTitles` 让既有页面优先）；结果注记
   `QUANTITY_FALLBACK_NOTE =「（已达到调整轮次上限，代码侧收尾）」`（tool_result / 日志可见）。

### 18.3 与旧实现的行为差异（有意为之）

- **越界不再静默截断**：旧实现 `normalizeBlueprintSections` 直接 `slice(0, 8)`；现在先请模型归并，
  截断只作为最后兜底并写明注记。
- **数量下限也生效**：旧提示词要求「4~8 个分类 / 3~10 篇」但代码不校验；现在低于下限同样要求补充
  （sync 除外：旧页面必留，只校验上限）。
- **标题阶段随档位跳过**：low / minimal 不跑 `refine_section_titles`（目录生成更快、更省）。
- **minimal 跳基础分类强补**：`normalizeBlueprintSections(..., { minimal: true })` 只保留「概览」；
  页面提示词附加 `MINIMAL_PANORAMA_REQUIREMENT`（Mermaid 架构图 + 数据流）。
- **缩编输出工具进入预算提示集合**（`OUTPUT_TOOL_NAMES`），缩编 Agent 预算耗尽也会被强制交卷。

### 18.4 契约与新增导出

- `AppConfig.blueprint: { detail: BlueprintDetailLevel }`；旧 `config.yaml` 缺段 → `validateConfig` 补 `high`，
  非法值回退 `high`，可直接启动。
- utils：`normalizeBlueprintSections(input, language, limit?, { minimal? })` /
  `initWikiSkeleton(..., { limit?, minimal? })` / `mergeWikiSections(..., { limit?, minimal? })` /
  `mergeBlueprintSections(..., limit?)`（均为新增可选参数）。
- orchestrator 新增导出：`BLUEPRINT_DETAIL_SPECS / getDetailSpec / judgeQuantity / formatQuantityFeedback /
  buildSectionQuantityStrategy / buildTopicsQuantityStrategy / buildCondenseSectionTask / buildCondenseTopicsTask /
  codeFallbackSections / condenseTopicsToMax / MINIMAL_PANORAMA_REQUIREMENT / QUANTITY_FALLBACK_NOTE /
  MAX_QUANTITY_FEEDBACK_ROUNDS / DEFAULT_CONDENSE_TOKEN_BUDGET / CONDENSE_SYSTEM_PROMPT`；
  `renderClassifyPrompt` / `renderTopicsPrompt`；`createSubmitSectionsTool` / `createSubmitSectionTopicsTool` /
  `createSubmitCondensedSectionsTool` / `createSubmitCondensedTopicsTool`；`generate-wiki` 的 `buildPagePrompt`。
- 工具语义：`submit_sections` / `submit_section_topics` 越界时返回**非 error** 的策略文本，
  阶段驱动器以 quantity state 的 `persisted`（而非 tool error）判定落盘。

### 18.5 配置界面

新增 `/config/detail`（五档单选 + Enter 应用 / s 保存），配置项 `blueprint.detail`；
文案见 `apps/cli/src/i18n/translations/{zh-CN,en-US}.ts`；渲染覆盖进 `render-all-routes`。

### 18.6 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:catalog` | 37/37（新增缺省 high / 合法值保留 / 非法值回退） |
| `bun run test:blueprint` | e2e-blueprint 29/29；blueprint-detail 83/83（纯函数 + 工具级 + 缩编成功 / 失败降级 / minimal）；e2e-sync 19/19；context-files 11/11；style-discipline 17/17 |
| `bun run test:pages` | e2e-page-generation 19/19（新增 minimal 全景导览传递）；page-output-fallback 7/7；page-polish 16/16 |
| `bun run test:tui` | smoke-tui 225、real-run 9、output-guard 10、target-dir 36、wiki-generate 单测 28、mock-generate 42、browse-server 28；`render-all-routes` 21 个路由 |
| `bun run test` | 全部套件通过（EXIT=0） |
| `bun run mock:wiki` | `completed=5 failed=0`（夹具 hello-python，low 档位 3 分类 / 5 页） |

### 18.7 风险与未决

- **下限可能多花一轮**：真实模型偶发少给 1 篇文章时会触发一次归并重提（第 2 轮通常即合规）；
  若希望完全零打扰，可把档位降到 `low`（下限 1 篇）。
- **缩编 subagent 需要额外一次 LLM 调用**：只在「原对话两次不收敛」时触发；缩编本身也可能失败，
  此时代码兜底保证必定落盘（可能比目标数量少，但不会悬挂）。
- **sync 不校验下限**：既有页面必留，只对总量上限做归并；新增分类不足下限不会要求补足
  （同步的目标是增量修补）。
- **合计用量口径**：缩编 subagent 的用量进入 `CatalogEvent.usage` 聚合（与阶段 Agent 同池），
  但底部合计的「页维度」口径不变；polish 用量仍只记在 `PageResult.polish`（见 §16.6）。

---

## 19. 多档共存 + 浏览切换（第十七步）

### 19.1 目标与存储布局

让同一仓库可以同时保留多个档位的完整产物，并在浏览站里一键切换；遗留的无档位产物保持只读可用。

```
.zread-pi/wiki/
  minimal/   wiki.json + <section>/<file>.md + archived/<快照>/
  low/       …
  medium/    …
  high/      …
  max/       …
  wiki.json  ← 旧版遗留（只读兼容，browse 中显示为「默认」）
```

- 每个档位子目录是一套独立完整产物（目录 + 全部页面文件），互不覆盖、可共存；
- 新生成一律写档位子目录；遗留的无档位 `wiki/wiki.json` 不再写入；
- `WikiOutput.detail?` 记录生成档位（旧文件无该字段，读取以目录名 / 请求参数为准）。

### 19.2 路径口径与解析规则

`packages/utils/src/file-io.ts` 是唯一路径口径：

- `getWikiDir(detail?)` / `getWikiJsonPath(detail?)`：传档位 = `wiki/<detail>`；不传 / null = 遗留 `wiki/`；
- `listWikiVariants(wikiRoot?)`：枚举「wiki.json 可解析且 pages 为数组」的档位子目录 + 遗留目录，
  返回 `WikiVariantInfo { detail, legacy, generatedAt, pagesCount, sectionsCount }`（档位顺序 + 遗留最后）；
- `resolveWikiVariant(preferred?, wikiRoot?)`：配置档位对应的变体存在 → 用它；否则遗留；否则第一个档位；
  都没有 → `undefined`（`wikiRoot` 供 browse 服务器传入目标项目路径，不依赖进程 cwd）。

### 19.3 各层落点

| 层 | 改动 |
|---|---|
| utils wiki-content | 全部落盘/加载函数新增可选 `variant`（`initWikiSkeleton` / `mergeWikiSections` / `mergeSectionTopics` / `applySectionTitles` / `writeWikiPages` / `loadWikiBlueprint(path?, variant?)` / `generateWikiJson(..., variant?)`）；骨架写入 `WikiOutput.detail` |
| utils storage/wiki-store | `new WikiStore(detail?)`：页面源目录 = 变体目录（顺带修正归档源为 `<section>/<file>`），归档到 `<变体>/archived/<快照>/<section>/` |
| orchestrator | `generateWikiCatalog(onEvent?, { detail? })`（缺省 = 配置档位）写入目标档位；`syncWiki(onEvent?, { detail? })`（缺省解析活动变体）只读写一个变体；阶段上下文新增 `variant` / `detail`，输出工具经 `variant` 注入目录 |
| 页面生成 | `generateWikiContent({ detail? })`：catalog / 页面文件 / 落盘兜底 / `createWritePageTool(variant)` / 提示词输出路径全部随变体；`buildPagePrompt(page, spec, variant?)` |
| CLI 生成/同步控制器 | 首页 store 区分「活动变体」（任一档位，状态标题 + 浏览入口）与「写盘目标」（配置档位）：生成 / 继续 / 管理 / 同步 / 强制重新生成均作用于配置档位；遗留目录不会被写入（强制重新生成只清理目标档位子目录）；归档 `new WikiStore(detail)` |
| CLI 完整文档判定 | 首页与 `adoptExistingProject` 改为「任一档位（含遗留）完整即算已有文档」，逐一检查每个变体 |
| browse 服务端 | 新增 `GET /api/wiki/variants`（含 `active`）；`catalog` / `content/:slug` / `source` 接受 `?detail=`：缺省 = 配置档位 → 遗留 → 第一个存在；`default` = 遗留；非法值 / 档位不存在 → 404；页面文件按变体目录解析 |
| browse 前端 | `types` 新增 `WikiVariant` / `WikiVariantsResponse`；`wikiApi` 三个方法加 `detail` 参数 + `getVariants()`；`WikiContext` 新增 `variants` / `detail` / `setDetail`（重拉 catalog、同 slug 保留否则落首页、重展开目录树）；`WikiSidebar` 底部上拉选择器（名称 + 篇数，当前高亮） |

### 19.4 契约与兼容

- 均为新增可选参数 / 字段：`getWikiDir(detail?)`、`getWikiJsonPath(detail?)`、`listWikiVariants()`、`resolveWikiVariant()`、
  各落盘函数的 `variant`、`WikiOutput.detail?`、API `?detail=`；旧调用点零改动（不传 variant = 遗留目录）。
- 遗留目录只读兼容：browse 无任何档位目录时行为与现状完全一致（默认解析到遗留目录）；
  CLI 对遗留目录仅提供浏览 / 补录，写操作统一落到配置档位。
- 兼容边界：`listWikiVariants` 接受 `wikiRoot` 参数，供 browse 服务器对目标项目（而非进程 cwd）枚举变体。

### 19.5 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:blueprint` | e2e-blueprint 29/29（产物落在 `wiki/high/`）；blueprint-detail 95/95（工具级用例按变体目录落盘 / 读取；新增变体枚举与遗留兼容）；e2e-sync 19/19（sync 只作用于 high 变体）；context-files 11/11；style-discipline 17/17 |
| `bun run test:pages` | e2e-page-generation 19/19（页面落在 `wiki/high/`）；page-output-fallback 7/7（遗留路径救援链不变）；page-polish 16/16 |
| `bun run test:browse` | 50/50（新增 variants API / `?detail=` / 非法值 404 / 缺失档位 404 / 遗留回退 / 多档并存 / 变体目录正文解析 / 仅有变体的目录识别；无 `apps/browse/dist` 时含 4 项 Vite 兜底） |
| `bun run test:tui` | smoke-tui 225、real-run 9、output-guard 10、target-dir 36、wiki-generate 单测 28、mock-generate 42、browse-server 50；`render-all-routes` 21 个路由 |
| `bun run test:history` | 61 + 24 + 11（adopt 新增「档位变体（wiki/high）完整自动登记」） |
| `bun run test` | 全部套件通过（EXIT=0） |
| `bun run browse:build` | 前端 tsc -b + vite build 通过（删除 dist 以保留 test:browse 的 Vite 兜底覆盖） |
| `bun run mock:wiki` | `completed=5 failed=0`（产物在 `fixtures/hello-python/.zread-pi/wiki/low/`） |

### 19.6 风险与未决

- **多档产物无自动清理**：每个档位目录独立保留，磁盘占用随档位数线性增长；后续可在配置界面加「删除某档位产物」（未实现）。
- **编辑配置档位后旧变体不变为「活动」**：`resolveWikiVariant` 优先配置档位，切回旧档位需把配置改回去；
  浏览站的档位选择器不修改配置（仅当次浏览）。
- **遗留目录无写入路径**：遗留项目需通过「生成文档 / 强制重新生成」产出配置档位产物后才能同步 / 管理；
  浏览页的「默认」条目仅用于阅读。
- **browse 缺省档位依赖服务端配置**：`loadConfigSync()` 读的是 CLI 进程的用户配置；多用户共享同一项目目录时以启动服务器的用户配置为准。

## 20. 三阶段大纲逐级注入 + 约束收敛（第十八步）

### 20.1 目标与机制

分类 → 分主题 → 标题三个阶段各自携带一份逐级细化的大纲：上一级的产物作为下一级的**硬约束边界**，
避免「分类 Agent 跑去讲别的模块、主题 Agent 越界到其他分类、标题精修跑题」的全项目漂移。

```
分类大纲（project outline）        ← 分类阶段产出，注入所有下游 Agent
  └─ 条目 = title + description + scope（包含 / 不包含边界清单）
       └─ 主题大纲（section outline）← 分主题阶段产出，只注入本分类的下游 Agent
            └─ 条目 = title + summary + associatedFiles
                 └─ 页面提示词（topicSummary + 关联路径 + 范围纪律）
```

关键点：不止「带上文」，还带上**负向边界**。正向 description 只说明「写什么」；
scope 里的「不包含：…（→ 相邻分类）」才阻止模型「顺手写别的」——这是防漂移的主要手段。

### 20.2 字段与落点

| 层 | 改动 |
|---|---|
| types | `WikiSection.scope?: string[]`（包含 / 不包含边界清单）、`WikiTopic.summary?: string`（一句话主题摘要）、`WikiPage.topicSummary?: string`（summary 透传）——全部可选，旧 wiki.json 照常读取 |
| classify 提示词 | 硬性要求每个分类给 scope：1~3 条「包含：…」+ 1~3 条「不包含：…（→ 相邻分类）」，分类间互斥；示例同步更新 |
| output-tools | `SECTION_ITEM_SCHEMA` 声明 `scope`、`TOPIC_ITEM_SCHEMA` 声明 `summary`；`summarizeSections` 回显 scope（模型可见的确认） |
| utils | `normalizeBlueprintSections` 透传 scope（基础分类保留强补 title/description，但采纳模型声明的 scope；不再原地改写共享常量对象）；`mergeBlueprintSections` 仅在既有分类缺失时补齐 scope；`mergeSectionTopics` 把 summary 透传为 `page.topicSummary`（sync 复用可更新，缺失时保留旧锚点） |
| topics 阶段 | `renderTopicsPrompt` 新增「范围锁定（scope，硬约束）」，`summary` 进入输出规范与示例；`buildTopicsPrompt` 注入「范围边界（scope）」（无则省略）；`SYNC_TOPICS_RULES` 把 summary 列为逐字保留字段 |
| titles 阶段 | 新增「不越出分类边界」规则；`buildTitlesPrompt` 注入 scope |
| 页面阶段 | `buildPagePrompt` 注入 `**主题摘要**:`（无则省略）+ 一行范围纪律（不得超出主题摘要 / 关联路径划定范围） |
| sync | 旧页面清单带上 summary（供逐字带回）；分类合并的 extraContext 带上旧 scope |
| 缩编 / 兜底 | 缩编提示词带上 scope / summary 与「原样保留」规则；代码兜底遍历对象，天然保留 |

### 20.3 明确不做

- **不做**代码级越界校验 / 归并拒绝：scope / summary 是语义约束，无法机械判定「越界」，
  因此只有「注入 + 提示词约束」一层（数量控制可机械判定，才有多层防线）；
- 不改工具名与既有必填字段；minimal 档位不做特判（单分类单篇，scope 生成后基本不起约束作用）；
- `computeSyncDiff` 不感知新字段（status 仍由 title / group / level / 关联路径机械判定）。

### 20.4 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:blueprint` | e2e-blueprint 29/29；blueprint-detail 115/115（新增 B9 字段透传 / 旧数据兼容 / sync merge 补齐 scope、A10 提示词与 schema、C1/C2 全链路 scope+summary 落盘与注入断言）；e2e-sync 23/23（summary 逐字带回 + scope 注入 + 合并保留）；context-files 11/11；style-discipline 17/17 |
| `bun run test:pages` | e2e-page-generation 22/22（topicSummary 注入 / 缺省省略 / 范围纪律）；page-output-fallback 7/7；page-polish 16/16 |
| `bun run test` | 全部套件通过（EXIT=0） |
| `bun run mock:wiki` | `completed=5 failed=0` 不回退 |

### 20.5 风险与未决

- scope / summary 的质量取决于模型，代码不做语义校验；字段缺失时下游按「无边界」降级（旧产物等价）。
- 同步时 summary 依赖模型逐字带回；即使模型漏带，`mergeSectionTopics` 也保留旧锚点（不漂移、也不更新）。
- 缩编 subagent 若不按提示保留 scope / summary，该路径会丢弃它们（代码兜底路径不丢）。

## 21. 生成页逐 Agent 行 + 上下文占比（第十九步）

### 21.1 目标

生成文档界面（`/wiki/generate`）的**每条目右侧状态后**都要看到四个指标：
输入 token、输出 token、缓存占比、当前上下文占比（已用 / 上下文窗口）——**完成 / 失败也照常显示**，
且不能再有「运行时才有数字、完成后什么都不剩」的空窗。

目录生成会并发跑多个 Agent（分类 1 个 + 每个分类的主题 / 标题各 1 个 + 数量越界的缩编 subagent），
因此「目录」不再是一行聚合：**每个 Agent 一行**（缩进在目录聚合行下方），各自带自己的状态与四个指标；
文章列表的每篇文章同样带四个指标。

### 21.2 数据来源与口径

| 需要的东西 | 来源 | 口径 |
|---|---|---|
| 上下文窗口 | harness 的 `system/init` 新增 `context_window`（`driver.ts` 取 `request.model.contextWindow`） | 本次运行实际解析出的模型（含自定义 / 回退默认 200k） |
| 上下文已用 | `orchestrator/src/agents/create-agent.ts` 从**最近一次 assistant 响应的 usage** 计算 | `input + output + cacheRead + cacheWrite`，与 pi compaction 的 `calculateContextTokens` 同口径（不是累计用量） |
| 逐 Agent 身份 | `CatalogEvent.agentKey` / `agentRole` / `agentStatus` | `classify` / `topics:<section>` / `titles:<section>` / `condense:<...>` |
| 行内用量 | `CatalogEvent.agentUsage` | 该 Agent **自己**的累计快照（`usage` 仍是目录级聚合，两者不同语义，不能混用） |

生命周期事件：计划行（`agentStatus: 'waiting'`，阶段开始时一次性铺全所有 Agent）→ `running`（开始前一条 +
create-agent 的流式事件）→ 终态（`completed` / `failed`，在用量结算进聚合账本**之后**发出，
`usage` = 新聚合值、`agentUsage` = 该 Agent 终值）。
业务层判定「模型没调输出工具 / Agent 报错」时由 `markAgentFailed()` 补一条 `agentStatus: 'failed'`，
覆盖「Agent 运行正常结束但没产出」的行状态（单 section 失败仍不阻断其余，语义不变）。

### 21.3 CLI 落点

| 位置 | 改动 |
|---|---|
| `agent-runtime/src/types.ts` / `harness/driver.ts` | `SDKSystemMessage.context_window?`；init 事件带模型上下文窗口 |
| `orchestrator/src/types.ts` / `wiki/types.ts` | `CatalogEvent` 新增逐 Agent 字段 + 上下文报表值；`ArticleEventPayload` 新增上下文报表值 |
| `orchestrator/src/agents/create-agent.ts` | `AgentResult` 新增 `contextTokens?` / `contextWindow?`；所有事件带上下文报表值 |
| `orchestrator/src/agents/blueprint-stages.ts` | 计划 / running / 终态事件 + `markAgentFailed`；缩编 subagent 单独成行（`agentRole: 'condense'`） |
| `orchestrator/src/wiki/generate-wiki.ts` | 页面事件转发 `contextTokens` / `contextWindow`（`page_complete` 优先用 `AgentResult` 终值，`page_error` 用最后已知值） |
| `apps/cli/.../wiki-generate/types.ts` | `CatalogAgentState` + `CatalogState.agents`（key = agentKey，插入顺序 = 展示顺序）；`PageStatus.contextTokens/contextWindow` |
| `apps/cli/.../wiki-generate/mapper.ts` | `applyAgentEvent`（逐 Agent 行）；带 `agentKey` 的 `complete` / `error` 只改行、不改目录整体状态；`scanning` 清空行（用量已进聚合 `carryUsage`）；页面上下文「终态沿用 / `page_start` 清零」 |
| `apps/cli/.../wiki-generate/controller.ts` | **只把不带 `agentKey` 的 `complete` 当作目录完成**（否则首个 Agent 完成就会 reload + 提前启动页面，见 21.5）；转发逐 Agent 字段 |
| `apps/cli/.../wiki-generate/index.ts` | 目录聚合行 + 逐 Agent 缩进行；`usageSuffix()` 统一四个指标 + 耗时；重试倒计时覆盖目录 Agent |
| `apps/cli/src/views/wiki-sync/controller.ts` | 同步页不展示逐 Agent 行，忽略带 `agentKey` 的事件（否则单 Agent 终态会被当成目录完成 / 失败） |
| `apps/cli/src/utils/display.ts` | `formatBytes` 增加 `M` 档（如 1M 窗口不再显示 `1000.0k`） |

展示格式：`[完成] ↑12.0k ↓1.3k · 缓存占比 50.0% · 上下文 24.0k/200.0k (12.0%) · 1.2s`，
无数据的片段自动省略（不占位）；窄终端由 `renderTwoColumn` 按显示宽度截断（既有行为）。

**Agent 行命名**（描述「这一步在做什么」，而不是阶段名词）：

| 内部 stage | Agent 行标签（zh） | 干嘛 |
|---|---|---|
| `classify` | 规划主题 | 分析仓库，产出主题（章节）清单与各自范围边界 |
| `topics` | 拟定标题 · <主题> | 为一个主题拟定文章标题（以及文件 / 难度等草稿） |
| `titles` | 精修标题 · <主题> | 精修该主题下已拟定好的标题 |
| `condense`（分类阶段） | 精简主题 | 主题清单超出数量区间时归并精简（缩编 subagent） |
| `condense`（主题阶段） | 精简标题 · <主题> | 标题清单超出数量区间时归并精简（缩编 subagent） |

目录聚合行的阶段进度文案与行标签**同词**（`规划主题中` / `拟定标题 {current}/{total}` / `精修标题 {current}/{total}`），
避免同一阶段在屏幕上出现两种叫法。内部 `CatalogEvent.stage`（`classify` / `topics` / `titles`）、
`agentKey`、wiki.json 的 `sections` 字段名一律不变——UI 用词只影响 i18n 字符串。

### 21.4 兼容性

- 全部为**新增可选字段**：旧 orchestrator 不发 `agentKey` 时 UI 退回原来的单行聚合；
  旧配置 / 旧 `wiki.json` 零影响；`SDKSystemMessage.context_window` 缺省时上下文片段自动省略。
- `CatalogEvent.usage` 语义没变（目录级聚合）；逐 Agent 用量另开 `agentUsage`，
  底部合计（§16）仍按目录聚合 + 页面槽位 reduce，不重复计数。
- 聚合目录行**不展示上下文**（多 Agent 没有单一上下文值）；上下文只在逐 Agent 行与文章行展示。

### 21.5 修掉的竞态（本次一并修复）

逐 Agent 终态事件也是 `type: 'complete'`。生成页控制器原先对**任何** `complete` 都执行
「reload wiki.json → 启动文章生成」，于是分类 Agent 一完成就会拿**当时只有部分页面**的 wiki.json
启动页面批次，`isInitialized` 随即置位，剩余页面永远不会开始（现象：文章只生成前几篇，其余永远等待，
且不再发生任何 LLM 请求）。现在只有不带 `agentKey` 的整体 `complete` 才触发该流程；
同期同步页控制器忽略带 `agentKey` 的事件。

### 21.6 验证（实际执行结果）

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:agent` | 20/20（新增 `system/init` 带 `context_window`，faux 模型 128000） |
| `bun run test:blueprint` | e2e-blueprint 36/36（新增逐 Agent 行 / running+completed 终态 / `agentUsage` / 上下文窗口 200k / 失败分类行标 failed）；blueprint-detail 115/115；e2e-sync 23/23；context-files 11/11；style-discipline 17/17 |
| `bun run test:pages` | e2e-page-generation 24/24（新增页面完成 / 失败事件带上下文报表值）；page-output-fallback 7/7；page-polish 16/16 |
| `bun test apps/cli/src/views/wiki-generate/__tests__` | 37/37（新增逐 Agent 行 5 项 + 页面上下文沿用/清零 1 项 + `contextUsage` 3 项） |
| `bun run test:tui` | smoke-tui 226、real-run 9、output-guard 10、target-dir 36、wiki-generate 单测 37、mock-generate 46（新增「目录按 Agent 分类显示」「目录 Agent 行四个指标」「完成后目录/文章行仍显示四指标」）、browse-server 50 |
| `bun run test` | 全部套件通过（EXIT=0） |

### 21.7 风险与未决

- **上下文「已用」是最近一次响应的报表值**，不是 harness 的 `estimateContextTokens`（后者还会估算
  usage 之后新增消息）；压缩发生在 run 边界，UI 看不到压缩前峰值。对展示可接受，但不要把该数字当预算判据。
- **每行指标变多**：窄终端下右栏可能被截断（优先保留左侧状态图标 + 标题）；如需可后续做「按宽度逐级降级显示」。
- **失败行的错误文案已截断**（首行 60 字符），完整错误仍在日志 / `page_error` 事件里。
- polish Agent 的用量仍不进事件（与 §16.6 相同）。

## 22. 发布说明正文未生效的修复（第二十步）

### 22.1 现象

`.github/release-notes/<tag>.md` 从引入以来（v1.4.0 起）**从未**成为 Release 正文：
v1.4.0 / v1.4.1 / v1.5.0 / v1.5.1 的正文都是自动生成的 `**Full Changelog**: …compare/…`（78 字符），
而仓库里的说明文件是 3.6 ~ 8.4 KB。

### 22.2 根因（有证据）

原 workflow 用的是：

```yaml
body_path: ${{ hashFiles(format('.github/release-notes/{0}.md', github.ref_name)) != '' && format(...) || '' }}
```

当 `hashFiles(...) == ''`（文件在 action 的工作目录里不可见）时，表达式回落为**空字符串**，
而 GitHub Actions 在处理 step `with:` 时会**丢弃空值输入** —— 运行日志的 `with:`
只有 `files` / `generate_release_notes` / `overwrite_files` / `token`，根本不出现 `body_path`，
于是 `generate_release_notes: true` 每次生效。

两点旁证：

1. `softprops/action-gh-release@v2` 的实现是 `config.body_path` 为 falsy 时才回退 `generate_release_notes`
   （空字符串在字符串路径上本应被 `fs.readFileSync('')` 报错，而实际是静默回落）。
2. 仓库根的执行上下文里 `hashFiles` 对这个文件本应命中（在 tag 树上用 `git ls-tree` 验证过文件存在），
   所以问题不在「文件未入库」，而在「输入被过滤」。

### 22.3 修法

`release` job 不再依赖 `hashFiles`：

1. 新增 `actions/checkout@v5`（release job 不跑构建，checkout 成本可忽略）；
2. 新增 `Resolve release notes body` step：shell 判断 `.github/release-notes/${GITHUB_REF_NAME}.md`
   是否存在，写入 `$GITHUB_OUTPUT` 的 `body_path`（不存在时写空值）；
3. `Create Release` 用 `body_path: ${{ steps.notes.outputs.body_path }}`，
   并用同一个输出控制 `generate_release_notes: ${{ steps.notes.outputs.body_path == '' }}`。

未命中时输出空字符串并开启 `generate_release_notes`，行为与文档一致。

**为什么第 3 步要条件化生成开关**：`softprops/action-gh-release` 在 `generate_release_notes: true`
与 `body_path` 同时生效时，会把自动生成的变更列表**追加**在说明文件后面（v1.5.2 的正文
就是「说明文件 + 一段 Full Changelog」，而手工回填的 v1.4.0 ~ v1.5.1 只有文件本身）。
条件化后正文与提交的说明文件**逐字一致**，便于用「body == git show <tag>:<file>」验证。

### 22.4 历史 Release 正文回填

v1.4.0 / v1.4.1 / v1.5.0 / v1.5.1 的正文用仓库内对应说明文件覆盖（`gh release edit --notes-file`）；
v1.5.2 的正文同样是它的说明文件。五个 Release 的正文都与各自 tag 上的文件逐行一致。
说明文件均为人工编写，历史版本号未变，不涉及 tag / 产物变更。

### 22.5 验证（实际执行结果）

| 命令 / 动作 | 结果 |
|---|---|
| `bun run typecheck` | 0 错误（仅 workflow 与文档改动） |
| 工作流片段断言 | 关键片段齐备、`hashFiles` 已无活动引用、无 tab 缩进 |
| 回填核对 | v1.4.0 / v1.4.1 / v1.5.0 / v1.5.1 正文与仓库内说明文件**逐行一致**（`body == git show <tag>:<file>`） |
| v1.5.2 端到端 | 运行日志 `with:` 中首次出现 `body_path: .github/release-notes/v1.5.2.md`（修法生效）；正文 = 说明文件 + 追加的 Full Changelog |
| v1.5.3 端到端 | 条件化 `generate_release_notes` 后，正文与仓库内说明文件逐字一致（无追加段） |
| 下一次 tag | v1.5.2+ 推送后由 CI 自动带上说明文件正文（修法已入库） |

### 22.6 风险与未决

- 回填是**改写已发布 Release 的正文**（AGENTS.md §4.5 的异常处理只允许在 Release 未对外使用时改 tag；
  正文编辑不动 tag / 产物，但仍属对外可见变更，本次由用户明确授权执行）。
- 无说明文件时仍走 `generate_release_notes`，此时 `body_path` 为空值 —— 该输入会被 GitHub 过滤掉，
  等于没传（这正是预期的回落路径）。

## 23. 模型上下文/输出覆盖（llm.context_window / llm.max_tokens，第二十一步）

### 23.1 目标

pi-ai 的模型目录为内置模型提供准确的 `contextWindow` / `maxTokens`，但两类场景下目录值不可信：

1. **目录外模型**：旧配置 / 第三方网关里的模型名不在内置目录里，运行时只能拿到回退默认值
   （`runtime-model.ts` 的 200k / 8192），与真实能力无关；
2. **网关代理**：很多 OpenAI 兼容网关实际提供的上下文/输出上限与它声称的模型不一致
   （例如把 claude 包装成 openai 协议时窗口被打折）。

因此把「上下文大小 / 最大输出 token」做成**用户可覆盖的配置项**，作用在**当前生效模型**上。

### 23.2 语义与落点

| 位置 | 内容 |
| --- | --- |
| `LLMConfig.context_window` / `LLMConfig.max_tokens` | 新增**可选**字段（`number \| null`）；`null` / 缺省 = 跟随模型目录自带元数据；显式正值覆盖。旧 config.yaml 缺省时由 `validateConfig` 归一化为 `null`（老用户零变化） |
| `normalizeModelContextWindow` / `normalizeModelMaxTokens`（`@zread-pi/utils`） | 正整数保留（带 `MIN/MAX` 钳制）；`0` / 负数 / 非数字一律回退 `null`。与 `CustomModelConfig` 的同名字段语义一致，但作用在「当前生效模型」而非某个自定义模型定义上 |
| `orchestrator/src/agents/create-agent.ts` | 读取配置并经 `createAgent({ contextWindow, maxTokens })` 下发；`logger.info` 追加覆盖日志 |
| `agent-runtime` 的 `AgentOptions.contextWindow` / `maxTokens` | 已有字段（适配层早期为兼容旧 SDK 保留），经 `createRuntimeModel` **patch 到解析出的模型对象**上（catalog 命中与回退两条路径都生效） |
| CLI `/config/model-size` | 两个输入框 + 模型目录默认值提示；`tab` / `↑↓` 切字段、`enter` 保存并返回、`s` 保存、`d` 恢复模型默认（两字段清空 = `null`）、`esc` 返回；非法输入不写回并提示范围 |
| 配置首页 | 新增条目「模型上下文/输出」：未覆盖显示「跟随模型默认」，覆盖后显示 `上下文 / 输出`（单项未覆盖显示「默认」） |

效果链路（已由 e2e-blueprint 场景 7 断言）：覆盖值 → 解析出的模型 →
`system/init` 的 `context_window`（生成页「上下文占比」分母）+ 请求体输出上限
（openai-completions 依 compat 走 `max_tokens` 或 `max_completion_tokens`）+
上下文压缩阈值（harness 按 `model.contextWindow - reserveTokens` 判定）。

注意：请求输出上限**不是** `model.maxTokens` 原值直送——pi-ai 的 `clampMaxTokensToContext`
会按当前上下文用量把它钳制到 `contextWindow - 已用 - 4096`，因此把窗口改小可能连带把输出上限压低。

### 23.3 与 `agent.token_budget` 的区别

`llm.max_tokens` 是**单次请求**的输出上限（每次 LLM 调用）；`agent.token_budget` 是**整次 Agent 运行**
的累计 token 预算（首尾机制：软/硬提示与强制交卷）。两者互不影响，配置界面也分属
`/config/model-size` 与 `/config/max-turns`。

### 23.4 兼容性

- 旧 config.yaml 无这两个字段：`validateConfig` 补 `null`，行为与迁移前完全一致（用目录值）；
- 字段是 `LLMConfig` 上的**新增可选**属性，`getProviderConfig` / `mergeBlueprintSections` 等既有
  读-改-写路径不受影响；
- `CustomModelConfig`（per-provider 自定义模型）的同名字段**保持独立**：自定义模型定义仍按
  models.json 语义提供元数据，本覆盖在其之上再叠加（解析时 `contextWindow` 选项覆盖目录值）。

### 23.5 验证（实际执行结果）

- `bun run test:catalog`：`llm.context_window` / `llm.max_tokens` 的缺省 null / 合法值保留 /
  0 与负数回退 null（42/42 全通过）；
- `bun run packages/orchestrator/test/e2e-blueprint.ts` 场景 7：`llm.context_window: 99999` →
  `system/init` 上报 99999；`llm.max_tokens: 1234` → 请求体输出上限 1234（38/38 全通过）；
- `bun run apps/cli/test/smoke-tui.ts`：`/config/model-size` 渲染 / 字段切换 / Enter 写回 /
  非法输入拦截 / `d` 恢复默认 / `s` 落盘（config.yaml 出现 `context_window: 200000` 与
  `max_tokens: 32000`）/ 配置首页条目值（245 项全通过）；
- `bun run test`（全部 13 个套件）与 `bun run mock:wiki`（completed=5 failed=0）均通过。

### 23.6 风险与未决

- 覆盖是**全局生效**的（跟随 `llm.provider/model`）：切换模型后旧覆盖仍会套到新模型上。
  配置首页条目值会显示当前覆盖，用户切换模型后应手动复查（或按 `d` 恢复）。
  没有做成 per-model 是因为目录外的模型连「模型身份」都不稳定（网关别名），
  按 id 记忆覆盖反而更容易错配。
- 覆盖值**不会反向写回 catalog**（`getZreadModel()` 仍返回目录原值），因此 Provider 详情页的
  模型列表展示的是目录元数据；只有请求与上下文记账用覆盖后的值。这是有意的：配置界面改的是
  「当前生效模型」的运行时行为，不是目录事实。

---

## 24. 工具名 / 参数 / 描述与 pi coding-agent 完全对齐

### 24.1 背景

第六步按上游 pi 重写工具层时，**工具名保留了旧 `agent-sdk` 时代的 PascalCase**（`Read` / `Write` / `Edit` / `Glob` / `Grep` / `Ls`），
参数风格也保留了旧契约（`file_path` / `old_string` / `new_string` / `replace_all`），与 pi coding-agent 的小写命名
（`read` / `write` / `edit` / `find` / `grep` / `ls`）和参数风格（`path`、`edits: [{ oldText, newText }]`）不一致。
本步骤把三者（名称 / 参数 / description）全部对齐 pi coding-agent，消除「同源实现、两套命名」的漂移。

### 24.2 改动清单

| 动作 | 对象 |
|---|---|
| 工具改名（保持导出常量名不变） | `Read→read`、`Write→write`、`Edit→edit`、`Glob→find`、`Grep→grep`、`Ls→ls`（`packages/agent-runtime/src/tools/*.ts` 的 `name` 字段；`GlobTool` 等导出名不动，业务侧 import 零改动） |
| 参数风格对齐 | `read` / `write`：主参数 `file_path` → `path`（旧名仍被接受）；`edit`：主参数 `path` + `edits[]`（`old_string` / `new_string` / `replace_all` 与顶层 `oldText` / `newText` 仍被接受）；`grep`：schema 移除 pi 没有的 `output_mode`（运行时仍接受，作为本仓库扩展） |
| description 逐字一致 | 六个工具的 description 与 pi coding-agent `src/core/tools/*.ts` 逐字相同（含截断上限数字） |
| 交叉引用文案 | `read` 目录报错点名 `ls`、长行截断提示点名 `read tool`、polish 提示词 `Read/Edit` → `read/edit`（`style-discipline.ts`） |
| 外部工具注册表 | `usedBy`：`['Grep']→['grep']`、`['Glob']→['find']`（`packages/utils/src/tools/registry.ts`） |
| i18n 文案 | `Grep/Glob` → `grep/find`（`apps/cli/src/i18n/translations/{en-US,zh-CN}.ts` 的 tools 段） |
| 测试同步 | `tools-smoke` / `smoke-agent` / `openai-http-smoke` / `page-polish`（mock 工具调用改用新名新参数）/ `smoke-tui`（i18n 断言）/ `tool-installer`（usedBy 断言） |

### 24.3 兼容性说明

- **旧参数名仍被接受**：`file_path`（read/write/edit）、`old_string` / `new_string` / `replace_all`（edit）
  在归一化层继续解析，历史会话回放与第三方集成不受影响；只有 LLM 可见的 schema（决定模型输出什么）切换到 pi 风格。
- **旧工具名不再被接受**：模型侧只注册小写名。mock LLM（`tools/mock-wiki-run.ts`）不调用文件工具，
  不受影响；`write_page` / `submit_*` 等业务工具名不变。
- **导出常量名不变**：`FileReadTool` / `GlobTool` 等 TypeScript 导出名保持原样，22 处业务 import 零改动。

### 24.4 验证（实际执行结果）

见本节随附提交的测试输出；本步骤改动涉及工具层，按 AGENTS.md §3 跑 `typecheck` + `test:tools` + `test` 全套。

### 24.5 风险与未决

- pi 的 `find` 默认上限是 1000（与本仓库原 `Glob` 相同），`grep` 默认 100 而本仓库是 250 ——
  description 里的数字与实际实现绑定（`${DEFAULT_LIMIT}` 插值），保留本仓库的 250 而不改描述会导致与 pi 文本不一致；
  现方案是**描述与实现一起对齐 pi 的默认值**（grep 上限 250 → 100）。若后续需要调大，必须同时改描述。

---

## 25. 日志系统对齐 cordis（LoggerService 总线 + 命名 logger）

### 25.1 目标

把 deepseek-harness 的日志体系（cordis `logger.ts` + cosmokit `time.ts` + logger-console 渲染器）
完整移植进 `packages/utils/src/logger/`，zread-pi 从「全局单例拼字符串」升级为
「结构化记录 + 多 exporter 总线 + 命名 logger」。既有调用点与测试零破坏。

### 25.2 对齐清单（源 → 落点）

| harness 源 | 内容 | zread-pi 落点 |
| --- | --- | --- |
| `vendor/cordis/src/logger.ts` | `Message{sn,ts,name,type,level,args}`、`LoggerLevel`（error=0/info=1/warn=2/debug=3）、Logger 门面（printf / Error 展开 / AggregateError 展开 / maxLength=10240 截断）、`Logger.code` 名字哈希着色（c16/c256）、`LoggerService`（命名工厂、exporter 广播、按 exporter/按名 levels 阈值、1000 条环形缓冲） | `logger/types.ts` + `logger/format.ts` + `logger/service.ts` |
| `vendor/cosmokit/src/time.ts` | `Time.template`（yyyy/yy/MM/dd/hh/mm/ss/SSS）、`Time.format`（+1.2s 差值格式化） | `logger/time.ts`（最小子集） |
| `vendor/logger-console/src/shared.ts` + `index.ts` | ConsoleExporter 渲染：`[I] name message` 前缀、showTime 模板、showDiff、label 宽度对齐、`util.inspect` 对象格式化（node 变体） | `logger/console-exporter.ts` |

渲染结果与 harness **逐字一致**：`test:logger` 的黄金值直接取自 `vendor/cordis` 实跑
（如 `code('app',3)=57`、`code('orchestrator.pages',1)=5`、
`render([colors:0])` = `[I] app hello world`、`render([colors:3])` = `[I] \u001b[38;5;57;1mapp\u001b[0m hi`）。

### 25.3 偏差项（有意不移植）

| 偏差 | 理由 |
| --- | --- |
| cordis fiber / Context / DI 体系 | zread-pi 无插件架构；改为模块级单例（`getLoggerService()`）+ `createLogger(name)` 工厂 |
| `Message.fiber`（WeakRef） | 无对应概念，字段省略 |
| schemastery 配置 schema | 用 TS interface + `ZREAD_PI_LOG_LEVEL` 环境变量 |
| `supports-color` 依赖 | 手写约 20 行探测（`NO_COLOR` / `FORCE_COLOR` / TTY + `COLORTERM` / `TERM`），零新依赖，不影响 standalone 二进制打包 |
| browser 变体 / OTel 遥测 | 无场景 |
| **console exporter 默认不注册** | harness 里 console exporter 由应用层插件加载；zread-pi 的 TUI 期间 `console-guard` 会把 console 输出转回总线，两者同时开启会往**日志文件双写**（console exporter → console.log → 被捕获 → file exporter 再写一次）。因此默认只注册缓冲 + 文件 exporter，`ZREAD_PI_LOG_CONSOLE=1` 才开 console（排障用）；console exporter 还会跳过名字为 `tui.console` 的记录，防止无限递归 |
| file exporter（harness 无，本仓库新增） | 文本 sink 沿用 `~/.zread-pi/logs/zread-pi-<date>.log`，行内容为 `[本地时间] [级别] 名字 消息`（消息体复用 `LoggerFormat.format` 的 printf 渲染，无色） |
| 级别阈值按名**前缀匹配** | cordis 只做精确名 + `default`；本仓库的 logger 名是点号分层（`orchestrator.pages`），因此 `ZREAD_PI_LOG_LEVEL=orchestrator=debug` 能覆盖下级名字。取最长匹配前缀（点号边界，`orchestrator` 不误命中 `orchestrator-lite`） |

### 25.4 命名 logger 对照表（旧前缀 → 新名字）

| 文件 | 旧写法 | 新名字 |
| --- | --- | --- |
| `agents/blueprint-stages.ts` | `[classify]` / `[topics]` / `[titles]` 前缀 | `classify` / `topics` / `titles`（三个 logger，前缀删除） |
| `agents/create-agent.ts` | 全局 `logger` | `orchestrator.agent` |
| `wiki/generate-wiki.ts` | 全局 `logger` | `orchestrator.pages` |
| `wiki/polish.ts` | 全局 `logger` | `orchestrator.polish` |
| `wiki/sync-wiki.ts` | 全局 `logger` | `orchestrator.sync` |
| `wiki/memory.ts` | 全局 `logger` | `orchestrator.memory` |
| `repo-analyzer/scanner` | 全局 `logger` | `analyzer.scanner` |
| `repo-analyzer/parser`（index / vue-handler） | 全局 `logger` | `analyzer.parser` |
| `repo-analyzer/parser/wasm-loader.ts` | 全局 `logger` | `analyzer.wasm` |
| `repo-analyzer/repo-map` | 全局 `logger` | `analyzer.repo-map` |
| `apps/cli/src/tui/console-guard.ts` | 手拼 `[iso] [LEVEL] args` | `tui.console`（按 console 方法映射 error/warn/info/debug） |
| `apps/cli/src/tui/output-guard.ts` | 手拼 raw text | `tui.stdout`（杂散 stdout） |
| `packages/utils/src/output/wiki-content.ts` | 全局 `logger` | 保留兼容层 `logger`（`app`），不在本次改造范围 |

共 61 处调用点。`logger.progress` / `logger.success` 在兼容层保留，语义改为
`info` + 消息标记 `[PROGRESS]` / `[OK]`（旧文件行的 `[PROGRESS]` / `[OK]` 标记因此仍在）。
命名 logger 没有 `progress` / `success` 方法（cordis 只有 4 个严重程度），进度类消息直接用 `info`。

### 25.5 行格式变化

```text
旧：[2026-09-15T13:00:00.000Z] [INFO] 开始生成 Wiki 内容：12 个页面，并发数 3
新：[2026-09-15 21:00:00.000] [INFO] orchestrator.pages 开始生成 Wiki 内容：12 个页面，并发数 3
```

- 时间戳从 UTC ISO 改为**本地时间**（`yyyy-MM-dd hh:mm:ss.SSS`，与 console 渲染器同源）；
- 行内多出 logger 名字（按模块过滤的依据）；
- 级别仍是全词 `[INFO]` / `[WARN]` / `[ERROR]` / `[DEBUG]`（兼容层与外部 grep 习惯）。

所有既有测试按 **needle** 断言（消息文本、`QUANTITY_FALLBACK_NOTE`、`代码兜底` 等），行格式变化不影响。

### 25.6 修掉的旧实现 bug

1. **日志路径在模块加载期定死日期**：旧 `logger.ts` 在模块顶层算 `LOG_FILE = ...new Date().toISOString().slice(0,10)`，
   进程跨过午夜后仍然写昨天的文件。现在 `getLogFile()` 与 file exporter 都在**写入时刻**取日期。
2. **无过期日志清理**：现在首次写入时清理超过保留期的旧日志（默认 30 天，`ZREAD_PI_LOG_RETENTION_DAYS` 覆盖，`<= 0` 不清理）。
3. **写日志的 I/O 时机**：retention 清理放在首次写入而不是 import 期，避免 import 链对家目录做意外 I/O（测试隔离友好）。

### 25.7 `ZREAD_PI_LOG_LEVEL` 用法

形如 `default=info,orchestrator=debug`：

- 条目可省略名字（`debug` → 设为 `default`）；未知级别名 / 负数忽略；整体非法或为空时回退 `{ default: INFO }`；
- `warning` 是 `warn` 的别名；
- **语义提醒**：cordis 的 level 数值是「啰嗦度」而非严重度 ——
  `ERROR=0` 最不啰嗦、`DEBUG=3` 最啰嗦，阈值表示「允许发出的最大啰嗦度」。
  因此 `default=warn` 会发出 `error` / `info` / `warn`，只丢弃 `debug`；
- 只作用于 **console exporter**（且只在 `ZREAD_PI_LOG_CONSOLE=1` 注册时才存在）。
  文件 exporter 固定记录全部级别（排障 sink），不受该变量影响。

### 25.8 兼容性

- `@zread-pi/utils` 的 `logger` / `getLogFile` 导出不变；新增导出 `createLogger` / `getLoggerService` /
  `addExporter` / `LoggerLevel` / `Message` / `Exporter` / `LoggerFormat` / `ConsoleExporter` / `FileExporter` /
  `getLogFilePath` / `sweepOldLogFiles` / `parseLogLevels` / `detectColorLevel` / `Time` 等（均为新增，旧调用点零改动）；
- 旧 `config.yaml` 与日志无耦合（日志不进配置），启动路径不变；
- `console-guard` / `output-guard` 对外接口不变，只是落盘实现改走总线。

### 25.9 验证（实际执行结果）

- `bun run typecheck`：0 错误；
- `bun run test:logger`：103/103 通过；
- `bun run test`（全套，含 test:logger）：全部绿
  （test:blueprint 38+115+23+11+17 / test:pages 24+7+16 / test:tui 287+9+10+36+37+46+50 / test:context 45 等）；
- `bun run mock:wiki`：`completed=5 failed=0`；
- 真实日志文件抽样：

```text
[2026-09-15 21:59:37.784] [INFO] orchestrator.pages 页面生成开始
[2026-09-15 21:59:37.785] [WARN] classify 数量越界，要求重提
[2026-09-15 21:59:37.785] [ERROR] orchestrator.agent Error: demo error
    at ...（Error stack 原样保留，续行不缩进）
[2026-09-15 21:59:37.786] [INFO] app [PROGRESS] Scanning project 5 files
[2026-09-15 21:59:37.786] [INFO] app [OK] 全部完成
```

### 25.10 风险与未决

- **console exporter 与 TUI 的双写**：只有显式设 `ZREAD_PI_LOG_CONSOLE=1` 且同时运行 TUI 时，
  日志文件里会出现同一条消息两次（一次原名、一次 `tui.console` 捕获）。这是排障场景的可接受代价；
  默认（不设该变量）无双写。console exporter 同时跳过 `tui.console` 与 `tui.stdout`
  两个捕获名——否则该组合会形成 console → stdout 接管 → 总线 → console 的**无限递归**
  （每次迭代追加日志文件，饿死 TUI 事件循环）。
- **printf 语义**：命名 logger 的首参按 printf 解析，消息里含 `%s` / `%d` 会被消费。
  兼容层与所有「消息体不可控」的位置（工具输入 / 工具输出 / 助手文本块 / 捕获的 console / 杂散 stdout）
  已用 `%s` 占位包裹；新增日志点若消息含字面量 `%`，用 `%` 转义或同样用 `%s` 占位。
- **LoggerLevel 用 `as const` 对象**：harness 用 `const enum`；本仓库的 bun/tsup 打包链不做隔离编译，
  const enum 的运行时值会丢失，因此改用 `as const` 对象（类型与运行时两侧都可用）。
- **日志文件不加跨进程锁**：多进程同时写同一天文件可能交错（与旧实现行为一致）；日志是尽力而为的排障数据，
  不值得为此引入锁开销。

### 25.11 JSONL exporter（机器可读 sink，本仓库新增）

与 file-exporter 同一偏差族：harness 没有文件 sink，JSONL 是为「日志事后分析」新增的能力。
**JSONL 是默认文件 sink**；文本 file-exporter 降级为可选（见下）。

- 落 `~/.zread-pi/logs/zread-pi-<yyyy-MM-dd>.jsonl`，与文本文件同目录同日期口径；
- 每行一条 JSON：`{ sn, ts, time, name, type, level, msg }`——`msg` 走与文本 sink 相同的
  printf 渲染（`LoggerFormat.format`），语义完全一致；单行超过 10240 字符截断补 `...`；
- **默认开启**：`ZREAD_PI_LOG_JSONL=0`（或 `false` / `no`）显式关闭；
- 级别与文本 file-exporter 同口径（排障 sink，默认记录含 debug 的全部级别，
  不受 `ZREAD_PI_LOG_LEVEL` 影响）；
- 保留期清理与文本文件共用 `sweepOldLogFiles`（同时扫 `.log` 与 `.jsonl` 两种后缀，
  `ZREAD_PI_LOG_RETENTION_DAYS` 同一份配置）；
- 写失败 / 序列化失败一律静默（与其它 exporter 相同的「日志绝不打断业务」契约）。

### 25.12 文本 file-exporter 降级为可选 sink

JSONL 承担默认文件 sink 后，文本输出沦为重复内容，改为**默认关闭**：

- `ZREAD_PI_LOG_TEXT=1`（或 `true` / `yes`）显式开启——适合人工翻阅、
  既有 needle 脚本 / 外部 grep 工具（行格式 `[本地时间] [级别] 模块名 消息` 不变）；
- 行格式、级别口径（全级别含 debug）、保留期清理、跨天切换、写失败静默等行为均不变；
- 兼容层的 `getLogFile()` 仍返回文本文件路径（开启后才有内容）；
  依赖文本文件的测试（`test:logger` needle 段、`test:tui` 的 output-guard / smoke-tui）
  已在测试内显式设置 `ZREAD_PI_LOG_TEXT=1`。
