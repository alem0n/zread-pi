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

// Types
export * from './types.js'

// Re-export TokenUsage from agent-sdk
export type { TokenUsage } from '@zread-pi/agent-runtime'