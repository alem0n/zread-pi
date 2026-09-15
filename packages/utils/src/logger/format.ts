/**
 * 日志格式化层 —— 对齐 cordis 的 `Logger.color` / `Logger.code` / `Logger.format`
 * 与 `defaultFormatters`（`vendor/cordis/src/logger.ts`）。
 *
 * 这里把 cordis 挂在 `Logger` 类上的静态方法挪到 `LoggerFormat` 命名空间：
 * 本仓库的 `Logger` 是纯门面（见 service.ts），渲染工具被 console / file
 * 两个 exporter 共用，放进命名空间更清晰，也避免门面类同时是渲染器。
 *
 * `resolveExporterLevel` 是本仓库新增的级别判定（cordis 也有等价逻辑，但在
 * `Logger._method` 内联）：支持按 logger 名字做**前缀匹配**的阈值，
 * 使 `ZREAD_PI_LOG_LEVEL=orchestrator=debug` 能覆盖 `orchestrator.pages`
 * 这样的层级命名（cordis 只做精确匹配 + default）。
 */

import { LoggerLevel, type Exporter, type Formatter, type Message } from './types.js';

function isAggregateError(error: any): error is Error & { errors: Error[] } {
  return error instanceof Error && Array.isArray((error as Error & { errors?: unknown }).errors);
}

/** Built-in placeholder formatters used by `LoggerFormat.format()`. */
export const defaultFormatters: Record<string, Formatter> = {
  s: (value) => String(value),
  d: (value) => Math.trunc(Number(value)),
  i: (value) => Math.trunc(Number(value)),
  f: (value) => Number(value),
  o: (value) => JSON.stringify(value),
  O: (value) => JSON.stringify(value),
  c: () => '',
  C: (value, exporter, message) => {
    return LoggerFormat.color(exporter, LoggerFormat.code(message.name, exporter.colors), value);
  },
};

/**
 * ANSI 16-color palette indexes used for logger name coloring（cordis 逐字复刻）。
 * 注意：这些是 SGR 颜色**参数值**（3x 前景），不是转义序列本身。
 */
export const c16 = [6, 2, 3, 4, 5, 1];

/** ANSI 256-color palette indexes used for logger name coloring（cordis 逐字复刻）。 */
export const c256 = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62,
  63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113,
  129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168,
  169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
];

export function isLoggerAggregateError(error: any): error is Error & { errors: Error[] } {
  return isAggregateError(error);
}

/** 渲染工具（对齐 cordis 的 `Logger` 静态方法）。 */
export namespace LoggerFormat {
  /** 按 exporter 的色彩级别给文本着色；无色时原样返回字符串。 */
  export function color(exporter: Exporter, code: number, value: any, decoration = ''): string {
    if (!exporter.colors) return '' + value;
    return `\u001b[3${code < 8 ? code : '8;5;' + code}${exporter.colors >= 2 ? decoration : ''}m${value}\u001b[0m`;
  }

  /** 由 logger 名字哈希出稳定的颜色索引；`level` 决定用 16 色还是 256 色板。 */
  export function code(name: string, level?: false | number): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 3) - hash) + name.charCodeAt(i) + 13;
      hash |= 0;
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16;
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * 把 `message.args` 渲染成字符串：首参做 printf 模板，Error 首参展开 stack，
   * 非字符串首参补 `%o`，剩余对象参数追加在后，单行超长截断。
   */
  export function format(exporter: Exporter, message: Message): string {
    const args = message.args.slice();
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message;
      args.unshift('%s');
    } else if (typeof args[0] !== 'string') {
      args.unshift('%o');
    }

    let formatString: string = args.shift();
    formatString = formatString.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === '%%') return '%';
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
      if (typeof formatter === 'function') {
        const value = args.shift();
        return formatter(value, exporter, message);
      }
      return match;
    });

    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
    for (let arg of args) {
      if (typeof arg === 'object' && arg) {
        arg = oFormatter(arg, exporter, message);
      }
      formatString += ' ' + arg;
    }

    const { maxLength = 10240 } = exporter;
    return formatString.split(/\r?\n/g).map(line => {
      return line.slice(0, maxLength) + (line.length > maxLength ? '...' : '');
    }).join('\n');
  }
}

/**
 * 判定某 exporter 是否应当发出这条消息（级别阈值）。
 *
 * 优先级：按名前缀匹配的最具体阈值 → `default` → logger 自身 `level` → INFO。
 * 前缀匹配按点号边界：`orchestrator` 命中 `orchestrator` 与 `orchestrator.pages`，
 * 但不命中 `orchestrator-lite`。
 */
export function resolveExporterLevel(
  exporter: Exporter,
  name: string,
  loggerLevel?: number,
): number {
  const levels = exporter.levels;
  if (levels) {
    let best: number | undefined;
    let bestLength = -1;
    for (const key of Object.keys(levels)) {
      const matched = key === name || (name.startsWith(key) && name[key.length] === '.');
      if (matched && key.length > bestLength) {
        bestLength = key.length;
        best = levels[key];
      }
    }
    if (best !== undefined) return best;
    if (levels.default !== undefined) return levels.default;
  }
  return loggerLevel ?? LoggerLevel.INFO;
}
