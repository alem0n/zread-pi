/**
 * Config Model Page - 模型选择（pi-tui 版，pi-ai catalog）
 *
 * 功能:
 * - 列出指定 Provider 的模型（pi-ai 内置目录 + ~/.zread/config.yaml 里的自定义模型）
 * - r 刷新模型列表（调用 pi-ai 的 Models.refresh，动态 Provider 会请求远端目录）
 * - a 为该 Provider 添加自定义模型
 * - 选择模型 → 登录/凭据页面
 */

import { matchesKey } from "@earendil-works/pi-tui";
import {
  getZreadProvider,
  getZreadProviderModels,
  refreshZreadProviderModels,
  setZreadCatalogConfig,
} from "@open-zread/agent-runtime";
import { barIndicator, computeItemWindow, scrollIndicator } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, padRight } from "../../tui/text-layout";

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

type RefreshStatus = "idle" | "refreshing" | "done" | "unsupported" | "failed";

export default class ConfigModelPage extends Screen {
  private providerId = "";
  private providerName = "";
  private models: readonly CatalogModel[] = [];
  private selectedIndex = 0;
  private loading = true;
  private error: string | null = null;
  private refreshStatus: RefreshStatus = "idle";
  private refreshError = "";
  /** 最近一次渲染的可见项数（PageUp/PageDown 步长） */
  private lastVisibleCount = 10;

  protected override init(): void {
    this.providerId = this.app.location?.params.providerId ?? "";
    void this.load();
  }

  override handleKey(data: string): boolean {
    if (this.loading) return false;

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
        this.app.navigate(`/config/provider/${this.providerId}/model/${encodeURIComponent(selected.model.id)}`);
      }
      return true;
    }
    if (data === "a") {
      this.app.navigate(`/config/provider/${this.providerId}/model-new`);
      return true;
    }
    if (data === "r") {
      void this.refreshModels();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    // 加载中状态
    if (this.loading) {
      return ["", style(this.t("model.loading"), { bold: true, color: "cyan" })];
    }

    // 错误状态
    if (this.error) {
      return [
        "",
        style(this.error, { bold: true, color: "red" }),
        "",
        style(this.t("common.escBack"), { dim: true }),
      ];
    }

    const lines: string[] = [];

    // 提供商标题（marginTop={1}）
    lines.push(
      "",
      clampLine(
        style(this.providerName || this.providerId, { bold: true, color: "cyan" }) +
          style(` · ${this.t("model.count", { count: this.models.length })}`, { dim: true }),
        width,
      ),
    );

    // 刷新状态提示
    if (this.refreshStatus === "refreshing") {
      lines.push(style(this.t("model.refreshing"), { color: "yellow" }));
    } else if (this.refreshStatus === "done") {
      lines.push(style(this.t("model.refreshDone"), { color: "green" }));
    } else if (this.refreshStatus === "unsupported") {
      lines.push(style(this.t("model.refreshUnsupported"), { dim: true }));
    } else if (this.refreshStatus === "failed") {
      lines.push(style(this.t("model.refreshFailed", { error: this.refreshError }), { color: "red" }));
    }

    // 无预置模型提示（marginTop={1}）
    if (this.models.length === 0) {
      lines.push("", style(this.t("model.noModels"), { dim: true }));
    }

    // Model 列表（marginTop={1}）+ Footer（marginTop={1}）
    const items = this.displayItems;
    const post = ["", style(this.t("model.footer"), { dim: true })];
    const budget = Math.max(1, this.app.availableRows - lines.length - 1 - post.length);

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

  private get displayItems(): ListItem[] {
    return [
      ...this.models.map((model) => ({ kind: "model" as const, model })),
      { kind: "custom" as const },
    ];
  }

  private renderModelRow(item: ListItem, index: number): string {
    const isSelected = index === this.selectedIndex;
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

    const isCustom = this.isCustomModel(model.id);
    if (isCustom) {
      row += style(` [${this.t("model.customBadge")}]`, { color: "magenta", dim: true });
    }

    if (model.id === config.llm.model && this.providerId === config.llm.provider) {
      row += style(` ← ${this.t("provider.current")}`, { color: "green", dim: true });
    }

    // 显示能力标签
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

  private async load(): Promise<void> {
    if (!this.providerId) {
      this.app.navigate("/config/provider");
      return;
    }

    this.loading = true;
    this.error = null;
    this.refresh();

    try {
      // CLI 内存配置优先（未保存的自定义模型也能立即看到）
      setZreadCatalogConfig(this.app.config.config);
      const provider = getZreadProvider(this.providerId);
      if (!provider) {
        this.error = `Provider "${this.providerId}" not found`;
        return;
      }
      this.providerName = provider.name;
      this.reloadModels();

      // 找到当前选中的 model 并设置 selectedIndex
      const currentIndex = this.models.findIndex((model) => model.id === this.app.config.config.llm.model);
      if (currentIndex >= 0) {
        this.selectedIndex = currentIndex;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Load failed";
    } finally {
      this.loading = false;
      this.refresh();
    }
  }

  private reloadModels(): void {
    const models = getZreadProviderModels(this.providerId);
    this.models = models.map((model) => ({
      id: model.id,
      name: model.name,
      maxTokens: model.maxTokens,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      input: model.input,
    }));
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
