# MIGRATION.md — 把 open_zread 的 Agent 内核换成 pi

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
| 机械替换 import | 22 个文件：`@open-zread/agent-sdk` → `@open-zread/agent-runtime`（orchestrator 17、cli 3、tsconfig/package.json 等） |
| 未改动 | `orchestrator` 的 prompts / 三层 Repo Map 工具 / 并发与错误隔离 / wiki 契约；`repo-analyzer`；`utils`；`types`；`browse` 全部前端代码（`cli` 的 TUI 在第二步换成 pi-tui，见 §7） |
| 依赖修正 | `apps/cli` 补 `@types/express`；`vendor/pi/packages/ai` 补 `@smithy/types` |
| 配置界面（第三步） | `apps/cli` 的 Provider/模型页面改为 pi-ai 目录 + `Models.login`；Provider 详情页为「API Key 配置 + 模型选择」并列布局（只提供 API Key）；`agent-runtime` 新增 `src/pi/{provider-catalog,auth-store,models-store}.ts`；配置结构新增 `llm.providers`，凭据落 `~/.zread/auth.json`（详见 §8） |
| 上下文与轮次（第五步） | `agent-runtime` 接入 pi compaction（`transformContext` + `prepareCompaction`/`compact`）与 `shouldStopAfterTurn` 优雅停止；配置结构新增 `agent.max_turns`，CLI 新增 `/config/max-turns`，Orchestrator 不再硬编码 30（详见 §8.6） |

工具与类型的**原样复制**（非重写）：
`packages/agent-runtime/src/types.ts`、`src/tools/{types,read,write,edit,glob,grep}.ts`、`src/providers/types.ts`
均直接取自 `archive/open-zread/packages/agent-sdk/src`，因此 Read/Write/Edit/Glob/Grep 的 schema、提示文本、行为与旧版一字不差。

## 3. 契约冻结点（业务可见面）

```ts
createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt,
              tools, maxTurns, thinkingLevel, compaction, hooks, retryConfig, includePartialMessages })
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
| 最大轮次 | 旧实现在 Orchestrator 硬编码 30；现由 `config.agent.max_turns`（默认 30）提供，`createAgent({ maxTurns })` 仍可显式覆盖。 |
| 上下文压缩 | 旧引擎的「自动压缩」语义由 pi 的 `transformContext` + `compaction` 对等实现：超阈值时摘要历史（发出 `system/compact_boundary`），摘要请求会额外消耗一次模型调用；压缩无法再腾出空间时在本轮边界优雅停止（`error_context_full`）。 |
| 事件粒度 | `assistant` 事件在 `message_end` 产出（完整内容 + usage）；流式增量以 `partial_message` 产出（旧引擎同形）。 |

## 5. 风险与未决项

1. **MCP 缺失**：pi 文档无 MCP 能力。当前 wiki 链路不需要；若 `cli`/browse-chat 需要用户配置的 MCP 工具，应把 `agent-sdk/src/mcp/client.ts` + `tool-helper.ts` 作为独立小包保留并适配成 pi 工具（pi 支持运行时 `registerTool`）。
2. **会话能力缺口**：tag/rename/list/fork 在 pi 文档中无直接对应，需用值存储/自定义条目实现或放弃。
3. **React 18/19 混装**：原因为 Ink（React 18）与 browse（React 19）冲突，见 README §工程细节 1。
   CLI 换成 pi-tui 后已不再依赖 React，该风险降级为历史约束（browse 仍独立安装）。
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
| 验证 | 新增 `bun run test:tui`（89 + 13 + 9 + 19 项），并纳入根 `bun run test` |
| 可用性补强 | 列表窗口化分页（`computeItemWindow` / `scrollIndicator`）、PageUp·PageDown·Home·End、终端高度自适应、console 接管（`console-guard.ts`） |

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
| 杂散输出 | TUI 期间 `console.*` 被转存到 `~/.zread/logs/open-zread-*.log`（防止花屏），退出时还原。 |
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
6. **`apps/browse` 仍在 workspaces 之外**：CLI 已无 React 依赖，理论上可合并；本次迁移刻意不动。

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
| 新增 | `packages/agent-runtime/src/pi/auth-store.ts`（`~/.zread/auth.json` 的 CredentialStore）、`models-store.ts`（`~/.zread/models-store.json` 的 ModelsStore） |
| 新增 | `packages/agent-runtime/test/provider-catalog-smoke.ts`（25 项，离线） |
| 配置结构 | `LLMConfig` 新增 `providers: Record<string, LlmProviderConfig>`（base_url / api / auth_type / model / models）；`CustomModelConfig` 支持窗口/输出/推理/图片 |
| 配置工具 | `packages/utils` 新增 `getZreadAuthPath()` / `getZreadModelsStorePath()` / `getProviderConfig()` / `normalizeProviderConfigs()`；`isFirstTimeConfig` 改为「provider+model 已选即已配置」 |
| 运行时 | `createRuntimeModel()` 优先走 catalog（真实模型元数据 + OAuth 刷新 + 自定义模型），未命中回退单模型 Provider；`createAgent` 无 apiKey 时若 provider 在 catalog 中不再报错 |
| CLI | `views/config-provider`、`views/config-provider-detail`（API Key + 模型并列，替换 config-model + config-auth）；新增 `views/config-custom-model`（自定义模型表单）；`ConfigStore` 新增 per-provider 与自定义模型写入；`utils/llm-config.ts` 负责旧字段迁移 |
| 旧路由兼容 | `/config/provider/:id/custom` 仍可用（等价 model-new） |

### 8.3 与旧实现的行为差异

| 差异 | 说明 |
|---|---|
| Provider 列表来源 | 由 LiteLLM 在线目录（`~/.zread/providers.json`，24h 缓存）改为 pi-ai 内置目录（离线可用、40 个 Provider），未内置的已配置端点仍会列在末尾 |
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
bun run test            # 全部套件（含 test:context 18/18、TUI 150 + 路由 16 + 真实终端 9 + mock 全链路 19）
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

- 配置：`AppConfig.agent.max_turns`（1-100，默认 30）；`validateConfig` 对旧 `config.yaml` 自动补齐；
- UI：配置首页「最大轮次」项 → `/config/max-turns`（`apps/cli/src/views/config-max-turns`）；
- Orchestrator：`agents/create-agent.ts` 改为 `options.maxTurns ?? config.agent.max_turns ?? 30`，`wiki/generate-wiki.ts` 删除写死的 `maxTurns: 30`（`GenerateWikiOptions.maxTurns` 仍可显式覆盖）。

**b) 上下文压缩与优雅停止（pi `transformContext` + `compaction`）**

- `packages/agent-runtime/src/agent.ts` 在每次请求前（`transformContext`）用 `estimateContextTokens` + `shouldCompact`
  判定，超阈值时把消息转成 pi 的 `Entry[]` 调 `prepareCompaction` / `compact` 生成结构化摘要，
  并以「`compactionSummary` + `retainedTail` + 压缩后新增的消息」作为后续请求的上下文；
- 压缩成功向业务侧发 `system/compact_boundary`（`SDKCompactBoundaryMessage`，与旧 SDK 消息类型对齐）；
- `shouldStopAfterTurn` 仍负责轮次计数（`maxTurns`），同时检查上下文用量：
  如果上下文将满且压缩已无法腾出空间（单个巨大 turn、可总结内容为空、摘要请求失败/关闭压缩），
  在轮次边界优雅停止并产出 `subtype: "error_context_full"`；
- `convertToLlm` 改用 pi harness 版本，保证 `compactionSummary` 消息能转成模型可见的 user 消息；
- 测试：`packages/agent-runtime/test/context-compaction.ts`（`bun run test:context`，18 项）覆盖
  「压缩后继续 success」「压缩无法腾空 → error_context_full」「关闭压缩 → error_context_full」「maxTurns → error_max_turns（可读错误文案）」。
