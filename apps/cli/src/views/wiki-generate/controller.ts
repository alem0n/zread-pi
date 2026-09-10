/**
 * WikiGenerateController - Wiki 生成流程控制（pi-tui 版）
 *
 * 由迁移前的三个 Hook 合并而来，流程与判定条件保持不变：
 * - useCatalogGenerate：扫描 → 解析 → 缓存 → 生成目录（失败可 r 重试）
 * - useArticlesGenerate：检测已存在文档 → 并发生成缺失页面 → 支持单页重新生成
 * - useWikiGenerate：编排两者（目录完成后 reload wiki.json 再启动文章生成）
 */

import { parseFiles, scanFiles } from "@open-zread/repo-analyzer";
import {
  fileExists,
  getWikiDir,
  getWikiJsonPath,
  joinPath,
  loadConfig,
  removeDir,
  saveCachedManifest,
  saveCachedSymbols,
} from "@open-zread/utils";
import {
  generateWikiCatalog,
  generateWikiContent,
  type ArticleEventPayload,
  type CatalogEvent,
} from "@open-zread/orchestrator";
import { articleEventToState, catalogEventToState } from "./mapper";
import { createInitialArticlesState, initialCatalogState } from "./state";
import type { WikiStore } from "../../state/wiki-store";
import type { CatalogEventPayload, CatalogState, WikiGenerateState, WikiPage } from "./types";

type FlowState =
  | "idle"
  | "catalog-generating"
  | "waiting-pages"
  | "articles-generating"
  | "completed";

export interface WikiGenerateControllerOptions {
  forceRegenerate: boolean;
  wiki: WikiStore;
  onChange: () => void;
}

export class WikiGenerateController {
  readonly state: WikiGenerateState;

  private flowState: FlowState = "idle";
  private isGeneratingCatalog = false;
  private isGeneratingArticles = false;
  private isInitialized = false;
  private startedArticles = false;

  constructor(private options: WikiGenerateControllerOptions) {
    // wikiPages 实时跟随 WikiStore（等价迁移前 useMemo(wikiCatalog?.pages ?? [])）
    const controller = this;
    this.state = {
      catalog: { ...initialCatalogState },
      articles: createInitialArticlesState([]),
      get wikiPages() {
        return controller.pages;
      },
    };
  }

  // ==================== 派生状态 ====================

  get hasWikiCatalog(): boolean {
    return !this.options.forceRegenerate && this.options.wiki.catalog !== null;
  }

  get catalogCompleted(): boolean {
    return this.state.catalog.status === "completed";
  }

  get articlesCompleted(): boolean {
    const pages = this.pages;
    return this.state.articles.completedCount === pages.length && pages.length > 0;
  }

  get allCompleted(): boolean {
    return this.catalogCompleted && this.articlesCompleted;
  }

  private get pages(): WikiPage[] {
    return this.options.wiki.catalog?.pages ?? [];
  }

  // ==================== 生命周期 ====================

  /** 等价迁移前挂载后的各 useEffect：已有目录直接进入文章流程，否则自动开始生成目录 */
  init(): void {
    if (
      this.hasWikiCatalog &&
      !this.options.forceRegenerate &&
      this.state.catalog.status === "waiting"
    ) {
      this.state.catalog = { ...initialCatalogState, status: "completed" };
    }

    this.maybeStartCatalog();
    this.reconcile();
    this.options.onChange();
  }

  /** 目录失败时重试（r 键） */
  retryCatalog(): void {
    this.state.catalog = { ...initialCatalogState };
    this.flowState = "idle";
    this.maybeStartCatalog();
    this.reconcile();
    this.options.onChange();
  }

  /** 重新生成单篇文章（r 键） */
  async regeneratePage(slug: string): Promise<void> {
    const page = this.pages.find((p) => p.slug === slug);
    if (!page) return;

    // 先将状态改为 waiting，并同步计数
    const previous = { ...this.state.articles };
    const prevStatus = previous.pages[slug]?.status;
    const pages = { ...previous.pages, [slug]: { status: "waiting" } as const };
    let { completedCount, failedCount, pendingCount } = previous;
    if (prevStatus === "completed") {
      completedCount--;
      pendingCount++;
    } else if (prevStatus === "failed") {
      failedCount--;
      pendingCount++;
    }
    this.state.articles = {
      ...previous,
      pages,
      completedCount,
      failedCount,
      pendingCount,
    };
    this.options.onChange();

    const concurrent = await this.loadConcurrency();

    try {
      await generateWikiContent({
        pages: [page],
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

  // ==================== 目录生成 ====================

  private maybeStartCatalog(): void {
    const shouldStart =
      (!this.hasWikiCatalog || this.options.forceRegenerate) &&
      this.state.catalog.status === "waiting" &&
      !this.isGeneratingCatalog;

    if (shouldStart) {
      void this.startCatalog();
    }
  }

  private async startCatalog(): Promise<void> {
    if (this.isGeneratingCatalog) return;
    this.isGeneratingCatalog = true;

    // 强制重新生成时清理旧数据
    if (this.options.forceRegenerate) {
      try {
        await removeDir(getWikiDir());
        await removeDir(getWikiJsonPath());
      } catch {
        // 忽略删除错误（文件不存在等）
      }
    }

    // 扫描阶段
    this.state.catalog = catalogEventToState(initialCatalogState, { type: "scanning" });
    this.flowState = "catalog-generating";
    this.options.onChange();

    try {
      // Phase 1-2: 扫描 + 解析
      const manifest = await scanFiles();
      if (manifest.files.length === 0) {
        this.state.catalog = { status: "failed", error: "No files found" };
        this.options.onChange();
        return;
      }

      // 保存文件清单缓存（用于后续增量更新）
      await saveCachedManifest(manifest);

      const symbols = await parseFiles(manifest);
      await saveCachedSymbols(symbols);

      // Phase 3: 调用 Agent
      await generateWikiCatalog((event) => this.handleCatalogEvent(event));
    } catch (err) {
      this.state.catalog = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      this.options.onChange();
    } finally {
      this.isGeneratingCatalog = false;
    }
  }

  private handleCatalogEvent(rawEvent: CatalogEvent): void {
    const event: CatalogEventPayload = {
      type: rawEvent.type,
      toolName: rawEvent.toolName,
      usage: rawEvent.usage,
      error: rawEvent.error,
      durationMs: rawEvent.durationMs,
      retryCount: rawEvent.retryCount,
      maxRetries: rawEvent.maxRetries,
      delayMs: rawEvent.delayMs,
    };

    const next = catalogEventToState(this.state.catalog, event);
    if (next !== this.state.catalog) {
      this.state.catalog = next;
      this.options.onChange();
    }

    if (rawEvent.type === "complete") {
      void this.handleCatalogComplete();
    }
  }

  private async handleCatalogComplete(): Promise<void> {
    // 1. reload wiki.json
    await this.options.wiki.reload();
    // 2. 标记等待 pages
    this.flowState = "waiting-pages";
    this.reconcile();
  }

  // ==================== 文章生成 ====================

  /** 等价迁移前的两个 useEffect：等待 pages 后初始化并启动文章生成 */
  private reconcile(): void {
    const pages = this.pages;

    if (
      this.flowState === "waiting-pages" &&
      pages.length > 0 &&
      !this.isInitialized
    ) {
      void this.initializeArticles();
      return;
    }

    if (
      this.hasWikiCatalog &&
      pages.length > 0 &&
      this.flowState === "idle" &&
      !this.isInitialized
    ) {
      void this.initializeArticles();
      return;
    }

    if (this.state.catalog.status === "loading" && this.flowState === "idle") {
      this.flowState = "catalog-generating";
    }
  }

  private async initializeArticles(): Promise<void> {
    const pendingPages = await this.initialize();
    this.isInitialized = true;

    if (!this.startedArticles && pendingPages.length > 0) {
      this.startedArticles = true;
      void this.startArticles(pendingPages);
      this.flowState = "articles-generating";
    } else if (pendingPages.length === 0) {
      this.flowState = "completed";
    }
  }

  /** 检测已存在文档并设置状态，返回待生成的 pages 列表 */
  private async initialize(): Promise<WikiPage[]> {
    const pages = this.pages;
    if (pages.length === 0 || this.isInitialized) return [];

    const wikiDir = getWikiDir();
    const existingSlugs: string[] = [];

    for (const page of pages) {
      const filePath = joinPath(wikiDir, page.section, page.file);
      try {
        const exists = await fileExists(filePath);
        if (exists) {
          existingSlugs.push(page.slug);
        }
      } catch {
        // 文件检查失败，视为不存在
      }
    }

    const pendingCount = pages.length - existingSlugs.length;

    // 一次性更新状态
    const next = createInitialArticlesState(pages);
    for (const slug of existingSlugs) {
      next.pages[slug] = { status: "completed" };
    }
    next.completedCount = existingSlugs.length;
    next.pendingCount = pendingCount;
    this.state.articles = next;
    this.options.onChange();

    // 返回待生成的 pages 列表（避免闭包陷阱）
    return pages.filter((page) => !existingSlugs.includes(page.slug));
  }

  /** 开始生成（由流程控制在 initialize() 完成后显式调用） */
  private async startArticles(pendingPages: WikiPage[]): Promise<void> {
    if (this.isGeneratingArticles || pendingPages.length === 0) return;

    const concurrent = await this.loadConcurrency();
    this.isGeneratingArticles = true;

    try {
      await generateWikiContent({
        pages: pendingPages,
        maxConcurrent: concurrent,
        onEvent: (event) => this.handleArticleEvent(event),
      });
      this.flowState = "completed";
      this.options.onChange();
    } catch (err) {
      this.handleArticleEvent({
        type: "page_error",
        slug: pendingPages[0]?.slug ?? "unknown",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isGeneratingArticles = false;
    }
  }

  private handleArticleEvent(event: ArticleEventPayload): void {
    const next = articleEventToState(this.state.articles, event);
    if (next !== this.state.articles) {
      this.state.articles = next;
      this.options.onChange();
    }
  }

  private async loadConcurrency(): Promise<number> {
    try {
      const config = await loadConfig();
      return config.concurrency.max_concurrent;
    } catch {
      // 配置加载失败，使用默认值
      return 1;
    }
  }
}

/** 目录状态类型透出（视图渲染使用） */
export type { CatalogState };
