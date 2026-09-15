/**
 * File exporter —— harness 没有（logger-console 只管终端），这是本仓库新增的
 * 文本 sink，沿用 zread-pi 既定产物位置 `~/.zread-pi/logs/zread-pi-<date>.log`。
 *
 * 与旧 `logger.ts` 实现的差异（详见 MIGRATION.md）：
 *  1. 日期按**写入时刻**计算（旧实现在模块加载期定死 `LOG_FILE`，跨天运行会写错文件）；
 *  2. 行内带上命名 logger 的名字（`[时间] [级别] 名字 消息`），便于按模块过滤；
 *  3. 启动时清理超过保留期的旧日志（默认 30 天，`ZREAD_PI_LOG_RETENTION_DAYS` 可覆盖）；
 *  4. 写失败静默：日志绝不能反过来打断业务或污染终端。
 *
 * 级别：文件是**排障 sink**，默认记录全部级别（含 debug），
 * 不受 `ZREAD_PI_LOG_LEVEL`（只调 console exporter）影响。
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LoggerFormat } from './format.js';
import { Time } from './time.js';
import { LoggerLevel, type Exporter, type Message } from './types.js';
import { projectHomePath } from '../project-home.js';

/** 日志保留天数（默认 30 天）；`ZREAD_PI_LOG_RETENTION_DAYS` 可覆盖，<= 0 表示不清理。 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const LOG_RETENTION_DAYS_ENV = 'ZREAD_PI_LOG_RETENTION_DAYS';

/** 日志文件名前缀与目录名（目录路径统一走 projectHomePath）。 */
export const LOG_FILE_PREFIX = 'zread-pi-';
export const LOG_FILE_SUFFIX = '.log';
export const LOG_DIR_NAME = 'logs';

/** retention 只在进程内执行一次（首次写入日志时触发，不在 import 期做任何 I/O）。 */
let retentionSwept = false;

export interface FileExporterOptions {
  /** 单行最大长度（缺省 10240，与 cordis 一致） */
  maxLength?: number;
  /** 保留天数覆盖；不传时读环境变量，再不传用默认 30 天 */
  retentionDays?: number;
}

/** 取某一天（默认今天）的日志文件绝对路径。日期按本地时区，写入时刻计算。 */
export function getLogFilePath(date: Date = new Date()): string {
  return projectHomePath(LOG_DIR_NAME, `${LOG_FILE_PREFIX}${Time.template('yyyy-MM-dd', date)}${LOG_FILE_SUFFIX}`);
}

/** 清理超过保留期的旧日志；返回被删除的文件数（不清理则返回 0）。 */
export function sweepOldLogFiles(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const dir = projectHomePath(LOG_DIR_NAME);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // 目录不存在 / 不可读：没有可清理的
    return 0;
  }
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(LOG_FILE_PREFIX) || !entry.endsWith(LOG_FILE_SUFFIX)) continue;
    try {
      const stats = statSync(join(dir, entry));
      if (now - stats.mtimeMs > maxAgeMs) {
        unlinkSync(join(dir, entry));
        removed += 1;
      }
    } catch {
      // 单个文件删失败不影响其余
    }
  }
  return removed;
}

/** 文本文件日志 exporter：`[本地时间] [级别] 名字 消息`。 */
export class FileExporter implements Exporter {
  colors: number | false = false;
  /** 文件是排障 sink：默认记录全部级别（含 debug），不受 ZREAD_PI_LOG_LEVEL 影响 */
  levels: Record<string, number> = { default: LoggerLevel.DEBUG };
  maxLength: number;
  private readonly retentionDays: number;

  constructor(options: FileExporterOptions = {}) {
    this.maxLength = options.maxLength ?? 10240;
    this.retentionDays = options.retentionDays ?? readRetentionDaysFromEnv();
  }

  export(message: Message): void {
    if (!retentionSwept) {
      retentionSwept = true;
      // 首次写入时清理过期日志（此时 ZREAD_PI_HOME 等环境必定已就位）
      sweepOldLogFiles(this.retentionDays);
    }
    this.append(this.render(message));
  }

  /** 渲染单行（无色），末尾不含换行（由 append 补）。 */
  render(message: Message): string {
    const timestamp = Time.template('yyyy-MM-dd hh:mm:ss.SSS');
    const level = message.type.toUpperCase();
    const body = LoggerFormat.format(this, message);
    return `[${timestamp}] [${level}] ${message.name} ${body}`;
  }

  /** 追加一行到当天的日志文件；任何失败都静默。 */
  private append(line: string): void {
    try {
      const logPath = getLogFilePath(new Date());
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n', 'utf-8');
    } catch {
      // 日志写失败绝不影响业务，也不输出到终端
    }
  }
}

function readRetentionDaysFromEnv(): number {
  const raw = process.env[LOG_RETENTION_DAYS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOG_RETENTION_DAYS;
  return Math.trunc(parsed);
}
