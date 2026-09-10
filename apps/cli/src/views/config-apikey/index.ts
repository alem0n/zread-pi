/**
 * Config API Key Page - API Key 输入（pi-tui 版）
 *
 * 功能:
 * - 输入 API Key
 * - 验证非空
 * - 自动填充 base_url
 * - 设置配置字段，返回首页（不自动保存）
 *
 * 按键：Enter 下一步/保存 | ESC（API Key 编辑态）返回上一级 | ESC（Base URL 编辑态）返回编辑 API Key
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getProviderRegistry } from "@open-zread/utils";
import type { AppConfig } from "@open-zread/types";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine } from "../../tui/text-layout";

/** 与 usePrefilledConfig 等价的预填充计算 */
function computePrefilled(
  providerId: string | undefined,
  config: AppConfig,
): { apiKey: string; baseUrl: string; modelName: string } {
  const id = providerId ?? "custom";
  const providerMatches = id === config.llm.provider;
  const modelMatches = providerMatches && config.llm.model !== null;

  return {
    apiKey: providerMatches ? (config.llm.api_key ?? "") : "",
    baseUrl: providerMatches ? (config.llm.base_url ?? "") : "",
    modelName: modelMatches ? (config.llm.model ?? "") : "",
  };
}

export default class ConfigApiKeyPage extends Screen {
  private providerId: string | undefined;
  private modelId: string | undefined;
  private customModelName: string | null = null;

  private apiKey = "";
  private baseUrl = "";
  private isEditingApiKey = true;
  private error: string | null = null;
  private providerBaseUrl = "";

  private apiKeyField = new TextField({ placeholder: "sk-..." });
  private baseUrlField = new TextField({ placeholder: "https://api.example.com/v1" });

  protected override init(): void {
    const params = this.app.location?.params ?? {};
    this.providerId = params.providerId;
    this.modelId = params.modelId;
    this.customModelName = this.app.location?.query.get("model") ?? null;

    // 预填充值：provider 匹配时预填充 api_key 和 base_url
    const prefilled = computePrefilled(this.providerId, this.app.config.config);
    if (prefilled.apiKey) {
      this.apiKey = prefilled.apiKey;
      this.baseUrl = prefilled.baseUrl;
    }

    this.apiKeyField.setValue(this.apiKey);
    this.baseUrlField.setValue(this.baseUrl);
    this.apiKeyField.onChange = (value) => {
      this.apiKey = value;
    };
    this.baseUrlField.onChange = (value) => {
      this.baseUrl = value;
    };
    this.apiKeyField.onSubmit = () => this.handleApiKeySubmit();
    this.baseUrlField.onSubmit = () => this.handleBaseUrlSubmit();

    // API Key 编辑模式：释放 ESC（让 App 处理返回上一级）
    this.app.releaseEsc();
    void this.loadProvider(prefilled.baseUrl);
  }

  override handleKey(data: string): boolean {
    if (!this.isEditingApiKey && matchesKey(data, "escape")) {
      // Base URL 编辑模式：ESC 返回 API Key 编辑
      this.setEditing(true);
      return true;
    }

    if (this.isEditingApiKey) {
      this.apiKeyField.handleKey(data);
    } else {
      this.baseUrlField.handleKey(data);
    }
    return false;
  }

  override onDestroy(): void {
    this.app.releaseEsc();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // API Key 输入（marginTop={1}）
    const apiKeyLabel = this.isEditingApiKey
      ? style("API Key: ", { color: "cyan" })
      : style("API Key: ", { color: "gray" });
    if (this.isEditingApiKey) {
      lines.push("", this.composeRow(apiKeyLabel, this.apiKeyField, width));
    } else {
      const hidden =
        this.apiKey.length > 0 ? this.t("apikey.hidden") : "(未设置)";
      lines.push("", clampLine(apiKeyLabel + style(hidden, { dim: true }), width));
    }

    // 错误提示
    if (this.error) {
      lines.push("", style(this.error, { color: "red" }));
    }

    // Base URL 输入（非编辑 API Key 时显示）
    if (!this.isEditingApiKey) {
      const baseUrlLabel = style("Base URL: ", { color: "cyan" });
      lines.push("", this.composeRow(baseUrlLabel, this.baseUrlField, width));
    }

    // Footer
    lines.push(
      "",
      style(
        this.isEditingApiKey
          ? `enter 下一步 | ${this.t("common.escBack")}`
          : "enter 保存 | esc 返回编辑 API Key",
        { dim: true },
      ),
    );

    return lines;
  }

  // ==================== 内部实现 ====================

  private composeRow(label: string, field: TextField, width: number): string {
    const labelWidth = visibleWidth(label);
    const inputLine = field.render(Math.max(1, width - labelWidth))[0] ?? "";
    return clampLine(label + inputLine, width);
  }

  private setEditing(editing: boolean): void {
    this.isEditingApiKey = editing;
    this.apiKeyField.setFocused(editing);
    this.baseUrlField.setFocused(!editing);
    if (editing) {
      this.app.releaseEsc();
    } else {
      this.app.claimEsc();
    }
    this.refresh();
  }

  private async loadProvider(prefilledBaseUrl: string): Promise<void> {
    if (!this.providerId) {
      this.app.navigate("/config/provider");
      return;
    }

    try {
      const registry = await getProviderRegistry();
      const provider = registry.getProvider(this.providerId);
      if (provider) {
        this.providerBaseUrl = provider.base_url || "";
        this.baseUrlField.setPlaceholder(
          this.providerBaseUrl || "https://api.example.com/v1",
        );
        // 只有没有预填充值时，才使用 provider 的默认 base_url
        if (!prefilledBaseUrl && provider.base_url) {
          this.baseUrl = provider.base_url;
          this.baseUrlField.setValue(provider.base_url);
        }
      }
    } catch {
      // 忽略加载失败（与迁移前一致：不显示错误）
    }
    this.refresh();
  }

  /** API Key 提交处理 */
  private handleApiKeySubmit(): void {
    if (!this.apiKey.trim()) {
      this.error = this.t("apikey.required");
      this.refresh();
      return;
    }
    this.error = null;
    this.setEditing(false);
  }

  /** Base URL 提交处理（保存） */
  private handleBaseUrlSubmit(): void {
    if (!this.apiKey.trim()) {
      this.error = this.t("apikey.required");
      this.refresh();
      return;
    }

    this.error = null;

    // 设置配置字段（暂存，由首页 s 键统一保存）
    this.app.config.setField("llm.provider", this.providerId || "");
    this.app.config.setField("llm.model", this.modelId || this.customModelName || "");
    this.app.config.setField("llm.api_key", this.apiKey);
    const finalBaseUrl = this.baseUrl.trim() || this.providerBaseUrl;
    if (finalBaseUrl) {
      this.app.config.setField("llm.base_url", finalBaseUrl);
    }

    // 直接返回上一级（使用 -1 避免路由栈堆积）
    this.app.releaseEsc();
    this.app.navigate(-1);
  }
}
