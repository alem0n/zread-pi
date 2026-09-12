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
| 上下文与轮次（第五步） | `agent-runtime` 接入 pi compaction（`transformContext` + `prepareCompaction`/`compact`）与 `shouldStopAfterTurn` 优雅停止；配置结构新增 `agent.max_turns`，CLI 新增 `/config/max-turns`，Orchestrator 不再硬编码 30（详见 §8.6） |

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
`result.subtype` 新增 `error_context_full`（上下文将满优雅停止，见 §8.6），与 `error_max_turns` 同为「非成功但非异常」的停止原因。

## 4. 与旧实现的行为差异（有意为之，均已验证）

| 差异 | 说明 |
|---|---|
| 重试位置 | pi 的 Agent 循环**不内置**重试（避免污染会话）；本适配层在 `streamFn` 层实现"未产出内容即可重试"，并额外提供可选 `retryScope: "stream+run"`（整轮重跑，默认关闭）。旧实现是 API 级重试，语义等价且更干净。 |
| 重试判定 | 复用 pi-ai 的错误分类器，同时保留旧 `retryableStatusCodes` 白名单（错误文本包含状态码即视为可重试）。 |
| 未登记 providerId | 旧实现抛 `Unsupported provider`；新实现回退 OpenAI 兼容协议（健壮性增强）。 |
| 思考深度 | 新增 `thinkingLevel` 选项（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，缺省 `off` = 旧行为）与 `config.llm.thinking_level`：pi 以 `options.reasoning` 下发，模型不支持时 pi-ai 在请求时自动 clamp。 |
| 会话 | 旧实现的 `saveSession/loadSession/tag/rename/fork` 未迁移；wiki 生成是一次性 agent，不需要。若 CLI 后续要做"会话聊天"，需接 pi 的 JSONL 会话树。 |
| 上下文窗口/定价 | 旧 `MODEL_PRICING` 表未迁移，`Model` 用保守默认（200k 窗口 / 8k 输出、cost=0）。pi 的 usage 记账照常工作，只是成本字段为 0。 |
| 最大轮次 | 旧实现在 Orchestrator 硬编码 30；现由 `config.agent.max_turns`（默认 30，`0` = 不限制轮次）提供，`createAgent({ maxTurns })` 仍可显式覆盖。到达上限前会向模型注入收尾提示（steering user 消息），超限后默认允许 1 轮宽限（`finalization.graceTurns`，0 = 旧行为）；`maxTurns = 0` 时不发提示、不因轮次停止（仍受上下文/取消约束）；模型在最后一轮给出最终答复（无工具调用）时按 success 处理，不再误报 `error_max_turns`。 |
| 上下文压缩 | 旧引擎的「自动压缩」语义由 pi 的 `transformContext` + `compaction` 对等实现：超阈值时摘要历史（发出 `system/compact_boundary`），摘要请求会额外消耗一次模型调用；压缩无法再腾出空间时在本轮边界优雅停止（`error_context_full`）。 |
| 事件粒度 | `assistant` 事件在 `message_end` 产出（完整内容 + usage）；流式增量以 `partial_message` 产出（旧引擎同形）。 |
| 成功判定以落盘为准 | `generateWikiCatalog()` 在 Agent 正常结束后校验 `wiki.json` 可加载；`generateWikiContent()` 校验 `.zread-pi/wiki/<section>/<file>` 真实存在，否则记为失败（抛错/`page_error`）。旧实现把「Agent 循环正常结束」当作完成，模型只输出文字、写到错误路径或被 Mermaid 校验拦截时会显示完成，但首页按文件检查仍显示未完成；现以磁盘产物为唯一判定依据。**落盘兜底**：`write_page` 已成功但文件不在约定路径时（典型：漏传 `section` 落到 wiki 根、只传 `slug` 写成 `<slug>.md`），按「write_page 报告的真实路径 → 模型传入参数复算 → wiki 目录按文件名扫描（跳过 `archived/` 快照）」三层候选找到文件并移动回约定位置，移动成功仍计为完成，不再误报「写入路径与 wiki.json 不一致」。 |
| 浏览文档服务器 | 旧实现源码运行（非打包）时固定返回 `http://localhost:5173`（外部 Vite dev server 的地址），未另起 Vite 时浏览器 ERR_CONNECTION_REFUSED。现返回的一定是真实监听地址：有构建产物（打包 `dist/browse` 或源码 `apps/browse/dist`）时 API + 静态资源同端口（SPA fallback）；源码且未构建时进程内启动 Vite dev server，并把 `/api` 代理到 API 端口；启动失败（端口占用/资源缺失）在 TUI 直接显示原因。 |

## 5. 风险与未决项

1. **MCP 缺失**：pi 文档无 MCP 能力。当前 wiki 链路不需要；若 `cli`/browse-chat 需要用户配置的 MCP 工具，应把 `agent-sdk/src/mcp/client.ts` + `tool-helper.ts` 作为独立小包保留并适配成 pi 工具（pi 支持运行时 `registerTool`）。
2. **会话能力缺口**：tag/rename/list/fork 在 pi 文档中无直接对应，需用值存储/自定义条目实现或放弃。
3. **React 18/19 混装（已解除）**：原因为 Ink（React 18）与 browse（React 19）冲突，见 README §工程细节 1。
   CLI 换成 pi-tui 后已不再依赖 React，`apps/browse` 已重新列入根 workspaces（依赖随根 `bun install`）；
   修复了源码运行「浏览文档」因漏跑 `bun run browse:install` 而报「未找到前端资源，也无法启动 Vite」的问题。
4. **pi 内核版本**：vendor 快照为 0.85.1（与 npm 发布版同版本号）。升级 pi 时需重跑 `bun run vendor:build` 与 `bun run test`。
   `ai` 包现在编译到 `providers/all.ts` + `auth/oauth/*` + `providers/data/*.json`（为了配置界面的 Provider 目录与 pi-ai 登录能力，见 §8）；升级后需同步更新 data JSON。
5. **真机联调**：全部测试使用离线 faux / 本地 mock HTTP；**尚未用真实 API Key 跑过完整 wiki 生成**。建议首次验证：`bun run cli config` 配好 key → 在目标仓库执行 `bun run cli`，重点观察 retry 事件与长上下文（大仓库）下的 usage/压缩表现（压缩触发时会收到 `system/compact_boundary`）。

## 6. 后续可选路径

1. **pi 的压缩能力已接入**（`transformContext` + `prepareCompaction`/`compact` + `shouldStopAfterTurn` 优雅停止，见 §8.6）；后续可把 `compaction.reserveTokens` / `keepRecentTokens` 也暴露到配置界面。
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
5. **`tui` 包的构建差异**：上游用 `tsgo`，本仓库用 `tsc` 并把 target/lib 提到 ES2024（原因见 README §工程细节 2）。
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
