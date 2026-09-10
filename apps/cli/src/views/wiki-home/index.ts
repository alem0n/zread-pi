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
import { fileExists, getWikiDir, joinPath } from "@open-zread/utils";
import type { WikiOutput, WikiPage } from "@open-zread/types";

type SelectItem = { value: string; label: string };

type Translate = (key: string, params?: Record<string, string | number>) => string;

// 进度检查函数
async function checkProgress(pages: WikiPage[]): Promise<{ total: number; generated: number }> {
  const wikiDir = getWikiDir();

  const checks = pages.map(async (page) => {
    // wiki 目录按 section 分组，文件路径：wikiDir/section/file.md
    const filePath = joinPath(wikiDir, page.section, page.file);
    return await fileExists(filePath);
  });

  const results = await Promise.all(checks);
  const generated = results.filter(Boolean).length;

  return { total: pages.length, generated };
}

// 构建首次配置选项列表
function buildFirstTimeSelectItems(t: Translate): SelectItem[] {
  return [
    { label: t("wiki.firstTimeConfig"), value: "config" },
    { label: t("wiki.exit"), value: "exit" },
  ];
}

// 构建正常选项列表
function buildNormalSelectItems(
  wikiCatalog: WikiOutput | null,
  progress: { total: number; generated: number } | null,
  t: Translate,
): SelectItem[] {
  const items: SelectItem[] = [];

  // 1. 生成文档（wiki.json 不存在）
  if (!wikiCatalog) {
    items.push({ label: t("wiki.generate"), value: "generate" });
  }

  // 2. 继续生成（wiki.json 存在 + 文档未完成）
  if (wikiCatalog && progress && progress.generated < progress.total) {
    items.push({
      label: t("wiki.continue", { generated: progress.generated, total: progress.total }),
      value: "continue",
    });
  }

  // 3. 浏览文档（wiki.json 存在 + 文档已完成）
  if (wikiCatalog && progress && progress.generated === progress.total) {
    items.push({ label: t("wiki.browse"), value: "browse" });
  }

  // 4. 同步文档（wiki.json 存在）
  if (wikiCatalog) {
    items.push({ label: t("wiki.sync"), value: "sync" });
  }

  // 5. 管理文档（wiki.json 存在 + 文档已完成）
  if (wikiCatalog && progress && progress.generated === progress.total) {
    items.push({ label: t("wiki.manage"), value: "manage" });
  }

  // 6. 强制重新生成（wiki.json 存在）
  if (wikiCatalog) {
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

    // 状态标题（用于 Divider）
    const statusTitle = isFirstTime
      ? this.t("wiki.dividerFirstTime")
      : wikiCatalog
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
      : wikiCatalog && this.progress && this.progress.generated < this.progress.total
        ? "yellow"
        : undefined;

    const lines: string[] = [];

    // 状态分割线
    lines.push(...new Divider(statusTitle, statusColor).render(width));

    // 选项列表（marginTop={1}）
    lines.push("", ...this.select.render(width));

    // Footer（marginTop={1}）
    lines.push("", style(this.t("wiki.footer"), { dim: true }));

    return lines;
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
    if (pages) {
      this.progress = await checkProgress(pages);
    } else {
      this.progress = null;
    }
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
