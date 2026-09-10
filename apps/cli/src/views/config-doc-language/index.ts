/**
 * Config Doc Language Page - 文档生成语言选择（pi-tui 版）
 *
 * 按键：↑↓ 选择 | Enter 确认并返回 | s 保存并返回 | ESC 返回
 */

import { defaultRow, Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

const LANGUAGE_OPTIONS = [
  { value: "zh", labelKey: "docLanguage.zh" },
  { value: "en", labelKey: "docLanguage.en" },
];

export default class ConfigDocLanguagePage extends Screen {
  private select!: Select<{ value: string; labelKey: string }>;
  private selectedValue = "zh";
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  protected override init(): void {
    this.selectedValue = this.app.config.config.doc_language;
    this.select = new Select({
      items: LANGUAGE_OPTIONS.map((option) => ({ ...option })),
      initialIndex: LANGUAGE_OPTIONS.findIndex((option) => option.value === this.selectedValue),
      renderItem: (item, isSelected) => [defaultRow(this.t(item.labelKey), isSelected)],
      onSelect: (item) => this.handleSelect(item.value),
    });
  }

  override handleKey(data: string): boolean {
    // ESC 返回由 App 统一处理，这里只监听 s 键保存
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
    const { config } = this.app.config;
    const lines: string[] = [];

    // 当前值（marginTop={1}）
    lines.push(
      "",
      style(`${this.t("docLanguage.current")}: `, { dim: true }) +
        style(config.doc_language === "zh" ? this.t("docLanguage.zh") : this.t("docLanguage.en"), {
          color: "cyan",
        }),
    );

    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    }
    if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    }
    if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    // 选择列表（marginTop={1}）
    lines.push("", ...this.select.render(width));

    // Footer（marginTop={1}）
    lines.push("", style(this.t("docLanguage.footer"), { dim: true }));

    return lines;
  }

  private handleSelect(value: string): void {
    this.selectedValue = value;
    this.app.config.setField("doc_language", value);
    // Enter 确认后返回上一级（使用 -1 避免路由栈堆积）
    this.app.navigate(-1);
  }

  private startSave(): void {
    this.app.config.setField("doc_language", this.selectedValue);
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
