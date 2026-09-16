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
export { polishPageFile, DEFAULT_POLISH_TOKEN_BUDGET } from './wiki/polish.js'
export type { WikiResult, ProgressState, PageResult, PolishOutcome, GenerateWikiOptions, ArticleEventPayload } from './wiki/types.js'

// Phase 3: Wiki Sync
// 三阶段增量修补：diff → （按需）分类合并 → 按变更 section 分主题 / 标题；SyncDiff 语义与旧实现一致
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

// 文风纪律（humanizer）：预防层注入 + polish Agent 提示词（见 MIGRATION.md §15）
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

// 蓝图细节档位（blueprint.detail）：数量区间 / 数量反馈 / 归并策略 / 缩编与代码兜底
// 纯函数（数量控制四层机制的第 1、2、4 层；第 3 层缩编 subagent 在 blueprint-stages.ts）
export {
  BLUEPRINT_DETAIL_SPECS,
  CONDENSE_SYSTEM_PROMPT,
  DEFAULT_CONDENSE_TOKEN_BUDGET,
  MAX_QUANTITY_FEEDBACK_ROUNDS,
  MINIMAL_PANORAMA_REQUIREMENT,
  QUANTITY_FALLBACK_NOTE,
  buildCondenseSectionTask,
  buildCondenseTopicsTask,
  buildSectionQuantityStrategy,
  buildTopicsQuantityStrategy,
  codeFallbackSections,
  condenseTopicsToMax,
  formatQuantityFeedback,
  getDetailSpec,
  judgeQuantity,
} from './agents/blueprint-detail.js'
export type {
  BlueprintDetailSpec,
  DetailRange,
  QuantityToolState,
  QuantityVerdict,
} from './agents/blueprint-detail.js'

// 蓝图阶段提示词渲染（数量目标按档位参数化）
export { renderClassifyPrompt } from './prompts/classify'
export type { ClassifyPromptOptions } from './prompts/classify'
export { renderTopicsPrompt, SYNC_TOPICS_RULES } from './prompts/topics'
export type { TopicsPromptOptions } from './prompts/topics'

// 蓝图输出工具（数量反馈 / 越界不落盘 / 缩编一次性输出工具）
export {
  createSubmitSectionsTool,
  createSubmitSectionTopicsTool,
  createSubmitCondensedSectionsTool,
  createSubmitCondensedTopicsTool,
} from './tools/output-tools.js'
export type { CondensedSectionCapture, CondensedTopicCapture } from './tools/output-tools.js'

// Types
export * from './types.js'

// 轨迹日志 sink（编排层注入；落盘在 @zread-pi/utils 的 RunLogWriter）
export type { RunLogSink } from './agents/create-agent.js'

// Re-export TokenUsage from agent-sdk
export type { TokenUsage } from '@zread-pi/agent-runtime'