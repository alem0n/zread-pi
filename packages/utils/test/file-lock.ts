/**
 * file-lock.ts —— 跨进程文件锁专项回归
 *
 * 覆盖：
 *  1. `withFileLock` / `withFileLockSync` 的互斥（临界区不重叠、异常也释放）；
 *  2. 同一路径的第二个锁请求在重试耗尽后失败（ELOCKED），不会静默无锁执行；
 *  3. `saveConfig` 并发写：配置始终是可解析的完整 YAML（锁 + 原子替换）；
 *  4. **真实跨进程**：并发子进程同时 `rememberProject()`，记录不丢（修复前
 *     整文件写会互相覆盖）；
 *  5. 锁目录不影响原有的读写语义（history 追加/读取正常）。
 *
 * 运行：bun run packages/utils/test/file-lock.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const home = await mkdtemp(join(tmpdir(), 'zread-pi-lock-home-'));
process.env.ZREAD_PI_HOME = home;

const {
  DEFAULT_CONFIG,
  acquireFileLock,
  getConfigPath,
  getHistoryPath,
  loadConfig,
  readHistory,
  rememberProject,
  saveConfig,
  withFileLock,
  withFileLockSync,
} = await import('../src/index.js');

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1) 互斥与释放语义
// ---------------------------------------------------------------------------
const lockTarget = join(home, 'mutex.txt');
let active = 0;
let maxActive = 0;
const critical = async (value: string): Promise<string> =>
  withFileLock(lockTarget, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return value;
  });

const results = await Promise.all(['a', 'b', 'c', 'd'].map((value) => critical(value)));
check(
  'withFileLock 并发临界区不重叠（串行执行）',
  maxActive === 1 && results.join('') === 'abcd',
  `maxActive=${maxActive} results=${results.join('')}`,
);

let syncRan = false;
withFileLockSync(lockTarget, () => {
  syncRan = true;
});
check('withFileLockSync 正常执行并释放', syncRan === true);

let releasedOnThrow = true;
try {
  await withFileLock(lockTarget, async () => {
    throw new Error('boom');
  });
} catch {
  // 预期抛错
}
try {
  await withFileLock(lockTarget, async () => undefined);
} catch {
  releasedOnThrow = false;
}
check('withFileLock 异常时也会释放锁', releasedOnThrow);

// 2) 持有锁期间另一个请求会失败（重试耗尽），而不是静默无锁执行
const held = await acquireFileLock(lockTarget);
const secondAcquire = await acquireFileLock(lockTarget).then(
  () => null,
  (error: unknown) => (error as { code?: string }).code ?? String(error),
);
held();
check(
  '已持锁时第二次获取在重试耗尽后失败（ELOCKED）',
  secondAcquire === 'ELOCKED',
  String(secondAcquire),
);
check('释放后可以重新获取', await acquireFileLock(lockTarget).then(() => true, () => false));

// 3) saveConfig 并发写：始终得到可解析的完整配置
const config = structuredClone(DEFAULT_CONFIG);
config.concurrency.max_retries = 2;
await Promise.all([saveConfig(config), saveConfig(config), saveConfig(config)]);
const rawConfig = await readFile(getConfigPath(), 'utf-8');
const parsed = parse(rawConfig) as { concurrency?: { max_retries?: number } };
check(
  'saveConfig 并发写后 YAML 完整可解析',
  parsed?.concurrency?.max_retries === 2 && parsed?.language === 'en',
  JSON.stringify(parsed?.concurrency),
);
const loaded = await loadConfig();
check('loadConfig 能读回并发写入后的配置', loaded.concurrency.max_retries === 2);

// ---------------------------------------------------------------------------
// 4) 真实跨进程：并发子进程同时写全局记忆，记录不能丢
// ---------------------------------------------------------------------------
const childScript = join(home, 'child-remember.ts');
// 用 file:// URL，避免 Windows 盘符在 ESM 说明符里被当成协议；
// 子进程以源码方式 import 工具入口，ZREAD_PI_HOME 指向本次临时家目录。
const utilsEntry = pathToFileURL(join(import.meta.dir, '..', 'src', 'index.ts')).href;
await Bun.write(
  childScript,
  [
    `import { rememberProject } from ${JSON.stringify(utilsEntry)};`,
    'const target = process.argv[2];',
    'if (!target) throw new Error("missing target");',
    'await rememberProject(target);',
    '',
  ].join('\n'),
);

const paths = Array.from({ length: 6 }, (_, index) => join(home, `project-${index}`));
const children = paths.map((path) =>
  Bun.spawn(['bun', 'run', childScript, path], {
    env: { ...process.env, ZREAD_PI_HOME: home },
    stdout: 'ignore',
    stderr: 'pipe',
  }),
);
const exits = await Promise.all(children.map((child) => child.exited));
const stderrTexts = await Promise.all(
  children.map(async (child) => await new Response(child.stderr).text()),
);
check(
  '6 个并发子进程全部写入成功',
  exits.every((code) => code === 0),
  `exits=${exits.join(',')} stderr=${stderrTexts.join(' | ').slice(0, 200)}`,
);

const remembered = (await readHistory()).map((record) => record.path);
const missing = paths.filter((path) => !remembered.includes(path));
check(
  '并发写入的记录一条都不丢（锁生效）',
  missing.length === 0,
  `remembered=${remembered.length} missing=${missing.length}${missing.length > 0 ? ` (${missing.join(',')})` : ''}`,
);

// 锁文件落在项目家目录、不影响读取
const historyContent = await readFile(getHistoryPath()).catch(() => null);
check('history 文件仍可正常读取', historyContent !== null && historyContent.length > 12);

await rm(home, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
