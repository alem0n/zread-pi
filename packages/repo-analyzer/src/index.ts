// Scanner
export { scanFiles, SCANNER_CONFIG, LANGUAGE_MAP } from './scanner/index.js';

// Parser
export { parseFiles } from './parser/index.js';
export { loadParsers, loadLanguage, loadParser, getCachedLanguage } from './parser/wasm-loader.js';
export { isLanguageSupported, getParserName } from './parser/language-map.js';
export { parseVueSfc, extractVueScript } from './parser/vue-handler.js';

// Repo Map - Core API only
export { buildRepoMap, REPO_MAP_CONFIG } from './repo-map/index.js';
export {
  buildDirectoryTreeOnly,
  buildCoreSignatures,
  buildModuleDetails,
} from './repo-map/index.js';

// Structure - 结构优先蓝图（CEG / 切片 / 分类 / 槽位）
export {
  buildStructureCache,
  computeLineLedger,
  computeManifestHash,
  computeExcluded,
  buildCodeGraph,
  buildSlices,
  louvainHierarchy,
  modularityOf,
  sliceQuotient,
  buildSections,
  buildSlots,
  computeSeams,
  hubCandidates,
  edgeView,
  type BuildStructureOptions,
  type StructureSpec,
  type SectionSelection,
  type CodeGraph,
} from './structure/index.js';