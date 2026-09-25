/**
 * Cache Types
 *
 * Cache manifest structure for incremental processing
 */

/**
 * CacheManifest - Cache manifest
 */
export interface CacheManifest {
  version: string;
  generated_at: string;
  promptHash?: string;
  files: Array<{
    path: string;
    hash: string;
    size: number;
    /** 语言标签（结构层清单哈希依赖它；旧缓存缺失时 verify 的覆盖检查组整组 SKIP） */
    language?: string;
  }>;
}