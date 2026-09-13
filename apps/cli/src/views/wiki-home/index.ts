/**
 * Wiki Home Page - Wiki 首页（pi-tui 版）
 *
 * 根据 wiki.json 和文档生成状态动态显示选项列表
 * 首次配置时显示"尚未配置 LLM 提供商"，仅提供配置和退出选项
 */

import { Divider } from "../../tui/components/divider";
import { barIndicator, Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { countGeneratedPages } from "../../utils/generated-docs";
import type { WikiOutput } from "@zread-pi/types";

type SelectItem = { value: string; label: string };

type Translate = (key: string, params?: Record<string, string | number>) => string;

// 构建首次配置选项列表
function buildFirstTimeSelectItems(t: Translate): SelectItem[] {
  return [
    { label: t("wiki.firstTimeConfig"), value: "config" },
    { label: t("wiki.exit"), value: "exit" },
  ];
}

// 构建正常选项列表
// 注意：三阶段流程会先落盘「只有 sections、pages 为空」的骨架；空骨架不算已有目录，
// 否则会出现「文档已生成 (0 篇)」且没有任何继续生成入口的卡死状态。
function buildNormalSelectItems(
  wikiCatalog: WikiOutput | null,
  progress: { total: number; generated: number } | null,
  t: Translate,
): SelectItem[] {
  const items: SelectItem[] = [];
  const hasCatalog = wikiCatalog !== null && (wikiCatalog.pages?.length ?? 0) > 0;

  // 1. 生成文档（wiki.json 不存在或只有未完成的空骨架）
  if (!hasCatalog) {
    items.push({ label: t("wiki.generate"), value: "generate" });
  }

  // 2. 继续生成（wiki.json 存在 + 文档未完成）
  if (hasCatalog && progress && progress.generated < progress.total) {
    items.push({
      label: t("wiki.continue", { generated: progress.generated, total: progress.total }),
      value: "continue",
    });
  }

  // 3. 浏览文档（wiki.json 存在 + 文档已完成）
  if (hasCatalog && progress && progress.generated === progress.total) {
    items.push({ label: t("wiki.browse"), value: "browse" });
  }

  // 4. 同步文档（wiki.json 存在）
  if (hasCatalog) {
    items.push({ label: t("wiki.sync"), value: "sync" });
  }

  // 5. 管理文档（wiki.json 存在 + 文档已完成）
  if (hasCatalog && progress && progress.generated === progress.total) {
    items.push({ label: t("wiki.manage"), value: "manage" });
  }

  // 6. 强制重新生成（wiki.json 存在）
  if (hasCatalog) {
    items.push({ label: t("wiki.force"), value: "force" });
  }

  // 7. 配置（常驻）
  items.push({ label: t("wiki.config"), value: "config" });

  // 8. 退出（常驻）
  items.push({ label: t("wiki.exit"), value: "exit" });

  return items;
}

export default class WikiHomePage extends Screen {
  private select!: Select<SelectItem>;
  private progress: { total: number; generated: number } | null = null;

  protected override init(): void {
    this.select = new Select({
      items: this.buildItems(),
      renderItem: (item, isSelected) => [
        barIndicator(isSelected) +
          style(item.label, isSelected ? { bold: true, color: "white" } : { color: "gray" }),
      ],
      onSelect: (item) => this.handleSelect(item.value),
    });
    void this.loadCatalog();
  }

  override handleKey(data: string): boolean {
    return this.select.handleInput(data);
  }

  render(width: number): string[] {
    const { isFirstTime } = this.app.config;
    const wikiCatalog = this.app.wiki.catalog;
    // 空骨架（只有 sections、pages 为空）视同「尚无目录」
    const hasCatalog = wikiCatalog !== null && (wikiCatalog.pages?.length ?? 0) > 0;

    // 状态标题（用于 Divider）
    const statusTitle = isFirstTime
      ? this.t("wiki.dividerFirstTime")
      : hasCatalog
        ? this.progress && this.progress.generated === this.progress.total
          ? this.t("wiki.dividerComplete", { total: this.progress.total })
          : this.progress
            ? this.t("wiki.dividerInProgress", {
                generated: this.progress.generated,
                total: this.progress.total,
              })
            : this.t("wiki.dividerHasCatalog")
        : this.t("wiki.dividerNoCatalog");

    // 状态颜色（首次配置用黄色警告，进行中用黄色，其他默认灰色）
    const statusColor = isFirstTime
      ? "yellow"
      : hasCatalog && this.progress && this.progress.generated < this.progress.total
        ? "yellow"
        : undefined;

    // 状态分割线
    const pre = new Divider(statusTitle, statusColor).render(width);

    // 选项列表（marginTop={1}）+ Footer（marginTop={1}）
    const post = ["", style(this.t("wiki.footer"), { dim: true })];
    this.select.setViewportRows(
      Math.max(3, this.app.availableRows - pre.length - 1 - post.length),
    );

    return [...pre, "", ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  private buildItems(): SelectItem[] {
    const t = this.app.t.bind(this.app);
    const wikiCatalog = this.app.wiki.catalog;
    return this.app.config.isFirstTime
      ? buildFirstTimeSelectItems(t)
      : buildNormalSelectItems(wikiCatalog, this.progress, t);
  }

  private async loadCatalog(): Promise<void> {
    await this.app.wiki.load();
    const pages = this.app.wiki.catalog?.pages;
    // 空骨架（只有 sections）视同「尚无目录」：不计算进度，首页给出生成入口
    this.progress = pages && pages.length > 0 ? await countGeneratedPages(pages) : null;
    this.syncItems();
    this.refresh();
  }

  private syncItems(): void {
    this.select.setItems(this.buildItems());
  }

  private handleSelect(value: string): void {
    switch (value) {
      case "generate":
        this.app.navigate("/wiki/generate?mode=generate");
        break;
      case "continue":
        this.app.navigate("/wiki/generate?mode=continue");
        break;
      case "manage":
        this.app.navigate("/wiki/generate?mode=manage");
        break;
      case "browse":
        this.app.navigate("/browse");
        break;
      case "force":
        this.app.navigate("/wiki/generate?mode=force");
        break;
      case "sync":
        this.app.navigate("/wiki/sync");
        break;
      case "config":
        this.app.navigate("/config");
        break;
      case "exit":
        this.app.exit();
        break;
    }
  }
}
