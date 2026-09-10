/**
 * Config Concurrency Page - 最大并发数设置（pi-tui 版）
 *
 * 按键：Enter 确认 | s 保存并返回 | ESC 返回
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

const MIN = 1;
const MAX = 10;

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigConcurrencyPage extends Screen {
  private field = new TextField();
  private inputValue = "";
  private error: string | null = null;
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    const current = String(this.app.config.config.concurrency.max_concurrent);
    this.inputValue = current;
    this.field.setValue(current);
    this.field.setPlaceholder(current);
    this.field.onChange = (value) => this.handleChange(value);
  }

  override handleKey(data: string): boolean {
    // 与 Ink 版一致：页面级 useInput 与输入框同时收到按键，
    // 且页面级校验使用「按键前」的值（React 闭包语义）。
    const valueBeforeKey = this.inputValue;

    if (matchesKey(data, "return") && this.saveStatus === "idle") {
      if (this.validate(valueBeforeKey)) {
        this.app.config.setField(
          "concurrency.max_concurrent",
          Number.parseInt(valueBeforeKey, 10),
        );
        this.app.navigate(-1);
        return true;
      }
    }

    if (data === "s" && this.saveStatus === "idle") {
      if (this.validate(valueBeforeKey)) {
        this.app.config.setField(
          "concurrency.max_concurrent",
          Number.parseInt(valueBeforeKey, 10),
        );
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
    const label = style(`${this.t("concurrency.current")}: `, { dim: true });
    const labelWidth = visibleWidth(label);
    const inputLine = this.field.render(Math.max(1, width - labelWidth))[0] ?? "";
    lines.push("", clampLine(label + inputLine, width));

    // 范围提示（marginTop={1}）
    lines.push("", style(this.t("concurrency.range"), { dim: true }));

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
    lines.push("", style(this.t("concurrency.footer"), { dim: true }));

    return lines;
  }

  // ==================== 内部实现 ====================

  /** 验证输入 */
  private validate(value: string): boolean {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num < MIN || num > MAX) {
      this.error = this.t("concurrency.invalid");
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
