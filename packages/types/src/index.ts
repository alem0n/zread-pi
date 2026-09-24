/**
 * @zread-pi/types
 *
 * Shared type definitions for the zread-pi project.
 *
 * Modules:
 * - manifest: File manifest (scanner output)
 * - symbols: Symbol manifest (parser output)
 * - wiki: Wiki page definitions and output
 * - config: Application configuration
 * - cache: Cache manifest structure
 * - repo-map: Three-layer repo map types
 */

// Manifest types
export type { FileManifest, FileInfo } from './manifest.js'

// Symbol types
export type { SymbolManifest, SymbolInfo } from './symbols.js'

// Structure types（结构优先蓝图：CEG / 切片 / 分类 / 槽位 / 覆盖台账）
export type {
  StructureEdgeKind,
  StructureEdge,
  SeamRecord,
  StructureSlice,
  MachineSectionKind,
  MachineSection,
  SlotKind,
  SlotSpec,
  StructureParams,
  StructureCache,
  MachinePageId,
  PageRef,
  SymbolRange,
} from './structure.js'

// Wiki types
export type { WikiPage, WikiOutput, WikiSection, WikiTopic, TechStackSummary, WikiLevel, SyncPageStatus, SyncDiff, WikiCoverage } from './wiki.js'

// Config types
export type { AppConfig, AgentConfig, LLMConfig, LlmProviderConfig, CustomModelConfig, LlmAuthType, ThinkingLevel, ThinkingLevelMap, ToolConfig, ToolsConfig, PolishConfig, PolishMode, BlueprintConfig, BlueprintDetailLevel, QualityConfig, ContentGateMode } from './config.js'

// Cache types
export type { CacheManifest } from './cache.js'

// Run（轨迹）类型：可回放事件流 + 运行元数据
export type { RunEvent, RunEventBase, RunEventKind, ActiveRunEventKind, RunEventAgentMeta, RunEventAgentRole, RunContentBlock, RunJsonValue, RunTokenUsage, RunStage, RunStartEvent, RunEndEvent, AgentConfigEvent, AgentStartEvent, AgentEndEvent, ProviderRequestEvent, ScanStartEvent, ScanEndEvent, MessageStartEvent, MessageDeltaEvent, MessageEndEvent, ToolStartEvent, ToolEndEvent, RetryEvent, CompactEvent, StatusEvent, StageEvent, SectionEvent, PageStartEvent, PageEndEvent, FailedSectionsEvent } from './run-event.js'
export { RUN_LEVEL_AGENT } from './run-event.js'
export type { RunMeta, RunSummary, RunStatus, RunKind, RunAgentsMeta, RunPagesMeta } from './run-meta.js'

// Repo Map types
export type {
  RepoMapOptions,
  FilePriority,
  DirectoryTreeNode,
  RepoMapOutput,
  DirectoryTreeOutput,
  CoreSignaturesOutput,
  ModuleDetailsOutput,
} from './repo-map.js'