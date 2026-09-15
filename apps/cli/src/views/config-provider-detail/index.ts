/**
 * Config Provider Detail Page - 单个提供商的配置页（pi-tui 版）
 *
 * 路由：/config/provider/:providerId
 *
 * 布局：同一页面并列两块配置
 *   1. API Key 配置（仅 API Key，不提供 OAuth 订阅选项）
 *   2. 模型选择（pi-ai 内置目录 + 自定义模型；r 刷新模型，a 添加自定义模型）
 *
 * 焦点：tab / shift+tab 在两块配置间切换；模型列表焦点下按 i 也可回到 API Key 输入。
 * 选择模型时若 API Key 输入框里还有未保存的值，会先保存再设为当前模型。
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
  getZreadCatalog,
  getZreadModel,
  getZreadProvider,
  getZreadProviderModels,
  loginZreadProvider,
  refreshZreadProviderModels,
  setZreadCatalogConfig,
} from "@zread-pi/agent-runtime";
import { barIndicator, computeItemWindow, scrollIndicator } from "../../tui/components/select";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, padRight } from "../../tui/text-layout";
import { migrateLegacyCredentials } from "../../utils/llm-config";

/** 只读取 UI 需要的字段（避免 CLI 直接依赖 pi-ai 类型） */
interface CatalogModel {
  id: string;
  name: string;
  maxTokens: number;
  contextWindow: number;
  reasoning: boolean;
  input: readonly string[];
}

type ListItem = { kind: "model"; model: CatalogModel } | { kind: "custom" };
type FocusArea = "apiKey" | "models";
type RefreshStatus = "idle" | "refreshing" | "done" | "unsupported" | "failed";

export default class ConfigProviderDetailPage extends Screen {
  private providerId = "";
  private providerName = "";
  /** 自定义 Provider（非内置）：允许编辑名称 / Base URL / 协议 */
  private providerCustom = false;
  private models: readonly CatalogModel[] = [];
  private selectedIndex = 0;
  private loading = true;
  private error: string | null = null;

  // ---- API Key 配置 ----
  private focus: FocusArea = "apiKey";
  private apiKeyValue = "";
  private apiKeyField = new TextField();
  private hasApiKeyLogin = false;
  private hasOAuthOnly = false;
  private configured = false;
  private configuredSource = "";
  private savingKey = false;
  private keyStatus: { kind: "ok" | "error"; text: string } | null = null;

  // ---- 模型列表 ----
  private refreshStatus: RefreshStatus = "idle";
  private refreshError = "";
  private modelStatus: string | null = null;
  /** 最近一次渲染的可见项数（PageUp/PageDown 步长） */
  private lastVisibleCount = 10;

  protected override init(): void {
    this.providerId = this.app.location?.params.providerId ?? "";
    // 让 catalog 使用 CLI 内存配置（未保存的修改也能反映到模型/登录判断）
    setZreadCatalogConfig(this.app.config.config);
    this.apiKeyField.onChange = (value) => {
      this.apiKeyValue = value;
    };
    this.apiKeyField.onSubmit = () => void this.saveApiKey();
    void this.load();
  }

  override handleKey(data: string): boolean {
    if (this.loading) return false;

    // 两块配置间切换焦点（没有可编辑的 API Key 输入时只在模型区）
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      if (!this.hasApiKeyLogin) return true;
      this.setFocus(this.focus === "apiKey" ? "models" : "apiKey");
      return true;
    }

    if (this.focus === "apiKey") {
      if (matchesKey(data, "escape")) {
        // 先退回模型列表，再按一次 ESC 才是返回上一级
        this.setFocus("models");
        return true;
      }
      if (matchesKey(data, "return")) {
        void this.saveApiKey();
        return true;
      }
      if (matchesKey(data, "down")) {
        this.setFocus("models");
        return true;
      }
      this.apiKeyField.handleKey(data);
      return true;
    }

    // ---- 模型列表焦点 ----
    if (matchesKey(data, "escape")) return false; // 交给 App 返回上一级

    const items = this.displayItems;
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.lastVisibleCount);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + this.lastVisibleCount);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.refresh();
      return true;
    }
    if (matchesKey(data, "end")) {
      this.selectedIndex = Math.max(0, items.length - 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "return")) {
      const selected = items[this.selectedIndex];
      if (!selected) return true;
      if (selected.kind === "custom") {
        this.app.navigate(`/config/provider/${this.providerId}/model-new`);
      } else {
        void this.selectModel(selected.model.id);
      }
      return true;
    }
    if (data === "a") {
      this.app.navigate(`/config/provider/${this.providerId}/model-new`);
      return true;
    }
    if (data === "e" && this.providerCustom) {
      this.app.navigate(`/config/provider/${this.providerId}/edit`);
      return true;
    }
    if (data === "r") {
      void this.refreshModels();
      return true;
    }
    if (data === "i" && this.hasApiKeyLogin) {
      this.setFocus("apiKey");
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    lines.push(
      "",
      clampLine(
        style(this.providerName || this.providerId, { bold: true, color: "cyan" }) +
          style(` (${this.providerId})`, { dim: true }),
        width,
      ),
    );

    if (this.loading) {
      lines.push("", style(this.t("model.loading"), { dim: true }));
      return lines;
    }

    if (this.error) {
      lines.push("", style(this.error, { bold: true, color: "red" }), "", style(this.t("common.escBack"), { dim: true }));
      return lines;
    }

    // ==================== 配置 1：API Key ====================
    const keyFocused = this.focus === "apiKey";
    lines.push("", this.sectionHeader(this.t("detail.apiKeyTitle"), keyFocused));

    if (this.hasApiKeyLogin) {
      const status = this.configured
        ? style(`✓ ${this.t("provider.configured")}${this.configuredSource ? ` · ${this.t("provider.source", { source: this.configuredSource })}` : ""}`, { color: "green" })
        : style(`○ ${this.t("provider.notConfigured")}`, { color: "yellow" });
      lines.push(clampLine("  " + status, width));

      const label = keyFocused ? style("> ", { color: "cyan" }) : style("  ", { color: "gray" });
      const labelWidth = visibleWidth(label);
      const inputLine = this.apiKeyField.render(Math.max(1, width - labelWidth))[0] ?? "";
      lines.push(clampLine(label + inputLine, width));
    } else if (this.hasOAuthOnly) {
      lines.push(clampLine("  " + style(this.t("detail.oauthOnly"), { dim: true, color: "yellow" }), width));
    } else {
      lines.push(clampLine("  " + style(this.t("detail.ambient"), { dim: true }), width));
    }

    if (this.savingKey) {
      lines.push(clampLine("  " + style(this.t("apikey.saving"), { color: "yellow" }), width));
    } else if (this.keyStatus) {
      lines.push(
        clampLine(
          "  " + style(this.keyStatus.text, { color: this.keyStatus.kind === "ok" ? "green" : "red" }),
          width,
        ),
      );
    }

    // ==================== 配置 2：模型 ====================
    const modelsFocused = this.focus === "models";
    lines.push(
      "",
      this.sectionHeader(
        `${this.t("detail.modelsTitle")} · ${this.t("model.count", { count: this.models.length })}`,
        modelsFocused,
      ),
    );

    if (this.refreshStatus === "refreshing") {
      lines.push(clampLine("  " + style(this.t("model.refreshing"), { color: "yellow" }), width));
    } else if (this.refreshStatus === "done") {
      lines.push(clampLine("  " + style(this.t("model.refreshDone"), { color: "green" }), width));
    } else if (this.refreshStatus === "unsupported") {
      lines.push(clampLine("  " + style(this.t("model.refreshUnsupported"), { dim: true }), width));
    } else if (this.refreshStatus === "failed") {
      lines.push(
        clampLine("  " + style(this.t("model.refreshFailed", { error: this.refreshError }), { color: "red" }), width),
      );
    } else if (this.modelStatus) {
      lines.push(clampLine("  " + style(this.modelStatus, { color: "green" }), width));
    }

    if (this.models.length === 0) {
      lines.push(clampLine("  " + style(this.t("model.noModels"), { dim: true }), width));
    }

    const items = this.displayItems;
    const post = [
      "",
      style(
        this.focus === "apiKey"
          ? this.t("detail.keyFooter")
          : this.providerCustom
            ? this.t("detail.footerCustom")
            : this.t("detail.footer"),
        { dim: true },
      ),
    ];
    const budget = Math.max(1, this.app.availableRows - lines.length - post.length);

    const { start, end } = computeItemWindow(items.map(() => 1), this.selectedIndex, budget);
    this.lastVisibleCount = Math.max(1, end - start);
    for (let index = start; index < end; index++) {
      lines.push(padRight(clampLine(this.renderModelRow(items[index], index), width), width));
    }
    const indicator = scrollIndicator(this.selectedIndex, items.length, start, end);
    if (indicator) lines.push(padRight(style(indicator, { dim: true }), width));

    return ["", ...lines, ...post];
  }

  // ==================== 内部实现 ====================

  private sectionHeader(title: string, focused: boolean): string {
    const marker = style(focused ? "▸ " : "  ", { color: focused ? "cyan" : "gray" });
    return marker + style(title, { bold: true, color: focused ? "white" : "gray" });
  }

  private get displayItems(): ListItem[] {
    return [
      ...this.models.map((model) => ({ kind: "model" as const, model })),
      { kind: "custom" as const },
    ];
  }

  private renderModelRow(item: ListItem, index: number): string {
    const listFocused = this.focus === "models";
    const isSelected = listFocused && index === this.selectedIndex;
    const { config } = this.app.config;

    if (item.kind === "custom") {
      return (
        barIndicator(isSelected) +
        style(this.t("model.custom"), isSelected ? { bold: true, color: "white" } : { color: "gray" })
      );
    }

    const { model } = item;
    let row = barIndicator(isSelected);
    row += style(model.name || model.id, isSelected ? { bold: true, color: "white" } : { color: "gray" });
    if (model.name && model.name !== model.id) {
      row += style(` (${model.id})`, { dim: true, color: "gray" });
    }
    if (model.maxTokens) {
      row += style(` (${model.maxTokens} ${this.t("model.tokens")})`, { dim: true, color: "gray" });
    }

    if (this.isCustomModel(model.id)) {
      row += style(` [${this.t("model.customBadge")}]`, { color: "magenta", dim: true });
    }

    if (model.id === config.llm.model && this.providerId === config.llm.provider) {
      row += style(` ← ${this.t("provider.current")}`, { color: "green", dim: true });
    }

    const supportsVision = model.input.includes("image");
    if (model.reasoning || supportsVision) {
      let tags = style("[", { dim: true });
      if (model.reasoning) tags += style(this.t("model.reasoning"), { dim: true, color: "magenta" });
      if (supportsVision) {
        if (model.reasoning) tags += " ";
        tags += style(this.t("model.vision"), { dim: true, color: "blue" });
      }
      tags += style("]", { dim: true });
      row += " " + tags;
    }

    return row;
  }

  private isCustomModel(modelId: string): boolean {
    return (this.app.config.getProviderConfig(this.providerId).models ?? []).some(
      (model) => model.id === modelId,
    );
  }

  private setFocus(focus: FocusArea): void {
    this.focus = focus;
    this.apiKeyField.setFocused(focus === "apiKey");
    if (focus === "models") {
      this.keyStatus = null;
    } else {
      this.modelStatus = null;
    }
    this.refresh();
  }

  private async load(): Promise<void> {
    if (!this.providerId) {
      this.app.navigate("/config/provider");
      return;
    }

    this.loading = true;
    this.error = null;
    this.refresh();

    try {
      const provider = getZreadProvider(this.providerId);
      if (!provider) {
        this.error = `Provider "${this.providerId}" not found`;
        return;
      }
      this.providerName = provider.name;
      this.providerCustom = !getZreadCatalog().builtinIds.has(this.providerId);
      this.hasApiKeyLogin = Boolean(provider.auth.apiKey?.login);
      this.hasOAuthOnly = !provider.auth.apiKey && Boolean(provider.auth.oauth?.login);
      this.reloadModels();

      const status = await this.checkAuth();
      this.applyAuthStatus(status);

      // 已配置 → 直接看模型；未配置 → 先填 API Key
      this.focus = this.configured || !this.hasApiKeyLogin ? "models" : "apiKey";
      this.apiKeyField.setFocused(this.focus === "apiKey");
      this.apiKeyField.setPlaceholder(
        this.configured ? this.t("detail.keyPlaceholderConfigured") : this.t("apikey.placeholder"),
      );

      const currentIndex = this.models.findIndex((model) => model.id === this.app.config.config.llm.model);
      if (currentIndex >= 0) this.selectedIndex = currentIndex;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Load failed";
    } finally {
      this.loading = false;
      this.refresh();
    }
  }

  private async checkAuth(): Promise<{ type?: "api_key" | "oauth"; source?: string } | undefined> {
    const result = await getZreadCatalog().models.checkAuth(this.providerId);
    return result ?? undefined;
  }

  private applyAuthStatus(status: { source?: string } | undefined): void {
    this.configured = status !== undefined;
    this.configuredSource = status?.source ?? "";
  }

  private reloadModels(): void {
    this.models = getZreadProviderModels(this.providerId).map((model) => ({
      id: model.id,
      name: model.name,
      maxTokens: model.maxTokens,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      input: model.input,
    }));
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.displayItems.length - 1));
  }

  /** 保存 API Key（pi-ai login，只走 api_key 方式） */
  private async saveApiKey(): Promise<boolean> {
    const key = this.apiKeyValue.trim();
    if (!key) {
      this.keyStatus = { kind: "error", text: this.t("apikey.required") };
      this.refresh();
      return false;
    }
    if (!this.hasApiKeyLogin) {
      this.keyStatus = {
        kind: "error",
        text: this.hasOAuthOnly ? this.t("detail.oauthOnly") : this.t("detail.ambient"),
      };
      this.refresh();
      return false;
    }

    this.savingKey = true;
    this.keyStatus = null;
    this.refresh();
    try {
      await loginZreadProvider(this.providerId, "api_key", {
        prompt: async () => key,
        notify: () => {
          // api_key 登录没有额外事件
        },
      });
      this.app.config.setProviderConfig(this.providerId, { auth_type: "api_key" });
      // 当前 provider 的旧扁平 key 已被新凭据取代，清掉避免覆盖
      if (this.app.config.config.llm.provider === this.providerId) {
        this.app.config.clearLegacyCredentials();
      }
      this.configured = true;
      this.configuredSource = "stored credential";
      this.apiKeyValue = "";
      this.apiKeyField.setValue("");
      this.apiKeyField.setPlaceholder(this.t("detail.keyPlaceholderConfigured"));
      // 保存成功后焦点移到模型列表（不重置 keyStatus，保留保存提示）
      this.focus = "models";
      this.apiKeyField.setFocused(false);
      this.modelStatus = null;
      this.keyStatus = { kind: "ok", text: this.t("detail.keySaved") };
      return true;
    } catch (err) {
      this.keyStatus = {
        kind: "error",
        text: this.t("detail.keyFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      };
      return false;
    } finally {
      this.savingKey = false;
      this.refresh();
    }
  }

  /** 选择模型：先落盘未保存的 API Key，再设为当前模型 */
  private async selectModel(modelId: string): Promise<void> {
    if (this.apiKeyValue.trim() && this.hasApiKeyLogin) {
      const saved = await this.saveApiKey();
      if (!saved) {
        this.setFocus("apiKey");
        return;
      }
    }
    if (!this.configured) {
      const text = !this.hasApiKeyLogin
        ? this.hasOAuthOnly
          ? this.t("detail.oauthOnly")
          : this.t("detail.ambient")
        : this.t("detail.keyFirst");
      if (this.hasApiKeyLogin) this.setFocus("apiKey");
      this.keyStatus = { kind: "error", text };
      this.refresh();
      return;
    }

    await migrateLegacyCredentials(this.app.config);
    if (!getZreadModel(this.providerId, modelId)) {
      this.app.config.upsertCustomModel(this.providerId, { id: modelId, name: modelId });
    }
    this.app.config.setActiveModel(this.providerId, modelId);
    setZreadCatalogConfig(this.app.config.config);
    this.modelStatus = this.t("detail.currentSet", { model: modelId });
    this.keyStatus = null;
    this.refresh();
  }

  private async refreshModels(): Promise<void> {
    const provider = getZreadProvider(this.providerId);
    if (!provider?.refreshModels) {
      this.refreshStatus = "unsupported";
      this.refresh();
      return;
    }

    this.refreshStatus = "refreshing";
    this.refresh();
    const result = await refreshZreadProviderModels(this.providerId);
    if (result.ok) {
      this.reloadModels();
      this.refreshStatus = "done";
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.displayItems.length - 1));
    } else {
      this.refreshStatus = "failed";
      this.refreshError = result.error ?? "unknown error";
    }
    this.refresh();
  }
}
