/**
 * WikiSyncPage — Wiki 同步页面（pi-tui 版）
 *
 * 顶部：── 目录 ──            状态行
 * 底部：── 文章 X/Y ──        Select 列表，行末附变更 tag
 *
 * 按键：↑↓ 导航 | r 重新生成（目录失败时重试同步） | ESC 返回 | ctrl+c 退出
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, statusIcon } from "../../tui/components/status";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { theme } from "../../theme";
import { formatBytes, formatDuration } from "../../utils/display";
import { renderTwoColumn } from "../../tui/text-layout";
import { WikiSyncController } from "./controller";
import type { SyncCatalogState } from "./types";

interface SyncArticleItem {
  value: string;
  slug: string;
  title: string;
  status?: string;
}

const tagColor = (type?: string): string | undefined => {
  switch (type) {
    case "new":
      return "#1aae39";
    case "updated":
      return "#dd5b00";
    case "archived":
      return "#a39e98";
    default:
      return undefined;
  }
};

const tagLabel = (type?: string): string => {
  switch (type) {
    case "new":
      return "新增";
    case "updated":
      return "更新";
    case "archived":
      return "归档";
    default:
      return "";
  }
};

export default class WikiSyncPage extends Screen {
  private controller!: WikiSyncController;
  private select!: Select<SyncArticleItem>;
  private selectedSlug: string | null = null;
  private ticker?: ReturnType<typeof setInterval>;
  /** spinner 动画帧（loading 图标轮换用） */
  private spinnerFrame = 0;

  protected override init(): void {
    this.controller = new WikiSyncController({
      wiki: this.app.wiki,
      onChange: () => this.refresh(),
    });

    this.select = new Select<SyncArticleItem>({
      items: [],
      renderItem: (item, isSelected, width) => [
        this.renderArticleRow(item, isSelected, width),
      ],
      onHighlight: (item) => {
        this.selectedSlug = item.slug;
      },
    });

    // loading 图标动画需要每帧刷新
    this.ticker = setInterval(() => {
      if (this.hasLoadingItem()) {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.refresh();
      }
    }, SPINNER_INTERVAL_MS);
  }

  override async onEnter(): Promise<void> {
    // 直接进入该路由时（未经 wiki 首页）也要先加载 wiki.json，再开始同步
    await this.app.wiki.load();
    this.controller.init();
  }

  override onDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.app.navigate("/wiki");
      return true;
    }
    if (data === "r") {
      // 目录失败：重新触发整个同步流程
      if (this.controller.state.catalog.status === "failed") {
        this.controller.retrySync();
        return true;
      }
      // 选中某篇文章：重新生成该文章
      if (this.selectedSlug) {
        void this.controller.regeneratePage(this.selectedSlug);
      }
      return true;
    }
    return this.select.handleInput(data);
  }

  render(width: number): string[] {
    const { state } = this.controller;
    const { catalog, syncPages } = state;

    const lines: string[] = [];
    lines.push(...this.renderCatalogRow(catalog, width));

    // 底部导航（marginTop={1}）
    const footer = [
      "",
      style(
        `↑/↓: ${this.t("wikiGenerate.navigate")} | r: ${this.t("wikiGenerate.retry")} | ctrl+c: ${this.t("wikiGenerate.exit")} | ESC: 返回`,
        { dim: true },
      ),
    ];

    if (catalog.status === "completed" && syncPages.length > 0) {
      this.select.setItems(
        syncPages.map((page) => ({
          value: page.slug,
          slug: page.slug,
          title: page.title,
          status: page.status,
        })),
      );
      lines.push(...this.renderArticlesList(width, lines.length, footer.length));
    }

    if (catalog.status === "completed" && syncPages.length === 0) {
      lines.push("", style("无变更", { color: theme.muted }));
    }

    return [...lines, ...footer];
  }

  // ==================== 目录段 ====================

  private renderCatalogRow(catalog: SyncCatalogState, width: number): string[] {
    const { status, phase, usage, durationMs, error } = catalog;

    let statusText: string;
    if (status === "loading") {
      statusText =
        phase === "detecting"
          ? "扫描变更"
          : phase === "planning"
            ? "规划目录"
            : this.t("wikiGenerate.requesting");
    } else if (status === "failed" && error) {
      statusText = error;
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    let rightText = `[${statusText}]`;
    if (status === "loading" && usage) {
      if (usage.input_tokens > 0) rightText += ` ↑${formatBytes(usage.input_tokens)}`;
      if (usage.output_tokens > 0) rightText += ` ↓${formatBytes(usage.output_tokens)}`;
    }
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

    const left =
      statusIcon(status, "default", this.spinnerFrame) +
      " " +
      this.t("wikiGenerate.catalogTitle");

    return [
      ...new Divider(this.t("wikiGenerate.catalogTitle")).render(width),
      renderTwoColumn(width, left, style(rightText, { color: rightColor })),
    ];
  }

  // ==================== 文章段 ====================

  private renderArticlesList(width: number, preLines: number, postLines: number): string[] {
    const { articles, syncPages } = this.controller.state;
    const articlesTitle = this.t("wikiGenerate.articlesTitle", {
      current: articles.completedCount,
      total: syncPages.length,
    });

    // 分页：列表可用行数 = 页面高度 - 上方内容 - 下方内容 - 本区块的 3 行（分割线 2 + 空行 1）
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

  private renderArticleRow(item: SyncArticleItem, isSelected: boolean, width: number): string {
    const { articles } = this.controller.state;
    const pg = articles.pages[item.slug];
    const status = pg?.status || "waiting";
    const syncType = pg?.syncType ?? (item.status === "unchanged" ? undefined : item.status);

    let statusText: string;
    if (status === "loading" && pg?.phase === "retry") {
      statusText = this.t("wikiGenerate.retrying", {
        n: pg.retryCount ?? 1,
        max: pg.maxRetries ?? 3,
        seconds: Math.ceil((pg.delayMs ?? 10000) / 1000),
      });
    } else if (status === "loading" && pg?.phase === "tool" && pg.currentTool) {
      const toolDisplay = pg.currentTool.replace(/_/g, " ").replace(/^get /, "");
      statusText = this.t("wikiGenerate.tool", { name: toolDisplay });
    } else if (status === "loading" && pg?.phase) {
      statusText = this.t(`wikiGenerate.${pg.phase}`);
    } else if (status === "failed" && pg?.error) {
      statusText = pg.error;
    } else {
      statusText = this.t(`wikiGenerate.${status}`);
    }

    let rightText = `[${statusText}]`;
    if (status === "loading" && pg?.usage) {
      if (pg.usage.input_tokens > 0) rightText += ` ↑${formatBytes(pg.usage.input_tokens)}`;
      if (pg.usage.output_tokens > 0) rightText += ` ↓${formatBytes(pg.usage.output_tokens)}`;
    }
    if (status === "completed") {
      if (pg?.durationMs !== undefined) rightText += ` ${formatDuration(pg.durationMs)}`;
      if (pg?.usage) {
        if (pg.usage.input_tokens > 0) rightText += ` ↑${formatBytes(pg.usage.input_tokens)}`;
        if (pg.usage.output_tokens > 0) rightText += ` ↓${formatBytes(pg.usage.output_tokens)}`;
      }
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

    // 左栏：指示器 + 图标 + 变更 tag + 标题
    let left = isSelected
      ? style(">", { color: theme.primary })
      : style(" ", { color: theme.muted });
    left += statusIcon(status, isSelected ? "active" : "default", this.spinnerFrame);
    if (syncType) {
      left += style(`  [${tagLabel(syncType)}]`, { color: tagColor(syncType) });
    }
    left += style(" " + item.title, { bold: isSelected });

    return renderTwoColumn(width, left, style(rightText, { color: rightColor }));
  }

  /** 目录或任一文章是否处于 loading 状态（决定 spinner 是否需要转动） */
  private hasLoadingItem(): boolean {
    const { catalog, articles, syncPages } = this.controller.state;
    if (catalog.status === "loading") return true;
    return syncPages.some((page) => articles.pages[page.slug]?.status === "loading");
  }
}
