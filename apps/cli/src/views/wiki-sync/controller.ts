/**
 * WikiSyncController - Wiki 同步流程控制（pi-tui 版）
 *
 * 由迁移前的 useWikiSync Hook 改写而来，流程不变：
 * 检测 → 规划（LLM） → 执行（归档 + 并发生成 .md）
 */

import { loadConfig, WikiStore } from "@zread-pi/utils";
import type { BlueprintDetailLevel } from "@zread-pi/types";
import {
  generateWikiContent,
  syncWiki,
  type ArticleEventPayload,
  type CatalogEvent,
} from "@zread-pi/orchestrator";
import { createInitialSyncState } from "./state";
import { syncArticleEventToState, syncCatalogEventToState, type SyncCatalogEventPayload } from "./mapper";
import type { WikiSyncState } from "./types";

export interface WikiSyncControllerOptions {
  /** TUI 的 WikiStore（变体感知）：`detail` = 活动变体，`targetDetail` = 写盘目标 */
  wiki: {
    reload: () => Promise<void>;
    detail: BlueprintDetailLevel | null;
    targetDetail: BlueprintDetailLevel;
  };
  onChange: () => void;
}

export class WikiSyncController {
  readonly state: WikiSyncState = createInitialSyncState([]);
  private isRunning = false;

  constructor(private options: WikiSyncControllerOptions) {}

  /** 自动触发同步（等价迁移前的 useEffect(() => { runSync() }, [])） */
  init(): void {
    void this.runSync();
  }

  /** 重试整个同步流程（目录失败时使用） */
  retrySync(): void {
    if (this.isRunning) return;
    const fresh = createInitialSyncState([]);
    this.state.catalog = fresh.catalog;
    this.state.articles = fresh.articles;
    this.state.syncPages = [];
    this.options.onChange();
    void this.runSync();
  }

  /** 重新生成单篇文章（仅 new/updated 有效，archived 无 .md 可生成） */
  async regeneratePage(slug: string): Promise<void> {
    const page = this.state.syncPages.find((p) => p.slug === slug);
    if (!page) return;

    // archived 页面无 .md，跳过
    const syncType =
      this.state.articles.pages[slug]?.syncType ??
      (page.status === "unchanged" ? undefined : page.status);
    if (syncType === "archived") return;

    // 重置状态为 waiting，并更新计数
    const previous = this.state.articles.pages[slug];
    const prevStatus = previous?.status;
    this.state.articles.pages[slug] = { status: "waiting", syncType: previous?.syncType };
    if (prevStatus === "completed") {
      this.state.articles.completedCount = Math.max(0, this.state.articles.completedCount - 1);
      this.state.articles.pendingCount++;
    } else if (prevStatus === "failed") {
      this.state.articles.failedCount = Math.max(0, this.state.articles.failedCount - 1);
      this.state.articles.pendingCount++;
    }
    this.options.onChange();

    const concurrent = await this.loadConcurrency();

    try {
      await generateWikiContent({
        pages: [page],
        detail: this.syncDetail,
        maxConcurrent: concurrent,
        onEvent: (event) => this.handleArticleEvent(event),
      });
    } catch (err) {
      this.handleArticleEvent({
        type: "page_error",
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ==================== 内部实现 ====================

  /**
   * 同步读写的档位变体：优先活动变体，否则用配置档位
   * （若目标档位尚无 wiki.json，syncWiki 会报可读错误）。
   */
  private get syncDetail(): BlueprintDetailLevel {
    return this.options.wiki.detail ?? this.options.wiki.targetDetail;
  }

  private async runSync(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // 阶段1-2: syncWiki（只读写一个变体目录）
      const detail = this.syncDetail;
      const result = await syncWiki((event) => this.handleCatalogEvent(event), { detail });

      // 设置 syncPages
      const allPages = [
        ...result.diff.newPages,
        ...result.diff.updatedPages,
        ...result.diff.archivedPages,
      ];

      this.state.syncPages = allPages;
      this.state.articles = createInitialSyncState(allPages).articles;
      this.options.onChange();

      // 阶段3: 执行
      // 3a: 归档（变体目录内 `<detail>/archived/...`）
      const store = new WikiStore(detail);
      for (const page of result.diff.archivedPages) {
        await store.archivePage(page);
      }

      // 3b: 创建快照
      await store.createSnapshot();

      // 3c: 重载 wiki.json（syncWiki 已写入新 wiki.json）
      await this.options.wiki.reload();

      // 3d: 并发生成 new + updated 的 .md
      if (result.diff.newPages.length > 0 || result.diff.updatedPages.length > 0) {
        const concurrent = await this.loadConcurrency();
        await generateWikiContent({
          pages: [...result.diff.newPages, ...result.diff.updatedPages],
          detail,
          maxConcurrent: concurrent,
          onEvent: (event) => this.handleArticleEvent(event),
        });
      }

      // 标记归档页面为完成（无需生成 .md）
      for (const page of result.diff.archivedPages) {
        const pageState = this.state.articles.pages[page.slug];
        if (pageState) {
          pageState.status = "completed";
          this.state.articles.completedCount++;
          this.state.articles.pendingCount = Math.max(0, this.state.articles.pendingCount - 1);
        }
      }
      this.options.onChange();
    } catch (err) {
      this.state.catalog.status = "failed";
      this.state.catalog.error = err instanceof Error ? err.message : String(err);
      this.options.onChange();
    } finally {
      this.isRunning = false;
    }
  }

  private handleCatalogEvent(rawEvent: CatalogEvent): void {
    // 带 `agentKey` 的事件只描述「某一个 Agent」（结构切分 / 分类命名 / 页面命名），
    // 其中终态事件同样是 `complete` / `error`；同步页不展示逐 Agent 行，
    // 错过它们，只让不带该字段的事件驱动目录整体状态。
    if (rawEvent.agentKey) return;

    const event: SyncCatalogEventPayload = {
      type: rawEvent.type,
      toolName: rawEvent.toolName,
      usage: rawEvent.usage,
      error: rawEvent.error,
      durationMs: rawEvent.durationMs,
      retryCount: rawEvent.retryCount,
      maxRetries: rawEvent.maxRetries,
      delayMs: rawEvent.delayMs,
    };
    this.state.catalog = syncCatalogEventToState(this.state.catalog, event);
    this.options.onChange();
  }

  private handleArticleEvent(event: ArticleEventPayload): void {
    this.state.articles = syncArticleEventToState(this.state.articles, event);
    this.options.onChange();
  }

  private async loadConcurrency(): Promise<number> {
    try {
      const config = await loadConfig();
      return config.concurrency.max_concurrent;
    } catch {
      return 1;
    }
  }
}
