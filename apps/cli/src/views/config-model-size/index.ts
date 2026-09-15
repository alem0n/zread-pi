/**
 * Config Model Size Page - 当前模型的上下文窗口 / 最大输出 tokens 覆盖
 *
 * 路由：/config/model-size
 *
 * llm.context_window / llm.max_tokens 覆盖「当前生效模型」的目录元数据：
 *  - 留空 = 跟随模型目录默认（pi-ai 内置或用户自定义模型自带的 contextWindow / maxTokens）；
 *  - 显式正值 = 覆盖：影响请求时的输出上限（pi-ai 仍会按上下文窗口钳制）与上下文压缩阈值，
 *    并作为生成页「上下文占比」的分母（system/init 上报的 context_window 来自解析出的模型）。
 *
 * 与 agent.token_budget 的区别：max_tokens 是**单次请求**的输出上限，token_budget 是
 * **整次 Agent 运行**的累计预算（首尾机制），两者互不影响。
 *
 * 按键：tab / shift+tab / ↑↓ 切换字段 | enter 保存并返回 | s 保存 | d 恢复模型默认 | esc 返回
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getZreadModel, setZreadCatalogConfig } from "@zread-pi/agent-runtime";
import {
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  MIN_MODEL_CONTEXT_WINDOW,
  MIN_MODEL_MAX_TOKENS,
} from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

type Field = "context" | "maxTokens";
type SaveStatus = "idle" | "saving" | "saved" | "failed";

/** 模型目录自带的默认值（当前模型不在目录中时的回退值，与 runtime-model.ts 对齐） */
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

export default class ConfigModelSizePage extends Screen {
  private focus: Field = "context";
  private contextField = new TextField();
  private maxTokensField = new TextField();
  private error: string | null = null;
  private saveStatus: SaveStatus = "idle";
  private timer?: ReturnType<typeof setTimeout>;
  /** 模型目录默认值（留空字段时的参照） */
  private defaultContextWindow = FALLBACK_CONTEXT_WINDOW;
  private defaultMaxTokens = FALLBACK_MAX_OUTPUT_TOKENS;

  protected override init(): void {
    // catalog 使用 CLI 内存配置（与思考深度页一致，未保存的修改也能反映）
    setZreadCatalogConfig(this.app.config.config);

    const { provider, model } = this.app.config.config.llm;
    const catalogModel = provider && model ? getZreadModel(provider, model) : undefined;
    if (catalogModel) {
      this.defaultContextWindow = catalogModel.contextWindow;
      this.defaultMaxTokens = catalogModel.maxTokens;
    }

    // 字段只显示「覆盖值」；未覆盖时留空，placeholder 给出模型目录默认值
    const contextOverride = this.app.config.getModelContextWindow();
    const maxTokensOverride = this.app.config.getModelMaxTokens();
    this.contextField.setValue(contextOverride !== null ? String(contextOverride) : "");
    this.maxTokensField.setValue(maxTokensOverride !== null ? String(maxTokensOverride) : "");
    this.contextField.setPlaceholder(String(this.defaultContextWindow));
    this.maxTokensField.setPlaceholder(String(this.defaultMaxTokens));

    this.contextField.onChange = () => {
      this.error = null;
      this.saveStatus = "idle";
    };
    this.maxTokensField.onChange = () => {
      this.error = null;
      this.saveStatus = "idle";
    };

    this.updateFocus();
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) return false; // 交给 App 返回上一级

    // tab / shift+tab / ↑↓：在两个字段间切换焦点
    if (
      matchesKey(data, "tab") ||
      matchesKey(data, "shift+tab") ||
      matchesKey(data, "up") ||
      matchesKey(data, "down")
    ) {
      this.setFocus(this.focus === "context" ? "maxTokens" : "context");
      return true;
    }

    if (data === "d" && this.saveStatus === "idle") {
      this.resetToDefault();
      return true;
    }

    if (matchesKey(data, "return") && this.saveStatus === "idle") {
      if (this.applyToConfig()) this.app.navigate(-1);
      return true;
    }

    if (data === "s" && this.saveStatus === "idle") {
      if (this.applyToConfig()) this.startSave();
      return true;
    }

    this.activeField().handleKey(data);
    return false;
  }

  override onDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const { provider, model } = this.app.config.config.llm;

    lines.push(...new Divider(this.t("modelSize.title")).render(width));

    lines.push("");
    if (provider && model) {
      lines.push(
        clampLine(
          style(`${this.t("layout.model")}: `, { dim: true }) +
            style(`${provider} · ${model}`, { color: "cyan" }),
          width,
        ),
      );
    } else {
      lines.push(clampLine(style(this.t("modelSize.modelUnset"), { dim: true, color: "yellow" }), width));
    }
    lines.push(
      clampLine(
        style(
          this.t("modelSize.defaults", {
            context: this.defaultContextWindow,
            maxTokens: this.defaultMaxTokens,
          }),
          { dim: true },
        ),
        width,
      ),
    );
    lines.push(clampLine(style(this.t("modelSize.hint"), { dim: true }), width));

    lines.push("", ...this.renderFieldRow("context", width));
    lines.push("", ...this.renderFieldRow("maxTokens", width));

    if (this.error) {
      lines.push("", clampLine(style(this.error, { color: "red" }), width));
    }
    if (this.saveStatus === "saving") {
      lines.push("", clampLine(style(this.t("apikey.saving"), { color: "yellow" }), width));
    }
    if (this.saveStatus === "saved") {
      lines.push("", clampLine(style(this.t("config.saved"), { color: "green" }), width));
    }
    if (this.saveStatus === "failed") {
      lines.push("", clampLine(style(this.t("config.saveFailed"), { color: "red" }), width));
    }

    lines.push("", clampLine(style(this.t("modelSize.footer"), { dim: true }), width));
    return lines;
  }

  // ==================== 内部实现 ====================

  private activeField(): TextField {
    return this.focus === "context" ? this.contextField : this.maxTokensField;
  }

  private fieldFor(field: Field): TextField {
    return field === "context" ? this.contextField : this.maxTokensField;
  }

  private updateFocus(): void {
    this.contextField.setFocused(this.focus === "context");
    this.maxTokensField.setFocused(this.focus === "maxTokens");
  }

  private setFocus(field: Field): void {
    if (this.focus === field) return;
    this.focus = field;
    this.updateFocus();
    this.refresh();
  }

  private renderFieldRow(field: Field, width: number): string[] {
    const isCurrent = this.focus === field;
    const label = style(this.t(field === "context" ? "modelSize.contextWindow" : "modelSize.maxTokens"), {
      bold: isCurrent,
      color: isCurrent ? "white" : "gray",
    });
    const indicator = style(isCurrent ? "> " : "  ", { color: isCurrent ? "cyan" : "gray" });
    const labelWidth = visibleWidth(indicator + label) + 1;
    const input = this.fieldFor(field).render(Math.max(1, width - labelWidth))[0] ?? "";
    return [clampLine(`${indicator}${label} ${input}`, width)];
  }

  /** 解析单个字段：空 = null（跟随默认）；范围内正整数保留；否则返回错误信息 */
  private parseField(field: Field): { value: number | null } | { error: string } {
    const raw = this.fieldFor(field).getValue().trim();
    if (raw === "") return { value: null };
    const num = Number.parseInt(raw, 10);
    const min = field === "context" ? MIN_MODEL_CONTEXT_WINDOW : MIN_MODEL_MAX_TOKENS;
    const max = field === "context" ? MAX_MODEL_CONTEXT_WINDOW : MAX_MODEL_MAX_TOKENS;
    if (!Number.isInteger(num) || num < min || num > max) {
      return {
        error: this.t(field === "context" ? "modelSize.invalidContext" : "modelSize.invalidMaxTokens", {
          min,
          max,
        }),
      };
    }
    return { value: num };
  }

  /** 校验并写回内存配置；失败时展示错误并返回 false */
  private applyToConfig(): boolean {
    const context = this.parseField("context");
    if ("error" in context) {
      this.error = context.error;
      this.refresh();
      return false;
    }
    const maxTokens = this.parseField("maxTokens");
    if ("error" in maxTokens) {
      this.error = maxTokens.error;
      this.refresh();
      return false;
    }
    this.error = null;
    this.app.config.setModelSize(context.value, maxTokens.value);
    return true;
  }

  /** d：恢复模型默认（两个字段清空 = 跟随目录默认，并写回内存配置） */
  private resetToDefault(): void {
    this.contextField.setValue("");
    this.maxTokensField.setValue("");
    this.error = null;
    this.app.config.setModelSize(null, null);
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
