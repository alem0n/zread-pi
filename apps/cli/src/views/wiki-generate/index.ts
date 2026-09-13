/**
 * Wiki Generate Page - Wiki 文档生成（pi-tui 版）
 *
 * URL 参数：
 * - mode=generate: 新生成（wiki.json 不存在）
 * - mode=continue: 继续生成（wiki.json 存在，文档未完成）
 * - mode=manage: 管理文档（wiki.json 存在，文档已完成，可重新生成单个）
 * - mode=force: 强制重新生成（忽略现有 wiki.json）
 *
 * 按键：↑↓ 导航 | r 重新生成（目录失败时重试目录） | ctrl+c 退出
 */

import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, statusIcon, statusRow } from "../../tui/components/status";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { theme } from "../../theme";
import { formatBytes, formatDuration } from "../../utils/display";
import { WikiGenerateController } from "./controller";
import { cacheHitRatio, collectUsageTotals, formatPercent, slotUsageTotal } from "./usage";
import type { WikiPage } from "./types";

type ArticleItem = { value: string; page: WikiPage };

export default class WikiGeneratePage extends Screen {
  private controller!: WikiGenerateController;
  private select!: Select<ArticleItem>;
  private selectedSlug: string | null = null;
  private ticker?: ReturnType<typeof setInterval>;
  /** spinner 动画帧（loading 图标轮换用） */
  private spinnerFrame = 0;
  /** 每个 slug 进入 retry 阶段的时间戳（用于倒计时） */
  private retryStartedAt = new Map<string, number>();

  protected override init(): void {
    const mode = this.app.location?.query.get("mode");

    this.controller = new WikiGenerateController({
      forceRegenerate: mode === "force",
      wiki: this.app.wiki,
      onChange: () => {
        this.syncRetryStates();
        this.refresh();
      },
    });

    this.select = new Select<ArticleItem>({
      items: [],
      renderItem: (item, isSelected, width) => [
        this.renderArticleRow(item.page, isSelected, width),
      ],
      onHighlight: (item) => {
        this.selectedSlug = item.page.slug;
      },
    });

    // 重试倒计时需要每秒刷新；loading 图标动画需要每帧刷新
    this.ticker = setInterval(() => {
      const hasRetrying = this.syncRetryStates();
      if (this.hasLoadingItem()) {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.refresh();
      } else if (hasRetrying) {
        this.refresh();
      }
    }, SPINNER_INTERVAL_MS);
  }

  override async onEnter(): Promise<void> {
    // 直接进入该路由时（未经 wiki 首页）也要先加载 wiki.json，再决定是否生成目录
    await this.app.wiki.load();
    this.controller.init();
  }

  override handleKey(data: string): boolean {
    // 目录失败时按 r 重新生成目录
    if (data === "r" && this.controller.state.catalog.status === "failed") {
      this.controller.retryCatalog();
      return true;
    }

    // 选中文章时按 r 重新生成该文章
    if (data === "r" && this.selectedSlug) {
      void this.controller.regeneratePage(this.selectedSlug);
      return true;
    }

    return this.select.handleInput(data);
  }

  override onDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 目录生成部分
    lines.push(...this.renderCatalogSection(width));

    // 底部导航（marginTop={1}）+ 用量合计（有数据时才是最后一行）
    const footer = [
      "",
      style(
        `↑/↓: ${this.t("wikiGenerate.navigate")} | r: ${this.t("wikiGenerate.retry")} | ctrl+c: ${this.t("wikiGenerate.exit")}`,
        { dim: true },
      ),
    ];
    const usageTotals = this.renderUsageTotals();
    if (usageTotals) footer.push(usageTotals);

    // 文章生成部分（目录完成后显示）
    lines.push(...this.renderArticlesSection(width, lines.length, footer.length));

    return [...lines, ...footer];
  }

  /**
   * 底部合计行：全部 Agent（目录 + 每个页面）的输入 / 输出 token 与缓存占比。
   *
   * 用量为 0（尚未开始或打开的文档已全部存在）时返回 null，不占屏幕行。
   * 并发正确性见 ./usage.ts 的模块注释：每页各自的累计快照做幂等 reduce。
   */
  private renderUsageTotals(): string | null {
    const { catalog, articles } = this.controller.state;
    const totals = collectUsageTotals(catalog, articles);
    if (totals.total <= 0) return null;

    return style(
      this.t("wikiGenerate.usageTotals", {
        input: formatBytes(totals.totalInput),
        output: formatBytes(totals.output),
        ratio: formatPercent(cacheHitRatio(totals)),
      }),
      { dim: true },
    );
  }

  // ==================== 目录段 ====================

  private renderCatalogSection(width: number): string[] {
    const state = this.controller.state.catalog;
    const { status, phase, currentTool, durationMs, error, retryCount, maxRetries, delayMs } = state;
    const { stage, sectionsProgress, section, failedSections } = state;
    // 展示口径 = 历史结转 + 本轮快照（重试不清零）
    const usage = slotUsageTotal(state);

    // 构建状态文字
    let statusText: string;
    if (status === "loading" && phase === "retry") {
      // 重试状态：显示次数和延迟
      const seconds = Math.ceil((delayMs || 10000) / 1000);
      statusText = this.t("wikiGenerate.retrying", {
        n: retryCount ?? 1,
        max: maxRetries ?? 3,
        seconds,
      });
    } else if (status === "loading" && stage) {
      // 三阶段：分类 → 分主题 → 标题（带分类级进度）
      statusText = this.stageStatusText(stage, sectionsProgress, section);
    } else if (status === "loading" && phase === "tool" && currentTool) {
      // 工具调用
      const toolDisplay = currentTool.replace(/_/g, " ").replace(/^get /, "");
      statusText = this.t("wikiGenerate.tool", { name: toolDisplay });
    } else if (status === "loading") {
      // requesting/responding/scanning/解析 → 统一显示请求中
      statusText = this.t("wikiGenerate.requesting");
    } else if (status === "failed" && error) {
      statusText = error;
    } else if (status === "completed" && failedSections && failedSections.length > 0) {
      statusText =
        this.t("wikiGenerate.completed") +
        " · " +
        this.t("wikiGenerate.failedSections", { n: failedSections.length });
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    // 右栏：状态 + Token
    let rightText = `[${statusText}]`;

    // loading 状态显示 Token（累计显示）
    if (status === "loading" && usage) {
      if (usage.input_tokens > 0) rightText += ` ↑${formatBytes(usage.input_tokens)}`;
      if (usage.output_tokens > 0) rightText += ` ↓${formatBytes(usage.output_tokens)}`;
    }

    // completed 状态显示耗时和 Token
    if (status === "completed") {
      if (durationMs !== undefined) rightText += ` ${formatDuration(durationMs)}`;
      if (usage) {
        if (usage.input_tokens > 0) rightText += ` ↑${formatBytes(usage.input_tokens)}`;
        if (usage.output_tokens > 0) rightText += ` ↓${formatBytes(usage.output_tokens)}`;
      }
    }

    const rightColor =
      status === "loading"
        ? theme.warning
        : status === "completed"
          ? theme.success
          : status === "failed"
            ? theme.error
            : theme.muted;

    // 左栏：图标 + 标题（loading 时图标轮换）
    const left =
      statusIcon(status, "default", this.spinnerFrame) +
      " " +
      this.t("wikiGenerate.catalogTitle");

    return [
      ...new Divider(this.t("wikiGenerate.catalogTitle")).render(width),
      statusRow(width, left, style(rightText, { color: rightColor })),
    ];
  }

  /** 三阶段状态文字（classify / topics / titles；带分类级进度） */
  private stageStatusText(
    stage: "classify" | "topics" | "titles",
    progress?: { current: number; total: number },
    section?: string,
  ): string {
    if (stage === "classify") return this.t("wikiGenerate.stageClassify");

    const suffix = section ? this.t("wikiGenerate.stageSection", { section }) : "";
    const hasProgress = progress !== undefined && progress.total > 0;

    if (stage === "topics") {
      return hasProgress
        ? this.t("wikiGenerate.stageTopics", { current: progress.current, total: progress.total }) + suffix
        : this.t("wikiGenerate.stageTopicsIdle");
    }

    return hasProgress
      ? this.t("wikiGenerate.stageTitles", { current: progress.current, total: progress.total }) + suffix
      : this.t("wikiGenerate.stageTitlesIdle");
  }

  // ==================== 文章段 ====================

  private renderArticlesSection(width: number, preLines: number, postLines: number): string[] {
    const { state } = this.controller;
    if (!this.controller.catalogCompleted || state.wikiPages.length === 0) return [];

    const pages = state.wikiPages;
    const statusMap = state.articles.pages;

    // 统计完成数量
    const completedCount = pages.filter(
      (p) => statusMap[p.slug]?.status === "completed",
    ).length;
    const articlesTitle = this.t("wikiGenerate.articlesTitle", {
      current: completedCount,
      total: pages.length,
    });

    this.select.setItems(pages.map((page) => ({ value: page.slug, page })));
    // 分页：只有列表内的行数受可用高度约束
    this.select.setViewportRows(
      Math.max(3, this.app.availableRows - preLines - postLines - 3),
    );

    return [
      ...new Divider(articlesTitle).render(width),
      // <Box marginTop={1}>
      "",
      ...this.select.render(width),
    ];
  }

  private renderArticleRow(page: WikiPage, isSelected: boolean, width: number): string {
    const statusMap = this.controller.state.articles.pages;
    const pageState = statusMap[page.slug];
    const status = pageState?.status || "waiting";
    const phase = pageState?.phase;
    const currentTool = pageState?.currentTool;
    // 展示口径 = 历史结转 + 本轮快照：重新生成时已消耗的 token 留在槽位里（不清零）
    const usage = pageState ? slotUsageTotal(pageState) : undefined;

    // 重试状态：实时倒计时
    const isRetrying = status === "loading" && phase === "retry";
    const delayMs = pageState?.delayMs || 10000;
    const retryCount = pageState?.retryCount ?? 1;
    const maxRetries = pageState?.maxRetries ?? 3;

    // 状态文字：根据 phase 显示详细状态
    let statusText: string;
    if (isRetrying) {
      // 重试状态：倒计时显示（由下方 CountdownRow 逻辑处理）
      statusText = "";
    } else if (status === "loading" && phase === "tool" && currentTool) {
      const toolDisplay = currentTool.replace(/_/g, " ").replace(/^get /, "");
      statusText = this.t("wikiGenerate.tool", { name: toolDisplay });
    } else if (status === "loading" && phase) {
      statusText = this.t(`wikiGenerate.${phase}`);
    } else if (status === "failed" && pageState?.error) {
      statusText = pageState.error;
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    const rightColor =
      status === "loading"
        ? isSelected
          ? theme.primary
          : theme.warning
        : status === "completed"
          ? theme.success
          : status === "failed"
            ? theme.error
            : theme.muted;

    // 左栏：指示器 + 图标 + 标题
    const indicator = isSelected
      ? style(">", { color: theme.primary })
      : style(" ", { color: theme.muted });
    const left =
      indicator +
      statusIcon(status, isSelected ? "active" : "default", this.spinnerFrame) +
      style(" " + page.title, { bold: isSelected });

    // 重试状态使用特殊逻辑（带倒计时）
    if (isRetrying) {
      const seconds = this.retrySeconds(page.slug, delayMs);
      let countdownText = `[${this.t("wikiGenerate.retrying", {
        n: retryCount,
        max: maxRetries,
        seconds,
      })}]`;
      if (usage) {
        if (usage.input_tokens > 0)
          countdownText += ` ↑${formatBytes(usage.input_tokens)}`;
        if (usage.output_tokens > 0)
          countdownText += ` ↓${formatBytes(usage.output_tokens)}`;
      }
      return statusRow(width, left, style(countdownText, { color: rightColor }));
    }

    // 普通状态
    let rightText = `[${statusText}]`;
    if (status === "loading" && usage) {
      if (usage.input_tokens > 0)
        rightText += ` ↑${formatBytes(usage.input_tokens)}`;
      if (usage.output_tokens > 0)
        rightText += ` ↓${formatBytes(usage.output_tokens)}`;
    }

    return statusRow(width, left, style(rightText, { color: rightColor }));
  }

  /** 计算 retry 剩余秒数（等价迁移前的 useCountdown） */
  private retrySeconds(slug: string, delayMs: number): number {
    const startedAt = this.retryStartedAt.get(slug);
    if (startedAt === undefined) return Math.ceil(delayMs / 1000);
    return Math.max(0, Math.ceil((delayMs - (Date.now() - startedAt)) / 1000));
  }

  /** 目录或任一文章是否处于 loading 状态（决定 spinner 是否需要转动） */
  private hasLoadingItem(): boolean {
    if (this.controller.state.catalog.status === "loading") return true;
    const statusMap = this.controller.state.articles.pages;
    return this.controller.state.wikiPages.some(
      (page) => statusMap[page.slug]?.status === "loading",
    );
  }

  /** 同步 retry 状态的倒计时起点；返回是否仍有页面在重试 */
  private syncRetryStates(): boolean {
    const statusMap = this.controller.state.articles.pages;
    let anyRetrying = false;
    for (const page of this.controller.state.wikiPages) {
      const pageState = statusMap[page.slug];
      if (pageState?.status === "loading" && pageState.phase === "retry") {
        // 记录倒计时起点（仅第一次进入 retry 时）
        if (!this.retryStartedAt.has(page.slug)) {
          this.retryStartedAt.set(page.slug, Date.now());
        }
        anyRetrying = true;
      } else {
        this.retryStartedAt.delete(page.slug);
      }
    }
    return anyRetrying;
  }
}
