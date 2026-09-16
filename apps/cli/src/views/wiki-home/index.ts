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
// 多档共存下菜单按「写盘目标档位（targetCatalog）」组织：生成/继续/同步/强制重新生成
// 都作用于配置档位；浏览入口在任一档位完整时都可用（浏览页内置档位切换）。
function buildNormalSelectItems(
  targetCatalog: WikiOutput | null,
  targetProgress: { total: number; generated: number } | null,
  statusProgress: { total: number; generated: number } | null,
  t: Translate,
): SelectItem[] {
  const items: SelectItem[] = [];
  const targetHasCatalog =
    targetCatalog !== null && (targetCatalog.pages?.length ?? 0) > 0;
  const targetComplete =
    targetHasCatalog &&
    targetProgress !== null &&
    targetProgress.generated === targetProgress.total;
  const anyComplete = statusProgress !== null && statusProgress.generated === statusProgress.total;

  // 1. 生成文档（当前配置档位还没有目录）
  if (!targetHasCatalog) {
    items.push({ label: t("wiki.generate"), value: "generate" });
  }

  // 2. 继续生成（当前配置档位存在 + 文档未完成）
  if (targetHasCatalog && !targetComplete && targetProgress) {
    items.push({
      label: t("wiki.continue", { generated: targetProgress.generated, total: targetProgress.total }),
      value: "continue",
    });
  }

  // 3. 浏览文档（当前档位已完成；或其他档位已有完整文档）
  if (targetComplete || (!targetHasCatalog && anyComplete)) {
    items.push({ label: t("wiki.browse"), value: "browse" });
  }

  // 4. 同步文档（当前配置档位存在）
  if (targetHasCatalog) {
    items.push({ label: t("wiki.sync"), value: "sync" });
  }

  // 5. 管理文档（当前档位已完成）
  if (targetComplete) {
    items.push({ label: t("wiki.manage"), value: "manage" });
  }

  // 6. 强制重新生成（当前配置档位存在；只重建该档位变体）
  if (targetHasCatalog) {
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
  /** 活动变体（任一档位）的进度：用于状态标题 */
  private statusProgress: { total: number; generated: number } | null = null;
  /** 写盘目标档位（配置档位）的进度：用于菜单项判定 */
  private targetProgress: { total: number; generated: number } | null = null;

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
    // l：查看运行轨迹（最新一次运行）
    if (data === "l") {
      this.app.navigate("/logview");
      return true;
    }
    return this.select.handleInput(data);
  }

  override async onEnter(): Promise<void> {
    // 从配置页返回时档位可能已变化：重新解析变体并刷新菜单
    await this.loadCatalog();
  }

  render(width: number): string[] {
    const { isFirstTime } = this.app.config;
    const wikiCatalog = this.app.wiki.catalog;
    // 空骨架（只有 sections、pages 为空）视同「尚无目录」
    const hasCatalog = wikiCatalog !== null && (wikiCatalog.pages?.length ?? 0) > 0;

    // 状态标题（用于 Divider）：按活动变体（任一档位）显示
    const statusTitle = isFirstTime
      ? this.t("wiki.dividerFirstTime")
      : hasCatalog
        ? this.statusProgress && this.statusProgress.generated === this.statusProgress.total
          ? this.t("wiki.dividerComplete", { total: this.statusProgress.total })
          : this.statusProgress
            ? this.t("wiki.dividerInProgress", {
                generated: this.statusProgress.generated,
                total: this.statusProgress.total,
              })
            : this.t("wiki.dividerHasCatalog")
        : this.t("wiki.dividerNoCatalog");

    // 状态颜色（首次配置用黄色警告，进行中用黄色，其他默认灰色）
    const statusColor = isFirstTime
      ? "yellow"
      : hasCatalog && this.statusProgress && this.statusProgress.generated < this.statusProgress.total
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
    return this.app.config.isFirstTime
      ? buildFirstTimeSelectItems(t)
      : buildNormalSelectItems(
          this.app.wiki.targetCatalog,
          this.targetProgress,
          this.statusProgress,
          t,
        );
  }

  private async loadCatalog(): Promise<void> {
    // 每次进入都重新解析变体（配置档位切换后立即生效）
    await this.app.wiki.reload();

    // 活动变体（任一档位）：状态标题与浏览入口
    const activePages = this.app.wiki.catalog?.pages;
    this.statusProgress =
      activePages && activePages.length > 0 && this.app.wiki.detail
        ? await countGeneratedPages(activePages, this.app.wiki.detail)
        : null;

    // 写盘目标档位：生成 / 继续 / 管理 / 同步 / 强制重新生成
    const targetPages = this.app.wiki.targetCatalog?.pages;
    this.targetProgress =
      targetPages && targetPages.length > 0
        ? await countGeneratedPages(targetPages, this.app.wiki.targetDetail)
        : null;

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
