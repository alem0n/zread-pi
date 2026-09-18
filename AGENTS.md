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
                    + harness/（第十步：AgentHarness 驱动 + token 预算 + 工具/事件/Models 桥）
                    + pi/provider-catalog（pi-ai 内置 Provider 目录 / 登录 / 自定义模型）
                    + pi/auth-store（~/.zread-pi/auth.json 凭据）/ pi/models-store（模型目录缓存）
  orchestrator      ★ 编排层：三阶段蓝图（分类/分主题/标题）、prompts、p-limit 并发、wiki.json 契约、增量同步
                    + 轨迹事件捕获（createAgent 钩子 + generate/sync 的 withRunLog 包裹）
  repo-analyzer     ★ Tree-sitter 扫描与解析（未改）
  utils             ★ 配置 / cache / wiki 落盘 / 版本快照 / provider-registry / trajectory-store（runs 落盘与读取）
  types             ★ 共享类型 + RunEvent / RunMeta（轨迹事件流）
  trajectory        ★ 轨迹视图的纯模型层（replay 折叠 / 布局 / 时序投影 / 搜索 / 虚拟化；无 node 依赖，可被 Vite 打包）
fixtures/hello-python  测试夹具：极简 Python 项目，离线全链路试跑的目标
vendor/pi/packages/    pi 内核源码（ai / agent / telemetry / chord / tui，上游零改动）
tools/                 vendor 模式切换脚本、mock LLM 全链路脚本
```

### 1.1 关键设计决策（改动前必须理解）

| 决策                                            | 原因                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只替换运行时内核，不动业务层                                | 业务层（编排/并发/落盘/提示词）已验证可用；换底座是为了健壮性                                                                                                                                                                                                                                                                                                                                                                                                               |
| 首尾机制跟随 harness 升级，而不是原样搬运                   | 裸 loop 的 `shouldStopAfterTurn` / 手写 `transformContext` 压缩 / `agent.steer()` 收尾提示换成 harness 的 `before_run` / `before_run_end` / `before_tool`：轮数硬顶→**token 预算**（usage 事件/ledger 权威累计）、一次性提示→**两段式提示**、返回 true 停止→**不返回 followUp 终止**、`error_max_turns`→**预算耗尽强制交卷 + 编排层判页失败**（详见 `MIGRATION.md` §12） |
| CLI 从 Ink 换成 pi-tui，**布局/快捷键/文案不变**           | 与内核同一生态，去掉 React 18/Ink 依赖；业务逻辑在 `views/*/mapper.ts`、`state.ts` 等纯函数层原样保留                                                                                                                                                                                                                                                                                                                                                                      |
| 适配层保持 `agent-sdk` 的**同名同签名**契约                | 业务侧 22 处 import 机械替换即可，行为可回退对比                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 重试交给 harness 的 retry policy，且只在「未产出内容」时重试         | harness 在响应 settlement 前重试（失败尝试不会写进会话记录，等价旧 `stream` 语义）；pi 的裸 Agent 循环刻意不内置重试                                                                                                                                                                                                                                                                                                                                                                                                            |
| 钩子映射到 harness 的 `before_run` / `before_run_end` / `before_tool` / `after_tool` | 旧 `PreToolUse` / `PostToolUse` 与 UI 进度事件零改动；首尾机制（预算提示/终止/熔断）挂在同一套钩子上（见 `MIGRATION.md` §12.3）                                                                                                                                                                                                                                                                                                                                                                                              |
| 5 个文件工具**原样复制**而非改用 pi 内置工具                   | 保持工具名/schema/提示文本不变，避免 LLM 行为漂移（**已由 §1.3 的工具层重写取代，工具名仍不变**）                                                                                                                                                                                                                                                                                                                                                                                   |
| 工具层按上游 pi 重写，新增 `Ls`                          | 旧工具是从 `agent-sdk` 原样拷来的糙版：`Glob` 依赖 Node 实验 API 且有 `spawn('bash')` 兜底（Windows 上等于不可用）、`Grep` 全量缓冲且 rg/grep 两分支输出不一致、`Read` 的图片只回一句字节数、`Edit` 在 CRLF 检出上必然匹配失败、`Write`/`Edit` 无同文件串行化（并行页面生成会丢更新）。现按上游实现重写，补齐 `Ls`（旧 `Read` 对目录的提示点名 `Bash`，而本仓库没有 Bash 工具），详见 §1.3                                                                                                                                                                             |
| rg / fd：**探测常驻、安装显式**                         | 上游会在工具缺失时静默联网下载并解包（tar/zip + chmod + Windows `tar.exe`/PowerShell 分支）。本仓库拆成两件事：① agent 运行期只探测（缺失时退回纯 JS 兜底，见 `file-walk.ts`），绝不隐式联网；② 安装只在用户显式动作（配置界面 `/config/tools` 或 `bun run tools:install`）时发生，解包用**纯 JS**（`zlib` + 自写 tar/zip 解析），不依赖 tar/unzip/PowerShell。                                                                                                                                                                              |
| 外部工具配置只存「是否启用」                                | `config.yaml` 只记用户意图（`tools.<id>.enabled`）；「装没装 / 装在哪 / 什么版本」属于运行时探测到的事实（托管目录 `~/.zread-pi/bin` 与系统 PATH），不落配置，避免配置与实际文件系统状态不一致                                                                                                                                                                                                                                                                                                                |
| 工具结果新增可选 `details` 与图片内容块                     | 截断信息 / diff / 命中上限需要结构化回传（不进模型上下文）；图片按 magic number 判型后以 image 块回传（仅当 `model.input` 含 `image`）。均为**新增可选字段**，旧调用点零改动。**第十二步起图片走处理管线**（见下一行）                                                                                                                                                                                                                                                                                                                            |
| 图片处理管线（第十二步，移植 pi coding-agent）              | `Read` 不再原样回传图片：格式归一到 png/jpeg/gif/webp（BMP/TIFF 等转 PNG）、超过 2000×2000 或 4.5MB base64 时缩放（PNG/多档 JPEG 取小、逐级 0.75 缩）、回传坐标换算提示；Worker 线程跑 WASM，失败回退进程内。仅当模型支持图片时才处理；无法处理时降级为文本说明（不报 tool error）。实现：`agent-runtime/src/tools/image/**`（见 `MIGRATION.md` §14.2.1） |
| 目标仓库自述注入系统提示（第十二步）                       | 生成文档前读 `AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`（全局 `~/.zread-pi` + 目标仓库根），按 pi 的 `<project_context>` 格式拼进蓝图/页面 Agent 的系统提示；单文件 64 KiB 截断。与上游差异：不向上遍历父目录（见 `MIGRATION.md` §14.2.2） |
| 文风纪律（humanizer）两层机制（第十三步）                  | 第 1 层预防（`polish.enabled`，默认开）：按 `doc_language` 选 `humanizer.en.md` / `humanizer.zh.md`（各 60~80 行、头部注明来源），拼进蓝图/页面 Agent 系统提示、排在 `<project_context>` 之后，零额外调用；第 2 层兜底（`polish.mode=full`）：每页落盘后跑轻量 polish Agent（Read/Edit/Ls + 独立小预算，提示词 = 纪律 + Embedded mode），失败不判页失败、Mermaid 被改坏回滚。配置界面 `/config/polish`（见 `MIGRATION.md` §15） |
| 浏览站跟随 CLI 界面语言（logview 网页中文化）           | CLI 有中英双语但浏览站（轨迹页）原为英文硬编码。服务端新增 `GET /api/i18n`（`resolveBrowseLocale()` 读 `language` 配置并归一化），前端 `apps/browse/src/i18n/` 是**独立于 CLI 的第二套字典**（两套应用文案不重合），`I18nProvider` 启动时取一次语言经 Context 下发。默认/回退 `en-US`（= 改造前文案，现有用户零变化）。数据层派生的标签（turn label / 「Initial System Prompt」等）不翻译（见 `MIGRATION.md` §26.8） |
| 重试分两层，尊重服务端 `Retry-After`（第十二步）             | Agent 层（harness `RetryPolicy`）从固定 10s 改为指数退避 2s→4s→…、60s 封顶；Provider 层新增 `streamOptions.maxRetries / maxRetryDelayMs`，由 pi-ai `retryProviderRequest` 读服务端 `Retry-After`，超上限立即失败并交给 Agent 层。`maxRetries=0` 现在**显式禁用**（不再回退 harness 默认 3 次） |
| 配置写入加跨进程文件锁（第十二步）                         | `packages/utils/src/lockfile.ts`（`proper-lockfile`，`realpath:false`，ELOCKED 重试 10×20ms）包住 config.yaml / auth.json / tools-state.json / history 的「读-改-写」；config 额外临时文件 + rename 原子替换。锁失败按写入失败报错，不静默降级（见 `MIGRATION.md` §14.2.4） |
| TUI stdout 接管（第十二步）                               | `apps/cli/src/tui/output-guard.ts`（移植 pi coding-agent）：接管 `process.stdout.write`，TUI 自身写入走放行窗口/ESC 控制序列直达原生 stdout，杂散写入进日志文件（pi 默认送 stderr，可用 `redirect` 配置）；`guarded-terminal.ts` 把 pi-tui 终端方法包进放行窗口；`zread-pi history` 的清单输出也走 `writeRawStdout`（见 `MIGRATION.md` §14.2.5） |
| 配置界面改用 pi-ai 的 Provider/登录/模型目录               | 不再自维护 provider registry；API Key 统一走 `Models.login('api_key')`，凭据落 `~/.zread-pi/auth.json`，天然支持多 Provider；Provider 详情页把 API Key 与模型选择并列在同一页面（不再有 OAuth 订阅选项）；自定义模型按 pi models.json 合并语义叠加                                                                                                                                                                                                                                                       |
| 自定义 Provider 与内置 Provider 同等待遇（可命名 / 可多模型 / 可编辑） | 旧「自定义 Provider」流程只能用一个固定 id（`custom`）且只能配一个模型。现在：新建时填写**显示名称**（id 由名称 slug 化，与内置/已配置 id 冲突时追加 `-2`/`-3`，见 `apps/cli/src/utils/provider-id.ts`）、Base URL 与 **API 协议**（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`，`t` 切换）；保存后进入**标准详情页**——API Key 录入与**多个**自定义模型都在详情页完成（与内置 Provider 完全一致）。详情页对自定义 Provider 额外提供 `e` 编辑入口（`/config/provider/:id/edit`：改名称/端点/协议，id 与凭据/模型不变）。配置新增 `llm.providers.<id>.name`（缺省回退 id；`createConfiguredProvider` 读取）。内联登录逻辑从创建页移除 |
| 思考深度（thinking level）直接沿用 pi 的 7 档             | 配置界面新增 `/config/thinking`（`llm.thinking_level`，默认 off）；受支持等级由 pi-ai `getSupportedThinkingLevels` 计算，模型不支持时分界清楚标注、请求时由 pi 自动 clamp；运行时 `createAgent({ thinkingLevel })` 透传为 `options.reasoning`。**自定义模型遵循 pi 的 opt-in 语义**：缺省只是「普通推理模型」（最高 high，max/xhigh 被钳制），在添加模型时勾选 `xhigh`/`max`（写入 `CustomModelConfig.thinking_level_map`）后这两档才会出现在支持列表与 `/config/thinking` 中；高级映射（自定义发送值、标准档调整、`null` 显式禁用某档）可直接编辑 config.yaml |                                                                                                                                                                                                                                          |
| 最大轮次进配置（不再硬编码）                                | 配置界面新增 `/config/max-turns`（`agent.max_turns`，0-100，默认 30；0 = 不限制轮次）；Orchestrator 的 `create-agent.ts` 读配置下发，`generate-wiki` 不再写死 `maxTurns: 30`。**第十步起该字段不再数轮次**：适配层把 `max_turns × 25000` 折算成 token 预算（见下一行）                                                                                                                                                                                                                                                                                                 |
| 首尾机制 harness 化（token 预算 + 两段式提示）                                 | 轮数硬顶 → **token 预算**（判据是 harness 的 usage 事件/ledger 权威累计）；两段式提示（软 70% + 硬将尽）经 `before_run` 注入；`before_run_end` 不返回 followUp 即终止；预算耗尽 → 强制交卷 → 仍无目标产物才 `error_budget_exhausted`，编排层照旧按产物判页失败（详见 `MIGRATION.md` §12）                                                                                                                                                                                                                                          |
| 蓝图生成改为**三阶段多重循环**（分类 → 分主题 → 标题） | 旧实现「单 Agent 一次性吐全量蓝图」输出轮次过多，模型提前收敛导致文章数偏少。现在：① 分类（1 个 Agent）只产 sections 并写骨架；② 分主题（每 section 1 个 Agent，p-limit 并发）产页面，slug/file 由代码统一编号去重；③ 标题（每 section 1 个 Agent）只回写 title。每阶段增量归并进 wiki.json（文件锁 + 原子替换），单 section 失败记 `failedSections` 不阻断其余；文章生成阶段零改动（详见 `MIGRATION.md` §17）。`generate_blueprint` / `generate_sync_blueprint` 保留仅归档 |
| 蓝图细节档位 `blueprint.detail`（第十六步：minimal / low / medium / high / max，默认 high） | 「项目理解深度」交给用户；三阶段管线对所有档位统一保留（不回退旧单 Agent）。数量控制是四层防线：① 提示词数量目标（`renderClassifyPrompt` / `renderTopicsPrompt` 按档位参数化）；② 常驻数量反馈（`submit_sections` / `submit_section_topics` **每次**返回都带「当前 N / 要求 min~max（当前档位）」）；③ AI 归并（越界**不落盘、不报错**，返回归并 / 补充策略文本请求重提，最多 2 轮；第 3 轮开缩编 subagent：干净上下文 + 覆盖 `systemPrompt` + 小预算 + 一次性只读输出工具，只看清单本身，结果仍走 merge 落盘，失败静默降级）；④ 代码确定性兜底（基础分类保序取前 N / 每 distinct group 保 1 篇再按序填充，注记「已达到调整轮次上限，代码侧收尾」）。minimal 固定 1 分类（概览）·1 篇全景导览（页面提示词附加 Mermaid 架构图要求），low/minimal 跳过标题精修；配置界面 `/config/detail`（详见 `MIGRATION.md` §18） |
| 三阶段大纲逐级注入（第十八步：防全项目漂移） | 分类阶段除 description 外为每个分类产出 `scope`（1~3 条「包含：…」+ 1~3 条「不包含：…（→ 相邻分类）」，分类间互斥）；分主题阶段注入本分类 scope（`buildTopicsPrompt`）并产出 `summary`（一句话主题摘要，≤40 字）；标题阶段注入 scope 并新增「不越出分类边界」规则；页面阶段把 `topicSummary` 与「范围纪律」注入 `buildPagePrompt`。字段全部可选（`WikiSection.scope?` / `WikiTopic.summary?` / `WikiPage.topicSummary?`），旧 wiki.json 无字段照常读取；sync 把 summary 列为逐字保留字段（旧页面清单带回）；**不做**代码级越界校验（语义约束只有注入一层，见 `MIGRATION.md` §20） |
| `llm.context_window` / `llm.max_tokens` 覆盖下发（e2e-blueprint 场景 7） | 同 test:blueprint | 覆盖值经编排层 `createAgent` → 适配层 `createRuntimeModel` 落到解析出的模型：`system/init` 上报覆盖后的上下文窗口（UI「上下文占比」分母），请求体输出上限为覆盖值（openai-completions 依 compat 走 `max_tokens` / `max_completion_tokens`） |
| 多档共存 + 浏览切换（第十七步） | 同一仓库可同时保留多套完整产物：`wiki/<detail>/wiki.json + <section>/<file>.md`（与 generate 的 `blueprint.detail` 一一对应）；新生成一律写档位子目录，遗留的无档位 `wiki/wiki.json` 只读兼容（browse 中显示为「默认」）。路径唯一口径：`getWikiDir(detail?)` / `getWikiJsonPath(detail?)` / `listWikiVariants()` / `resolveWikiVariant()`；orchestrator 生成/同步按变体读写（输出工具经 options 注入 `variant`），页面提示词与落盘兜底同步变体化。CLI 区分「活动变体」（任一档位，用于首页状态与浏览入口）与「写盘目标」（配置档位，生成/继续/管理/同步/强制重新生成；遗留目录不会被写）；完整文档判定改为「任一档位完整即算已有」。browse 新增 `GET /api/wiki/variants`，catalog/content/source 接受 `?detail=`（缺省 = 配置档位 → 遗留 → 第一个存在；`default` = 遗留；非法 / 缺失 → 404），前端侧边栏底部上拉选择器整站切换（同 slug 保留，否则落首页）。详见 `MIGRATION.md` §19 |
| 上下文压缩由 harness 内建承担                       | run 边界按 `model.contextWindow - reserveTokens` 判定，超限时生成摘要（发出 `system/compact_boundary`），用「摘要 + 保留的近期消息」继续；泄漏到 provider 的溢出按 pi-ai 的 `isContextOverflow` 归类为 `error_context_full`（既有文案不变）；`compaction.enabled=false` 用 `before_compaction` decline 保证不发摘要请求                                                                                                                                                                                                                  |
| 日志系统对齐 cordis（`LoggerService` 总线 + 命名 logger） | 移植 deepseek-harness 的 cordis `logger.ts` + logger-console 渲染器到 `packages/utils/src/logger/`：结构化记录（`Message{sn,ts,name,type,level,args}`）、printf/Error/AggregateError 展开、单行 10240 截断、名字哈希着色（与 harness 逐字一致）、多 exporter 广播、按 exporter/按名级别阈值、1000 条环形缓冲。旧的全局单例 `logger` 保留为兼容层（导出形状不变，`success`/`progress` 改为 `info` + `[OK]`/`[PROGRESS]` 消息标记），61 处调用点改为命名 logger（`orchestrator.*` / `analyzer.*` / `classify` / `topics` / `titles` / `tui.*`）。偏差：无 fiber/Context（改模块级单例）；console exporter 默认不注册（`ZREAD_PI_LOG_CONSOLE=1` 开启，避免与 TUI 的 console-guard 双写日志文件）；file exporter 为本仓库新增（日期按写入时刻取，修了旧实现模块加载期定死日期跨天写错文件的 bug；默认保留 30 天，`ZREAD_PI_LOG_RETENTION_DAYS` 可覆盖）。详见 `MIGRATION.md` §25 |
| 凭据不进 `config.yaml`                            | 用户配置（provider/model/base_url/自定义模型）在 `config.yaml`， 秘密（API Key / OAuth token）在 `auth.json`；旧扁平字段首次切换时自动迁移后清空                                                                                                                                                                                                                                                                                                                                   |
| 项目家目录只在一处定义 + 新增全局记忆 `history`                | 家目录（`~/.zread-pi`）此前散落在 utils / agent-runtime / repo-analyzer 多处 `homedir()` 拼接中，现在统一到 `packages/utils/src/project-home.ts`（`ZREAD_PI_HOME` 可覆盖，测试隔离用）。开始生成文档（蓝图 / 页面两个入口）时把项目绝对路径写入 `<家目录>/history`：ZRH1 二进制（追加 O(1) / 顺序遍历 O(n) / 墓碑随机删除 O(1)，按需 compact，上限 1000 条）；`zread-pi history` 并发检查各项目 `.zread-pi` 是否还在，删除失效记录后展示剩余；重复生成同一项目去重只留最近一条。另：打开（默认 wiki / config / browse 均适用）已有完整文档的目录时，若路径不在名单则自动补录（`ensureProjectRecorded`，已在名单不刷位置不重复） |
| 版本守卫（v1.13.0 引入；v1.13.6 改为按不兼容分界判定） | 只守卫项目家目录 `~/.zread-pi/version`（config / auth / history / logs …）；**仓库输出目录 `<repo>/.zread-pi` 不再守卫**（wiki / runs / cache 都是可再生产物）。**不是每个版本都互相不兼容**：代码用常量 `INCOMPATIBLE_BEFORE`（= `1.13.0`，最后一次不兼容数据格式变更的版本）标定分界——目录不存在 → 静默创建；来源版本 >= 分界（含未来主版本）→ **兼容，只更新 version 标记、不动数据、不备份**；早于分界 / 无 version 文件 / 无法解析 → 把目录备份为 `<dir>_bak`（占用则 `-2`/`-3`）后重建，并在 stderr 给出提示。以后再发生不兼容变更时，把 `INCOMPATIBLE_BEFORE` 改成那个版本号即可。**目录被别的进程当作 cwd 导致无法整体重命名时（Windows 报 EBUSY/EPERM），不降级、不静默：`ensureVersionGuard` 直接抛错，`runVersionGuard` 在 stderr 输出原因与重试指引后 `process.exit(1)` 退出进程**，旧数据保持不动。纯逻辑在 `packages/utils/src/version-guard.ts`（`parseVersion` / `compareVersions` / `isVersionCompatible`），CLI 包装在 `apps/cli/src/commands/version-guard.ts`（无参数，`runApp` 与 `history` 命令调用，接管终端前执行；`ZREAD_PI_VERSION_GUARD=0` 跳过）。语言提示用 `loadConfigLanguageSync`（不做完整校验，旧/残缺配置也能给出正确语言） |
| pi 以 vendor 源码 + dist 产物方式消费                  | 可锁定版本、可局部调试，同时类型检查走 `.d.ts` 保持快                                                                                                                                                                                                                                                                                                                                                                                                                |
| 浏览文档：服务端返回的 URL 必须真实可访问                       | 有构建产物（打包 `dist/browse` / 源码 `apps/browse/dist`）时 API + 静态资源同端口（SPA fallback）；源码运行且未构建时进程内启动 Vite dev server（`/api` 代理到 API 端口）。不再依赖用户另起 `browse:dev`，也不再返回没人监听的 5173；启动失败在 TUI 显示原因（`ZREAD_PI_BROWSE_DIST` / `ZREAD_PI_BROWSE_NO_OPEN` 供自定义与测试）                                                                                                                                                                                                |
| `apps/browse` 并入根 workspaces                  | 历史隔离原因（React 18/19 混装）随 CLI 换成 pi-tui 消失；并入后根 `bun install` 即装齐 Vite/React，源码运行「浏览文档」直接走进程内 Vite 兜底，不再依赖手动 `browse:install`（漏跑会以「未找到前端资源」启动失败，见 §6.3）                                                                                                                                                                                                                                                                                          |
| 生成页底部展示用量合计（第十四步）                          | 生成文档界面最下方实时展示**目录 Agent + 全部页面 Agent** 的输入 token（输入侧总量 = 非缓存输入 + 缓存读 + 缓存写）/ 输出 token / 缓存读占比（无用量时整行不渲染）。合计**不是**共享计数器上的增量累加，而是渲染时对「每页自己的累计快照」做幂等 reduce：多页并发不会重复计数/丢更新。槽位分两段：`usage` = 本轮运行累计快照，`carryUsage` = 历史轮次结转；**重试/重新生成不清零**（成功 + 失败 + 重试的消耗都留在槽位里，合计 = carry + 本轮），同一页正在生成时忽略重复触发。失败页/失败目录带最后一次累计快照（`generate-wiki.ts` 记录、`create-agent.ts` 的 error 事件带上、mapper 再做 `event.usage ?? 旧值` 兜底）。口径来自 pi 的 usage ledger（见 `MIGRATION.md` §16）；**不含** `polish.mode=full` 的 polish Agent 用量 |
| 生成页逐 Agent 行 + 上下文占比（第十九步） | 生成页**每个条目右侧状态后**都显示四个指标：输入 token（输入侧总量）/ 输出 token / 缓存占比 / **上下文占比（已用/窗口）**；**完成 / 失败也照常显示**。目录不再是一行聚合：**每个 Agent 一行**（`规划主题` / `拟定标题 · 章节` / `精修标题 · 章节` / 缩编 subagent 缩进在目录行下；命名见 `MIGRATION.md` §21.3），行内用量取 `agentUsage`（该 Agent **自己**的累计快照；`usage` 仍是目录级聚合，不混用），上下文已用 = 最近一次响应的 input+output+cacheRead+cacheWrite（与 pi compaction 同口径），窗口来自 `system/init` 新增的 `context_window`。带 `agentKey` 的 `complete`/`error` 只改行、不改目录整体状态（并修掉「首个 Agent 完成就 reload 并提前启动页面」的竞态）；业务判定「未产出工具」时由 `markAgentFailed` 把该行改为失败。详见 `MIGRATION.md` §21 |

### 1.2 契约冻结点（破坏即需同步改业务层）

```ts
createAgent({ model, providerId, apiKey, baseURL, cwd, systemPrompt,
              tools, maxTurns, budget, thinkingLevel, compaction, finalization, hooks, retryConfig, includePartialMessages })
  -> { query(prompt): AsyncGenerator<SDKMessage>, close(), abort() }

createProvider(providerIdOrApiType, { apiKey, baseURL })
  -> { apiType, createMessage({ model, maxTokens, system, messages }) }
```

- `SDKMessage` 联合类型与 `CatalogEvent` 时序（`requesting → responding → tool_start → tool_result → complete`）；`result.subtype` 新增 `error_context_full`（上下文将满）与 `error_budget_exhausted`（token 预算耗尽且强制交卷后仍无目标产物）
- `TokenUsage` 字段名、`BlueprintResult.durationMs / tokenUsage`；`result.usage` 自第十步起为 harness usage ledger 的**累计值**（单次响应用量在 `assistant` 事件上）
- 第十四步起 `TokenUsage` 归并新增纯函数导出：`emptyTokenUsage / addTokenUsage / sumTokenUsage`（`packages/agent-runtime/src/usage.ts`，唯一归并口径；pi 的 `addUsage` 只作用于内部 `Usage` 形状且未从包根导出）；`CatalogEvent` / `ArticleEventPayload` 的 `usage` 语义补齐为「该 Agent 的累计快照」（**含失败事件**带上最后一次快照，见 §1.1 与 `MIGRATION.md` §16）
- 首尾机制配置面：`budget.maxTokens / softRatio / forcedTurns / notices / outputTools`；`maxTurns` / `finalization` 保留为兼容字段（折算 token 预算，见 `MIGRATION.md` §12.5）
- 工具名（第二十一步起对齐上游 pi 的小写命名）：`read` / `write` / `edit` / `find`（原 `Glob`）/ `grep` / `ls`（原 `Ls`）/ `write_page` / `generate_blueprint`（提示词与测试依赖名字，不得改名）；参数风格同步对齐 pi：文件路径参数为 `path`（旧 `file_path` 仍被接受），`edit` 主参数为 `path` + `edits: [{ oldText, newText }]`（旧 `old_string` / `new_string` / `replace_all` 与顶层 `oldText` / `newText` 别名仍被接受）；工具 description 与 pi coding-agent 逐字一致
- 蓝图三阶段输出工具：`submit_sections`（分类；sync 为 merge 模式）/ `submit_section_topics`（分主题）/ `refine_section_titles`（标题）；`generate_blueprint` / `generate_sync_blueprint` 仅归档
- `WikiOutput.sections?: WikiSection[]`（新增可选；旧 wiki.json 无该字段时由 `sectionsFromBlueprint` 从 pages 推导）；`WikiSection` / `WikiTopic` 为新增类型
- `BlueprintResult` 的 `pagesCount` 语义为「最终页面数」，新增可选 `sectionsCount?` / `failedSections?`（`{ section, stage: 'topics'|'titles', error }[]`）
- `CatalogEvent` 新增可选 `stage?: 'classify'|'topics'|'titles'` / `section?: string` / 分类级 `progress` / `failedSections?`（complete 事件携带）；每阶段事件带聚合用量（所有已结束 + 进行中 Agent 的累计）
- utils 新增三阶段落盘设施（文件锁 + 原子替换）：`initWikiSkeleton` / `mergeWikiSections` / `mergeSectionTopics` / `applySectionTitles` / `writeWikiPages` / `normalizeBlueprintSections` / `mergeBlueprintSections` / `deriveSectionsFromPages` / `sectionsFromBlueprint` / `slugStem` / `nextPageIndex` / `normalizeLevel`
- `loadWikiBlueprint` 放宽：`pages` 为空但 `sections` 非空（骨架阶段）时可加载；sync 新增纯函数 `computeSyncDiff`（页面状态由代码机械判定）
- 工具结果新增**可选**字段（不破坏旧调用方）：`ToolResult.details` / `SDKToolResultMessage.result.details`（截断、diff、命中上限等元信息，不进入模型上下文）、`ToolResult.content` 允许内容块数组（图片回传）、`ToolContext.supportsImages`
- `RetryConfig` 新增**可选** `provider: { maxRetries, maxRetryDelayMs, timeoutMs }`（Provider 层重试，pi-ai 读 `Retry-After`）；`toRetryPolicy()` 对 `maxRetries <= 0` 返回**显式禁用**策略（不再回退 harness 默认 3 次），`toStreamOptions()` 负责下发 Provider 层配置（第十二步，见 `MIGRATION.md` §14.2.3）
- 图片处理管线对外新增导出：`processImage / resizeImage / formatDimensionNote / convertImageBytesToPng / convertToPng / loadPhoton` + 类型（均为新增，旧调用点零改动，见 `MIGRATION.md` §14.2.1）
- `AppConfig.llm` 的旧扁平字段（`provider/model/api_key/base_url`）仍可读；新增 `providers` 映射（`LlmProviderConfig`，新增可选 `name` = 自定义 Provider 显示名，缺省回退 id；旧配置无该字段照常读取）与 `CustomModelConfig`（新增可选 `thinking_level_map?: ThinkingLevelMap`，与 pi-ai 的 `thinkingLevelMap` 同形的三态映射 `Partial<Record<ThinkingLevel, string|null>>`；缺省/空对象 = 不写该字段，自定义模型退回 pi 的「普通推理模型」语义；旧配置无该字段照常读取）；新增 `llm.context_window` / `llm.max_tokens`（当前生效模型的上下文窗口/最大输出覆盖，`null` = 跟随模型目录默认，旧配置缺省 `null`，配置界面 `/config/model-size` 维护）；新增 `agent.max_turns`（旧配置缺省 30）与 `agent.token_budget`（0 = 按 `max_turns × 25000` 折算；两者同为 0 = 不限制预算）。旧配置必须能直接启动（运行时自动迁移/回退）
- `AppConfig.polish: { enabled: boolean; mode: 'prompt-only' | 'full' }`（旧配置缺省 `{ enabled: true, mode: 'prompt-only' }`，安全可启动）；`PageResult.polish?: PolishOutcome`（`applied / reason / error / durationMs / tokenUsage`，均为**新增可选字段**，polish 失败不影响 `success`）
- orchestrator 适配层 `createAgent` 新增可选 `systemPrompt`（polish Agent 自备系统提示，替换默认「语言提示 + project_context + 文风纪律」组合）；新增导出 `withStyleDiscipline / getStyleDiscipline / formatStyleDiscipline / buildPolishSystemPrompt / buildPolishTaskPrompt / polishPageFile / STYLE_DISCIPLINE_TAG`
- 第十六步：`AppConfig.blueprint: { detail: BlueprintDetailLevel }`（旧配置缺省 `high`，非法值回退 `high`，安全可启动）
- 第十六步：`submit_sections` / `submit_section_topics` 越界时返回**非 error** 的策略文本（`is_error` 不置位、不落盘）；新增工具名 `submit_condensed_sections` / `submit_condensed_topics`（一次性只读输出工具，仅缩编 Agent 使用，已加入 `OUTPUT_TOOL_NAMES` 预算提示集合）
- 第十六步：utils 三阶段落盘设施新增可选参数：`normalizeBlueprintSections(input, language, limit?, { minimal? })` / `initWikiSkeleton(..., { limit?, minimal? })` / `mergeWikiSections(..., { limit?, minimal? })` / `mergeBlueprintSections(..., limit?)`
- 第十六步：orchestrator 新增导出 `BLUEPRINT_DETAIL_SPECS / getDetailSpec / judgeQuantity / formatQuantityFeedback / buildSectionQuantityStrategy / buildTopicsQuantityStrategy / buildCondenseSectionTask / buildCondenseTopicsTask / codeFallbackSections / condenseTopicsToMax / MINIMAL_PANORAMA_REQUIREMENT / QUANTITY_FALLBACK_NOTE / MAX_QUANTITY_FEEDBACK_ROUNDS / DEFAULT_CONDENSE_TOKEN_BUDGET / CONDENSE_SYSTEM_PROMPT`、提示词渲染 `renderClassifyPrompt` / `renderTopicsPrompt`、工具工厂 `createSubmitSectionsTool` / `createSubmitSectionTopicsTool` / `createSubmitCondensedSectionsTool` / `createSubmitCondensedTopicsTool`、`generate-wiki` 的 `buildPagePrompt`
- 第十七步：`WikiOutput.detail?: BlueprintDetailLevel`（生成档位记录；旧文件无该字段）
- 第十七步：utils 路径口径 `getWikiDir(detail?)` / `getWikiJsonPath(detail?)`（不传 / null = 遗留目录）；新增 `listWikiVariants(wikiRoot?)` / `resolveWikiVariant(preferred?, wikiRoot?)` 与 `WikiVariantInfo`
- 第十七步：三阶段落盘/加载函数新增可选 `variant`（`initWikiSkeleton` / `mergeWikiSections` / `mergeSectionTopics` / `applySectionTitles` / `writeWikiPages` / `loadWikiBlueprint(path?, variant?)` / `generateWikiJson(..., variant?)`）；`generateWikiCatalog(onEvent?, { detail? })`、`generateWikiContent({ detail? })`、`syncWiki(onEvent?, { detail? })`、`createWritePageTool(variant?)`、`buildPagePrompt(page, spec, variant?)`
- 第十七步：browse API `GET /api/wiki/variants` 与 `?detail=`（catalog / content / source；`default` = 遗留目录）
- 第十八步：`WikiSection.scope?` / `WikiTopic.summary?` / `WikiPage.topicSummary?`（新增可选，旧 wiki.json 无该字段照常读取）；`submit_sections` / `submit_section_topics` 的 schema 新增同名可选参数；`normalizeBlueprintSections` / `mergeBlueprintSections` / `mergeSectionTopics` 透传（基础分类保留强补 title/description，但采纳模型声明的 scope）；`buildTopicsPrompt` / `buildTitlesPrompt` 注入 `- 范围边界（scope）:`；`buildPagePrompt` 注入 `**主题摘要**`（无则省略）+ 范围纪律；`SYNC_TOPICS_RULES` 要求 summary 逐字保留
- 第十九步：`SDKSystemMessage` 新增可选 `context_window?`（本次解析出的模型上下文窗口）；`CatalogEvent` 新增可选 `contextTokens?` / `contextWindow?`（最近一次响应的上下文体量）与 `agentKey?` / `agentRole?`（`classify` | `topics` | `titles` | `condense`）/ `agentStatus?`（`waiting` | `running` | `completed` | `failed`）/ `agentUsage?`（该 Agent 自己的累计快照；`usage` 仍为目录级聚合）；`ArticleEventPayload` 新增可选 `contextTokens?` / `contextWindow?`；带 `agentKey` 的 `complete` / `error` = 单个 Agent 终态，不带 = 目录整体终态
- 第十九步：`AgentResult` 新增可选 `contextTokens?` / `contextWindow?`；orchestrator 新增 `CatalogAgentRole` / `CatalogAgentStatus` 类型；CLI 新增 `CatalogAgentState` 与 `CatalogState.agents`（key = agentKey）、`PageStatus.contextTokens?` / `contextWindow?`、纯函数 `contextUsage()`；同步页忽略带 `agentKey` 的事件（不展示逐 Agent 行）
- 第二十二步（轨迹会话隔离）：`RunEventAgentMeta` 新增**可选** `sessionId?`（Agent 一次运行的会话标识；旧日志无该字段时 replay 回退 `agent.key` 归属，兼容读取）；编排层新增 `agents/run-log-sink.ts`（`generateSessionId()` 时间戳 + 随机后缀 / `createRunLogSink()` 统一生成 sessionId 并绑定 Agent 身份），`RunLogSink` 接口新增 `readonly sessionId`，`createAgent` 透传 `sessionId` 到 pi 的 `AgentOptions`（缺省由适配层生成，绝不复用）；`TrajectoryTurnInfo.sessionId`（必填）/ `TrajectoryTurnModel.sessionId?`（layout 回填）；replay 归属键由「单指针」改为 `Map<sessionId|key, TurnState>`（并发 Agent 不互相吞、`agent_end` 只清自己的会话）；保留期清理改为按 `startedAt`（毫秒 ISO）而非 runId 字典序，且用含本 run 的完整集合判定超限、只在删除时排除自己；`listRuns` 对无 meta 目录合成的 `startedAt` 改用 runId 本身（与 ISO 同为 `T` 分隔、字典序可比）

---

## 1.3 工具层（第六步：对齐上游 pi）

落点：`packages/agent-runtime/src/tools/`（共享设施 + 5 个工具 + 新增 `Ls` + 图片处理管线 `image/`）。

| 工具      | 状态     | 要点                                                                                                                                                                                    |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ls`    | **新增** | 目录列举：大小写不敏感排序、目录补 `/`、含 dotfile、条目/字节双上限；`read` 的目录报错已改为点名 `ls`（名称对齐 pi 后原 `Ls`）                                                                                                                       |
| `find`  | 替换     | 原 `Glob`，名称对齐 pi；系统 `fd` 优先，无 fd 时纯 JS 遍历兜底；输出**相对搜索根的 POSIX 路径**并按字典序排序；尊重 `.gitignore`/`.ignore`/`.fdignore`（非 git 仓库内也生效）；跳过 `.git`/`node_modules`/`.zread-pi`；`limit` 可调                           |
| `grep`  | 替换     | 原 `Grep`，名称对齐 pi；rg `--json` **流式**解析 + 命中上限立刻 kill；无 rg 时纯 JS 兜底（同输出格式）；新增 `ignoreCase`/`literal`/`context`/`limit`；长行截断 500 字符；保留 `output_mode`（content / files_with_matches / count）                |
| `read`  | 替换     | 原 `Read`，名称对齐 pi；图片按 **magic number** 判型，模型支持图片时走**图片处理管线**回传 image 块（自动归一到内联格式、缩放到 2000×2000 / 4.5MB 以内、带坐标换算提示），否则文本说明；`offset` 1-based；2000 行 / 50KB 双上限 + `Use offset=N to continue.`；目录报错点名 `ls`；非图片二进制不灌乱码                                             |
| `write` | 替换     | 原 `Write`，名称对齐 pi；同文件并发写串行化（`withFileMutationQueue`）；`details.created` 标记新建/覆盖；参数 `path`/`content`（旧 `file_path` 仍被接受）                                                                                              |
| `edit`  | 替换     | 原 `Edit`，名称对齐 pi；BOM/CRLF 归一化 + fuzzy 兜底；主参数 `path` + `edits[]` 多段不相邻替换（上游风格）；`old_string`/`new_string`/`replace_all` 与顶层 `oldText`/`newText` 仍被接受；回传 diff / patch / 首行变更行号；同文件并发编辑串行化 |
| 输出截断    | 复用     | 直接用 vendor `@earendil-works/pi-agent-core` 已导出的 `truncateHead`/`truncateLine`/`formatSize` 等纯函数（`tools/truncate.ts` 薄封装 + 统一提示文案）                                                     |

| 图片处理管线（`image/`） | 新增 | 移植自 pi coding-agent 的 `utils/image-*.ts`：`processImage()` 是唯一入口；Worker 线程跑 photon（Rust/WASM），失败回退进程内；上游差异与打包细节见 `MIGRATION.md` §14.2.1 / §14.3 |
| `submit_sections` / `submit_section_topics` / `refine_section_titles` | **新增（三阶段蓝图输出工具）** | 分类阶段写骨架 / sync 合并分类；主题阶段按分类增量归并页面（slug 由代码分配）；标题阶段批量写回 title。单 section 失败不阻断（见 §1.2 与 `MIGRATION.md` §17）；`generate_blueprint` / `generate_sync_blueprint` 保留仅归档 |

约束：**不得重命名工具**（提示词与测试依赖名字）；新增/改行为必须补 `bun run test:tools` 断言；
移植上游实现时**逐条保留平台适配分支**（Windows 路径分隔符、macOS 文件名变体、gitignore 语义）。
移植自 `vendor/pi` 或上游 `pi/packages/**` 的文件必须在文件头注明来源（走「复制 + 改写」，不改 vendor）。
**优先直接用 pi 的实现**：能通过 `@earendil-works/pi-agent-core`（根入口或 `./harness/*` 子路径）复用的一律直接 import，
不得再维护本地副本；只有确需适配签名/宿主能力时才保留**薄包装**（如 `tools/file-mutation-queue.ts` 只负责提供
`NodeExecutionEnv` 与 `Context`，排队逻辑仍在 pi 里）。见 MIGRATION.md §13。

### 1.4 外部工具安装与配置界面（第七步：rg / fd）

| 位置                                            | 内容                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/utils/src/tools/registry.ts`        | **工具注册表（扩展点）**：新增工具只需加一条 `ToolSpec`（id / 仓库 / 资产名规则 / 版本探测参数组 / 用途），配置界面、安装器、状态探测、`tools:install` 全部自动跟上                                    |
| `packages/utils/src/tools/installer.ts`       | 状态探测（`resolveToolBinary` / `getToolStatus`）、安装（解析版本 → 下载 → 校验指纹 → 解包 → 落盘 → **可执行性校验**，全程进度回调）、卸载、安装台账、变更广播（`onToolsChanged`）               |
| `packages/utils/src/tools/archive.ts`         | 纯 JS 解包（`.tar.gz` / `.zip`），带 zip-slip 防护（拒绝绝对路径 / `..` 越界）                                                                                 |
| `packages/types` 的 `ToolConfig`/`ToolsConfig` | `config.yaml` 的 `tools.<id>.enabled`（旧配置缺省 `true`，无需迁移）                                                                                     |
| CLI `/config/tools`                           | 列表页（总体就绪进度条 + 每个工具状态）+ 详情页（状态/版本/路径/用途、Enter 安装、d 卸载、t 启用/停用、**安装进度条**：百分比 + 字节数 + 阶段）；列表与详情均为注册表驱动                                         |
| CLI `bun run tools:install`                   | 无头入口：列状态 / 安装（可指定版本）/ 卸载；与配置界面走同一份实现                                                                                                        |
| 环境变量                                          | `ZREAD_PI_TOOLS_DIR`（托管目录，默认 `~/.zread-pi/bin`）、`ZREAD_PI_TOOLS_BASE_URL`（下载镜像，目录结构需与 GitHub Releases 一致）、`ZREAD_PI_<ID>_PATH`（显式指定二进制，测试用） |
| 供应链                                           | 只从固定仓库 HTTPS 下载；ripgrep 发布 `<asset>.sha256` 时先校验指纹再解包（fd 不发布，工具中不引入自签名的伪验证）；安装后必须能执行才算成功，否则删除半成品并报错                                         |

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
bun run typecheck          # tsc --noEmit（apps/cli/src + apps/cli/test + packages/*/src
#                           + apps/browse 的组件测试 tsconfig.test.json）
bun run test               # typecheck + 14 个测试套件（离线，无需 API Key）
bun run test:tui           # CLI(pi-tui) 专项：布局/快捷键 + 真实终端启动 + stdout 接管 + 目标目录参数 + mock LLM 生成/同步
bun run mock:wiki          # 用 mock LLM 对 fixtures/hello-python 跑全链路（产出单个可回放 run）
bun run browse:build       # 预览站静态产物（打包 CLI / 免 Vite 预览；依赖随根 bun install）
bun run cli                # 真机 CLI（需 ~/.zread-pi/config.yaml）
bun run cli --dir <repo>   # 真机 CLI，-d/--dir 指定目标目录（缺省=当前目录）
bun run cli history        # 查看全局记忆：清理已失效项目并列出剩余（-c 指定并发，默认 8）
```

| 命令                 | 覆盖内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 期望                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `test:catalog`     | pi-ai Provider 目录、api_key 登录写 auth.json、多 Provider、自定义模型、未内置 Provider（**`llm.providers.<id>.name` 往返保留 / 列表用配置名 / 缺省回退 id**）、runtime model、思考深度支持列表、**自定义模型 `thinking_level_map` 透传 + pi opt-in 语义（声明 max 则 max 生效 / xhigh 向上钳到 max / 未声明仍是普通推理模型）+ `validateConfig` 三态保留与非法键值过滤**、旧配置补 `agent.max_turns` 默认值（`0` 保留为不限制、负数回退 30）、`blueprint.detail` 缺省 high / 合法值保留 / 非法值回退 high、`llm.context_window` / `llm.max_tokens` 缺省 null / 合法值保留 / 0 与负数回退 null、logout                                                                                                                                                                                                                                                                                                                         | 52/52                                   |
| `test:agent`       | pi 循环、工具执行、钩子、流式事件、429 重试、usage、thinkingLevel 透传、maxTurns、Provider 重试配置透传（`streamOptions`）、`toRetryPolicy`/`toStreamOptions` 纯函数映射（`maxRetries=0` 显式禁用）、`TokenUsage` 归并（`addTokenUsage`/`sumTokenUsage`，缺失缓存字段按 0；`system/init` 带 `context_window`）                                                                                                                                                                                                                                                                                                                       | 20/20                                   |
| `test:tools`       | 工具层专项：截断设施、glob 语义（与 fd `--glob` 对齐）、`Ls`/`Glob`/`Grep`/`Read`/`Write`/`Edit` 行为与错误文案、**rg/fd 与纯 JS 兜底两条路径结果一致**（含 .gitignore 行为）、同文件 16 路并发编辑不丢更新、`details` 与 image 块穿过桥接层进入模型上下文、外部工具启用开关→二进制解析联动、图片处理管线（超大图缩放 + 坐标提示、BMP→PNG、`autoResizeImages=false`、无法解码降级）                                                                                                                                                                                                                                       | 102/102                                 |
| `test:installer`   | 外部工具：注册表与资产名（已对真实 release 列表）、归档解包（tar.gz/zip、stored+deflate、GNU LongName、zip-slip 防护）、配置归一化、安装全流程（本地 mock Releases + 注入探测，含进度阶段 / 百分比单调 / 指纹不匹配拒绝解包 / 校验失败清理）、卸载与启用开关                                                                                                                                                                                                                                                                                                     | 70/70                                   |
| `test:history`     | 全局记忆：ZRH1 二进制结构（头部 / 追加 / 顺序遍历 / 偏移稳定 / 墓碑随机删除 / 去重移到末尾 / 压缩 / maxRecords 淘汰 / 半截尾部修复 / 损坏自愈 / UTF-8 与超长路径）、`ZREAD_PI_HOME` 唯一定义点、`pruneHistory` 并发检查 `.zread-pi` 并删除失效记录、`ensureProjectRecorded` 仅缺录不刷位置、`mapWithConcurrency` 保序；`zread-pi history` 命令（空记忆 / 清理 / 幂等 / `-c` / 损坏文件 / 帮助）；老旧项目自动登记（完整文档补录 / 已在名单不挪位 / 不完整不登记 / **档位变体（wiki/high）完整自动登记** / `--dir` 登记目标目录）                                                                                                                             | 61 + 24 + 11                            |
| `test:context`     | 上下文与首尾机制：harness 内建压缩与 `system/compact_boundary`、溢出→`error_context_full`、**token 预算以 usage 事件/ledger 为权威**（小用量 10 轮不触发、大用量 2 轮即触发）、两段式提示（`before_run` 注入）、`before_run_end` 终止与强制交卷、预算耗尽→`error_budget_exhausted`、`maxTurns` 折算 token 预算 | 45/45                                   |
| `test:agent:http`  | 真实 HTTP/SSE：baseURL + apiKey 注入、增量 tool_call 解析、429 + `Retry-After` 按服务端要求等待后重试、超上限 `Retry-After` 立即失败（错误含 `retry delay`）                                                                                                                                                                                                                                                                                                                                                                      | 12/12                                   |
| `test:provider`    | `createProvider().createMessage()`（browse-chat 路径）                                                                                                                                                                                                                                                                                                                                                                                                                         | 5/5                                     |
| `test:analyzer`    | RepoAnalyzer 扫描 + Tree-sitter 解析（5/5）+ Repo Map 单测（`bun test packages/repo-analyzer/src/repo-map`：构建/优先级/预算/formatter/模块路径，17/17） | 5/5 + 17/17                             |
| `test:blueprint`   | Orchestrator 三阶段蓝图端到端：`generateWikiCatalog()` 分类/主题/标题三阶段落盘 `wiki.json`（骨架即 pages 为空也可加载、slug/file 由代码分配、标题写回）；**蓝图细节档位（`test/blueprint-detail.ts`）：五档规格与提示词注入、常驻数量反馈、越界不落盘 + 2 轮后缩编 subagent 成功 / 失败降级代码兜底（日志含兜底注记）、minimal 单分类单篇 / 同步 merge 上限语义 / 档位目录落盘与遗留兼容 / listWikiVariants 与 resolveWikiVariant**；**scope / summary 逐级注入：字段透传 + 旧数据兼容 + 提示词与工具 schema + 全链路落盘（B9 / A10 / C1 / C2）**；跨 Agent 聚合用量 = 所有请求之和；**逐 Agent 行（每个 Agent 一行）：`agentKey`/`agentRole`/`agentStatus`、`agentUsage`、上下文窗口 200k、失败分类行标 failed**；**`llm.context_window` / `llm.max_tokens` 覆盖下发：`system/init` 上报覆盖后的窗口 + 请求输出上限为覆盖值**；模型不产出 sections / 某分类不调工具必须报错或记 `failedSections`（不阻断其余）；增量同步 diff（updated/archived/new/unchanged、URL 不漂移、无变更不调 LLM、漏报兜底）；目标仓库/全局 `AGENTS.md` 注入系统提示（`<project_context>`，全局在前）+ **文风纪律注入（`<writing_discipline>` 排在 project_context 之后）** + 上下文文件加载纯函数（候选优先级 / BOM / 大小写变体 / 截断 / 格式）+ 文风纪律纯函数（语言选择 / 注入块 / polish 提示词 / 保护性约束 / vendored 行数）；**捕获点端到端（场景 8）：runLog 自动落盘 + 并发归属回归**——不传 runLog 时自动建 run、run.json 记 kind/detail/model、events.jsonl 首尾为 run_start/run_end 且 seq 从 1 单调、agent_start 全部携带**互不相同**的 sessionId（max_concurrent=4 的交错事件流）、用真实捕获事件流跑 replay 断言归属零错误（13 项）                                                                                                                                                                                                                                                                                                                     | 52/52 + 115/115 + 23/23 + 11/11 + 17/17            |
| `test:lock`        | 跨进程文件锁：`withFileLock` 互斥/异常释放/`ELOCKED`、`saveConfig` 并发写后 YAML 完整、**6 个子进程并发写 history 记录不丢**、锁与既有读写语义兼容                                                                                                                                                                                                                                                                                                                                                              | 10/10                                   |
| `test:version-guard` | 版本守卫：版本号三段解析与比较（`parseVersion` / `compareVersions`，无法解析视为最旧）、兼容判定（**来源版本 >= `INCOMPATIBLE_BEFORE` 即兼容，含未来主版本**；早于分界 / 无法解析 → 不兼容）、version 文件读写、备份路径命名（`_bak` / `-2` / `-3`）、`ensureVersionGuard`（首次安装 / 兼容只更新标记 / 无版本文件 → 备份 / 早于分界 → 备份 / 分界之后含未来主版本 → 只更新标记不备份 / **当前版本退化（`0.0.0-dev` / 无法解析）→ `skipped` 跳过，不反复备份**，旧数据完整保留在备份里）**+ 目录被别的进程 chdir 占用 → 抛错且旧数据不动（不降级），释放后重跑成功**；CLI 包装层（stderr 提示含备份路径 / 兼容时无输出且静默更新标记 / 首次静默 / `ZREAD_PI_VERSION_GUARD=0` 跳过 / **不再碰仓库目录**（不写标记、不备份）/ **退化标记只备份一次不循环** / 提示语言随旧配置 / **占用时提示并 `exit(1)`**） | 61/61 + 26/26                           |
| `test:logger`      | 日志总线（对齐 cordis）：记录形状（sn/ts/name/type/level）、printf 全占位符 + Error/cause/AggregateError 展开 + 10240 截断、**`Logger.code` 哈希与 harness 逐字一致（黄金值取自 vendor/cordis 实跑）**、按 exporter/按名级别阈值（含 `ZREAD_PI_LOG_LEVEL` 解析与非法值回退）、多 exporter 广播 + 1000 条环形缓冲淘汰、file exporter 行格式 / 跨天路径 / 保留期清理（含负数禁用）/ needle 兼容、**JSONL exporter（默认开启 / `ZREAD_PI_LOG_JSONL=0` 关闭，字段完整 / printf 同语义 / sn 单调）**、**文本 file-exporter 默认关闭（`ZREAD_PI_LOG_TEXT=1` 开启）与 needle 显式开启**、**递归保护（`tui.stdout` / `tui.console` 不回 console）**、**无参调用与故障 exporter 的异常隔离**、命名 logger 端到端、`getLogFile()` 稳定性、console 渲染（无色 / 16 色 / 256 色 / showDiff / label 宽度）与色彩探测、`Time` 工具 | 116/116                                 |
| `test:pages`       | 并行页面生成：`generateWikiContent()` + `write_page` + Mermaid 校验；页面未落盘（未调用 `write_page` / 写入路径不符 / Mermaid 拦截）必须记失败并发出 `page_error`；预算耗尽后仍无产物同样计页失败（工具熔断 → 强制交卷 → 仍无 `write_page`）；**失败事件带最后一次累计用量**（`page_error.usage`，底部合计的依据）；**页面级 polish（`polish.mode=full`）：真实 Edit 生效、Mermaid 改坏回滚、no-change / Agent 失败都不判页失败、prompt-only 与 enabled=false 的开关语义**；**minimal 档位页面提示词附加「全景导览」段（Mermaid 架构图）**；**topicSummary 注入 / 缺省省略 / 范围纪律（B9 页面提示词）**；**页面事件带上下文报表值（完成 / 失败都带）** | 24/24 + 7/7 + 16/16                     |
| `test:browse`      | 「浏览文档」服务器 + pi-tui 浏览页：静态资源/API 同端口、SPA fallback、未知 API 404、`close()` 后可连性；页面显示真实地址、ESC 停止；源码无产物时进程内 Vite 兜底；无效资源目录报错；**多档共存：`/api/wiki/variants`、`?detail=`（catalog/content/source）、非法值 / 缺失档位 404、遗留回退、变体目录正文解析、仅有变体的目录识别**；**界面语言 `GET /api/i18n`：`zh→zh-CN` / `en→en-US` / 改配置后按请求即时生效**                                                                                                                                                                                                                                                                                                                                                      | 78/82（无 `apps/browse/dist` 时 +4 项 Vite 兜底） + 组件 51 |
| `test:components` | 浏览站**组件级**测试（`bun:test` + `happy-dom` + `@testing-library/react` + jest-dom）：`apps/browse/src/**/__tests__/*.test.tsx`。覆盖渲染与交互契约：sticky turn 表头的「不出现双表头 / 不在滚动容器流内 / 半可见不显示」结构回归、`buildTrajectoryRows` 行模型（折叠 / 过滤 / load-older / 行高）、时间线 sub-pixel span 合并（一千条 span → 1 条色块；duration 空闲压缩合并 / actual 保留空隙分开画）、滚轮缩放（sequence→duration 切换 / duration 进入缩放态且缩放后不塌陷 / 计数器重置）、拖拽选区与点击选中（MINIMUM_DRAG_PX 阈值 / 非左键不启动 / 选区遮罩）、悬停提示、视口钳制（模型边界漂移保留缩放）与模式切换重置、右键清除选区、JsonTree 递归渲染与长字符串换行。基建与写法见 `apps/browse/test/README.md`（happy-dom 布局桩含 getBoundingClientRect / afterEach cleanup / jest-dom 类型桥接 / WheelEvent 不读 init 的 clientX / 原生派发须包 act / RTL 只匹配直接文本子节点等坑）。**行覆盖率：JsonTree 95% / TrajectoryTable 93% / TrajectoryTimeline 97%** | 51/51（3 个文件）                  |
| `test:tui`         | `smoke-tui.ts`（布局/按键/输入框/长列表分页/终端自适应/按键重绘与 Kitty 松开过滤/Provider 详情页 API Key+模型焦点切换/多 Provider/自定义模型/思考深度页/模型上下文输出覆盖页（字段切换 + 留空跟随默认 + d 恢复默认 + 非法输入拦截 + 写回与落盘）/最大轮次页（含 `0` = 不限制写回与落盘）/**文风润色页（开关切换 + prompt-only/full 写回与落盘）**/**蓝图细节档位页（五档切换 + 写回与落盘）**/外部工具页/版本号与项目版本同步 **+ 自定义 Provider 新建全链路（名称/URL/协议步骤 + 空名称与非法 URL 拦截 + `t` 切换协议 + 创建后进入详情页 + 连续添加两个模型 + `e` 编辑预填与改名 + 列表回显）+ id 生成纯函数（slug / 中文 / 回退 / 冲突追加序号）+ 自定义模型的 pi 扩展思考档（开启思考后出现 xhigh/max 开关 + 写入 `thinking_level_map` + 详情页 max 徽标）** 291 项）、`render-all-routes.ts`（全部 23 个路由渲染不报错、无超宽行）、`real-run-check.ts`（真实 ProcessTerminal 启动/退出 9 项）、`output-guard.ts`（stdout 接管：杂散重定向 / 放行窗口 / ESC 透传 / 日志 / 还原 10 项）、`cli-target-dir.ts`（`-d/--dir`：绝对/相对路径、`wiki --dir` 写法、产物落盘到目标目录、调用目录不被写入、缺省行为、无效目录报错 36 项）、`bun test src/views/wiki-generate/__tests__`（事件映射 + 用量合计 + 槽位结转 + 三阶段进度映射 + 逐 Agent 行 + 37 项：失败事件保留快照 / 重试不清零 / 幂等 reduce / 0 分母边界 / 生成中忽略重复触发 / stage+section+分类级进度 / scanning 清空 / plan→running→completed 行状态 / `agentUsage` 不是聚合 / 整体 complete 保留行 / 页面上下文沿用与清零 / `contextUsage` 边界）、`mock-generate.ts`（生成 + 同步全链路 + 全局记忆写入 + **底部用量合计与重试累加** + **三阶段进度文案** + **逐 Agent 行与完成后的四指标**断言 46 项）、`browse-server.ts`（浏览文档服务 + 页面 + 多档变体 API，50 项：无 `apps/browse/dist` 时含 4 项 Vite 兜底） | 291 + 9 + 10 + 36 + 37 + 46 + 50 + 51（组件）             |
| `test:trajectory`  | 轨迹模型层（106 项）：replay 折叠（turn=agent / group 归属 / 请求统一编号 / 失败归属 / partial）、**并发归属（session id：交错事件流不互相吞 / agent_end 不清空别的 Agent 的在途消息 / 旧日志无 sessionId 回退 key）**、**turn 的 sessionId 唯一性**、layout、timeline 四模式投影 + 选区过滤、**session 隐藏后时间线重新投影**、搜索索引（多词交集 / 增量更新）、虚拟化窗口数学 + 稳定 key、格式化函数、**大规模布局回归（10 万 cell：partial 追加不抛错 / 续号 = 最大索引 + 1 / 时间线 span 数与范围 / 显式 lastIndex 向后兼容）**；store 层（47 项）：writer/reader 往返、beforeSeq/afterSeq 分页、损坏行跳过、保留期清理（删最早开始的 run）、残留 running 自愈 interrupted、run.json 写入串行（end 终态不被挂起写覆盖）、withRunLog 自动建 run / 复用 / 失败记 failed、runId 校验与列表排序 | 106/106 + 47/47 + 7/7                    |
| `mock:wiki [path]` | 蓝图 + 页面全链路（mock LLM，请求可数）                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `completed=N failed=0`                  |

> **硬性要求**：任何改动都必须实际运行对应验证并贴出真实输出。
> **不允许**在未运行的情况下声称"测试通过"。
>
> **测试先行（TDD）**：改 `apps/browse` 组件或 `packages/trajectory` 展示层的行为时，
> **先写 / 改测试并确认红灯**，再改实现到绿灯（流程与踩坑清单见
> `apps/browse/test/README.md`）。纯逻辑优先在模型层单测覆盖；只有渲染 / 交互 /
> 布局契约才进组件测试。

---

## 3. 改动类型 → 必须执行的动作

| 改动                                                                                                  | 必做                                                                 | 说明                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 业务层（orchestrator / repo-analyzer / utils / types / browse）                                          | `bun run typecheck` + `bun run test`                               | 若触及 wiki 产物结构，额外跑 `bun run mock:wiki` 并核对 `wiki.json` 与页面文件；repo-analyzer 的行为改动会被 `test:analyzer` 里的 Repo Map 单测覆盖（`bun test …/repo-map`）；**日志相关改动（`packages/utils/src/logger/**` / 命名 logger）另跑 `bun run test:logger`** |
| 配置结构 / Provider 目录（types 的 `LLMConfig`、agent-runtime 的 `pi/*`）                                      | `bun run typecheck` + `bun run test:catalog` + `bun run test`      | 旧 `config.yaml`（仅扁平字段）必须仍可启动；`auth.json` 损坏需自愈                                                                    |
| CLI TUI（`apps/cli/src/**`）                                                                          | `bun run typecheck` + `bun run test:tui`                           | 布局/快捷键/文案改动必须同步 `smoke-tui.ts` 的断言；列表分页行为（窗口/位置指示/PageUp·PageDown·Home·End）也归该套断言覆盖                               |
| 适配层 `packages/agent-runtime/**`                                                                     | `bun run test`（全部套件）+ 新增/更新针对性断言                                   | 契约面改动必须同步 `MIGRATION.md` §3/§4；首尾机制（预算/提示/终止）改动必须补 `test:context` 断言 |
| 蓝图三阶段 / sync 增量修补（`orchestrator/src/prompts/**`、`tools/output-tools.ts`、`orchestrator.ts`、`agents/blueprint-stages.ts`、`wiki/sync-wiki.ts`） | `bun run typecheck` + `bun run test:blueprint` + `bun run test` | 每阶段落盘必须保持 `loadWikiBlueprint` 可加载（骨架 pages 为空合法）；单 section 失败语义与 SyncDiff 语义必须有 e2e 断言；输出工具名不要改（提示词与 mock 依赖） |
| 蓝图细节档位（`orchestrator/src/agents/blueprint-detail.ts`、`tools/output-tools.ts` 数量控制、`prompts/classify.ts`、`prompts/topics.ts`、`views/config-detail/**`、`blueprint.*` 配置） | `bun run typecheck` + `bun run test:blueprint` + `bun run test:pages` + `bun run test`（配置界面改动另跑 `bun run test:tui`） | 五档区间 / 反馈与策略文案 / 越界不落盘 / 缩编与代码兜底必须补 `test:blueprint` 断言；minimal 全景导览传递补 `test:pages`；工具名 `submit_condensed_*` 不要随意改（mock 依赖） |
| 多档共存 / 浏览切换（`utils/file-io.ts`、`utils/output/wiki-content.ts`、`utils/storage/wiki-store.ts`、orchestrator 生成/同步、`apps/cli/src/commands/browse-server.ts`、`apps/browse/src/**`） | `bun run typecheck` + `bun run test:blueprint` + `bun run test:browse` + `bun run test:tui` + `bun run test`（前端改动另跑 `bun run browse:build`） | 路径口径改动必须补 `test:blueprint`（档位落盘 / 遗留兼容 / listWikiVariants）与 `test:browse`（variants API / `?detail=` / 404 / 遗留回退 / 多档并存）断言；`apps/browse` 的**生产构建**不在根 tsconfig（`bun run browse:build` 真实跑 `tsc -b` + Vite）；**组件行为改动必须补 `test:components`（`__tests__/*.test.tsx`，测试先行）** |
| 轨迹视图（`packages/trajectory/**`、`packages/utils/src/trajectory-store/**`、编排层捕获点、`browse-server.ts` 的 `/api/runs*`、`apps/browse/src/features/trajectory/**`） | `bun run typecheck` + `bun run test:trajectory` + `bun run test:browse` + `bun run mock:wiki` + `bun run test`（前端改动另跑 `bun run browse:build`） | 折叠语义（turn=agent / group 归属 / 请求编号 / 失败归属）改动必须补 `test:trajectory`；API 分页语义改动必须补 `test:browse`；**展示层组件（表头 / 时间线 / 检查器）改动必须补 `test:components`（测试先行）**；捕获点改动必须跑 `mock:wiki` 核对 `events.jsonl` 与 `run.json`（单个 run、终态正确）；`packages/trajectory` 必须保持**无 node 依赖**（被 Vite 打包） |
| 工具层 `packages/agent-runtime/src/tools/**`                                                           | `bun run typecheck` + `bun run test:tools` + `bun run test`        | 新增/改工具行为必须补 `test:tools` 断言；工具改名会破坏提示词，**不要改**                                                                    |
| 图片处理管线 `packages/agent-runtime/src/tools/image/**`                                                  | `bun run typecheck` + `bun run test:tools` + `bun run test`        | 上游模块同步时保持文件头来源注释；缩放/转换行为变更必须补 `test:tools` 的 6b 段断言；打包产物需保持 `apps/cli/dist/photon_rs_bg.wasm`（tsup onSuccess 负责）          |
| 文风纪律 / 页面润色（`orchestrator/src/agents/style-discipline.ts`、`src/prompts/humanizer.*.md`、`src/wiki/polish.ts`、`polish.*` 配置） | `bun run typecheck` + `bun run test:blueprint` + `bun run test:pages` + `bun run test`（配置界面改动另跑 `bun run test:tui`） | 两份纪律文件必须同步改动并保持 60~80 行 / 头部来源注释；polish 失败语义（不判页失败 / Mermaid 回滚）必须补 `test:pages` 断言；新增 `.md` 文本导入需确认 `tools/tsup-md-text.ts` 插件与 `md.d.ts`、`apps/cli` / `orchestrator` 两处 tsup 配置同步 |
| 重试策略（`agent-runtime/src/retry.ts`、`harness/driver.ts`、orchestrator 的 `create-agent.ts`）           | `bun run typecheck` + `bun run test:agent` + `bun run test:agent:http` + `bun run test` | `RetryConfig` 形状改动必须同步 `MIGRATION.md` §14.2.3；两层重试的映射/禁用语义必须补 `test:agent`；`Retry-After` 行为必须补 `test:agent:http`          |
| 文件锁 `packages/utils/src/lockfile.ts` 与写入点（config / auth-store / installer / history）             | `bun run typecheck` + `bun run test:lock` + `bun run test`         | 新增写入点必须包 `withFileLock*` 并补 `test:lock` 断言（尤其是并发子进程场景）                                                                    |
| 日志系统 `packages/utils/src/logger/**` 与命名 logger（`orchestrator.*` / `analyzer.*` / `tui.*`）          | `bun run typecheck` + `bun run test:logger` + `bun run test`       | 渲染/哈希/级别语义改动必须保持与 cordis 逐字一致并补 `test:logger` 黄金值断言；新增 logger 名字走点号分层命名（`ZREAD_PI_LOG_LEVEL` 按前缀匹配）；兼容层 `logger.success`/`progress` 的 `[OK]`/`[PROGRESS]` 标记不要删（有外部 grep 依赖） |
| TUI stdout 接管（`apps/cli/src/tui/output-guard.ts` / `guarded-terminal.ts` / `app.ts`）                 | `bun run typecheck` + `bun run test:tui`                           | 接管策略/放行窗口改动必须同步 `output-guard.ts` 断言；`runApp` 只在真实终端路径接管（测试注入终端不受影响）                                                   |
| 外部工具层 `packages/utils/src/tools/**`（注册表 / 安装器 / 归档）                                                 | `bun run typecheck` + `bun run test:installer` + `bun run test`    | 新增工具只需加一条 `ToolSpec` 并补 `test:installer` 断言（含资产名，需对过真实 release 列表）                                                |
| 项目家目录 / 全局记忆（`packages/utils/src/project-home.ts`、`packages/utils/src/history/**`、CLI `history` 命令） | `bun run typecheck` + `bun run test:history` + `bun run test`      | 目录名 / 位置改动只改 `project-home.ts`；history 二进制布局变更必须升 `HISTORY_VERSION` 并补断言与读取兼容（当前只支持 v1）                           |
| 版本守卫（`packages/utils/src/version-guard.ts`、`apps/cli/src/commands/version-guard.ts`、调用点 `app.ts` / `index.ts`） | `bun run typecheck` + `bun run test:version-guard` + `bun run test:tui` + `bun run test` | 兼容判定口径（`INCOMPATIBLE_BEFORE` 分界）或备份命名（`_bak`）改动必须补 `test:version-guard` 断言；**失败语义（抛错 vs 退出 vs 告警）改动也必须补断言**（模拟 chdir 占用）；新增 CLI 调用点必须确认在 TUI 接管终端**之前**执行，且 spawn 型测试已设 `ZREAD_PI_VERSION_GUARD=0`（否则临时家目录会被当成不兼容数据备份掉） |
| pi vendor 源码（`vendor/pi/**/src`）                                                                    | `vendor:src` → 改 → `vendor:dist` → `vendor:build` → `bun run test` | 见 §6.1；**不要手改 `dist/`**                                                                                           |
| 依赖变更                                                                                                | `bun install` 后一并提交 `bun.lock`，并在 commit body 说明原因                 | 不要把 `node_modules` 带进仓库                                                                                           |
| 文档（`*.md`）                                                                                          | 至少 `bun run typecheck`                                             | 若文档描述了命令，需实际执行一遍确认命令可用；命令示例必须跨平台可复制（见 §6.8）                                                                       |
| 新增脚本 / 夹具                                                                                           | 登记到根 `package.json` 的 `scripts`，并在 `README.md` 写明用途                | `tools/` 脚本用相对路径 import 工作区源码；`scripts` 一律用 `bun run xxx.ts` 形式，不写 `rm -rf` / `&&` 链等仅 POSIX 可用的 shell 逻辑（见 §6.8） |

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

# 7) 打 tag 并提交发布说明（§4.5；打 tag / push 由用户手动执行，AI 只起草说明与建议 tag 摘要）
#    tag 名与根 package.json 的 version 一致（v 前缀 + 三段版本号）；注释 tag 带一句话摘要
git tag -a v0.2.0 -m "v0.2.0 —— <一句话摘要>"
#    发布说明落 .github/release-notes/v0.2.0.md，随合并后的 master 一起提交（先于 tag push 入库）
git add .github/release-notes/v0.2.0.md
git commit -m "docs: 添加 v0.2.0 发布说明（Release 正文由 CI 读取）"
git push origin master --follow-tags
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

| 情况           | 处理                                                                   |
| ------------ | -------------------------------------------------------------------- |
| 验证不通过        | 继续在当前分支修，追加提交（不要合并）                                                  |
| 分支方向错了       | 切回 master，`git branch -D <branch>` 丢弃，不污染 master                     |
| 已合并但发现问题     | 在 master 上新建 `fix/...` 分支，用 `git revert <merge-commit>` 或前向修复，禁止改写历史 |
| 合并冲突         | 只解决自己改动涉及的文件；冲突落在无关文件时停下询问，不要强推                                      |
| 用户未合并 / 打回   | 分支保留，继续修或补充说明后再次提请；不得自行合并                                            |
| 版本号冲突（多分支并行） | 以已合并进 master 的版本为基线重新计算，追加一次 `chore(version)` 提交，禁止改写历史              |

### 4.4 版本号管理

**格式：`主版本.次版本.修复版本`**（三段均为非负整数，如 `1.4.2`）。
唯一来源是根 `package.json` 的 `version` 字段（当前 `0.1.0`）；子包均为 `private: true`，不单独发版。

| 触发                      | 版本变化           | 说明                              |
| ----------------------- | -------------- | ------------------------------- |
| 新增功能 / 能力               | 次版本 +1，修复版本归 0 | `feat/*` 分支默认按此处理               |
| 修复 bug                  | 修复版本 +1        | `fix/*` 分支默认按此处理                |
| 文档 / 重构 / 测试 / 依赖等无行为变化 | 修复版本 +1        | 避免版本停滞；用户明确要求时可不动版本             |
| 主版本                     | **由用户定义**      | AI 不得自行变更；用户要求升主版本时，次版本与修复版本归 0 |

执行要求：

- 合并进 `master` 之前，必须在分支上完成版本升级（只改根 `package.json`），建议独立提交：`chore(version): 0.1.0 -> 0.2.0（新增 xxx 能力）`。
- 提请手动合并时，必须报告"当前版本 → 目标版本"与升级依据（feat / fix / 用户指定）；主版本号与是否升版本由用户最终决定。
- 版本号只增不减，禁止回退或复用已用过的版本号。
- 多分支并行发生版本号冲突时，以先合并进 `master` 的版本为基线重新计算并追加提交，不做历史改写。

### 4.5 Tag 与 Release 发布

合并复验通过后，由**用户手动**打 tag 触发发布；AI 负责起草发布说明文件与建议 tag 摘要，并随分支提交入库。

- **tag 名**：`v<主>.<次>.<修>`，必须与根 `package.json` 的 `version` 完全一致；只增不减，禁止复用已删除的版本号。
- **tag 只打在 `master` 上**（即合并复验之后的提交），不在功能分支上打。
- **注释 tag**：消息格式 `vX.Y.Z —— <一句话摘要>`（与 v0.14.0 / v0.15.0 既有风格一致），摘要概括本次版本的核心变更。
- **发布说明**：正文写入 `.github/release-notes/<tag>.md`（人工编写的发布说明），与 tag 摘要随分支提交、随合并后的 `master` 入库。
  CI（`build-binary.yml` 的 `release` job）先 checkout，再用 shell 判断该文件是否存在并写入 step 输出，
  `body_path` 直接引用该输出；同时用同一个输出控制 `generate_release_notes`
  （有说明文件时为 false，正文与文件**逐字一致**；无说明文件时才用自动生成的变更列表）。
  **不要**用 `body_path: ${{ hashFiles(...) != '' && ... || '' }}`：
  表达式回路到空字符串时 GitHub 会把该输入整个过滤掉（等于没传 `body_path`），
  `generate_release_notes` 于是总是生效（v1.4.0 ~ v1.5.1 的 Release 正文因此都是自动生成的 Full Changelog）。
- **CI 机制**：推送 `v*` tag 触发 `.github/workflows/build-binary.yml`，自动构建三平台产物并创建 Release——仓库内存在对应说明文件就用它作正文，否则回落到自动生成的变更列表；因此**说明文件必须先于（或与 tag 同批）推送入库**。
- **职责边界**：AI 不得自行执行 `git tag` / `git push`；提请合并时交付建议的 tag 名、tag 摘要与发布说明文件，实际打 tag 与 push 由用户执行。
- **异常处理**：tag 打错或摘要笔误，仅在 Release 尚未对外使用时删除本地与远端 tag 重建（`git tag -d` + `git push origin :refs/tags/<tag>`）；Release 已发布后禁止改写历史，走前向修复 + 新版本号。

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
- [ ] 发布说明 `.github/release-notes/v<版本>.md` 已随分支提交，tag 摘要已建议（tag 由用户在 master 上手动打，见 §4.5）
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
- `vendor/pi/packages/agent/package.json` 的 `exports` 除上游原有的入口外，额外露出 3 个**内核实现子路径**（仅 manifest 改动，源码零改动）：
  `./harness/tools/edit-diff`、`./harness/tools/image`、`./harness/tools/file-mutation-queue`。
  上游把这三个模块当内部实现（`harness/tools/index.ts` 与根入口都不 re-export，`pi-coding-agent` 里是自己再拷一份）；
  本仓库不引入 `pi-coding-agent`，因此用子路径导出直接消费同一份构建产物（见 MIGRATION.md §13）。
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

- `~/.zread-pi/config.yaml`：非敏感配置。`llm.provider/model` 是当前生效项；`llm.providers.<id>` 保存每个 Provider 的 `name`（自定义 Provider 的显示名，缺省用 id）/ `base_url` / `api` / `auth_type` / 自定义模型 / 上次选择的模型；`llm.thinking_level` 是 pi 思考深度（缺省 `off`，配置界面 `/config/thinking` 维护）；`llm.context_window` / `llm.max_tokens` 是当前模型的上下文窗口/最大输出覆盖（缺省 `null` = 跟随模型目录自带元数据；显式正值会覆盖请求输出上限与上下文压缩阈值，并作为生成页「上下文占比」的分母；配置界面 `/config/model-size` 维护）；`agent.token_budget` 是每次 Agent 运行的 token 预算（0 = 按 `agent.max_turns × 25000` 折算；两者都为 0 = 不限制预算）；`agent.max_turns`（0-100，缺省 30，配置界面 `/config/max-turns` 维护）自第十步起只作为折算依据，内核不再数轮次；`polish.enabled` / `polish.mode`（缺省 `true` / `prompt-only`，配置界面 `/config/polish` 维护）控制文风纪律注入与页面级 polish；`blueprint.detail`（缺省 `high`，配置界面 `/config/detail` 维护）控制蓝图分类数 / 每分类文章数 / 是否精修标题（数量控制四层防线见 §1.1 与 `MIGRATION.md` §18）；`tools.<id>.enabled` 是外部工具（rg / fd）的启用开关（缺省 `true`，配置界面 `/config/tools` 维护，见 §1.4）。旧扁平 `llm.api_key`/`llm.base_url` 仍可读。
- `~/.zread-pi/bin/`：zread-pi 托管安装的外部工具（rg / fd）；探测顺序为「环境变量指定 → 托管目录 → 系统 PATH」，用户停用时直接不用（强制内置纯 JS 实现）。
- `~/.zread-pi/auth.json`：pi-ai 格式凭据（`{ "<providerId>": Credential }`），由 `Models.login()` 写入，可同时保存多个 Provider；配置界面只走 api_key，OAuth 凭据需手动写入（运行时仍会自动刷新）。
- `~/.zread-pi/models-store.json`：动态 Provider 的模型目录缓存。
- `~/.zread-pi/logs/`：日志文本 sink（`zread-pi-<yyyy-MM-dd>.log`，对齐 cordis 日志总线后行格式为 `[本地时间] [级别] 名字 消息`；默认保留 30 天）。日志环境变量：`ZREAD_PI_LOG_LEVEL`（console exporter 的级别阈值，形如 `default=info,orchestrator=debug`，按 logger 名前缀匹配；不设时文件侧仍记录全部级别）；`ZREAD_PI_LOG_CONSOLE=1`（把日志同时打到终端，默认关闭——TUI 期间 console 输出会被 console-guard 转回总线，两者同时开启会往日志文件双写）；`ZREAD_PI_LOG_RETENTION_DAYS`（日志保留天数，默认 30，`<= 0` 不清理）。
- 产物布局（多档共存）：`<目标仓库>/.zread-pi/wiki/<detail>/wiki.json + <detail>/<section>/<file>.md`（每个档位一套完整产物）；遗留的无档位 `wiki/wiki.json` 只读兼容，browse 中显示为「默认」。路径唯一口径是 `getWikiDir(detail?)` / `getWikiJsonPath(detail?)` / `listWikiVariants()`（见 §1.1 与 `MIGRATION.md` §19）。
- `~/.zread-pi/history`：全局记忆（ZRH1 二进制；开始生成文档时写入，`zread-pi history` 清理并展示，见 §1.1）。
- `~/.zread-pi/version`：版本标记（v1.13.0 起，版本守卫用；见 §1.1）。只守卫家目录：来源版本 >= `INCOMPATIBLE_BEFORE`（`1.13.0`）即兼容（只静默更新标记）；早于分界 / 无标记时整个目录被备份为 `<dir>_bak` 后重建，**旧数据完整保留在备份里**。目录被别的进程当作 cwd 导致无法重命名时，守卫会提示并退出进程（不降级）。`ZREAD_PI_VERSION_GUARD=0` 可跳过该检查。仓库目录 `<repo>/.zread-pi` 不再守卫（wiki / runs / cache 均可再生，v1.13.6 起不再写 version 标记）。
- 并发写入：`config.yaml` / `auth.json` / `tools-state.json` / `history` 的「读-改-写」都经 `packages/utils/src/lockfile.ts` 的跨进程文件锁（`<file>.lock`）；config 另做临时文件 + rename 原子替换。锁失败会报写入失败，不静默降级。
- `ZREAD_PI_HOME`：覆盖项目家目录位置（默认 `~/.zread-pi`），测试隔离与同机多套配置用；路径本身只在 `packages/utils/src/project-home.ts` 定义。
- 适配层把这份配置翻译成 pi 的 Provider + Model（内置 Provider 直接用 `builtinProviders()`；未内置的用 `createProvider()` 动态注册；自定义模型按 pi models.json 语义合并）。
- 上下文压缩阈值不在 `config.yaml`，而是由 harness 按 `model.contextWindow` + pi 默认值（`reserveTokens=16384` / `keepRecentTokens=20000`）自动判定；测试可通过 `createAgent({ compaction })` 调参。
- **未登记的 providerId 回退 OpenAI 兼容协议**（旧实现会抛 `Unsupported provider`）——这是有意的健壮性增强。

### 6.7 未完成事项（不要当成已完成）

- **生成页底部合计不含 polish 用量**：`polish.mode=full` 时页面级 polish Agent 的用量记在
  `PageResult.polish.tokenUsage`（只进结果对象与日志，未进入 TUI 事件），因此底部合计只覆盖目录 Agent + 页面 Agent
  （见 `MIGRATION.md` §16.6）。
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
- **会话语义差异**：旧 `saveSession/loadSession/tag/fork` 未迁移；pi 侧是 JSONL 会话树 + SQLite。第十步的 harness 化仍然使用**内存会话**（每次 `query()` 一个，与迁移前语义一致）；需要中断续跑时把 `MemorySessionRepo` 换成 `JsonlSessionRepo` 即可。
- **版本守卫只对「不兼容分界」之前的版本备份旧数据目录**（v1.13.6 起）：只有家目录 `~/.zread-pi` 的来源版本早于 `INCOMPATIBLE_BEFORE`（`1.13.0`）或没有 version 标记时，整个目录才会被改名为 `<dir>_bak` 并重建；**分界之后的所有版本（含未来主版本）都互相兼容，只静默更新 version 标记、不备份**。v1.13.0–1.13.5 的老主版本判定（主版本不同即隔离）已废弃。`_bak` / `_bak-N` 与 `.zread-pi` 同级，**不会被用户仓库的 `.gitignore` 覆盖**（本仓库自己的 `.gitignore` 已加 `.zread-pi_bak/` 规则）。
  - **目录被占用时提示并退出**：若该目录正被别的进程当作 cwd（Windows 拒绝重命名任何进程的工作目录，报 EBUSY/EPERM），备份无法完成，守卫**不降级、不静默**——在 stderr 输出原因与「关闭占用程序后重跑」的指引后 `exit(1)` 退出进程，旧数据保持不动。常见触发：AI 编程环境等常驻进程把数据目录当工作目录。
- **Provider 层重试的等待对 UI 不可见**：`retryProviderRequest` 在单次请求内部退避（可能等待数秒），
  TUI 的 `retry` 事件只在 Agent 层重试时发出（pi coding-agent 相同，见 `MIGRATION.md` §14.5）。
- **图片处理能力依赖 photon WASM**：`bun run cli`（源码）与 tsup 产物（已复制 `photon_rs_bg.wasm`）都可用；
  standalone 二进制需随 `tools/build-binary.ts` 的产物一起分发 wasm，缺失时图片退化为文本说明（不会报错）。
- **时间线的「缩放达到阈值后自动切 actual 模式」未实现**：`MINIMUM_ZOOM_OPERATIONS`
  常量与计数器都在，但只重置计数、不切模式（一次触控板手势就产生远超阈值的 wheel 事件，
  自动切换会在用户第一次缩放时压缩空闲，体感像 bug）。sequence 模式的滚轮切
  duration 已实现（原生非被动监听，缩放不再连带滚动台账）。详见 `MIGRATION.md` §26.10。
- **轨迹视图的大规模真机渲染未做人工实测**：sticky 表头 / 滚轮缩放 / sub-pixel span 合并 /
  流式期间的缩放保留与搜索节流均已按 `MIGRATION.md` §26.10 改过并通过构建与模型回归，
  且渲染 / 交互契约（sticky 表头位置、span 合并、滚轮模式切换）已有**组件级测试**
  兜底（`test:components`，51 项，见 `MIGRATION.md` §26.11 与 `apps/browse/test/README.md`）；
  但真机（上万吨记录、运行中的 run、高分辨率屏）下的帧率与交互仍需人工确认。

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

1. 压缩由 harness 内建承担（threshold + overflow 恢复，见 `packages/agent-runtime/src/harness/driver.ts` 与 `test/context-compaction.ts`）；后续可把压缩阈值（`reserveTokens` / `keepRecentTokens`）与 `agent.token_budget` 一起暴露到配置界面。
2. 用 pi 的 usage ledger + 真实 `Model.cost` 替代旧 `estimateCost`。
3. 需要聊天/会话时接 pi 的 `JsonlStorage` 会话树，而不是回填旧实现。
4. 需要子代理/权限弹窗/计划模式时，走 pi 扩展 API（`registerTool` / `tool_call` 事件阻断）。
5. 工具层可选补强（未决，见 `MIGRATION.md` §9.6）：`Grep` 的 `type` 参数、rg/fd 自动下载、
   以及「先用方案再实现」的 shell 执行能力。（`Read` 图片缩放已由第十二步的图片处理管线完成，见 §1.1 / `MIGRATION.md` §14.2.1）
6. 重试旋钮拆分：目前 `concurrency.max_retries` 同时下发到 Agent 层与 Provider 层（最坏 `N(N+1)` 次请求），
   后续可在配置里拆成两个独立旋钮（见 `MIGRATION.md` §14.5）。

---

## 8. 文档索引

| 文件                                | 内容                                              |
| --------------------------------- | ----------------------------------------------- |
| `README.md`                       | 项目对外说明：功能特性、快速开始、CLI 参考、工作原理、语言/Provider 支持、FAQ |
| `RULES.md`                        | 包结构与逐包修改要点（UI 约束、跨平台摘要）；流程约定仍以本文件为准 |
| `DESIGN.md`                       | Notion 风格设计系统（色值 / 层级 / 终端适配约定），TUI 与浏览站视觉规范来源 |
| `MIGRATION.md`                    | 迁移决策、改动清单、契约冻结点、与旧实现的行为差异、风险与后续路径               |
| `AGENTS.md`                       | 本文件：上下文总结 + 开发 / Git（手动合并）/ 版本号流程（唯一入口约定）       |
| `fixtures/hello-python/README.md` | 夹具说明与三种测试用法                                     |

<!-- gitnexus:start -->

# 
