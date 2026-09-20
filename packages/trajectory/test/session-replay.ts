/**
 * session-replay.ts —— 方案 C 的会话投影回归（解析 + replay + digest）
 *
 * 覆盖：
 * - parseSessionLines：header / entry / usage 行（含事务数组行与单对象行）、
 *   toolResult 独立消息、压缩条目、损坏行跳过、sessionId 来源
 * - replayRun：有会话时从会话投影（turn 与会话按 sessionId join、
 *   消息 / 工具 / 结果 / 用量 / provider_request / 失败归属），无会话回退旧 replay
 * - summarizeRunEvents：digest（状态 / Agent 数 / 消息数 / 用量合计）
 *
 * 运行：bun run test:trajectory（含在 bun run test 中）
 */

import {
  parseSessionLines,
  previewOfSessionMessage,
  replayRun,
  replayRunEvents,
  sumSessionUsage,
  summarizeRunEvents,
  toolCallArguments,
} from '../src/index.js';
import type { RunEvent, RunTokenUsage } from '@zread-pi/types';

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
// 事件构造助手
// ---------------------------------------------------------------------------

let nextSeq = 0;

function event(base: Omit<RunEvent, 'seq' | 'ts'>): RunEvent {
  nextSeq += 1;
  return { ...base, seq: nextSeq, ts: nextSeq * 1_000 } as RunEvent;
}

const PAGE_AGENT = { key: 'page:x', role: 'page' as const, pageSlug: 'x', sessionId: 'session-page-x' };

/** 一个最小但形态真实的 pi 会话文件（header + value 行 + entry/usage 数组行 + toolResult） */
function pageSessionLines(): string[] {
  return [
    JSON.stringify({ v: 4, kind: 'header', id: 'session-page-x', format: 4 }),
    // value 行（配置快照）不参与投影，但必须能被解析器跳过
    JSON.stringify({ kind: 'value', op: 'set', key: 'lane.config', value: { model: 'm' } }),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 1,
        timestamp: 1_100,
        message: { role: 'user', content: [{ type: 'text', text: '生成页面 x' }] },
      },
    ]),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 2,
        timestamp: 1_200,
        message: {
          role: 'assistant',
          model: 'demo-model',
          provider: 'demo-provider',
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
          content: [
            { type: 'text', text: '页面正文' },
            { type: 'toolCall', id: 'call-1', name: 'write_page', arguments: { file: 'x.md' } },
          ],
        },
      },
      {
        kind: 'usage',
        id: 'usage-1',
        seq: 2,
        entryId: 'entry-2',
        adjustment: false,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
      },
    ]),
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 3,
        timestamp: 1_300,
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'write_page',
          content: [{ type: 'text', text: 'written: x.md' }],
        },
      },
    ]),
    // 第二条助手消息（文本，无工具）：验证 step 编号
    JSON.stringify([
      {
        kind: 'entry',
        type: 'message',
        seq: 4,
        timestamp: 1_400,
        message: {
          role: 'assistant',
          model: 'demo-model',
          provider: 'demo-provider',
          usage: { input: 30, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 60 },
          content: [{ type: 'text', text: '完成' }],
        },
      },
    ]),
  ];
}

// ---------------------------------------------------------------------------
// parseSessionLines
// ---------------------------------------------------------------------------

console.log('▶ parseSessionLines：基本形态');
{
  const facts = parseSessionLines(pageSessionLines());
  checkEqual('sessionId 取自 header', facts.sessionId, 'session-page-x');
  checkEqual('条目数 = 4（user / assistant / toolResult / assistant）', facts.entries.length, 4);
  checkEqual('usage 行 = 1', facts.usageRows.length, 1);
  checkEqual('value 行不参与投影', facts.entries.filter((entry) => entry.type === 'custom').length, 0);
  checkEqual('seq 升序', facts.entries[0]!.seq, 1);
  checkEqual('assistant 自带用量', facts.entries[1]!.message!.usage!.input, 100);
  checkEqual('toolCall 块的 name', (facts.entries[1]!.message!.content as Array<{ name?: string }>)[1]!.name, 'write_page');
  checkEqual('toolResult 是独立消息', facts.entries[2]!.message!.role, 'toolResult');
  checkEqual('toolResult 带 toolCallId', facts.entries[2]!.message!.toolCallId, 'call-1');
}

console.log('▶ parseSessionLines：压缩条目 / 损坏行 / 参数 sessionId');
{
  const lines = [
    JSON.stringify({ v: 4, kind: 'header', id: 'session-a' }),
    // 损坏行（非法 JSON）：跳过
    '{not json',
    JSON.stringify([
      { kind: 'entry', type: 'compaction', seq: 5, timestamp: 5_000, summary: '压缩摘要', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
    ]),
    JSON.stringify([{ kind: 'entry', type: 'message', seq: 6, timestamp: 6_000, message: { role: 'user', content: '继续' } }]),
  ];
  const facts = parseSessionLines(lines);
  checkEqual('压缩条目被解析', facts.entries[0]!.type, 'compaction');
  checkEqual('压缩摘要', facts.entries[0]!.summary, '压缩摘要');
  checkEqual('损坏行被跳过', facts.entries.length, 2);
  checkEqual('参数 sessionId 优先', parseSessionLines(['nope'], 'session-b').sessionId, 'session-b');
}

console.log('▶ parseSessionLines：字符串 content 与空文件');
{
  const facts = parseSessionLines([
    JSON.stringify({ kind: 'header', id: 'session-c' }),
    JSON.stringify([{ kind: 'entry', type: 'message', seq: 1, timestamp: 1, message: { role: 'assistant', content: '纯文本内容' } }]),
  ]);
  checkEqual('字符串 content 解析为一条消息', facts.entries.length, 1);
  checkEqual('字符串 content 预览', previewOfSessionMessage(facts.entries[0]!.message), '纯文本内容');
  const empty = parseSessionLines([]);
  checkEqual('空行数组 → 0 条目', empty.entries.length, 0);
  checkEqual('空行数组 → sessionId 空', empty.sessionId, '');
}

console.log('▶ sumSessionUsage：合计 + adjustment');
{
  const facts = parseSessionLines(pageSessionLines());
  const total = sumSessionUsage(facts.usageRows);
  checkEqual('input 合计', total.input, 100);
  checkEqual('output 合计', total.output, 50);
  checkEqual('totalTokens 合计', total.totalTokens, 150);
  const withAdjust = sumSessionUsage([
    ...facts.usageRows,
    { id: 'adj', seq: 9, adjustment: true, usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } },
  ]);
  checkEqual('adjustment 行按增量计入', withAdjust.input, 105);
}

console.log('▶ toolCallArguments：arguments / input 兼容');
{
  checkEqual('arguments 字段', typeof toolCallArguments({ type: 'toolCall', id: 'a', name: 't', arguments: { x: 1 } }), 'object');
  checkEqual('input 兜底', JSON.stringify(toolCallArguments({ type: 'toolCall', id: 'a', name: 't', input: { y: 2 } })), '{"y":2}');
  checkEqual('text 块返回 undefined', toolCallArguments({ type: 'text', text: 'hi' }), undefined);
}

// ---------------------------------------------------------------------------
// replayRun（方案 C：会话投影）
// ---------------------------------------------------------------------------

console.log('▶ replayRun：会话与事件按 sessionId join');
{
  nextSeq = 0;
  const facts = parseSessionLines(pageSessionLines());
  const events: RunEvent[] = [
    event({
      kind: 'run_start',
      runKind: 'generate',
      detail: 'high',
      targetDir: '/repo',
      model: 'demo-model',
      provider: 'demo-provider',
    }),
    event({
      kind: 'scan_start',
    }),
    event({
      kind: 'scan_end',
      fileCount: 12,
      durationMs: 800,
    }),
    event({
      kind: 'agent_config',
      agent: PAGE_AGENT,
      prompt: '生成页面 x 的正文',
      systemPrompt: '你是页面生成 Agent',
      toolCatalog: [{ name: 'write_page', inputSchema: { type: 'object', properties: {} } }],
      model: 'demo-model',
      provider: 'demo-provider',
      thinkingLevel: 'off',
      tokenBudget: 100_000,
      contextWindow: 200_000,
    }),
    event({
      kind: 'provider_request',
      agent: PAGE_AGENT,
      requestId: 'req-aaaa',
      model: 'demo-model',
      provider: 'demo-provider',
    }),
    event({
      kind: 'agent_end',
      subtype: 'success',
      durationMs: 4_000,
      usage: { input_tokens: 130, output_tokens: 70 },
    }),
    event({
      kind: 'run_end',
      status: 'completed',
      durationMs: 5_000,
      usage: { input_tokens: 130, output_tokens: 70 },
    }),
  ];
  const snapshot = replayRun({ events, sessions: [facts] });

  checkEqual('turn 数 = 1', snapshot.turns.length, 1);
  checkEqual('turn 的 sessionId = 会话 id', snapshot.turns[0]!.sessionId, 'session-page-x');
  checkEqual('turn 的 pageSlug', snapshot.turns[0]!.pageSlug, 'x');
  checkEqual('turn 的 role', snapshot.turns[0]!.role, 'page');
  checkEqual('run 状态 = completed', snapshot.runSummary.status, 'completed');
  checkEqual('run 的 stages 初始为空', snapshot.runSummary.stages.length, 0);
  check('system 记录携带系统提示全文', snapshot.records.some((record) => record.kind === 'system' && record.text === 'Initial System Prompt'));
  check('user 记录携带提示词', snapshot.records.some((record) => record.kind === 'user' && record.preview === '生成页面 x 的正文'));
  check('scan 记录落 run 级独立段', snapshot.records.some((record) => record.kind === 'context' && record.text.includes('12 files')));

  const messages = snapshot.records.filter((record) => record.kind === 'message');
  checkEqual('会话消息 = 2（两条 assistant）', messages.length, 2);
  checkEqual('step 编号从 1 开始', messages[0]!.step, 1);
  checkEqual('第二条消息 step = 2', messages[1]!.step, 2);
  check('第一条消息含正文块', messages[0]!.blocks.some((block) => block.type === 'text' && block.text === '页面正文'));

  const tools = snapshot.records.filter((record) => record.kind === 'tool');
  checkEqual('工具记录 = 1', tools.length, 1);
  checkEqual('工具名 = write_page', tools[0]!.name, 'write_page');
  checkEqual('工具已结算（running=false）', tools[0]!.running, false);
  checkEqual('工具输出来自 toolResult 消息', tools[0]!.output, 'written: x.md');
  check('工具 schema 来自 agent_config 目录', tools[0]!.schemaDetail !== undefined);
  checkEqual('工具分组 = 父消息的 Message 组', tools[0]!.group, 'Message');
  check('provider_request 落在该 turn', snapshot.records.some((record) => record.kind === 'context' && record.text.includes('req-aaaa')));
}

console.log('▶ replayRun：用量合计来自会话 usage 行');
{
  nextSeq = 0;
  const facts = parseSessionLines(pageSessionLines());
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' }),
    event({
      kind: 'agent_config',
      agent: PAGE_AGENT,
      prompt: 'p',
      toolCatalog: [],
      model: 'demo-model',
    }),
    event({ kind: 'agent_end', subtype: 'success', durationMs: 1, usage: { input_tokens: 999, output_tokens: 999 } }),
    event({ kind: 'run_end', status: 'completed', durationMs: 1, usage: { input_tokens: 999, output_tokens: 999 } }),
  ];
  const snapshot = replayRun({ events, sessions: [facts] });
  const usage = snapshot.runSummary.usage as RunTokenUsage | undefined;
  check('runSummary.usage 存在', usage !== undefined);
  checkEqual('input = 会话合计（不取 run_end 的 999）', usage?.input_tokens, 100);
  checkEqual('output = 会话合计', usage?.output_tokens, 50);
  checkEqual('无缓存写入', usage?.cache_creation_input_tokens, undefined);
}

console.log('▶ replayRun：请求编号 + 累计用量 + 模型');
{
  nextSeq = 0;
  const facts = parseSessionLines(pageSessionLines());
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' }),
    event({
      kind: 'agent_config',
      agent: PAGE_AGENT,
      prompt: 'p',
      toolCatalog: [],
      model: 'cfg-model',
      provider: 'cfg-provider',
      contextWindow: 128_000,
    }),
    event({ kind: 'agent_end', subtype: 'success', durationMs: 1 }),
    event({ kind: 'run_end', status: 'completed', durationMs: 1 }),
  ];
  const snapshot = replayRun({ events, sessions: [facts] });
  const requests = snapshot.requests;
  checkEqual('请求数 = 2（两条 assistant 消息）', requests.length, 2);
  checkEqual('请求编号从 1 开始', requests[0]!.number, 1);
  checkEqual('第二条请求编号 = 2', requests[1]!.number, 2);
  checkEqual('请求用途 = assistant', requests[0]!.purpose, 'assistant');
  checkEqual('累计用量包含第二条消息', requests[1]!.cumulativeUsage?.input, 130);
  checkEqual('模型取消息自带值', requests[0]!.model, 'demo-model');
  checkEqual('contextWindow 来自 agent_config', requests[0]!.contextWindow, 128_000);
}

console.log('▶ replayRun：失败 Agent 的最后一条请求标 error');
{
  nextSeq = 0;
  const facts = parseSessionLines(pageSessionLines());
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' }),
    event({ kind: 'agent_config', agent: PAGE_AGENT, prompt: 'p', toolCatalog: [] }),
    // sink 绑定身份只有 key/role（无 sessionId）：验证双键回退能归回 turn
    event({
      kind: 'agent_end',
      agent: { key: 'page:x', role: 'page', pageSlug: 'x' },
      subtype: 'error_budget_exhausted',
      durationMs: 1,
    }),
    event({ kind: 'run_end', status: 'failed', durationMs: 1, error: 'no output' }),
  ];
  const snapshot = replayRun({ events, sessions: [facts] });
  checkEqual('turn 带 endError', snapshot.turns[0]!.endError, 'error_budget_exhausted');
  const last = snapshot.requests[snapshot.requests.length - 1]!;
  checkEqual('最后一条请求状态 = error', last.status, 'error');
  checkEqual('失败原因 = subtype', last.error, 'error_budget_exhausted');
  checkEqual('run 状态 = failed', snapshot.runSummary.status, 'failed');
}

console.log('▶ replayRun：无会话事实 → 回退事件 replay（旧 run 兼容）');
{
  nextSeq = 0;
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' }),
    event({
      kind: 'agent_start',
      agent: { key: 'classify', role: 'classify', sessionId: 's1' },
      prompt: '分类',
      toolCatalog: [],
    }),
    event({
      kind: 'message_end',
      agent: { key: 'classify', role: 'classify', sessionId: 's1' },
      blocks: [{ type: 'text', text: '旧格式内容' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    event({ kind: 'agent_end', subtype: 'success', durationMs: 1 }),
    event({ kind: 'run_end', status: 'completed', durationMs: 1 }),
  ];
  const withSessions = replayRun({ events, sessions: [] });
  const fallback = replayRun({ events });
  checkEqual('空会话数组 → 回退', withSessions.records.length, fallback.records.length);
  check('回退路径保留旧消息内容', fallback.records.some((record) => record.kind === 'message'));
  checkEqual('缺省 sessions 参数等价于空', replayRun({ events }).records.length, fallback.records.length);
}

console.log('▶ replayRun：多 Agent 并发，会话按 id 精确归属');
{
  nextSeq = 0;
  const sessionA = parseSessionLines([
    JSON.stringify({ kind: 'header', id: 'sa' }),
    JSON.stringify([{ kind: 'entry', type: 'message', seq: 1, timestamp: 1_000, message: { role: 'assistant', content: [{ type: 'text', text: 'A 正文' }] } }]),
  ]);
  const sessionB = parseSessionLines([
    JSON.stringify({ kind: 'header', id: 'sb' }),
    JSON.stringify([{ kind: 'entry', type: 'message', seq: 1, timestamp: 2_000, message: { role: 'assistant', content: [{ type: 'text', text: 'B 正文' }] } }]),
  ]);
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' }),
    // 两个 Agent 的 agent_config 交错（模拟并发）
    event({ kind: 'agent_config', agent: { key: 'page:a', role: 'page', pageSlug: 'a', sessionId: 'sa' }, prompt: 'A', toolCatalog: [] }),
    event({ kind: 'agent_config', agent: { key: 'page:b', role: 'page', pageSlug: 'b', sessionId: 'sb' }, prompt: 'B', toolCatalog: [] }),
    event({ kind: 'agent_end', agent: { key: 'page:a', role: 'page', pageSlug: 'a', sessionId: 'sa' }, subtype: 'success', durationMs: 3 }),
    event({ kind: 'agent_end', agent: { key: 'page:b', role: 'page', pageSlug: 'b', sessionId: 'sb' }, subtype: 'success', durationMs: 4 }),
    event({ kind: 'run_end', status: 'completed', durationMs: 5 }),
  ];
  const snapshot = replayRun({ events, sessions: [sessionA, sessionB] });
  checkEqual('turn 数 = 2', snapshot.turns.length, 2);
  const bySession = new Map(snapshot.turns.map((turn) => [turn.sessionId, turn]));
  checkEqual('turn A 归属 sa', bySession.get('sa')?.pageSlug, 'a');
  checkEqual('turn B 归属 sb', bySession.get('sb')?.pageSlug, 'b');
  // A 的内容不能跑到 B 的 turn 里
  const turnARelated = snapshot.records.filter((record) => record.turn === bySession.get('sa')?.number);
  check('A 的会话正文只在 A 的 turn', turnARelated.some((record) => record.kind === 'message'));
  checkEqual('A 的 turn 只有自己的消息', turnARelated.filter((record) => record.kind === 'message').length, 1);
  checkEqual('A 的消息正文 = A 正文', turnARelated.find((record) => record.kind === 'message')?.blocks[0]?.type === 'text' &&
    (turnARelated.find((record) => record.kind === 'message')?.blocks[0] as { text?: string } | undefined)?.text, 'A 正文');
}

console.log('▶ summarizeRunEvents：digest');
{
  nextSeq = 0;
  const facts = parseSessionLines(pageSessionLines());
  const events: RunEvent[] = [
    event({ kind: 'run_start', runKind: 'sync', detail: 'low', targetDir: '/repo' }),
    event({ kind: 'agent_config', agent: PAGE_AGENT, prompt: 'p', toolCatalog: [] }),
    event({ kind: 'agent_end', subtype: 'success', durationMs: 1 }),
    event({ kind: 'run_end', status: 'completed', durationMs: 42, usage: { input_tokens: 7, output_tokens: 3 } }),
  ];
  const digest = summarizeRunEvents(events, [facts]);
  checkEqual('状态 = completed', digest.status, 'completed');
  checkEqual('kind = sync', digest.kind, 'sync');
  checkEqual('detail = low', digest.detail, 'low');
  checkEqual('Agent 数 = 会话数', digest.agentCount, 1);
  checkEqual('消息条目数 = 会话条目数', digest.messageCount, 4);
  checkEqual('用量取会话合计', digest.usage?.input_tokens, 100);

  const noSessionDigest = summarizeRunEvents(events);
  checkEqual('无会话时 Agent 数 = 0', noSessionDigest.agentCount, 0);
  checkEqual('无会话时用量回退 run_end', noSessionDigest.usage?.input_tokens, 7);
}

console.log('▶ summarizeRunEvents：未结束的 run');
{
  nextSeq = 0;
  const digest = summarizeRunEvents([event({ kind: 'run_start', runKind: 'generate', targetDir: '/repo' })]);
  checkEqual('状态 = running', digest.status, 'running');
  check('无 usage', digest.usage === undefined);
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
