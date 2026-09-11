/**
 * Config Max Turns Page - 最大轮次设置（pi-tui 版）
 *
 * 路由：/config/max-turns
 *
 * agent.max_turns 控制每次 Agent 运行（单页 Wiki / 蓝图 / 同步）的最大轮次。
 * 旧实现在 Orchestrator 里硬编码 30，现在由配置提供；0 = 不限制轮次。
 *
 * 按键：Enter 确认 | s 保存并返回 | ESC 返回
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_TURNS, MAX_MAX_TURNS, MIN_MAX_TURNS } from "@zread-pi/utils";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigMaxTurnsPage extends Screen {
  private field = new TextField();
  private inputValue = "";
  private error: string | null = null;
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    const current = String(this.app.config.config.agent?.max_turns ?? DEFAULT_MAX_TURNS);
    this.inputValue = current;
    this.field.setValue(current);
    this.field.setPlaceholder(current);
    this.field.onChange = (value) => this.handleChange(value);
  }

  override handleKey(data: string): boolean {
    const valueBeforeKey = this.inputValue;

    if (matchesKey(data, "return") && this.saveStatus === "idle") {
      if (this.validate(valueBeforeKey)) {
        this.app.config.setField("agent.max_turns", Number.parseInt(valueBeforeKey, 10));
        this.app.navigate(-1);
        return true;
      }
    }

    if (data === "s" && this.saveStatus === "idle") {
      if (this.validate(valueBeforeKey)) {
        this.app.config.setField("agent.max_turns", Number.parseInt(valueBeforeKey, 10));
        this.startSave();
        return true;
      }
    }

    this.field.handleKey(data);
    return false;
  }

  override onDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // 当前值输入（marginTop={1}）
    const label = style(`${this.t("maxTurns.current")}: `, { dim: true });
    const labelWidth = visibleWidth(label);
    const inputLine = this.field.render(Math.max(1, width - labelWidth))[0] ?? "";
    lines.push("", clampLine(label + inputLine, width));

    // 范围提示（marginTop={1}）
    lines.push("", style(this.t("maxTurns.range"), { dim: true }));
    // 语义提示：max_turns 是工作轮数，超出后自动追加收尾轮
    lines.push(style(this.t("maxTurns.hint"), { dim: true }));

    // 错误提示
    if (this.error) {
      lines.push("", style(this.error, { color: "red" }));
    }

    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    }
    if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    }
    if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    // Footer（marginTop={1}）
    lines.push("", style(this.t("maxTurns.footer"), { dim: true }));

    return lines;
  }

  // ==================== 内部实现 ====================

  /** 验证输入 */
  private validate(value: string): boolean {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num < MIN_MAX_TURNS || num > MAX_MAX_TURNS) {
      this.error = this.t("maxTurns.invalid");
      this.refresh();
      return false;
    }
    this.error = null;
    return true;
  }

  /** 输入变化时验证 */
  private handleChange(value: string): void {
    this.inputValue = value;
    if (value === "") {
      this.error = null;
      this.refresh();
      return;
    }
    this.validate(value);
    this.refresh();
  }

  private startSave(): void {
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
