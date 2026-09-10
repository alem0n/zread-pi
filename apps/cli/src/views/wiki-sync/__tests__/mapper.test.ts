import { describe, test, expect } from 'bun:test';
import type { ArticleEventPayload, TokenUsage } from '@open-zread/orchestrator';
import {
  syncCatalogEventToState,
  syncArticleEventToState,
  type SyncCatalogEventPayload,
} from '../mapper';
import { initialSyncCatalogState, initialSyncPageState } from '../state';
import type { SyncArticlesState, SyncPageState } from '../types';

const usage: TokenUsage = { input_tokens: 100, output_tokens: 50 };

describe('syncCatalogEventToState', () => {
  test('scanning → loading + detecting', () => {
    const next = syncCatalogEventToState(initialSyncCatalogState, { type: 'scanning' });
    expect(next).toEqual({ status: 'loading', phase: 'detecting' });
  });

  test('parsing → loading + detecting', () => {
    const next = syncCatalogEventToState(initialSyncCatalogState, { type: 'parsing' });
    expect(next.phase).toBe('detecting');
  });

  test('requesting/responding/tool_start/tool_result/retry → planning，并保留 usage', () => {
    const events: SyncCatalogEventPayload['type'][] = [
      'requesting',
      'responding',
      'tool_start',
      'tool_result',
      'retry',
    ];
    for (const type of events) {
      const next = syncCatalogEventToState(initialSyncCatalogState, { type, usage });
      expect(next.status).toBe('loading');
      expect(next.phase).toBe('planning');
      expect(next.usage).toEqual(usage);
    }
  });

  test('complete → completed，记录耗时与 usage', () => {
    const next = syncCatalogEventToState(initialSyncCatalogState, {
      type: 'complete',
      usage,
      durationMs: 1234,
    });
    expect(next).toEqual({ status: 'completed', usage, durationMs: 1234 });
  });

  test('complete 缺少 durationMs 时回落到 0', () => {
    const next = syncCatalogEventToState(initialSyncCatalogState, { type: 'complete' });
    expect(next.durationMs).toBe(0);
  });

  test('error → failed，记录 error 与 usage', () => {
    const next = syncCatalogEventToState(initialSyncCatalogState, {
      type: 'error',
      error: 'boom',
      usage,
      durationMs: 500,
    });
    expect(next).toEqual({ status: 'failed', error: 'boom', usage, durationMs: 500 });
  });

  test('未知事件类型保持原状态不变', () => {
    const state = { ...initialSyncCatalogState, status: 'loading' as const, phase: 'planning' as const };
    const next = syncCatalogEventToState(state, { type: 'unknown' as SyncCatalogEventPayload['type'] });
    expect(next).toBe(state);
  });
});

function emptyArticlesState(): SyncArticlesState {
  return { pages: {}, completedCount: 0, failedCount: 0, pendingCount: 0 };
}

function articlesStateWith(slug: string, page: SyncPageState, pending = 1): SyncArticlesState {
  return {
    pages: { [slug]: page },
    completedCount: 0,
    failedCount: 0,
    pendingCount: pending,
  };
}

describe('syncArticleEventToState', () => {
  test('未知 slug + page_start 创建 loading 状态', () => {
    const next = syncArticleEventToState(emptyArticlesState(), {
      type: 'page_start',
      slug: 'a',
    } as ArticleEventPayload);
    expect(next.pages.a.status).toBe('loading');
    expect(next.pages.a.phase).toBe('requesting');
  });

  test('requesting/responding 切换 phase 并保留 usage', () => {
    const state = articlesStateWith('a', { ...initialSyncPageState, status: 'loading', phase: 'requesting' });
    const responding = syncArticleEventToState(state, {
      type: 'responding',
      slug: 'a',
      usage,
    } as ArticleEventPayload);
    expect(responding.pages.a.phase).toBe('responding');
    expect(responding.pages.a.usage).toEqual(usage);
  });

  test('tool_start 记录 currentTool 与 phase=tool', () => {
    const state = articlesStateWith('a', { ...initialSyncPageState, status: 'loading' });
    const next = syncArticleEventToState(state, {
      type: 'tool_start',
      slug: 'a',
      toolName: 'Read',
      usage,
    } as ArticleEventPayload);
    expect(next.pages.a.phase).toBe('tool');
    expect(next.pages.a.currentTool).toBe('Read');
  });

  test('tool_result 回到 responding', () => {
    const state = articlesStateWith('a', {
      ...initialSyncPageState,
      status: 'loading',
      phase: 'tool',
      currentTool: 'Read',
    });
    const next = syncArticleEventToState(state, {
      type: 'tool_result',
      slug: 'a',
      usage,
    } as ArticleEventPayload);
    expect(next.pages.a.phase).toBe('responding');
  });

  test('retry 记录 retryCount/maxRetries/delayMs/error', () => {
    const state = articlesStateWith('a', { ...initialSyncPageState, status: 'loading' });
    const next = syncArticleEventToState(state, {
      type: 'retry',
      slug: 'a',
      retryCount: 2,
      maxRetries: 5,
      delayMs: 1000,
      error: 'rate-limit',
      usage,
    } as ArticleEventPayload);
    const page = next.pages.a;
    expect(page.phase).toBe('retry');
    expect(page.retryCount).toBe(2);
    expect(page.maxRetries).toBe(5);
    expect(page.delayMs).toBe(1000);
    expect(page.error).toBe('rate-limit');
  });

  test('page_complete 保留 syncType 并更新计数（loading → completed）', () => {
    const state = articlesStateWith(
      'a',
      { ...initialSyncPageState, status: 'loading', syncType: 'new' },
      1,
    );
    const next = syncArticleEventToState(state, {
      type: 'page_complete',
      slug: 'a',
      usage,
      durationMs: 2000,
      outputPath: '/out/a.md',
    } as ArticleEventPayload);

    expect(next.pages.a).toEqual({
      status: 'completed',
      syncType: 'new',
      usage,
      durationMs: 2000,
      outputPath: '/out/a.md',
    });
    expect(next.completedCount).toBe(1);
    expect(next.failedCount).toBe(0);
    expect(next.pendingCount).toBe(0);
  });

  test('page_error 保留 syncType 并更新 failedCount', () => {
    const state = articlesStateWith(
      'a',
      { ...initialSyncPageState, status: 'loading', syncType: 'updated' },
      1,
    );
    const next = syncArticleEventToState(state, {
      type: 'page_error',
      slug: 'a',
      error: 'boom',
      usage,
      durationMs: 500,
    } as ArticleEventPayload);

    expect(next.pages.a.status).toBe('failed');
    expect(next.pages.a.syncType).toBe('updated');
    expect(next.pages.a.error).toBe('boom');
    expect(next.failedCount).toBe(1);
    expect(next.pendingCount).toBe(0);
    expect(next.completedCount).toBe(0);
  });

  test('page_complete 缺少 durationMs 时回落到 0', () => {
    const state = articlesStateWith('a', { ...initialSyncPageState, status: 'loading' });
    const next = syncArticleEventToState(state, {
      type: 'page_complete',
      slug: 'a',
    } as ArticleEventPayload);
    expect(next.pages.a.durationMs).toBe(0);
  });

  test('多次同状态转换不会重复计数', () => {
    const state = articlesStateWith(
      'a',
      { ...initialSyncPageState, status: 'completed', syncType: 'new' },
      0,
    );
    state.completedCount = 1;

    const next = syncArticleEventToState(state, {
      type: 'page_complete',
      slug: 'a',
      durationMs: 100,
    } as ArticleEventPayload);

    expect(next.completedCount).toBe(1);
    expect(next.pendingCount).toBe(0);
  });

  test('未知事件类型返回原 state 引用', () => {
    const state = articlesStateWith('a', { ...initialSyncPageState, status: 'loading' });
    const next = syncArticleEventToState(state, {
      type: 'unknown' as ArticleEventPayload['type'],
      slug: 'a',
    } as ArticleEventPayload);
    expect(next).toBe(state);
  });

  test('不破坏其他页面的状态', () => {
    const state: SyncArticlesState = {
      pages: {
        a: { ...initialSyncPageState, status: 'loading', syncType: 'new' },
        b: { ...initialSyncPageState, status: 'completed', syncType: 'updated' },
      },
      completedCount: 1,
      failedCount: 0,
      pendingCount: 1,
    };
    const next = syncArticleEventToState(state, {
      type: 'page_complete',
      slug: 'a',
      durationMs: 10,
    } as ArticleEventPayload);
    expect(next.pages.b).toBe(state.pages.b);
    expect(next.completedCount).toBe(2);
    expect(next.pendingCount).toBe(0);
  });
});
