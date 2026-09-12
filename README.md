<h1 align="center">zread-pi</h1>

<p align="center">
  <strong>一行命令，把任何代码库变成一份高质量的 Wiki。</strong><br>
  本地运行的 AI 代码库导航器：扫描 → 解析 → 蓝图 → 并行页面生成，全程代码不出本机（只与你配置的 LLM 通信）。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-success?style=flat-square" alt="Node version">
  <img src="https://img.shields.io/badge/Bun-1.3%2B-f6f5f4?style=flat-square" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20macOS-%E7%AD%89%E4%BB%B7%E5%8F%AF%E7%94%A8-2a9d99?style=flat-square" alt="Platforms">
</p>

<p align="center">
  <img src="./static/index-tui.png" width="90%" alt="zread-pi 终端界面">
</p>

---

## 为什么做 zread-pi

文档会腐烂，zread-pi 让它保持鲜活。

- **几分钟上手，而不是几周。** 对任何陌生代码库，得到一份带模块边界与架构图的 Wiki。
- **专注代码本身。** AI 从源码提取接口、依赖与用法示例，不需要你随手补文档注释。
- **刷新，而不是重写。** 符号级增量缓存让代码变更后的再生成又快又省。
- **代码不出本机。** 完全本地运行，无遥测、无第三方服务，数据只发往你自己配置的 LLM 端点。
- **自带 LLM。** 内置 40 个 Provider 目录（Anthropic、OpenAI、DeepSeek、Moonshot、Qwen 等），
  也支持任意 OpenAI 兼容端点与自定义模型。
- **三平台等价可用。** Windows / Linux / macOS 全部命令与工具链行为一致（含纯 JS 兜底，不依赖 POSIX 专属命令）。

## Features

> [!TIP]
> zread-pi 不是「包一层 LLM API」——业务层运行在 [pi](https://github.com/earendil-works/pi) 的 agent 内核
> （`pi-ai` + `pi-agent-core`）之上，专为「理解代码库」这件事打造。

- **三层 Repo Map** —— 目录拓扑 → 高频签名 → 按需深挖。超大规模仓库也不会撑爆上下文预算。
- **符号级增量缓存** —— 基于 AST hash；未变更的符号跨运行直接跳过，Wiki 同步只重新生成源码确实变过的页面。
- **并行页面 Agent** —— `p-limit` 调度扇出，并发可配置；每个 Agent 只拥有一个 Wiki 页面，只读它需要的真实代码。
- **上下文自动压缩** —— 接近模型上下文上限时自动生成摘要（compact boundary）继续工作；实在腾不出空间时优雅停止，
  而不是等 provider 报上下文溢出。
- **可调的轮次与收尾** —— 最大工作轮次可配置（0 = 不限制）；到达上限前自动注入收尾提示并给一轮宽限，避免「差一步被掐断」。
- **思考深度可选** —— 7 档 thinking level（off → max），由模型能力自动 clamp，不支持的档位清楚标注。
- **Provider 无关** —— 统一抽象 Anthropic Messages 与 OpenAI Chat Completions 协议；在 TUI 里选 Provider、贴 API Key、
  挑模型，三步完成，可同时配置多个 Provider。
- **流级重试** —— 429 / 5xx / 网络错误指数退避，只在「未产出内容」时重试，失败尝试不污染会话记录。
- **本地 Web 阅读器** —— `zread-pi browse` 启动 React 19 + Vite 预览站：侧边导航、Mermaid 图表渲染（支持放大查看）。
- **Wiki 同步，而不是 Wiki 覆盖** —— diff 感知的再生成：页面被标记为 `new` / `updated` / `unchanged` / `archived`，
  像审代码 diff 一样审文档变更。
- **全局记忆** —— 生成过的项目自动记录（`zread-pi history` 一键清理失效项），老项目打开即自动补录。

## Quick Start

> [!NOTE]
> 要求 Bun ≥ 1.3、Node ≥ 22。

```bash
# 0) 全新 clone 后：安装依赖 + 构建 pi 内核 vendor 产物（vendor/pi/**/dist 不入库）
git clone <your-repo-url> zread-pi
cd zread-pi
bun install
bun run vendor:build

# 1) 类型检查 + 全部冒烟测试（离线，不需要任何 API Key）
bun run test

# 2) 离线全链路试跑：用 mock LLM 对夹具仓库跑「扫描 -> 蓝图 -> 并行页面」
bun run mock:wiki

# 3) 真机跑 CLI：先配置 LLM（API Key 写入 ~/.zread-pi/auth.json）
bun run cli config
bun run cli            # 在目标仓库根目录执行
```

然后在终端 UI 里：

1. 添加一个 LLM API Key（内置 40 个 Provider，也支持任意 OpenAI 兼容端点）。
2. 选好模型，回车「生成文档」。
3. 看并行 Agent 读你的代码，产出带 Mermaid 图表的 `Wiki/` 页面。

用浏览器阅读结果：

```bash
bun run cli browse     # 或 zread-pi browse（二进制安装后）
```

## CLI 参考

| 命令                     | 作用                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `zread-pi`               | 默认命令 —— 打开 Wiki TUI；检测已有文档时提供 生成 / 同步 / 浏览 选项      |
| `zread-pi wiki`          | 显式 Wiki 生成入口（与默认命令同一 TUI）                                   |
| `zread-pi config`        | 交互式配置编辑器 —— Provider、API Key、模型、思考深度、最大轮次、外部工具  |
| `zread-pi browse`        | 启动本地 Web 阅读器（地址由服务端返回，保证真实可访问）                    |
| `zread-pi history [-c n]`| 清理全局记忆中已失效的项目记录并列出剩余项                                 |
| `bun run tools:install`  | 无头安装外部搜索工具（rg / fd），可指定版本；配置界面 `/config/tools` 同效 |

所有子命令均支持 `-d / --dir <path>` 指定目标仓库（不用切 shell 目录）。

### 快捷键（TUI）

| 键               | 作用                          |
| ---------------- | ----------------------------- |
| `↑ / ↓` (`k/j`)  | 移动焦点（长列表自动窗口化）  |
| `Enter`          | 确认                          |
| `Esc`            | 返回 / 取消（根页面退出）     |
| `PageUp/Down` `Home/End` | 长列表翻页            |
| `r`              | 刷新（模型目录 / 重跑检测）   |
| `Ctrl+C`         | 强制退出                      |

## 截图

<p align="center">
  <img src="./static/config-tui.png" width="48%" alt="Provider 配置页">
  <img src="./static/ai-model-tui.png" width="48%" alt="模型选择页">
</p>
<p align="center">
  <em>在终端内完成 Provider / API Key / 模型选择 —— 内置 40 个 Provider，也可添加自定义端点与自定义模型。</em>
</p>

<p align="center">
  <img src="./static/gen-document-tui.png" width="90%" alt="并行生成进度页">
</p>
<p align="center">
  <em>N 个并行页面 Agent 读真实代码，实时产出结构化 Markdown。</em>
</p>

<p align="center">
  <img src="./static/help-tui.png" width="90%" alt="帮助页">
</p>
<p align="center">
  <em>内置帮助页 —— 命令与快捷键一览。</em>
</p>

## 工作原理

zread-pi 不会把代码一股脑塞给 LLM，而是模仿资深架构师读代码的方式：

```text
你的代码库
   │
   ├── 1. 扫描    glob + .gitignore 精确定位所有源码文件
   │
   ├── 2. 解析    Tree-sitter AST 提取导出、签名、依赖
   │
   ├── 3. 缓存    符号级 AST hash 跳过未变更文件 —— 省时省钱
   │
   ├── 4. 蓝图    规划 Agent 构建三层 Repo Map：
   │                ├─ 层一  目录拓扑        → 宏观架构
   │                ├─ 层二  核心签名        → 高频接口
   │                └─ 层三  按需深挖        → 模块边界 → wiki.json
   │
   └── 5. 生成    N 个并行页面 Agent 按模块读真实代码，
                  渲染 Mermaid 图表，产出结构化 Markdown
```

### 为什么三层 Repo Map 是关键

一个 5 万行的代码库完整序列化约 200 万 token —— 远超任何上下文窗口。常见做法要么丢真（对 README 做分块检索），
要么烧钱（每个页面都重喂整棵目录树）。

三层 Repo Map 借鉴人类架构师的上手方式：

1. **先看拓扑。** 什么在哪里？哪些目录像基础设施、哪些像业务域？
2. **再看热点签名。** 哪些导出被引用最多？那些就是承重接口。
3. **按需深挖。** 只有当规划 Agent 决定给模块 X 写页面时，才打开 X 的完整 AST。

结果：10 万行的仓库用约 5k token 就能画像，每个页面 Agent 只拉自己需要的内容。

### Wiki 同步：diff 感知的再生成

代码变更后重跑不会推倒你的 Wiki。编排层会：

1. 重算每个文件的 AST hash；
2. 与缓存的符号清单做 diff；
3. 依据页面覆盖的源码文件标记 **unchanged** / **updated** / **new** / **archived**；
4. 经你确认后只重新生成受影响页面。归档页面快照保存在 `.zread-pi/wiki/archived/<时间戳>/`，什么都不丢。

## 支持的语言

| 语言               | AST 解析器                | 状态 |
| ------------------ | ------------------------- | :--: |
| TypeScript / TSX   | tree-sitter-typescript    |  ✅  |
| JavaScript / JSX   | tree-sitter-javascript    |  ✅  |
| Vue (SFC)          | tree-sitter-vue           |  ✅  |
| Go                 | tree-sitter-go            |  ✅  |
| Python             | tree-sitter-python        |  ✅  |
| Rust               | tree-sitter-rust          |  ✅  |
| Java               | tree-sitter-java          |  ✅  |
| C                  | tree-sitter-c             |  ✅  |
| C++                | tree-sitter-cpp           |  ✅  |
| C#                 | tree-sitter-c_sharp       |  ✅  |
| Ruby               | tree-sitter-ruby          |  ✅  |
| Swift              | tree-sitter-swift         |  ✅  |
| Kotlin             | tree-sitter-kotlin        |  ✅  |
| PHP                | tree-sitter-php           |  ✅  |

新增语言只需在 `packages/repo-analyzer/src/parser/constants.ts` 的 WASM 映射中登记 grammar。PR 欢迎贡献。

## 支持的 LLM Provider

内置 pi-ai 的 40 个 Provider（离线可用，含精选模型默认值），并支持任意 OpenAI 兼容端点：

| 海外                                                              | 国内                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Anthropic · OpenAI · Google Gemini · Mistral · Cohere · xAI · Groq | DeepSeek · Moonshot · MiniMax · 智谱 · Qwen · 豆包 · Yi · 百川 · StepFun 等 |

没找到你的？在 TUI 里走「自定义 Provider」流程，填任意 OpenAI 兼容 Base URL 即可；
还能为任意 Provider 添加自定义模型（上下文窗口 / 最大输出 / 思考 / 图片能力）。

## 配置

配置归 zread-pi 自管理，全部可在 TUI 中维护，无需手写 YAML：

- `~/.zread-pi/config.yaml` —— 非敏感配置：UI / 文档语言、`llm.provider/model`、每个 Provider 的
  `base_url` 与自定义模型、思考深度（`llm.thinking_level`）、最大轮次（`agent.max_turns`，0 = 不限制）、
  外部工具开关（`tools.<id>.enabled`）。
- `~/.zread-pi/auth.json` —— pi-ai 格式凭据（API Key），可同时保存多个 Provider；**秘密不进 config.yaml**。
- `~/.zread-pi/models-store.json` —— 动态 Provider 的模型目录缓存。

> [!IMPORTANT]
> API Key 存放在 `~/.zread-pi/auth.json`，除调用你配置的 Provider 外不会离开本机。共享机器请自行收紧文件权限。

## 输出结构

```
your-project/
└── .zread-pi/
    ├── wiki/
    │   ├── wiki.json                    # 蓝图：页面、分区、技术栈摘要
    │   ├── current/
    │   │   └── {section}/{page}.md      # 生成的 Markdown 页面（当前版本）
    │   └── archived/<快照名>/
    │       └── {section}/{page}.md      # 同步时归档的旧页面快照
    └── cache/
        ├── last_manifest.json           # 文件扫描结果
        └── last_symbols.json            # AST-hash 符号缓存
```

每页都是内嵌 Mermaid 图表的纯 Markdown —— GitHub、GitLab、Docusaurus、Notion、你自己的静态站点都能直接渲染。

<p align="center">
  <img src="./static/index-browse.png" width="90%" alt="本地 Web 阅读器">
</p>

## 使用场景

- **开源维护者** —— 不用写一页文档，就能随 README 交付一份真实的 Wiki。
- **新人上手** —— 入职第一天就获得代码库导览，而不是第三周。
- **并购尽调** —— 一小时内产出陌生代码库的架构概览。
- **遗产代码考古** —— 从原作者早已离职的代码库里找回机构知识。
- **内部平台团队** —— 用 CI 触发再生成，让平台 / SDK 文档持续与代码同步。

## 对比

| 方案                          | 局限                                     | zread-pi                                            |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 手写文档                      | 慢、与代码漂移、没人爱写                 | AI 从源码生成；重跑保持同步                          |
| Copilot / Cursor              | 只有文件级上下文，没有全局视图           | 三层 Repo Map 提供上帝视角                           |
| Mintlify / JSDoc              | 只覆盖前端生态                           | AST 级解析 14 种语言，前后端通吃                     |
| 闭源 AI 文档 SaaS             | 订阅费 + 代码上传第三方                  | 完全开源、本地运行，数据不出本机                     |
| 朴素 RAG-over-README          | 泛泛摘要，信号量低                       | 每模块 Agent 自适应呈现 API 与架构                   |
| 手搭 Docusaurus / VitePress   | 搭建成本高，内容仍要手写                 | 生成内容直接落进你现有的静态站点流水线               |

## FAQ

<details>
<summary><strong>一次典型运行要花多少钱？</strong></summary>

成本大致与 Wiki 页面数线性相关，而不是与代码行数。以 DeepSeek V3 为例，3 万行的 TypeScript 仓库一次完整生成
通常低于 $0.2；得益于符号缓存，之后的同步运行通常低于 $0.05。
</details>

<details>
<summary><strong>我的代码会被上传到哪里？</strong></summary>

只会发往你在 `config.yaml` 里配置的 LLM Provider。zread-pi 本身完全本地运行：无遥测、无自有服务器、
除你选择的 LLM 端点外没有任何第三方。
</details>

<details>
<summary><strong>能在 CI 里用吗？</strong></summary>

可以。配置齐全时 CLI 是非交互的，可包在 GitHub Action 里触发再生成并回写 Wiki。
外部搜索工具（rg / fd）可通过 `bun run tools:install` 无头安装，不依赖交互界面。
</details>

<details>
<summary><strong>代码库混用多种语言怎么办？</strong></summary>

有 grammar 的语言全部解析，没有的跳过。混合语言模块的页面会引用全部文件，但只为受支持的语言渲染结构细节。
</details>

<details>
<summary><strong>Windows 上能跑吗？</strong></summary>

能，且与 Linux / macOS 行为等价。文件工具不依赖 POSIX 专属命令（无 rg/fd 时走纯 JS 兜底，能力不降级），
外部工具解包为纯 JS 实现，不调用 tar/unzip/PowerShell。
</details>

## 贡献

项目在快速迭代中。Issue、PR、新语言解析器与反馈都欢迎。

> [!TIP]
> 好的入手点：加一种 tree-sitter 语言（`packages/repo-analyzer/src/parser/constants.ts`）、
> 改进 TUI（遵循 `DESIGN.md` 设计系统）、或完善中英文案。

开发约定（分支 / 验证 / 版本号 / 合并流程）见 `AGENTS.md`；
迁移决策与行为差异见 `MIGRATION.md`；
UI 设计系统见 `DESIGN.md`；包结构与修改指南见 `RULES.md`。

如果这个项目帮你省了时间，去 GitHub 点个 ⭐ 就是最好的感谢。
