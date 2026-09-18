/**
 * 版本守卫单元测试。
 *
 * 运行：bun run packages/utils/test/version-guard.ts
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ensureVersionGuard,
  getVersionFilePath,
  isVersionCompatible,
  nextBackupPath,
  parseVersion,
  compareVersions,
  INCOMPATIBLE_BEFORE,
  readVersionFile,
  writeVersionFile,
  BACKUP_SUFFIX,
} from '../src/version-guard.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function checkEqual<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * 启动一个子进程，把它的工作目录（cwd）设为 target 并保持运行，直到 release()。
 *
 * Windows 上任何进程的 cwd 都不能被重命名（rename 抛 EBUSY/EPERM）——这正是
 * 版本守卫「失败即提示并退出」要处理的场景。真实场景就是 node/bun 进程
 * chdir 到数据目录。
 */
function holdAsCwd(target: string): { release: () => Promise<void> } {
  const childCode = `
process.chdir(${JSON.stringify(target)});
setTimeout(() => process.exit(0), 20000);
`;
  const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
  return {
    release: async () => {
      try { child.kill(); } catch { /* 已退出 */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
}

// ---------------------------------------------------------------------------
// 1) 版本号解析与兼容判定（纯函数）
// ---------------------------------------------------------------------------

console.log('▶ 版本号解析与兼容判定');

checkEqual('parseVersion("1.12.2")', JSON.stringify(parseVersion('1.12.2')), JSON.stringify([1, 12, 2]));
checkEqual('parseVersion("v3.1.0")', JSON.stringify(parseVersion('v3.1.0')), JSON.stringify([3, 1, 0]));
checkEqual('parseVersion("1") 缺段补 0', JSON.stringify(parseVersion('1')), JSON.stringify([1, 0, 0]));
checkEqual('parseVersion(带空白)', JSON.stringify(parseVersion('  1.5.0  ')), JSON.stringify([1, 5, 0]));
checkEqual('parseVersion("0.0.0-dev")', JSON.stringify(parseVersion('0.0.0-dev')), JSON.stringify([0, 0, 0]));
checkEqual('parseVersion(非法) = undefined', parseVersion('abc'), undefined);
checkEqual('parseVersion(空) = undefined', parseVersion(''), undefined);

checkEqual('compareVersions(1.12.2, 1.13.0) = -1', compareVersions('1.12.2', '1.13.0'), -1);
checkEqual('compareVersions(1.13.0, 1.13.0) = 0', compareVersions('1.13.0', '1.13.0'), 0);
checkEqual('compareVersions(1.13.5, 1.13.0) = 1', compareVersions('1.13.5', '1.13.0'), 1);
checkEqual('compareVersions(2.0.0, 1.13.0) = 1（未来版本更新）', compareVersions('2.0.0', '1.13.0'), 1);
checkEqual('compareVersions(无法解析视为最旧) = -1', compareVersions('garbage', '1.13.0'), -1);

// 兼容判定：只有早于 INCOMPATIBLE_BEFORE 的版本才不兼容
console.log(`  （不兼容分界版本 = ${INCOMPATIBLE_BEFORE}）`);
check('分界版本本身兼容', isVersionCompatible(INCOMPATIBLE_BEFORE));
check('分界之后的版本兼容（1.13.5）', isVersionCompatible('1.13.5'));
check('未来的主版本也兼容（2.0.0）——数据格式未变不备份', isVersionCompatible('2.0.0'));
check('早于分界的版本不兼容（1.12.2）', !isVersionCompatible('1.12.2'));
check('无法解析的版本不兼容（保守）', !isVersionCompatible('garbage'));
check('空版本不兼容', !isVersionCompatible(''));

// ---------------------------------------------------------------------------
// 2) 版本标记文件读写
// ---------------------------------------------------------------------------

console.log('▶ 版本标记文件读写');

const scratch = await tempDir('zread-vg-scratch-');
await writeVersionFile(scratch, '1.12.2');
checkEqual('读回写入的版本', await readVersionFile(scratch), '1.12.2');
check('文件以换行结尾（友好可读）', (await readFile(getVersionFilePath(scratch), 'utf-8')).endsWith('\n'));
checkEqual('不存在时读回 null', await readVersionFile(join(scratch, 'missing')), null);

// 空文件视为无版本
await writeFile(getVersionFilePath(scratch), '   \n', 'utf-8');
checkEqual('空白文件读回 null', await readVersionFile(scratch), null);

// ---------------------------------------------------------------------------
// 3) 备份路径
// ---------------------------------------------------------------------------

console.log('▶ 备份路径命名');

const nest = await tempDir('zread-vg-nest-');
const target = join(nest, 'data');
await mkdir(target, { recursive: true });
checkEqual('首次备份名 = <dir>_bak', nextBackupPath(target), `${target}${BACKUP_SUFFIX}`);

await mkdir(`${target}${BACKUP_SUFFIX}`, { recursive: true });
checkEqual('已占用时用 <dir>_bak-2', nextBackupPath(target), `${target}${BACKUP_SUFFIX}-2`);

await mkdir(`${target}${BACKUP_SUFFIX}-2`, { recursive: true });
checkEqual('再占用用 <dir>_bak-3', nextBackupPath(target), `${target}${BACKUP_SUFFIX}-3`);

// ---------------------------------------------------------------------------
// 4) ensureVersionGuard：首次安装
// ---------------------------------------------------------------------------

console.log('▶ 首次安装（目录不存在）');

const home1 = join(await tempDir('zread-vg-home1-'), '.zread-pi');
const first = await ensureVersionGuard(home1, '1.13.0');
checkEqual('结果 = created', first.status, 'created');
checkEqual('版本文件 = 当前版本', await readVersionFile(home1), '1.13.0');
check('目录存在', (await stat(home1)).isDirectory());

// 再跑一次：兼容 → 只更新版本标记（不备份、不重建）
const again = await ensureVersionGuard(home1, '1.13.5');
checkEqual('兼容版本再跑 = compatible', again.status, 'compatible');
checkEqual('兼容时版本标记更新为当前版本', await readVersionFile(home1), '1.13.5');
check('未生成备份目录', !(await stat(`${home1}${BACKUP_SUFFIX}`).catch(() => null)));

// ---------------------------------------------------------------------------
// 5) ensureVersionGuard：目录存在但无版本文件 → 不兼容 → 备份
// ---------------------------------------------------------------------------

console.log('▶ 目录存在但无版本文件');

const home2 = join(await tempDir('zread-vg-home2-'), '.zread-pi');
await mkdir(join(home2, 'wiki', 'high'), { recursive: true });
await writeFile(join(home2, 'config.yaml'), 'language: zh\n', 'utf-8');
await mkdir(join(home2, 'wiki', 'high'), { recursive: true }); // 旧产物

const legacy = await ensureVersionGuard(home2, '1.13.0');
checkEqual('结果 = incompatible', legacy.status, 'incompatible');
checkEqual('stored = null（无版本文件）', (legacy as { stored: string | null }).stored, null);
const backup2 = (legacy as { backupPath: string }).backupPath;
check('备份目录被创建', (await stat(backup2)).isDirectory());
check('旧数据完整保留在备份里', (await stat(join(backup2, 'config.yaml'))).isFile());
check('旧产物目录也在备份里', (await stat(join(backup2, 'wiki', 'high'))).isDirectory());
checkEqual('新目录已重建并写入当前版本', await readVersionFile(home2), '1.13.0');
check('新目录是空的（旧数据没留在原位）', (await readFile(join(home2, 'version'), 'utf-8')).trim() === '1.13.0');

// ---------------------------------------------------------------------------
// 6) ensureVersionGuard：早于不兼容分界的版本 → 备份；分界之后 → 只更新标记
// ---------------------------------------------------------------------------

console.log('▶ 不兼容分界附近的处理');

// 6a) 早于分界的旧版本（1.12.2 < INCOMPATIBLE_BEFORE）→ 备份重建
const home3 = join(await tempDir('zread-vg-home3-'), '.zread-pi');
await mkdir(home3, { recursive: true });
await writeVersionFile(home3, '1.12.2');
await writeFile(join(home3, 'auth.json'), '{}', 'utf-8');

const crossed = await ensureVersionGuard(home3, '2.0.0');
checkEqual('早于分界 = incompatible', crossed.status, 'incompatible');
checkEqual('stored 读到旧版本', (crossed as { stored: string }).stored, '1.12.2');
const backup3 = (crossed as { backupPath: string }).backupPath;
checkEqual('备份名带 _bak', backup3, `${home3}${BACKUP_SUFFIX}`);
check('旧凭据保留在备份里', (await stat(join(backup3, 'auth.json'))).isFile());
checkEqual('新目录写入新版本', await readVersionFile(home3), '2.0.0');

// 再次遇到早于分界的旧版本：备份名追加序号
await writeVersionFile(home3, '1.12.2');
const crossed2 = await ensureVersionGuard(home3, '2.0.0');
checkEqual('第二次备份用 _bak-2', (crossed2 as { backupPath: string }).backupPath, `${home3}${BACKUP_SUFFIX}-2`);

// 6b) 分界之后的版本（含未来主版本）→ 兼容，只更新标记，绝不备份
const home3b = join(await tempDir('zread-vg-home3b-'), '.zread-pi');
await mkdir(home3b, { recursive: true });
await writeVersionFile(home3b, INCOMPATIBLE_BEFORE);
await writeFile(join(home3b, 'config.yaml'), 'language: zh\n', 'utf-8');

const future = await ensureVersionGuard(home3b, '2.0.0');
checkEqual('分界之后的版本升级 = compatible', future.status, 'compatible');
checkEqual('版本标记更新为新版本', await readVersionFile(home3b), '2.0.0');
check('数据目录未被备份（config.yaml 仍在原位）', (await stat(join(home3b, 'config.yaml'))).isFile());
check('未生成备份目录', !(await stat(`${home3b}${BACKUP_SUFFIX}`).catch(() => null)));

// ---------------------------------------------------------------------------
// 8) 目录被别的进程当作 cwd：备份失败 → 直接抛错，旧数据不动
// ---------------------------------------------------------------------------

console.log('▶ 目录被占用时备份失败抛错（cwd 锁）');

const home4 = join(await tempDir('zread-vg-home4-'), '.zread-pi');
await mkdir(join(home4, 'wiki', 'high'), { recursive: true });
await writeFile(join(home4, 'config.yaml'), 'language: zh\n', 'utf-8');
await writeFile(join(home4, 'wiki', 'high', 'wiki.json'), '{}', 'utf-8');

// 子进程把 cwd 设为家目录 → Windows 拒绝整体重命名 → ensureVersionGuard 应抛错
const holder = holdAsCwd(home4);
await new Promise((resolve) => setTimeout(resolve, 800));

let threw: Error | undefined;
try {
  await ensureVersionGuard(home4, '1.13.0');
} catch (error) {
  threw = error as Error;
}
check('占用时 ensureVersionGuard 抛错', threw !== undefined, threw?.message);
check('未生成备份目录（不降级）', !(await stat(`${home4}${BACKUP_SUFFIX}`).catch(() => null)));
check('旧数据保持原位（config.yaml 未动）', (await stat(join(home4, 'config.yaml'))).isFile());
check('未写入 version 文件', (await readVersionFile(home4)) === null);

await holder.release();

// 释放占用后重跑：应成功完成备份（用户解决问题后重试的路径）
const afterRelease = await ensureVersionGuard(home4, '1.13.0');
checkEqual('释放占用后重跑 = incompatible', afterRelease.status, 'incompatible');
checkEqual('重跑后写入当前版本', await readVersionFile(home4), '1.13.0');
check('旧数据进备份', (await stat(join(`${home4}${BACKUP_SUFFIX}`, 'config.yaml'))).isFile());

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
