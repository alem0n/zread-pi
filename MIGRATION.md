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
| 配置结构 | `LLMConfig` 新增 `providers: Record<string, LlmProviderConfig>`（base_url / api / auth_type / model / models）；`CustomModelConfig` 支持窗口/输出/推理/图片 |
| 配置工具 | `packages/utils` 新增 `getZreadAuthPath()` / `getZreadModelsStorePath()` / `getProviderConfig()` / `normalizeProviderConfigs()`；`isFirstTimeConfig` 改为「provider+model 已选即已配置」 |
| 运行时 | `createRuntimeModel()` 优先走 catalog（真实模型元数据 + OAuth 刷新 + 自定义模型），未命中回退单模型 Provider；`createAgent` 无 apiKey 时若 provider 在 catalog 中不再报错 |
| CLI | `views/config-provider`、`views/config-provider-detail`（API Key + 模型并列，替换 config-model + config-auth）；新增 `views/config-custom-model`（自定义模型表单）；`ConfigStore` 新增 per-provider 与自定义模型写入；`utils/llm-config.ts` 负责旧字段迁移 |
| 旧路由兼容 | `/config/provider/:id/custom` 仍可用（等价 model-new） |

### 8.3 与旧实现的行为差异

| 差异 | 说明 |
|---|---|
| Provider 列表来源 | 由 LiteLLM 在线目录（`~/.zread-pi/providers.json`，24h 缓存）改为 pi-ai 内置目录（离线可用、40 个 Provider），未内置的已配置端点仍会列在末尾 |
| 登录方式 | 配置界面只提供 API Key（写入 `auth.json`，同一 Provider 只保留一份凭据）；Provider 详情页把「API Key 配置」与「模型选择」并列在同一页面（tab/Shift+Tab 或 ↑ 切换焦点，仅 `Models.login('api_key')`）；OAuth 订阅流程仍保留在 provider-catalog/运行时中（可手写 `auth.json` 使用），但界面不再提供 |
| 多 Provider | `llm.providers.<id>` 保存每个 Provider 的端点/模型/自定义模型；`auth.json` 可同时保存多份凭据；provider 列表逐项显示登录状态 |
| 自定义模型 | 新增独立表单（id / 名称 / 上下文窗口 / 最大输出 / 思考 / 图片），按 pi models.json 语义覆盖或追加 |
| 模型刷新 | 详情页 `r` 调用 pi-ai `Models.refresh()`（动态 Provider 请求远端目录并缓存到 `models-store.json`；静态目录提示「无需刷新」） |
| 旧配置兼容 | 首次在新界面切换 Provider/模型时，`llm.api_key` → `auth.json`、`llm.base_url` → `llm.providers.<id>.base_url`，然后清空旧字段；未知 providerId 仍回退 OpenAI 兼容协议 |
| 未内置 Provider | 仍可从零配置（自定义 Provider 流程：Base URL → 模型 → API Key），实现改为 pi `createProvider()` 动态注册 |

### 8.4 验证

```bash
bun run typecheck
bun run test:catalog    # 32/32
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
