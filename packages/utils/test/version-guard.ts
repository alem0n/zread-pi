/**
 * 版本守卫单元测试。
 *
 * 运行：bun run packages/utils/test/version-guard.ts
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureVersionGuard,
  getVersionFilePath,
  isVersionCompatible,
  nextBackupPath,
  parseMajorVersion,
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

// ---------------------------------------------------------------------------
// 1) 版本号解析与兼容判定（纯函数）
// ---------------------------------------------------------------------------

console.log('▶ 版本号解析与兼容判定');

checkEqual('parseMajorVersion("1.12.2") = 1', parseMajorVersion('1.12.2'), 1);
checkEqual('parseMajorVersion("2.0.0") = 2', parseMajorVersion('2.0.0'), 2);
checkEqual('parseMajorVersion("0.0.0-dev") = 0', parseMajorVersion('0.0.0-dev'), 0);
checkEqual('parseMajorVersion("v3.1.0") = 3', parseMajorVersion('v3.1.0'), 3);
checkEqual('parseMajorVersion(带空白) = 1', parseMajorVersion('  1.5.0  '), 1);
checkEqual('parseMajorVersion(非法) = undefined', parseMajorVersion('abc'), undefined);
checkEqual('parseMajorVersion(空) = undefined', parseMajorVersion(''), undefined);

check('同主版本兼容（1.12.2 vs 1.13.0）', isVersionCompatible('1.12.2', '1.13.0'));
check('同版本兼容', isVersionCompatible('1.12.2', '1.12.2'));
check('跨主版本不兼容（1.x vs 2.0）', !isVersionCompatible('1.12.2', '2.0.0'));
check('旧版本不可解析时不兼容', !isVersionCompatible('garbage', '1.12.2'));
check('当前版本不可解析时不兼容', !isVersionCompatible('1.12.2', 'garbage'));

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

// 再跑一次：兼容，无变化（幂等）
const again = await ensureVersionGuard(home1, '1.13.5');
checkEqual('同主版本再跑 = compatible', again.status, 'compatible');
checkEqual('版本文件不被改写（仍是 1.13.0）', await readVersionFile(home1), '1.13.0');

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
// 6) ensureVersionGuard：跨主版本 → 备份
// ---------------------------------------------------------------------------

console.log('▶ 跨主版本不兼容');

const home3 = join(await tempDir('zread-vg-home3-'), '.zread-pi');
await mkdir(home3, { recursive: true });
await writeVersionFile(home3, '1.12.2');
await writeFile(join(home3, 'auth.json'), '{}', 'utf-8');

const crossed = await ensureVersionGuard(home3, '2.0.0');
checkEqual('结果 = incompatible', crossed.status, 'incompatible');
checkEqual('stored 读到旧版本', (crossed as { stored: string }).stored, '1.12.2');
const backup3 = (crossed as { backupPath: string }).backupPath;
checkEqual('备份名带 _bak', backup3, `${home3}${BACKUP_SUFFIX}`);
check('旧凭据保留在备份里', (await stat(join(backup3, 'auth.json'))).isFile());
checkEqual('新目录写入新版本', await readVersionFile(home3), '2.0.0');

// 再次不兼容升级：备份名追加序号
const crossed2 = await ensureVersionGuard(home3, '3.0.0');
checkEqual('第二次备份用 _bak-2', (crossed2 as { backupPath: string }).backupPath, `${home3}${BACKUP_SUFFIX}-2`);

// ---------------------------------------------------------------------------
// 7) 目标仓库目录（与家目录同逻辑，独立路径）
// ---------------------------------------------------------------------------

console.log('▶ 目标仓库数据目录');

const repo = join(await tempDir('zread-vg-repo-'), 'my-repo');
const repoDir = join(repo, '.zread-pi');
const repoResult = await ensureVersionGuard(repoDir, '1.13.0');
checkEqual('仓库目录首次 = created', repoResult.status, 'created');
checkEqual('版本文件在仓库目录内', await readVersionFile(repoDir), '1.13.0');

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
