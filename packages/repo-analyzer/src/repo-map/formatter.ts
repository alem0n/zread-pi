/**
 * Repo Map Formatter - Format tree structure for LLM readability
 */

import type { SymbolInfo, DirectoryTreeNode, RepoMapOutput } from '@zread-pi/types';
import { REPO_MAP_CONFIG } from './constants.js';
import { estimateTextTokens } from './token-counter.js';

/** 取路径的文件名部分（两种分隔符都支持） */
export function fileNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * 一个文件在 Repo Map 中会输出的符号内容行（不含树前缀 / Ref 标签）
 *
 * formatter 渲染与 token-counter 估算共用这一份构造：估算值与真实输出不会漂移。
 */
export function formatSymbolContentLines(symbol: SymbolInfo): string[] {
  const lines: string[] = [fileNameOf(symbol.file)];

  // Docstring (first one)
  if (symbol.docstrings.length > 0) {
    lines.push(`/** ${symbol.docstrings[0].trim()} */`);
  }

  // Exports (with signature truncation)
  for (const exp of symbol.exports) {
    lines.push(`[Export] ${trimSignature(exp, REPO_MAP_CONFIG.max_signature_length)}`);
  }

  // Functions
  for (const fn of symbol.functions) {
    lines.push(trimSignature(fn.signature, REPO_MAP_CONFIG.max_signature_length));
  }

  return lines;
}

/**
 * Build directory tree from selected files
 */
export function buildDirectoryTree(files: SymbolInfo[]): DirectoryTreeNode {
  const root: DirectoryTreeNode = {
    name: 'root',
    type: 'directory',
    children: [],
  };

  for (const symbol of files) {
    // Normalize path
    const normalizedPath = symbol.file.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    const fileName = parts.pop() || '';
    // Navigate/create directory structure
    let current = root;
    for (const dirName of parts) {
      if (!current.children) current.children = [];

      let dirNode = current.children.find(c => c.name === dirName && c.type === 'directory');
      if (!dirNode) {
        dirNode = {
          name: dirName,
          type: 'directory',
          children: [],
        };
        current.children.push(dirNode);
      }
      current = dirNode;
    }

    // Add file node
    if (!current.children) current.children = [];
    current.children.push({
      name: fileName,
      type: 'file',
      path: symbol.file,
    });

    // Sort children: directories first, then files alphabetically
    current.children.sort((a: DirectoryTreeNode, b: DirectoryTreeNode) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
  }

  return root;
}

/**
 * Format Repo Map as tree string
 */
export function formatRepoMap(
  tree: DirectoryTreeNode,
  symbols: SymbolInfo[],
  referenceMap: Record<string, number>
): string {
  const lines: string[] = [];

  // Header
  lines.push('Project Tree & Symbols');
  lines.push('');

  // Format tree recursively (skip 'root' name)
  if (tree.children) {
    formatTreeNode(tree.children, symbols, referenceMap, lines, '');
  }

  return lines.join('\n');
}

/**
 * Format single tree node
 */
function formatTreeNode(
  nodes: DirectoryTreeNode[],
  symbols: SymbolInfo[],
  referenceMap: Record<string, number>,
  lines: string[],
  prefix: string
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const nodePrefix = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : REPO_MAP_CONFIG.tree_indent;

    if (node.type === 'directory') {
      // Directory node
      lines.push(`${prefix}${nodePrefix}${node.name}/`);
      if (node.children && node.children.length > 0) {
        formatTreeNode(node.children, symbols, referenceMap, lines, prefix + childPrefix);
      }
    } else if (node.type === 'file' && node.path) {
      // File node
      const symbol = symbols.find(s => s.file === node.path);
      if (!symbol) continue;

      const refCount = referenceMap[node.path] || 0;
      const refLabel = refCount > 0 ? ` [Ref: ${refCount}]` : '';

      lines.push(`${prefix}${nodePrefix}${node.name}${refLabel}`);

      // Add symbol details（与 token 估算共用同一份内容行构造）
      const symbolPrefix = prefix + childPrefix;
      for (const contentLine of formatSymbolContentLines(symbol)) {
        lines.push(`${symbolPrefix}${contentLine}`);
      }

      // Empty line after file (for readability)
      if (symbol.exports.length > 0 || symbol.functions.length > 0 || symbol.docstrings.length > 0) {
        lines.push(`${symbolPrefix}`);
      }
    }
  }
}

/**
 * Trim signature to max length
 */
export function trimSignature(signature: string, maxLength: number): string {
  if (signature.length <= maxLength) return signature;

  // Try to keep meaningful part
  const trimmed = signature.slice(0, maxLength - 3);
  return trimmed + '...';
}

/**
 * Build complete Repo Map output
 */
export function buildRepoMapOutput(
  content: string,
  selectedSymbols: SymbolInfo[],
  priorities: { file: string; referenceCount: number }[]
): RepoMapOutput {
  // Estimate token count with pi's context estimator (same algorithm the harness uses)
  const tokenCount = estimateTextTokens(content);

  // Get top files
  const topFiles = priorities
    .sort((a: { file: string; referenceCount: number }, b: { file: string; referenceCount: number }) => b.referenceCount - a.referenceCount)
    .slice(0, 10)
    .map(p => p.file);

  return {
    content,
    tokenCount,
    fileCount: selectedSymbols.length,
    topFiles,
  };
}