/**
 * Config Thinking Page - 思考深度设置（pi thinking level，pi-tui 版）
 *
 * 路由：/config/thinking
 *
 * 等级与 pi 一致：off / minimal / low / medium / high / xhigh / max。
 * - 未选择模型：7 个等级全部可选（请求时由 pi 按模型能力自动调整）
 * - 已选择模型：调用 agent-runtime 的 getZreadThinkingLevels()，
 *   模型不支持的等级会标注「当前模型不支持，请求时自动调整」（仍可选）
 *
 * 按键：↑↓ 选择 | Enter 确认并返回 | s 保存并返回 | ESC 返回
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@open-zread/types";
import { THINKING_LEVELS } from "@open-zread/utils";
import { getZreadThinkingLevels, setZreadCatalogConfig } from "@open-zread/agent-runtime";
import { Divider } from "../../tui/components/divider";
import { Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";
import { thinkingLevelLabel } from "../../utils/thinking";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export default class ConfigThinkingPage extends Screen {
  private select!: Select<{ value: ThinkingLevel }>;
  private selectedValue: ThinkingLevel = "off";
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;
  /** 当前模型支持的等级（未选模型时为全部等级） */
  private supported: ThinkingLevel[] = [...THINKING_LEVELS];
  private modelLabel: string | null = null;

  protected override init(): void {
    // catalog 使用 CLI 内存配置（与 Provider 详情页一致，未保存的改动也能反映）
    setZreadCatalogConfig(this.app.config.config);

    const { provider, model } = this.app.config.config.llm;
    this.selectedValue = this.app.config.config.llm.thinking_level ?? "off";
    this.supported = getZreadThinkingLevels(provider, model);
    this.modelLabel = provider && model ? `${provider} · ${model}` : null;

    this.select = new Select({
      items: THINKING_LEVELS.map((level) => ({ value: level })),
      initialIndex: Math.max(0, THINKING_LEVELS.indexOf(this.selectedValue)),
      renderItem: (item, isSelected) => [this.renderLevelRow(item.value, isSelected)],
      onHighlight: (item) => {
        this.selectedValue = item.value;
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
    lines.push(...new Divider(this.t("thinking.title")).render(width));

    // 当前值
    lines.push(
      style(`${this.t("thinking.current")}: `, { dim: true }) +
        style(thinkingLevelLabel(this.app.config.config.llm.thinking_level, (key) => this.t(key)), {
          color: "cyan",
        }),
    );

    // 模型与支持情况
    lines.push("");
    if (this.modelLabel) {
      lines.push(
        style(`${this.t("layout.model")}: `, { dim: true }) + clampLine(this.modelLabel, width),
      );
      lines.push(
        style(
          this.t("thinking.supported", { levels: this.supported.map((level) => level).join(" / ") }),
          { dim: true },
        ),
      );
    } else {
      lines.push(style(this.t("thinking.modelUnset"), { dim: true }));
    }

    // 保存状态
    if (this.saveStatus === "saving") {
      lines.push("", style("正在保存...", { color: "yellow" }));
    } else if (this.saveStatus === "saved") {
      lines.push("", style(this.t("config.saved"), { color: "green" }));
    } else if (this.saveStatus === "failed") {
      lines.push("", style(this.t("config.saveFailed"), { color: "red" }));
    }

    const pre = [...lines, ""];
    const post = ["", style(this.t("thinking.footer"), { dim: true })];
    this.select.setViewportRows(Math.max(1, this.app.availableRows - pre.length - post.length));

    return [...pre, ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  /** 等级行：模型不支持时追加提示（仍可选，pi 会在请求时自动调整） */
  private renderLevelRow(level: ThinkingLevel, isSelected: boolean): string {
    const supported = this.supported.includes(level);
    const label = thinkingLevelLabel(level, (key) => this.t(key));
    const suffix = supported ? "" : ` · ${this.t("thinking.unsupportedLevel")}`;
    const indicator = isSelected ? style("❯", { color: "blue" }) : " ";
    const indent = indicator + " ".repeat(visibleWidth(indicator));
    const text = isSelected
      ? style(label + suffix, { color: "blue" })
      : supported
        ? label + suffix
        : style(label + suffix, { dim: true });
    return indent + text;
  }

  private handleSelect(level: ThinkingLevel): void {
    this.selectedValue = level;
    this.app.config.setField("llm.thinking_level", level);
    // Enter 确认后返回上一级（使用 -1 避免路由栈堆积）
    this.app.navigate(-1);
  }

  private startSave(): void {
    this.app.config.setField("llm.thinking_level", this.selectedValue);
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
