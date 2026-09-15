/**
 * LoggerService —— 对齐 cordis 的 `LoggerService` + `Logger` 门面
 * （`vendor/cordis/src/logger.ts`），去掉 fiber / Context / DI。
 *
 * zread-pi 没有 cordis 的插件与纤程体系，这里用**模块级单例**替代：
 *  - `getLoggerService()`：进程内唯一的总线（懒构造，首次记日志时才建）；
 *  - `createLogger(name?)`：创建命名 logger 门面（名字默认 `app`）；
 *  - `addExporter(exporter)`：注册 exporter，返回注销函数。
 *
 * 记录流程（与 cordis 的 `Logger._method` 一致）：
 *  1. 单 Error 首参且带 `cause` → 递归记录 cause；AggregateError → 拆成多条；
 *  2. 分配全局 `sn` / `ts`，广播给所有 exporter；
 *  3. 每个 exporter 用 `resolveExporterLevel` 判定是否发出（级别阈值）。
 *
 * 默认注册的 exporter：内置环形缓冲（1000 条，全级别）+ 文本文件 exporter +
 * JSONL exporter（结构化机器可读 sink，`ZREAD_PI_LOG_JSONL=0` 关闭）。
 * console exporter **默认不注册**（显式 `ZREAD_PI_LOG_CONSOLE=1` 才开），
 * 因为 TUI 期间 console-guard 会把 console 输出转回总线，两者同时开启会往
 * 日志文件里双写（详见 MIGRATION.md）。
 */

import { LoggerFormat, resolveExporterLevel } from './format.js';
import {
  ConsoleExporter,
  LOG_CONSOLE_ENV,
  LOG_LEVEL_ENV,
} from './console-exporter.js';
import { FileExporter } from './file-exporter.js';
import { JsonlExporter, isJsonlEnabled } from './jsonl-exporter.js';
import {
  LoggerLevel,
  type Exporter,
  type Logger,
  type LoggerMethod,
  type LoggerOptions,
  type LoggerType,
  type Message,
} from './types.js';

/** 内置环形缓冲大小（与 cordis 的 `bufferSize = 1000` 一致）。 */
export const DEFAULT_BUFFER_SIZE = 1000;

/** 默认 logger 名（兼容旧的全局单例 logger）。 */
export const DEFAULT_LOGGER_NAME = 'app';

/**
 * 解析级别阈值环境变量：`default=info,orchestrator=debug` 形式。
 *
 * 条目可省略名字（`debug` → 设为 default）；未知级别名或负数忽略；
 * 整体非法（空串 / 全部非法）时回退 `{ default: INFO }`。
 */
export function parseLogLevels(env: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (typeof env !== 'string' || env.trim() === '') {
    return { default: LoggerLevel.INFO };
  }
  for (const raw of env.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const equals = entry.indexOf('=');
    const name = equals < 0 ? 'default' : entry.slice(0, equals).trim();
    const value = equals < 0 ? entry : entry.slice(equals + 1).trim();
    const level = levelFromName(value.toLowerCase());
    if (level === undefined) continue;
    if (name === '') continue;
    result[name] = level;
  }
  if (result.default === undefined) result.default = LoggerLevel.INFO;
  return result;
}

function levelFromName(name: string): number | undefined {
  switch (name) {
    case 'error': return LoggerLevel.ERROR;
    case 'info': return LoggerLevel.INFO;
    case 'warn':
    case 'warning': return LoggerLevel.WARN;
    case 'debug': return LoggerLevel.DEBUG;
    default: return undefined;
  }
}

/** Logger 门面：对齐 cordis 的 `class Logger`（去掉静态渲染方法，见 format.ts）。 */
export class LoggerFacade implements Logger {
  name: string;
  meta?: Partial<Message>;
  level?: number;
  readonly error: LoggerMethod;
  readonly info: LoggerMethod;
  readonly warn: LoggerMethod;
  readonly debug: LoggerMethod;

  constructor(options: LoggerOptions, private service: LoggerService) {
    this.name = options.name;
    this.meta = options.meta;
    this.level = options.level;
    this.error = this._method('error', LoggerLevel.ERROR);
    this.info = this._method('info', LoggerLevel.INFO);
    this.warn = this._method('warn', LoggerLevel.WARN);
    this.debug = this._method('debug', LoggerLevel.DEBUG);
  }

  private _method(type: LoggerType, level: number): LoggerMethod {
    return (...args: any[]) => {
      // 单 Error 首参的展开（cause 链 / AggregateError），与 cordis 一致：
      //  - 有 cause：先递归记录 cause，再 fall-through 把原错误也广播；
      //  - AggregateError（无 cause）：拆成子错误逐条记录后 return，
      //    聚合错误本身不重复广播。
      if (args.length === 1 && args[0] instanceof Error) {
        const error = args[0] as Error & { cause?: unknown; errors?: Error[] };
        if (error.cause instanceof Error) {
          this[type](error.cause);
        } else if (Array.isArray(error.errors) && error.errors.length > 0) {
          for (const item of error.errors) this[type](item);
          return;
        }
      }

      const sn = ++this.service._snMessage;
      const ts = Date.now();
      for (const exporter of this.service.exporters.values()) {
        const targetLevel = resolveExporterLevel(exporter, this.name, this.level);
        if (targetLevel < level) continue;
        const message: Message = { sn, ts, type, level, name: this.name, ...this.meta, args };
        // 异常隔离：单个故障 exporter 绝不能打断业务或影响其它 exporter
        // （本模块的自述契约：日志写失败静默）。
        try {
          exporter.export(message);
        } catch {
          // 静默：渲染/落盘失败不向业务调用方传播
        }
      }
    };
  }
}

/** 日志总线（模块级单例）：广播结构化记录给所有 exporter。 */
export class LoggerService {
  bufferSize = DEFAULT_BUFFER_SIZE;
  buffer: Message[] = [];

  _snMessage = 0;
  _snExporter = 0;
  exporters = new Map<number, Exporter>();

  constructor() {
    // 内置环形缓冲：记录全部级别，供排障/最近日志查询（cordis 的缓冲默认只到 INFO，
    // 这里放宽到 DEBUG——缓冲是内存侧的排障快照，不进文件也不进终端）。
    this.addExporter({
      levels: { default: LoggerLevel.DEBUG },
      export: (message) => {
        this.buffer.push(message);
        if (this.buffer.length > this.bufferSize) {
          this.buffer = this.buffer.slice(-this.bufferSize);
        }
      },
    });

    // 文本文件 exporter（默认开启，日期按写入时刻取）
    this.addExporter(new FileExporter());

    // JSONL exporter：默认开启（ZREAD_PI_LOG_JSONL=0 关闭），结构化机器可读 sink
    if (isJsonlEnabled()) {
      this.addExporter(new JsonlExporter());
    }

    // console exporter：仅当显式要求时注册（避免与 TUI 的 console-guard 双写文件）
    if (isConsoleExporterEnabled()) {
      this.addExporter(new ConsoleExporter({ levels: parseLogLevels(process.env[LOG_LEVEL_ENV]) }));
    }
  }

  /** 创建命名 logger 门面。 */
  createLogger(name: string = DEFAULT_LOGGER_NAME): Logger {
    return new LoggerFacade({ name }, this);
  }

  /** 注册 exporter，返回注销函数。 */
  addExporter(exporter: Exporter): () => void {
    const id = ++this._snExporter;
    this.exporters.set(id, exporter);
    return () => {
      this.exporters.delete(id);
    };
  }
}

function isConsoleExporterEnabled(): boolean {
  const raw = process.env[LOG_CONSOLE_ENV];
  return raw === '1' || raw === 'true' || raw === 'yes';
}

let service: LoggerService | undefined;

/** 取日志总线单例（懒构造）。 */
export function getLoggerService(): LoggerService {
  if (!service) service = new LoggerService();
  return service;
}

/** 创建命名 logger（默认名 `app`，对齐旧的全局 logger）。 */
export function createLogger(name?: string): Logger {
  return getLoggerService().createLogger(name);
}

/** 注册 exporter；返回注销函数（测试 / 扩展用）。 */
export function addExporter(exporter: Exporter): () => void {
  return getLoggerService().addExporter(exporter);
}

/** 仅供测试重置单例（业务代码不要调用）。 */
export function resetLoggerServiceForTesting(): void {
  service = undefined;
}
