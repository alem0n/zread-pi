/**
 * mapper.test.ts —— 生成页事件 → 状态映射的纯函数断言
 *
 * 重点覆盖两件事（底部合计行能反映真实消耗的前提）：
 * 1. 失败事件不带用量时不清零（失败页 / 失败目录也要计入合计）；
 * 2. 重试 / 重新生成把上一轮用量结转到 carryUsage，而不是清空槽位。
 *
 * 运行：bun test apps/cli/src/views/wiki-generate/__tests__（已并入 bun run test:tui）
 */

import { describe, expect, test } from 'bun:test';
import type { WikiPage } from '@zread-pi/types';
import { articleEventToState, catalogEventToState } from '../mapper';
import { createInitialArticlesState, initialCatalogState } from '../state';
import { slotUsageTotal } from '../usage';
import type { TokenUsage } from '../types';

const usage: TokenUsage = { input_tokens: 100, output_tokens: 50 };

function makePage(slug = 'a'): WikiPage {
  return { slug, title: slug, file: `${slug}.md`, section: 'core', level: 'Beginner' };
}

describe('catalogEventToState', () => {
  test('error 不带 usage 时保留最后一次快照', () => {
    const loading = catalogEventToState(initialCatalogState, { type: 'responding', usage });
    const failed = catalogEventToState(loading, { type: 'error', error: 'boom' });

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.usage).toEqual(usage);
  });

  test('error 带 usage 时使用最新值', () => {
    const loading = catalogEventToState(initialCatalogState, { type: 'responding', usage });
    const latest: TokenUsage = { input_tokens: 200, output_tokens: 60 };
    const failed = catalogEventToState(loading, { type: 'error', error: 'boom', usage: latest });

    expect(failed.usage).toEqual(latest);
  });

  test('complete 使用事件里的权威累计用量', () => {
    const done = catalogEventToState(initialCatalogState, {
      type: 'complete',
      usage: { input_tokens: 300, output_tokens: 80 },
      durationMs: 1234,
    });

    expect(done.status).toBe('completed');
    expect(done.usage).toEqual({ input_tokens: 300, output_tokens: 80 });
  });

  test('重试目录（scanning）把上一轮用量结转到 carryUsage（幂等）', () => {
    const failed = catalogEventToState(initialCatalogState, { type: 'responding', usage });

    const restarted = catalogEventToState(failed, { type: 'scanning' });
    expect(restarted.status).toBe('loading');
    expect(restarted.usage).toBeUndefined();
    expect(restarted.carryUsage).toMatchObject(usage);
    expect(slotUsageTotal(restarted)).toMatchObject(usage);

    // parsing 与 scanning 同属一轮起点：重复结转不改变结果
    const parsed = catalogEventToState(restarted, { type: 'parsing' });
    expect(slotUsageTotal(parsed)).toMatchObject(usage);
  });

  test('complete / error 不丢 carryUsage（重试后的终态仍保留历史用量）', () => {
    const restarted = catalogEventToState(
      catalogEventToState(initialCatalogState, { type: 'responding', usage }),
      { type: 'scanning' },
    );
    const latest: TokenUsage = { input_tokens: 40, output_tokens: 8 };

    const done = catalogEventToState(restarted, { type: 'complete', usage: latest, durationMs: 1 });
    expect(slotUsageTotal(done)).toEqual({
      input_tokens: usage.input_tokens + latest.input_tokens,
      output_tokens: usage.output_tokens + latest.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const failed = catalogEventToState(restarted, { type: 'error', error: 'boom' });
    expect(slotUsageTotal(failed)).toMatchObject(usage);
  });

  test('三阶段：stage / section / 分类级进度会写进目录状态', () => {
    let state = catalogEventToState(initialCatalogState, {
      type: 'requesting',
      stage: 'classify',
    });
    expect(state.stage).toBe('classify');
    expect(state.sectionsProgress).toBeUndefined();

    state = catalogEventToState(state, {
      type: 'requesting',
      stage: 'topics',
      section: '核心架构',
      progress: { current: 1, total: 4 },
    });
    expect(state.stage).toBe('topics');
    expect(state.section).toBe('核心架构');
    expect(state.sectionsProgress).toEqual({ current: 1, total: 4 });

    state = catalogEventToState(state, {
      type: 'tool_result',
      stage: 'titles',
      section: '核心架构',
      progress: { current: 3, total: 4 },
    });
    expect(state.stage).toBe('titles');
    expect(state.sectionsProgress).toEqual({ current: 3, total: 4 });
  });

  test('重新开始（scanning）会清空上一轮的阶段展示', () => {
    const loading = catalogEventToState(initialCatalogState, {
      type: 'requesting',
      stage: 'topics',
      section: '核心架构',
      progress: { current: 1, total: 4 },
    });
    const restarted = catalogEventToState(loading, { type: 'scanning' });

    expect(restarted.stage).toBeUndefined();
    expect(restarted.section).toBeUndefined();
    expect(restarted.sectionsProgress).toBeUndefined();
    expect(restarted.failedSections).toBeUndefined();
  });

  test('complete 携带失败分类（单分类失败不阻断整体）', () => {
    const failed = [{ section: '核心模块', stage: 'topics' as const, error: '模型未调用 submit_section_topics' }];
    const done = catalogEventToState(initialCatalogState, {
      type: 'complete',
      usage,
      durationMs: 10,
      failedSections: failed,
    });

    expect(done.status).toBe('completed');
    expect(done.failedSections).toEqual(failed);
  });
});

// ==================== 逐 Agent 行（每个 Agent 一行） ====================

describe('catalogEventToState（逐 Agent 行）', () => {
  const plan = {
    type: 'requesting' as const,
    stage: 'topics' as const,
    section: '核心架构',
    agentKey: 'topics:核心架构',
    agentRole: 'topics' as const,
    agentStatus: 'waiting' as const,
  };

  test('计划事件建立等待行（还没有用量）', () => {
    const state = catalogEventToState(initialCatalogState, plan);
    const agent = state.agents?.['topics:核心架构'];

    expect(state.status).toBe('loading');
    expect(agent?.status).toBe('waiting');
    expect(agent?.role).toBe('topics');
    expect(agent?.section).toBe('核心架构');
    expect(agent?.usage).toBeUndefined();
  });

  test('运行事件的行内用量取 agentUsage（不是目录级聚合）', () => {
    let state = catalogEventToState(initialCatalogState, plan);
    state = catalogEventToState(state, {
      type: 'responding',
      stage: 'topics',
      section: '核心架构',
      agentKey: 'topics:核心架构',
      agentRole: 'topics',
      agentStatus: 'running',
      agentUsage: usage,
      contextTokens: 24_000,
      contextWindow: 200_000,
      // 目录级聚合（usage）不能进这一行
      usage: { input_tokens: 999, output_tokens: 9 },
    });

    const agent = state.agents?.['topics:核心架构'];
    expect(agent?.status).toBe('loading');
    expect(agent?.phase).toBe('responding');
    expect(agent?.usage).toEqual(usage);
    expect(agent?.contextTokens).toBe(24_000);
    expect(agent?.contextWindow).toBe(200_000);
    expect(state.usage).toEqual({ input_tokens: 999, output_tokens: 9 });
  });

  test('单个 Agent 的终态事件改行不改目录整体状态', () => {
    const running = catalogEventToState(initialCatalogState, {
      ...plan,
      agentStatus: 'running',
    });

    const done = catalogEventToState(running, {
      type: 'complete',
      stage: 'topics',
      section: '核心架构',
      agentKey: 'topics:核心架构',
      agentRole: 'topics',
      agentStatus: 'completed',
      agentUsage: usage,
      contextTokens: 1000,
      contextWindow: 200_000,
      durationMs: 500,
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    expect(done.status).toBe('loading'); // 目录整体仍在跑
    expect(done.agents?.['topics:核心架构']?.status).toBe('completed');
    expect(done.agents?.['topics:核心架构']?.durationMs).toBe(500);

    // 业务判失败（markAgentFailed）：Agent 运行正常结束也会被改成失败行
    const failed = catalogEventToState(done, {
      type: 'error',
      stage: 'topics',
      section: '核心架构',
      agentKey: 'topics:核心架构',
      agentRole: 'topics',
      agentStatus: 'failed',
      error: '模型未调用 submit_section_topics',
    });

    expect(failed.status).toBe('loading');
    const agent = failed.agents?.['topics:核心架构'];
    expect(agent?.status).toBe('failed');
    expect(agent?.error).toContain('submit_section_topics');
    // 终态事件不带用量 / 上下文 / 耗时时，保留旧值（已完成行也要继续显示指标）
    expect(agent?.usage).toEqual(usage);
    expect(agent?.contextTokens).toBe(1000);
    expect(agent?.contextWindow).toBe(200_000);
    expect(agent?.durationMs).toBe(500);
  });

  test('目录整体 complete 保留 Agent 行（完成后仍可展示逐 Agent 指标）', () => {
    const running = catalogEventToState(initialCatalogState, plan);
    const done = catalogEventToState(running, {
      type: 'complete',
      usage: { input_tokens: 1000, output_tokens: 200 },
      durationMs: 100,
    });

    expect(done.status).toBe('completed');
    expect(done.agents?.['topics:核心架构']?.status).toBe('waiting');
  });

  test('scanning 清空上一轮的 Agent 行（新一轮重新规划）', () => {
    const running = catalogEventToState(initialCatalogState, { ...plan, agentStatus: 'running' });
    const restarted = catalogEventToState(running, { type: 'scanning' });

    expect(restarted.agents).toEqual({});
  });
});

describe('articleEventToState', () => {
  test('page_error 不带 usage 时保留该页最后一次快照', () => {
    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    state = articleEventToState(state, { type: 'responding', slug: 'a', usage });
    state = articleEventToState(state, { type: 'page_error', slug: 'a', error: 'boom' });

    expect(state.pages.a.status).toBe('failed');
    expect(state.pages.a.error).toBe('boom');
    expect(state.pages.a.usage).toEqual(usage);
  });

  test('page_complete 使用事件里的权威累计用量', () => {
    let state = createInitialArticlesState([makePage()]);
    const latest: TokenUsage = { input_tokens: 400, output_tokens: 90 };
    state = articleEventToState(state, {
      type: 'page_complete',
      slug: 'a',
      usage: latest,
      durationMs: 100,
      outputPath: 'core/a.md',
    });

    expect(state.pages.a.usage).toEqual(latest);
  });

  test('重新生成（page_start）把上一轮用量结转到 carryUsage，而不是清零', () => {
    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_complete', slug: 'a', usage, durationMs: 1 });
    expect(state.pages.a.usage).toEqual(usage);

    state = articleEventToState(state, { type: 'page_start', slug: 'a' });

    expect(state.pages.a.usage).toBeUndefined();
    expect(state.pages.a.carryUsage).toMatchObject(usage); // 历史消耗留住了
    expect(slotUsageTotal(state.pages.a)).toMatchObject(usage);
  });

  test('retry 事件不带 usage 时保留本轮快照（重试不清槽位）', () => {
    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    state = articleEventToState(state, { type: 'responding', slug: 'a', usage });
    state = articleEventToState(state, {
      type: 'retry',
      slug: 'a',
      retryCount: 1,
      maxRetries: 3,
      delayMs: 2000,
      error: '429',
    });

    expect(state.pages.a.phase).toBe('retry');
    expect(state.pages.a.usage).toMatchObject(usage);
    expect(slotUsageTotal(state.pages.a)).toMatchObject(usage);
  });

  test('页面事件带上下文报表值（已用 / 窗口），终态沿用、重新生成清零', () => {
    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    state = articleEventToState(state, {
      type: 'responding',
      slug: 'a',
      usage,
      contextTokens: 1500,
      contextWindow: 200_000,
    });

    expect(state.pages.a.contextTokens).toBe(1500);
    expect(state.pages.a.contextWindow).toBe(200_000);

    // 终态事件不带上下文时沿用最后一次（完成行仍能显示上下文占比）
    state = articleEventToState(state, { type: 'page_complete', slug: 'a', usage, durationMs: 1 });
    expect(state.pages.a.contextTokens).toBe(1500);
    expect(state.pages.a.contextWindow).toBe(200_000);

    // 重新生成是新的一轮：不沿用上一轮的上下文报表值
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    expect(state.pages.a.contextTokens).toBeUndefined();
    expect(state.pages.a.contextWindow).toBeUndefined();
  });

  test('失败页重试：合计 = 上一轮（含失败估算）+ 本轮实时快照（成功 + 失败 + 重试）', () => {
    const failedUsage: TokenUsage = { input_tokens: 300, output_tokens: 60 };
    const inProgress: TokenUsage = { input_tokens: 80, output_tokens: 10 };
    const finalUsage: TokenUsage = { input_tokens: 500, output_tokens: 120 };

    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    state = articleEventToState(state, { type: 'responding', slug: 'a', usage: failedUsage });
    state = articleEventToState(state, { type: 'page_error', slug: 'a', error: 'boom' });
    expect(slotUsageTotal(state.pages.a)).toMatchObject(failedUsage);

    // 重试：先结转上一轮，再叠加本轮快照
    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    state = articleEventToState(state, { type: 'responding', slug: 'a', usage: inProgress });
    expect(slotUsageTotal(state.pages.a)).toEqual({
      input_tokens: failedUsage.input_tokens + inProgress.input_tokens,
      output_tokens: failedUsage.output_tokens + inProgress.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    state = articleEventToState(state, { type: 'page_complete', slug: 'a', usage: finalUsage, durationMs: 2 });
    expect(slotUsageTotal(state.pages.a)).toEqual({
      input_tokens: failedUsage.input_tokens + finalUsage.input_tokens,
      output_tokens: failedUsage.output_tokens + finalUsage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});
