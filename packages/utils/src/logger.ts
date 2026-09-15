/**
 * 兼容层 —— 旧的全局 `logger` 单例，内部路由到新的日志总线（见 `./logger/`）。
 *
 * 对齐 cordis 的日志体系后，本仓库从「全局单例拼字符串」升级为
 * 「结构化记录 + 多 exporter 总线 + 命名 logger」（决策见 AGENTS.md §1.1）。
 * 这里保留旧的导出形状，已有调用点零改动：
 *  - `logger.info / warn / error / debug / success / progress`
 *  - `getLogFile()`：今天的日志文件路径（按调用时刻计算日期）
 *
 * 语义要点：
 *  - 旧 logger 记为 `app`（总线的默认名），日志行内会带上这个名字；
 *  - 旧实现没有 printf 语义，这里用 `%s` 占位把消息**原样**交给总线，
 *    避免消息文本里恰好含 `%s` / `%d` 之类字符被 printf 误解析；
 *  - Error 首参交给总线走 stack 展开（harness 既有行为，排障信息更多）；
 *  - `success` / `progress` 的语义标记保留：消息里仍带 `[OK]` / `[PROGRESS]`。
 *
 * 新代码请改用 `createLogger('<子系统>')`（如 `orchestrator.pages`），
 * 以获得按模块的级别阈值与日志行内的模块名。
 */

import { getLogFilePath } from './logger/file-exporter.js';
import { createLogger } from './logger/service.js';
import type { Logger } from './logger/types.js';

let appLogger: Logger | undefined;

function app(): Logger {
  if (!appLogger) appLogger = createLogger('app');
  return appLogger;
}

/** 字符串消息用 `%s` 占位原样传递；其余值（含 Error / 对象）交给总线自行展开。 */
export const logger = {
  info(message: unknown): void {
    if (typeof message === 'string') app().info('%s', message);
    else app().info(message);
  },
  warn(message: unknown): void {
    if (typeof message === 'string') app().warn('%s', message);
    else app().warn(message);
  },
  error(message: unknown): void {
    if (typeof message === 'string') app().error('%s', message);
    else app().error(message);
  },
  debug(message: unknown): void {
    if (typeof message === 'string') app().debug('%s', message);
    else app().debug(message);
  },
  success(message: unknown): void {
    app().info('%s', `[OK] ${message}`);
  },
  progress(step: string, detail?: string): void {
    app().info('%s', detail ? `[PROGRESS] ${step} ${detail}` : `[PROGRESS] ${step}`);
  },
};

/** 今天的日志文件绝对路径（按调用时刻的本地日期计算）。 */
export function getLogFile(): string {
  return getLogFilePath();
}
