/**
 * Symbol Manifest Types
 *
 * Parser output - extracted symbols from source files
 */

/**
 * SymbolManifest - Parser output
 */
export interface SymbolManifest {
  symbols: SymbolInfo[];
  loadedParsers: string[];
}

import type { SymbolRange } from './structure.js';

/**
 * SymbolInfo - Single file symbols
 */
export interface SymbolInfo {
  file: string;
  exports: string[];
  functions: Array<{ name: string; signature: string }>;
  imports: string[];
  docstrings: string[];
  /**
   * 文件总行数（结构优先蓝图的行级台账用；加法式新增字段，旧缓存缺失）。
   *
   * 公式：`text === '' ? 0 : text.split(/\r?\n/).length`（末元素为空串时移除）。
   */
  lineCount?: number;
  /**
   * 顶层符号的行区间（tree-sitter 节点 startPosition / endPosition，1-based）。
   * import / export 不进 ranges（按惯例计入间隙行）；vue 段为空数组（不测）。
   * 加法式新增字段，旧缓存缺失。
   */
  ranges?: SymbolRange[];
}