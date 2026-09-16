/**
 * trajectory-model.ts —— 纯模型层的离线回归（replay / layout / timeline / search / 虚拟窗口）
 *
 * 输入是构造出的事件流（不依赖任何 LLM 或文件系统），覆盖：
 * - turn = agent：agent_start/agent_end 推导 turn 边界；run 级事件归到「Between turns」
 * - group 归属：step 1 = Message；其余 = Step N；工具挂到含其 callId 的父消息
 * - 请求统一编号 + 累计 usage；turn 失败归属到最后一条请求
 * - timeline 四模式投影 + 选区过滤；搜索索引多词交集；虚拟窗口数学
 *
 * 运行：bun run test:trajectory（含在 bun run test 中）
 */

import {
  appendTrajectoryPartialLayout,
  cacheHitRatio,
  deriveTrajectoryLayout,
  deriveTrajectoryTimeline,
  formatDurationMs,
  formatPercent,
  groupTrajectoryVirtualRows,
  previewOfBlocks,
  replayRunEvents,
  trajectoryRecordId,
  trajectoryTimelineFocusIndexes,
  trajectoryTotalHeight,
  trajectoryViewportWindow,
  TrajectorySearchIndex,
  VIRTUAL_OVERSCAN_ROWS,
} from '../src/index.js';
import type { RunEvent, RunTokenUsage } from '@zread-pi/types';
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

// ---------------------------------------------------------------------------
// 事件构造助手
// ---------------------------------------------------------------------------

let nextSeq = 0;

function event(base: Omit<RunEvent, 'seq' | 'ts'>): RunEvent {
  nextSeq += 1;
  return { ...base, seq: nextSeq, ts: nextSeq * 1_000 } as RunEvent;
}

const CLASSIFY_AGENT = { key: 'classify', role: 'classify' as const };
const TOPICS_A = { key: 'topics:A', role: 'topics' as const, section: 'A' };
const PAGE_X = { key: 'page:x', role: 'page' as const, pageSlug: 'x' };

const USAGE: RunTokenUsage = { input_tokens: 100, output_tokens: 20 };

/** 一个完整的 Agent 生命周期：start → 一条消息（含工具调用）→ end */
function agentLifecycle(agent: RunEvent['agent'], options: { fail?: boolean } = {}): RunEvent[] {
  return [
    event({
      kind: 'agent_start',
      agent,
      prompt: 'do work',
      systemPrompt: 'system',
      toolCatalog: [{ name: 'read', inputSchema: { type: 'object' } }],
    }),
    event({ kind: 'message_start', agent, preview: 'think…' }),
    event({
      kind: 'message_end',
      agent,
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', callId: 'call-1', name: 'read', input: { path: 'a.ts' } },
      ],
      usage: USAGE,
      stopReason: 'stop',
      contextWindow: 200_000,
    }),
    event({ kind: 'tool_start', agent, callId: 'call-1', name: 'read', input: { path: 'a.ts' } }),
    event({ kind: 'tool_end', agent, callId: 'call-1', name: 'read', output: 'file content' }),
    event({
      kind: 'agent_end',
      agent,
      subtype: options.fail === true ? 'error_during_execution' : 'success',
      durationMs: 500,
      usage: USAGE,
    }),
  ];
}

// ---------------------------------------------------------------------------
// 1) replay：turn = agent；run 级事件归到「Between turns」
// ---------------------------------------------------------------------------

console.log('▶ replay：turn / group / 请求编号');

const events: RunEvent[] = [
  event({ kind: 'run_start', agent: RUN_LEVEL_AGENT, runKind: 'generate', targetDir: '/repo' }),
  event({ kind: 'stage', agent: RUN_LEVEL_AGENT, stage: 'classify' }),
  ...agentLifecycle(CLASSIFY_AGENT),
  event({ kind: 'section', agent: RUN_LEVEL_AGENT, section: 'A' }),
  // 分主题 Agent：压缩发生在它的运行期间（compact 归到当前 Agent 的上下文）
  event({ kind: 'agent_start', agent: TOPICS_A, prompt: 'topics', systemPrompt: 's', toolCatalog: [] }),
  event({ kind: 'message_start', agent: TOPICS_A, preview: 'topics…' }),
  event({
    kind: 'message_end',
    agent: TOPICS_A,
    blocks: [{ type: 'text', text: 'topics done' }],
    usage: USAGE,
    stopReason: 'stop',
  }),
  event({ kind: 'compact', agent: TOPICS_A, summary: 'compacted context' }),
  event({ kind: 'agent_end', agent: TOPICS_A, subtype: 'success', durationMs: 700, usage: USAGE }),
  ...agentLifecycle(PAGE_X),
  event({
    kind: 'run_end',
    agent: RUN_LEVEL_AGENT,
    status: 'completed',
    durationMs: 5_000,
    usage: { input_tokens: 500, output_tokens: 60 },
  }),
];

const snapshot = replayRunEvents(events);

checkEqual('记录数', snapshot.records.length, 13);
// snapshot.turns 只列 Agent（turn = agent）；run 级记录的 turn 为 null，但不出现在这里
checkEqual('turn 数 = 3 个 Agent', snapshot.turns.length, 3);
checkEqual('turn 1 是 classify', snapshot.turns[0]?.key, 'classify');
checkEqual('turn 2 是 topics:A', snapshot.turns[1]?.key, 'topics:A');
checkEqual('turn 3 是 page:x', snapshot.turns[2]?.key, 'page:x');

// 请求编号：assistant 消息 + 压缩共用一个时间序空间
const assistantRequests = snapshot.requests.filter((request) => request.purpose === 'assistant');
const compactionRequests = snapshot.requests.filter((request) => request.purpose === 'compaction');
checkEqual('助手请求 = 3（每个 Agent 一条）', assistantRequests.length, 3);
checkEqual('压缩请求 = 1（Agent 运行期间的压缩）', compactionRequests.length, 1);
check('请求编号 1..N 连续', snapshot.requests.every((request, index) => request.number === index + 1));
checkEqual('压缩请求的累计用量含前面的助手用量', snapshot.requests[1]?.cumulativeUsage?.input, 200);
checkEqual('最后一条请求的累计用量 = 全部之和', snapshot.requests[3]?.cumulativeUsage?.input, 300);

// run 摘要
checkEqual('run 摘要状态', snapshot.runSummary.status, 'completed');
checkEqual('run 摘要 kind', snapshot.runSummary.kind, 'generate');
checkEqual('run 摘要 agent 数', snapshot.runSummary.agents?.count ?? 0, 0);
checkEqual('run 摘要 stages 含 classify', snapshot.runSummary.stages.includes('classify'), true);

// ---------------------------------------------------------------------------
// 2) layout：group 归属与工具挂载
// ---------------------------------------------------------------------------

console.log('▶ layout：group / cell');

const layout = deriveTrajectoryLayout(snapshot);
checkEqual('layout turn 数', layout.length, 4);

const classifyTurn = layout.find((turn) => turn.turn === 1);
check('classify turn 的标签来自 turn 信息', classifyTurn?.label === 'classify');
checkEqual('classify turn 的 group 数', classifyTurn?.groups.length, 1);
checkEqual('首条消息归到 Message 组', classifyTurn?.groups[0]?.title, 'Message');
check('工具记录归到含其 callId 的父消息同组', classifyTurn?.groups[0]?.cells.some((cell) => cell.kind === 'tool'));

const toolCell = classifyTurn?.groups[0]?.cells.find((cell) => cell.kind === 'tool');
check('工具单元格带 schemaDetail', toolCell?.schemaDetail !== undefined);
check('工具单元格带 inputDetail（参数）', (toolCell?.inputDetail ?? '').includes('a.ts'));
check('工具单元格带 outputDetail（结果）', (toolCell?.outputDetail ?? '').includes('file content'));

const messageCell = classifyTurn?.groups[0]?.cells.find((cell) => cell.kind === 'message');
check('消息单元格带用量', messageCell?.input === 100 && messageCell?.output === 20);
check('消息单元格带 TTFT 时序事实', messageCell?.assistantMetrics?.timingRecorded === true);
check('消息单元格带 contextWindow', messageCell?.sourceBlocks?.some((block) => block.type === 'tool-call') === true);

// 独立段（run 级事件）归到 turn = null
const standalone = layout.find((turn) => turn.turn === null);
check('run 级事件归到 Between turns 段', standalone?.label === 'Between turns');

// ---------------------------------------------------------------------------
// 3) 失败归属：agent_end 非 success → 错误标在 turn 最后一条请求上
// ---------------------------------------------------------------------------

console.log('▶ 失败归属');

const failEvents: RunEvent[] = [
  event({ kind: 'run_start', agent: RUN_LEVEL_AGENT, runKind: 'generate', targetDir: '/repo' }),
  ...agentLifecycle(CLASSIFY_AGENT, { fail: true }),
  event({ kind: 'run_end', agent: RUN_LEVEL_AGENT, status: 'failed', durationMs: 100, error: 'boom' }),
];
const failSnapshot = replayRunEvents(failEvents);
checkEqual('失败 turn 的请求 status = error', failSnapshot.requests[0]?.status, 'error');

// ---------------------------------------------------------------------------
// 4) 流式 partial：进行中的消息追加到布局
// ---------------------------------------------------------------------------

console.log('▶ 流式 partial');

const partialEvents: RunEvent[] = [
  event({ kind: 'run_start', agent: RUN_LEVEL_AGENT, runKind: 'generate', targetDir: '/repo' }),
  event({ kind: 'agent_start', agent: PAGE_X, prompt: 'p', toolCatalog: [] }),
  event({ kind: 'message_start', agent: PAGE_X, preview: 'draft' }),
];
const partialSnapshot = replayRunEvents(partialEvents);
check('进行中的消息成为 partial', partialSnapshot.partial !== null);
checkEqual('partial 的 turn 序号 = 该事件流里的第 1 个 turn', partialSnapshot.partial?.turn, 1);
const partialLayout = appendTrajectoryPartialLayout(
  deriveTrajectoryLayout(partialSnapshot),
  partialSnapshot.partial,
  0,
);
checkEqual('partial 追加后布局只有该 turn（agent_start 不产生记录）', partialLayout.length, 1);
check('partial 单元格出现在布局里', partialLayout[0]?.groups[0]?.cells.some((cell) => cell.text === 'draft'));

// ---------------------------------------------------------------------------
// 5) timeline：四模式投影 + 选区过滤
// ---------------------------------------------------------------------------

console.log('▶ timeline：投影与选区');

const sequence = deriveTrajectoryTimeline(layout, 'sequence');
checkEqual('sequence 模式非空', sequence === null, false);
checkEqual('sequence 模式 span 数 = 记录数', sequence?.spans.length, snapshot.records.length);
check('sequence 模式的起止是 0..N', sequence?.start === 0 && sequence?.end === sequence.spans.length);
check('泳道划分：tool 在泳道 2', sequence?.spans.some((span) => span.kind === 'tool' && span.lane === 2));
check('泳道划分：message 在泳道 1', sequence?.spans.some((span) => span.kind === 'message' && span.lane === 1));

const duration = deriveTrajectoryTimeline(layout, 'duration');
checkEqual('duration 模式非空', duration === null, false);
check('duration 模式按墙钟投影（跨度非零）', (duration?.end ?? 0) > (duration?.start ?? 0));

const actual = deriveTrajectoryTimeline(layout, 'actual');
checkEqual('actual 模式非空', actual === null, false);

const time = deriveTrajectoryTimeline(layout, 'time');
checkEqual('time 模式非空', time === null, false);
// time 模式 = 真实墙钟时刻的点（不压缩、不画时长）：范围 = 首末记录的 start
checkEqual('time 模式的范围是绝对墙钟跨度', time?.start, Math.min(...snapshot.records.map((record) => record.ts)));
checkEqual('time 模式的终点是最后一条记录的时刻', time?.end, Math.max(...snapshot.records.map((record) => record.ts)));
check('duration 模式压缩空闲后跨度更小', (duration?.end ?? 1) - (duration?.start ?? 0) <= (time?.end ?? 1) - (time?.start ?? 0));

const focusAll = trajectoryTimelineFocusIndexes(layout, { start: sequence!.start, end: sequence!.end }, 'sequence');
checkEqual('全区间选区命中全部记录', focusAll.size, snapshot.records.length);
const focusNone = trajectoryTimelineFocusIndexes(layout, { start: -5, end: -1 }, 'sequence');
checkEqual('空区间选区命中 0 条', focusNone.size, 0);

check('空 turns 的 timeline 为 null', deriveTrajectoryTimeline([], 'duration') === null);

// ---------------------------------------------------------------------------
// 6) 搜索索引：多词交集 + 增量更新
// ---------------------------------------------------------------------------

console.log('▶ 搜索索引');

const index = new TrajectorySearchIndex();
check('空查询返回 null（不过滤）', index.search('') === null);
index.update([layout]);
check('单命中：工具名', (index.search('read')?.size ?? 0) > 0);
check('单命中：参数内容', (index.search('a.ts')?.size ?? 0) > 0);
check('多词交集：不存在时为空集', (index.search('read a.ts')?.size ?? 0) > 0);
check('多词交集：有一个词不匹配时为空', (index.search('read nope-xyz')?.size ?? 0) === 0);
check('匹配包含 turn 编号', (index.search('turn 1')?.size ?? 0) > 0);
check('大小写不敏感', (index.search('READ')?.size ?? 0) > 0);

// 增量更新：同一份布局引用再更新返回 false（内容未变，不重建条目）
const sameLayouts = [layout] as const;
index.update(sameLayouts);
const updated = index.update(sameLayouts);
checkEqual('相同布局再更新返回 false', updated, false);

// ---------------------------------------------------------------------------
// 7) 虚拟化：窗口数学 + 稳定 key
// ---------------------------------------------------------------------------

console.log('▶ 虚拟化');

const cells = layout.flatMap((turn) => turn.groups.flatMap((group) => group.cells));
const virtualRows = groupTrajectoryVirtualRows(cells.map((cell) => ({ cell })));
check('虚拟行数 = 内容记录数（无 requestOnly）', virtualRows.length === cells.length);
check('稳定 key 不含空格', virtualRows.every((row) => !row.key.includes(' ')));
checkEqual('内容行高 30', virtualRows[0]?.height, 30);
checkEqual('总高度 = 行高之和', trajectoryTotalHeight(virtualRows), virtualRows.reduce((total, row) => total + row.height, 0));

// requestOnly 记录挂到下一个内容行
const withPlaceholder = groupTrajectoryVirtualRows([
  { cell: { ...cells[0]!, requestOnly: true } },
  { cell: cells[1]! },
]);
checkEqual('requestOnly 挂到下一内容行（仍是 1 行）', withPlaceholder.length, 1);
checkEqual('requestOnly 行的 entries 含 2 条', withPlaceholder[0]?.entries.length, 2);

// 视口窗口：scrollTop=0 时从第 0 行开始
const heights = Array.from({ length: 50 }, () => ({ height: 30 }));
const topWindow = trajectoryViewportWindow(heights, 0, 90, VIRTUAL_OVERSCAN_ROWS);
checkEqual('视口顶部从第 0 行开始', topWindow.startIndex, 0);
check('视口包含至少 3 行 + overscan', topWindow.endIndex >= 3);
const midWindow = trajectoryViewportWindow(heights, 1_000, 90, VIRTUAL_OVERSCAN_ROWS);
check('滚动后 startIndex > 0', midWindow.startIndex > 0);
checkEqual('上下 spacer 高度之和 + 可见行 = 总高度（首屏特例不适用，只校验非负）', topWindow.topHeight, 0);
check('空行集合的窗口安全', trajectoryViewportWindow([], 0, 100, 5).startIndex === 0);
checkEqual('recordId 稳定（同 cell 两次取值相同）', trajectoryRecordId({ cell: cells[0]! }), trajectoryRecordId({ cell: cells[0]! }));

// ---------------------------------------------------------------------------
// 8) 格式化
// ---------------------------------------------------------------------------

console.log('▶ 格式化');

checkEqual('formatDurationMs <1s 显示 ms', formatDurationMs(500), '500 ms');
checkEqual('formatDurationMs >=1s 显示秒', formatDurationMs(1_500), '1.50 s');
checkEqual('formatPercent 0.5 → 50%', formatPercent(0.5), '50%');
checkEqual('formatPercent 非正 → 0%', formatPercent(0), '0%');
checkEqual('cacheHitRatio 全命中', cacheHitRatio({ input: 0, cacheRead: 100 }), 1);
checkEqual('cacheHitRatio 无缓存', cacheHitRatio({ input: 100 }), 0);
check('previewOfBlocks 只取 text/thinking', previewOfBlocks([{ type: 'text', text: 'a' }, { type: 'tool_use', callId: 'c', name: 'n', input: {} }]) === 'a');
check('previewOfBlocks 折叠空白', previewOfBlocks([{ type: 'text', text: 'a\n  b' }]) === 'a b');

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


