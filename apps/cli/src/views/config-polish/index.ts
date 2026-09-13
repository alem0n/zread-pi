/**
 * Config Polish Page - 文风纪律与页面润色（第 1 层预防 / 第 2 层兜底）
 *
 * 路由：/config/polish
 *
 * `polish.enabled` 是总开关；`polish.mode` 决定强度：
 * - prompt-only（默认）：只把 humanizer 文风纪律注入蓝图 / 页面 Agent 的系统提示，零额外成本；
 * - full：预防 + 每页落盘后多跑一次轻量 polish Agent（失败不判页失败，Mermaid 被改坏会回滚）。
 *
 * 按键：↑↓ 选择模式 | Enter 应用并返回 | t 启用/停用 | s 保存并返回 | ESC 返回
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { PolishMode } from "@zread-pi/types";
import { POLISH_MODES } from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigPolishPage extends Screen {
  private select!: Select<{ value: PolishMode }>;
  private enabled = true;
  private selectedMode: PolishMode = "prompt-only";
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    this.enabled = this.app.config.isPolishEnabled();
    this.selectedMode = this.app.config.getPolishMode();

    this.select = new Select({
      items: POLISH_MODES.map((mode) => ({ value: mode })),
      initialIndex: Math.max(0, POLISH_MODES.indexOf(this.selectedMode)),
      renderItem: (item, isSelected) => this.renderModeRow(item.value, isSelected),
      onHighlight: (item) => {
        this.selectedMode = item.value;
      },
      onSelect: (item) => this.handleSelect(item.value),
    });
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) return false; // 交给 App 返回上一级

    if (data === "t" && this.saveStatus === "idle") {
      // 只切开关：不动当前已保存的模式（模式由 ↑↓ + Enter/s 决定）
      this.enabled = !this.enabled;
      this.app.config.setPolish(this.enabled, this.app.config.getPolishMode());
      this.refresh();
      return true;
    }

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
    lines.push(...new Divider(this.t("polish.title")).render(width));

    // 当前值：开关 + 模式（读内存配置；Enter/t 应用后立刻反映）
    lines.push(
      style(`${this.t("polish.current")}: `, { dim: true }) +
        style(
          `${this.enabled ? this.t("polish.enabled") : this.t("polish.disabled")} · ${this.modeLabel(this.app.config.getPolishMode())}`,
          { color: "cyan" },
        ),
    );

    // 两层机制说明
    lines.push("");
    lines.push(style(this.t("polish.intro"), { dim: true }));
    lines.push(style(this.t("polish.layersHint"), { dim: true }));

    // 保存状态
    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    } else if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    } else if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    const pre = [...lines, ""];
    const post = ["", style(this.t("polish.footer"), { dim: true })];
    this.select.setViewportRows(Math.max(1, this.app.availableRows - pre.length - post.length));

    return [...pre, ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  /** 模式行的中文/英文标签 */
  private modeLabel(mode: PolishMode): string {
    return mode === "full" ? this.t("polish.modeFull") : this.t("polish.modePromptOnly");
  }

  /** 模式行：标签 + 描述（描述固定 dim，选中行用蓝色） */
  private renderModeRow(mode: PolishMode, isSelected: boolean): string[] {
    const label = this.modeLabel(mode);
    const desc = mode === "full" ? this.t("polish.modeFullDesc") : this.t("polish.modePromptOnlyDesc");
    const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
    const labelText = isSelected ? style(label, { color: "blue" }) : label;
    return [
      `${indicator} ${labelText}`,
      `  ${style(desc, { dim: true })}`,
    ];
  }

  private handleSelect(mode: PolishMode): void {
    this.selectedMode = mode;
    this.app.config.setPolish(this.enabled, mode);
    // Enter 确认后返回上一级（使用 -1 避免路由栈堆积）
    this.app.navigate(-1);
  }

  private startSave(): void {
    this.app.config.setPolish(this.enabled, this.selectedMode);
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
