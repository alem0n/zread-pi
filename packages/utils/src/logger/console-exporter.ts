/**
 * Console exporter —— 对齐 logger-console 的 Node 变体
 * （`vendor/logger-console/src/index.ts` + `shared.ts`）。
 *
 * 渲染格式与 harness 逐字一致：
 *  `[I] name message`，可选时间戳前缀（`showTime` 模板）、可选相对上次的时间差
 *  （`showDiff`）、可选名字标签宽度对齐（`label`）；对象参数走 `util.inspect`
 *  （node 变体），名字按哈希着色。
 *
 * 与 harness 的偏差：
 *  - 不依赖 `supports-color`：色彩探测手写约 20 行（`NO_COLOR` / `FORCE_COLOR` /
 *    TTY + `COLORTERM` / `TERM`），零新依赖，不影响 standalone 二进制打包；
 *  - 递归保护：名为 `tui.console`（console-guard 捕获的输出）与 `tui.stdout`
 *    （output-guard 转存的杂散 stdout）的记录不再回到 console，否则
 *    `ZREAD_PI_LOG_CONSOLE=1` + TUI 时会形成 console → stdout 接管 → 总线 →
 *    console 的无限递归（每次迭代都追加日志文件）。
 */

import { inspect } from 'node:util';
import { LoggerFormat } from './format.js';
import { Time } from './time.js';
import { type Exporter, type Formatter, type Message } from './types.js';

/** Terminal color support level compatible with supports-color. */
export type ColorSupportLevel = 0 | 1 | 2 | 3;

/** console exporter 的名字（也是「已被捕获的 console 输出」的 logger 名）。 */
export const CONSOLE_CAPTURE_LOGGER_NAME = 'tui.console';

/** 杂散 stdout 的 logger 名（output-guard 的 redirect: "log" 路径）。 */
export const STDOUT_CAPTURE_LOGGER_NAME = 'tui.stdout';

/** 显式开启 console exporter 的环境变量（默认不注册，避免与 console-guard 双写日志文件）。 */
export const LOG_CONSOLE_ENV = 'ZREAD_PI_LOG_CONSOLE';

/** 级别阈值环境变量，形如 `default=info,orchestrator=debug`。 */
export const LOG_LEVEL_ENV = 'ZREAD_PI_LOG_LEVEL';

/** Formatting options for the logger name label. */
export interface LabelStyle {
  width?: number;
  margin?: number;
  align?: 'left' | 'right';
}

export interface ConsoleExporterOptions {
  colors?: false | ColorSupportLevel;
  maxLength?: number;
  levels?: Record<string, number>;
  showDiff?: boolean;
  showTime?: string;
  label?: LabelStyle;
}

/** 显式标记「不要把这条记录再送回 console」。 */
const CAPTURED_NAMES = new Set<string>([CONSOLE_CAPTURE_LOGGER_NAME, STDOUT_CAPTURE_LOGGER_NAME]);

/**
 * 手写色彩探测（替代 supports-color，零依赖）。
 *
 * 语义对齐 supports-color：`NO_COLOR`（非空）禁用；`FORCE_COLOR` 强制档位；
 * 否则仅当 stdout 是 TTY 时按 `COLORTERM` / `TERM` 推断档位，非 TTY 返回 0。
 */
export function detectColorLevel(stream: { isTTY?: boolean } = process.stdout): ColorSupportLevel {
  const env = process.env;
  if (env.NO_COLOR) return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    if (force === '0' || force === 'false') return 0;
    if (force === '3') return 3;
    if (force === '2') return 2;
    return 1;
  }
  if (!stream.isTTY) return 0;
  const colorTerm = env.COLORTERM;
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 3;
  const term = typeof env.TERM === 'string' ? env.TERM : '';
  if (term.includes('256')) return 2;
  if (term.includes('color')) return 1;
  // Windows 终端（含旧版 conhost）在 TTY 下至少支持 16 色
  return 1;
}

const inspectFormatter: Formatter = (value, target) => {
  return inspect(value, { colors: !!target.colors, depth: Infinity, compact: true, breakLength: Infinity });
};

/** Node console exporter with `util.inspect` object formatting. */
export class ConsoleExporter implements Exporter {
  colors: false | ColorSupportLevel;
  maxLength?: number;
  levels?: Record<string, number>;
  showDiff: boolean;
  showTime: string;
  label?: LabelStyle;
  private timestamp = 0;

  formatters: Record<string, Formatter> = {
    o: inspectFormatter,
    O: inspectFormatter,
  };

  constructor(options: ConsoleExporterOptions = {}) {
    this.colors = options.colors ?? detectColorLevel();
    this.maxLength = options.maxLength;
    this.levels = options.levels;
    this.showDiff = options.showDiff ?? false;
    this.showTime = options.showTime ?? 'yyyy-MM-dd hh:mm:ss ';
    this.label = options.label;
  }

  export(message: Message): void {
    if (CAPTURED_NAMES.has(message.name)) return;
    // eslint-disable-next-line no-console
    console.log(this.render(message));
  }

  render(message: Message): string {
    const prefix = `[${message.type[0].toUpperCase()}]`;
    const space = ' '.repeat(this.label?.margin ?? 1);
    let indent = 3 + space.length;
    let output = '';
    if (this.showTime) {
      indent += this.showTime.length;
      output += LoggerFormat.color(this, 8, Time.template(this.showTime));
    }
    const code = LoggerFormat.code(message.name, this.colors);
    const label = LoggerFormat.color(this, code, message.name, ';1');
    const padLength = (this.label?.width ?? 0) + label.length - message.name.length;
    if (this.label?.align === 'right') {
      output += label.padStart(padLength) + space + prefix + space;
      indent += (this.label.width ?? 0) + space.length;
    } else {
      output += prefix + space + label.padEnd(padLength) + space;
    }
    output += LoggerFormat.format(this, message).replace(/\n/g, '\n' + ' '.repeat(indent));
    if (this.showDiff && this.timestamp) {
      const diff = message.ts - this.timestamp;
      output += LoggerFormat.color(this, code, ' +' + Time.format(diff));
    }
    this.timestamp = message.ts;
    return output;
  }
}
