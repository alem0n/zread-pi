/**
 * GuardedProcessTerminal —— 与 output-guard 配套的终端实现。
 *
 * pi 的 `ProcessTerminal` 直接调用 `process.stdout.write`；而 TUI 启动后 stdout 已被
 * 接管（杂散输出转去日志）。为了让 TUI 自己的渲染帧与控制序列不受影响，
 * 这里把终端组件的公开方法包进 output-guard 的「放行窗口」，窗口内写入直达原生 stdout。
 *
 * 进度指示（OSC 9;4）单独实现：pi-tui 的保活定时器在窗口之外异步触发，
 * 放在这里用 `writeRawStdout` 直写，既保住终端任务栏进度，又不会被误判成杂散输出。
 */

import { ProcessTerminal } from "@earendil-works/pi-tui";
import { runWithRawStdout, writeRawStdout } from "./output-guard";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";

export class GuardedProcessTerminal extends ProcessTerminal {
  private guardedProgressInterval?: ReturnType<typeof setInterval>;

  override start(onInput: (data: string) => void, onResize: () => void): void {
    runWithRawStdout(() => super.start(onInput, onResize));
  }

  override stop(): void {
    this.clearGuardedProgress();
    runWithRawStdout(() => super.stop());
  }

  override write(data: string): void {
    runWithRawStdout(() => super.write(data));
  }

  override moveBy(lines: number): void {
    runWithRawStdout(() => super.moveBy(lines));
  }

  override hideCursor(): void {
    runWithRawStdout(() => super.hideCursor());
  }

  override showCursor(): void {
    runWithRawStdout(() => super.showCursor());
  }

  override clearLine(): void {
    runWithRawStdout(() => super.clearLine());
  }

  override clearFromCursor(): void {
    runWithRawStdout(() => super.clearFromCursor());
  }

  override clearScreen(): void {
    runWithRawStdout(() => super.clearScreen());
  }

  override setTitle(title: string): void {
    runWithRawStdout(() => super.setTitle(title));
  }

  override setProgress(active: boolean): void {
    if (active) {
      writeRawStdout(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
      if (!this.guardedProgressInterval) {
        this.guardedProgressInterval = setInterval(() => {
          writeRawStdout(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
        }, TERMINAL_PROGRESS_KEEPALIVE_MS);
      }
    } else {
      this.clearGuardedProgress();
      writeRawStdout(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
    }
  }

  private clearGuardedProgress(): void {
    if (!this.guardedProgressInterval) return;
    clearInterval(this.guardedProgressInterval);
    this.guardedProgressInterval = undefined;
  }
}
