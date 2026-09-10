/**
 * Config Custom Provider Page - 自定义 Provider/模型配置（pi-tui 版）
 *
 * 两种流程：
 * 1. 完全自定义 Provider (providerId === 'custom'): Base URL → Model Name → API Key
 * 2. 已有 Provider 自定义模型 (providerId !== 'custom'): Model Name → API Key
 *
 * 完成后直接返回首页，不自动保存（由首页 s 键统一保存）
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { getProviderRegistry } from "@open-zread/utils";
import type { AppConfig } from "@open-zread/types";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

type Step = "baseUrl" | "modelName" | "apiKey";

interface PrefilledValues {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

/** 与 usePrefilledConfig 等价的预填充计算 */
function computePrefilled(providerId: string | undefined, config: AppConfig): PrefilledValues {
  const id = providerId ?? "custom";
  const providerMatches = id === config.llm.provider;
  const modelMatches = providerMatches && config.llm.model !== null;

  return {
    apiKey: providerMatches ? (config.llm.api_key ?? "") : "",
    baseUrl: providerMatches ? (config.llm.base_url ?? "") : "",
    modelName: modelMatches ? (config.llm.model ?? "") : "",
  };
}

export default class ConfigCustomProviderPage extends Screen {
  private providerId: string | undefined;
  private isFullCustom = true;
  private step: Step = "baseUrl";

  private providerBaseUrl = "";
  private baseUrl = "";
  private modelName = "";
  private apiKey = "";
  private errors: Record<Step, string> = { baseUrl: "", modelName: "", apiKey: "" };

  private baseUrlField = new TextField();
  private modelNameField = new TextField();
  private apiKeyField = new TextField();

  protected override init(): void {
    this.providerId = this.app.location?.params.providerId;
    this.isFullCustom = this.providerId === "custom" || !this.providerId;
    this.step = this.isFullCustom ? "baseUrl" : "modelName";

    this.baseUrlField.onChange = (value) => {
      this.baseUrl = value;
    };
    this.modelNameField.onChange = (value) => {
      this.modelName = value;
    };
    this.apiKeyField.onChange = (value) => {
      this.apiKey = value;
    };

    this.baseUrlField.onSubmit = () => this.handleBaseUrlSubmit();
    this.modelNameField.onSubmit = () => this.handleModelNameSubmit();
    this.apiKeyField.onSubmit = () => this.handleApiKeySubmit();

    // 预填充值：当前 provider 匹配时才预填充
    const prefilled = computePrefilled(this.providerId, this.app.config.config);
    if (prefilled.baseUrl) {
      this.baseUrl = prefilled.baseUrl;
      this.modelName = prefilled.modelName;
      this.apiKey = prefilled.apiKey;
      this.baseUrlField.setValue(this.baseUrl);
      this.modelNameField.setValue(this.modelName);
      this.apiKeyField.setValue(this.apiKey);
    }

    this.baseUrlField.setPlaceholder(this.t("customProvider.baseUrlPlaceholder"));
    this.modelNameField.setPlaceholder(this.t("customProvider.modelNamePlaceholder"));
    this.apiKeyField.setPlaceholder(this.t("apikey.placeholder"));

    // 进入页面时声明 ESC 处理权（需要多步骤回退）
    this.app.claimEsc();
    this.updateFocus();

    if (!this.isFullCustom && this.providerId) {
      void this.loadProvider();
    }
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      this.handleBack();
      return true;
    }

    if (this.step === "baseUrl") this.baseUrlField.handleKey(data);
    else if (this.step === "modelName") this.modelNameField.handleKey(data);
    else this.apiKeyField.handleKey(data);
    return false;
  }

  override onDestroy(): void {
    this.app.releaseEsc();
  }

  render(width: number): string[] {
    const stepNumber = this.isFullCustom
      ? this.step === "baseUrl"
        ? 1
        : this.step === "modelName"
          ? 2
          : 3
      : this.step === "modelName"
        ? 1
        : 2;
    const totalSteps = this.isFullCustom ? 3 : 2;

    const lines: string[] = [];

    // 步骤显示（marginTop={1}）
    lines.push(
      "",
      style(this.t("customProvider.step", { current: stepNumber, total: totalSteps }), {
        dim: true,
      }),
    );

    // 步骤: Base URL（仅完全自定义）
    if (this.isFullCustom) {
      lines.push(
        "",
        this.renderStepHeader(
          "baseUrl",
          this.t("customProvider.baseUrl"),
          this.baseUrl,
          width,
        ),
      );
      if (this.step === "baseUrl") {
        lines.push(this.renderStepInput(this.baseUrlField, width));
        if (this.errors.baseUrl) lines.push(this.renderStepError(this.errors.baseUrl, width));
      }
    }

    // 步骤: Model Name
    lines.push(
      "",
      this.renderStepHeader(
        "modelName",
        this.t("customProvider.modelName"),
        this.modelName,
        width,
      ),
    );
    if (this.step === "modelName") {
      lines.push(this.renderStepInput(this.modelNameField, width));
      if (this.errors.modelName) lines.push(this.renderStepError(this.errors.modelName, width));
    }

    // 步骤: API Key
    lines.push(
      "",
      this.renderStepHeader("apiKey", this.t("customProvider.apikey"), this.apiKey, width, true),
    );
    if (this.step === "apiKey") {
      lines.push(this.renderStepInput(this.apiKeyField, width));
      if (this.errors.apiKey) lines.push(this.renderStepError(this.errors.apiKey, width));
    }

    // 已有 Provider 的 Base URL 提示
    if (!this.isFullCustom && this.providerBaseUrl && this.step === "modelName") {
      lines.push("", style(`Base URL: ${this.providerBaseUrl}`, { dim: true }));
    }

    // Footer（marginTop={1}）
    lines.push("", style(this.t("customProvider.footer"), { dim: true }));

    return lines;
  }

  // ==================== 内部实现 ====================

  private updateFocus(): void {
    this.baseUrlField.setFocused(this.step === "baseUrl");
    this.modelNameField.setFocused(this.step === "modelName");
    this.apiKeyField.setFocused(this.step === "apiKey");
  }

  private setStep(step: Step): void {
    this.step = step;
    this.updateFocus();
    this.refresh();
  }

  private renderStepHeader(
    step: Step,
    label: string,
    value: string,
    width: number,
    isSecret = false,
  ): string {
    const isCurrent = this.step === step;
    const indicator = style(isCurrent ? "> " : "  ", { color: isCurrent ? "cyan" : "gray" });
    const title = style(label, {
      bold: isCurrent,
      color: isCurrent ? "white" : "gray",
    });
    const suffix =
      !isCurrent && value
        ? style(`: ${isSecret ? this.t("apikey.hidden") : value}`, { dim: true, color: "green" })
        : "";
    return clampLine(indicator + title + suffix, width);
  }

  private renderStepInput(field: TextField, width: number): string {
    // <Box marginLeft={2}>
    const available = Math.max(1, width - 2);
    const line = field.render(available)[0] ?? "";
    return clampLine("  " + line, width);
  }

  private renderStepError(message: string, width: number): string {
    return clampLine("  " + style(message, { color: "red" }), width);
  }

  private async loadProvider(): Promise<void> {
    if (!this.providerId) return;
    try {
      const registry = await getProviderRegistry();
      const provider = registry.getProvider(this.providerId);
      if (provider) {
        this.providerBaseUrl = provider.base_url || "";
        if (provider.base_url) {
          this.baseUrl = provider.base_url;
          this.baseUrlField.setValue(provider.base_url);
        }
      }
    } catch {
      // 忽略加载失败
    }
    this.refresh();
  }

  /** URL 格式验证 */
  private validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  /** 前一步（ESC 由此处理，App 不处理） */
  private handleBack(): void {
    this.errors = { baseUrl: "", modelName: "", apiKey: "" };
    switch (this.step) {
      case "baseUrl":
        this.app.releaseEsc();
        this.app.navigate(-1);
        break;
      case "modelName":
        if (this.isFullCustom) {
          this.setStep("baseUrl");
        } else {
          this.app.releaseEsc();
          this.app.navigate(-1);
        }
        break;
      case "apiKey":
        this.setStep("modelName");
        break;
    }
  }

  /** Base URL 提交处理 */
  private handleBaseUrlSubmit(): void {
    this.errors = { ...this.errors, baseUrl: "" };

    if (!this.baseUrl.trim()) {
      this.errors = { ...this.errors, baseUrl: "URL 不能为空" };
      this.refresh();
      return;
    }
    if (!this.validateUrl(this.baseUrl)) {
      this.errors = { ...this.errors, baseUrl: this.t("customProvider.invalidUrl") };
      this.refresh();
      return;
    }
    this.setStep("modelName");
  }

  /** Model Name 提交处理 */
  private handleModelNameSubmit(): void {
    this.errors = { ...this.errors, modelName: "" };

    if (!this.modelName.trim()) {
      this.errors = { ...this.errors, modelName: "模型名称不能为空" };
      this.refresh();
      return;
    }
    this.setStep("apiKey");
  }

  /** API Key 提交处理：设置字段值，直接返回首页 */
  private handleApiKeySubmit(): void {
    this.errors = { ...this.errors, apiKey: "" };

    if (!this.apiKey.trim()) {
      this.errors = { ...this.errors, apiKey: this.t("apikey.required") };
      this.refresh();
      return;
    }

    // 设置配置字段（暂存，由首页 s 键统一保存）
    this.app.config.setField("llm.provider", this.providerId || "custom");
    this.app.config.setField("llm.model", this.modelName.trim());
    this.app.config.setField("llm.api_key", this.apiKey.trim());
    const finalBaseUrl = this.baseUrl.trim() || this.providerBaseUrl;
    if (finalBaseUrl) {
      this.app.config.setField("llm.base_url", finalBaseUrl);
    }

    // 直接返回上一级（使用 -1 避免路由栈堆积）
    this.app.releaseEsc();
    this.app.navigate(-1);
  }
}
