/**
 * 同步初始状态工厂（纯函数）
 */

import type { WikiPage } from '@open-zread/types';
import type { SyncCatalogState, SyncArticlesState, SyncPageState, WikiSyncState } from './types';

export const initialSyncCatalogState: SyncCatalogState = {
  status: 'waiting',
};

export const initialSyncPageState: SyncPageState = {
  status: 'waiting',
};

export function createInitialSyncArticlesState(pages: WikiPage[]): SyncArticlesState {
  const pageStatuses: Record<string, SyncPageState> = {};
  for (const page of pages) {
    pageStatuses[page.slug] = {
      ...initialSyncPageState,
      syncType: page.status === 'unchanged' ? undefined : (page.status as SyncPageState['syncType']),
    };
  }
  return {
    pages: pageStatuses,
    completedCount: 0,
    failedCount: 0,
    pendingCount: pages.length,
  };
}

export function createInitialSyncState(pages: WikiPage[]): WikiSyncState {
  return {
    catalog: initialSyncCatalogState,
    articles: createInitialSyncArticlesState(pages),
    syncPages: pages,
  };
}
