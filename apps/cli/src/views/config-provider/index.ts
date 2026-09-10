/**
 * Config Provider Page - LLM 提供商选择（pi-tui 版）
 *
 * 功能:
 * - 动态加载 Provider 列表（从 ProviderRegistry）
 * - 自定义 Provider 选项放在最前面
 * - 搜索功能（/ 键激活）
 * - 键盘导航（↑↓ / j k）
 * - 刷新列表（r 键）
 * - 选择后跳转 Model 选择页
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { getProviderRegistry } from "@open-zread/utils";
import type { ProviderInfo } from "@open-zread/utils";
import { barIndicator } from "../../tui/components/select";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, padRight } from "../../tui/text-layout";
import { visibleWidth } from "@earendil-works/pi-tui";

// 自定义 Provider 选项（固定放在第一位）
const CUSTOM_PROVIDER_OPTION: ProviderInfo = {
  id: "custom",
  name: "自定义 Provider...",
  npm: "",
  base_url: "",
  models: {},
};

export default class ConfigProviderPage extends Screen {
  private providers: ProviderInfo[] = [];
  private selectedIndex = 0;
  private searchQuery = "";
  private isSearchMode = false;
  private loading = true;
  private error: string | null = null;
  private searchField = new TextField({ placeholder: "输入 Provider 名称..." });

  protected override init(): void {
    this.searchField.onChange = (value) => {
      this.searchQuery = value;
      this.refresh();
    };
    this.searchField.onSubmit = () => this.handleSearchSubmit();
    void this.loadProviders(false);
  }

  override handleKey(data: string): boolean {
    if (this.loading) return false;

    // ESC 键只在搜索模式下处理（退出搜索）
    if (matchesKey(data, "escape")) {
      if (this.isSearchMode) {
        this.isSearchMode = false;
        this.searchQuery = "";
        this.searchField.setValue("");
        this.app.releaseEsc();
        this.refresh();
        return true;
      }
      return false;
    }

    // 搜索模式下，其他键由 TextInput 处理
    if (this.isSearchMode) {
      this.searchField.handleKey(data);
      return true;
    }

    // 当前显示的列表（搜索时用过滤结果，否则用完整列表）
    const currentList = this.searchQuery ? this.filteredProviders : this.displayProviders;
    const maxIndex = currentList.length - 1;

    // 正常导航模式
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 1);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "return") && currentList[this.selectedIndex]) {
      const selectedProvider = currentList[this.selectedIndex];
      this.app.navigate(`/config/provider/${selectedProvider.id}`);
      return true;
    }
    if (data === "/") {
      this.isSearchMode = true;
      this.searchQuery = "";
      this.searchField.setValue("");
      this.app.claimEsc();
      this.refresh();
      return true;
    }
    if (data === "r") {
      void this.loadProviders(true);
      return true;
    }

    return false;
  }

  render(width: number): string[] {
    // 加载中状态
    if (this.loading) {
      return ["", style(this.t("provider.loading"), { bold: true, color: "cyan" })];
    }

    // 错误状态
    if (this.error) {
      return [
        "",
        style(`${this.t("provider.error")}: ${this.error}`, { bold: true, color: "red" }),
        "",
        style(`${this.t("common.escBack")} | r ${this.t("provider.refresh")}`, { dim: true }),
      ];
    }

    // 搜索模式显示 - 使用 TextField
    if (this.isSearchMode) {
      const label = style("搜索: ", { color: "cyan" });
      const labelWidth = visibleWidth(label);
      const inputLine = this.searchField.render(Math.max(1, width - labelWidth))[0] ?? "";
      return [
        "",
        clampLine(label + inputLine, width),
        "",
        style(
          `找到 ${this.filteredProviders.length} 个结果 | ${this.t("common.escBack")} | enter 确认`,
          { dim: true },
        ),
      ];
    }

    const lines: string[] = [""];
    const { config } = this.app.config;

    if (this.displayProviders.length === 0) {
      lines.push(style("没有 Provider", { dim: true }));
    } else {
      for (let index = 0; index < this.displayProviders.length; index++) {
        const provider = this.displayProviders[index];
        const isSelected = index === this.selectedIndex;
        let row = barIndicator(isSelected);
        row += style(provider.name, isSelected ? { bold: true, color: "white" } : { color: "gray" });
        if (provider.id === config.llm.provider) {
          row += style(` ← ${this.t("provider.current")}`, { color: "green", dim: true });
        }
        if (provider.id !== "custom" && provider.npm) {
          row += style(` (${provider.npm})`, { dim: true, color: "gray" });
        }
        lines.push(padRight(clampLine(row, width), width));
      }
    }

    lines.push("", style(this.t("provider.footer"), { dim: true }));
    return lines;
  }

  // ==================== 内部实现 ====================

  /** 显示列表：自定义选项 + 已有 Provider（排除 registry 中的 custom） */
  private get displayProviders(): ProviderInfo[] {
    return [CUSTOM_PROVIDER_OPTION, ...this.providers.filter((p) => p.id !== "custom")];
  }

  /** 搜索过滤（不包括自定义选项） */
  private get filteredProviders(): ProviderInfo[] {
    return this.searchQuery
      ? this.providers.filter(
          (p) =>
            p.id.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
            p.name.toLowerCase().includes(this.searchQuery.toLowerCase()),
        )
      : this.providers;
  }

  private handleSearchSubmit(): void {
    this.isSearchMode = false;
    this.app.releaseEsc();
    if (this.filteredProviders.length > 0) {
      // 搜索模式下索引是相对于过滤结果的
      this.selectedIndex = 0;
    }
    this.refresh();
  }

  private async loadProviders(forceRefresh: boolean): Promise<void> {
    this.loading = true;
    this.error = null;
    this.refresh();

    try {
      const registry = await getProviderRegistry(forceRefresh);
      const list = registry.getAllProviders();
      this.providers = list;
      // 如果当前是自定义 provider，选中第一位
      if (this.app.config.config.llm.provider === "custom") {
        this.selectedIndex = 0;
      } else {
        // 否则找到当前 provider（索引需要 +1，因为第一位是自定义选项）
        const currentIndex = list.findIndex(
          (p) => p.id === this.app.config.config.llm.provider,
        );
        if (currentIndex >= 0) {
          this.selectedIndex = currentIndex + 1;
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.t("provider.error");
    } finally {
      this.loading = false;
      this.refresh();
    }
  }
}
