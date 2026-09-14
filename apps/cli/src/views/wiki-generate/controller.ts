/**
 * WikiGenerateController - Wiki 生成流程控制（pi-tui 版）
 *
 * 由迁移前的三个 Hook 合并而来，流程与判定条件保持不变：
 * - useCatalogGenerate：扫描 → 解析 → 缓存 → 生成目录（失败可 r 重试）
 * - useArticlesGenerate：检测已存在文档 → 并发生成缺失页面 → 支持单页重新生成
 * - useWikiGenerate：编排两者（目录完成后 reload wiki.json 再启动文章生成）
 */

import { parseFiles, scanFiles } from "@zread-pi/repo-analyzer";
import {
  fileExists,
  getWikiDir,
  joinPath,
  loadConfig,
  removeDir,
  saveCachedManifest,
  saveCachedSymbols,
} from "@zread-pi/utils";
import {
  generateWikiCatalog,
  generateWikiContent,
  type ArticleEventPayload,
  type CatalogEvent,
} from "@zread-pi/orchestrator";
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
    // 三阶段流程会先落盘「只有 sections、pages 为空」的骨架；
    // 空骨架不算已有目录（否则会跳过生成、卡在 0 页）。
    // 只看**写盘目标档位**（配置档位）：遗留目录 / 其他档位不算，避免把它们的页面写进新变体。
    return (
      !this.options.forceRegenerate &&
      (this.options.wiki.targetCatalog?.pages?.length ?? 0) > 0
    );
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
    return this.options.wiki.targetCatalog?.pages ?? [];
  }

  /** 写盘目标档位（配置档位；遗留目录不会被写入） */
  private get targetDetail() {
    return this.options.wiki.targetDetail;
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
    // 保留上一轮已消耗的用量（不做清空）：真正「开启新一轮」时由
    // mapper 的 scanning 事件把 usage 结转到 carryUsage（合计 = carry + 本轮）
    this.state.catalog = {
      status: "waiting",
      usage: this.state.catalog.usage,
      carryUsage: this.state.catalog.carryUsage,
    };
    this.flowState = "idle";
    this.maybeStartCatalog();
    this.reconcile();
    this.options.onChange();
  }

  /** 重新生成单篇文章（r 键） */
  async regeneratePage(slug: string): Promise<void> {
    const page = this.pages.find((p) => p.slug === slug);
    if (!page) return;

    // 同一页正在生成时忽略重复触发：两次运行同时写同一槽位会让合计失真
    // （快照是同轮累计值，交错覆盖无法再还原）
    if (this.state.articles.pages[slug]?.status === "loading") return;

    // 先将状态改为 waiting，并同步计数；用量原样保留等待 page_start 结转，
    // 重试不清空槽位（展示口径 = carryUsage + 本轮快照）
    const previous = { ...this.state.articles };
    const prevPage = previous.pages[slug];
    const prevStatus = prevPage?.status;
    const pages = {
      ...previous.pages,
      [slug]: {
        status: "waiting",
        usage: prevPage?.usage,
        carryUsage: prevPage?.carryUsage,
      } as const,
    };
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
        detail: this.targetDetail,
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

    // 强制重新生成时清理旧数据（只清理目标档位变体；遗留目录 / 其他档位不动）
    if (this.options.forceRegenerate) {
      try {
        await removeDir(getWikiDir(this.targetDetail));
      } catch {
        // 忽略删除错误（文件不存在等）
      }
    }

    // 扫描阶段（以当前状态为基准：mapper 会把上一轮 usage 结转到 carryUsage）
    this.state.catalog = catalogEventToState(this.state.catalog, { type: "scanning" });
    this.flowState = "catalog-generating";
    this.options.onChange();

    try {
      // Phase 1-2: 扫描 + 解析
      const manifest = await scanFiles();
      if (manifest.files.length === 0) {
        this.state.catalog = {
          ...this.state.catalog,
          status: "failed",
          error: "No files found",
        };
        this.options.onChange();
        return;
      }

      // 保存文件清单缓存（用于后续增量更新）
      await saveCachedManifest(manifest);

      const symbols = await parseFiles(manifest);
      await saveCachedSymbols(symbols);

      // Phase 3: 调用 Agent（写入目标档位变体目录）
      await generateWikiCatalog((event) => this.handleCatalogEvent(event), {
        detail: this.targetDetail,
      });
    } catch (err) {
      // 保留已消耗的用量与结转（失败也要计入合计，重试不清空）
      this.state.catalog = {
        ...this.state.catalog,
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
      // 三阶段信息：阶段 / 分类 / 分类级进度 / 失败分类
      stage: rawEvent.stage,
      section: rawEvent.section,
      progress: rawEvent.progress,
      failedSections: rawEvent.failedSections,
      // 逐 Agent 信息（每个 Agent 一行）：身份 / 生命周期 / 行内用量 / 上下文报表值
      agentKey: rawEvent.agentKey,
      agentRole: rawEvent.agentRole,
      agentStatus: rawEvent.agentStatus,
      agentUsage: rawEvent.agentUsage,
      contextTokens: rawEvent.contextTokens,
      contextWindow: rawEvent.contextWindow,
    };

    const next = catalogEventToState(this.state.catalog, event);
    if (next !== this.state.catalog) {
      this.state.catalog = next;
      this.options.onChange();
    }

    if (rawEvent.type === "complete" && !rawEvent.agentKey) {
      // 只处理「整个目录完成」；带 agentKey 的 complete 是单个 Agent 的终态
      // （每个 Agent 一行），不能触发 reload + 启动文章生成
      void this.handleCatalogComplete();
    }
  }

  private async handleCatalogComplete(): Promise<void> {
    // 1. reload wiki.json（按当前配置档位重新解析变体）
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

    const wikiDir = getWikiDir(this.targetDetail);
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
        detail: this.targetDetail,
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
