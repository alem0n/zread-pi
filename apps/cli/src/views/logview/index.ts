/**
 * LogviewPage - 轨迹（Trajectory）检查视图（pi-tui 版）
 *
 * 镜像 BrowsePage 的四态：无运行 / 启动中 / 运行中（真实 URL）/ 已停止 / 错误。
 * 启动浏览服务器并在浏览器打开 `/trajectory/:runId`（runId 缺省 = latest）。
 * ESC 停止服务器并返回上一页。
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { startWikiBrowseServer } from "../../commands/browse-server";
import { latestRun } from "@zread-pi/utils";
import { Divider } from "../../tui/components/divider";
import { wrapStyled } from "../../tui/text-layout";
import { style } from "../../tui/ansi";
import { Screen } from "../../tui/screen";
import { theme } from "../../theme";

type LogviewStatus = "checking" | "no-runs" | "starting" | "running" | "stopped" | "error";

// ink-spinner 的 dots 动画帧
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export default class LogviewPage extends Screen {
  private status: LogviewStatus = "checking";
  private url = "";
  private errorMessage = "";
  private server: { close: () => void | Promise<void> } | null = null;
  private spinnerFrame = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private navigateTimer?: ReturnType<typeof setTimeout>;

  protected override async init(): Promise<void> {
    const projectPath = process.cwd();
    const param = this.app.location?.params.runId;

    // 解析要打开的 runId：路径参数 > 最新一次；一次都没有 → 无运行态
    let runId = typeof param === "string" && param.length > 0 ? param : undefined;
    if (!runId) {
      const latest = await latestRun(projectPath);
      if (latest === undefined) {
        this.status = "no-runs";
        this.refresh();
        return;
      }
      runId = latest.id;
    }

    this.status = "starting";
    this.startSpinner();
    this.refresh();

    startWikiBrowseServer(projectPath, { initialPath: `/trajectory/${runId}` })
      .then((info) => {
        this.url = `${info.url}/trajectory/${runId}`;
        this.server = info;
        this.status = "running";
        this.stopSpinner();
        this.refresh();
      })
      .catch((error: unknown) => {
        this.errorMessage = error instanceof Error ? error.message : String(error);
        this.status = "error";
        this.stopSpinner();
        this.refresh();
      });
  }

  override handleKey(data: string): boolean {
    if (matchesKey(data, "escape")) {
      if (this.server) {
        const server = this.server;
        this.server = null;
        // close() 可能返回 Promise（Vite dev server），失败也不应阻塞退出
        void Promise.resolve(server.close()).catch(() => {});
      }
      this.status = "stopped";
      this.stopSpinner();
      this.refresh();
      // 短暂显示停止状态后返回
      this.navigateTimer = setTimeout(() => {
        if (this.app.currentScreen === this) this.app.navigate("/wiki");
      }, 500);
      return true;
    }
    return false;
  }

  override onDestroy(): void {
    this.stopSpinner();
    if (this.navigateTimer) clearTimeout(this.navigateTimer);
  }

  render(width: number): string[] {
    // 无运行记录
    if (this.status === "no-runs") {
      return [
        ...new Divider(this.t("logview.noRuns"), "yellow").render(width),
        "",
        style(this.t("logview.noRunsHint"), { dim: true }),
        "",
        style(this.t("common.escBack"), { dim: true }),
      ];
    }

    // 正在启动
    if (this.status === "checking" || this.status === "starting") {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      return [
        ...new Divider(this.t("logview.starting")).render(width),
        "",
        style(frame, { color: theme.warning }) + " " + this.t("logview.starting"),
      ];
    }

    // 已停止
    if (this.status === "stopped") {
      return [...new Divider(this.t("logview.stopped")).render(width)];
    }

    // 启动失败：展示具体原因（端口占用 / 缺少前端资源等）
    if (this.status === "error") {
      const messageLines = this.errorMessage
        .split(/\r?\n/)
        .flatMap((line) => wrapStyled(line, Math.max(1, width)));
      return [
        ...new Divider(this.t("logview.startFailed"), "red").render(width),
        "",
        ...messageLines.map((line) => style(line, { color: theme.warning })),
        "",
        style(this.t("common.escBack"), { dim: true }),
      ];
    }

    // 正在运行
    return [
      ...new Divider(this.t("logview.running"), "green").render(width),
      "",
      style(`${this.t("logview.url")}: `, { dim: true }) +
        style(this.url, { color: "cyan", bold: true }),
      "",
      style(this.t("logview.footer"), { dim: true }),
    ];
  }

  // ==================== 内部实现 ====================

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.refresh();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }
}
