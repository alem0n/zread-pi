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
 * 该目录被别的进程当作 cwd（当前工作目录）时，Windows 会拒绝整体重命名
 * （EPERM/EBUSY）。此时自动降级为「把目录内条目逐个迁入新备份目录」——
 * 迁移条目不需要重命名被占用的父目录，通常仍能完成等价的备份，结果带
 * `degraded: true` 标记。两种方式都失败时向上抛，由调用方告警（不静默）。
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
import { mkdir, readdir, rename, readFile } from 'node:fs/promises';
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

/**
 * 把源目录内的所有条目移动到目标目录（不重命名源目录本身）。
 *
 * 这是「目录被别的进程当作 cwd」时的降级路径：Windows 不允许重命名任何进程的
 * 当前工作目录，{@link rename} 会抛 EPERM/EBUSY。但把目录**内部的条目**逐个
 * move 出去不需要重命名被占用的父目录，因此可以绕过该限制，达到同等效果
 * （旧数据整体迁出、源目录被清空）。
 *
 * 返回未能迁移的条目（相对名）。全部成功时返回空数组。
 */
async function moveContents(source: string, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const failed: string[] = [];
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    try {
      await rename(from, to);
    } catch {
      // 单个条目迁移失败（可能被单独占用）：记录下来交给调用方决定，不丢数据
      failed.push(entry.name);
    }
  }
  return failed;
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
      /**
       * 是否以降级方式完成备份：目录被别的进程当作 cwd 时无法整体重命名，
       * 改为把内部条目逐个迁入新备份目录。语义等价（旧数据完整迁出、原目录清空），
       * 但调用方可据此给出不同的提示（建议关闭占用程序后重跑以获得干净结构）。
       */
      degraded?: boolean;
      /** 降级时未能迁出的条目（相对名）；非降级或全部成功时为 undefined */
      unresolvedEntries?: string[];
    };

/**
 * 对单个数据目录执行版本守卫。
 *
 * - 目录不存在 → 创建 + 写当前版本 → `created`（首次安装）
 * - 版本兼容 → `compatible`
 * - 不兼容（无版本文件 / 主版本不同）→ 备份 + 重建 + 写当前版本 → `incompatible`
 *
 * 备份优先走「整体重命名」（原子、干净）；当目录被别的进程当作 cwd 导致
 * `rename` 被拒绝时，自动降级为「逐条目迁出」，依然把旧数据完整移入备份目录。
 * 两种方式都失败时向上抛（调用方负责告警：保留旧数据不动比强行重建更安全）。
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

  // 3a) 首选：整体重命名（原子、干净，一步到位）
  try {
    await rename(dir, backupPath);
  } catch {
    // 3b) 降级：目录被别的进程当作 cwd（Windows 拒绝重命名任何进程的工作目录）
    //      或被以其他方式占用。改为把内部条目逐个迁入新的备份目录——
    //      迁移条目不需要重命名被占用的父目录，通常可以成功。
    const unresolved = await moveContents(dir, backupPath);
    // 原目录现已清空（或残留未能迁出的条目），写入当前版本标记。
    // 残留条目的数据仍在原目录内、且备份目录已持有其余数据，不丢数据。
    await writeVersionFile(dir, currentVersion);
    return {
      status: 'incompatible',
      dir,
      stored,
      backupPath,
      version: currentVersion,
      degraded: true,
      unresolvedEntries: unresolved.length > 0 ? unresolved : undefined,
    };
  }
  await mkdir(dir, { recursive: true });
  await writeVersionFile(dir, currentVersion);
  return { status: 'incompatible', dir, stored, backupPath, version: currentVersion };
}
