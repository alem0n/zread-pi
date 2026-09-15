/**
 * console-guard - TUI 运行期间把 console 输出重定向到日志总线
 *
 * 备用屏幕（TuiAltScreen）里任何 stdout/stderr 写入都会直接画到界面上，
 * 造成花屏/错位（典型来源：provider-registry 同步失败时的 console.error）。
 * TUI 启动前接管 console，退出时还原。
 *
 * 对齐 cordis 日志总线后，这里不再是「自己拼字符串写文件」，而是把捕获到的
 * console 调用作为命名 logger `tui.console` 送进总线，由 file exporter 统一落盘
 * （日志文件只有这一个写入者，避免双写）。console exporter 会跳过这个名字的
 * 记录，否则 console 输出会被总线再送回 console，形成无限递归。
 */

import { createLogger } from "@zread-pi/utils";
import type { Logger } from "@zread-pi/utils";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

/** console 方法 → 总线严重程度。 */
const LEVEL_BY_METHOD: Record<ConsoleMethod, "error" | "info" | "warn" | "debug"> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
  trace: "debug",
};

let tuiConsoleLogger: Logger | undefined;

function getLogger(): Logger {
  if (!tuiConsoleLogger) tuiConsoleLogger = createLogger("tui.console");
  return tuiConsoleLogger;
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把捕获到的 console 调用送进日志总线（命名 tui.console）。 */
function forwardToBus(level: "error" | "info" | "warn" | "debug", args: unknown[]): void {
  try {
    // 用 %s 占位把拼接好的文本原样传递，避免文本里的 % 被 printf 误解析
    getLogger()[level]("%s", args.map(formatArg).join(" "));
  } catch {
    // 日志失败时静默，绝不能反过来污染终端
  }
}

/**
 * 接管 console；返回还原函数。
 * 建议在启动 TUI 之前调用，并在退出前调用还原函数。
 */
export function captureConsoleToLog(): () => void {
  const original = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  for (const method of METHODS) {
    const fn = console[method];
    if (typeof fn === "function") {
      original.set(method, fn.bind(console));
    }
  }

  for (const method of METHODS) {
    if (!original.has(method)) continue;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      forwardToBus(LEVEL_BY_METHOD[method], args);
    };
  }

  return () => {
    for (const [method, fn] of original) {
      (console as unknown as Record<string, unknown>)[method] = fn;
    }
  };
}
