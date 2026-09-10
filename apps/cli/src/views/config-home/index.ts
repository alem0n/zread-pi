/**
 * Config Home Page - 主配置页面（pi-tui 版）
 *
 * Layout: 选择列表，每项显示标题+值，左侧 │ 标记选中项
 * 按键：↑↓ 选择 | Enter 进入 | s 保存（有改动时）
 */

import type { AppConfig } from "@open-zread/types";
import { Divider } from "../../tui/components/divider";
import { barIndicator, Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";

interface ConfigItem {
  key: string;
  labelKey: string;
  getValue: (config: AppConfig, t: (key: string, params?: Record<string, string | number>) => string) => string;
  default?: string;
  route: string;
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

// 配置项定义（动态获取值，使用翻译函数）
const configItems: ConfigItem[] = [
  {
    key: "language",
    labelKey: "config.selectLanguage",
    getValue: (config, t) => (config.language === "zh" ? t("language.zh") : t("language.en")),
    route: "/config/language",
  },
  {
    key: "doc_language",
    labelKey: "config.docLanguage",
    getValue: (config, t) =>
      config.doc_language === "zh" ? t("language.zh") : t("language.en"),
    route: "/config/doc_language",
  },
  {
    key: "llm.provider",
    labelKey: "config.llmProvider",
    getValue: (config, t) => {
      if (config.llm.provider === null || config.llm.model === null) {
        return t("config.notConfigured");
      }
      return `${config.llm.provider} · ${config.llm.model}`;
    },
    route: "/config/provider",
  },
  {
    key: "concurrency.max_concurrent",
    labelKey: "config.maxConcurrency",
    getValue: (config, _t) => String(config.concurrency.max_concurrent),
    default: "1",
    route: "/config/concurrency",
  },
  {
    key: "concurrency.max_retries",
    labelKey: "config.maxRetries",
    getValue: (config, _t) => String(config.concurrency.max_retries),
    default: "0",
    route: "/config/retry",
  },
];

export default class ConfigHomePage extends Screen {
  private select: Select<{ value: string; item: ConfigItem }>;
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.select = new Select({
      items: configItems.map((item) => ({ value: item.key, item })),
      renderItem: (entry, isSelected) => this.renderConfigItem(entry.item, isSelected),
      onSelect: (entry) => this.app.navigate(entry.item.route),
    });
  }

  override handleKey(data: string): boolean {
    // ESC 退出程序由 App 统一处理，这里只监听 s 键保存
    if (data === "s" && this.app.config.hasChanges && this.saveStatus === "idle") {
      this.startSave();
      return true;
    }
    return this.select.handleInput(data);
  }

  override onDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  render(width: number): string[] {
    const t = this.app.t.bind(this.app);
    const lines: string[] = [];

    lines.push(...new Divider(`${t("config.title")} · ~/.zread/config.yaml`).render(width));

    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    }
    if (this.saveStatus === "saved") {
      lines.push("", style(t("config.saved"), { color: "green" }));
    }
    if (this.saveStatus === "failed") {
      lines.push("", style(t("config.saveFailed"), { color: "red" }));
    }
    if (this.app.config.hasChanges && this.saveStatus === "idle") {
      lines.push(
        "",
        style(`${t("config.hasUnsavedChanges")} · ${t("config.pressS")}`, { color: "yellow" }),
      );
    }

    // 配置项选择列表（marginTop={1}）+ Footer（marginTop={1}）
    const pre = [...lines];
    const post = ["", style(t("config.footer"), { dim: true })];
    this.select.setViewportRows(
      Math.max(3, this.app.availableRows - pre.length - 1 - post.length),
    );

    return [...pre, "", ...this.select.render(width), ...post];
  }

  private startSave(): void {
    this.saveStatus = "saving";
    this.refresh();
    this.app.config.save().then((success) => {
      this.saveStatus = success ? "saved" : "failed";
      this.refresh();
      this.timer = setTimeout(() => {
        this.saveStatus = "idle";
        this.refresh();
      }, 2000);
    });
  }

  /** 自定义选项渲染 - 两行布局（标题+值）+ 空行分隔 */
  private renderConfigItem(item: ConfigItem, isSelected: boolean): string[] {
    const t = this.app.t.bind(this.app);
    const value = item.getValue(this.app.config.config, t);
    const indicator = barIndicator(isSelected);
    const labelStyle = isSelected
      ? { bold: true, color: "white" }
      : { bold: false, color: "gray" };
    const valueStyle = isSelected ? { color: "cyan" } : { color: "white" };

    const defaultText = item.default
      ? style(" " + t("config.default", { default: item.default }), {
          dim: true,
          bold: labelStyle.bold,
          color: labelStyle.color,
        })
      : "";

    return [
      indicator + style(t(item.labelKey), labelStyle) + defaultText,
      indicator + style(value, valueStyle),
      // 空行分隔
      "",
    ];
  }
}
