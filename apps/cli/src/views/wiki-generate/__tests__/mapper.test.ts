/**
 * mapper.test.ts —— 生成页事件 → 状态映射的纯函数断言
 *
 * 重点覆盖「失败事件不带用量时不清零」：这是底部合计行能反映真实消耗的前提
 * （失败页/失败目录也要计入合计）。
 *
 * 运行：bun test apps/cli/src/views/wiki-generate/__tests__（已并入 bun run test:tui）
 */

import { describe, expect, test } from 'bun:test';
import type { WikiPage } from '@zread-pi/types';
import { articleEventToState, catalogEventToState } from '../mapper';
import { createInitialArticlesState, initialCatalogState } from '../state';
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

  test('重新生成该页（page_start）会清空上一轮用量', () => {
    let state = createInitialArticlesState([makePage()]);
    state = articleEventToState(state, { type: 'page_complete', slug: 'a', usage, durationMs: 1 });
    expect(state.pages.a.usage).toEqual(usage);

    state = articleEventToState(state, { type: 'page_start', slug: 'a' });
    expect(state.pages.a.usage).toBeUndefined();
  });
});
