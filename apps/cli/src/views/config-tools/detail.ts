/**
 * Config Tool Detail Page - 单个外部工具详情与安装
 *
 * 路由：/config/tools/:toolId
 *
 * 能力：
 *  - 展示状态 / 版本 / 路径 / 用途 / 安装目录
 *    （状态探测会 spawn 子进程，只在这些时机执行，不在 render() 里做）
 *  - Enter 安装（或覆盖重装）：下载 → 解包 → 落盘 → 校验，进度用进度条 + 百分比 + 字节数实时展示
 *  - d 卸载（只删 zread-pi 托管目录里的副本，系统安装不受影响）
 *  - t 启用/停用（写 config.yaml 的 tools.<id>.enabled，需按 s 保存）
 *
 * 安装失败不会影响工具的内置兜底实现：Grep / Glob 仍会退回纯 JS 实现。
 *
 * 按键：ESC 返回 | Enter 安装/重装 | d 卸载 | t 启用/停用 | s 保存并返回
 */

import { matchesKey } from "@earendil-works/pi-tui";
import {
  getManagedBinDir,
  getToolSpec,
  getToolStatus,
  installTool,
  ToolInstallError,
  uninstallTool,
  type ToolInstallPhase,
  type ToolInstallProgress,
  type ToolStatus,
} from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { formatBytes, renderProgressLine } from "../../tui/components/progress-bar";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { clampLine, wrapStyled } from "../../tui/text-layout";
import { theme } from "../../theme";
import { toolStateColor, toolStateHint, toolStateLabel } from "./status";

type ActionStatus = "idle" | "installing" | "uninstalling" | "saving";

export default class ConfigToolDetailPage extends Screen {
  private toolId = "";
  private status: ToolStatus | undefined;
  private action: ActionStatus = "idle";
  private progress: ToolInstallProgress | null = null;
  private message: { text: string; ok: boolean } | null = null;
  private savedStatus: "idle" | "saved" | "failed" = "idle";
  private timer?: ReturnType<typeof setTimeout>;
  private lastRenderedPercent = -1;

  protected override init(): void {
    this.toolId = this.app.location?.params.toolId ?? "";
    this.refreshStatus();
  }

  override onDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    // 页面被销毁（如 ctrl+c / ESC）时务必收掉终端忙指示
    this.app.setBusy(false);
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) return false; // 交给 App 返回上一级
    if (this.action !== "idle") return true; // 安装/卸载/保存过程中吞掉按键

    if (matchesKey(data, "return")) {
      this.startInstall();
      return true;
    }
    if (data === "d") {
      void this.startUninstall();
      return true;
    }
    if (data === "t") {
      this.toggleEnabled();
      return true;
    }
    if (data === "s") {
      void this.startSave();
      return true;
    }
    return true;
  }

  render(width: number): string[] {
    const t = this.t.bind(this);
    const spec = getToolSpec(this.toolId);
    const lines: string[] = [];

    lines.push(...new Divider(`${spec?.displayName ?? this.toolId} (${this.toolId})`).render(width));

    if (!spec || !this.status) {
      lines.push("", style(`${t("tools.stateMissing")}: ${this.toolId}`, { color: theme.error }));
      lines.push("", style(t("common.escBack"), { dim: true }));
      return lines;
    }

    const status = this.status;
    const field = (label: string, value: string, valueColor?: string): string =>
      clampLine(style(`${label}: `, { dim: true }) + style(value, valueColor ? { color: valueColor } : {}), width);

    lines.push("");
    lines.push(field(t("tools.fieldState"), toolStateLabel(t, status), toolStateColor(status)));
    lines.push(field(t("tools.fieldVersion"), status.version ?? t("tools.notInstalled")));
    lines.push(field(t("tools.fieldPath"), status.path ?? "-"));
    lines.push(field(t("tools.fieldUsedBy"), t(`tools.usage.${status.id}`) || status.usedBy.join(" / ")));
    lines.push(field(t("tools.fieldManagedDir"), getManagedBinDir()));
    lines.push(field(t("tools.enabled"), status.enabled ? t("tools.enabled") : t("tools.disabled"), status.enabled ? theme.success : theme.muted));

    // 进度条：安装中显示实时进度；空闲时显示「就绪度」（就绪 100% / 未就绪 0%）
    lines.push("");
    if (this.action === "installing" && this.progress) {
      lines.push(
        clampLine(
          renderProgressLine(width, this.progress.percent / 100, `${this.progress.percent}%`, this.progressDetail(this.progress), theme.primary),
          width,
        ),
      );
    } else {
      const ready = status.state === "system" || status.state === "managed";
      lines.push(
        clampLine(
          renderProgressLine(
            width,
            ready ? 1 : 0,
            ready ? "100%" : "0%",
            status.state === "disabled" ? t("tools.stateDisabled") : undefined,
            ready ? theme.success : theme.warning,
          ),
          width,
        ),
      );
    }

    lines.push("", ...wrapStyled(style(toolStateHint(t, status), { dim: true }), width));

    if (this.action === "installing") {
      lines.push("", style(t("tools.installing"), { color: "yellow" }));
    }
    if (this.action === "uninstalling") {
      lines.push("", style(`${t("tools.uninstallDone")}…`, { color: "yellow" }));
    }
    if (this.message) {
      lines.push("", ...wrapStyled(style(this.message.text, { color: this.message.ok ? "green" : "red" }), width));
    }
    if (this.savedStatus === "saved") {
      lines.push("", style(t("config.saved"), { color: "green" }));
    }
    if (this.savedStatus === "failed") {
      lines.push("", style(t("config.saveFailed"), { color: "red" }));
    }
    if (this.app.config.hasChanges && this.action === "idle" && this.savedStatus === "idle") {
      lines.push("", style(t("tools.unsavedHint"), { color: "yellow" }));
    }

    lines.push("", style(this.action === "idle" ? t("tools.detailFooter") : t("tools.busyFooter"), { dim: true }));
    return lines;
  }

  // ==================== 内部实现 ====================

  /**
   * 重新探测状态。
   *
   * 用内存配置覆盖磁盘配置：用户在页面里按 t 切换后（尚未按 s 保存）
   * 状态文案也应该立刻变化，而 agent 运行期仍以磁盘配置为准。
   */
  private refreshStatus(): void {
    const pendingEnabled = this.app.config.isToolEnabled(this.toolId);
    this.status = getToolStatus(this.toolId, { enabled: pendingEnabled });
  }

  private progressDetail(progress: ToolInstallProgress): string {
    const t = this.t.bind(this);
    const phaseLabel: Record<ToolInstallPhase, string> = {
      resolving: t("tools.phaseResolving"),
      downloading: t("tools.phaseDownloading"),
      extracting: t("tools.phaseExtracting"),
      verifying: t("tools.phaseVerifying"),
      done: t("tools.phaseDone"),
    };
    const bytes =
      progress.phase === "downloading" && progress.totalBytes
        ? `${formatBytes(progress.receivedBytes)}/${formatBytes(progress.totalBytes)}`
        : undefined;
    return [phaseLabel[progress.phase], bytes, progress.message].filter(Boolean).join(" · ");
  }

  private startInstall(): void {
    const t = this.t.bind(this);
    if (this.status?.installable === false) {
      this.message = { text: t("tools.notInstallable"), ok: false };
      this.refresh();
      return;
    }

    this.action = "installing";
    this.progress = { phase: "resolving", percent: 0 };
    this.message = null;
    this.lastRenderedPercent = -1;
    // 终端原生忙指示（OSC 9;4，任务栏/标签页会显示进度）
    this.app.setBusy(true);
    this.refresh();

    installTool(this.toolId, {
      onProgress: (progress) => {
        this.progress = progress;
        // 只在百分比变化时重绘，避免每个下载 chunk 都请求渲染
        if (progress.percent !== this.lastRenderedPercent) {
          this.lastRenderedPercent = progress.percent;
          this.refresh();
        }
      },
    })
      .then((status) => {
        this.status = status;
        this.action = "idle";
        this.progress = null;
        this.app.setBusy(false);
        this.message = { text: `${t("tools.installDone")} · ${status.version ?? ""}`.trim(), ok: true };
        this.refresh();
      })
      .catch((error: unknown) => {
        this.action = "idle";
        this.progress = null;
        this.app.setBusy(false);
        this.refreshStatus();
        const detail = error instanceof ToolInstallError || error instanceof Error ? error.message : String(error);
        this.message = { text: `${t("tools.installFailed")}: ${detail}`, ok: false };
        this.refresh();
      });
  }

  private async startUninstall(): Promise<void> {
    const t = this.t.bind(this);
    this.action = "uninstalling";
    this.refresh();
    try {
      const removed = await uninstallTool(this.toolId);
      this.message = { text: removed ? t("tools.uninstallDone") : t("tools.uninstallNothing"), ok: removed };
    } catch (error: unknown) {
      this.message = { text: error instanceof Error ? error.message : String(error), ok: false };
    } finally {
      this.action = "idle";
      this.refreshStatus();
      this.refresh();
    }
  }

  private toggleEnabled(): void {
    const next = !(this.status?.enabled ?? true);
    this.app.config.setToolEnabled(this.toolId, next);
    this.refreshStatus();
    this.message = null;
    this.refresh();
  }

  private async startSave(): Promise<void> {
    this.action = "saving";
    this.refresh();
    const ok = await this.app.config.save();
    this.action = "idle";
    this.savedStatus = ok ? "saved" : "failed";
    this.refreshStatus();
    this.refresh();
    this.timer = setTimeout(() => {
      this.savedStatus = "idle";
      if (ok && this.app.currentScreen === this) {
        this.app.navigate(-1);
        return;
      }
      this.refresh();
    }, ok ? 400 : 2000);
  }
}
