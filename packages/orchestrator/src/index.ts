/**
 * @zread-pi/blueprint
 *
 * Wiki blueprint generation using Agent orchestration.
 */

// Phase 1: Blueprint Generation
export { generateWikiCatalog } from './orchestrator.js'

// Phase 2: Wiki Content Generation
export { generateWikiContent } from './wiki/generate-wiki.js'
// Phase 2b: 页面落盘后的兜底润色（polish.mode = 'full' 时启用）
export { polishPageFile, checkPolishDiff, DEFAULT_POLISH_TOKEN_BUDGET } from './wiki/polish.js'
export type { PolishDiffViolation } from './wiki/polish.js'
export type { WikiResult, ProgressState, PageResult, PolishOutcome, GenerateWikiOptions, ArticleEventPayload } from './wiki/types.js'

// 内容密度门（quality.contentGate）：把「页面是否干瘪」变成机械可判定的指标
// 移植自 lecture-to-notes 的 verify_notes.py::density_gate（纯函数 + 常量表，
// 拦截点在 tools/page-tools.ts，降级落盘在 wiki/generate-wiki.ts）
export {
  evaluateContentGate,
  extractGateMetrics,
  extractGateReport,
  formatContentGateError,
  resolveGateMode,
  proseFloor,
  mermaidRequiredFor,
  codeRecommendedFor,
} from './wiki/content-gate.js'
export type { ContentGateMetrics, ContentGateReport } from './wiki/content-gate.js'

// 交付闸门（quality.verifyAfterGenerate / `zread-pi verify`）：
// 移植自 lecture-to-notes 的 verify_notes.py（检查组 + PASS/FAIL/SKIP + OVERALL）。
// 只读：不写任何产物；verify.json 由 CLI / generate-wiki 集成按需落盘。
export { verifyWiki } from './wiki/verify-wiki.js'
export type {
  VerifyReport,
  VerifyCheck,
  VerifyStatus,
  VerifyGroup,
  VerifyWikiOptions,
} from './wiki/verify-wiki.js'

// 溯源台账（claims ledger 的代码版，移植自 extract_claims.py 的两段式「提取 → 逐条 check」）：
// 纯函数 + 只读；复用 repo-analyzer 已产出的缓存清单（last_manifest.json / last_symbols.json）。
export {
  parseSourceRefs,
  collectKnownSymbols,
  findUnresolvedSymbols,
  collectManifestPaths,
  isPathReal,
  countLines,
  checkAssociatedFiles,
  checkTraceability,
} from './wiki/traceability.js'
export type {
  SourceRef,
  AssociatedFileIssue,
  TraceabilityInput,
  TraceabilityResult,
} from './wiki/traceability.js'

// Phase 3: Wiki Sync
// 结构优先增量同步：diff → reconcileBlueprint（身份继承）→ 只对新增分类 / 页面命名；SyncDiff 语义与旧实现一致
export { syncWiki, computeSyncDiff } from './wiki/sync-wiki.js'
export type { SyncResult } from './wiki/sync-wiki.js'

// 目标仓库上下文文件（AGENTS.md / CLAUDE.md …）注入
// 页面 / 蓝图 Agent 的系统提示会带上目标仓库自述（见 agents/context-files.ts）
export {
  CONTEXT_FILE_MAX_BYTES,
  loadContextFileFromDir,
  loadProjectContextFiles,
  formatContextFiles,
  withProjectContext,
} from './agents/context-files.js'
export type { ProjectContextFile, LoadProjectContextFilesOptions } from './agents/context-files.js'

// 文风纪律（humanizer）：预防层注入 + polish Agent 提示词
export {
  STYLE_DISCIPLINE_TAG,
  getStyleDiscipline,
  formatStyleDiscipline,
  withStyleDiscipline,
  POLISH_EMBEDDED_MODE,
  buildPolishSystemPrompt,
  buildPolishTaskPrompt,
} from './agents/style-discipline.js'
export type { StyleLanguage } from './agents/style-discipline.js'

// 页面格式契约（frontmatter / 标题层级 / Mermaid 引号 / 溯源格式 / 交付前自检清单）：
// 从 page-agent.ts 抽出的硬性约束，与语气正交。
export { getPageFormat, formatPageFormat, withPageFormat } from './agents/page-format.js'
export type { FormatLanguage } from './agents/page-format.js'
export { PAGE_FORMAT_TAG } from './agents/page-format.js'

// 读者优先纪律（reader-first）：「教会了读者」，与 humanizer 正交、拼在其之后
export {
  getReaderDiscipline,
  formatReaderDiscipline,
  withReaderDiscipline,
  READER_SELF_CHECK,
} from './agents/reader-first.js'
export type { ReaderLanguage } from './agents/reader-first.js'
export { READER_FIRST_TAG } from './agents/reader-first.js'

// 蓝图细节档位（blueprint.detail）：数量区间是**机器目标参数**（算 minSliceSize 与选层窗口）
export {
  BLUEPRINT_DETAIL_SPECS,
  MINIMAL_PANORAMA_REQUIREMENT,
  getDetailSpec,
} from './agents/blueprint-detail.js'
export type { BlueprintDetailSpec, DetailRange } from './agents/blueprint-detail.js'

// 蓝图阶段提示词渲染（命名阶段；机器骨架以 json fence 给出）
export {
  renderSectionsNamingPrompt,
  renderMachineSectionsFence,
  machineSectionViews,
} from './prompts/classify.js'
export type {
  SectionsNamingPromptOptions,
  MachineSectionView,
} from './prompts/classify.js'
export {
  renderPagesNamingPrompt,
  renderMachinePagesFence,
  machinePageViews,
  SYNC_NAMING_RULES,
} from './prompts/topics.js'
export type { PagesNamingPromptOptions, MachinePageView } from './prompts/topics.js'

// 蓝图命名工具（只写语义字段；结构由机器蓝图锁定）
export { createSubmitSectionsTool, createSubmitPagesTool } from './tools/output-tools.js'

// Types
export * from './types.js'

// 轨迹日志 sink（编排层注入；落盘在 @zread-pi/utils 的 RunLogWriter）
export type { RunLogSink } from './agents/create-agent.js'

// Re-export TokenUsage from agent-sdk
export type { TokenUsage } from '@zread-pi/agent-runtime'