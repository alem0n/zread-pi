/**
 * listRuns 排序回归：同一秒内创建的多个 run 必须按真实创建顺序排列。
 *
 * 历史 bug：runId 只有秒级精度（`<日期>T<时-分-秒>-<随机后缀>`），
 * 而 listRuns 曾按 runId 字符串排序 —— 同一秒内的 run 顺序由随机后缀决定，
 * 与创建顺序无关。表现：e2e-blueprint 场景 8 间歇失败（更早创建的失败 run
 * 排到 runs[0]，被当成「最新 run」断言）。
 *
 * 运行：bun run packages/utils/test/run-dir-order.ts
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogWriter, listRuns, type RunEvent } from '../src/index.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const repo = await mkdtemp(join(tmpdir(), 'zread-pi-order-'));
await mkdir(join(repo, '.zread-pi'), { recursive: true });

const STATUS_EVENT: RunEvent = { kind: 'status', seq: 0, ts: 0, text: 'note' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 创建一个 run（毫秒级 startedAt 由 RunLogWriter 写入） */
async function makeRun(status: 'completed' | 'failed'): Promise<string> {
  const writer = await RunLogWriter.create(repo, { kind: 'generate' });
  writer.append(STATUS_EVENT);
  await writer.end(status);
  return writer.runId;
}

// ---------------------------------------------------------------------------
// 1) 同一秒内连续创建 4 个 run（第 2 个失败），顺序必须保持
// ---------------------------------------------------------------------------

console.log('▶ 同一秒内创建的 run 按真实开始时间排序');

const ids: string[] = [];
ids.push(await makeRun('completed')); // 最早
await sleep(2);
ids.push(await makeRun('failed')); // ← 更早的失败 run（历史 bug 会把它排到最前）
await sleep(2);
ids.push(await makeRun('completed'));
await sleep(2);
ids.push(await makeRun('completed')); // 最新

const runs = await listRuns(repo);
check('run 数 = 4', runs.length === 4, `runs=${runs.length}`);

const orderedIds = runs.map((run) => run.id);
check(
  'runs[0] 是最后创建的 run（不是更早的失败 run）',
  orderedIds[0] === ids[3],
  `got=${orderedIds[0]?.slice(-13)} want=${ids[3].slice(-13)}`,
);
check(
  '整体顺序 = 创建顺序的逆序',
  JSON.stringify(orderedIds) === JSON.stringify([...ids].reverse()),
  JSON.stringify(orderedIds.map((id) => id.slice(-13))),
);

// runs[0] 的状态反映「最新的 run」，不是历史失败 run
check('runs[0].status = completed（最新 run 成功）', runs[0].status === 'completed', runs[0].status);
check(
  '失败的 run 不在首位',
  runs[0].id !== ids[1],
  `runs[0]=${runs[0].id.slice(-13)} failedRun=${ids[1].slice(-13)}`,
);

// ---------------------------------------------------------------------------
// 2) runId 的秒级时间戳相同时，排序不依赖随机后缀
// ---------------------------------------------------------------------------

console.log('▶ runId 秒级时间戳相同的 run 顺序稳定');

// runId 只有秒级精度：存在至少一对 run 共享同一秒级前缀（随机后缀不可靠），
// 但它们的毫秒级 startedAt 不同 —— 排序必须靠 startedAt 而非 runId
const secondOf = (id: string): string => id.slice(0, id.lastIndexOf('-'));
const sharedSecondPair = ids.some((id) =>
  ids.some((other) => other !== id && secondOf(other) === secondOf(id)),
);
check('存在同秒级前缀的 run 对（runId 后缀不可靠）', sharedSecondPair, JSON.stringify(ids.map(secondOf)));
check(
  '各 run 的 startedAt 互不相同（毫秒精度）',
  new Set(runs.map((run) => run.startedAt)).size === runs.length,
  JSON.stringify(runs.map((run) => run.startedAt)),
);

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

await rm(repo, { recursive: true, force: true }).catch(() => undefined);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
