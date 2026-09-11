/**
 * 子进程执行（工具层专用，跨平台）
 *
 * 上游把这些逻辑散落在 `utils/child-process.ts` + 各工具里；这里只保留搜索工具需要的部分：
 *  - 直接 `spawn` 可执行文件（不经过 shell），因此在 Windows / Linux / macOS 行为一致，
 *    也避免 shell 注入与 `&&` / 引号等 POSIX-only 写法；
 *  - 支持 AbortSignal 与超时，超时/中止都会杀掉子进程；
 *  - 输出按字节上限截断，防止异常仓库把内存打满。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface CaptureOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** stdout 收集上限（字节）；超过则丢弃后续输出并标记 truncated。 */
	maxBytes?: number;
}

export interface CaptureResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** stdout 是否因字节上限被丢弃 */
	truncated: boolean;
	/** 被 AbortSignal 中止 */
	aborted: boolean;
	/** 进程无法启动（如 ENOENT）或其它运行期错误 */
	error?: Error;
}

/** 运行命令并收集 stdout/stderr（不经过 shell）。 */
export function runCapture(command: string, args: string[], options: CaptureOptions = {}): Promise<CaptureResult> {
	return new Promise<CaptureResult>((resolve) => {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let capturedBytes = 0;
		let truncated = false;
		let aborted = false;
		let settled = false;

		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: CaptureResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const stop = (): void => {
			if (!child.killed) child.kill();
		};
		const onAbort = (): void => {
			aborted = true;
			stop();
		};

		if (options.signal?.aborted) {
			aborted = true;
			stop();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		timer = setTimeout(stop, options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
		// 允许进程结束后 Node 自然退出，不因为定时器悬挂
		(timer as unknown as { unref?: () => void }).unref?.();

		child.stdout?.on("data", (chunk: Buffer) => {
			if (truncated) return;
			capturedBytes += chunk.length;
			if (capturedBytes > maxBytes) {
				truncated = true;
				stop();
				return;
			}
			chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errChunks.length < 64) errChunks.push(chunk);
		});

		child.on("error", (error: Error) => {
			finish({
				code: null,
				stdout: Buffer.concat(chunks).toString("utf-8"),
				stderr: "",
				truncated,
				aborted,
				error,
			});
		});

		child.on("close", (code: number | null) => {
			finish({
				code,
				stdout: Buffer.concat(chunks).toString("utf-8"),
				stderr: Buffer.concat(errChunks).toString("utf-8"),
				truncated,
				aborted,
			});
		});
	});
}

export interface StreamLinesOptions extends CaptureOptions {
	/** 收到一行时回调；返回 false 表示停止读取（会杀掉子进程）。 */
	onLine: (line: string) => boolean | void;
	/** 上限：最多处理多少行（超出后丢弃剩余行，不影响进程退出状态）。 */
	maxLines?: number;
}

export interface StreamLinesResult {
	code: number | null;
	stderr: string;
	lines: number;
	aborted: boolean;
	error?: Error;
}

/**
 * 逐行流式读取子进程 stdout（按 \r?\n 切分）。
 *
 * 用于 rg 的 `--json` 输出与 fd 的逐行输出：命中上限时可以立刻 kill 子进程，
 * 不必等全量输出（旧实现的全量缓冲问题）。
 */
export function streamLines(command: string, args: string[], options: StreamLinesOptions): Promise<StreamLinesResult> {
	return new Promise<StreamLinesResult>((resolve) => {
		let lineCount = 0;
		let stderr = "";
		let aborted = false;
		let settled = false;
		let stopping = false;

		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const reader = createInterface({ input: child.stdout ?? undefined, crlfDelay: Infinity });

		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reader.close();
		};
		const finish = (result: StreamLinesResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const stop = (): void => {
			stopping = true;
			if (!child.killed) child.kill();
		};
		const onAbort = (): void => {
			aborted = true;
			stop();
		};

		if (options.signal?.aborted) {
			aborted = true;
			stop();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		timer = setTimeout(stop, options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
		(timer as unknown as { unref?: () => void }).unref?.();

		reader.on("line", (line: string) => {
			lineCount++;
			if (stopping) return;
			if (options.maxLines !== undefined && lineCount > options.maxLines) {
				stop();
				return;
			}
			const keepGoing = options.onLine(line);
			if (keepGoing === false) stop();
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 16_384) stderr += chunk.toString();
		});

		child.on("error", (error: Error) => {
			finish({ code: null, stderr, lines: lineCount, aborted, error });
		});

		child.on("close", (code: number | null) => {
			finish({ code, stderr, lines: lineCount, aborted });
		});
	});
}
