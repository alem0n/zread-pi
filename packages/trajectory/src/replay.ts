/**
 * replay —— 把 RunEvent 流折叠成 TrajectorySnapshot。
 *
 * 与 dsh 的差异（见下方逐条注释）：
 * ① 无 Cordis / Assembler，折叠是对自有 JSONL 的单遍 replay；
 * ② turn 由 agent_start / agent_end 推导（一个 Agent = 一个 turn），
 *    而不是 user 消息边界 —— zread-pi 的 Agent 内部没有用户插话；
 * ③ 请求编号覆盖全部 Agent 的 assistant 消息 + 压缩，共用一个时间序编号空间；
 * ④ 「会话窗口」= 单个 run 目录，分页即文件 seq 分页。
 *
 * 归属键（session id）：并发 Agent（topics 按 section、page 按 p-limit）
 * 的事件在日志里交错，**每条事件自带 `agent.sessionId`**（全局唯一，
 * 同时是 pi 会话 id）。replay 以它为键把事件归进对应的 turn / 进行中消息，
 * 与事件到达顺序无关。`agent_end` 只结束自己那一份，不会影响仍在跑的其他
 * Agent（旧实现用单一 `current` 指针，会互相吞记录）。
 */

import type {
  AgentStartEvent,
  RunEvent,
  RunEventAgentMeta,
  RunJsonValue,
  RunTokenUsage,
} from '@zread-pi/types';
import { previewOfBlocks } from './format.js';
import {
  type SessionFacts,
  type SessionMessage,
  type SessionBlock,
  type SessionUsage,
  parseSessionLines,
  previewOfSessionMessage,
  sumSessionUsage,
  toolCallArguments,
} from './session.js';
import {
  type ReplayCompactedRecord,
  type ReplayContextRecord,
  type ReplayMessageRecord,
  type ReplayRecord,
  type ReplayToolRecord,
  type TrajectoryPartial,
  type TrajectoryPromptSnapshot,
  type TrajectoryRequestNumber,
  type TrajectoryRunSummary,
  type TrajectorySnapshot,
  type TrajectoryUsage,
} from './types.js';

interface TurnState {
  key: string;
  /** 归属键（agent.sessionId ?? agent.key）—— 并发区分用 */
  identity: string;
  number: number;
  role?: RunEventAgentMeta['role'];
  section?: string;
  pageSlug?: string;
  /** 该 turn 内的消息计数（step） */
  messages: number;
  /** agent_end 的 subtype（success / error_*） */
  endSubtype?: string;
  endError?: string;
  catalog: Map<string, string>;
}

interface InFlightMessage {
  /** 归属键（查 turns 用） */
  identity: string;
  step: number;
  startedAt: number;
  firstTokenAt?: number;
  preview: string;
  /** 尚未结算的 retry（挂在下一条 message_end 上） */
  pendingRetry?: { attempt: number; maxRetries: number; delayMs: number; error: string };
}

function addUsage(total: TrajectoryUsage | undefined, usage: RunTokenUsage | undefined): TrajectoryUsage | undefined {
  if (usage === undefined) return total;
  const next: TrajectoryUsage = { ...(total ?? {}) };
  next.input = (total?.input ?? 0) + usage.input_tokens;
  next.output = (total?.output ?? 0) + usage.output_tokens;
  next.cacheRead = (total?.cacheRead ?? 0) + (usage.cache_read_input_tokens ?? 0);
  next.cacheWrite = (total?.cacheWrite ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return next;
}

function usageOf(usage: RunTokenUsage | undefined): TrajectoryUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(usage.cache_read_input_tokens ? { cacheRead: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens ? { cacheWrite: usage.cache_creation_input_tokens } : {}),
  };
}

/** 事件的归属键：session id 优先；旧日志（无 sessionId）回退 agent.key */
function identityOf(agent: RunEventAgentMeta | undefined): string | undefined {
  if (agent === undefined) return undefined;
  return agent.sessionId ?? agent.key;
}

/** turn 标签：角色 + 分类 / 页面 */
function turnLabel(meta: Omit<RunEventAgentMeta, 'sessionId'>): string {
  const parts: string[] = [meta.role];
  if (meta.section) parts.push(meta.section);
  if (meta.pageSlug) parts.push(meta.pageSlug);
  return parts.join(' · ');
}

/** turn 标签（来自 TurnState） */
function labelOfTurn(turn: TurnState): string {
  const meta: Omit<RunEventAgentMeta, 'sessionId'> = {
    key: turn.key,
    role: turn.role ?? 'run',
    ...(turn.section ? { section: turn.section } : {}),
    ...(turn.pageSlug ? { pageSlug: turn.pageSlug } : {}),
  };
  return turnLabel(meta);
}

/** 把工具目录转成 name → schema JSON 的映射 */
function indexCatalog(toolCatalog: AgentStartEvent['toolCatalog']): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of toolCatalog) {
    map.set(
      tool.name,
      JSON.stringify({ name: tool.name, ...(tool.inputSchema as object) }, null, 2),
    );
  }
  return map;
}

/**
 * 单遍 replay：RunEvent[] → TrajectorySnapshot。
 *
 * @param events - 按 seq 排序的事件（未排序时会先排序，保证幂等）
 */
export function replayRunEvents(events: readonly RunEvent[]): TrajectorySnapshot {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);

  const records: ReplayRecord[] = [];
  /** identity → turn（一个 Agent 一个 turn；键 = agent.sessionId） */
  const turns = new Map<string, TurnState>();
  /** agent.key → identity（旧 record 的 turnKey 回查 turns 用） */
  const keyToIdentity = new Map<string, string>();
  let turnCounter = 0;
  /** 活跃 Agent：identity → turn（agent_end 后移除；并发 Agent 各占一格） */
  const activeTurns = new Map<string, TurnState>();
  /** 每 Agent 各自的进行中消息：identity → inFlight */
  const inFlightBySession = new Map<string, InFlightMessage>();
  const toolsByCallId = new Map<string, { record: ReplayToolRecord; identity: string }>();
  /** 每个 turn 内 tool_use callId → 父消息 step（工具挂到发出它的消息的分组） */
  const parentStepByCallId = new Map<string, number>();

  const runSummary: TrajectoryRunSummary = {
    status: 'running',
    stages: [],
    pages: { total: 0, completed: 0, failed: 0 },
  };

  const groupOf = (step: number): string => (step <= 1 ? 'Message' : `Step ${step}`);

  for (const event of ordered) {
    switch (event.kind) {
      case 'run_start': {
        const payload = event;
        runSummary.status = 'running';
        runSummary.kind = payload.runKind;
        if (payload.detail) runSummary.detail = payload.detail;
        runSummary.startedAt = event.ts;
        if (payload.model) (runSummary as TrajectoryRunSummary & { model?: string }).model = payload.model;
        break;
      }
      case 'run_end': {
        const payload = event;
        runSummary.status = payload.status;
        runSummary.endedAt = event.ts;
        runSummary.durationMs = payload.durationMs;
        if (payload.error) runSummary.error = payload.error;
        if (payload.usage) runSummary.usage = payload.usage;
        // run 收尾：一条 run 级 context 记录（阶段都已结束，归到 turn=null 的独立段）
        records.push({
          kind: 'context',
          seq: event.seq,
          ts: event.ts,
          turnKey: null,
          turn: null,
          group: 'Run',
          text: `Run ${payload.status} · ${payload.durationMs} ms`,
          ...(payload.error ? { isError: true } : {}),
        });
        break;
      }
      case 'agent_start': {
        const payload = event;
        const agent = event.agent;
        if (agent === undefined) break;
        const identity = identityOf(agent);
        if (identity === undefined) break;
        turnCounter += 1;
        const turn: TurnState = {
          key: agent.key,
          identity,
          number: turnCounter,
          role: agent.role,
          ...(agent.section ? { section: agent.section } : {}),
          ...(agent.pageSlug ? { pageSlug: agent.pageSlug } : {}),
          messages: 0,
          catalog: indexCatalog(payload.toolCatalog),
        };
        turns.set(identity, turn);
        keyToIdentity.set(agent.key, identity);
        activeTurns.set(identity, turn);

        const promptDetail: TrajectoryPromptSnapshot = {
          system: payload.systemPrompt ?? '',
          tools: payload.toolCatalog.map((tool) => ({
            name: tool.name,
            parameters: tool.inputSchema,
          })),
        };
        records.push({
          kind: 'system',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn.key,
          turn: turn.number,
          group: 'Message',
          text: 'Initial System Prompt',
          promptDetail,
        });
        records.push({
          kind: 'user',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn.key,
          turn: turn.number,
          group: 'Message',
          text: previewOfBlocks([{ type: 'text', text: payload.prompt }]) || 'Prompt',
          preview: payload.prompt,
          inputDetail: payload.prompt,
          sourceBlocks: [{ type: 'text', content: payload.prompt }],
        });
        break;
      }
      case 'agent_end': {
        const payload = event;
        const identity = identityOf(event.agent);
        const turn = identity !== undefined ? turns.get(identity) : undefined;
        if (turn) {
          turn.endSubtype = payload.subtype;
          // 非成功终态：在该 turn 的最后一条消息请求上标 error（对齐 dsh 的 turn 错误归属）
          if (payload.subtype !== 'success') turn.endError = payload.subtype;
        }
        if (identity !== undefined) {
          // 只结束自己那一份，不影响其他并发 Agent
          activeTurns.delete(identity);
          inFlightBySession.delete(identity);
        }
        break;
      }
      case 'message_start': {
        const payload = event;
        const identity = identityOf(event.agent);
        if (identity === undefined) break; // 无 agent 身份：无法归属
        const turn = activeTurns.get(identity);
        if (turn === undefined) break; // 未知 / 已结束的 Agent：丢弃，不误归给别人
        turn.messages += 1;
        inFlightBySession.set(identity, {
          identity,
          step: turn.messages,
          startedAt: event.ts,
          preview: payload.preview,
        });
        break;
      }
      case 'message_delta': {
        const payload = event;
        const identity = identityOf(event.agent);
        const inFlight = identity !== undefined ? inFlightBySession.get(identity) : undefined;
        if (inFlight) {
          if (inFlight.firstTokenAt === undefined) inFlight.firstTokenAt = event.ts;
          inFlight.preview = payload.preview;
        }
        break;
      }
      case 'message_end': {
        const payload = event;
        const identity = identityOf(event.agent);
        if (identity === undefined) break; // 无 agent 身份：无法归属
        const inFlight = inFlightBySession.get(identity);
        const turn = turns.get(identity);
        if (inFlight === undefined || turn === undefined) {
          // 没有对应 message_start（旧日志 / 流式丢失 / 本 Agent 已结束）：
          // 只在自己的 turn 上补一条，绝不归给别的 Agent
          if (turn) {
            turn.messages += 1;
            records.push({
              kind: 'message',
              seq: event.seq,
              ts: event.ts,
              turnKey: turn.key,
              turn: turn.number,
              group: groupOf(turn.messages),
              step: turn.messages,
              blocks: payload.blocks,
              ...(payload.usage ? { usage: payload.usage } : {}),
              ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
              ...(payload.contextWindow ? { contextWindow: payload.contextWindow } : {}),
              ...(payload.model ? { model: payload.model } : {}),
              ...(payload.provider ? { provider: payload.provider } : {}),
            });
            inFlightBySession.delete(identity);
          }
          break;
        }
        // 登记 callId → 父 step（工具记录随后据此归组）
        for (const block of payload.blocks) {
          if (block.type === 'tool_use' && typeof block.callId === 'string') {
            parentStepByCallId.set(block.callId, inFlight.step);
          }
        }
        records.push({
          kind: 'message',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn.key,
          turn: turn.number,
          group: groupOf(inFlight.step),
          step: inFlight.step,
          blocks: payload.blocks,
          startedAt: inFlight.startedAt,
          ...(inFlight.firstTokenAt !== undefined ? { firstTokenAt: inFlight.firstTokenAt } : {}),
          ...(inFlight.preview ? { preview: inFlight.preview } : {}),
          ...(payload.usage ? { usage: payload.usage } : {}),
          ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
          ...(payload.contextWindow ? { contextWindow: payload.contextWindow } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.provider ? { provider: payload.provider } : {}),
          ...(inFlight.pendingRetry ? { retry: inFlight.pendingRetry } : {}),
        });
        inFlightBySession.delete(identity);
        break;
      }
      case 'tool_start': {
        const payload = event;
        const identity = identityOf(event.agent);
        if (identity === undefined) break; // 无 agent 身份：无法归属
        const turn = activeTurns.get(identity);
        if (turn === undefined) break; // 未知 / 已结束的 Agent：丢弃
        const parentStep = parentStepByCallId.get(payload.callId) ?? turn.messages;
        const schema = turn.catalog.get(payload.name);
        const record: ReplayRecord = {
          kind: 'tool',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn.key,
          turn: turn.number,
          group: groupOf(parentStep),
          callId: payload.callId,
          name: payload.name,
          input: payload.input,
          running: true,
          parentStep,
          ...(schema ? { schemaDetail: schema } : {}),
        };
        toolsByCallId.set(payload.callId, { record, identity });
        records.push(record);
        break;
      }
      case 'tool_end': {
        const payload = event;
        const pending = toolsByCallId.get(payload.callId);
        if (!pending) {
          // 无 tool_start 的结果（旧日志）：按事件自己的 Agent 补一条
          const identity = identityOf(event.agent);
          const turn = identity !== undefined ? turns.get(identity) : undefined;
          if (turn) {
            const fallback: ReplayRecord = {
              kind: 'tool',
              seq: event.seq,
              ts: event.ts,
              turnKey: turn.key,
              turn: turn.number,
              group: groupOf(turn.messages),
              callId: payload.callId,
              name: payload.name ?? 'tool',
              output: payload.output,
              endedAt: event.ts,
              ...(payload.details ? { details: payload.details } : {}),
              ...(payload.isError ? { isError: true } : {}),
              parentStep: turn.messages,
            };
            records.push(fallback);
          }
          break;
        }
        const index = records.indexOf(pending.record);
        if (index !== -1) {
          const updated: ReplayToolRecord = {
            ...pending.record,
            running: false,
            endedAt: event.ts,
            output: payload.output,
            ...(payload.details ? { details: payload.details } : {}),
            ...(payload.name ? { name: payload.name } : {}),
            ...(payload.isError ? { isError: true } : {}),
          };
          records[index] = updated;
        }
        toolsByCallId.delete(payload.callId);
        break;
      }
      case 'retry': {
        const identity = identityOf(event.agent);
        const inFlight = identity !== undefined ? inFlightBySession.get(identity) : undefined;
        if (inFlight) {
          inFlight.pendingRetry = {
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            error: event.error,
          };
        }
        break;
      }
      case 'compact': {
        const payload = event;
        const identity = identityOf(event.agent);
        if (identity === undefined) break; // 无 agent 身份：无法归属
        const turn = activeTurns.get(identity);
        if (turn === undefined) break; // 压缩发生在未知的 Agent 上：丢弃
        records.push({
          kind: 'compacted',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn.key,
          turn: turn.number,
          group: `Compaction ${event.seq}`,
          ...(payload.summary ? { summary: payload.summary } : {}),
          running: payload.summary === undefined,
        });
        break;
      }
      case 'status': {
        const payload = event;
        const identity = identityOf(event.agent);
        const turn = identity !== undefined ? activeTurns.get(identity) : undefined;
        records.push({
          kind: 'context',
          seq: event.seq,
          ts: event.ts,
          turnKey: turn?.key ?? null,
          turn: turn?.number ?? null,
          group: turn ? groupOf(turn.messages) : 'Run',
          text: payload.text,
        });
        break;
      }
      case 'stage': {
        const payload = event;
        if (runSummary.stages[runSummary.stages.length - 1] !== payload.stage) {
          runSummary.stages.push(payload.stage);
        }
        break;
      }
      case 'section':
        // 分类注解：agent 元信息已携带 section，不单独产生记录
        break;
      case 'page_start': {
        // 页面 Agent 的身份在 agent_start 时已带 pageSlug，这里只记账
        runSummary.pages.total += 1;
        break;
      }
      case 'page_end': {
        const payload = event;
        if (payload.success) runSummary.pages.completed += 1;
        else runSummary.pages.failed += 1;
        if (!payload.success) {
          // 归到该页面的活跃 Agent（按 pageSlug 精确匹配）；找不到则 run 级
          const turn = [...activeTurns.values()].find((candidate) => candidate.pageSlug === payload.slug);
          records.push({
            kind: 'context',
            seq: event.seq,
            ts: event.ts,
            turnKey: turn?.key ?? null,
            turn: turn?.number ?? null,
            group: turn ? groupOf(turn.messages) : 'Run',
            text: `Page failed${payload.error ? `: ${payload.error}` : ''}`,
            isError: true,
          });
        }
        break;
      }
      case 'failed_sections': {
        const payload = event;
        // 阶段都已结束（由编排层在收尾时发出）：一律归 run 级独立段
        for (const entry of payload.sections) {
          records.push({
            kind: 'context',
            seq: event.seq,
            ts: event.ts,
            turnKey: null,
            turn: null,
            group: 'Run',
            text: `Section failed (${entry.stage}): ${entry.section} — ${entry.error}`,
            isError: true,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // 进行中的消息 → partial（流式帧；只知预览，不知完整内容）
  // 并发时可能同时有多个 Agent 在流式，取最后一个（顺序场景下只有一个）
  const flights = [...inFlightBySession.values()];
  let partial: TrajectoryPartial | null = null;
  if (flights.length > 0) {
    const inFlight = flights[flights.length - 1]!;
    const partialTurn = turns.get(inFlight.identity);
    partial = {
      turn: partialTurn?.number ?? null,
      step: inFlight.step,
      preview: inFlight.preview,
      blocks: [{ type: 'text', text: inFlight.preview }],
    };
  }

  // 请求编号：消息 + 压缩，共用一个时间序编号空间 + 累计 usage
  const requests = indexRequests(records, turns, keyToIdentity);

  // callSchemas：最后活跃的 Agent 目录（检查器兜底；工具记录自身已带 schemaDetail）
  const callSchemas = new Map<string, string>();
  for (const turn of turns.values()) {
    for (const [name, schema] of turn.catalog) callSchemas.set(name, schema);
  }

  const turnInfos = [...turns.values()].map((turn) => ({
    number: turn.number,
    key: turn.key,
    label: labelOfTurn(turn),
    sessionId: turn.identity,
    ...(turn.role ? { role: turn.role } : {}),
    ...(turn.section ? { section: turn.section } : {}),
    ...(turn.pageSlug ? { pageSlug: turn.pageSlug } : {}),
    ...(turn.endError ? { endError: turn.endError } : {}),
  }));

  return { records, requests, partial, callSchemas, turns: turnInfos, runSummary };
}

/** 请求统一编号 + 累计用量（压缩与普通消息共用编号空间） */
function indexRequests(
  records: readonly ReplayRecord[],
  turns: ReadonlyMap<string, TurnState>,
  keyToIdentity: ReadonlyMap<string, string>,
): TrajectoryRequestNumber[] {
  const numbered: TrajectoryRequestNumber[] = [];
  let cumulative: TrajectoryUsage | undefined;

  for (const record of records) {
    if (record.kind !== 'message' && record.kind !== 'compacted') continue;
    // record.turnKey 是 Agent key；turns 以 identity（sessionId）为键
    const turn =
      record.turnKey !== null
        ? (turns.get(keyToIdentity.get(record.turnKey) ?? record.turnKey) as TurnState | undefined)
        : undefined;
    const usage = usageOf(record.usage);
    cumulative = addUsage(cumulative, record.usage);

    if (record.kind === 'compacted') {
      numbered.push({
        seq: record.seq,
        turn: record.turn,
        step: 0,
        group: record.group,
        number: numbered.length + 1,
        purpose: 'compaction',
        status: record.running ? 'running' : record.error ? 'error' : 'complete',
        ...(record.running ? { completedAt: null } : { completedAt: record.ts }),
        startedAt: record.ts,
        ...(record.error ? { error: record.error } : {}),
        ...(usage ? { usage } : {}),
        ...(cumulative ? { cumulativeUsage: cumulative } : {}),
      });
      continue;
    }

    // 该 turn 的最后一条消息且 Agent 非成功终止 → 标 error
    const isTurnFailure =
      turn?.endError !== undefined && turn.messages === record.step && record.running !== true;

    numbered.push({
      seq: record.seq,
      turn: record.turn,
      step: record.step,
      group: record.group,
      number: numbered.length + 1,
      purpose: 'assistant',
      status: record.running ? 'running' : isTurnFailure ? 'error' : 'complete',
      startedAt: record.ts,
      ...(record.running ? { completedAt: null } : { completedAt: record.ts }),
      ...(record.retry ? { retry: record.retry.attempt, maxRetries: record.retry.maxRetries, retryDelayMs: record.retry.delayMs, error: record.retry.error } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.contextWindow ? { contextWindow: record.contextWindow } : {}),
      ...(usage ? { usage } : {}),
      ...(cumulative ? { cumulativeUsage: cumulative } : {}),
      ...(isTurnFailure && turn?.endError ? { error: turn.endError } : {}),
    });
  }

  return numbered;
}

// ============================================================================
// 方案 C：pi 会话 = 唯一完整事实源
//
// 内容（消息 / 工具调用 / 工具结果 / 用量 / 压缩摘要）全部从会话条目投影，
// events.jsonl 只提供业务边界（run / stage / section / page）与三个 harness
// 配置事实（agent_config：systemPrompt / toolCatalog / tokenBudget）+
// provider request id（provider_request）。turn 与会话按 sessionId join。
//
// 旧格式 run（无会话目录）仍走 replayRunEvents，历史日志可读。
// ============================================================================

interface SessionTurnState {
  key: string;
  identity: string;
  number: number;
  role?: RunEventAgentMeta['role'];
  section?: string;
  pageSlug?: string;
  messages: number;
  endSubtype?: string;
  endError?: string;
  catalog: Map<string, string>;
  /** 模型上下文窗口（agent_config 携带，供请求的 contextWindow） */
  contextWindow?: number;
  model?: string;
  provider?: string;
  /** 系统提示全文（agent_config 携带，system 记录的 promptDetail） */
  systemPrompt?: string;
  /** 用户提示词全文（agent_config 携带，user 记录） */
  prompt?: string;
  /** 该 turn 的会话事实；agent_config 与会话按 sessionId join */
  facts?: SessionFacts;
  /** turn 块的开始时刻（把 turn 块与 run 级记录按时间排序用） */
  startedAt: number;
  /** turn 内的 provider_request 记录（排障关联，追加在会话内容之后） */
  requestRecords: ReplayContextRecord[];
}

/**
 * 解析事件到自己所属的 turn。
 *
 * agent_config 建立的是「会话身份」键（agent.sessionId ?? agent.key）。
 * 后续事件由 sink 绑定身份：create-agent 在 init 后能拿到 sessionId
 * （agent_config / provider_request 携带），但 agent_end / page_end 只有
 * key/role —— 这里对两个键都查，保证它们仍能归回自己建立的 turn。
 * 并发 Agent 的 key 本身就互异，回退不会误归。
 */
function resolveTurnIdentity(
  agent: RunEventAgentMeta | undefined,
  turns: ReadonlyMap<string, unknown>,
  keyToIdentity: ReadonlyMap<string, string>,
): string | undefined {
  if (agent === undefined) return undefined;
  if (agent.sessionId !== undefined && turns.has(agent.sessionId)) return agent.sessionId;
  const byKey = keyToIdentity.get(agent.key);
  if (byKey !== undefined && turns.has(byKey)) return byKey;
  // 旧日志（无 sessionId）：identity 就是 key 本身
  return turns.has(agent.key) ? agent.key : undefined;
}

function usageOfSession(usage: SessionUsage | undefined): RunTokenUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(usage.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
  };
}

/** 会话内容块 → replay 的消息块（与旧 message_end 的块形状对齐） */
function mapSessionBlocks(
  blocks: SessionBlock[],
): Array<{ type: string; text?: string; callId?: string; name?: string; input?: RunJsonValue }> {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', text: block.thinking };
    if (block.type === 'image') return { type: 'image' };
    return {
      type: 'tool_use',
      callId: block.id,
      name: block.name,
      input: toolCallArguments(block) as RunJsonValue,
    };
  });
}

/** toolResult 消息的输出文本（存储格式：role=toolResult 的独立消息） */
function toolResultOutput(message: SessionMessage | undefined): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  const blocks: SessionBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text === '' ? undefined : text;
}

/**
 * 从「会话条目 + 瘦业务事件」投影快照。
 *
 * - events.jsonl 提供 run / agent_config / agent_end / stage / section /
 *   page_* / failed_sections / scan_* / provider_request / run_end
 * - 会话条目提供消息正文 / 工具调用与结果 / 每响应用量 / 压缩摘要
 * - 一个 Agent 一个会话文件，并发归属结构性成立（无交错事件需要解析）
 */
function replayFromSessions(
  events: readonly RunEvent[],
  sessions: readonly SessionFacts[],
): TrajectorySnapshot {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const factsBySession = new Map(sessions.map((facts) => [facts.sessionId, facts]));

  const turns = new Map<string, SessionTurnState>();
  const keyToIdentity = new Map<string, string>();
  let turnCounter = 0;
  /** run 级独立记录（scan / failed_sections / run_end …），按 ts 与 turn 块排序 */
  const runLevel: Array<{ ts: number; record: ReplayRecord }> = [];

  const runSummary: TrajectoryRunSummary = {
    status: 'running',
    stages: [],
    pages: { total: 0, completed: 0, failed: 0 },
  };

  const groupOf = (step: number): string => (step <= 1 ? 'Message' : `Step ${step}`);

  for (const event of ordered) {
    switch (event.kind) {
      case 'run_start': {
        const payload = event;
        runSummary.status = 'running';
        runSummary.kind = payload.runKind;
        if (payload.detail) runSummary.detail = payload.detail;
        runSummary.startedAt = event.ts;
        if (payload.model) (runSummary as TrajectoryRunSummary & { model?: string }).model = payload.model;
        break;
      }
      case 'run_end': {
        const payload = event;
        runSummary.status = payload.status;
        runSummary.endedAt = event.ts;
        runSummary.durationMs = payload.durationMs;
        if (payload.error) runSummary.error = payload.error;
        if (payload.usage) runSummary.usage = payload.usage;
        runLevel.push({
          ts: event.ts,
          record: {
            kind: 'context',
            seq: 0,
            ts: event.ts,
            turnKey: null,
            turn: null,
            group: 'Run',
            text: `Run ${payload.status} · ${payload.durationMs} ms`,
            ...(payload.error ? { isError: true } : {}),
          },
        });
        break;
      }
      case 'agent_config': {
        const payload = event;
        const agent = event.agent;
        if (agent === undefined) break;
        const identity = agent.sessionId ?? agent.key;
        turnCounter += 1;
        const turn: SessionTurnState = {
          key: agent.key,
          identity,
          number: turnCounter,
          role: agent.role,
          ...(agent.section ? { section: agent.section } : {}),
          ...(agent.pageSlug ? { pageSlug: agent.pageSlug } : {}),
          messages: 0,
          catalog: indexCatalog(payload.toolCatalog),
          startedAt: event.ts,
          requestRecords: [],
        };
        if (payload.model) turn.model = payload.model;
        if (payload.provider) turn.provider = payload.provider;
        if (typeof payload.systemPrompt === 'string') turn.systemPrompt = payload.systemPrompt;
        if (typeof payload.prompt === 'string') turn.prompt = payload.prompt;
        if (payload.contextWindow !== undefined) turn.contextWindow = payload.contextWindow;
        turns.set(identity, turn);
        keyToIdentity.set(agent.key, identity);
        const facts = factsBySession.get(identity);
        if (facts !== undefined) turn.facts = facts;
        break;
      }
      case 'agent_end': {
        const identity = resolveTurnIdentity(event.agent, turns, keyToIdentity);
        const turn = identity !== undefined ? turns.get(identity) : undefined;
        if (turn) {
          turn.endSubtype = event.subtype;
          if (event.subtype !== 'success') turn.endError = event.subtype;
        }
        break;
      }
      case 'provider_request': {
        // 排障关联：挂在自己的 turn 上（run 级事件归 run）。一 Agent 多响应，
        // 每个响应一条事件，全部保留（挂 agent_end 只能留最后一个）。
        const identity = resolveTurnIdentity(event.agent, turns, keyToIdentity);
        const turn = identity !== undefined ? turns.get(identity) : undefined;
        const record: ReplayContextRecord = {
          kind: 'context',
          seq: 0,
          ts: event.ts,
          turnKey: turn?.key ?? null,
          turn: turn?.number ?? null,
          group: turn ? groupOf(turn.messages) : 'Run',
          text: `provider request ${event.requestId}`,
        };
        if (turn !== undefined) turn.requestRecords.push(record);
        else runLevel.push({ ts: event.ts, record });
        break;
      }
      case 'scan_start': {
        runLevel.push({
          ts: event.ts,
          record: { kind: 'context', seq: 0, ts: event.ts, turnKey: null, turn: null, group: 'Run', text: 'Scanning repository' },
        });
        break;
      }
      case 'scan_end': {
        runLevel.push({
          ts: event.ts,
          record: {
            kind: 'context',
            seq: 0,
            ts: event.ts,
            turnKey: null,
            turn: null,
            group: 'Run',
            text: `Scan complete${event.fileCount !== undefined ? ` · ${event.fileCount} files` : ''}`,
          },
        });
        break;
      }
      case 'stage': {
        if (runSummary.stages[runSummary.stages.length - 1] !== event.stage) {
          runSummary.stages.push(event.stage);
        }
        break;
      }
      case 'section':
        break;
      case 'page_start':
        runSummary.pages.total += 1;
        break;
      case 'page_end': {
        if (event.success) runSummary.pages.completed += 1;
        else runSummary.pages.failed += 1;
        if (!event.success) {
          const identity = resolveTurnIdentity(event.agent, turns, keyToIdentity);
          const turn = identity !== undefined ? turns.get(identity) : undefined;
          runLevel.push({
            ts: event.ts,
            record: {
              kind: 'context',
              seq: 0,
              ts: event.ts,
              turnKey: turn?.key ?? null,
              turn: turn?.number ?? null,
              group: 'Run',
              text: `Page failed${event.error ? `: ${event.error}` : ''}`,
              isError: true,
            },
          });
        }
        break;
      }
      case 'failed_sections': {
        for (const entry of event.sections) {
          runLevel.push({
            ts: event.ts,
            record: {
              kind: 'context',
              seq: 0,
              ts: event.ts,
              turnKey: null,
              turn: null,
              group: 'Run',
              text: `Section failed (${entry.stage}): ${entry.section} — ${entry.error}`,
              isError: true,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // ----------------------------------------------------------------
  // 会话内容 → turn 内记录（一个 Agent 一个会话，无交错）
  // ----------------------------------------------------------------
  const turnBlocks: Array<{ ts: number; records: ReplayRecord[] }> = [];

  for (const turn of turns.values()) {
    const records: ReplayRecord[] = [];

    // system + user（prompt）来自 agent_config
    records.push({
      kind: 'system',
      seq: 0,
      ts: turn.startedAt,
      turnKey: turn.key,
      turn: turn.number,
      group: 'Message',
      text: 'Initial System Prompt',
      promptDetail: {
        system: turn.systemPrompt ?? '',
        tools: [...turn.catalog.entries()].map(([name, schema]) => {
          const parsed = JSON.parse(schema) as { name?: string } & RunJsonValue;
          return { name, parameters: parsed as RunJsonValue };
        }),
      },
    });
    if (turn.prompt !== undefined) {
      records.push({
        kind: 'user',
        seq: 0,
        ts: turn.startedAt,
        turnKey: turn.key,
        turn: turn.number,
        group: 'Message',
        text: previewOfBlocks([{ type: 'text', text: turn.prompt }]) || 'Prompt',
        preview: turn.prompt,
        inputDetail: turn.prompt,
        sourceBlocks: [{ type: 'text', content: turn.prompt }],
      });
    }

    const pendingTools = new Map<string, ReplayToolRecord>();
    let step = 0;

    if (turn.facts !== undefined) {
      for (const entry of turn.facts.entries) {
        if (entry.type === 'compaction') {
          records.push({
            kind: 'compacted',
            seq: 0,
            ts: entry.timestamp,
            turnKey: turn.key,
            turn: turn.number,
            group: `Compaction ${entry.seq}`,
            ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}),
            ...(usageOfSession(entry.usage) ? { usage: usageOfSession(entry.usage) } : {}),
            running: false,
          });
          continue;
        }
        if (entry.type !== 'message' || entry.message === undefined) continue;
        const message = entry.message;

        if (message.role === 'assistant') {
          step += 1;
          const content: SessionBlock[] =
            typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
          // 工具调用块先建记录（与发出它的消息同组）
          for (const block of content) {
            if (block.type !== 'toolCall') continue;
            const schema = turn.catalog.get(block.name);
            const toolRecord: ReplayToolRecord = {
              kind: 'tool',
              seq: 0,
              ts: entry.timestamp,
              turnKey: turn.key,
              turn: turn.number,
              group: groupOf(step),
              callId: block.id,
              name: block.name,
              input: toolCallArguments(block) as RunJsonValue,
              running: true,
              parentStep: step,
              ...(schema ? { schemaDetail: schema } : {}),
            };
            pendingTools.set(block.id, toolRecord);
            records.push(toolRecord);
          }
          records.push({
            kind: 'message',
            seq: 0,
            ts: entry.timestamp,
            turnKey: turn.key,
            turn: turn.number,
            group: groupOf(step),
            step,
            blocks: mapSessionBlocks(content),
            preview: previewOfSessionMessage(message),
            ...(usageOfSession(message.usage) ? { usage: usageOfSession(message.usage) } : {}),
            ...(message.model ? { model: message.model } : turn.model ? { model: turn.model } : {}),
            ...(message.provider ? { provider: message.provider } : turn.provider ? { provider: turn.provider } : {}),
            ...(turn.contextWindow !== undefined ? { contextWindow: turn.contextWindow } : {}),
          });
        } else if (message.role === 'toolResult') {
          const pending = message.toolCallId !== undefined ? pendingTools.get(message.toolCallId) : undefined;
          const output = toolResultOutput(message);
          if (pending !== undefined) {
            pending.running = false;
            pending.endedAt = entry.timestamp;
            if (output !== undefined) pending.output = output;
            pendingTools.delete(pending.callId);
          } else {
            records.push({
              kind: 'tool',
              seq: 0,
              ts: entry.timestamp,
              turnKey: turn.key,
              turn: turn.number,
              group: groupOf(step),
              callId: message.toolCallId ?? 'unknown',
              name: message.toolName ?? 'tool',
              output,
              endedAt: entry.timestamp,
              parentStep: step,
            });
          }
        }
        // user 消息即 agent_config 的 prompt，不重复投影
      }
    }

    // 排障 request id 追加在 turn 内容之后
    records.push(...turn.requestRecords);
    // 会话内 assistant 消息数（indexSessionRequests 的失败归属判据用）
    turn.messages = step;

    turnBlocks.push({ ts: turn.startedAt, records });
  }

  // ----------------------------------------------------------------
  // 全局排序（turn 块按开始时刻与 run 级记录排序）+ seq 分配
  // ----------------------------------------------------------------
  const all: Array<{ ts: number; records: ReplayRecord[] }> = [
    ...runLevel.map((entry) => ({ ts: entry.ts, records: [entry.record] })),
    ...turnBlocks,
  ];
  all.sort((left, right) => {
    const byTime = left.ts - right.ts;
    return byTime !== 0 ? byTime : 0;
  });

  const records: ReplayRecord[] = [];
  let seq = 0;
  for (const block of all) {
    for (const record of block.records) {
      seq += 1;
      records.push({ ...record, seq });
    }
  }

  // 用量合计：优先读会话 usage 行（harness ledger 权威累计）
  const sessionUsage = sessions.length > 0 ? sumSessionUsage(sessions.flatMap((facts) => facts.usageRows)) : undefined;
  if (sessionUsage !== undefined && sessionUsage.totalTokens > 0) {
    runSummary.usage = {
      input_tokens: sessionUsage.input,
      output_tokens: sessionUsage.output,
      ...(sessionUsage.cacheRead ? { cache_read_input_tokens: sessionUsage.cacheRead } : {}),
      ...(sessionUsage.cacheWrite ? { cache_creation_input_tokens: sessionUsage.cacheWrite } : {}),
    };
  }

  const requestRecords = records.filter(
    (record): record is ReplayMessageRecord | ReplayCompactedRecord =>
      record.kind === 'message' || record.kind === 'compacted',
  );
  const requests = indexSessionRequests(requestRecords, turns, keyToIdentity);

  const callSchemas = new Map<string, string>();
  for (const turn of turns.values()) {
    for (const [name, schema] of turn.catalog) callSchemas.set(name, schema);
  }

  const turnInfos = [...turns.values()].map((turn) => ({
    number: turn.number,
    key: turn.key,
    label: turnLabel({
      key: turn.key,
      role: turn.role ?? 'run',
      ...(turn.section ? { section: turn.section } : {}),
      ...(turn.pageSlug ? { pageSlug: turn.pageSlug } : {}),
    }),
    sessionId: turn.identity,
    ...(turn.role ? { role: turn.role } : {}),
    ...(turn.section ? { section: turn.section } : {}),
    ...(turn.pageSlug ? { pageSlug: turn.pageSlug } : {}),
    ...(turn.endError ? { endError: turn.endError } : {}),
  }));

  return { records, requests, partial: null, callSchemas, turns: turnInfos, runSummary };
}

/** 会话路径的请求编号 + 累计用量（与旧路径同口径） */
function indexSessionRequests(
  records: readonly (ReplayMessageRecord | ReplayCompactedRecord)[],
  turns: ReadonlyMap<string, SessionTurnState>,
  keyToIdentity: ReadonlyMap<string, string>,
): TrajectoryRequestNumber[] {
  const numbered: TrajectoryRequestNumber[] = [];
  let cumulative: TrajectoryUsage | undefined;

  for (const record of records) {
    const turn =
      record.turnKey !== null
        ? (turns.get(keyToIdentity.get(record.turnKey) ?? record.turnKey) as SessionTurnState | undefined)
        : undefined;
    const usage = usageOf(record.usage);
    cumulative = addUsage(cumulative, record.usage);

    if (record.kind === 'compacted') {
      numbered.push({
        seq: record.seq,
        turn: record.turn,
        step: 0,
        group: record.group,
        number: numbered.length + 1,
        purpose: 'compaction',
        status: record.running ? 'running' : record.error ? 'error' : 'complete',
        ...(record.running ? { completedAt: null } : { completedAt: record.ts }),
        startedAt: record.ts,
        ...(record.error ? { error: record.error } : {}),
        ...(usage ? { usage } : {}),
        ...(cumulative ? { cumulativeUsage: cumulative } : {}),
      });
      continue;
    }

    const isTurnFailure = turn?.endError !== undefined && turn.messages === record.step && record.running !== true;
    numbered.push({
      seq: record.seq,
      turn: record.turn,
      step: record.step,
      group: record.group,
      number: numbered.length + 1,
      purpose: 'assistant',
      status: record.running ? 'running' : isTurnFailure ? 'error' : 'complete',
      startedAt: record.ts,
      ...(record.running ? { completedAt: null } : { completedAt: record.ts }),
      ...(record.model ? { model: record.model } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.contextWindow ? { contextWindow: record.contextWindow } : {}),
      ...(usage ? { usage } : {}),
      ...(cumulative ? { cumulativeUsage: cumulative } : {}),
      ...(isTurnFailure && turn?.endError ? { error: turn.endError } : {}),
    });
  }

  return numbered;
}

/**
 * 统一入口：有会话事实时从会话投影（方案 C），否则走旧事件 replay（历史 run）。
 *
 * 内容只在会话里，故新 run 的 events.jsonl 不含 message_* / tool_* 等内容事件；
 * 旧 run 没有会话目录，由 replayRunEvents 解析历史 kind。
 */
export function replayRun(input: {
  events: readonly RunEvent[];
  sessions?: readonly SessionFacts[];
}): TrajectorySnapshot {
  const sessions = input.sessions ?? [];
  if (sessions.length > 0) return replayFromSessions(input.events, sessions);
  return replayRunEvents(input.events);
}

/**
 * run 级摘要的 digest（纯函数，不含内容）：从业务事件 + 会话用量投影
 * 「名字 / 大小 / 耗时 / 用量」，供 run 列表 / telemetry 等不需要正文的视图。
 */
export interface RunDigest {
  status: TrajectoryRunSummary['status'];
  kind?: TrajectoryRunSummary['kind'];
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Agent 数（= 会话数） */
  agentCount: number;
  /** 消息条目总数（会话投影） */
  messageCount: number;
  /** 用量合计（会话 usage 行；无会话时回退 run_end.usage） */
  usage?: RunTokenUsage;
}

export function summarizeRunEvents(
  events: readonly RunEvent[],
  sessions?: readonly SessionFacts[],
): RunDigest {
  const digest: RunDigest = { status: 'running', agentCount: 0, messageCount: 0 };
  let endUsage: RunTokenUsage | undefined;

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.kind === 'run_start') {
      digest.kind = event.runKind;
      if (event.detail) digest.detail = event.detail;
      digest.startedAt = event.ts;
    } else if (event.kind === 'run_end') {
      digest.status = event.status;
      digest.endedAt = event.ts;
      digest.durationMs = event.durationMs;
      if (event.usage) endUsage = event.usage;
    }
  }

  if (sessions !== undefined && sessions.length > 0) {
    digest.agentCount = sessions.length;
    const totals = sumSessionUsage(sessions.flatMap((facts) => facts.usageRows));
    digest.messageCount = sessions.reduce(
      (count, facts) => count + facts.entries.filter((entry) => entry.type === 'message').length,
      0,
    );
    if (totals.totalTokens > 0) {
      digest.usage = {
        input_tokens: totals.input,
        output_tokens: totals.output,
        ...(totals.cacheRead ? { cache_read_input_tokens: totals.cacheRead } : {}),
        ...(totals.cacheWrite ? { cache_creation_input_tokens: totals.cacheWrite } : {}),
      };
    }
  }
  if (digest.usage === undefined) digest.usage = endUsage;

  return digest;
}

/** 解析会话文本行（便捷导出：服务端读取后直接调用，不依赖 node） */
export { parseSessionLines };
