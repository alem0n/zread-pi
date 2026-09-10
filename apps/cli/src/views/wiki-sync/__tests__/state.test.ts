import { describe, test, expect } from 'bun:test';
import type { WikiPage } from '@open-zread/types';
import {
  initialSyncCatalogState,
  initialSyncPageState,
  createInitialSyncArticlesState,
  createInitialSyncState,
} from '../state';

function makePage(slug: string, status?: WikiPage['status']): WikiPage {
  return {
    slug,
    title: slug,
    file: `${slug}.md`,
    section: 'core',
    level: 'Beginner',
    status,
  };
}

describe('initial state constants', () => {
  test('catalog 初始为 waiting', () => {
    expect(initialSyncCatalogState).toEqual({ status: 'waiting' });
  });

  test('page 初始为 waiting', () => {
    expect(initialSyncPageState).toEqual({ status: 'waiting' });
  });
});

describe('createInitialSyncArticlesState', () => {
  test('空列表返回空 pages 与 0 计数', () => {
    const state = createInitialSyncArticlesState([]);
    expect(state).toEqual({
      pages: {},
      completedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    });
  });

  test('依据页面 status 推导 syncType（unchanged → undefined）', () => {
    const pages: WikiPage[] = [
      makePage('a', 'unchanged'),
      makePage('b', 'new'),
      makePage('c', 'updated'),
      makePage('d', 'archived'),
    ];

    const state = createInitialSyncArticlesState(pages);

    expect(state.pendingCount).toBe(4);
    expect(state.completedCount).toBe(0);
    expect(state.failedCount).toBe(0);

    expect(state.pages.a).toEqual({ status: 'waiting', syncType: undefined });
    expect(state.pages.b).toEqual({ status: 'waiting', syncType: 'new' });
    expect(state.pages.c).toEqual({ status: 'waiting', syncType: 'updated' });
    expect(state.pages.d).toEqual({ status: 'waiting', syncType: 'archived' });
  });

  test('页面无 status 字段时 syncType 为 undefined', () => {
    const state = createInitialSyncArticlesState([makePage('a')]);
    expect(state.pages.a.syncType).toBeUndefined();
  });
});

describe('createInitialSyncState', () => {
  test('聚合 catalog/articles/syncPages', () => {
    const pages = [makePage('a', 'new'), makePage('b', 'updated')];
    const state = createInitialSyncState(pages);

    expect(state.catalog).toEqual(initialSyncCatalogState);
    expect(state.syncPages).toBe(pages);
    expect(state.articles.pendingCount).toBe(2);
    expect(state.articles.pages.a.syncType).toBe('new');
    expect(state.articles.pages.b.syncType).toBe('updated');
  });
});
