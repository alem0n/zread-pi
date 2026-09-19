# 移除「快速开始」强制基础分类

> **状态**：方案（待执行）
> **分支**：`refactor/remove-quick-start`
> **版本**：1.18.1 → 1.19.0
> **类型**：行为变更（蓝图骨架结构 + 提示词 + 数量区间 + 一项 Mermaid 判定）

## 1. 背景与动机

### 1.1 现状（已核实）

系统在**所有非 minimal 档位**强制三个基础分类，标题逐字一致、永不动、永不归并：

| 位置 | 内容 |
| --- | --- |
| `packages/utils/src/output/wiki-content.ts:49` `BASE_SECTIONS` | zh / en 各 3 条，含 `快速开始` / `Quick Start` |
| `packages/orchestrator/src/prompts/classify.ts:30` | 「必须包含三个基础分类」+ 第 112 行示例 JSON 含 `快速开始` 条目 |
| `packages/orchestrator/src/agents/blueprint-detail.ts:180,293` `BASE_SECTION_NOTE` | 「概览 / 快速开始 / 核心架构三个基础分类永不动、永不归并」 |
| `packages/orchestrator/src/tools/output-tools.ts:159,189` | `submit_sections` 的 JSDoc + schema description |
| `packages/orchestrator/src/wiki/content-gate.ts:121` `OVERVIEW_SECTIONS` | 含 `快速开始` / `quick start` → **该分类页面强制 Mermaid 图** |

### 1.2 为什么应该删掉

**① 受众错配。** wiki 的目标读者是「准备接手或深入研究该项目源码的开发者」。对这个读者，安装 / 配置 / 运行步骤是 README 里 10 秒就能拿到的东西，不是需要 Agent 读源码综合出来的内容。wiki 的差异化价值在架构、设计意图、模块职责、失败模式——这些不读大量代码出不来。

**② 可信度风险最高的一页。** 工具不执行安装命令，生成的快速开始最容易写出「看起来对、跑不通」的命令与版本号。而溯源机制（`Sources:` 指向源文件）对安装步骤恰恰最无力——安装步骤本来就 self-evident，不是「需要证据的论断」。

**③ 与反注水机制自相矛盾（最关键）。** `content-gate.ts:298` 的 `codeRecommendedFor` 要求代码块来自**关联源文件**（「源没有代码时正确答案是 0」），但快速开始这页天然该写 shell 命令——不是源码派生的；同时它又被 `OVERVIEW_SECTIONS` 强制要求 Mermaid。等于一边逼出一页过程性内容、一边逼它配图、一边要求它放源码代码块。模型只能注水凑，而密度门的存在意义正是抓注水。

**④ 一刀切。** 快速开始只对「产物本身就是装来跑的」仓库（CLI / 库 / 框架）有价值；内部微服务、纯模块库根本没有外部安装故事，强行塞一页只能是 hollow 内容。

### 1.3 决策

**直接删除，不做「按需派生」。** 用户明确要求：不引入「检测可安装面才生成」的条件分支——检测本身是新的不可靠判据，且把简单问题复杂化。基础分类应该是**对任何代码库都成立的骨架**：概览（它是什么）+ 核心架构（它怎么组织）。这两条对所有仓库都成立，快速开始不是。

---

## 2. 影响面清单（全量扫描，`git ls-files` 排除 `node_modules/` 与 `vendor/pi/`）

### 2.1 核心逻辑（4 个文件，7 处）

| # | 文件:行 | 现状 | 处理 |
| --- | --- | --- | --- |
| 1 | `packages/utils/src/output/wiki-content.ts:49–60` | `BASE_SECTIONS.zh` / `.en` 各含 `快速开始` / `Quick Start` | **删除两条**（zh / en 各 1 条） |
| 2 | 同上 `:44` 注释 | 「强制包含的三个基础分类」 | →「两个」 |
| 3 | 同上 `:132` 注释 | 「跳过『快速开始 / 核心架构』强补逻辑」 | →「跳过『核心架构』强补逻辑」 |
| 4 | 同上 `:139` 注释 | 「强制基础分类（概览/快速开始/核心架构）」 | →「（概览/核心架构）」 |
| 5 | `packages/orchestrator/src/prompts/classify.ts:26–31` | 「必须包含三个基础分类」+ 快速开始条目 | →「两个基础分类」，删条目 |
| 6 | 同上 `:112` | 示例 JSON 含 `快速开始` | **删除该条目**（示例 6 → 5 个分类） |
| 7 | `packages/orchestrator/src/agents/blueprint-detail.ts:180,293` | `BASE_SECTION_NOTE` 两处 | →「两个基础分类」 |
| 8 | `packages/orchestrator/src/tools/output-tools.ts:159,189` | JSDoc + schema description | →「概览/核心架构」 |
| 9 | `packages/orchestrator/src/wiki/content-gate.ts:121–122` | `OVERVIEW_SECTIONS` 含 `快速开始` / `quick start` | **删除两行** |

> **已核实无悬空引用**：`classify.ts` 示例里**没有**任何 scope 的「→ 快速开始」指回（第 112 行的快速开始条目自身 scope 指向「→ 周边工具与生态」，删掉它不产生悬空引用）。
>
> **已核实无其它下游依赖**：`verify-wiki.ts` / `sync-wiki.ts` / `page-tools.ts` / `prompts/topics.ts` / `prompts/titles.ts` 均**无**基础分类硬编码。

### 2.2 数量区间联动（关键，易漏）

`submit_sections` 的 `judgeQuantity` 判的是 **`normalizeBlueprintSections` 归一化后的 count**（`output-tools.ts:277–282`，含强补的基础分类）。基础分类从 3 降到 2 后，区间语义必须同步，否则「模型只需再贡献 1 个分类即达标」的旧语义被破坏：

| 档位 | 现 sections 区间 | 新区间 | 理由 |
| --- | --- | --- | --- |
| `minimal` | 1（固定概览） | **不变** | 只保留概览，不涉及 |
| `low` | 3~5 | **2~5** | 基础分类强占 2 个；下限跟随下调，保持「模型可只贡献基础分类」的语义 |
| `medium` | 4~6 | **3~6** | 同上 |
| `high`（默认） | 4~8 | **3~8** | 同上 |
| `max` | 4~8 | **3~8** | 同上 |

**不需要改的**：`judgeQuantity` / `buildSectionQuantityStrategy` / `formatQuantityFeedback` 全部读 `spec.sections`，区间改了反馈文案自动跟随；`MAX_BLUEPRINT_SECTIONS = 8` 不变；`codeFallbackSections` 内部调 `normalizeBlueprintSections`，无硬编码 3。

**文档同步**：`MIGRATION.md:1100` 档位表 `low` 行的「3~5（基础分类已强占 3）」与 medium/high/max 行的区间，须一并改。

### 2.3 下游 Mermaid 判定联动

`content-gate.ts:346` 的失败文案是「本页属于概览/核心架构类（或 minimal 全景导览），必须用 Mermaid 梳理模块关系」——**本身不提快速开始**，删掉 `OVERVIEW_SECTIONS` 两行后文案自然正确，**无需改**。`mermaidRequiredFor` 的 `spec.panorama` 分支不动。

### 2.4 测试夹具（6 个测试文件 + 1 个工具脚本）

mock LLM 的分类清单 / 主题映射里硬编码了 `快速开始`。**必须同步删除对应 section 与其 topics**，否则 mock 产出的分类数 / 页数与断言全部对不上。

> **★ 最关键的连锁点（易漏，会导致整片测试红灯）**：
> `blueprint-detail.ts:46` 的 `OVER_SECTIONS` = 3 基础 + 6 领域 = **9**，正是靠 `9 > max 8` 触发「分类数超出上限」→ 缩编 subagent 整条 C1 链路。
> 删一个基础分类后变成 2 + 6 = **8**，**恰好不再超限**，C1 缩编链路将完全不触发。
> **处理：给 `OVER_SECTIONS` 追加 1 个领域（如 `领域G`）**，保持 2 + 7 = 9 > 8，让「越界」场景继续成立。

| 文件 | 处理（含已核实的具体行） |
| --- | --- |
| `packages/orchestrator/test/blueprint-detail.ts` | ① `:41` `BASE_SECTIONS` 删快速开始；② **`:46` `OVER_SECTIONS` 追加 `领域G`**（保 9 > 8）；③ `:66` `COMPLIANT_SECTIONS` 注释「4 个」→ 3 个；④ `:86` `topicsFor` 的 slug 映射删 `quickstart` 分支；⑤ `:384` 反馈断言 `要求 4~8` → `3~8`；⑥ `:459–461` A5 兜底断言：`fallback[1]` 从「快速开始」改为「核心架构」（fallback 变成 2 基础 + 6 领域 = 8，长度仍 8）；⑦ `:476,480` sync existing 清单删快速开始（8 → 7 条，`syncFallback.length` 跟随改 7）；⑧ `:526` `zhDefault.length === 4` → 3；⑨ `:589` 「当前 9 / 要求 4~8」→「3~8」；⑩ `:596,600,602` 第 2 轮合规计数（2 基础 + 5 领域 = 7）；⑪ `:640,661` B4 sync 计数（既有 2 基础 + 2 领域 = 4，`length === 5` → 4）；⑫ `:865` B9 initWikiSkeleton 入参删快速开始；⑬ `:902` C1 「基础 3 + 缩编 5 = 8」→「基础 2 + 缩编 5 = 7」、`titles.length === 8` → 7；⑭ `:911` 「当前 9 / 要求 4~8」→「3~8」；⑮ `:915` 「8 分类 × 3 = 24」→「7 分类 × 3 = 21」 |
| `packages/orchestrator/test/content-gate.ts` | `:194–199` 删「快速开始页强制 Mermaid」用例 |
| `packages/orchestrator/test/e2e-blueprint.ts` | `:57` `SECTIONS` 删 Quick Start（4 → 3 分类）；`:83` `TOPICS` 删 `"Quick Start"` 键（12 → 9 页）；`:395,397` `pages.length === 12` → 9、`pagesCount === 12` → 9；`:396` `sectionsCount === 4` → 3；`:402` 基础分类清单删 Quick Start；`:452` `progressTotal === 4` → 3；`:469,474` `topicsKeys/titlesKeys.length === 4` → 3；`:500` 「每个分类都跑到」清单删 Quick Start；`:583` partial `pagesCount === 9` → 6（核心模块跳过 → 3 分类 × 3 − 3） |
| `packages/orchestrator/test/e2e-sync.ts` | `:48` `BASE_SECTIONS` 删快速开始；`:69` `GENERATE_TOPICS` 删键；`:272` 「基线生成 12 个页面」→ 9；`:283` modulePages 等计数跟随 |
| `apps/cli/test/cli-target-dir.ts` | `:75` `SECTIONS` 删快速开始；`:87` `TOPICS_BY_SECTION` 删键；`:398,407,416,417` 「12 个页面」→ 9、「文章 12/12」→ 9/9 |
| `apps/cli/test/mock-generate.ts` | `:43` `SECTIONS` 删快速开始；`:70` `TOPICS_BY_SECTION` 删键；`:526` 「12 个页面」→ 9；`:453,454` 「文章 12/12」→ 9/9；**`:175–177,481–506` 用量合计算术**：三阶段 18 请求 + 12 页 × 2 = 42 → 分类 1 + 主题 3 + 标题 3 各 2 次 = 14 + 9 页 × 2 = 18，**共 32 请求**；单次 60 非缓存 + 60 缓存读 + 30 输出 → **输入侧 3840（3.8k）、输出 960（显示 `960`）、缓存占比 50.0%**；重生成 +2 请求 → 输入 4080（4.1k）、输出 1020（1.0k）。注意 `formatBytes` 在 <1000 时不带 k：`960 → "960"`、`1020 → "1.0k"`，断言文案须按此改 |
| `tools/mock-wiki-run.ts` | `:47,50` mock 分类清单删快速开始；`:64` `TOPICS_BY_SECTION` 删键（`expectedPages` 由 reduce 自动重算，无需改）；`:47` 注释「low 档位 3~5 个」→「2~5 个」 |

> **夹具产物**：`fixtures/hello-python/.zread-pi/wiki/**` 未被 git 跟踪（`git ls-files` 确认为空），重跑 `mock:wiki` 自动重生成。**已确认 `apps/browse` 无任何快速开始硬编码**，浏览测试不受影响。

### 2.5 文档（4 个文件）

| 文件 | 处理 |
| --- | --- |
| `README.md` | `:162` 树状图「含概览/快速开始/核心架构」→「含概览/核心架构」；`:188` 「强制包含概览 / 快速开始 / 核心架构」→ 两个；`:62` 的 `## Quick Start` 是**项目自身**的快速开始章节，**保留** |
| `MIGRATION.md` | `:1022` 表格「强制包含概览/快速开始/核心架构」→ 两个；`:1100` 档位表 4 行区间按 §2.2 改；新增 **§34** 记录本次决策 |
| `AGENTS.md` | §1.2 契约冻结点**新增第二十八步**；§2 测试表更新 blueprint / pages / tui 计数；§3 变更类型表**新增一行**；§6.7 更新状态 |
| `packages/trajectory/src/types.ts:124` | 仅 turn 标签的**注释举例**（「页面 · quick-start」）→「页面 · architecture」 |

### 2.6 明确不动的

- **历史发布说明不改**：`.github/release-notes/v0.15.0.md` / `v1.4.0.md` 描述当时行为，属历史记录，保留。
- `vendor/pi/**` 全部命中都是上游 pi 内核，与本仓库无关。
- `AGENTS.md:547` 索引行里的「快速开始」描述的是 `README.md` 对外章节，保留。
- 工具名 / schema 结构 / `write_page` 参数 / 输出路径规范**一律不动**。

---

## 3. 实施步骤

### 步骤 1：核心逻辑（基础分类 + 数量区间）

- `wiki-content.ts`：删 `BASE_SECTIONS` zh/en 快速开始条目；3 处 JSDoc 文案
- `blueprint-detail.ts`：`BLUEPRINT_DETAIL_SPECS` 的 sections 区间按 §2.2 表调整；`BASE_SECTION_NOTE` 两处
- `classify.ts`：`quantitySection` 的 `base` 块改两个分类、删快速开始条目；示例 JSON 删快速开始
- `output-tools.ts`：JSDoc + schema description
- `content-gate.ts`：`OVERVIEW_SECTIONS` 删 2 行

**验证**：`bun run typecheck`

### 步骤 2：测试夹具同步（含 OVER_SECTIONS 补领域）

- 按 §2.4 逐文件改；**先给 `OVER_SECTIONS` 加 `领域G`**，再批量改计数断言
- `mock-generate.ts` 的用量合计算术必须用 §2.4 给出的新值（32 请求 / 3.8k / 960 / 50.0%）

**验证**：`bun run test:blueprint` + `bun run test:pages` + `bun run test:tui`

### 步骤 3：补「删除已生效」的回归断言（防回潮）

`packages/orchestrator/test/blueprint-detail.ts` 新增：
- `normalizeBlueprintSections(任意输入, 'zh')` 结果**不含**快速开始
- `normalizeBlueprintSections(任意输入, 'en')` 结果**不含** Quick Start
- `BASE_SECTIONS` 长度为 2（zh / en 各一断言）
- 档位区间断言更新为 §2.2 新区间（`low` 2~5 等）

`packages/orchestrator/test/content-gate.ts` 新增：
- 「快速开始」section 的页面**不再强制 Mermaid**（`mermaidRequiredFor` 返回 false），而「概览」/「核心架构」仍返回 true

> 这两条把「删除」本身变成被守护的行为，避免日后回潮时没有信号。

**验证**：`bun run test:blueprint` + `bun run test:pages`

### 步骤 4：端到端 + 真机链路

- `bun run mock:wiki`：产物只有概览 / 核心架构两个基础分类，`completed=N failed=0`
- 真机 `zread-pi verify`（对 mock 产物）：结构组仍 PASS

**验证**：`bun run mock:wiki` + `bun run test`

### 步骤 5：全量回归 + 文档

- `bun run typecheck` + `bun run test`（test:tui 的 mock-generate / cli-target-dir 计数已联动）
- 写 `MIGRATION.md` §34；改 `README.md` / `AGENTS.md`；写 `.github/release-notes/v1.19.0.md`

### 步骤 6：版本与提交

- 根 `package.json`：`1.18.1` → `1.19.0`
- 提交：`refactor(orchestrator): 移除「快速开始」强制基础分类`（正文含动机 / 影响 / 验证）
- 独立 `chore(version)` 提交

---

## 4. 行为差异

| 维度 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 非 minimal 基础分类 | 概览 / **快速开始** / 核心架构（3 个） | 概览 / 核心架构（2 个） |
| `low` 分类数区间 | 3~5 | 2~5 |
| `medium` / `high` / `max` 下限 | 4 | 3 |
| 「快速开始」页面的 Mermaid 强制 | 强制 | 该分类已不存在，规则随 `OVERVIEW_SECTIONS` 删除而失效 |
| wiki.json 的 `sections` | 必含 3 个基础分类 | 必含 2 个 |

**旧产物兼容（已核实）**：`loadWikiBlueprint` 只按字段加载，不校验基础分类集合；`syncWiki` merge 模式「既有分类必留」，旧 wiki 里的快速开始分类会被原样保留（只是不再强补）。浏览站多档变体切换不受影响（`apps/browse` 无硬编码）。

---

## 5. 风险与回退

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| `OVER_SECTIONS` 忘了补领域 → C1 缩编链路不触发，`blueprint-detail.ts` 大片红灯 | **高** | §2.4 已置顶标红；步骤 2 先改它再改其余 |
| `mock-generate.ts` 用量合计算术漏改（42 → 32 请求，且 `960` 不带 k） | **中** | §2.4 已给出精确新值 |
| e2e-blueprint / e2e-sync / cli-target-dir 计数漏改 | 中 | §2.4 逐行列出；步骤 2 集中处理 |
| 真机模型仍输出「安装/运行」类内容 | 低 | 无害——变成普通业务分类，不再强制 Mermaid，数量门照常校验区间 |
| 用户下游脚本依赖「必有快速开始分类」 | 低 | 契约冻结点从未声明分类集合固定；发布说明写明 |
| wiki 缺「怎么跑起来」入口 | 中 | **有意为之**：wiki 定位是源码理解而非使用指南 |

**回退**：单一 `git revert` 即可（所有改动在同一分支内，按步骤 1–6 有序提交）。

---

## 6. 完成定义

- [ ] `bun run typecheck` 0 错误
- [ ] `bun run test` 全绿（blueprint / pages / tui 计数断言已同步）
- [ ] 新增「快速开始不再强制」的回归断言（步骤 3）
- [ ] `bun run mock:wiki` 产物只含 2 个基础分类，`failed=0`
- [ ] `MIGRATION.md` §34 + `README.md` + `AGENTS.md`（§1.2 第 28 步 / §2 表 / §3 表 / §6.7）同步
- [ ] `.github/release-notes/v1.19.0.md`
- [ ] 版本 1.18.1 → 1.19.0，独立 `chore(version)` 提交
- [ ] 工作区干净，分支提请手动合并（`--no-ff`）
