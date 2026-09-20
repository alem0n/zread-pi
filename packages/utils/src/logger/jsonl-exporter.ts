/**
 * JSONL exporter —— 结构化 sink，与文本 FileExporter 并存。
 *
 * harness 没有文件 sink（logger-console 只管终端）；本 exporter 是 zread-pi 侧
 * 为「机器可读日志分析」新增的能力（与 file-exporter 同一偏差族）：
 * 每行一条 JSON，字段直接取自结构化 Message，可被 jq / 脚本按 name/level/ts 过滤。
 *
 * - 落 `~/.zread-pi/logs/zread-pi-<yyyy-MM-dd>.jsonl`（与文本文件同目录同日期口径）；
 * - **默认开启**：`ZREAD_PI_LOG_JSONL=0`（或 `false`/`no`）显式关闭，
 *   避免不想维护双文件的用户被动写两份；
 * - 保留期清理与文本文件共用 `sweepOldLogFiles`（两种后缀都扫）；
 * - 写失败静默：日志绝不能反过来打断业务或污染终端。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LoggerFormat } from './format.js';
import { Time } from './time.js';
import { LoggerLevel, type Exporter, type Message } from './types.js';
import {
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_DIR_NAME,
  LOG_FILE_PREFIX,
  LOG_JSONL_SUFFIX,
  LOG_RETENTION_DAYS_ENV,
  getLogFilePath,
  sweepOldLogFiles,
} from './file-exporter.js';
import { projectHomePath } from '../project-home.js';

/** JSONL 开关环境变量。 */
export const LOG_JSONL_ENV = 'ZREAD_PI_LOG_JSONL';

/** JSONL 单行最大字符数（与文本 sink 的 maxLength 缺省一致）。 */
export const DEFAULT_JSONL_MAX_LENGTH = 10240;

/** 是否由环境变量开启 JSONL sink（默认开启；`0`/`false`/`no` 显式关闭）。 */
export function isJsonlEnabled(): boolean {
  const raw = process.env[LOG_JSONL_ENV];
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

/** 取某一天（默认今天）的 JSONL 日志文件绝对路径（日期按本地时区，写入时刻计算）。 */
export function getJsonlLogFilePath(date: Date = new Date()): string {
  return projectHomePath(LOG_DIR_NAME, `${LOG_FILE_PREFIX}${Time.template('yyyy-MM-dd', date)}${LOG_JSONL_SUFFIX}`);
}

export interface JsonlExporterOptions {
  /** 单行最大字符数（含消息体），超过截断并补 `...`（缺省 10240） */
  maxLength?: number;
  /** 保留天数覆盖；不传时读 `ZREAD_PI_LOG_RETENTION_DAYS`，再不传默认 30 天（<= 0 不清理） */
  retentionDays?: number;
}

/** JSONL 渲染上下文：只借 LoggerFormat 的 printf 语义，不参与广播。 */
const JSONL_FORMAT_CONTEXT = { export: () => {}, maxLength: Number.MAX_SAFE_INTEGER };

/** 把一条 Message 压成 JSONL 行对象（msg 走 printf 渲染，与文本 sink 同语义）。 */
function toRecord(message: Message, maxLength: number): Record<string, unknown> {
  let msg: string;
  try {
    msg = LoggerFormat.format(JSONL_FORMAT_CONTEXT, message);
  } catch {
    msg = '[unserializable args]';
  }
  if (msg.length > maxLength) msg = msg.slice(0, maxLength) + '...';
  return {
    sn: message.sn,
    ts: message.ts,
    time: Time.template('yyyy-MM-dd hh:mm:ss.SSS', new Date(message.ts)),
    name: message.name,
    type: message.type,
    level: message.level,
    msg,
  };
}

/** 结构化 JSONL 文件 exporter。 */
export class JsonlExporter implements Exporter {
  colors: number | false = false;
  /** 文件是排障 sink：默认记录全部级别（与文本 FileExporter 同口径） */
  levels: Record<string, number> = { default: LoggerLevel.DEBUG };
  maxLength: number;
  private readonly retentionDays: number;

  constructor(options: JsonlExporterOptions = {}) {
    this.maxLength = options.maxLength ?? DEFAULT_JSONL_MAX_LENGTH;
    this.retentionDays = options.retentionDays ?? readRetentionDaysFromEnv();
  }

  export(message: Message): void {
    // 保留期清理与文本 sink 共用 sweep（两种后缀都扫）；每进程只跑一次
    sweepOnce(this.retentionDays);
    this.append(message);
  }

  /** 序列化并追加一行；任何失败都静默。 */
  private append(message: Message): void {
    try {
      const record = toRecord(message, this.maxLength);
      const line = JSON.stringify(record);
      const logPath = getJsonlLogFilePath(new Date());
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n', 'utf-8');
    } catch {
      // 序列化或写失败绝不影响业务，也不输出到终端
    }
  }
}

function readRetentionDaysFromEnv(): number {
  const raw = process.env[LOG_RETENTION_DAYS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  // 与文本 sink 一致：负数合法（<= 0 表示禁用清理），只拒绝非数字
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_RETENTION_DAYS;
  return Math.trunc(parsed);
}

/** JSONL 侧的保留期清理只跑一次（与文本 exporter 各自独立计数，互不影响）。 */
let jsonlSwept = false;
function sweepOnce(retentionDays: number): void {
  if (jsonlSwept) return;
  jsonlSwept = true;
  sweepOldLogFiles(retentionDays);
}
