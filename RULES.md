# RULES.md — 项目结构与修改指南

本文给出 zread-pi 的代码地图与逐包修改要点。**流程性约定（分支 / 验证命令 / 版本号 / 手动合并）以
`AGENTS.md` 为唯一入口**，本文不重复；UI 视觉规范见 `DESIGN.md`。

---

## 项目概述

zread-pi 是 AI 驱动的 Wiki 文档生成工具：一行命令把整个项目转换为高质量的 Wiki 文档库。
业务层（编排 / 并发 / 落盘 / 提示词）运行在 pi 的 agent 内核（`@earendil-works/pi-ai` +
`@earendil-works/pi-agent-core`，vendor 源码见 `vendor/pi/`）之上；代码分析基于 Tree-sitter 多语言 AST。

一句话架构：**只换运行时内核，业务逻辑零改动**——`agent-sdk` 被 `agent-runtime` 适配层取代，
对外契约（`createAgent` / `createProvider` / 工具名 / 类型）冻结，冻结点清单见 `MIGRATION.md` §3。

## 开发环境

- 包管理器 Bun ≥ 1.3，Node ≥ 22（pi 内核要求）；
- 全新 clone 后必须先 `bun install && bun run vendor:build`（`vendor/pi/**/dist` 不入库）。

**每次修改代码后必须执行**（命令矩阵按改动类型细分，见 `AGENTS.md` §3）：

```bash
bun run typecheck   # tsc --noEmit —— 必须
bun run test        # typecheck + 12 个离线测试套件 —— 必须
```

单个套件（调试用）：`bun run test:tools` / `test:catalog` / `test:tui` / `test:history` / `test:installer` 等，
完整清单见根 `package.json` 的 `scripts`。

## 包依赖关系

```
apps/cli（pi-tui 终端界面入口）
    ├── @zread-pi/agent-runtime（pi 适配层）
    ├── @zread-pi/orchestrator（编排层）
    │       ├── @zread-pi/agent-runtime
    │       ├── @zread-pi/repo-analyzer（代码分析）
    │       └── @zread-pi/utils（工具函数）
    ├── @zread-pi/repo-analyzer
    ├── @zread-pi/types（共享类型）
    └── @zread-pi/utils
apps/browse（React 19 + Vite 预览站；不引用任何 @zread-pi/* 包，已并入根 workspaces）
vendor/pi/packages/*（pi 内核源码快照，上游零改动）
```

---

## 包职责与修改要点

### 1. `@zread-pi/types`（packages/types）

共享类型基础，零外部依赖：`manifest.ts`（扫描结果）、`symbols.ts`（AST 符号）、`wiki.ts`
（Wiki 页面与输出）、`config.ts`（AppConfig，含 `llm.providers` / `llm.context_window` / `llm.max_tokens` / `agent.max_turns` / `agent.token_budget` / `polish.*` / `blueprint.detail` / `quality.contentGate` / `tools.*`）、
`cache.ts`、`repo-map.ts`（三层 Repo Map）。

**修改要点**：这里动了就是契约面——旧 `config.yaml` 必须仍可直接启动（运行时自动迁移/补缺省值），
新增字段一律「可选 + 合理缺省」。

### 2. `@zread-pi/utils`（packages/utils）

基础设施：`config/`（加载 / 保存 / 校验 / 归一化）、`cache/`（符号级 AST hash 缓存）、
`storage/`（wiki-store、版本快照）、`output/`（wiki.json 生成与加载）、
`project-home.ts`（**项目家目录唯一定义点**：config / auth / models-store / logs / parsers / bin / history 全部由此派生，
`ZREAD_PI_HOME` 可覆盖）、`history/`（ZRH1 二进制全局记忆）、`tools/`（外部工具注册表 / 安装器 / 纯 JS 解包）。

**修改要点**：

- 家目录路径**只**在 `project-home.ts` 改，禁止在别处 `homedir()` 拼接；
- `tools/registry.ts` 是扩展点：新增外部工具只需加一条 `ToolSpec`，界面 / 安装器 / 探测自动跟上；
  可用性判定只看「进程能否启动」，版本识别失败不等于未安装（详见 `AGENTS.md` §1.4）；
- history 二进制布局变更必须升 `HISTORY_VERSION` 并保留旧版本读取兼容。

### 3. `@zread-pi/repo-analyzer`（packages/repo-analyzer）

扫描 + 解析引擎：`scanner/`（glob + .gitignore）、`parser/`（Tree-sitter WASM 加载、语言映射
`constants.ts`、Vue SFC 处理）、`repo-map/`（三层 Repo Map：prioritizer / reference-counter / token-counter）。

**修改要点**：

- `parseFiles()` 以 `process.cwd()` 为根——任何调用方必须先切到目标仓库目录（见 §6.4 `AGENTS.md`）；
- 新增语言 = 在 `parser/constants.ts` 的 `WASM_FILE_MAP` 登记 grammar；
- 首次解析会从 CDN 下载 WASM 到 `<家目录>/parsers`，不要在测试里假设它已存在。

### 4. `@zread-pi/agent-runtime`（packages/agent-runtime）

pi 适配层（替代旧 agent-sdk）：`src/agent.ts`（createAgent：pi Agent 循环 + 流级重试 + 事件/钩子映射 +
compaction + 轮次收尾）、`src/pi/`（runtime-model / provider-catalog / auth-store / models-store）、
`src/providers/`（createProvider，browse-chat 用）、`src/tools/`（`Ls`/`Glob`/`Grep`/`Read`/`Write`/`Edit`
+ 截断与遍历共享设施）、`src/retry.ts`。

**修改要点**：

- 对外契约冻结（`MIGRATION.md` §3）：改 `createAgent` / `createProvider` 签名或 `SDKMessage` 结构，
  必须同步业务层与 `MIGRATION.md`；
- **工具不得改名**（提示词与测试依赖 `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Ls`/`write_page`/`generate_blueprint`）；
  工具行为改动必须补 `test:tools` 断言；
- 重试只放在 `streamFn` 层且仅在「未产出内容」时触发；不要往 pi Agent 循环里塞重试；
- rg / fd 运行期**只探测不下载**，缺失必须走纯 JS 兜底且两条路径结果一致（`test:tools` 有断言）；
- 移植自 vendor / 上游 pi 的文件必须文件头注明来源（复制 + 改写，不改 vendor）。

### 5. `@zread-pi/orchestrator`（packages/orchestrator）

编排层：`orchestrator.ts`（`generateWikiCatalog`）、`wiki/generate-wiki.ts`（`generateWikiContent`）、
`wiki/content-gate.ts`（内容密度门纯函数 + 下限表常量，对齐 `blueprint-detail.ts` 的组织方式）、
`wiki/verify-wiki.ts`（交付闸门纯逻辑，**只读**：不写任何产物）、
`agents/create-agent.ts`（读配置下发 maxTurns / thinkingLevel / contextWindow / maxTokens）、`prompts/`（蓝图与页面 Agent 提示词，
**工具名写死在其中**）、`wiki/memory.ts`（全局记忆写入）。

**修改要点**：

- 并发控制用 `p-limit`；完成判定**以落盘为准**（wiki.json 可加载 / 页面文件真实存在），不信任「Agent 正常结束」；
- `wiki.json` 契约与 `write_page` 的 Mermaid 校验是产物契约——改结构需跑 `bun run mock:wiki` 并核对产物；
- 内容密度门是**纯函数**（`content-gate.ts`）：判定逻辑改这里，副作用仍在
  `page-tools.ts`（拦截）与 `generate-wiki.ts`（降级落盘）；**降级落盘必须同时覆盖 `try` 与 `catch`
  两条路径**（token 预算耗尽时 harness 抛错走 `catch`）；门限是下限不是目标，
  代码块是软建议（源里没代码时 0 是正确答案，见 `AGENTS.md` §1.1）；
- 交付闸门（`verify-wiki.ts`）**只读**：`verify.json` 只能由 CLI（`apps/cli/src/commands/verify.ts`）
  或 `generate-wiki.ts` 的 `verifyAfterGenerate` 集成落盘；**不得改 `RunMeta`**（摘要是 run 目录下的独立文件）；
  校验失败不判生成失败（闸门是事后体检，不是交付前置）；
- 提示词改动会直接改变 LLM 行为，改前先读 `AGENTS.md` §1.1 的对应决策行。

### 6. `apps/cli`（终端界面）

pi-tui 全屏 TUI（**无 React/Ink 依赖**）：`src/index.ts`（commander 入口 + `-d/--dir`）、`src/tui/`
（App / Layout / Router / Screen / 组件）、`src/state/`（ConfigStore / I18nStore / WikiStore）、
`src/views/`（16 个页面：wiki-home / generate / sync / browse / 12 个 config 页）、`src/theme.ts`（色值）。

**修改要点**：

- 布局 / 快捷键 / 文案改动必须同步 `test:tui` 的断言；页面按键必须走 pi-tui 聚焦分发
  （`Screen.handleInput` → `handleKey`），不得自行转发后手动 `refresh()`；
- 渲染不得超终端高度：列表窗口化（`computeItemWindow`），超宽行截断（pi-tui 渲染器会抛错）；
- 色值一律从 `theme.ts` 引用，遵循 `DESIGN.md`（禁止页面内散落十六进制字面量、禁止 emoji 装饰）；
- 工具文案一律不引用 shell——本仓库没有 Bash 工具（目录操作点名 `Ls`）。

### 7. `apps/browse`（预览站）

React 19 + Vite 的本地 Web 阅读器：侧边导航、Mermaid 渲染（放大弹窗）、语法高亮。
不引用任何 workspace 包；依赖随根 `bun install` 装齐。

**修改要点**：视觉遵循 `DESIGN.md` 的 Web 规范部分（NotionInter 层级、暖中性色阶、耳语边框）；
API 通过 `/api` 与 CLI 服务端通信，响应结构改动需同步 `test:browse`。

### 8. `vendor/pi`（pi 内核快照）

上游源码 + 构建产物双模式（src / dist），**上游零改动**是默认约束。
确需改 pi 源码时：`bun run vendor:src` → 改 `src/` → `bun run vendor:dist` → `vendor:build` → `bun run test`
（**不要手改 `dist/`**，会被覆盖）。

---

## 跨平台硬约束（摘要）

完整清单见 `AGENTS.md` §6.8，改任何代码 / 脚本 / 文档示例前自查：

- 路径用 `node:path`，落盘 / 比较前归一化为正斜杠；
- 家目录 / 临时目录走 `os.homedir()` / `os.tmpdir()`，禁止硬编码；
- `package.json` scripts 一律 `bun run <file>.ts` 形式，不写 `rm -rf` / `&&` 链 / `$(...)` 等 POSIX 专属写法；
- 源码统一 LF、UTF-8 无 BOM；读外部文件注意 strip `\r`；
- import 路径大小写与磁盘完全一致（Linux 大小写敏感）。
