/**
 * 日志类型层 —— 对齐 cordis 的 `vendor/cordis/src/logger.ts`。
 *
 * 与 harness 的偏差（无 fiber / 无 Context）：
 *  - `Message` 不含 `fiber?: WeakRef<Fiber>`（zread-pi 无插件/纤程概念）；
 *  - `LoggerLevel` 用 `as const` 对象替代 cordis 的 `const enum`：
 *    本仓库的 bun/tsup 打包链不做隔离编译，const enum 的运行时值会丢失，
 *    `as const` 对象在类型与运行时两侧都可用（harness 之所以能用 const enum，
 *    是因为它的源码被直接打进同一 bundle）。
 *
 * 本模块是纯类型 + 常量，不产生副作用，任何 logger 内部模块都可以安全 import。
 */

/** Logger method name and severity category. */
export type LoggerType = 'error' | 'info' | 'warn' | 'debug';

/** Callable shape for one logger severity method. */
export type LoggerMethod = (format: any, ...param: any[]) => void;

/** Formatter used to resolve a printf-style placeholder. */
export type Formatter = (value: any, exporter: Exporter, message: Message) => any;

/**
 * Numeric severity used when exporters decide whether to emit a message.
 *
 * 数值越大越宽松（error 最严格、debug 最宽松），与 cordis 完全一致：
 * `error=0 / info=1 / warn=2 / debug=3`。
 */
export const LoggerLevel = {
  ERROR: 0,
  INFO: 1,
  WARN: 2,
  DEBUG: 3,
} as const;

export type LoggerLevel = (typeof LoggerLevel)[keyof typeof LoggerLevel];

/** Structured log record delivered to exporters. */
export interface Message {
  /** 全局单调递增的序号（由 LoggerService 分配） */
  sn: number;
  /** 记录时刻的 `Date.now()` */
  ts: number;
  /** 命名 logger 的名字（如 `orchestrator.pages`） */
  name: string;
  /** 严重程度类别 */
  type: LoggerType;
  /** 数值严重程度（与 type 一一对应，方便阈值比较） */
  level: number;
  /** 原始参数：首参为 printf 模板字符串或 Error / 对象 */
  args: any[];
}

/** Sink that receives structured log messages. */
export interface Exporter {
  /**
   * 颜色支持级别（兼容 supports-color：0/1/2/3），`false` 或 `0` 表示无色。
   * 渲染器据此决定是否输出 ANSI 转义。
   */
  colors?: number | false;
  /** 单行最大长度，超过截断并补 `...`（缺省 10240） */
  maxLength?: number;
  /** 按 logger 名字设置的级别阈值（支持前缀匹配，见 resolveExporterLevel） */
  levels?: Record<string, number>;
  /** 自定义 printf 占位符格式化器（覆盖默认） */
  formatters?: Record<string, Formatter>;
  export(message: Message): void;
}

/** Options used when creating a named logger facade. */
export interface LoggerOptions {
  /** The logger name shown with each message. */
  name: string;
  /** Message fields merged into every record from this logger. */
  meta?: Partial<Message>;
  /** Default maximum level exported when an exporter has no own threshold. */
  level?: number;
}

/** 命名 logger 门面：四个严重程度方法 + 继承的元信息。 */
export interface Logger extends LoggerOptions, Record<LoggerType, LoggerMethod> {}
