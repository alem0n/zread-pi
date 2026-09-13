// File I/O utilities
export {
  ensureDir,
  removeDir,
  readTextFile,
  writeTextFile,
  writeTextFileAtomic,
  writeJsonFile,
  readJsonFile,
  fileExists,
  joinPath,
  getProjectRoot,
  getOutputDir,
  getWikiJsonPath,
  getCacheDir,
  getWikiDir,
} from './file-io.js';

// Logger
export { logger, getLogFile } from './logger.js';

// 项目家目录（~/.zread-pi）的唯一定义点
// 配置 / 凭据 / 日志 / 解析器缓存 / 托管二进制 / 全局记忆 history 全部经由这里取路径
export { ZREAD_PI_DIR_NAME, ZREAD_PI_HOME_ENV, getProjectHome, projectHomePath } from './project-home.js';

// 跨进程文件锁（config / auth / tools-state / history 的读-改-写共用）
export { acquireFileLock, acquireFileLockSync, withFileLock, withFileLockSync } from './lockfile.js';

// 全局记忆（开始生成文档时写入；`zread-pi history` 清理并展示）
export {
  HISTORY_FILE_NAME,
  DEFAULT_PRUNE_CONCURRENCY,
  getHistoryPath,
  rememberProject,
  ensureProjectRecorded,
  readHistory,
  forgetProject,
  clearHistory,
  pruneHistory,
} from './history/index.js';
export type { ProjectRecord, HistoryPruneOptions, HistoryPruneResult } from './history/index.js';
export { mapWithConcurrency } from './history/concurrency.js';

// Config
export {
  loadConfig,
  loadConfigSync,
  saveConfig,
  validateConfig,
  getDefaultLanguage,
  getConfigPath,
  getZreadDir,
  getZreadAuthPath,
  getZreadModelsStorePath,
  getProviderConfig,
  getConfiguredProviderIds,
  normalizeProviderConfigs,
  isFirstTimeConfig,
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  isThinkingLevel,
  normalizeThinkingLevel,
  DEFAULT_MAX_TURNS,
  DEFAULT_TOKEN_BUDGET,
  normalizeTokenBudget,
  MIN_MAX_TURNS,
  MAX_MAX_TURNS,
  normalizeMaxTurns,
  normalizeToolsConfig,
  DEFAULT_POLISH_ENABLED,
  DEFAULT_POLISH_MODE,
  POLISH_MODES,
  isPolishMode,
  normalizePolishConfig,
} from './config/index.js';

// 外部工具（注册表 / 安装器 / 归档解包），配置界面 /config/tools 与 agent-runtime 共用
export {
  TOOL_REGISTRY,
  RG_TOOL,
  FD_TOOL,
  listTools,
  getToolSpec,
  toolIds,
  archiveKindOf,
} from './tools/registry.js';
export type { ToolSpec, ToolId } from './tools/registry.js';
export {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_NETWORK_TIMEOUT_MS,
  DEFAULT_VERSION_PROBE_ARGS,
  getManagedBinDir,
  getManagedBinaryPath,
  getManagedBinUsage,
  getToolLedgerPath,
  getToolStatus,
  getToolStatuses,
  clearToolInstall,
  installTool,
  isToolEnabled,
  notifyToolsChanged,
  onToolsChanged,
  probeBinary,
  readToolLedger,
  recordToolInstall,
  resolveLatestVersion,
  resolveToolBinary,
  setBinaryProbeForTesting,
  ToolInstallError,
  uninstallTool,
} from './tools/installer.js';
export type {
  BinaryProbe,
  BinaryProbeResult,
  InstallToolOptions,
  ResolvedToolBinary,
  ToolInstallPhase,
  ToolInstallProgress,
  ToolLedgerEntry,
  ToolSource,
  ToolState,
  ToolStatus,
} from './tools/installer.js';
export { ArchiveError, extractArchive, parseTarEntries, parseZipEntries, safeEntryPath } from './tools/archive.js';
export type { ArchiveKind, ExtractedEntry } from './tools/archive.js';

// Cache
export {
  loadCachedManifest,
  saveCachedManifest,
  diffManifests,
  needsReprocess,
  loadCachedSymbols,
  saveCachedSymbols,
} from './cache/index.js';

// Storage
export { WikiStore } from './storage/wiki-store.js';
export { generateSnapshotName, createVersionSnapshot } from './storage/versioning.js';

// Output
// 三阶段蓝图（分类 → 分主题 → 标题）的落盘设施：骨架 / 分类归并 / 主题归并 / 标题写回
export {
  generateWikiJson,
  loadWikiBlueprint,
  MAX_BLUEPRINT_SECTIONS,
  normalizeSectionList,
  normalizeBlueprintSections,
  mergeBlueprintSections,
  deriveSectionsFromPages,
  sectionsFromBlueprint,
  slugStem,
  nextPageIndex,
  normalizeLevel,
  initWikiSkeleton,
  mergeWikiSections,
  mergeSectionTopics,
  applySectionTitles,
  writeWikiPages,
} from './output/wiki-content.js';
export type {
  MergeTopicsResult,
  MergeTopicsOptions,
  ApplyTitlesResult,
} from './output/wiki-content.js';

// Provider Registry
export * from './provider-registry/types.js';
export { getProviderRegistry, syncProviders } from './provider-registry/index.js';