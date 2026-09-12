/**
 * history-store.ts —— 全局记忆专项回归
 *
 * 覆盖：
 *  - ZRH1 二进制结构：头部字段、追加、顺序遍历、偏移稳定、墓碑随机删除、重开持久化
 *  - 去重（同路径移到末尾）、maxRecords 淘汰、手动/自动压缩
 *  - 健壮性：尾部半截记录截断修复、magic 损坏时备份重建
 *  - 项目家目录唯一定义点：ZREAD_PI_HOME 覆盖、getHistoryPath()
 *  - pruneHistory：并发检查 `<项目>/.zread-pi` 是否存在、删除失效记录、保留有效记录
 *  - mapWithConcurrency：固定并发且结果保序
 *
 * 全程离线、不碰真实 ~/.zread-pi（用 ZREAD_PI_HOME 指向临时目录）。
 *
 * 运行：bun run test:history
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  HISTORY_HEADER_SIZE,
  HISTORY_MAGIC,
  HISTORY_MAX_PATH_BYTES,
  HISTORY_RECORD_OVERHEAD,
  HISTORY_TAG_LIVE,
  HISTORY_VERSION,
  HistoryFormatError,
  HistoryLog,
} from '../src/history/binary-log.js';
import {
  clearHistory,
  ensureProjectRecorded,
  forgetProject,
  getHistoryPath,
  getProjectHome,
  mapWithConcurrency,
  pruneHistory,
  readHistory,
  rememberProject,
} from '../src/index.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

const home = await mkdtemp(join(tmpdir(), 'zread-history-home-'));
process.env.ZREAD_PI_HOME = home;

// ---------------------------------------------------------------------------
// 1) 二进制结构：头部 / 追加 / 遍历 / 墓碑删除 / 去重 / 持久化
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'zread-history-log-'));
  const file = join(dir, 'history');

  const log = await HistoryLog.open(file);
  check('打开不存在的文件：空清单', log.entries().length === 0 && log.stats().live === 0);

  const alpha = '/code/alpha';
  const beta = '/home/me/beta';
  const chinese = '/home/me/项目-中文';
  const a = await log.append(alpha);
  const b = await log.append(beta);
  const c = await log.append(chinese);

  check('追加三条记录', log.stats().live === 3);
  check('同一实例格式版本未变', HISTORY_VERSION === 1);
  check(
    '顺序遍历保持追加顺序',
    JSON.stringify(log.entries().map((entry) => entry.path)) ===
      JSON.stringify([alpha, beta, chinese]),
  );
  check(
    '偏移从头部之后开始且严格递增',
    a.offset === HISTORY_HEADER_SIZE && b.offset > a.offset && c.offset > b.offset,
  );

  const raw = await readFile(file);
  check('文件头 magic = ZRH1', raw.toString('ascii', 0, 4) === HISTORY_MAGIC);
  check('文件头 version = 1', raw.readUInt16LE(4) === HISTORY_VERSION);
  check('文件头 headerSize = 16', raw.readUInt32LE(8) === HISTORY_HEADER_SIZE);
  check(
    '记录 tag / length 字段可解析',
    raw[a.offset] === HISTORY_TAG_LIVE &&
      raw.readUInt32LE(a.offset + 1) === Buffer.byteLength(alpha, 'utf8'),
  );

  // 随机删除（按偏移）
  const sizeBefore = (await stat(file)).size;
  check('按偏移随机删除返回 true', await log.remove(b));
  check(
    '删除后遍历跳过墓碑',
    JSON.stringify(log.entries().map((entry) => entry.path)) ===
      JSON.stringify([alpha, chinese]),
  );
  check('墓碑计数 +1', log.stats().deleted === 1);
  check('删除只写 1 个 tag 字节（文件大小不变）', (await stat(file)).size === sizeBefore);
  check('墓碑 tag 已写回文件', (await readFile(file))[b.offset] === 0x00);
  check('删除不存在的记录返回 false', (await log.remove('/nope')) === false);

  // 重复追加 → 去重并移到末尾
  await log.append(alpha);
  check(
    '重复追加只保留一条',
    log.entries().filter((entry) => entry.path === alpha).length === 1,
  );
  check('重复追加把它移到末尾（最近使用）', log.entries().at(-1)?.path === alpha);
  check('去重后存活记录数不变', log.stats().live === 2);

  // 重开持久化
  const reopened = await HistoryLog.open(file);
  check(
    '重新打开后记录与顺序一致',
    JSON.stringify(reopened.entries().map((entry) => entry.path)) ===
      JSON.stringify([chinese, alpha]),
  );

  // 压缩
  const beforeCompact = (await stat(file)).size;
  const stats = await reopened.compact();
  const afterCompact = (await stat(file)).size;
  check('压缩后无墓碑', stats.deleted === 0 && stats.live === 2);
  check('压缩后文件变小', afterCompact < beforeCompact);
  check(
    '压缩保留全部有效记录与顺序',
    JSON.stringify(reopened.entries().map((entry) => entry.path)) ===
      JSON.stringify([chinese, alpha]),
  );

  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2) maxRecords 淘汰 与 自动压缩
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'zread-history-limit-'));
  const limited = await HistoryLog.open(join(dir, 'limited'), {
    maxRecords: 3,
    autoCompact: false,
  });
  for (let index = 1; index <= 5; index += 1) {
    await limited.append(`/p/${index}`);
  }
  check(
    'maxRecords 淘汰最旧记录',
    JSON.stringify(limited.entries().map((entry) => entry.path)) ===
      JSON.stringify(['/p/3', '/p/4', '/p/5']),
  );

  const autoFile = join(dir, 'auto');
  const auto = await HistoryLog.open(autoFile);
  for (let index = 0; index < 20; index += 1) {
    await auto.append(`/q/${index}`);
  }

  // 删到第 16 条时命中自动压缩阈值（墓碑数 ≥ 16 且墓碑字节 ≥ 存活字节）
  const snapshot = auto.entries();
  for (const entry of snapshot.slice(0, 16)) {
    await auto.remove(entry);
  }
  check(
    '自动压缩：达到阈值后墓碑被回收',
    auto.stats().deleted === 0 && auto.stats().live === 4,
    JSON.stringify(auto.stats()),
  );
  check(
    '自动压缩：文件缩回只剩 4 条有效记录',
    (await stat(autoFile)).size < HISTORY_HEADER_SIZE + 4 * (HISTORY_RECORD_OVERHEAD + 5) + 4,
    `size=${(await stat(autoFile)).size}`,
  );

  for (const entry of auto.entries()) {
    await auto.remove(entry);
  }
  check('全部删除后存活为 0', auto.stats().live === 0);
  await auto.compact();
  check(
    '手动压缩清空后文件只剩头部',
    (await stat(autoFile)).size === HISTORY_HEADER_SIZE,
    `size=${(await stat(autoFile)).size}`,
  );
  check('压缩后可继续追加', (await auto.append('/q/again')).path === '/q/again');

  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3) 健壮性：半截尾部记录 / 损坏文件 / 非法内容
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'zread-history-repair-'));
  const file = join(dir, 'history');

  const log = await HistoryLog.open(file);
  await log.append('/keep/one');
  await log.append('/broken/two');
  const full = await readFile(file);
  const truncated = full.subarray(0, full.length - 3);
  await writeFile(file, truncated);

  let refused = false;
  try {
    await HistoryLog.open(file, { repairTail: false });
  } catch (error) {
    refused = error instanceof HistoryFormatError;
  }
  check('repairTail=false 时拒绝打开半截记录', refused);

  const repaired = await HistoryLog.open(file);
  check(
    '尾部半截记录：只截断坏尾巴，保留之前有效记录',
    JSON.stringify(repaired.entries().map((entry) => entry.path)) === JSON.stringify(['/keep/one']),
  );
  check(
    '尾部半截记录：文件被截断修复',
    (await stat(file)).size ===
      HISTORY_HEADER_SIZE + HISTORY_RECORD_OVERHEAD + Buffer.byteLength('/keep/one'),
  );
  await repaired.append('/after/repair');
  check(
    '修复后继续追加成功',
    (await HistoryLog.open(file)).entries().at(-1)?.path === '/after/repair',
  );

  const magicFile = join(dir, 'magic');
  await writeFile(magicFile, 'XXXXXXXXXXXXZZZZ');
  let magicThrew = false;
  try {
    await HistoryLog.open(magicFile);
  } catch (error) {
    magicThrew = error instanceof HistoryFormatError;
  }
  check('magic 不匹配时抛 HistoryFormatError', magicThrew);

  const badContent = await HistoryLog.open(join(dir, 'content'));
  let emptyThrew = false;
  let nulThrew = false;
  let longThrew = false;
  try {
    await badContent.append('');
  } catch (error) {
    emptyThrew = error instanceof TypeError;
  }
  try {
    await badContent.append('/a\0b');
  } catch (error) {
    nulThrew = error instanceof TypeError;
  }
  try {
    await badContent.append(`/${'a'.repeat(HISTORY_MAX_PATH_BYTES)}`);
  } catch (error) {
    longThrew = error instanceof RangeError;
  }
  check('拒绝空记录', emptyThrew);
  check('拒绝含 NUL 的记录', nulThrew);
  check('拒绝超长记录', longThrew);

  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4) 项目家目录唯一定义点 + 损坏自愈
// ---------------------------------------------------------------------------

{
  check('getProjectHome() 使用 ZREAD_PI_HOME 覆盖', getProjectHome() === home);
  check('getHistoryPath() = <项目家目录>/history', getHistoryPath() === join(home, 'history'));

  await writeFile(getHistoryPath(), 'this is not a ZRH1 file');
  const record = await rememberProject('/project/after-corrupt');
  check('损坏的 history 可自愈并继续写入', record.path === resolve('/project/after-corrupt'));

  const entries = await readdir(dirname(getHistoryPath()));
  check(
    '损坏文件已备份（history.corrupt-*）',
    entries.some((name) => name.startsWith('history.corrupt-')),
  );
  const recovered = await readHistory();
  check('自愈后只有新写的一条记录', recovered.length === 1 && recovered[0].path === record.path);
  await clearHistory();
}

// ---------------------------------------------------------------------------
// 5) pruneHistory：并发检查 <项目>/.zread-pi 并删除失效记录
// ---------------------------------------------------------------------------

{
  const projects = join(home, 'projects');
  const alive = join(projects, 'alive');
  const aliveSecond = join(projects, 'alive-second');
  const deadMissing = join(projects, 'dead-missing');
  const deadFile = join(projects, 'dead-file');

  await mkdir(join(alive, '.zread-pi', 'wiki'), { recursive: true });
  await mkdir(join(aliveSecond, '.zread-pi'), { recursive: true });
  await mkdir(deadFile, { recursive: true });
  await writeFile(join(deadFile, '.zread-pi'), 'not a directory');

  await rememberProject(alive);
  await rememberProject(aliveSecond);
  await rememberProject(deadMissing);
  await rememberProject(deadFile);
  await rememberProject(alive); // 重复 → 去重并移到末尾

  const beforePrune = await readHistory();
  check('去重后共 4 条记录', beforePrune.length === 4);
  check(
    '重复 remember 只保留一条且移到末尾',
    beforePrune.at(-1)?.path === resolve(alive) &&
      beforePrune.filter((item) => item.path === resolve(alive)).length === 1,
  );

  const result = await pruneHistory({ concurrency: 3 });
  check('pruneHistory 扫描全部记录', result.scanned === 4);
  check(
    'pruneHistory 删除目录不存在 / .zread-pi 不是目录的记录',
    JSON.stringify(result.removed.slice().sort()) ===
      JSON.stringify([resolve(deadMissing), resolve(deadFile)].sort()),
  );
  check(
    'pruneHistory 保留 .zread-pi 目录存在的记录（顺序稳定）',
    JSON.stringify(result.remaining.map((item) => item.path)) ===
      JSON.stringify([resolve(aliveSecond), resolve(alive)]),
  );

  const persisted = await readHistory();
  check(
    '清理结果已持久化到二进制文件',
    JSON.stringify(persisted.map((item) => item.path)) ===
      JSON.stringify([resolve(aliveSecond), resolve(alive)]),
  );

  check('forgetProject 删除指定记录', await forgetProject(aliveSecond));
  check('forgetProject 二次删除返回 false', !(await forgetProject(aliveSecond)));
  const left = await readHistory();
  check('只剩一条记录', left.length === 1 && left[0].path === resolve(alive));

  await clearHistory();
  check('clearHistory 清空记忆', (await readHistory()).length === 0);
}

// ---------------------------------------------------------------------------
// 5b) ensureProjectRecorded：老旧项目自动登记（仅缺录，不改顺序）
// ---------------------------------------------------------------------------

{
  const oldFirst = join(home, 'projects', 'old-first');
  const oldSecond = join(home, 'projects', 'old-second');

  check('ensureProjectRecorded：不存在时新增', await ensureProjectRecorded(oldFirst));
  check(
    'ensureProjectRecorded：新增后可读到',
    (await readHistory()).some((item) => item.path === resolve(oldFirst)),
  );
  check('ensureProjectRecorded：已存在时返回 false', !(await ensureProjectRecorded(oldFirst)));
  check('ensureProjectRecorded：已存在时数量不变', (await readHistory()).length === 1);

  await rememberProject(oldSecond);
  await rememberProject(oldFirst); // rememberProject 会把它移到末尾 → [oldSecond, oldFirst]
  check('ensureProjectRecorded：已存在时不刷新位置', !(await ensureProjectRecorded(oldFirst)));
  check(
    'ensureProjectRecorded：已存在时顺序保持不变',
    JSON.stringify((await readHistory()).map((item) => item.path)) ===
      JSON.stringify([resolve(oldSecond), resolve(oldFirst)]),
  );

  await clearHistory();
}

// ---------------------------------------------------------------------------
// 6) mapWithConcurrency：并发上限 + 结果保序
// ---------------------------------------------------------------------------

{
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    active -= 1;
    return item * 2;
  });
  check(
    'mapWithConcurrency 结果与输入顺序一致',
    JSON.stringify(results) === JSON.stringify([2, 4, 6, 8, 10, 12, 14]),
  );
  check('mapWithConcurrency 并发度不超过上限', peak <= 3);
  check('mapWithConcurrency 实际并行执行', peak >= 2);
  check('mapWithConcurrency 空输入安全', (await mapWithConcurrency([], 4, async () => 1)).length === 0);
}

// ---------------------------------------------------------------------------
// 清理 + 汇总
// ---------------------------------------------------------------------------

await rm(home, { recursive: true, force: true });

let passed = 0;
let failed = 0;
for (const item of checks) {
  if (item.ok) {
    passed += 1;
    console.log(`  OK  ${item.name}`);
  } else {
    failed += 1;
    console.error(` FAIL ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
}
console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
