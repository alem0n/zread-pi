/**
 * 版本守卫：隔离不兼容版本的数据目录。
 *
 * 只守卫项目家目录 `~/.zread-pi`（config.yaml / auth.json / history / logs …），
 * 用一个 `version` 文件记录「这份目录是由哪个版本创建的」。
 *
 * **不是每个版本都互相不兼容**：数据格式只在个别版本发生不兼容变更。
 * 代码里用一个常量 `INCOMPATIBLE_BEFORE` 标记「最后一次不兼容变更发生的版本」，
 * 只要目录的来源版本 >= 该版本就视为兼容（含未来版本），兼容时**只更新 version
 * 标记**、不动数据；只有早于该版本的目录（以及根本没有 version 文件的更老目录）
 * 才走备份重建流程。以后再发生不兼容变更时，把该常量改成那个版本号即可。
 *
 * 不兼容时的处理：把目录原样重命名为 `<dir>_bak`（已存在则追加 `-2` / `-3` …）
 * 作为备份，然后重建空目录并写入当前版本。**旧数据完整保留在备份目录里**，
 * 由用户自行决定如何迁移；界面上提示备份路径并建议尽快处理。
 *
 * 备份失败（目录正被别的进程当作 cwd——Windows 拒绝重命名任何进程的工作目录；
 * 或被杀软 / 索引服务锁定）时**不降级、不静默**：直接抛错，由调用方提示用户
 * 「关闭占用程序后重试」并退出进程。守卫无法完成时停下来比勉强继续更安全，
 * 用户解决占用后重跑即可获得干净结构。
 *
 * 兼容判定口径 = **来源版本 >= INCOMPATIBLE_BEFORE**（版本号三段比较）。
 * 无法解析的版本字符串一律视为不兼容（保守：宁可备份，不可误读旧格式）。
 *
 * 并发：这是「进程启动一次」的逻辑，不使用跨进程文件锁（备份用的是目录整体重命名，
 * 锁文件只能放在目录内，而重命名会把锁文件一起搬走）。改为执行前重检 +
 * 原子写 + 失败不崩溃：极端情况下两个进程同时启动，至多多出一份备份目录，
 * 不会损坏数据。
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeTextFileAtomic } from './file-io.js';

/** 版本标记文件名（落在数据目录根部） */
export const VERSION_FILE_NAME = 'version';

/** 备份目录的后缀 */
export const BACKUP_SUFFIX = '_bak';

/**
 * 最后一次**不兼容**数据格式变更发生的版本。
 *
 * 兼容判定只看来源版本是否 >= 该值：早于它的目录（含没有 version 标记的更老目录）
 * 会被备份重建；它及之后的版本（含未来主版本）一律兼容，只在兼容时把 version
 * 标记更新为当前版本。**以后再发生不兼容变更时，把这个常量改成那个版本号。**
 */
export const INCOMPATIBLE_BEFORE = '1.13.0';

/** 解析版本号为三段数字 [major, minor, patch]；无法解析返回 undefined */
export function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return undefined;
  }
  return [major, minor, patch];
}

/**
 * 比较两个版本号：a < b → -1，相等 → 0，a > b → 1。
 * 无法解析的版本视为「最旧」（排在所有可解析版本之前），两个都无法解析视为相等。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return -1;
  if (pb === undefined) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * 兼容判定：来源版本 >= `INCOMPATIBLE_BEFORE` 即兼容（含未来版本）。
 *
 * 无法解析的版本一律视为不兼容（保守口径，见模块头）。
 */
export function isVersionCompatible(stored: string): boolean {
  return compareVersions(stored, INCOMPATIBLE_BEFORE) >= 0;
}

/** 版本标记文件路径 */
export function getVersionFilePath(dir: string): string {
  return join(dir, VERSION_FILE_NAME);
}

/** 读取版本标记；文件不存在 / 读取失败返回 null（调用方按「无版本文件」处理） */
export async function readVersionFile(dir: string): Promise<string | null> {
  try {
    const content = await readFile(getVersionFilePath(dir), 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** 写入版本标记（原子写：临时文件 + rename） */
export async function writeVersionFile(dir: string, version: string): Promise<void> {
  await writeTextFileAtomic(getVersionFilePath(dir), `${version}\n`);
}

/**
 * 计算备份目录名：`<dir>_bak`；已被占用则依次尝试 `<dir>_bak-2` / `-3` …
 *
 * 只做存在性检查，不创建目录（真正的重命名由调用方完成）。
 */
export function nextBackupPath(dir: string): string {
  const base = `${dir}${BACKUP_SUFFIX}`;
  if (!existsSync(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** 守卫结果 */
export type VersionGuardOutcome =
  | { status: 'created'; dir: string; version: string }
  | { status: 'compatible'; dir: string; stored: string }
  | {
      status: 'incompatible';
      dir: string;
      /** 旧版本标记（目录存在但无版本文件时为 null） */
      stored: string | null;
      /** 备份目录的绝对路径（旧数据完整保留于此） */
      backupPath: string;
      version: string;
    };

/**
 * 对家目录执行版本守卫。
 *
 * - 目录不存在 → 创建 + 写当前版本 → `created`（首次安装）
 * - 版本兼容（来源版本 >= `INCOMPATIBLE_BEFORE`）→ `compatible`，
 *   并把 version 标记更新为当前版本（**只更新标记，不动数据、不备份**）
 * - 不兼容（早于分界 / 无版本文件 / 无法解析）→ 备份（整体重命名）+ 重建
 *   + 写当前版本 → `incompatible`
 *
 * 备份失败（例如目录正被别的进程当作 cwd，Windows 拒绝重命名任何进程的工作目录，
 * 报 EPERM/EBUSY；或被杀软 / 索引服务锁定）时**直接向上抛错**：不做降级处理，
 * 由调用方提示用户「关闭占用程序后重试」并退出进程。理由：守卫无法完成时
 * 「保留旧数据不动并停下来」比「用别的方式勉强继续」更安全，用户解决占用后
 * 重跑即可获得干净的目录结构。
 */
export async function ensureVersionGuard(
  dir: string,
  currentVersion: string,
): Promise<VersionGuardOutcome> {
  // 1) 首次安装
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await writeVersionFile(dir, currentVersion);
    return { status: 'created', dir, version: currentVersion };
  }

  // 2) 已存在：读版本标记判定
  const stored = await readVersionFile(dir);
  if (stored !== null && isVersionCompatible(stored)) {
    // 兼容：只把标记更新为当前版本（旧补丁版本顺手刷新，数据不动）
    if (stored !== currentVersion) await writeVersionFile(dir, currentVersion);
    return { status: 'compatible', dir, stored };
  }

  // 3) 不兼容：备份 → 重建 → 写版本
  //    重检一次：并发启动时可能别的进程已经把目录搬走（此时 dir 已不存在，
  //    重新走「首次安装」路径即可，不要在已搬走的目录上再备份一次）。
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await writeVersionFile(dir, currentVersion);
    return { status: 'created', dir, version: currentVersion };
  }
  const backupPath = nextBackupPath(dir);
  // 整体重命名（原子、干净）：失败直接抛，由调用方提示并退出，不做降级
  await rename(dir, backupPath);
  await mkdir(dir, { recursive: true });
  await writeVersionFile(dir, currentVersion);
  return { status: 'incompatible', dir, stored, backupPath, version: currentVersion };
}
