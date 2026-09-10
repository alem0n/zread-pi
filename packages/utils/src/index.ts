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
} from './config/index.js';

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