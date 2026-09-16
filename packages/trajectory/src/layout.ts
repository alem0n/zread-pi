/**
 * layout —— 把 replay 的记录折叠成 turn → group → cell 的展示模型。
 *
 * 对齐 dsh 的 deriveTrajectoryLayout / appendTrajectoryPartialLayout 语义，
 * 但输入是 TrajectorySnapshot（RunEvent 的单遍 replay 产物），没有 dsh 的
 * node / location / steering / subcall 分支。
 */

import { formatElapsedSeconds } from './format.js';
import type {
  ReplayCompactedRecord,
  ReplayContextRecord,
  ReplayMessageRecord,
  ReplayRecord,
  ReplaySystemRecord,
  ReplayToolRecord,
  ReplayUserRecord,
  TrajectoryCellProps,
  TrajectorySnapshot,
  TrajectorySourceBlock,
  TrajectoryTurnModel,
} from './types.js';

interface LaidCell {
  cell: TrajectoryCellProps;
  absTime: number | null;
  toolName?: string;
  callId?: string;
}

interface LaidGroup {
  title: string;
  laid: LaidCell[];
}

interface TurnBucket {
  number: number | null;
  label: string;
  groups: LaidGroup[];
}

function finiteTime(time: number | null | undefined): number | null {
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function durationSeconds(later: number | null, earlier: number | null): number | null {
  if (earlier === null || later === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.max(0, (later - earlier) / 1000);
}

function attachUsage(cell: TrajectoryCellProps, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void {
  if (usage === undefined) return;
  cell.input = usage.input_tokens;
  cell.output = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) cell.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) cell.cacheWrite = usage.cache_creation_input_tokens;
}

function sourceBlockOf(block: { type: string; text?: string; callId?: string; name?: string; input?: unknown }): TrajectorySourceBlock {
  if (block.type === 'text' || block.type === 'thinking') {
    return { type: block.type === 'thinking' ? 'thinking' : 'text', content: block.text ?? '' };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool-call',
      content: block.input === undefined ? '' : JSON.stringify(block.input, null, 2),
      ...(typeof block.callId === 'string' ? { callId: block.callId } : {}),
      ...(typeof block.name === 'string' ? { toolName: block.name } : {}),
    };
  }
  return { type: block.type, content: block.input === undefined ? '' : JSON.stringify(block.input) };
}

/** Message / user 记录的单行展示文本 */
function messagePreview(record: ReplayMessageRecord | ReplayUserRecord): string {
  if (record.kind === 'user') return record.text;
  const text = record.blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join(' ');
  if (text.trim() !== '') return text.replace(/\s+/g, ' ').trim();
  const thinking = record.blocks
    .filter((block) => block.type === 'thinking' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join(' ');
  return thinking.replace(/\s+/g, ' ').trim();
}

function toolCallSummary(name: string, input: unknown): { text: string; previewMarkdown?: string } {
  const args = input === undefined ? '' : JSON.stringify(input, null, 2);
  return { text: name, ...(args === '' || args === '{}' ? {} : { previewMarkdown: args }) };
}

function resultSummary(output: string | undefined, isError: boolean | undefined): { result?: string; resultPreviewMarkdown?: string } {
  if (isError) return { result: output === undefined ? 'error' : output.split('\n')[0] };
  if (output === undefined) return {};
  const firstLine = output.split('\n')[0] ?? '';
  return { result: '', resultPreviewMarkdown: firstLine };
}

/**
 * 把快照折叠成 turn 列表（按首次出现排序）。
 */
export function deriveTrajectoryLayout(snapshot: TrajectorySnapshot): readonly TrajectoryTurnModel[] {
  const turns = new Map<number, TurnBucket>();
  const standalone: TurnBucket[] = [];
  let index = 0;

  const bucket = (record: ReplayRecord): TurnBucket | undefined => {
    if (record.turn === null) {
      let entry = standalone.find((candidate) => candidate.number === null);
      if (entry === undefined) {
        entry = { number: null, label: 'Between turns', groups: [] };
        standalone.push(entry);
      }
      return entry;
    }
    let entry = turns.get(record.turn);
    if (entry === undefined) {
      entry = { number: record.turn, label: `Turn ${record.turn}`, groups: [] };
      turns.set(record.turn, entry);
    }
    return entry;
  };

  const pushCell = (record: ReplayRecord, laid: LaidCell): void => {
    const entry = bucket(record);
    if (entry === undefined) return;
    const group = entry.groups.find((candidate) => candidate.title === record.group);
    if (group === undefined) {
      entry.groups.push({ title: record.group, laid: [laid] });
    } else {
      group.laid.push(laid);
    }
  };

  for (const record of snapshot.records) {
    const absTime = finiteTime(record.ts);

    if (record.kind === 'system') {
      const system = record as ReplaySystemRecord;
      pushCell(record, {
        absTime,
        cell: {
          index: ++index,
          recordId: `system\u0000${record.turnKey ?? 'run'}`,
          kind: 'system',
          text: system.text,
          sourceSeq: record.seq,
          promptDetail: system.promptDetail,
          timeSeconds: 0,
          startedAt: absTime,
        },
      });
      continue;
    }

    if (record.kind === 'user') {
      const user = record as ReplayUserRecord;
      pushCell(record, {
        absTime,
        cell: {
          index: ++index,
          recordId: `user\u0000${record.turnKey ?? 'run'}`,
          kind: 'user',
          text: messagePreview(user),
          ...(user.inputDetail !== '' ? { previewMarkdown: user.inputDetail } : {}),
          sourceSeq: record.seq,
          inputDetail: user.inputDetail,
          sourceBlocks: user.sourceBlocks,
          opensTurn: true,
          timeSeconds: 0,
          startedAt: absTime,
        },
      });
      continue;
    }

    if (record.kind === 'context') {
      const context = record as ReplayContextRecord;
      pushCell(record, {
        absTime,
        cell: {
          index: ++index,
          recordId: `context\u0000${record.seq}`,
          kind: 'context',
          text: context.text,
          sourceSeq: record.seq,
          ...(context.isError ? { isError: true } : {}),
          timeSeconds: 0,
          startedAt: absTime,
        },
      });
      continue;
    }

    if (record.kind === 'compacted') {
      const compacted = record as ReplayCompactedRecord;
      const cell: TrajectoryCellProps = {
        index: ++index,
        recordId: `compacted\u0000${record.seq}`,
        kind: 'compacted',
        text: compacted.running ? 'Compacting context…' : compacted.summary ?? 'Context compacted',
        ...(compacted.summary ? { previewMarkdown: compacted.summary, outputDetail: compacted.summary } : {}),
        sourceSeq: record.seq,
        timeSeconds: null,
        startedAt: absTime,
      };
      attachUsage(cell, compacted.usage);
      pushCell(record, { absTime, cell });
      continue;
    }

    if (record.kind === 'message') {
      const message = record as ReplayMessageRecord;
      const textBlocks = message.blocks.filter((block) => block.type === 'text');
      const thinkingBlocks = message.blocks.filter((block) => block.type === 'thinking');
      const outputDetail = textBlocks.map((block) => block.text ?? '').join('\n\n');
      const thinkingDetail = thinkingBlocks.map((block) => block.text ?? '').join('\n\n');
      const preview = message.preview ?? messagePreview(message);
      const completedAt = message.running ? null : absTime;
      const startedAt = finiteTime(message.startedAt) ?? absTime;
      const firstTokenAt = finiteTime(message.firstTokenAt) ?? null;

      const cell: TrajectoryCellProps = {
        index: ++index,
        recordId: `message\u0000${record.turnKey ?? 'run'}\u0000${message.step}`,
        kind: 'message',
        sourceSeq: record.seq,
        text: preview !== '' ? preview : summarizeAssistantActivity(message.blocks),
        ...(preview !== '' ? { previewMarkdown: preview } : {}),
        ...(outputDetail !== '' ? { outputDetail } : {}),
        ...(thinkingDetail !== '' ? { thinkingDetail } : {}),
        sourceBlocks: message.blocks.map((block) => sourceBlockOf(block)),
        timeSeconds: message.running ? null : durationSeconds(absTime, startedAt),
        startedAt,
      };
      attachUsage(cell, message.usage);
      cell.assistantMetrics = {
        timingRecorded: message.startedAt !== undefined,
        stepStartTime: startedAt,
        firstTokenTime: firstTokenAt,
        completedTime: completedAt,
        usageProvided: message.usage !== undefined,
        outputTokens: message.usage ? message.usage.output_tokens : null,
      };
      pushCell(record, { absTime: message.running ? null : absTime, cell });
      continue;
    }

    // tool
    const tool = record as ReplayToolRecord;
    const argsText = tool.input === undefined ? '' : JSON.stringify(tool.input, null, 2);
    const summary = toolCallSummary(tool.name, tool.input);
    const result = resultSummary(tool.output, tool.isError);
    pushCell(record, {
      absTime: finiteTime(record.ts),
      toolName: tool.name,
      callId: tool.callId,
      cell: {
        index: ++index,
        recordId: `tool\u0000${tool.callId}`,
        kind: tool.kind === 'subtool' ? 'subtool' : 'tool',
        sourceSeq: record.seq,
        ...summary,
        inputDetail: argsText === '' ? undefined : argsText,
        ...(tool.output !== undefined
          ? { outputDetail: tool.output, outputBlocks: [{ type: 'text', content: tool.output }] }
          : {}),
        ...result,
        ...(tool.schemaDetail ? { schemaDetail: tool.schemaDetail } : {}),
        callId: tool.callId,
        ...(tool.isError ? { isError: true } : {}),
        timeSeconds: tool.running ? null : durationSeconds(tool.endedAt ?? null, record.ts),
        startedAt: absTime,
      },
    });
  }

  // 回填 turn 标签（一个 Agent = 一个 turn；turn=null 为 turn 之间的独立段）
  const labels = new Map<number, string>();
  for (const info of snapshot.turns) labels.set(info.number, info.label);

  return [
    ...[...turns.entries()].map(([number, entry]) =>
      toTurnModel(number, labels.get(number) ?? entry.label, entry),
    ),
    ...standalone.map((entry) => toTurnModel(null, entry.label, entry)),
  ].sort((left, right) => firstCellIndex(left) - firstCellIndex(right));
}

/** 「只有工具调用」的助手消息摘要 */
function summarizeAssistantActivity(blocks: ReadonlyArray<{ type: string }>): string {
  const tools = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    const name = (block as { name?: string }).name ?? 'tool';
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return tools.size > 0 ? 'Tool call only' : '';
}

function firstCellIndex(turn: TrajectoryTurnModel): number {
  return Math.min(
    ...turn.groups.flatMap((group) => group.cells.map((cell) => cell.index)),
    Number.POSITIVE_INFINITY,
  );
}

function toTurnModel(number: number | null, label: string, entry: TurnBucket): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryTurnModel['groups'][number] => {
    const description = groupDescription(laid);
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map((item) => item.cell),
    };
  });
  return { turn: number, label, groups };
}

/** 组的墙钟跨度 + 工具直方图，如 `1.5 s read×3` */
function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = [];
  const times: number[] = [];
  for (const item of laid) {
    if (item.absTime === null || !Number.isFinite(item.absTime)) continue;
    times.push(item.absTime);
    if (item.cell.kind === 'tool' && item.cell.timeSeconds !== null && Number.isFinite(item.cell.timeSeconds)) {
      times.push(item.absTime + item.cell.timeSeconds * 1000);
    }
  }
  if (times.length >= 2) {
    parts.push(formatElapsedSeconds((Math.max(...times) - Math.min(...times)) / 1000));
  } else if (times.length === 1) {
    const own = laid.find((item) => item.absTime === times[0])?.cell.timeSeconds;
    if (own !== null && own !== undefined && Number.isFinite(own)) {
      parts.push(formatElapsedSeconds(own));
    }
  }
  const tools = new Map<string, number>();
  for (const item of laid) {
    if (item.toolName === undefined || item.cell.kind !== 'tool') continue;
    tools.set(item.toolName, (tools.get(item.toolName) ?? 0) + 1);
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name);
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * 把流式中的助手单元格追加到已完成的布局（共享未受影响的 turn / group）。
 */
export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  partial: TrajectorySnapshot['partial'],
  lastIndex: number,
): readonly TrajectoryTurnModel[] {
  if (partial === null) return turns;
  const preview = partial.preview;
  const cell: TrajectoryCellProps = {
    index: lastIndex + 1,
    recordId: `message\u0000partial\u0000${partial.turn ?? 'run'}\u0000${partial.step}`,
    kind: 'message',
    text: preview,
    ...(preview !== '' ? { previewMarkdown: preview } : {}),
    timeSeconds: null,
    startedAt: null,
  };
  const group = partial.step <= 1 ? 'Message' : `Step ${partial.step}`;
  const streamed: TrajectoryTurnModel = {
    turn: partial.turn,
    label: partial.turn === null ? 'Between turns' : `Turn ${partial.turn}`,
    groups: [{ title: group, cells: [cell] }],
  };

  const turnIndex = turns.findIndex((turn) => turn.turn === streamed.turn);
  if (turnIndex === -1) return [...turns, streamed];

  const current = turns[turnIndex];
  if (current === undefined) return turns;
  const groups = [...current.groups];
  const groupIndex = groups.findIndex((candidate) => candidate.title === group);
  if (groupIndex === -1) {
    groups.push(streamed.groups[0]!);
  } else {
    const existing = groups[groupIndex]!;
    groups[groupIndex] = {
      ...existing,
      cells: [
        // 流式单元格替换同位的「请求占位」记录
        ...existing.cells.filter((candidate) => candidate.requestOnly !== true),
        cell,
      ],
    };
  }
  const updated = [...turns];
  updated[turnIndex] = { ...current, groups };
  return updated;
}
