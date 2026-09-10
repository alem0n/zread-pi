/**
 * Config Model Page - 模型选择（pi-tui 版）
 *
 * 功能:
 * - 根据 Provider ID 动态加载 Model 列表
 * - 显示 max_tokens 等信息
 * - 支持自定义模型输入
 * - 键盘导航（↑↓ / j k）
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { getProviderRegistry } from "@open-zread/utils";
import type { ModelInfo } from "@open-zread/utils";
import { barIndicator } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, padRight } from "../../tui/text-layout";

interface DisplayModel {
  id: string;
  name: string;
  max_tokens?: number;
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_thinking?: boolean;
}

export default class ConfigModelPage extends Screen {
  private providerId = "";
  private models: ModelInfo[] = [];
  private selectedIndex = 0;
  private loading = true;
  private error: string | null = null;

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
    if (matchesKey(data, "return")) {
      const selected = items[this.selectedIndex];
      if (!selected) return true;
      if (selected.id === "custom") {
        // 直接跳转到自定义流程页面
        this.app.navigate(`/config/provider/${this.providerId}/custom`);
      } else {
        // 跳转到 API Key 输入页
        this.app.navigate(`/config/provider/${this.providerId}/model/${selected.id}`);
      }
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

    // 无预置模型提示（marginTop={1}）
    if (this.models.length === 0) {
      lines.push("", style(this.t("model.noModels"), { dim: true }));
    }

    // Model 列表（marginTop={1}）
    lines.push("");
    const items = this.displayItems;
    for (let index = 0; index < items.length; index++) {
      lines.push(padRight(clampLine(this.renderModelRow(items[index], index), width), width));
    }

    // Footer（marginTop={1}）
    lines.push("", style(this.t("model.footer"), { dim: true }));

    return lines;
  }

  // ==================== 内部实现 ====================

  private get displayItems(): DisplayModel[] {
    return this.models.length > 0
      ? [...this.models, { id: "custom", name: this.t("model.custom") }]
      : [{ id: "custom", name: this.t("model.custom") }];
  }

  private renderModelRow(model: DisplayModel, index: number): string {
    const isSelected = index === this.selectedIndex;
    const { config } = this.app.config;
    let row = barIndicator(isSelected);
    row += style(model.name, isSelected ? { bold: true, color: "white" } : { color: "gray" });

    if (model.max_tokens) {
      row += style(` (${model.max_tokens} ${this.t("model.tokens")})`, { dim: true, color: "gray" });
    }
    if (model.id === config.llm.model && this.providerId === config.llm.provider) {
      row += style(` ← ${this.t("provider.current")}`, { color: "green", dim: true });
    }

    // 显示能力标签
    if (model.supports_tools || model.supports_vision || model.supports_thinking) {
      let tags = style("[", { dim: true });
      if (model.supports_tools) tags += style("tools", { dim: true, color: "yellow" });
      if (model.supports_vision) tags += style(" vision", { dim: true, color: "blue" });
      if (model.supports_thinking) tags += style(" thinking", { dim: true, color: "magenta" });
      tags += style("]", { dim: true });
      // <Box marginLeft={1}>
      row += " " + tags;
    }

    return row;
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
      const registry = await getProviderRegistry();
      const provider = registry.getProvider(this.providerId);
      if (!provider) {
        this.error = `Provider "${this.providerId}" not found`;
        return;
      }

      const modelList = registry.getModels(this.providerId);
      this.models = modelList;

      // 如果是 'custom' provider 或没有预置模型，直接跳转到自定义流程
      // 使用 replace 避免历史循环（ESC 返回时跳过此页面）
      if (this.providerId === "custom" || modelList.length === 0) {
        this.app.navigate(`/config/provider/${this.providerId}/custom`, { replace: true });
        return;
      }

      // 找到当前选中的 model 并设置 selectedIndex
      const currentIndex = modelList.findIndex((m) => m.id === this.app.config.config.llm.model);
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
}
