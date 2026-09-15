/**
 * stdout 接管（移植自 pi/packages/coding-agent/src/core/output-guard.ts）。
 *
 * 全屏 TUI（备用屏幕）里，任何绕开渲染循环直接写 stdout 的输出都会把界面打花
 * （典型来源：第三方库的 console.log / 进度输出 / 调试打印）。本模块把
 * `process.stdout.write` 接管掉：真实终端控制序列仍走原生 stdout，其余杂散写入
 * 交给可配置的去处（pi 默认 stderr；zread-pi 的 TUI 用日志文件，见下方说明）。
 *
 * 与上游的差异（均为新增能力，默认值保持 pi 语义）：
 *  1. `takeOverStdout({ redirect })` 支持 `"stderr"`（默认）/ `"log"` / 自定义回调。
 *     为什么 TUI 用 `"log"`：stderr 与 stdout 指向同一终端，杂散输出写 stderr
 *     一样会在备用屏幕里滚动花屏；zread-pi 的既定约定是「TUI 期间杂散输出进日志文件」
 *     （console-guard 同款），因此 TUI 启动时传入 `redirect: "log"`。
 *  2. `runWithRawStdout(fn)`：受控放行窗口。TUI 终端组件的公开方法把写入包在窗口里，
 *     窗口内的写入直达原生 stdout（保证渲染帧与控制序列的顺序）。
 *  3. `passthroughTerminalSequences`：以 ESC 开头的整块写入直达原生 stdout。
 *     pi-tui 内部有一部分控制序列（Kitty 协商、modifyOtherKeys、窗口标题等）发生在
 *     异步回调里，拿不到放行窗口；它们都以 ESC 开头，直接放行既不影响 TUI，
 *     也不会让杂散日志冒充终端控制。
 */

import { STDOUT_CAPTURE_LOGGER_NAME, createLogger } from "@zread-pi/utils";
import type { Logger } from "@zread-pi/utils";

/** 杂散去处：写入回调 */
export type StrayStdoutHandler = (text: string) => void;

export interface TakeOverStdoutOptions {
  /** 杂散输出的去处：`"stderr"`（pi 默认）/ `"log"`（写 zread-pi 日志文件）/ 自定义回调 */
  redirect?: "stderr" | "log" | StrayStdoutHandler;
  /**
   * 以 ESC 开头的写入是否直达原生 stdout（默认 false = pi 语义）。
   * TUI 场景应开启：异步到达的终端控制序列需要继续作用于真实终端。
   */
  passthroughTerminalSequences?: boolean;
}

interface StdoutTakeoverState {
  rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
  rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
  originalStdoutWrite: typeof process.stdout.write;
  redirect: StrayStdoutHandler;
  passthroughTerminalSequences: boolean;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/** 放行窗口深度（> 0 时视为受控写入，直达原生 stdout） */
let rawStdoutPermits = 0;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
  if (stdoutTakeoverState) {
    return stdoutTakeoverState.rawStdoutWrite;
  }
  return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          getRawStdoutWrite()(text, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return;
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error(String(error));
      const code = (writeError as Error & { code?: unknown }).code;
      if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
        throw writeError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
    }
  }
}

/** 把杂散 stdout 送进日志总线（命名 tui.stdout，由 file exporter 统一落盘）。 */
let strayLogger: Logger | undefined;

function appendStrayToLog(text: string): void {
  try {
    if (!strayLogger) strayLogger = createLogger(STDOUT_CAPTURE_LOGGER_NAME);
    // 用 %s 占位原样传递，避免文本里的 % 被 printf 误解析
    strayLogger.info("%s", text);
  } catch {
    // 杂散输出写日志失败时静默：绝不能反过来污染终端
  }
}

function toRedirectHandler(
  redirect: TakeOverStdoutOptions["redirect"],
  rawStderrWrite: StdoutTakeoverState["rawStderrWrite"],
): StrayStdoutHandler {
  if (typeof redirect === "function") return redirect;
  if (redirect === "log") return appendStrayToLog;
  return (text) => {
    rawStderrWrite(text);
  };
}

function chunkToText(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") return chunk;
  return Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
}

/**
 * 接管 process.stdout.write；重复调用无副作用。
 *
 * 接管后：
 *  - 放行窗口内的写入 → 原生 stdout；
 *  - `passthroughTerminalSequences` 开启且写入以 ESC 开头 → 原生 stdout；
 *  - 其余写入 → redirect（stderr / 日志 / 自定义）。
 */
export function takeOverStdout(options: TakeOverStdoutOptions = {}): void {
  if (stdoutTakeoverState) {
    return;
  }

  const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
  const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
  const originalStdoutWrite = process.stdout.write;
  const redirect = toRedirectHandler(options.redirect, rawStderrWrite);
  const passthroughTerminalSequences = options.passthroughTerminalSequences ?? false;

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = chunkToText(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;

    if (rawStdoutPermits > 0 || (passthroughTerminalSequences && text.startsWith("\x1b"))) {
      return rawStdoutWrite(text, done);
    }

    redirect(text);
    done?.();
    return true;
  }) as typeof process.stdout.write;

  stdoutTakeoverState = {
    rawStdoutWrite,
    rawStderrWrite,
    originalStdoutWrite,
    redirect,
    passthroughTerminalSequences,
  };
}

/** 还原 process.stdout.write（未接管时无副作用） */
export function restoreStdout(): void {
  if (!stdoutTakeoverState) {
    return;
  }

  process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
  stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
  return stdoutTakeoverState !== undefined;
}

/**
 * 在「放行窗口」内同步执行动作：窗口内对 `process.stdout.write` 的调用直达原生 stdout。
 *
 * TUI 的终端组件用它在公开方法里包住自己的写入，确保渲染帧与控制序列不被 redirect。
 */
export function runWithRawStdout<T>(fn: () => T): T {
  rawStdoutPermits += 1;
  try {
    return fn();
  } finally {
    rawStdoutPermits -= 1;
  }
}

/** 直达原生 stdout 的异步写队列（ENOBUFS / EAGAIN / EWOULDBLOCK 自动重试） */
export function writeRawStdout(text: string): void {
  if (text.length === 0) {
    return;
  }
  rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
  void rawStdoutWriteTail.catch(() => {
    process.exit(1);
  });
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
  while (true) {
    const tail = rawStdoutWriteTail;
    await tail;
    if (tail === rawStdoutWriteTail) {
      return;
    }
  }
}

export async function flushRawStdout(): Promise<void> {
  await waitForRawStdoutBackpressure();
  await writeRawStdoutChunk("");
}
