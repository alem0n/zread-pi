/**
 * Config Custom Model Page - 为指定 Provider 添加自定义模型
 *
 * 路由：/config/provider/:providerId/model-new
 *
 * 步骤：模型 ID → 显示名称 → 上下文窗口 → 最大输出 → 能力开关（t/v）→ 保存
 * 保存后写回 config.llm.providers[providerId].models，并重建 catalog（模型列表立即出现）。
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { setZreadCatalogConfig } from "@zread-pi/agent-runtime";
import type { CustomModelConfig } from "@zread-pi/types";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

type Step = "id" | "name" | "context" | "maxTokens" | "flags";

const STEP_ORDER: Step[] = ["id", "name", "context", "maxTokens", "flags"];

export default class ConfigCustomModelPage extends Screen {
  private providerId = "";
  private step: Step = "id";

  private modelId = "";
  private name = "";
  private contextWindow = "";
  private maxTokens = "";
  private reasoning = false;
  private supportsVision = false;

  private idField = new TextField();
  private nameField = new TextField();
  private contextField = new TextField();
  private maxTokensField = new TextField();
  private error: string | null = null;

  protected override init(): void {
    this.providerId = this.app.location?.params.providerId ?? "";
    if (!this.providerId) {
      this.app.navigate("/config/provider");
      return;
    }

    // 预填已选模型 / 默认值
    this.modelId = "";
    this.name = "";
    this.contextWindow = "128000";
    this.maxTokens = "16384";

    this.idField.setPlaceholder(this.t("customModel.idPlaceholder"));
    this.nameField.setPlaceholder(this.t("customModel.namePlaceholder"));
    this.contextField.setValue(this.contextWindow);
    this.maxTokensField.setValue(this.maxTokens);

    this.idField.onChange = (value) => {
      this.modelId = value;
    };
    this.nameField.onChange = (value) => {
      this.name = value;
    };
    this.contextField.onChange = (value) => {
      this.contextWindow = value;
    };
    this.maxTokensField.onChange = (value) => {
      this.maxTokens = value;
    };

    this.idField.onSubmit = () => this.handleNext();
    this.nameField.onSubmit = () => this.handleNext();
    this.contextField.onSubmit = () => this.handleNext();
    this.maxTokensField.onSubmit = () => this.handleNext();

    this.app.claimEsc();
    this.updateFocus();
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.handleBack();
      return true;
    }

    if (this.step === "flags") {
      if (data === "t") {
        this.reasoning = !this.reasoning;
        this.refresh();
        return true;
      }
      if (data === "v") {
        this.supportsVision = !this.supportsVision;
        this.refresh();
        return true;
      }
      if (matchesKey(data, "return")) {
        this.save();
        return true;
      }
      return false;
    }

    const field = this.fieldFor(this.step);
    if (matchesKey(data, "return")) {
      this.handleNext();
      return true;
    }
    field?.handleKey(data);
    return false;
  }

  override onDestroy(): void {
    this.app.releaseEsc();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const stepNumber = STEP_ORDER.indexOf(this.step) + 1;

    lines.push(
      "",
      style(this.t("customModel.title"), { bold: true, color: "cyan" }),
      style(this.t("customProvider.step", { current: stepNumber, total: STEP_ORDER.length }), {
        dim: true,
      }),
    );

    lines.push(
      "",
      this.renderHeader("id", this.t("customModel.id"), this.modelId, width),
      ...(this.step === "id"
        ? [
            this.renderInput(this.idField, width),
            ...(this.error ? [this.renderError(this.error, width)] : []),
          ]
        : []),
    );

    lines.push(
      "",
      this.renderHeader("name", this.t("customModel.name"), this.name, width),
      ...(this.step === "name" ? [this.renderInput(this.nameField, width)] : []),
    );

    lines.push(
      "",
      this.renderHeader("context", this.t("customModel.contextWindow"), this.contextWindow, width),
      ...(this.step === "context"
        ? [
            this.renderInput(this.contextField, width),
            ...(this.error ? [this.renderError(this.error, width)] : []),
          ]
        : []),
    );

    lines.push(
      "",
      this.renderHeader("maxTokens", this.t("customModel.maxTokens"), this.maxTokens, width),
      ...(this.step === "maxTokens"
        ? [
            this.renderInput(this.maxTokensField, width),
            ...(this.error ? [this.renderError(this.error, width)] : []),
          ]
        : []),
    );

    // 能力开关
    const flag = (enabled: boolean) => style(enabled ? "[x]" : "[ ]", { color: enabled ? "green" : "gray" });
    lines.push(
      "",
      clampLine(
        `  ${flag(this.reasoning)} ${this.t("customModel.reasoning")}    ${flag(this.supportsVision)} ${this.t("customModel.vision")}`,
        width,
      ),
      style(`  ${this.t("customModel.toggleHint")}`, { dim: true }),
      this.error && this.step === "flags" ? this.renderError(this.error, width) : "",
    );

    lines.push("", style(this.t("customModel.footer"), { dim: true }));
    return lines;
  }

  // ==================== 内部实现 ====================

  private fieldFor(step: Step): TextField | undefined {
    switch (step) {
      case "id":
        return this.idField;
      case "name":
        return this.nameField;
      case "context":
        return this.contextField;
      case "maxTokens":
        return this.maxTokensField;
      default:
        return undefined;
    }
  }

  private updateFocus(): void {
    this.idField.setFocused(this.step === "id");
    this.nameField.setFocused(this.step === "name");
    this.contextField.setFocused(this.step === "context");
    this.maxTokensField.setFocused(this.step === "maxTokens");
  }

  private setStep(step: Step): void {
    this.step = step;
    this.error = null;
    this.updateFocus();
    this.refresh();
  }

  private renderHeader(step: Step, label: string, value: string, width: number): string {
    const isCurrent = this.step === step;
    const done = STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(this.step);
    const indicator = style(isCurrent ? "> " : "  ", { color: isCurrent ? "cyan" : "gray" });
    const title = style(label, { bold: isCurrent, color: isCurrent ? "white" : "gray" });
    const suffix = done && value ? style(`: ${value}`, { dim: true, color: "green" }) : "";
    return clampLine(indicator + title + suffix, width);
  }

  private renderInput(field: TextField, width: number): string {
    const available = Math.max(1, width - 2);
    const line = field.render(available)[0] ?? "";
    return clampLine("  " + line, width);
  }

  private renderError(message: string, width: number): string {
    return clampLine("  " + style(message, { color: "red" }), width);
  }

  private handleNext(): void {
    switch (this.step) {
      case "id": {
        if (!this.modelId.trim()) {
          this.error = this.t("customModel.idRequired");
          this.refresh();
          return;
        }
        this.setStep("name");
        return;
      }
      case "name":
        this.setStep("context");
        return;
      case "context": {
        if (!this.isPositiveInt(this.contextWindow)) {
          this.error = this.t("customModel.invalidNumber");
          this.refresh();
          return;
        }
        this.setStep("maxTokens");
        return;
      }
      case "maxTokens": {
        if (!this.isPositiveInt(this.maxTokens)) {
          this.error = this.t("customModel.invalidNumber");
          this.refresh();
          return;
        }
        this.setStep("flags");
        return;
      }
      case "flags":
        this.save();
        return;
    }
  }

  private isPositiveInt(value: string): boolean {
    const text = value.trim();
    if (!text) return true;
    const num = Number.parseInt(text, 10);
    return Number.isFinite(num) && num > 0;
  }

  private handleBack(): void {
    this.error = null;
    switch (this.step) {
      case "id":
        this.app.releaseEsc();
        this.app.navigate(-1);
        return;
      case "name":
        this.setStep("id");
        return;
      case "context":
        this.setStep("name");
        return;
      case "maxTokens":
        this.setStep("context");
        return;
      case "flags":
        this.setStep("maxTokens");
        return;
    }
  }

  private save(): void {
    const model: CustomModelConfig = { id: this.modelId.trim() };
    if (this.name.trim()) model.name = this.name.trim();
    model.context_window = Number.parseInt(this.contextWindow.trim() || "128000", 10);
    model.max_tokens = Number.parseInt(this.maxTokens.trim() || "16384", 10);
    if (this.reasoning) model.reasoning = true;
    if (this.supportsVision) model.supports_vision = true;

    this.app.config.upsertCustomModel(this.providerId, model);
    // 让 CLI 里的 catalog 立即看到新模型（未保存的修改也能预览）
    setZreadCatalogConfig(this.app.config.config);

    this.app.releaseEsc();
    this.app.navigate(-1);
  }
}
