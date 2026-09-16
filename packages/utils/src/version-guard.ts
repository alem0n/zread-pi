/**
 * 版本守卫：隔离不同大版本的数据目录。
 *
 * 两处目录各自维护一个 `version` 文件，记录「这份目录是由哪个版本创建的」：
 *  - 项目家目录 `~/.zread-pi/version`（config.yaml / auth.json / history / logs …）
 *  - 目标仓库输出目录 `<repo>/.zread-pi/version`（wiki 产物 / runs 轨迹 / cache …）
 *
 * 运行时（CLI 启动）对两处分别判定：
 *  - 目录不存在 → 首次安装：直接创建并写入当前版本；
 *  - 目录存在但没有 `version` 文件 → 无法确定来源版本，视为不兼容；
 *  - `version` 文件存在但主版本号与当前不一致 → 不兼容。
 *
 * 不兼容时的处理：把目录原样重命名为 `<dir>_bak`（已存在则追加 `-2` / `-3` …）
 * 作为备份，然后重建空目录并写入当前版本。**旧数据完整保留在备份目录里**，
 * 由用户自行决定如何迁移；界面上提示备份路径并建议尽快处理。
 *
 * 兼容判定口径 = **主版本号相同**（语义化版本的兼容性约定）。
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

/** 解析版本号的主版本号；无法解析返回 undefined */
export function parseMajorVersion(version: string): number | undefined {
  const match = /^v?(\d+)/.exec(version.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

/**
 * 兼容判定：主版本号相同即兼容。
 *
 * 任一版本号无法解析 → 不兼容（保守口径，见模块头）。
 */
export function isVersionCompatible(stored: string, current: string): boolean {
  const storedMajor = parseMajorVersion(stored);
  const currentMajor = parseMajorVersion(current);
  if (storedMajor === undefined || currentMajor === undefined) return false;
  return storedMajor === currentMajor;
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
 * 对单个数据目录执行版本守卫。
 *
 * - 目录不存在 → 创建 + 写当前版本 → `created`（首次安装）
 * - 版本兼容 → `compatible`
 * - 不兼容（无版本文件 / 主版本不同）→ 备份 + 重建 + 写当前版本 → `incompatible`
 *
 * 任何意外错误都向上抛（调用方负责不阻断启动：版本守卫失败时
 * 「保留旧数据不动」比「强行重建」更安全）。
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
  if (stored !== null && isVersionCompatible(stored, currentVersion)) {
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
  await rename(dir, backupPath);
  await mkdir(dir, { recursive: true });
  await writeVersionFile(dir, currentVersion);
  return { status: 'incompatible', dir, stored, backupPath, version: currentVersion };
}
