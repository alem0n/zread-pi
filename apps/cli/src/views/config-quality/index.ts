/**
 * Config Quality Page - 内容质量门（内容密度门 + 生成后自动校验）
 *
 * 路由：/config/quality
 *
 * `quality.contentGate.enabled` 是总开关；`mode` 决定强度：
 * - off：完全不校验（行为与升级前一致）；
 * - warn（默认）：计算并记录进 PageResult.gate，不拦截落盘；
 * - enforce：未达标时拦截 write_page 并要求重写；预算用尽仍未通过时
 *   best-effort 落盘并标记 enforce-degraded（页面仍计成功，不判页失败）。
 *
 * `quality.verifyAfterGenerate`：生成完成后自动跑一次交付闸门（默认关闭）。
 *
 * 按键：↑↓ 选择 | Enter 应用并返回 | t 启用/停用内容门 | v 切换自动校验 | s 保存并返回 | ESC 返回
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ContentGateMode } from "@zread-pi/types";
import { CONTENT_GATE_MODES } from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigQualityPage extends Screen {
  private select!: Select<{ value: ContentGateMode }>;
  private enabled = true;
  private selectedMode: ContentGateMode = "warn";
  private verifyAfterGenerate = false;
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    this.enabled = this.app.config.isContentGateEnabled();
    this.selectedMode = this.app.config.getContentGateMode();
    this.verifyAfterGenerate = this.app.config.isVerifyAfterGenerate();

    this.select = new Select({
      items: CONTENT_GATE_MODES.map((mode) => ({ value: mode })),
      initialIndex: Math.max(0, CONTENT_GATE_MODES.indexOf(this.selectedMode)),
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
      // 只切内容门开关：不动当前已保存的模式
      this.enabled = !this.enabled;
      this.applyToStore();
      this.refresh();
      return true;
    }

    if (data === "v" && this.saveStatus === "idle") {
      this.verifyAfterGenerate = !this.verifyAfterGenerate;
      this.applyToStore();
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
    lines.push(...new Divider(this.t("quality.title")).render(width));

    // 当前值：开关 + 模式 + 自动校验（读内存配置；Enter/t/v 应用后立刻反映）
    lines.push(
      style(`${this.t("quality.current")}: `, { dim: true }) +
        style(
          `${this.enabled ? this.t("quality.enabled") : this.t("quality.disabled")} · ${this.modeLabel(this.app.config.getContentGateMode())}`,
          { color: "cyan" },
        ),
    );
    lines.push(
      style(
        `${this.t("quality.verifyAfterGenerate")}: ${this.app.config.isVerifyAfterGenerate() ? this.t("quality.enabled") : this.t("quality.disabled")}`,
        { dim: true },
      ),
    );

    // 机制说明 + 反注水提示
    lines.push("");
    lines.push(style(this.t("quality.intro"), { dim: true }));
    lines.push(style(this.t("quality.paddingHint"), { dim: true }));

    // 保存状态
    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    } else if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    } else if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    const pre = [...lines, ""];
    const post = ["", style(this.t("quality.footer"), { dim: true })];
    this.select.setViewportRows(Math.max(1, this.app.availableRows - pre.length - post.length));

    return [...pre, ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  /** 模式行的中文/英文标签 */
  private modeLabel(mode: ContentGateMode): string {
    switch (mode) {
      case "enforce":
        return this.t("quality.modeEnforce");
      case "warn":
        return this.t("quality.modeWarn");
      default:
        return this.t("quality.modeOff");
    }
  }

  /** 模式行：标签 + 描述（描述固定 dim，选中行用蓝色） */
  private renderModeRow(mode: ContentGateMode, isSelected: boolean): string[] {
    const label = this.modeLabel(mode);
    const desc =
      mode === "enforce"
        ? this.t("quality.modeEnforceDesc")
        : mode === "warn"
          ? this.t("quality.modeWarnDesc")
          : this.t("quality.modeOffDesc");
    const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
    const labelText = isSelected ? style(label, { color: "blue" }) : label;
    return [`${indicator} ${labelText}`, `  ${style(desc, { dim: true })}`];
  }

  /** 把当前界面状态写回内存配置（不落盘） */
  private applyToStore(): void {
    this.app.config.setQuality(this.enabled, this.selectedMode, this.verifyAfterGenerate);
  }

  private handleSelect(mode: ContentGateMode): void {
    this.selectedMode = mode;
    this.applyToStore();
    // Enter 确认后返回上一级（使用 -1 避免路由栈堆积）
    this.app.navigate(-1);
  }

  private startSave(): void {
    this.applyToStore();
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
