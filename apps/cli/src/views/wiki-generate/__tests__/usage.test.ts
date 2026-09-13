/**
 * usage.test.ts —— 生成页用量合计（纯函数）
 *
 * 覆盖：输入侧口径（含缓存读写）、跨页面归并、失败页快照、
 * 重试/重新生成的 carryUsage 结转（成功 + 失败 + 重试不清零）、
 * 缓存占比边界（0 输入 / 全命中）与文案格式。
 *
 * 运行：bun test apps/cli/src/views/wiki-generate/__tests__（已并入 bun run test:tui）
 */

import { describe, expect, test } from 'bun:test';
import { cacheHitRatio, collectUsageTotals, formatPercent, slotUsageTotal, toUsageTotals } from '../usage';
import type { ArticlesState, CatalogState, PageStatus, TokenUsage } from '../types';

const catalogState = (usage?: TokenUsage): CatalogState => ({ status: 'completed', usage });

const articlesState = (pages: Record<string, PageStatus>): ArticlesState => ({
  pages,
  completedCount: 0,
  failedCount: 0,
  pendingCount: 0,
});

describe('toUsageTotals', () => {
  test('输入侧总量 = 非缓存输入 + 缓存读 + 缓存写', () => {
    const totals = toUsageTotals({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 20,
    });

    expect(totals).toEqual({
      input: 100,
      cacheRead: 300,
      cacheWrite: 20,
      output: 40,
      totalInput: 420,
      total: 460,
    });
  });

  test('缓存字段缺失按 0 处理（不支持缓存的 provider / 旧数据）', () => {
    const totals = toUsageTotals({ input_tokens: 10, output_tokens: 5 });

    expect(totals.cacheRead).toBe(0);
    expect(totals.cacheWrite).toBe(0);
    expect(totals.totalInput).toBe(10);
    expect(totals.total).toBe(15);
  });
});

describe('collectUsageTotals', () => {
  test('目录 + 全部页面逐字段求和，未上报的用量跳过', () => {
    const totals = collectUsageTotals(
      catalogState({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 }),
      articlesState({
        a: {
          status: 'completed',
          usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 100 },
        },
        b: { status: 'loading' }, // 尚未上报用量
        c: { status: 'failed', usage: { input_tokens: 30, output_tokens: 3 } }, // 失败页的最后快照
      }),
    );

    expect(totals.input).toBe(330);
    expect(totals.cacheRead).toBe(150);
    expect(totals.output).toBe(33);
    expect(totals.totalInput).toBe(480);
    expect(totals.total).toBe(513);
  });

  test('空状态全为 0（渲染层据此不显示合计行）', () => {
    const totals = collectUsageTotals(catalogState(), articlesState({}));

    expect(totals.total).toBe(0);
    expect(totals.totalInput).toBe(0);
  });

  test('页面重新生成：上一轮结转到 carryUsage，合计不回退（成功 + 失败 + 重试）', () => {
    // 重试前的槽位：本轮快照 usage
    const before = collectUsageTotals(
      catalogState(),
      articlesState({
        a: { status: 'completed', usage: { input_tokens: 500, output_tokens: 100 } },
      }),
    );
    // 重试中：上一轮结转到 carryUsage，本轮快照在累积
    const during = collectUsageTotals(
      catalogState(),
      articlesState({
        a: {
          status: 'loading',
          carryUsage: { input_tokens: 500, output_tokens: 100 },
          usage: { input_tokens: 80, output_tokens: 20 },
        },
      }),
    );
    // 重试完成：合计 = 上一轮 + 本轮
    const after = collectUsageTotals(
      catalogState(),
      articlesState({
        a: {
          status: 'completed',
          carryUsage: { input_tokens: 500, output_tokens: 100 },
          usage: { input_tokens: 600, output_tokens: 120 },
        },
      }),
    );

    expect(before.total).toBe(600);
    expect(during.total).toBe(700); // 不会因重试回退到 0/80
    expect(after.total).toBe(1320); // (500+600) + (100+120)
  });

  test('目录重试：carryUsage 与本轮 usage 一起计入', () => {
    const totals = collectUsageTotals(
      { status: 'loading', carryUsage: { input_tokens: 150, output_tokens: 30 } },
      articlesState({}),
    );

    expect(totals.input).toBe(150);
    expect(totals.output).toBe(30);
  });

  test('幂等：同一份快照反复归并结果不变（并发中间事件重复上报）', () => {
    const catalog = catalogState({ input_tokens: 10, output_tokens: 1 });
    const articles = articlesState({
      a: { status: 'loading', usage: { input_tokens: 20, output_tokens: 2 } },
      b: { status: 'loading', usage: { input_tokens: 30, output_tokens: 3 } },
    });

    expect(collectUsageTotals(catalog, articles)).toEqual(collectUsageTotals(catalog, articles));
    expect(collectUsageTotals(catalog, articles).total).toBe(66);
  });
});

describe('slotUsageTotal', () => {
  test('等于历史结转 + 本轮快照', () => {
    expect(
      slotUsageTotal({
        carryUsage: { input_tokens: 50, output_tokens: 5 },
        usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 7 },
      }),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 7,
    });
  });

  test('只有结转时返回结转值（重试刚开始、本轮尚无快照）', () => {
    expect(slotUsageTotal({ carryUsage: { input_tokens: 50, output_tokens: 5 } })).toEqual({
      input_tokens: 50,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test('两者都缺失时全为 0（行内不渲染用量）', () => {
    expect(slotUsageTotal({})).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe('cacheHitRatio / formatPercent', () => {
  test('缓存占比 = 缓存读 / 输入侧总量', () => {
    const totals = toUsageTotals({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 300 });

    expect(cacheHitRatio(totals)).toBeCloseTo(0.75, 6);
    expect(formatPercent(cacheHitRatio(totals))).toBe('75.0%');
  });

  test('没有任何输入时占比为 0（不出现 NaN / Infinity）', () => {
    expect(cacheHitRatio(toUsageTotals({ input_tokens: 0, output_tokens: 12 }))).toBe(0);
    expect(formatPercent(0)).toBe('0.0%');
  });

  test('全部命中缓存时为 100%', () => {
    const totals = toUsageTotals({ input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 500 });

    expect(cacheHitRatio(totals)).toBe(1);
    expect(formatPercent(1)).toBe('100.0%');
  });
});
