/**
 * 项目家目录（`~/.zread-pi`）的唯一定义点。
 *
 * 全仓库所有访问「项目家目录」的代码（config.yaml / auth.json / models-store.json /
 * logs / parsers / bin / 全局记忆 history）都必须经由本模块取路径；
 * 修改家目录的目录名或位置时只改这里。
 *
 * 与「目标仓库内的 `.zread-pi` 输出目录」区分：后者是每个被分析仓库自己的产物目录
 * （由 `file-io.ts` 的 `getOutputDir()` 以 `process.cwd()` 为根计算），两者恰好同名，
 * 因此目录名字符串同样只在本模块定义一次。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * zread-pi 目录名。
 *
 * 项目家目录的目录名（`~/.zread-pi`）与仓库内输出目录名（`<repo>/.zread-pi`）
 * 共用这一个常量，避免同一字符串散落在多处。
 */
export const ZREAD_PI_DIR_NAME = '.zread-pi';

/**
 * 覆盖项目家目录的环境变量。
 *
 * 未设置时回退 `os.homedir()/<ZREAD_PI_DIR_NAME>`；设置后按当前目录解析相对路径。
 * 用途：测试隔离（绝不写真实家目录）、同一台机器上多套配置共存。
 */
export const ZREAD_PI_HOME_ENV = 'ZREAD_PI_HOME';

/**
 * 项目家目录的绝对路径。
 *
 * 延迟计算（不缓存求值结果），因此测试可以在进程内切换 HOME / USERPROFILE / ZREAD_PI_HOME。
 */
export function getProjectHome(): string {
  const override = process.env[ZREAD_PI_HOME_ENV];
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(homedir(), ZREAD_PI_DIR_NAME);
}

/** 拼接项目家目录下的路径：`projectHomePath('logs')` → `~/.zread-pi/logs`。 */
export function projectHomePath(...segments: string[]): string {
  return join(getProjectHome(), ...segments);
}
