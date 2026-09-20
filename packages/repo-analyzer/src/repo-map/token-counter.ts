/**
 * Token Counter - Estimate token count for Repo Map
 *
 * **不再自维护启发式**：迁移前是「行数 × 10 tokens」的粗估（两个副本：本文件 + formatter），
 * 现在统一用 pi 的上下文估算器 `estimateTokens`（`@earendil-works/pi-agent-core`，
 * chars/4 启发式，与 harness 判定上下文压力时用的是同一套算法）。
 *
 * 估算对象是「该文件在 Repo Map 中会输出的符号行」——由 `formatSymbolContentLines`
 * 提供（与 formatter 渲染共用同一份内容构造，避免估算与真实输出漂移）。
 */

import { estimateTokens as estimateMessageTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { SymbolInfo } from "@zread-pi/types";
import { REPO_MAP_CONFIG } from "./constants.js";
import { formatSymbolContentLines } from "./formatter.js";

/** 用 pi 的估算器估算一段文本的 token 数（空文本 = 0） */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  // pi 的估算器按消息形态取文本（user 分支即 chars/4），这里把文本包成一条 user 消息
  const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
  return estimateMessageTokens(message);
}

/**
 * Estimate tokens for a single file's Repo Map representation
 *
 * 估算对象是「该文件真正会输出到 Repo Map 里的文本」：树形缩进前缀 + 文件行（含 Ref 标签）
 * + 符号内容行，再交给 pi 的估算器。
 * 把前缀 / Ref 标签算进去是有意的：只估内容会低估带缩进的深层文件，让 token 预算失真。
 */
export function estimateTokens(symbol: SymbolInfo, referenceCount = 0): number {
  const depthIndent = REPO_MAP_CONFIG.tree_indent.length * getDepth(symbol.file);
  const fileLinePrefix = ' '.repeat(depthIndent) + REPO_MAP_CONFIG.file_prefix;
  const contentLinePrefix = ' '.repeat(depthIndent) + ' '.repeat(REPO_MAP_CONFIG.tree_indent.length);
  const refSuffix = referenceCount > 0 ? ` [Ref: ${referenceCount}]` : '';

  const rendered = formatSymbolContentLines(symbol)
    .map((line, index) =>
      index === 0 ? `${fileLinePrefix}${line}${refSuffix}` : `${contentLinePrefix}${line}`,
    )
    .join('\n');

  return estimateTextTokens(rendered);
}

/**
 * Get directory depth from file path
 */
export function getDepth(filePath: string): number {
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  // Exclude filename, count directories
  return Math.max(0, parts.length - 1);
}
