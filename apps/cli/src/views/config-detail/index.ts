/**
 * Config Blueprint Detail Page - 蓝图细节档位设置（pi-tui 版）
 *
 * 路由：/config/detail
 *
 * `blueprint.detail` 决定 Wiki 蓝图生成的项目理解深度（分类数 / 每分类文章数 / 是否精修标题）：
 * - minimal：1 个分类（概览）· 1 篇全景导览（必须 Mermaid 架构图），跳过标题精修；
 * - low：3~5 个分类 · 每分类 1~3 篇，跳过标题精修；
 * - medium：4~6 个分类 · 每分类 3~5 篇；
 * - high（默认）：4~8 个分类 · 每分类 3~10 篇（与旧行为一致）；
 * - max：4~8 个分类 · 每分类 5~12 篇，强调全面详尽并鼓励深挖关联文件。
 *
 * 数量越界时不会崩溃：模型先按策略归并重提，仍不收敛则由缩编 Agent / 代码确定性收尾。
 *
 * 按键：↑↓ 选择 | Enter 应用并返回 | s 保存并返回 | ESC 返回
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { BlueprintDetailLevel } from "@zread-pi/types";
import { BLUEPRINT_DETAIL_LEVELS } from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigDetailPage extends Screen {
  private select!: Select<{ value: BlueprintDetailLevel }>;
  private selectedLevel: BlueprintDetailLevel = "high";
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    this.selectedLevel = this.app.config.getBlueprintDetail();

    this.select = new Select({
      items: BLUEPRINT_DETAIL_LEVELS.map((level) => ({ value: level })),
      initialIndex: Math.max(0, BLUEPRINT_DETAIL_LEVELS.indexOf(this.selectedLevel)),
      renderItem: (item, isSelected) => this.renderLevelRow(item.value, isSelected),
      onHighlight: (item) => {
        this.selectedLevel = item.value;
      },
      onSelect: (item) => this.handleSelect(item.value),
    });
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) return false; // 交给 App 返回上一级

    if (data === "s" && this.saveStatus === "idle") {
      this.startSave();
      return true;
    }
    return this.select.handleInput(data);
  }

  override onDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 标题分割线（marginTop={1} 由 Divider 自带）
    lines.push(...new Divider(this.t("blueprintDetail.title")).render(width));

    // 当前值：读内存配置（Enter 应用后立刻反映）
    lines.push(
      style(`${this.t("blueprintDetail.current")}: `, { dim: true }) +
        style(this.levelLabel(this.selectedLevel), { color: "cyan" }),
    );

    // 档位机制说明
    lines.push("");
    lines.push(style(this.t("blueprintDetail.intro"), { dim: true }));

    // 保存状态
    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    } else if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    } else if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    const pre = [...lines, ""];
    const post = ["", style(this.t("blueprintDetail.footer"), { dim: true })];
    this.select.setViewportRows(Math.max(1, this.app.availableRows - pre.length - post.length));

    return [...pre, ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  /** 档位行的中文/英文标签 */
  private levelLabel(level: BlueprintDetailLevel): string {
    return this.t(`blueprintDetail.${level}`);
  }

  /** 档位行：标签 + 数量说明（说明固定 dim，选中行用蓝色） */
  private renderLevelRow(level: BlueprintDetailLevel, isSelected: boolean): string[] {
    const label = this.levelLabel(level);
    const desc = this.t(`blueprintDetail.${level}Desc`);
    const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
    const labelText = isSelected ? style(label, { color: "blue" }) : label;
    return [`${indicator} ${labelText}`, `  ${style(desc, { dim: true })}`];
  }

  private handleSelect(level: BlueprintDetailLevel): void {
    this.selectedLevel = level;
    this.app.config.setBlueprintDetail(level);
    // Enter 确认后返回上一级（使用 -1 避免路由栈堆积）
    this.app.navigate(-1);
  }

  private startSave(): void {
    this.app.config.setBlueprintDetail(this.selectedLevel);
    this.saveStatus = "saving";
    this.refresh();

    this.app.config.save().then((success) => {
      this.saveStatus = success ? "saved" : "failed";
      this.refresh();
      if (success) {
        this.timer = setTimeout(() => {
          if (this.app.currentScreen === this) this.app.navigate(-1);
        }, 500);
      } else {
        this.timer = setTimeout(() => {
          this.saveStatus = "idle";
          this.refresh();
        }, 2000);
      }
    });
  }
}
