# 迁移计划：把 lecture-to-notes 的「输出约束与优化方法论」迁移到 zread-pi

> 来源调查：`C:\Users\user\Desktop\code\lecture-to-notes`（视频讲座 → 中文 LaTeX/PDF + Markdown 笔记的 agent 流水线）
> 迁移目标：`C:\Users\user\Desktop\code\new_read\zread-pi`（代码库 → Wiki 的 agent 流水线，业务层运行在 pi 内核之上）
>
> 本计划只迁移**方法论**（对 AI 输出格式 / 输出形式 / 文法语法的限制与优化手段），
> 不移植任何 shell / python 脚本、不引入 LaTeX / ASR / 视频处理链路。
> 所有迁移项均按 zread-pi 的既有架构（TypeScript 纯函数 + 工具层拦截 + 可选配置字段 + 契约冻结点）重写。

---

## 0. 迁移范围与排除项

### 0.1 迁移的对象

lecture-to-notes 中「对 AI 输出做限制与优化」的机制，可归为三类，逐一对照：

| 类别 | lecture-to-notes 机制 | 本质 |
| --- | --- | --- |
| **格式** | `notes-template.tex`（LaTeX 模具）、`notes-prompt.md`（Markdown 格式法 + 检查清单）、`llm_correct_srt.py` 的 JSON schema | 输出的结构骨架与字段级格式契约 |
| **形式** | 密度门（CJK/图/框/节/公式配额）、五级字幕回退、`teaching_atoms.tsv`、三件套前置工件、三方图注校验、结构重排只改标题 | 内容完整性、覆盖度、可溯源性的**可判定指标** |
| **文法语法** | `reader-first-writing.md`（禁用词表 / 段落单一职责 / 七遍修订）、`verify_notes.py` 的编译日志门、CJK 计数正则、`extract_claims.py` 的数字台账 | 文风纪律 + 机械语法校验 + 事实台账 |

### 0.2 明确排除（zread-pi 无对应物，强行迁移等于引入死代码）

- **ASR / 字幕链路全部排除**：`check_srt_health.py`、`clean_subs.py`、`correct_srt.py`、`llm_correct_srt.py`、`transcribe_*.py`、`ocr_hardsubs.py`、Whisper initial_prompt 术语表 —— zread-pi 的输入是源码 AST，不存在语音转写问题。
- **LaTeX / 编译链路排除**：`notes-template.tex`、`verify_notes.py` 的 `! errors / Missing character / invalid in math mode / Overfull \hbox` 门、`\degC/\um/\nm` 单位宏、`web_notes.py` 的 TeX 沙箱 —— zread-pi 产物是纯 Markdown，无编译步骤。
- **视频帧选择排除**：`frame_filter.py`、contact sheet、bands/layout 测量、`\vtag`/`\srcnote` 时间脚注 —— 无视频。
- **CJK 字数门不照搬**：lecture-to-notes 的 `max(5000, 70×T)` 中文字符门是「讲座时长 → 文字量」的换算；zread-pi 的等价物应是「代码规模 / 页面难度 → 内容量」，需重新设计（见 §3.1），不能移植公式。

### 0.3 已经存在、无需迁移的机制（避免重复建设）

zread-pi 已实现的等价物，迁移时**只做增量、不重写**：

| lecture-to-notes 机制 | zread-pi 已有的等价物 | 结论 |
| --- | --- | --- |
| 五级字幕回退（CC→自动→OCR→ASR→视觉） | 三层 Repo Map（拓扑→签名→按需深挖）+ 14 语言 AST | 已有，不迁移 |
| 三件套前置工件（profile / atoms / claims） | 三阶段蓝图（classify→topics→titles）+ `scope` 边界 + `topicSummary` 锚点 | 已有，不迁移 |
| 密度门之「结构数量」部分 | `blueprint.detail` 五档 + 四层数量防线（提示词目标→常驻反馈→AI 归并→代码兜底） | 已有，且比 lecture-to-notes 更成熟 |
| 结构重排只改标题（diff 自检） | 标题阶段 `refine_section_titles` 只写回 title + sync 的 `computeSyncDiff` slug 不漂移 | 已有，仅补诊断信号（§3.5） |
| 上下文卫生（只读当前节窗口） | 页面 Agent 只读 `associatedFiles` + p-limit 并发隔离 + harness 自动压缩 | 已有，不迁移 |
| 文风纪律（反 AI 腔） | humanizer 两层机制（prompt 预防 + `polish.mode=full` 兜底 + Mermaid 回滚） | 已有，仅补 reader-first 的「教学型写作」部分（§3.4） |
| 禁捷径清单 | 「生成永不悬挂」哲学 + 落盘判定以文件存在为准 | 已有，反注水清单并入（§4） |

---

## 1. 运行流程对照

### 1.1 lecture-to-notes 流程（已调查）

```
视频 URL
 ├─ Phase1 元数据 + 五级字幕回退 + 下载 + 字幕纠错（词表级 → LLM 多模态段级，JSON schema 强制结构）
 ├─ Phase2 15s 抽帧 → bands/layout 测量 → contact sheet 选帧 → 三方校验（帧×字幕×图注）→ figure_manifest.tsv
 ├─ Phase3 profile/atoms/claims 三件套 → reader-first 写作 → notes.tex（从模板填充）
 └─ Phase4 两遍 xelatex → extract_claims check → verify_notes（密度/编译/图/溯源同页）→ OVERALL PASS 才交付
```

### 1.2 zread-pi 流程（现状）

```
目标仓库
 ├─ 扫描（glob + gitignore）→ 解析（tree-sitter AST，符号级 hash 缓存）
 ├─ 蓝图三阶段：classify（1 Agent，产 sections + scope 边界）
 │                 → topics（每 section 1 Agent，产页面 + summary，slug/file 代码分配，数量四层防线）
 │                 → titles（每 section 1 Agent，只改 title）
 ├─ 页面生成：N 个并行 Agent（p-limit）按 associatedFiles 读真实代码
 │            → write_page（YAML frontmatter 注入 + Mermaid 引号校验拦截）
 │            → 落盘兜底（路径救援）→ polish（可选 full 模式，Mermaid 回滚）
 └─ 同步：AST hash diff → 增量修补 → 页面状态由代码机械判定（new/updated/unchanged/archived）
```

### 1.3 流程上的关键差异（决定迁移项的形状）

| 维度 | lecture-to-notes | zread-pi | 对迁移的影响 |
| --- | --- | --- | --- |
| 交付判据 | `OVERALL PASS` 才算完成（强阻断） | 页面文件存在即成功，polish 失败不判页失败（弱阻断） | **内容门必须做成可降级的**，不能照搬"FAIL 就不许交付"，否则破坏既有哲学（§5.1） |
| 事实来源 | 字幕 + OCR（正则抽数字台账） | AST 符号清单（`last_symbols.json` 已有 hash 缓存） | 溯源台账用符号清单实现，比正则抽数字更可靠（§3.3） |
| 数量门基准 | 视频时长 T（分钟） | 页面 level + 关联文件规模 | 密度门基准要重新设计（§3.1） |
| 产物校验 | `pdftotext` 渲染后文本 + 编译日志 | Markdown 静态文本（无需渲染） | 校验全是纯正则/AST，零外部依赖 |
| 结构约束 | `\section` 数 + `本章小结` | section/topics 数 + scope 边界 | 已覆盖，仅补「每页标题层级」与「跨页重复声明」 |

---

## 2. 机制对照与差距分析

| # | lecture-to-notes 机制 | zread-pi 现状 | 差距 | 迁移项 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | CJK/图/框/节/公式密度门（`verify_notes.py::density_gate`） | 只有**结构数量**门（section/topic 篇数），**无内容密度门**：一篇页面是否只有干瘪 TL;DR 完全无度量 | **最大缺口** | §3.1 内容密度门 | **P0** |
| 2 | `verify_notes.py` 一站式交付闸门（density/artifacts/log/figures/provenance → OVERALL PASS/FAIL） | 无任何「交付闸门」命令；判定散在 `generate-wiki` 的 `fileExists` + 路径救援里 | 无统一质量出口 | §3.2 `verify-wiki` 交付闸门 | **P0** |
| 3 | `extract_claims.py` 数字台账（脚本决定源里有哪些数字，逐条 check 笔记） | `Sources:` 溯源强约束已存在；但**路径/行号真实性、跨页重复声明无校验**；`validate_blueprint` 只校验 associatedFiles 存在性且属旧版一次性蓝图工具（三阶段未复用） | 有台账基础、无校验 | §3.3 溯源台账与校验 | **P1** |
| 4 | `notes-prompt.md` 独立格式法 + 11 条最终检查清单 | 页面格式规范**全部内嵌在 `prompts/page-agent.ts` 字符串里**，无独立资产、无逐条自检清单 | 不可复用、不可测 | §3.4 页面格式规范资产化 + 自检清单 | **P1** |
| 5 | `reader-first-writing.md`（段落单一职责 / 证据框架四问 / 章节开合 / 七遍修订） | humanizer 只管「像人写的」（反 AI 腔），**不管「是否教会了读者」** | 教学型写作纪律缺失 | §3.4 reader-first 纪律块 | **P1** |
| 6 | 结构重排诊断信号表（带子层级编号 / 续接词 / 母题重复 / 字数悬殊）+ 正文逐字自检 | 标题阶段只改 title（已很强），但 prompt 无诊断信号，无「改 title 前后正文不变」自检 | 补强 | §3.5 标题精修诊断与自检 | **P2** |
| 7 | 三方校验（帧 × 字幕 × 图注） | 页面论述 × 关联文件 × wiki.json 元数据 三方对齐无校验 | 部分由 §3.3 覆盖 | 并入 §3.3 | P2 |

---

## 3. 迁移项详细设计

### 3.1 【P0】页面内容密度门（content gate）

**目标**：把「这篇页面是不是干瘪的 TL;DR」从主观判断变成机械可判定的指标，像 Mermaid 引号校验一样在 `write_page` 层拦截。

> 移植纪律：判定逻辑从 `verify_notes.py::density_gate` **先复制后兼容**（见 §5.5），阈值不得随手调整。

**落点**：`packages/orchestrator/src/wiki/content-gate.ts`（**纯函数 + 常量表**，对齐 `blueprint-detail.ts` 的组织方式；副作用仍在 `page-tools.ts` / `generate-wiki.ts`）。

**度量指标**（全部纯文本可判定，零外部依赖）：

| 指标 | 计算方式 | 下限（自适应） | 反注水配套 |
| --- | --- | --- | --- |
| `proseChars` | 剥离 frontmatter / 代码块 / Mermaid / `Sources:` 行 / 表格后的可见文本字符数 | `f(level, associatedFiles 规模)`，见下表 | 只统计散文，不统计代码与图注（对齐 lecture-to-notes「不数英文术语和 LaTeX 命令」） |
| `headings` | `^#{1,6} ` 计数 | ≥1 个 `##`；不出现 `#` → `###` 跳级 | — |
| `mermaidBlocks` | Mermaid 围栏计数（`page-tools.ts` 的 `MERMAID_FENCE_RE` 为模块私有常量；内容门**自行计数，不导出 `extractMermaidBlocks`**，避免为复用扩大导出面） | `overview` / `核心架构` 类页面 ≥1；其余 0 合法 | **源没有图就不该硬凑**（§4） |
| `codeBlocks` | `^``` ` 计数（排除 mermaid） | associatedFiles 含 ≥1 个源文件且 level ≠ Beginner 时建议 ≥1；**源里没有可写代码时正确答案是 0** | 同上 |
| `sourceNotes` | `Sources:` 行计数 | ≥1（页面 prompt 已强约束，机械校验兜底） | — |
| `repeatOpenings` | 连续 ≥3 段以同一前缀词开头 | ≤2 | 对齐 reader-first「重复句首」 |

**下限表**（纯函数 + 常量，写在 `content-gate.ts`，对齐 `BLUEPRINT_DETAIL_SPECS` 的形状）：

```ts
// 伪代码：仅示意形状，具体数值在实现时按 fixtures/hello-python 与真实仓库标定。
//
// 【审查修订】分键轴修正：难度等级（level）与「是否需要架构图」正交，
// mermaidRequired 不能挂在 level 表上。它的真实判定键是 section 角色
// （classify 强制的基础分类「概览 / 快速开始 / 核心架构」，英文为 Overview）
// 或 minimal 档的 panorama 要求。因此内容门签名接收 (page, detailSpec)：
//   evaluateContentGate(page: WikiPage, spec: BlueprintDetailSpec): ContentGateReport
interface ContentGateSpec {
  level: WikiLevel;
  /** 散文字符下限 = base + perFile × min(关联文件数, cap) */
  proseBase: number;      // Beginner 1200 / Intermediate 1800 / Advanced 2400
  prosePerFile: number;   // 每个关联文件追加（上限 8 个文件）
  proseCap: number;       // 单页上限，避免无限追加
  codeRecommended: boolean;
}

/** 是否强制要求 Mermaid 图：由 section 角色与档位派生，不进 level 表 */
function mermaidRequiredFor(page: WikiPage, spec: BlueprintDetailSpec): boolean {
  const OVERVIEW_SECTIONS = new Set(['概览', 'overview', '快速开始', '核心架构', 'core architecture']);
  return spec.panorama || OVERVIEW_SECTIONS.has(page.section.trim().toLowerCase());
}
```

**拦截点（复用现有 Mermaid 拦截的同一模式）**：
`packages/orchestrator/src/tools/page-tools.ts` 的 `write_page.call` —— Mermaid 校验**之后**追加内容门校验，`mode=enforce` 时返回同样的 `{ is_error: true }` 结构，错误文案带「当前 N / 下限 M」的常驻反馈（对齐 `formatQuantityFeedback` 的风格），让模型重写。校验对象与 Mermaid 一致取 `fullContent`（frontmatter 已拼接之后），故 `proseChars` 的「剥离 frontmatter」指标在工具内部成立。

**降级链（适配 zread-pi「生成永不悬挂」哲学，见 §5.1）**：

> 【审查修订】纯 `is_error` 拦截在当前架构下**没有降级出口**：`write_page` 返回 `is_error` 时，`generate-wiki.ts` 的包装层只置 `lastWriteError`、`wrotePage` 保持 `false`；模型若始终过不了门，输出文件永不落盘 → 该页被判 FAIL。必须显式补上 best-effort 落盘机制，下面的降级链才成立。

```
enforce 拦截（第 1..K 次）→ write_page 返回 is_error + 「当前 N / 下限 M」反馈，模型在 token 预算内重写
   → 重写通过 → 正常落盘
   → 预算用尽仍未通过（harness 强制交卷 / error_budget_exhausted）
        → generate-wiki 失败分支读取最近一次被拦截的内容（实现见下）
        → best-effort 落盘到约定路径，标 gate.passed = false、gate.mode = 'enforce-degraded'
        → 记为「成功 + 质量告警」，不判页失败
warn 模式 → 只记录与上屏，不拦截
off   → 完全跳过（mode 缺省 warn，保证老用户行为零变化）
```

**实现要点**（复用 `generate-wiki.ts` 已有的 `writePageTool` 包装层，不新增工具、不改工具名/schema）：
- 扩展 `PageWriteAttempt`：增加 `content?`（被拦截的正文）与 `gateError?` 两个字段
- 包装层在 `toolResult.is_error` 时缓存这两个字段（与已有 `summarizeWriteError` / `extractWrittenPath` 同类逻辑）
- 页面失败分支（`!(await fileExists(outputFile))` 且 `wrotePage === false` 且 `lastWriteError` 属内容门错误）时：取最近一次缓存的 `content`，末尾追加一行 `<!-- gate: <失败明细> -->` 注释后写入 `outputFile`，`PageResult.gate` 记 `mode: 'enforce-degraded'`，页面计为成功并上屏告警
- 无缓存内容（模型从未调用 write_page）时仍走原失败路径 —— 该情形属模型未产出，不是门判死

**配置字段**（新增可选 + 缺省，对齐 §1.2 契约中 `polish` 的形状）：

```ts
// packages/types/src/config.ts —— 新增
export interface QualityConfig {
  contentGate: {
    enabled: boolean;                    // 缺省 true
    mode: 'off' | 'warn' | 'enforce';    // 缺省 'warn'（安全可启动、不阻断）
  };
  /** 生成完成后是否自动跑一次 verify-wiki（缺省 false，避免拖慢生成） */
  verifyAfterGenerate: boolean;
}

AppConfig.quality?: QualityConfig;   // 可选字段；旧 config.yaml 缺省时由 normalizer 补全
```

> 【审查修订】必须同步 normalizer 层，否则旧配置无法安全启动、配置界面无法持久化校验（对齐 `normalizePolishConfig` 的既有模式，见 `packages/utils/src/config/index.ts:109-128 / 228-229 / 450-452`）：
- 新增 `normalizeQualityConfig(value: unknown): QualityConfig` + 常量 `DEFAULT_QUALITY_ENABLED = true` / `DEFAULT_QUALITY_MODE = 'warn'` / `DEFAULT_VERIFY_AFTER_GENERATE = false`
- **两处接线**：默认配置工厂（`polish: normalizePolishConfig(undefined)` 同位置补 `quality: normalizeQualityConfig(undefined)`）与 `loadConfig` 合并（`:450` 附近补 `quality: normalizeQualityConfig(config.quality)`）
- 未提供时 `enabled` 缺省 true 但 `mode` 缺省 `warn` —— 「老用户升级行为零变化」由 normalizer 保证，而非靠调用处可选链

**结果类型**（新增可选字段，不破坏 `PageResult`，定义在 `packages/orchestrator/src/wiki/types.ts`）：

```ts
PageResult.gate?: ContentGateReport;  // { passed, metrics, failures[], mode: 'warn'|'enforce'|'enforce-degraded', durationMs }
```

---

### 3.2 【P0】交付闸门 `verify-wiki`

**目标**：对齐 `verify_notes.py` 的「一条命令判定本次生成是否达标」，给 zread-pi 一个统一质量出口。

> 移植纪律：PASS/FAIL/SKIP + `OVERALL` 的检查组结构与逐行判定风格，从 `verify_notes.py` **先复制后兼容**（见 §5.5）。

**落点**：
- 纯逻辑：`packages/orchestrator/src/wiki/verify-wiki.ts`
- CLI 子命令：`apps/cli/src/commands/verify.ts`（`zread-pi verify [-d <dir>] [--detail <档位>] [--enforce]`）
  - `-d/--dir` 是根 program 上的全局选项（`apps/cli/src/index.ts:26`），子命令经 `applyTargetDir()` chdir，照抄既有命令注册模式即可，无需重复声明

**变体解析（含遗留目录）**：

> 【审查修订】`resolveWikiVariant`（`packages/utils/src/file-io.ts:152`）只枚举档位子目录，**不返回无档位的遗留 `.zread-pi/wiki/`**；且 `loadWikiBlueprint(path, variant)` 的 `variant` 为必填、`getWikiDir(detail)` 不接受 null。因此 verify-wiki 必须自带遗留分支：

1. 先 `resolveWikiVariant(detail)` 解析档位；命中则以 `loadWikiBlueprint(undefined, variant)` 加载
2. 返回 `undefined` 时**显式 fallback** 读遗留目录 `<root>/.zread-pi/wiki/wiki.json`，并以显式 path 调 `loadWikiBlueprint(legacyPath, <任一合法 variant>)`（path 优先于 variant 默认值，绕开必填约束）
3. 遗留目录也不存在 → 整体 SKIP、退出码 0（无产物可验，不报 FAIL）

**检查项**（逐条 PASS/FAIL/SKIP，末尾 `OVERALL PASS/FAIL` + 退出码，结构对齐 `verify_notes.py`）：

| 检查组 | 内容 |
| --- | --- |
| `structure` | `wiki.json` 可加载（复用 `loadWikiBlueprint`）；pages 非空；每页 `file` 真实存在；slug/file 不漂移；sections 与 pages 的 section 集合一致 |
| `content` | 逐页跑 §3.1 内容门（--enforce 时 FAIL 算整体 FAIL，否则只列出） |
| `mermaid` | 复用 `validateMermaidContent`（已有导出） |
| `traceability` | §3.3 溯源校验：`Sources:` 路径真实、行号区间落在文件长度内、跨页重复声明检测 |
| `frontmatter` | 每页含 `title:` / `slug:`，且与 wiki.json 一致 |

**集成点**：
- `generateWikiContent` 完成后**可选**自动跑一次（`quality.verifyAfterGenerate`，缺省 false，避免拖慢生成）
- 【审查修订】验证摘要**不写 `run.json`**——`RunMeta`（`packages/types/src/run-meta.ts:23`）是固定字段结构（`id/startedAt/status/kind/detail/model/provider/targetDir/agents/pages/usage/durationMs/error/events/lastSeq`），无挂载位置；改 `RunMeta` 属 run.json 契约变更。改为落成独立文件 `<runDir>/verify.json`（runId 目录由现有轨迹设施解析），trajectory replay 无感知。若后续需在轨迹页展示，再升 `RunMeta` 并同步 AGENTS §1.2 / MIGRATION
- `mock:wiki` 产物核对：`bun run mock:wiki` 后跑 `zread-pi verify`，**只断言结构类检查**（structure / mermaid / frontmatter / traceability）全绿；content 组以 warn 报告形式产出即可（mock LLM + 极小夹具的产物不可能过内容密度门，见 §6）

---

### 3.3 【P1】溯源台账与校验（claims ledger 的代码版）

**目标**：对齐 `extract_claims.py`「脚本决定源里有什么，不由模型决定」——页面声称的路径/符号/行号必须真实存在于代码中。

> 移植纪律：台账抽取正则与「提取 → 逐条 check」的两段式结构，从 `extract_claims.py` **先复制后兼容**（见 §5.5）；`flatten_tex` 的宏剥离思路尤其值得照搬（把 LaTeX 宏换成 Markdown 剥离即可）。

**落点**：`packages/orchestrator/src/wiki/traceability.ts`（纯函数）

**输入**（复用现有缓存，零额外解析成本）：
- `.zread-pi/cache/last_manifest.json`（文件扫描结果，已有）
- `.zread-pi/cache/last_symbols.json`（AST-hash 符号缓存，已有）

**校验内容**：

| 项 | 实现 | 失败语义 |
| --- | --- | --- |
| 路径真实 | 页面内所有 `](path)` 与 `](path#Lx-Ly)` 的 path 落在 manifest 内（对齐 `validate_blueprint` 的存在性判定，但作用于**页面正文**而非蓝图） | FAIL + 具体行 |
| 行号有效 | `#Lx-Ly` 的 x ≤ y ≤ 文件行数。【审查修订】`CacheManifest` 只有 `{path, hash, size}`（`packages/types/src/cache.ts`，**无行数字段**），故必须读文件：只对 `Sources:` 引用到的文件做**流式按行计数**（不全量缓冲），顺带用已有的 `size` 做字节级 sanity check | FAIL |
| 符号可溯 | 页面正文里出现的「文件 + 符号名」组合（如 `createAgent` @ `packages/agent-runtime/src/agent.ts`）在 symbols 缓存里存在 | WARN（符号名可能是合法的自由文本，不强 FAIL） |
| 跨页重复声明 | 同一文件 + 同一行号区间被 ≥2 个页面声明为证据 | WARN（列出页面对，供人工裁决） |

**复活 `validate_blueprint`**：将其存在性校验逻辑迁移到三阶段流程（当前属旧版一次性蓝图工具，三阶段未使用），由 `verify-wiki` 在页面维度执行；旧工具保留仅归档（与 `generate_blueprint` 同策略）。

---

### 3.4 【P1】页面格式规范资产化 + reader-first 纪律

#### 3.4.1 页面格式规范资产（对齐 `notes-prompt.md` 的独立资产形态）

**落点**：
- `packages/orchestrator/src/prompts/page-format.zh.md`
- `packages/orchestrator/src/prompts/page-format.en.md`
- `packages/orchestrator/src/agents/page-format.ts`（加载器，对齐 `style-discipline.ts` 的形状）

> 移植纪律：中文版从 `notes-prompt.md` **先复制后兼容**、英文版为同等翻译（见 §5.5）；两份同步改动，清单条数与编号一一对应。

**内容**：从 `prompts/page-agent.ts` 中抽出**与叙述语气无关的硬性格式契约**：
- YAML frontmatter 由 `write_page` 注入，模型不得手写
- 输出路径规范（现已在 `buildPagePrompt` 末尾，保留）
- Mermaid 引号规则（现已在 prompt，保留）
- `Sources:` 溯源格式（现已在 prompt，保留）
- 标题层级规则（不跳级、不重复 H1、源码导航节标题固定）
- **新增：交付前自检清单**（对齐 lecture-to-notes 的 11 条清单）：
  1. 每个二级标题下有实质散文，不是标题列表
  2. 每个关键论断后有 `Sources:` 行
  3. Mermaid 标签全部加引号
  4. 引用的文件路径真实存在
  5. 代码片段来自关联文件，不是凭空编写
  6. 无凭空发明的接口 / 行为 / 版本号
  7. 无聊天机器人残留 / 营销长句 / 装饰性加粗
  8. 章节以具体事实收尾，不以「未来可期」收尾

**提示词改动**：`page-agent.ts` 的格式段改为引用资产（`withPageFormat(language)`，对齐 `withStyleDiscipline` 的拼装点），**保留现有全部语气与结构要求**，只做文本外置。

#### 3.4.2 reader-first 教学型写作纪律（对齐 `reader-first-writing.md`）

**与 humanizer 的分工**（重要决策，见 §5.2）：
- humanizer = 「像人写的」（反 AI 腔）—— 已有，保持 60~80 行 + 头部来源注释 + zh/en 同步
- reader-first = 「教会了读者」—— **新增独立纪律块**，拼装点在 humanizer 之后

**落点**：
- `packages/orchestrator/src/prompts/reader-first.zh.md` / `.en.md`
- `packages/orchestrator/src/agents/reader-first.ts`（`withReaderDiscipline()`，拼进页面 Agent 与 polish Agent 的系统提示）

**从 lecture-to-notes 移植并改写为「代码 wiki」语境的条目**（下表每行都是「先复制 `reader-first-writing.md` 原条目 → 再做语境兼容」的结果，见 §5.5；原条目的措辞与编号必须保留）：

| lecture-to-news 原条目 | 改写为代码 wiki 版 |
| --- | --- |
| 保护源（不把预测写成事实 / 不把轶事写成普遍证据） | 不把实现细节写成设计意图；不确定的版本行为标「以当前代码为准」 |
| 读者论证地图（中心问题 / 前置依赖 / 证据边界） | 页面开头回答「读完后能解释什么」，依赖的先验概念在开头补齐 |
| 段落单一职责（四类动作不硬塞） | 同条移植 |
| 证据框架四问（测了什么 / 和什么比 / 什么工况 / 为何重要） | 改为「接口签名 / 调用方 / 触发条件 / 边界与失败模式」 |
| 章节开合（`本章小结` 回答节问题、不复读） | 每节以「读者现在能做什么 / 下一步看哪页」收尾，不罗列本节小标题 |
| 禁用词表（「值得注意的是」「不是……而是……」「全面/系统/显著」） | 与 humanizer 的 25 条模式去重后保留差异部分 |
| ~90 字长句复审信号 | 移植为复审信号（非禁止） |
| 七遍修订 | 单 Agent 内不现实 → 改为 polish Agent 的单遍结构化自检（§3.4.3） |

#### 3.4.3 polish 层扩展

`wiki/polish.ts` 的 polish Agent 系统提示（`buildPolishSystemPrompt`）在纪律全文后追加 reader-first 自检清单，使 `polish.mode=full` 时做一次「教学型」结构化检查；Mermaid 回滚保护扩展为「Mermaid + `Sources:` 行 + frontmatter」三项复检（前两项已在保护清单内，补**回滚后的 diff 断言**：只许改散文，路径/行号/溯源行字节数不变）。

---

### 3.5 【P2】标题精修诊断信号与只改标题自检

**目标**：把 lecture-to-notes `structure-reorder.md` 的诊断信号表移植到 `refine_section_titles`。

**落点**：`packages/orchestrator/src/prompts/titles.ts`（追加诊断段）+ `packages/orchestrator/src/tools/output-tools.ts`（`refine_section_titles` 内追加自检）。

**prompt 追加的诊断信号**（对齐 structure-reorder 的 7 条）：
- 标题带子层级编号（「2.3 注意力」→ 实为二级）
- 标题带续接词（「（续）」「再谈」）
- 同分类相邻标题同属一个母题
- 标题字数悬殊（最短不足最长 1/5）
- 标题是具体技术点而非主题块
- 同一母题词在多个标题反复出现
- 命名风格不统一

**工具侧自检**（对齐 structure-reorder 的两级自检）：

> 【审查修订】原设想的「校验除 title 外其他字段字节不变」是**伪检查**：`applySectionTitles`（`packages/utils/src/output/wiki-content.ts:550`）实现里只赋值 `page.title`，其余字段（slug / file / section / group / level / associatedFiles）**结构性不可能被改动**；且 `refine_section_titles` 工具入参只有 `{slug, title}[]`，拿不到前后页面对象，工具侧无法比对。字段不可变性写成实现注释即可。

真正有价值的两项机械检查：
- **数量一致性**：`applySectionTitles` 已返回 `updated / skipped / unknown`，补断言——`unknown > 0`（slug 不属于本分类）或 `updated + skipped ≠ 该分类页面数`（模型漏页）→ 返回 is_error + 具体差异，不落盘
- **重写率统计**：诊断信号触发后标题被改写的比例（mock 前后对比），用于验证诊断段是否起作用

---

## 4. 反注水设计（从 lecture-to-notes 带过来的核心，必须与密度门同步落地）

lecture-to-notes 最精巧的设计是「门限是下限不是目标」。迁移到 zread-pi 时，以下规则必须写进 prompt、代码注释与文档，**与 §3.1 同一 PR 落地**：

1. **gate ≠ target**：密度下限不是质量目标。文档明确「达标不等于写得好」，不在 TUI 上把「超出下限 X%」当成 KPI 展示。
2. **源没有就应该是 0**：
   - 关联文件里没有可写代码（纯配置 / 纯类型声明）时，代码块数正确答案是 0，强行加代码块 = FAIL；
   - 页面不涉及拓扑关系时，Mermaid 数正确答案是 0（`minimal` 档位的 panorama 是唯一强制作图例外）。
3. **禁止清单**（写进 `page-format.*.md` 的自检清单）：
   - 同义改写注水（同一论断换词重复）
   - 口号式收尾（「未来可期」「至关重要」）
   - 为凑图表而加图 / 为凑字数而堆术语表
   - 把 README 或 AGENTS.md 整段复制当散文（有 `<project_context>` 注入机制，不需要复制）
4. **门限自适应源规模**：下限随 `associatedFiles` 数量与 `level` 变化，不搞一刀切（避免小页面被迫注水、大页面轻松达标）。
5. **失败可降级、永不悬挂**：内容门不达标时，降级链见 §3.1；绝不出现「页面已生成但被门判死」导致用户拿不到产物的情况（这是与 lecture-to-notes `OVERALL FAIL 不许交付` 的**有意偏差**，理由见 §5.1）。

---

## 5. 与 zread-pi 既有哲学的适配决策（不能照搬的地方）

### 5.1 阻断 vs 降级：内容门默认 `warn`，不默认 `enforce`

- lecture-to-notes 是「人工交付物」——`OVERALL FAIL` 就不许说 done，因为下一步就是人工阅读 PDF。
- zread-pi 已确立「页面文件存在即成功，polish 失败不判页失败」「单页失败不阻断其余」「生成永不悬挂（四层数量防线 + 代码兜底）」。
- **决策**：内容门默认 `warn`（记录 + TUI 可见 + 写进 `PageResult.gate` + `run.json`），`enforce` 由用户在配置界面显式开启。`verify-wiki` 默认也只报告不阻断，`--enforce` 才以非零退出码失败。这保证老用户升级后行为零变化（缺省值哲学对齐 §1.2 的 `polish` 与 `blueprint.detail`）。

### 5.2 humanizer 与 reader-first 分立，不合并

- humanizer 有硬性约束：「两份纪律文件必须同步改动并保持 60~80 行 / 头部来源注释」（AGENTS.md §3）。lecture-to-notes 的 reader-first 篇幅远超 80 行。
- **决策**：reader-first 独立成两份资产文件（不受 60~80 行限制，因为不替换 humanizer、不引用外部 skill 版本号），通过新的 `withReaderDiscipline()` 拼装；humanizer 一字不动。

### 5.3 不引入「三件套前置工件」的额外文件

- lecture-to-notes 要求 `lecture_profile.json` / `teaching_atoms.tsv` / `numerical_claims.tsv` 三个工作区文件。
- zread-pi 的等价信息已全部在 `wiki.json` 内（sections + scope + pages + topicSummary + associatedFiles），且是**契约冻结点**。
- **决策**：不新增工作区工件文件；内容门报告挂在 `PageResult.gate` 与 `run.json`（复用现有轨迹设施），溯源校验读现有 `cache/last_symbols.json`。

### 5.4 工具名与契约冻结点

- `write_page` 不得改名（AGENTS.md §1.2 / §3 明令）；内容门只在 `write_page.call` 内部加校验，**不改工具名、不改 schema**（`content` 参数已存在，校验在其内部做）。
- 新增导出全部走「新增可选」路径：`AppConfig.quality?`、`PageResult.gate?`、`ContentGateReport`、`withReaderDiscipline` 等，旧配置与旧 wiki.json 必须仍可启动 / 仍可加载。
- `.md` 文本导入（§3.4）必须同步：`tools/tsup-md-text.ts` 插件 + `prompts/md.d.ts` + `apps/cli` / `orchestrator` 两处 tsup 配置（AGENTS.md §3 明令）。
- 【审查修订】配置层必须补 normalizer：`normalizeQualityConfig` + `DEFAULT_QUALITY_*` 常量 + `packages/utils/src/config/index.ts` 两处接线（默认配置工厂与 `loadConfig` 合并）。缺这层，旧 config.yaml 启动时 `quality` 为 `undefined`、配置界面无法持久化校验（对齐 `normalizePolishConfig` 既有模式）。
- 【审查修订】验证摘要**不入 `RunMeta`**（run.json 固定字段结构，改动属契约变更）——落 `<runDir>/verify.json` 独立文件。`PageResult.gate?` / `ContentGateReport` / `QualityConfig` / `withReaderDiscipline` / verify-wiki 导出全部走「新增可选」路径。

---

### 5.5 移植纪律：先复制文件，后兼容改写（保证与源项目高度一致）

> 【用户新增约束】本节是贯穿全计划的**强制过程约束**：本计划涉及到的所有提示词与代码，一律走「**先逐字复制源文件 → 再做兼容性改写**」，禁止凭记忆或理解重写。

**为什么**：lecture-to-notes 的约束措辞（如「gate ≠ target」「源没有就应该是 0」）与判定逻辑（门限算式、正则、降级分支）是源项目反复验证过的产物。凭记忆重写会无声地丢失这些细节——**迁移的是已验证的约束本身，不是对约束的印象**。

**依据 zread-pi 既有约定**（本纪律不是新发明，是对既有惯例的沿用与明确化）：
- AGENTS.md §1.3：「移植自 `vendor/pi` 或上游 `pi/packages/**` 的文件必须在文件头注明来源（走「复制 + 改写」，不改 vendor）」「移植上游实现时**逐条保留**适配分支」
- `prompts/humanizer.zh.md` 文件头是既有范例：注明来源、精炼方式（保留什么 / 去掉什么 / 补充什么）、同步对象（「仅与 en 版本、MIGRATION.md §15 一起改动」）

**两类对象的具体做法**：

| 对象 | 源文件（先逐字复制） | 先复制 | 后兼容（只允许改这些） |
| --- | --- | --- | --- |
| 提示词资产 | `lecture-to-notes/skills/lecture-to-notes/references/reader-first-writing.md`（**英文**）<br>`lecture-to-notes/skills/lecture-to-md/lecture-to-md/assets/notes-prompt.md`（**中文**） | 整篇复制到 `prompts/reader-first.en.md` / `prompts/page-format.zh.md` | 语境词替换（讲座→代码库、字幕/视频帧→AST 符号与关联文件、`\section`→Markdown 标题）；删不适条目；补 zread-pi 保护性约束。**保留原文措辞、规则编号、清单顺序** |
| 代码参考实现 | `scripts/verify_notes.py`（`density_gate` / `log_gate` / `figure_gate`）<br>`scripts/extract_claims.py`（`CLAIM_RE` / `flatten_tex` / `claim_in_notes`）<br>`scripts/verify_figures.py`（交叉引用模式） | 复制判定逻辑与正则到 TS 纯函数 | 翻译为 TS；改输入源（SRT/OCR→Markdown 与 AST 符号缓存）；改阻断语义（强阻断→warn/enforce 可降级，§5.1）。**判定语义与阈值不得顺手「优化」** |

**语言资产配对**（源文件语言决定复制方向，两份必须同步）：
- `reader-first-writing.md` 是英文 → `reader-first.en.md` **近乎逐字复制**（仅语境适配），`reader-first.zh.md` 为其翻译 + 同等适配
- `notes-prompt.md` 是中文 → `page-format.zh.md` 复制格式法段，`page-format.en.md` 为其翻译 + 同等适配
- 同步约束照 humanizer 既有写法：「仅与对应语言版本、MIGRATION.md §29 一起改动」

**文件头溯源注释（每个新建文件强制，对齐 humanizer 头部风格）**：

```ts
/**
 * 内容密度门 —— 从 lecture-to-notes 移植（源：scripts/verify_notes.py::density_gate / log_gate）。
 * 复制后做 TS 兼容改写：CJK 正则 → 通用可见文本计数；时长基准 → level + 关联文件规模；
 * 强阻断 → warn/enforce 可降级（§5.1）。判定语义保持一致，有意偏差见 MIGRATION §29。
 * 仅与 wiki/verify-wiki.ts、MIGRATION §29 一起改动。
 */
```

**一致性校验（落进 §6 测试，强制）**：
- 提示词资产：复制后用 diff 核对「保留段落」逐字一致（只允许语境词替换）；翻译版按原文逐条对账，清单**条数与编号必须一一对应**
- 代码：门限算式与正则用**同一输入**在 Python 参考实现与 TS 实现上跑黄金值对照，判定结果必须一致
- 任一「保留段落」被改动、或阈值漂移 → 测试 FAIL

**禁止**：
- 凭记忆重写提示词或判定逻辑
- 迁移时顺手调整阈值 / 改变判定语义（任何变动须在 §5 声明为有意偏差并进 MIGRATION §29）
- 只改 zh / en 中的一份
- 把源文件的规则编号或清单顺序「重新整理」（顺序本身经过验证）

---

## 6. 测试矩阵（按 AGENTS.md §3 的「改动类型 → 必做」表）

| 迁移项 | 改动类型 | 必做命令 | 必补断言 |
| --- | --- | --- | --- |
| §3.1 内容门 | 蓝图细节档位同类（数量控制）+ 页面生成 | `typecheck` + `test:blueprint` + `test:pages` + `test`（**配置界面 `/config/quality` 另跑 `test:tui`**） | 指标计算黄金值（剥码/剥图后字符数）、`warn` 不阻断、`enforce` 拦截 + 常驻反馈文案、**best-effort 落盘降级（预算用尽 → 内容仍落盘且 `gate.mode='enforce-degraded'`，页面计成功）**、`mermaidRequired` 由 section 角色 / `spec.panorama` 派生（minimal 档 + 概览类页面）、五档 × 三 level 下限表 |
| §3.2 verify-wiki | 业务层 + 新增 CLI 命令 | `typecheck` + `test:pages` + `test:tui` + `mock:wiki` + `test` | 各检查组 PASS/FAIL/SKIP 语义、`--enforce` 退出码、档位参数解析（`resolveWikiVariant`）与**遗留无档位目录的显式 fallback 分支**、变体与遗留目录均缺失时 SKIP 语义；**mock 只断言结构类检查全绿**（content 组为 warn 报告，不可作为内容门的达标依据） |
| §3.3 溯源校验 | 业务层 | `typecheck` + `test:pages` + `test` | 路径真实 / 行号有效 / 跨页重复声明、符号缓存缺失时降级为 SKIP（不判失败）、`validate_blueprint` 逻辑迁移后旧工具仍归档可用 |
| §3.4 格式资产 + reader-first | 文风纪律类 | `typecheck` + `test:blueprint` + `test:pages` + `test`（配置界面另跑 `test:tui`） | zh/en 两份文件同步、`.md` 导入经 tsup 打包后内容逐字一致（对齐现有 humanizer 测试）、`withReaderDiscipline` 拼装顺序在 `<project_context>` / `<writing_discipline>` 之后、polish 回滚 diff 断言（溯源行字节数不变） |
| §3.5 标题诊断 | 蓝图三阶段 | `typecheck` + `test:blueprint` + `test` | 只改 title 自检（其他字段字节不变）、数量一致校验、诊断信号触发的重写率下降（mock 对比） |
| §4 反注水 | prompt + 文档 | `typecheck` + `test:pages` | 「源没有代码时代码块为 0」不被判 FAIL、「强行加代码块」被判 FAIL |

**冒烟**：每个 P0/P1 项落地后跑 `bun run mock:wiki` 核对 `.zread-pi/wiki/<variant>` 产物 + `events.jsonl` 终态；随后跑 `zread-pi verify` 只核对结构类检查（content 组口径见上表）。

**一致性校验（§5.5 强制，每项都要跑，独立于上表）**：
- 提示词资产：复制后用 diff 核对「保留段落」逐字一致（仅允许语境词替换）；翻译版按原文逐条对账，清单**条数与编号必须一一对应**
- 代码：门限算式与正则用**同一输入**在 lecture-to-notes 的 Python 参考实现与 zread-pi 的 TS 实现上跑黄金值对照，判定结果必须一致
- 任一「保留段落」被改动、或阈值漂移 → 该项测试 FAIL（不允 comedthrough）

---

## 7. 文档同步清单

| 文件 | 改动 |
| --- | --- |
| `AGENTS.md` §1.1 | 新增决策行：内容密度门 / verify-wiki 闸门 / reader-first 纪律块 / 溯源校验 |
| `AGENTS.md` §3 | 新增「内容门 / verify-wiki」改动类型行；配置界面 `/config/quality` 并入既有「文风纪律 / 档位配置」行的 `test:tui` 覆盖范围 |
| `AGENTS.md` §1.2 | 登记新增可选字段与导出（`AppConfig.quality?` / `QualityConfig` / `normalizeQualityConfig` + `DEFAULT_QUALITY_*`、`PageResult.gate?` / `ContentGateReport`、`withReaderDiscipline`、verify-wiki 导出）；声明验证摘要落 `<runDir>/verify.json` 而非 `RunMeta` |
| `MIGRATION.md` | 新增章节（顺延编号 = **§29**，实测当前已到 §28）：设计、行为差异、降级语义、反注水决策、与 lecture-to-notes 的有意偏差 |
| `README.md` | CLI 参考表加 `zread-pi verify`；Features 加「内容密度门」与「交付闸门」两条；FAQ 加「质量门会不会让我的页面生成失败」；配置节补 `quality.contentGate` / `quality.verifyAfterGenerate` 说明（TUI `/config/quality` 维护） |
| `apps/cli/src/views/config-quality/**` | 【审查修订新增】内容门配置界面页：开关 / 模式三选（off·warn·enforce）/ `verifyAfterGenerate` 开关；遵循 `DESIGN.md`、文案进 `i18n/translations/*`、`test:tui` 断言（项目原则：配置全部可在 TUI 维护，不让用户手写 YAML） |
| 新建文件全部加溯源文件头（§5.5 强制） | 【用户新增约束】`content-gate.ts` / `verify-wiki.ts` / `traceability.ts` / `prompts/page-format.*.md` / `prompts/reader-first.*.md` / `agents/page-format.ts` / `agents/reader-first.ts` —— 头部注明来源 + 精炼方式（保留什么/去掉什么/补充什么）+ 同步对象，对齐 `humanizer.zh.md` 头部风格与 AGENTS §1.3 的「复制 + 改写」约定 |
| `RULES.md` §5 | orchestrator 修改要点补「内容门纯函数在 `wiki/content-gate.ts`，落点与拦截点分离」 |

---

## 8. 实施阶段与 Git 流程

按 AGENTS.md §4 的铁律执行（小步提交、分支上完成版本升级、**AI 不得自行 merge**、交付给用户手动合并）。

| 阶段 | 分支 | 内容 | 版本 | 交付物 |
| --- | --- | --- | --- | --- |
| P0-1 | `feat/orchestrator-content-gate` | §3.1 内容门纯函数 + 常量表 + `write_page` 拦截 + best-effort 降级链 + `normalizeQualityConfig` + `/config/quality` 视图 + §4 反注水 | 1.13.7 → 1.14.0 | 测试（含 `test:tui` 配置页）+ 决策行 + MIGRATION 章节 |
| P0-2 | `feat/orchestrator-verify-wiki` | §3.2 verify-wiki + CLI `verify` 子命令 + `<runDir>/verify.json` 集成 + 遗留目录 fallback | 1.14.0 → 1.15.0 | 测试 + README CLI 表 |
| P1-1 | `feat/orchestrator-traceability` | §3.3 溯源校验 + `validate_blueprint` 逻辑迁移 | 1.15.0 → **1.16.0** | 测试 |
| P1-2 | `feat/orchestrator-page-format` | §3.4 格式资产 + reader-first 纪律块 + polish 扩展 | 1.16.0 → **1.17.0** | 测试（含 tsup .md 导入） |
| P2 | `refactor/orchestrator-titles` | §3.5 标题诊断信号 + 数量一致性自检 | 1.17.0 → **1.17.1** | 测试 |

每个阶段：`bun run typecheck` + 对应测试套件真实执行 → 在分支上完成版本升级（独立提交）→ 交付报告（分支名 / 验证结果 / 当前版本 → 目标版本 / 升级依据）→ 用户在 master 手动 `git merge --no-ff` → 合并后复验 `bun run test` → 清理分支。

> 【审查修订】版本阶梯按 AGENTS §4.4「新增功能 = 次版本 +1、修复版本归 0；重构 / 文档 / 测试 = 修复版本 +1」：P0-1 / P0-2 / P1-1 / P1-2 均为 `feat/*`（次版本 +1），P2 为 `refactor/*`（修复版本 +1）。原计划把 P1-1 / P1-2 写成 patch 级跳（1.15.1 / 1.15.2），违反该规则，已改。

**版本守卫**：本次只新增可选配置字段与新文件，**不触碰数据格式**，`INCOMPATIBLE_BEFORE`（当前 `1.13.0`）无需改动；家目录与 `.zread-pi` 仓库输出目录都保持兼容。

---

## 9. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 内容门误伤高质量短页面（如纯配置页） | 下限按 `associatedFiles` 规模自适应 + 源没有就应该是 0 的规则 + 默认 `warn` 不阻断 |
| `enforce` 导致页面反复重写、烧 token | 重试在 token 预算内收敛；预算用尽时经 best-effort 落盘降级（§3.1，`gate.mode='enforce-degraded'`），页面不判失败；复用既有两段式提示（软 70% / 硬将尽）避免无限重试 |
| 溯源校验因符号缓存缺失而大面积 FAIL | 缓存缺失时降级为 SKIP，不判失败（对齐 `loadWikiBlueprint` 的宽松降级语义） |
| reader-first 条目与 humanizer 25 条模式重叠冲突 | 移植前做去重（§3.4.2 表格已标注「差异部分」）；两份文件分立，冲突在拼装顺序上解决 |
| `.md` 资产经 tsup 打包后内容漂移 | 复用现有 humanizer 的导入测试模式，加逐字断言 |
| 老配置 / 老 wiki.json 不兼容 | 全部新增字段可选 + 缺省；`bun run test` 的旧配置启动断言覆盖 |
| 大规模真机未验证（AGENTS.md §6.7 已声明） | 内容门数值在 `fixtures/hello-python` 与 mock 产物上标定；真机首次验证重点看 `enforce` 下的重写轮次与 token 消耗 |

**回退**：每个阶段独立分支 + 独立版本号；任一阶段出问题，用户在 master 上不合并即可，已合并阶段可通过配置 `quality.contentGate.mode = 'off'` 与不使用 `zread-pi verify` 完全关闭，行为退回当前 1.13.7。

---

## 10. 一句话总结

把 lecture-to-notes「**把主观质量判断改写为脚本可判定的硬指标**」的核心方法论迁移过来：用**内容密度门**补上 zread-pi「只有篇数门、没有内容门」的最大缺口，用**verify-wiki 闸门**补上缺失的质量出口，用**溯源校验**把已有的 `Sources:` 强约束从「格式正确」升级为「事实正确」，用**reader-first 纪律**把 humanizer「像人写的」补齐为「教会了读者」——同时通过**默认 warn 降级语义**与**反注水设计**，让这些门适配 zread-pi「生成永不悬挂」的既有哲学，而不是照搬 lecture-to-notes 的强阻断交付判据。

---

## 11. 修订记录（代码级审查修补）

本计划已对照真实代码逐条核实（文件 / 函数签名 / 导出状态 / 调用点），修补以下 12 处问题；并按用户指示新增 1 条贯穿全计划的过程约束（§5.5）。标记 `【审查修订】` / `【用户新增约束】` 的段落为修订落点。

### 用户新增的过程约束

| # | 约束 | 落点 |
| --- | --- | --- |
| 13 | **提示词与代码必须「先复制文件、后兼容改写」**：所有迁移资产先逐字复制源文件，再做语境/语言/阻断语义的兼容改写；禁止凭记忆重写、禁止顺手调阈值、zh/en 必须同步、清单编号顺序必须保留；新建文件强制溯源文件头；复制结果用 diff 与黄金值对照验证一致性 | §5.5（主条款）+ §3.1/§3.2/§3.3/§3.4 各实现点指针 + §6 一致性校验 + §7 文件头行 |

### 断链（实施会直接卡住）

| # | 问题 | 修补 |
| --- | --- | --- |
| 1 | **enforce 降级链无落地机制**：`write_page` 返回 `is_error` 时 `wrotePage` 保持 false，模型过不了门则文件永不落盘 → 页面被判 FAIL，不存在「降级 warn」路径 | §3.1 补 best-effort 落盘：扩展 `PageWriteAttempt` 缓存被拦截内容，失败分支写入约定路径并标 `gate.mode='enforce-degraded'`，页面计成功 + 告警 |
| 2 | **声称「配置界面开启 enforce」但无配置视图任务**，违反「配置全部可在 TUI 维护」原则 | §7 新增 `apps/cli/src/views/config-quality/**` 任务（文案进 i18n、`test:tui` 覆盖）；P0-1 阶段表补该项 |
| 3 | **`run.json` 无可写字段**：`RunMeta` 固定结构，无挂载验证摘要位置 | §3.2 决策落独立文件 `<runDir>/verify.json`，不改 `RunMeta`（避免 run.json 契约变更） |
| 4 | **`AppConfig.quality` 缺 normalizer**：旧配置启动时字段为 undefined、配置界面无法持久化；且 §3.2 引用的 `verifyAfterGenerate` 未在 §3.1 的类型里声明 | §3.1 类型改为 `QualityConfig`（含 `contentGate` + `verifyAfterGenerate`）+ `normalizeQualityConfig` + `DEFAULT_QUALITY_*` + `config/index.ts` 两处接线 |
| 5 | **`extractMermaidBlocks` 未导出**（模块私有） | §3.1 改为内容门自行用 `MERMAID_FENCE_RE` 计数，不导出该函数 |
| 6 | **MIGRATION 章节编号错误**：实测已到 §28，非 §27 | §7 改为 §29 |
| 7 | **遗留目录口径错误**：`resolveWikiVariant` 不返回无档位遗留目录，`loadWikiBlueprint` 的 variant 必填 | §3.2 补显式 fallback 分支（显式 path 调 `loadWikiBlueprint`，path 优先于 variant）；两处目录均缺失时 SKIP + 退出码 0 |

### 设计不一致（逻辑不严密）

| # | 问题 | 修补 |
| --- | --- | --- |
| 8 | **`mermaidRequired` 分键轴错误**：挂在 `level`（难度）上，但真实判定键是 section 角色 / `spec.panorama`，两者正交 | §3.1 下限表删除该字段，签名改为 `evaluateContentGate(page, detailSpec)`，`mermaidRequiredFor(page, spec)` 派生 |
| 9 | **§3.5 「其他字段不变」是伪检查**：`applySectionTitles` 只赋值 `page.title`，结构性保证；且工具入参只有 `{slug,title}[]` 无法比对 | §3.5 改为「数量一致性」（`unknown>0` 或 `updated+skipped≠页面数` → is_error）+ 重写率统计 |
| 10 | **「mock 产物全绿」断言不可达**：mock LLM + 极小夹具过不了内容密度门 | §6 改为只断言结构类检查全绿，content 组以 warn 报告产出 |
| 11 | **§3.3 行号数据源描述有误**：`CacheManifest` 只有 `{path,hash,size}`，无行数字段 | §3.3 改为对 `Sources:` 引用文件做流式按行计数 + `size` sanity check |
| 12 | **版本阶梯违反 AGENTS §4.4**：P1-1 / P1-2 是 feat 却用 patch 跳（1.15.1 / 1.15.2） | §8 改为 1.16.0 / 1.17.0（feat 次版本+1），P2 改 1.17.1（refactor patch+1），并加规则注 |

### 审查中确认无问题、未改动的部分

`write_page` 拦截点与 `is_error` 机制、`validateMermaidContent` 导出、CLI 注册模式与 `-d/--dir` 全局选项、`applySectionTitles` 只改 title、`last_symbols.json` / `last_manifest.json` 与 `loadCachedSymbols()` / `loadCachedManifest()` 的 null 返回语义（支持 SKIP 降级）、`tsup-md-text.ts` + `md.d.ts`、系统提示拼装链（`withProjectContext` → `withStyleDiscipline`，`options.systemPrompt` 为完全替换）、`ValidateBlueprintTool` 确为死代码、版本规则 1.13.7 → 1.14.0、工具名 / 契约冻结点遵守。
