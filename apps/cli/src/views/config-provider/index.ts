/**
 * Config Provider Page - pi-ai 提供商选择（pi-tui 版）
 *
 * 数据来源：@open-zread/agent-runtime 的 listZreadProviders()
 *   = pi-ai 的 40 个内置 Provider（含 OAuth/API Key 登录方式）
 *   + ~/.zread/config.yaml 里配置过的自定义 Provider
 *
 * 功能:
 * - 列出所有 Provider 及其凭据状态（OAuth / API Key / 未配置），支持同时配置多个
 * - 自定义 Provider 选项放在最前面
 * - 搜索功能（/ 键激活）
 * - 键盘导航（↑↓ / j k）、刷新列表（r 键）
 * - 选择后跳转模型列表页
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { listZreadProviders, type ZreadProviderSummary } from "@open-zread/agent-runtime";
import { barIndicator, computeItemWindow, scrollIndicator } from "../../tui/components/select";
import { TextField } from "../../tui/components/text-field";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, padRight } from "../../tui/text-layout";

/** 列表项：自定义 Provider 入口 + pi-ai Provider 摘要 */
type ProviderListItem =
  | { kind: "custom" }
  | { kind: "provider"; summary: ZreadProviderSummary };

const CUSTOM_PROVIDER_OPTION: ProviderListItem = { kind: "custom" };

export default class ConfigProviderPage extends Screen {
  private providers: ZreadProviderSummary[] = [];
  private selectedIndex = 0;
  private searchQuery = "";
  private isSearchMode = false;
  private loading = true;
  private error: string | null = null;
  private searchField = new TextField({ placeholder: "输入 Provider 名称..." });
  /** 最近一次渲染的可见项数（PageUp/PageDown 步长） */
  private lastVisibleCount = 10;

  protected override init(): void {
    this.searchField.onChange = (value) => {
      this.searchQuery = value;
      this.refresh();
    };
    this.searchField.onSubmit = () => this.handleSearchSubmit();
    void this.loadProviders();
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
    if (matchesKey(data, "pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.lastVisibleCount);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.selectedIndex = Math.min(maxIndex, this.selectedIndex + this.lastVisibleCount);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.refresh();
      return true;
    }
    if (matchesKey(data, "end")) {
      this.selectedIndex = maxIndex;
      this.refresh();
      return true;
    }
    if (matchesKey(data, "return") && currentList[this.selectedIndex]) {
      const selected = currentList[this.selectedIndex];
      if (selected.kind === "custom") {
        this.app.navigate("/config/provider/custom");
      } else {
        this.app.navigate(`/config/provider/${selected.summary.id}`);
      }
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
      void this.loadProviders();
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

    const { config } = this.app.config;
    const items = this.displayProviders;

    // 可用行数 = 页面高度 - 列表上方(1 空行) - 列表下方(1 空行 + footer)
    const post = ["", style(this.t("provider.footer"), { dim: true })];
    const budget = Math.max(1, this.app.availableRows - 1 - post.length);

    const body: string[] = [];
    if (items.length === 0) {
      body.push(style("没有 Provider", { dim: true }));
    } else {
      // 分页：只渲染窗口内的项，保证选中项始终可见
      const { start, end } = computeItemWindow(
        items.map(() => 1),
        this.selectedIndex,
        budget,
      );
      this.lastVisibleCount = Math.max(1, end - start);
      for (let index = start; index < end; index++) {
        const item = items[index];
        const isSelected = index === this.selectedIndex;
        let row = barIndicator(isSelected);
        if (item.kind === "custom") {
          row += style(this.t("provider.custom"), isSelected ? { bold: true, color: "white" } : { color: "gray" });
        } else {
          const { summary } = item;
          row += style(summary.name, isSelected ? { bold: true, color: "white" } : { color: "gray" });
          if (!summary.builtin) {
            row += style(` [${this.t("provider.customBadge")}]`, { dim: true, color: "magenta" });
          }
          row += style(` (${summary.id})`, { dim: true, color: "gray" });
          row += style(` ${this.t("provider.models", { count: summary.modelCount })}`, { dim: true });
          if (summary.configured) {
            const authLabel =
              summary.authType === "oauth"
                ? this.t("provider.authOauth")
                : this.t("provider.authApiKey");
            row += style(` ✓ ${this.t("provider.configured")} ${authLabel}`, { color: "green", dim: true });
          } else {
            row += style(` ○ ${this.t("provider.notConfigured")}`, { color: "yellow", dim: true });
          }
          if (summary.id === config.llm.provider) {
            row += style(` ← ${this.t("provider.current")}`, { color: "green", dim: true });
          }
        }
        body.push(padRight(clampLine(row, width), width));
      }

      const indicator = scrollIndicator(this.selectedIndex, items.length, start, end);
      if (indicator) body.push(padRight(style(indicator, { dim: true }), width));
    }

    return ["", ...body, ...post];
  }

  // ==================== 内部实现 ====================

  /** 显示列表：自定义选项 + 已有 Provider（自定义 Provider 放在内置之后） */
  private get displayProviders(): ProviderListItem[] {
    const builtin = this.providers.filter((provider) => provider.builtin);
    const custom = this.providers.filter((provider) => !provider.builtin);
    return [
      CUSTOM_PROVIDER_OPTION,
      ...builtin.map((summary) => ({ kind: "provider" as const, summary })),
      ...custom.map((summary) => ({ kind: "provider" as const, summary })),
    ];
  }

  /** 搜索过滤（不包括自定义选项） */
  private get filteredProviders(): ProviderListItem[] {
    if (!this.searchQuery) {
      return this.providers.map((summary) => ({ kind: "provider" as const, summary }));
    }
    const query = this.searchQuery.toLowerCase();
    return this.providers
      .filter(
        (provider) =>
          provider.id.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query),
      )
      .map((summary) => ({ kind: "provider" as const, summary }));
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

  private async loadProviders(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.refresh();

    try {
      const list = await listZreadProviders();
      this.providers = list;

      // 选中当前 provider（索引需要 +1，因为第一位是自定义选项）
      const currentIndex = list.findIndex(
        (provider) => provider.id === this.app.config.config.llm.provider,
      );
      this.selectedIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.t("provider.error");
    } finally {
      this.loading = false;
      this.refresh();
    }
  }
}
