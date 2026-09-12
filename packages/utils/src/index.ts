// File I/O utilities
export {
  ensureDir,
  removeDir,
  readTextFile,
  writeTextFile,
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

// 全局记忆（开始生成文档时写入；`zread-pi history` 清理并展示）
export {
  HISTORY_FILE_NAME,
  DEFAULT_PRUNE_CONCURRENCY,
  getHistoryPath,
  rememberProject,
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
  MIN_MAX_TURNS,
  MAX_MAX_TURNS,
  normalizeMaxTurns,
  normalizeToolsConfig,
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
export { generateWikiJson, loadWikiBlueprint } from './output/wiki-content.js';

// Provider Registry
export * from './provider-registry/types.js';
export { getProviderRegistry, syncProviders } from './provider-registry/index.js';