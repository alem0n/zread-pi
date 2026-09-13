/**
 * @zread-pi/blueprint
 *
 * Wiki blueprint generation using Agent orchestration.
 */

// Phase 1: Blueprint Generation
export { generateWikiCatalog } from './orchestrator.js'

// Phase 2: Wiki Content Generation
export { generateWikiContent } from './wiki/generate-wiki.js'
export type { WikiResult, ProgressState, PageResult, GenerateWikiOptions, ArticleEventPayload } from './wiki/types.js'

// Phase 3: Wiki Sync
export { syncWiki } from './wiki/sync-wiki.js'
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

// Types
export * from './types.js'

// Re-export TokenUsage from agent-sdk
export type { TokenUsage } from '@zread-pi/agent-runtime'