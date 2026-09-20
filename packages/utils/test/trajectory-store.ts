/**
 * trajectory-store.ts —— runs 落盘与读取的离线回归。
 *
 * 覆盖 PLAN「轨迹移植」测试矩阵里的 store 部分：
 * - writer / reader 往返（meta 状态 / events 计数 / lastSeq）
 * - beforeSeq 向前分页 / afterSeq 实时尾 / 缺省从头
 * - 损坏行跳过（写到一半 / 截断的行不让整个 run 不可读）
 * - 保留期清理（ZREAD_PI_RUNS_RETENTION）
 * - 残留 running 的旧 run 被标记 interrupted（自愈）
 * - run.json 的写入串行：end() 的终态不被更早 append 的挂起写覆盖
 * - 事件携带 agent.sessionId（轨迹回放的并发归属键）
 *
 * 运行：bun run test:trajectory（含在 bun run test 中）
 */

import { mkdtemp, mkdir, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunLogWriter,
  withRunLog,
  readRunMeta,
  readEvents,
  readSessionFacts,
  listRuns,
  latestRun,
  resolveRunId,
  isValidRunId,
  generateRunId,
  getEventsPath,
  getMetaPath,
  type RunLogWriterOptions,
} from '../src/index.js';
import type { RunEvent, RunEventAgentMeta } from '@zread-pi/types';
import { RUN_LEVEL_AGENT } from '@zread-pi/types';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function checkEqual<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 临时项目根（跨平台：os.tmpdir + mkdtemp）；结束时统一清理 */
const tempProjects: string[] = [];
async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zread-pi-runs-'));
  tempProjects.push(root);
  return root;
}

const AGENT_WITH_SESSION: RunEventAgentMeta = {
  key: 'page:alpha',
  role: 'page',
  pageSlug: 'alpha',
  sessionId: 'zread-pi-test-0001',
};

function agentStart(agent: RunEventAgentMeta): RunEvent {
  return {
    kind: 'agent_start',
    seq: 0,
    ts: 0,
    agent,
    prompt: 'do work',
    toolCatalog: [{ name: 'read', inputSchema: { type: 'object' } }],
  };
}

// ---------------------------------------------------------------------------
// 1) 往返：create → append → end → 读取
// ---------------------------------------------------------------------------

console.log('▶ writer / reader 往返');

const repo = await tempProject();
const options: RunLogWriterOptions = { kind: 'generate', detail: 'high', model: 'test-model' };
const writer = await RunLogWriter.create(repo, options);

writer.appendRunStart({ targetDir: repo, detail: 'high', model: 'test-model' });
writer.append({ kind: 'agent_start', agent: AGENT_WITH_SESSION, prompt: 'p', toolCatalog: [] });
writer.append({ kind: 'message_end', agent: AGENT_WITH_SESSION, blocks: [{ type: 'text', text: 'hi' }] });
await writer.end('completed');

const meta = await readRunMeta(writer.runId, repo);
checkEqual('run.json 状态 = completed', meta?.status, 'completed');
checkEqual('run.json kind = generate', meta?.kind, 'generate');
checkEqual('run.json events 计数 = 4（run_start + agent + message + run_end）', meta?.events, 4);
checkEqual('run.json lastSeq = 4', meta?.lastSeq, 4);
check('run.json 有结束时间', meta?.endedAt !== undefined);
checkEqual('run.json 记录了 model', meta?.model, 'test-model');

// 读取：缺省从头，seq 升序
const initial = await readEvents(writer.runId, {}, repo);
checkEqual('缺省读回 4 条事件', initial.events.length, 4);
check('事件按 seq 升序', initial.events.every((event, index) => event.seq === index + 1));
check('已完成 run 的 runEnded', initial.runEnded);
checkEqual('hasNewer = false（全部读完）', initial.hasNewer, false);

// 事件携带 sessionId（并发归属键）
const startEvent = initial.events.find((event) => event.kind === 'agent_start');
checkEqual('agent_start 事件携带 sessionId', startEvent?.agent?.sessionId, 'zread-pi-test-0001');

// ---------------------------------------------------------------------------
// 2) 分页：beforeSeq 向前 / afterSeq 尾随
// ---------------------------------------------------------------------------

console.log('▶ 分页');

const repo2 = await tempProject();
const w2 = await RunLogWriter.create(repo2, { kind: 'sync', runId: '2026-01-02T03-04-05-0a1b' });
w2.appendRunStart({ targetDir: repo2 });
for (let index = 0; index < 6; index += 1) {
  w2.append({ kind: 'status', agent: RUN_LEVEL_AGENT, text: `note ${index}` });
}
await w2.end('completed');

const tail = await readEvents(w2.runId, { afterSeq: 3, limit: 2 }, repo2);
checkEqual('afterSeq 返回 seq > 3 的最早 2 条', JSON.stringify(tail.events.map((event) => event.seq)), '[4,5]');
checkEqual('afterSeq 窗口外还有更新', tail.hasNewer, true);

const older = await readEvents(w2.runId, { beforeSeq: 5, limit: 2 }, repo2);
checkEqual('beforeSeq 返回 seq < 5 的最近 2 条（升序）', JSON.stringify(older.events.map((event) => event.seq)), '[3,4]');
checkEqual('beforeSeq 还有更旧页', older.hasMore, true);

const oldest = await readEvents(w2.runId, { beforeSeq: 2, limit: 5 }, repo2);
checkEqual('翻到最旧页 hasMore = false', oldest.hasMore, false);

const head = await readEvents(w2.runId, { limit: 3 }, repo2);
checkEqual('缺省从头返回 seq 1..3', JSON.stringify(head.events.map((event) => event.seq)), '[1,2,3]');
checkEqual('首屏 hasMore = false', head.hasMore, false);
check('首屏提示 hasNewer（剩余可续页）', head.hasNewer);

// ---------------------------------------------------------------------------
// 3) 损坏行跳过
// ---------------------------------------------------------------------------

console.log('▶ 损坏行容忍');

const eventsPath = getEventsPath(w2.runId, repo2);
// 追加一行写到一半的损坏内容（模拟并发写 / 截断）
await appendFile(eventsPath, '{ "kind": "status", "seq": 100, "ts": 1, "agent": null, "text": "broken\n', 'utf-8');
await appendFile(eventsPath, 'not-json-at-all\n', 'utf-8');
const corrupted = await readEvents(w2.runId, {}, repo2);
checkEqual('损坏行被跳过，有效事件仍是 8 条', corrupted.events.length, 8);
check('损坏行不影响 runEnded 判定', corrupted.runEnded);

// 损坏的 run.json：readRunMeta 返回 undefined（不抛错）
await writeFile(getMetaPath(w2.runId, repo2), '{ broken json', 'utf-8');
checkEqual('损坏的 run.json 返回 undefined', await readRunMeta(w2.runId, repo2), undefined);

// ---------------------------------------------------------------------------
// 4) 保留期清理
// ---------------------------------------------------------------------------

console.log('▶ 保留期清理');

const repo3 = await tempProject();
process.env.ZREAD_PI_RUNS_RETENTION = '2';
try {
  const createdIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const w = await RunLogWriter.create(repo3, { kind: 'generate' });
    createdIds.push(w.runId);
    await w.end('completed');
  }
  const remaining = await listRuns(repo3);
  checkEqual('保留期 2：只留 2 个 run', remaining.length, 2);
  // 删除的是「最早开始」的 run（startedAt 毫秒精度，不受同秒随机后缀影响）
  check('最早创建的 run 被删除', !remaining.some((run) => run.id === createdIds[0]));
  check('后两个 run 被保留', remaining.some((run) => run.id === createdIds[1]) && remaining.some((run) => run.id === createdIds[2]));
} finally {
  delete process.env.ZREAD_PI_RUNS_RETENTION;
}

// 保留期 <= 0 不清理
const repo3b = await tempProject();
process.env.ZREAD_PI_RUNS_RETENTION = '0';
try {
  for (let index = 0; index < 3; index += 1) {
    const w = await RunLogWriter.create(repo3b, { kind: 'generate' });
    await w.end('completed');
  }
  checkEqual('保留期 0：不清理（3 个 run）', (await listRuns(repo3b)).length, 3);
} finally {
  delete process.env.ZREAD_PI_RUNS_RETENTION;
}

// ---------------------------------------------------------------------------
// 5) 残留自愈：running 的旧 run 被标记 interrupted
// ---------------------------------------------------------------------------

console.log('▶ 残留自愈');

const repo4 = await tempProject();
const stale = await RunLogWriter.create(repo4, { kind: 'generate' });
// 不 end，模拟进程被杀死
checkEqual('旧 run 仍是 running', (await readRunMeta(stale.runId, repo4))?.status, 'running');
const fresh = await RunLogWriter.create(repo4, { kind: 'generate' });
await fresh.end('completed');
checkEqual('旧 run 被标记 interrupted', (await readRunMeta(stale.runId, repo4))?.status, 'interrupted');
checkEqual('旧 run 有 interrupted 错误说明', (await readRunMeta(stale.runId, repo4))?.error, 'Interrupted by a newer run');
checkEqual('新 run 正常完成', (await readRunMeta(fresh.runId, repo4))?.status, 'completed');

// ---------------------------------------------------------------------------
// 6) 写入串行：end() 的终态不被更早 append 的挂起写覆盖
// ---------------------------------------------------------------------------

console.log('▶ 写入串行');

const repo5 = await tempProject();
const w5 = await RunLogWriter.create(repo5, { kind: 'generate' });
w5.appendRunStart({ targetDir: repo5 });
// 高频 append（每次都触发一次 run.json 写入），随后立即 end
for (let index = 0; index < 20; index += 1) {
  w5.append({ kind: 'status', agent: RUN_LEVEL_AGENT, text: `n${index}` });
}
await w5.end('completed', undefined, { input_tokens: 99, output_tokens: 11 });
const finalMeta = await readRunMeta(w5.runId, repo5);
checkEqual('终态未被挂起写覆盖：status', finalMeta?.status, 'completed');
checkEqual('终态未被挂起写覆盖：events = 22（run_start + 20 status + run_end）', finalMeta?.events, 22);
checkEqual('终态用量合计正确写入', finalMeta?.usage?.input_tokens, 99);

// ---------------------------------------------------------------------------
// 7) withRunLog：缺省自动建 run / 传入则复用
// ---------------------------------------------------------------------------

console.log('▶ withRunLog');

const repo6 = await tempProject();
const result = await withRunLog(undefined, { kind: 'generate', targetDir: repo6 }, async (runLog) => {
  runLog.append({ kind: 'status', agent: RUN_LEVEL_AGENT, text: 'inside' });
  return 'ok';
});
checkEqual('withRunLog 返回业务结果', result, 'ok');
const autoRuns = await listRuns(repo6);
checkEqual('未传 runLog 时自动创建 1 个 run', autoRuns.length, 1);
checkEqual('自动 run 状态 = completed', autoRuns[0]?.status, 'completed');

// 传入时复用同一个 run（不再新建）
const shared = await RunLogWriter.create(repo6, { kind: 'generate' });
await withRunLog(shared, { kind: 'generate', targetDir: repo6 }, async (runLog) => {
  runLog.append({ kind: 'status', agent: RUN_LEVEL_AGENT, text: 'shared' });
  return undefined;
});
checkEqual('传入 runLog 时不新建 run', (await listRuns(repo6)).length, 2);
// runs[0] 必须是后创建的 shared run（同秒内创建时不能靠 runId 字符串序）
checkEqual('listRuns 按最新在前', (await listRuns(repo6))[0]?.id, shared.runId);

// 业务函数抛错时 run 记 failed
const repo7 = await tempProject();
await withRunLog(undefined, { kind: 'sync', targetDir: repo7 }, async () => {
  throw new Error('boom');
}).catch((err) => {
  checkEqual('业务失败时 withRunLog 透传错误', err.message, 'boom');
  return undefined;
});
const failedRuns = await listRuns(repo7);
checkEqual('业务失败时 run 状态 = failed', failedRuns[0]?.status, 'failed');
checkEqual('失败原因写入 meta', failedRuns[0]?.error, 'boom');

// ---------------------------------------------------------------------------
// 8) runId 与列表
// ---------------------------------------------------------------------------

console.log('▶ runId / 列表');

check('generateRunId 可用', isValidRunId(generateRunId()));
checkEqual('非法 runId 被拒', isValidRunId('not-a-run-id'), false);
checkEqual('resolveRunId(latest) 拿到最新', await resolveRunId('latest', repo6), (await latestRun(repo6))?.id);
checkEqual('空仓库 resolveRunId 返回 undefined', await resolveRunId(undefined, await tempProject()), undefined);
// 同秒内创建的 run 不能靠 runId 字符串序（随机后缀不可靠）；
// runs[0] 必须是 startedAt 最新的那个 = 后创建的 shared run
checkEqual('listRuns 按最新在前', (await listRuns(repo6))[0]?.id, shared.runId);

// 非法 runId 创建被拒
await RunLogWriter.create(await tempProject(), { kind: 'generate', runId: 'bad-id' })
  .then(() => check('非法 runId 应抛错', false))
  .catch(() => check('非法 runId 创建被拒', true));

// ---------------------------------------------------------------------------
// 会话事实读取（方案 C：readSessionFacts）
// ---------------------------------------------------------------------------

console.log('▶ readSessionFacts');
{
  const project = await tempProject();
  const runId = '2026-03-07T08-09-10-0a1b';
  const sessionRoot = join(project, '.zread-pi', 'runs', runId, 'sessions', '--cwd--');

  // 无会话目录 → 空数组（旧 run / 未传 sessionRoot 的运行）
  checkEqual('无会话目录返回空数组', (await readSessionFacts(runId, project)).length, 0);

  // 两个 Agent → 两个会话文件（一个有 header，一个只有文件名）
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(
    join(sessionRoot, `2026-03-07T08-09-10-000Z_${encodeURIComponent('session-a')}.jsonl`),
    [
      JSON.stringify({ v: 4, kind: 'header', id: 'session-a' }),
      JSON.stringify([{ kind: 'entry', type: 'message', seq: 1, timestamp: 1, message: { role: 'assistant', content: 'A' } }]),
    ].join('\n') + '\n',
    'utf-8',
  );
  await writeFile(
    join(sessionRoot, `2026-03-07T08-09-10-001Z_${encodeURIComponent('session-b')}.jsonl`),
    [
      // 无 header 行：sessionId 由文件名补
      JSON.stringify([{ kind: 'entry', type: 'message', seq: 1, timestamp: 2, message: { role: 'assistant', content: 'B' } }]),
    ].join('\n') + '\n',
    'utf-8',
  );
  // 非 .jsonl 文件被忽略；损坏的 jsonl 条目被跳过
  await writeFile(join(sessionRoot, 'note.txt'), 'nope', 'utf-8');
  await writeFile(
    join(sessionRoot, `2026-03-07T08-09-10-002Z_${encodeURIComponent('session-c')}.jsonl`),
    '{not json\n',
    'utf-8',
  );

  const facts = await readSessionFacts(runId, project);
  checkEqual('会话文件数 = 3（含损坏文件，忽略非 jsonl）', facts.length, 3);
  const byId = new Map(facts.map((fact) => [fact.sessionId, fact]));
  checkEqual('会话 A 的 id 来自 header', byId.get('session-a') !== undefined, true);
  checkEqual('会话 B 的 id 由文件名补', byId.get('session-b') !== undefined, true);
  checkEqual('会话 A 解析到消息条目', byId.get('session-a')?.entries.length, 1);
  checkEqual('损坏会话返回空条目', byId.get('session-c')?.entries.length, 0);
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

// 清理临时目录（Windows 下服务器/文件句柄可能还没释放，尽力而为）
await Promise.all(tempProjects.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
