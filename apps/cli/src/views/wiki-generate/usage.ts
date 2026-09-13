/**
 * 生成页的用量合计（纯函数）
 *
 * 口径与 pi 的 usage ledger 一致（见 agent-runtime 的 `harness/driver.ts`）：
 * - 每个用例 Agent 上报的 `usage` 都是**该 Agent 自己的累计快照**：
 *   运行中来自 assistant 事件的累加，结束时由 harness ledger 的权威累计覆盖；
 * - `input_tokens` 只是「非缓存输入」（pi 把缓存读写单独记账），
 *   所以「输入侧总量」= input + cache_creation + cache_read；
 * - 缓存占比 = cache_read / 输入侧总量（分母为 0 时为 0）。
 *
 * 并发正确性（多页 p-limit 并发生成）：
 * 合计**不是**共享计数器上的增量累加，而是渲染时对「每个页面自己的快照」做一次
 * 幂等 reduce，因此不存在资源竞争：
 * - 每个页面的用量由该页自己的事件写进自己的 state 槽位，互不干扰；
 * - 中间事件会反复携带同一份快照（requesting / responding / tool_*），
 *   reduce 重复计算同一份快照结果不变（增量累加会重复计数）；
 * - 与事件到达顺序无关；页面重新生成时该槽位被重置，旧用量自然不再计入。
 */

import { sumTokenUsage } from '@zread-pi/agent-runtime';
import type { ArticlesState, CatalogState, TokenUsage } from './types';

/** 合计用量的展示口径（保留分项，便于判断是否需要渲染） */
export interface UsageTotals {
  /** 非缓存输入 */
  input: number;
  /** 缓存读 */
  cacheRead: number;
  /** 缓存写 */
  cacheWrite: number;
  /** 输出 */
  output: number;
  /** 输入侧总量 = input + cacheRead + cacheWrite */
  totalInput: number;
  /** 全部 token = totalInput + output */
  total: number;
}

/** TokenUsage → 展示口径 */
export function toUsageTotals(usage: TokenUsage): UsageTotals {
  const input = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens;
  const totalInput = input + cacheRead + cacheWrite;

  return { input, cacheRead, cacheWrite, output, totalInput, total: totalInput + output };
}

/**
 * 目录 + 全部页面（含失败页的最后一次快照）的合计。
 *
 * 直接遍历 `articles.pages`（而不是 wikiPages）：即使某页在列表重建前已经产生过
 * 用量，只要它的状态槽位还在就会被计入。
 */
export function collectUsageTotals(catalog: CatalogState, articles: ArticlesState): UsageTotals {
  const usages: Array<TokenUsage | undefined> = [catalog.usage];
  for (const page of Object.values(articles.pages)) {
    usages.push(page.usage);
  }
  return toUsageTotals(sumTokenUsage(usages));
}

/** 缓存读占输入侧总量的比例（0-1；没有任何输入时为 0） */
export function cacheHitRatio(totals: UsageTotals): number {
  return totals.totalInput > 0 ? totals.cacheRead / totals.totalInput : 0;
}

/** 占比文案（一位小数，例如 `62.3%`） */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
