/**
 * Config Custom Provider Page - 自定义 Provider/模型配置（pi-tui 版）
 *
 * 两种流程：
 * 1. 完全自定义 Provider (providerId === 'custom'): Base URL → Model Name → API Key
 * 2. 已有 Provider 自定义模型 (providerId !== 'custom'): Model Name → API Key
 *
 * 凭据写入 ~/.zread/auth.json（pi-ai login），模型与 base_url 写入
 * config.llm.providers[providerId]，由首页 s 键统一保存。
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { getZreadProvider, loginZreadProvider, setZreadCatalogConfig } from "@open-zread/agent-runtime";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";
import { migrateLegacyCredentials } from "../../utils/llm-config";

type Step = "baseUrl" | "modelName" | "apiKey";

export default class ConfigCustomProviderPage extends Screen {
  private providerId: string | undefined;
  private isFullCustom = true;
  private step: Step = "baseUrl";

  private providerBaseUrl = "";
  private baseUrl = "";
  private modelName = "";
  private apiKey = "";
  private errors: Record<Step, string> = { baseUrl: "", modelName: "", apiKey: "" };
  private saving = false;

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
    this.apiKeyField.onSubmit = () => void this.handleApiKeySubmit();

    // 预填充：config.llm.providers[id] 的 base_url / 最近模型
    const id = this.providerId ?? "custom";
    const providerConfig = this.app.config.getProviderConfig(id);
    if (providerConfig.base_url) {
      this.baseUrl = providerConfig.base_url;
      this.baseUrlField.setValue(this.baseUrl);
    }
    if (providerConfig.model) {
      this.modelName = providerConfig.model;
      this.modelNameField.setValue(this.modelName);
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

    if (this.saving) {
      lines.push("", style(this.t("auth.loggingIn"), { color: "yellow" }));
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
    const provider = getZreadProvider(this.providerId);
    if (provider) {
      this.providerBaseUrl = provider.baseUrl ?? "";
      if (provider.baseUrl) {
        this.baseUrl = provider.baseUrl;
        this.baseUrlField.setValue(provider.baseUrl);
      }
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
    if (this.saving) return;
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

  /** API Key 提交处理：pi-ai login 写凭据 + 配置写模型，返回上一级 */
  private async handleApiKeySubmit(): Promise<void> {
    this.errors = { ...this.errors, apiKey: "" };

    if (!this.apiKey.trim()) {
      this.errors = { ...this.errors, apiKey: this.t("apikey.required") };
      this.refresh();
      return;
    }

    const providerId = this.providerId || "custom";
    const modelId = this.modelName.trim();
    const finalBaseUrl = (this.baseUrl.trim() || this.providerBaseUrl) || null;

    // 1) 配置：provider + 自定义模型（先迁移旧扁平字段，再切当前模型）
    this.app.config.setProviderConfig(providerId, {
      base_url: finalBaseUrl,
      api: this.app.config.getProviderConfig(providerId).api ?? "openai-completions",
      auth_type: "api_key",
    });
    this.app.config.upsertCustomModel(providerId, { id: modelId, name: modelId });
    await migrateLegacyCredentials(this.app.config);
    this.app.config.setActiveModel(providerId, modelId);

    // 2) 凭据：交给 pi-ai login 写入 ~/.zread/auth.json
    this.saving = true;
    this.refresh();
    try {
      setZreadCatalogConfig(this.app.config.config);
      await loginZreadProvider(providerId, "api_key", {
        prompt: async () => this.apiKey.trim(),
        notify: () => {
          // 自定义 Provider 的 api_key 登录没有额外事件
        },
      });
    } catch (err) {
      this.errors = {
        ...this.errors,
        apiKey: err instanceof Error ? err.message : String(err),
      };
      this.saving = false;
      this.refresh();
      return;
    }

    this.saving = false;
    // 直接返回上一级（使用 -1 避免路由栈堆积）
    this.app.releaseEsc();
    this.app.navigate(-1);
  }
}
