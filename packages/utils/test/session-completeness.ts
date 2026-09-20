/**
 * session-completeness.ts —— 完整性不变量（方案 C 阶段 4）
 *
 * 从**一个 run 目录**（会话文件 + 瘦业务事件，logger 一行内容都没有）
 * 重建完整视图，断言它自足地包含：
 *   模型正文 / 工具 I/O（入参 + 结果）/ 每响应用量 / 压缩摘要 /
 *   扫描边界 / provider request id / 系统提示 / 用户提示
 *
 * 这证明「pi 会话 + 瘦业务事件 = 唯一完整事实源」成立：投影层不需要
 * 任何 logger 输出或第二份内容拷贝。
 *
 * 运行：bun run test:trajectory（含在 bun run test 中）
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, readSessionFacts } from '../src/index.js';
import { replayRun } from '../../trajectory/src/index.js';

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

// ---------------------------------------------------------------------------
// 构造一个 run：events.jsonl（瘦业务事件）+ sessions/（完整内容）
// ---------------------------------------------------------------------------

const repo = await mkdtemp(join(tmpdir(), 'zread-completeness-'));
const runId = '2026-03-08T09-10-11-0a1b';
const runDir = join(repo, '.zread-pi', 'runs', runId);
const sessionId = 'zread-pi-20260308-compose-aabbccdd';
const cwdDir = '--cwd--';

await mkdir(join(runDir, 'sessions', cwdDir), { recursive: true });

// 瘦业务事件：零内容（systemPrompt 全文 / toolCatalog schema / tokenBudget 例外）
const events = [
  { kind: 'run_start', seq: 1, ts: 100, runKind: 'generate', detail: 'high', targetDir: repo, model: 'demo', provider: 'demo' },
  { kind: 'scan_start', seq: 2, ts: 200 },
  { kind: 'scan_end', seq: 3, ts: 1_500, fileCount: 7, durationMs: 1_300 },
  {
    kind: 'agent_config',
    seq: 4,
    ts: 1_600,
    agent: { key: 'page:alpha', role: 'page', pageSlug: 'alpha', sessionId },
    prompt: '生成页面 alpha：以 src/a.ts 为证说明模块边界',
    systemPrompt: '你是页面生成 Agent（系统提示全文）',
    toolCatalog: [{ name: 'write_page', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }],
    model: 'demo',
    provider: 'demo',
    thinkingLevel: 'off',
    tokenBudget: 100_000,
    contextWindow: 200_000,
  },
  { kind: 'provider_request', seq: 5, ts: 3_000, agent: { key: 'page:alpha', role: 'page', pageSlug: 'alpha', sessionId }, requestId: 'req-aaaa', model: 'demo', provider: 'demo' },
  { kind: 'provider_request', seq: 6, ts: 6_000, agent: { key: 'page:alpha', role: 'page', pageSlug: 'alpha', sessionId }, requestId: 'req-bbbb', model: 'demo', provider: 'demo' },
  { kind: 'page_start', seq: 7, ts: 1_550, slug: 'alpha' },
  { kind: 'agent_end', seq: 8, ts: 9_000, subtype: 'success', durationMs: 7_400 },
  { kind: 'page_end', seq: 9, ts: 9_100, slug: 'alpha', success: true, durationMs: 7_500 },
  { kind: 'run_end', seq: 10, ts: 9_200, status: 'completed', durationMs: 9_100, usage: { input_tokens: 400, output_tokens: 120 } },
];
await writeFile(
  join(runDir, 'events.jsonl'),
  events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  'utf-8',
);

// pi 会话条目：完整内容（含压缩点）
await writeFile(
  join(runDir, 'sessions', cwdDir, `2026-03-08T09-10-11-000Z_${encodeURIComponent(sessionId)}.jsonl`),
  [
    JSON.stringify({ v: 4, kind: 'header', id: sessionId }),
    JSON.stringify({ kind: 'value', op: 'set', key: 'lane.config', value: { model: 'demo' } }),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 1,
        timestamp: 1_700,
        message: { role: 'user', content: [{ type: 'text', text: '生成页面 alpha：以 src/a.ts 为证说明模块边界' }] },
      },
    ]),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 2,
        timestamp: 3_000,
        message: {
          role: 'assistant',
          model: 'demo',
          provider: 'demo',
          usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280 },
          content: [
            { type: 'thinking', thinking: '先读源码再写' },
            { type: 'text', text: '模块边界由 src/a.ts 的导出表决定。' },
            { type: 'toolCall', id: 'call-1', name: 'write_page', arguments: { file: 'alpha.md', content: '# 模块边界\n' } },
          ],
        },
      },
      {
        kind: 'usage',
        id: 'usage-1',
        seq: 2,
        entryId: 'entry-2',
        adjustment: false,
        usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 280 },
      },
    ]),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 3,
        timestamp: 4_000,
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'write_page',
          content: [{ type: 'text', text: 'written: alpha.md (128 bytes)' }],
        },
      },
    ]),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 4,
        timestamp: 6_000,
        message: {
          role: 'assistant',
          model: 'demo',
          provider: 'demo',
          usage: { input: 150, output: 40, cacheRead: 60, cacheWrite: 0, totalTokens: 250 },
          content: [{ type: 'text', text: '页面已完成。' }],
        },
      },
      {
        kind: 'usage',
        id: 'usage-2',
        seq: 4,
        entryId: 'entry-4',
        adjustment: false,
        usage: { input: 150, output: 40, cacheRead: 60, cacheWrite: 0, totalTokens: 250 },
      },
    ]),
    // 压缩点：追加 CompactionEntry，不删旧条目
    JSON.stringify([
      {
        kind: 'entry',
        type: 'compaction',
        seq: 5,
        timestamp: 7_000,
        summary: '此前讨论了模块边界与导出表，并已写入 alpha.md。',
        usage: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40 },
      },
    ]),
  ].join('\n') + '\n',
  'utf-8',
);

// ---------------------------------------------------------------------------
// 重建：会话 + 业务事件 → 快照
// ---------------------------------------------------------------------------

console.log('▶ 完整性不变量：会话 + 瘦业务事件自足重建完整视图');
const { events: readBack } = await readEvents(runId, { limit: 200 }, repo);
const facts = await readSessionFacts(runId, repo);
const snapshot = replayRun({ events: readBack, sessions: facts });

checkEqual('瘦业务事件全部读回（10 条）', readBack.length, 10);
checkEqual('会话文件数 = 1', facts.length, 1);
checkEqual('会话条目 = 5（user / assistant / toolResult / assistant / compaction）', facts[0]!.entries.length, 5);

// ① 模型正文
const messages = snapshot.records.filter((record) => record.kind === 'message');
checkEqual('assistant 消息 = 2', messages.length, 2);
check('模型正文（text 块原文）', messages[0]!.blocks.some((block) => block.type === 'text' && block.text === '模块边界由 src/a.ts 的导出表决定。'));
check('思考块（thinking 原文）', messages[0]!.blocks.some((block) => block.type === 'thinking' && block.text === '先读源码再写'));
check('第二条消息正文', messages[1]!.blocks.some((block) => block.type === 'text' && block.text === '页面已完成。'));

// ② 工具 I/O
const tools = snapshot.records.filter((record) => record.kind === 'tool');
checkEqual('工具记录 = 1', tools.length, 1);
checkEqual('工具入参（toolCall.arguments）', JSON.stringify(tools[0]!.input), JSON.stringify({ file: 'alpha.md', content: '# 模块边界\n' }));
checkEqual('工具结果（toolResult 消息）', tools[0]!.output, 'written: alpha.md (128 bytes)');
check('工具 schema（agent_config 的 toolCatalog）', tools[0]!.schemaDetail !== undefined && tools[0]!.schemaDetail.includes('write_page'));

// ③ 用量
const requests = snapshot.requests;
checkEqual('请求编号 = 3（2 条 assistant + 1 个压缩点）', requests.length, 3);
checkEqual('assistant 请求 = 2', requests.filter((request) => request.purpose === 'assistant').length, 2);
checkEqual('压缩请求 = 1', requests.filter((request) => request.purpose === 'compaction').length, 1);
checkEqual('第一响应用量', requests[0]!.usage?.input, 200);
check('缓存读逐响应保留', requests[1]!.usage?.cacheRead === 60);
check('累计用量跨响应累加', requests[1]!.cumulativeUsage?.input === 350);
checkEqual('run 用量合计取会话 usage 行（非 run_end 的 400）', snapshot.runSummary.usage?.input_tokens, 350);

// ④ 压缩
const compacted = snapshot.records.filter((record) => record.kind === 'compacted');
checkEqual('压缩记录 = 1', compacted.length, 1);
check('压缩摘要原文', compacted[0]!.summary === '此前讨论了模块边界与导出表，并已写入 alpha.md。');
check('压缩点之前的消息条目仍在磁盘（完整事实源）', facts[0]!.entries.filter((entry) => entry.type === 'message').length === 4);

// ⑤ 扫描边界
const scans = snapshot.records.filter((record) => record.kind === 'context' && record.text.includes('Scan complete'));
check('扫描边界（文件数）', scans.length === 1 && scans[0]!.text.includes('7 files'));

// ⑥ provider request id
const reqRecords = snapshot.records.filter((record) => record.kind === 'context' && record.text.includes('provider request'));
checkEqual('provider request id 全部保留（2 条，不只有最后一个）', reqRecords.length, 2);
check('request id 内容', reqRecords.some((record) => record.text.includes('req-aaaa')) && reqRecords.some((record) => record.text.includes('req-bbbb')));

// ⑦ 系统提示 / 用户提示（agent_config 承载的 harness 配置事实）
const system = snapshot.records.find((record) => record.kind === 'system');
check('系统提示全文（不在会话里，由 agent_config 承载）', system?.promptDetail?.system === '你是页面生成 Agent（系统提示全文）');
const user = snapshot.records.find((record) => record.kind === 'user');
check('用户提示全文', user?.preview === '生成页面 alpha：以 src/a.ts 为证说明模块边界');

// ⑧ 结构性事实
checkEqual('turn 数 = 1（一个 Agent 一个会话）', snapshot.turns.length, 1);
checkEqual('turn 的 sessionId 与会话文件一致', snapshot.turns[0]!.sessionId, sessionId);
checkEqual('run 状态 = completed', snapshot.runSummary.status, 'completed');
checkEqual('页面计数（page_start/page_end 投影）', snapshot.runSummary.pages.completed, 1);
check('上下文窗口（agent_config.contextWindow）', requests[0]!.contextWindow === 200_000);

// 清理
await rm(repo, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
