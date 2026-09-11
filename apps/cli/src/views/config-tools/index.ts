/**
 * Config Tools Page - 外部工具列表（rg / fd）
 *
 * 路由：/config/tools
 *
 * 展示每个已登记工具的安装状态，并提供总体「就绪进度条」：
 *  - 状态探测（`getToolStatus`）会 spawn 子进程，只在 init / onEnter 里计算，不在 render 里做；
 *  - 列表由 @zread-pi/utils 的工具注册表驱动，后续新增工具无需改本页。
 *
 * 按键：↑↓ 选择 | Enter 进入详情 | ESC 返回
 */

import { getManagedBinDir, getToolStatuses, type ToolStatus } from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { renderProgressLine } from "../../tui/components/progress-bar";
import { barIndicator, Select } from "../../tui/components/select";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, wrapStyled } from "../../tui/text-layout";
import { theme } from "../../theme";
import { toolStateColor, toolStateLabel } from "./status";

export default class ConfigToolsPage extends Screen {
  private select!: Select<{ value: string }>;
  private statuses: ToolStatus[] = [];

  protected override init(): void {
    this.select = new Select<{ value: string }>({
      items: [],
      renderItem: (item, isSelected) => {
        const status = this.statuses.find((entry) => entry.id === item.value);
        return status ? this.renderToolRow(status, isSelected) : [];
      },
      onSelect: (item) => this.app.navigate(`/config/tools/${item.value}`),
    });
    this.refreshStatuses();
  }

  override handleKey(data: string): boolean {
    // 按键统一转给列表（与配置首页一致）；ESC 由 App 统一处理
    return this.select.handleInput(data);
  }

  override onEnter(): void {
    // 从详情页返回时状态可能已变化（刚安装 / 卸载 / 改过启用状态）
    this.refreshStatuses();
    this.refresh();
  }

  render(width: number): string[] {
    const t = this.t.bind(this);
    const lines: string[] = [];

    lines.push(...new Divider(`${t("tools.title")} · ${getManagedBinDir()}`).render(width));
    lines.push("", ...wrapStyled(style(t("tools.intro"), { dim: true }), width));

    // 总体进度：就绪（系统安装或 zread-pi 安装）的工具数 / 总数
    const ready = this.statuses.filter((status) => status.state === "system" || status.state === "managed").length;
    const total = Math.max(1, this.statuses.length);
    lines.push("");
    lines.push(
      clampLine(
        renderProgressLine(
          width,
          ready / total,
          t("tools.readyRatio", { ready, total: this.statuses.length }),
          undefined,
          ready === this.statuses.length ? theme.success : theme.primary,
        ),
        width,
      ),
    );

    const pre = [...lines];
    const post = ["", style(t("tools.listFooter"), { dim: true })];
    this.select.setViewportRows(Math.max(3, this.app.availableRows - pre.length - post.length));

    return [...pre, "", ...this.select.render(width), ...post];
  }

  // ==================== 内部实现 ====================

  private refreshStatuses(): void {
    // 用内存配置覆盖磁盘配置，让「未保存的启用/停用」也能立刻反映在列表上
    this.statuses = getToolStatuses(this.pendingOverrides());
    this.select.setItems(this.statuses.map((status) => ({ value: status.id })));
  }

  private pendingOverrides(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const status of getToolStatuses()) result[status.id] = this.app.config.isToolEnabled(status.id);
    return result;
  }

  private renderToolRow(status: ToolStatus, isSelected: boolean): string[] {
    const t = this.t.bind(this);
    const indicator = barIndicator(isSelected);
    const labelStyle = isSelected ? { bold: true, color: "white" } : { bold: false, color: "gray" };
    const stateColor = toolStateColor(status);
    const versionSuffix = status.version
      ? ` · ${status.version}`
      : status.installedVersion && status.state !== "missing"
        ? ` · ${status.installedVersion}`
        : "";
    // usage 文案已经点名了它驱动哪个 Agent 工具（如「Grep（文件内容搜索）」），
    // 不再拼 usedBy，避免出现「Grep · Grep（文件内容搜索）」这种重复
    const usage = t(`tools.usage.${status.id}`) || status.usedBy.join(" / ");

    return [
      indicator + style(`${status.id} (${status.displayName})`, labelStyle),
      indicator +
        style(toolStateLabel(t, status) + versionSuffix, {
          color: stateColor,
          ...(isSelected ? { bold: true } : {}),
        }),
      indicator + style(usage, { dim: true }),
      "",
    ];
  }
}
