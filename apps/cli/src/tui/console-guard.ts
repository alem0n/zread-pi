/**
 * console-guard - TUI 运行期间把 console 输出重定向到日志文件
 *
 * 备用屏幕（TuiAltScreen）里任何 stdout/stderr 写入都会直接画到界面上，
 * 造成花屏/错位（典型来源：provider-registry 同步失败时的 console.error）。
 * TUI 启动前接管 console，退出时还原。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogFile } from "@zread-pi/utils";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendLog(level: string, args: unknown[]): void {
  try {
    const logPath = getLogFile();
    mkdirSync(dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArg).join(" ")}\n`;
    appendFileSync(logPath, line, "utf-8");
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
    const level = method === "log" || method === "info" ? "INFO" : method.toUpperCase();
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      appendLog(level, args);
    };
  }

  return () => {
    for (const [method, fn] of original) {
      (console as unknown as Record<string, unknown>)[method] = fn;
    }
  };
}
