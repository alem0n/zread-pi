/**
 * RunLogWriter —— 一次运行的可回放日志写入器。
 *
 * - events.jsonl：顺序追加（seq / ts 由写入口径分配）；内部 Promise 链保证
 *   并行页面 Agent 的写入不交错、seq 单调。
 * - run.json：跨进程文件锁 + 临时文件 rename 原子写（与 config / history 同一套）。
 * - 残留自愈：创建时把仍为 running 的旧 run 标记为 interrupted
 *   （单个目标目录同时只有一个 CLI 进程在跑）。
 * - 保留期：每目标仓库默认保留最近 DEFAULT_RUNS_RETENTION 个 run
 *   （ZREAD_PI_RUNS_RETENTION 覆盖；<= 0 不清理）。
 */

import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  AgentEndEvent,
  AgentStartEvent,
  BlueprintDetailLevel,
  CompactEvent,
  FailedSectionsEvent,
  MessageDeltaEvent,
  MessageEndEvent,
  MessageStartEvent,
  PageEndEvent,
  PageStartEvent,
  RetryEvent,
  RunEndEvent,
  RunEvent,
  RunEventAgentMeta,
  RunJsonValue,
  RunKind,
  RunMeta,
  RunStartEvent,
  RunTokenUsage,
  SectionEvent,
  StageEvent,
  StatusEvent,
  ToolEndEvent,
  ToolStartEvent,
} from '@zread-pi/types';
import { RUN_LEVEL_AGENT } from '@zread-pi/types';
import { ensureDir, writeTextFileAtomic } from '../file-io.js';
import { withFileLock } from '../lockfile.js';
import { createLogger } from '../logger/service.js';
import {
  EVENTS_FILE_NAME,
  generateRunId,
  getEventsPath,
  getMetaPath,
  getRunDir,
  getRunsDir,
  isValidRunId,
  listRuns,
  META_FILE_NAME,
} from './run-dir.js';
import { readRunMeta } from './run-log-reader.js';

/** 保留期环境变量（每目标仓库保留的 run 数；<= 0 不清理） */
export const RUNS_RETENTION_ENV = 'ZREAD_PI_RUNS_RETENTION';
/** 默认保留最近 20 次运行 */
export const DEFAULT_RUNS_RETENTION = 20;

/** 单个字符串载荷的截断上限（64 KiB） */
export const PAYLOAD_MAX_CHARS = 65_536;
/** 流式预览的字符上限 */
export const PREVIEW_MAX_CHARS = 512;
/** 单条消息的流式更新节流间隔（毫秒） */
export const DELTA_THROTTLE_MS = 1_000;

/** 本模块的命名 logger（运行日志写入） */
const logger = createLogger('orchestrator.run-log');

function resolveRetention(): number {
  const raw = process.env[RUNS_RETENTION_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RUNS_RETENTION;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RUNS_RETENTION;
}

/** 截断超长字符串（带截断标记，便于检查器识别） */
export function clipText(value: string, max: number = PAYLOAD_MAX_CHARS): string {
  if (value.length <= max) return value;
  const omitted = value.length - max;
  return `${value.slice(0, max)}…(truncated ${omitted} chars)`;
}

/** 递归截断 JSON 载荷中的长字符串 */
export function clipJson(value: RunJsonValue, max: number = PAYLOAD_MAX_CHARS): RunJsonValue {
  if (typeof value === 'string') return clipText(value, max);
  if (Array.isArray(value)) return value.map((item) => clipJson(item, max));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, RunJsonValue> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clipJson(item, max);
    return out;
  }
  return value;
}

/** 从内容块生成单行预览（流式事件用；与 trajectory 包的 previewOfBlocks 同语义） */
export function previewOfBlocks(blocks: Array<{ type: string; text?: string }>): string {
  const text = blocks
    .filter((block) => (block.type === 'text' || block.type === 'thinking') && typeof block.text === 'string')
    .map((block) => (block.type === 'text' ? block.text! : block.text!))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, PREVIEW_MAX_CHARS);
}

export interface RunLogWriterOptions {
  kind: RunKind;
  detail?: BlueprintDetailLevel;
  model?: string;
  provider?: string;
  /** 覆盖 runId（测试确定性用）；缺省按时间 + 随机后缀生成 */
  runId?: string;
}

/** 追加事件的输入（seq / ts 由写入器分配；按 kind 分布，保留各变体自有字段） */
export type AppendRunEvent = {
  [Kind in RunEvent['kind']]: Omit<Extract<RunEvent, { kind: Kind }>, 'seq' | 'ts'>;
}[RunEvent['kind']];

export class RunLogWriter {
  readonly runId: string;
  private readonly projectRoot: string;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  /** run.json 的写入串行（保证 end() 的终态不会被更早 append 的挂起写覆盖） */
  private metaChain: Promise<void> = Promise.resolve();
  private closed = false;
  private meta: RunMeta;
  /** 每条消息最近的 delta 时间（节流用，key = agent.key） */
  private lastDeltaAt = new Map<string, number>();

  private constructor(projectRoot: string, runId: string, meta: RunMeta) {
    this.projectRoot = projectRoot;
    this.runId = runId;
    this.meta = meta;
  }

  /**
   * 创建一次运行：建目录、写 run.json、把残留 running 标记为 interrupted、清理超额旧 run。
   */
  static async create(
    projectRoot: string = process.cwd(),
    options: RunLogWriterOptions,
  ): Promise<RunLogWriter> {
    const runId = options.runId ?? generateRunId();
    if (!isValidRunId(runId)) throw new Error(`Invalid run id: ${runId}`);

    const runsDir = getRunsDir(projectRoot);
    await ensureDir(getRunDir(runId, projectRoot));
    const startedAt = new Date();

    const meta: RunMeta = {
      id: runId,
      startedAt: startedAt.toISOString(),
      status: 'running',
      kind: options.kind,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      targetDir: projectRoot,
      agents: { count: 0, byRole: {} },
      pages: { total: 0, completed: 0, failed: 0 },
      events: 0,
      lastSeq: 0,
    };

    const writer = new RunLogWriter(projectRoot, runId, meta);
    // 先写 run.json 再清理：清理按 startedAt（毫秒精度）排序，此时本 run 已有
    // 真实开始时间，能被正确识别为「最新」，不会被自己触发的清理删掉
    await writer.writeMeta();
    await RunLogWriter.healInterruptedRuns(projectRoot, runId);
    await RunLogWriter.enforceRetention(projectRoot, runId);
    logger.info(`run 开始：${runId}（${options.kind}）→ ${runsDir}`);
    return writer;
  }

  /** 追加一条事件（顺序保证；seq 单调递增） */
  append(event: AppendRunEvent): void {
    if (this.closed) return;
    const seq = ++this.seq;
    const ts = Date.now();
    const record: RunEvent = {
      ...event,
      seq,
      ts,
      ...(event.agent === undefined ? {} : { agent: event.agent }),
    } as RunEvent;

    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain.then(() => appendFile(getEventsPath(this.runId, this.projectRoot), line, 'utf-8'));

    this.meta.events += 1;
    this.meta.lastSeq = seq;
    this.tally(record);
    void this.writeMeta();
  }

  /** run_start 事件 */
  appendRunStart(payload: Omit<RunStartEvent, 'kind' | 'agent' | 'runKind' | 'seq' | 'ts'>): void {
    this.append({ ...payload, kind: 'run_start', runKind: this.meta.kind, agent: RUN_LEVEL_AGENT });
  }

  /** run_end 事件并落盘终态 */
  async end(status: 'completed' | 'failed', error?: string, usage?: RunTokenUsage): Promise<void> {
    if (this.closed) return;
    const durationMs = Date.now() - new Date(this.meta.startedAt).getTime();
    const event: Omit<RunEndEvent, 'seq' | 'ts'> = {
      kind: 'run_end',
      agent: RUN_LEVEL_AGENT,
      status,
      durationMs,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    };
    // 先追加 run_end 再关闭，否则 append() 会被 closed 拦截而丢事件
    this.append(event);
    this.closed = true;
    await this.chain;
    this.meta.status = status;
    this.meta.endedAt = new Date().toISOString();
    this.meta.durationMs = durationMs;
    if (error) this.meta.error = error;
    if (usage) this.meta.usage = usage;
    await this.writeMeta();
    logger.info(`run 结束：${this.runId}（${status}，${Math.round(durationMs)}ms）`);
  }

  /** 只读 meta（不落盘） */
  getMeta(): RunMeta {
    return this.meta;
  }
  /** 合并 meta 补丁（文件锁 + 原子替换） */
  async updateMeta(patch: Partial<RunMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    await this.writeMeta();
  }

  /** 记录用量合计（外部聚合口径，如三阶段 BlueprintUsageTracker） */
  async recordUsage(usage: RunTokenUsage | undefined): Promise<void> {
    if (!usage) return;
    this.meta.usage = usage;
    await this.writeMeta();
  }

  // ==================== 内部实现 ====================

  /** 按事件种类更新 meta 计数（agent / page / 用量合计） */
  private tally(event: RunEvent): void {
    switch (event.kind) {
      case 'agent_start': {
        this.meta.agents.count += 1;
        const role = event.agent?.role;
        if (role) this.meta.agents.byRole[role] = (this.meta.agents.byRole[role] ?? 0) + 1;
        break;
      }
      case 'agent_end':
        // 每个 Agent 终态的用量是 harness ledger 的累计值，直接相加即为 run 级合计
        this.accumulateUsage(event.usage);
        break;
      case 'page_start':
        this.meta.pages.total += 1;
        break;
      case 'page_end':
        if (event.success) this.meta.pages.completed += 1;
        else this.meta.pages.failed += 1;
        break;
      default:
        break;
    }
  }

  /** 累计 Agent 终态用量（不依赖外部聚合口径） */
  private accumulateUsage(usage: RunTokenUsage | undefined): void {
    if (usage === undefined) return;
    const base = this.meta.usage ?? { input_tokens: 0, output_tokens: 0 };
    this.meta.usage = {
      input_tokens: base.input_tokens + usage.input_tokens,
      output_tokens: base.output_tokens + usage.output_tokens,
      ...(base.cache_read_input_tokens !== undefined || usage.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: (base.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) }
        : {}),
      ...(base.cache_creation_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: (base.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) }
        : {}),
    };
  }

  /** 写 run.json（跨进程锁 + 临时文件 rename；串行保证顺序） */
  private writeMeta(): Promise<void> {
    const path = getMetaPath(this.runId, this.projectRoot);
    // 快照在调用时取（后续 append 改的是 this.meta，不影响已排队的写入内容）
    const content = JSON.stringify(this.meta, null, 2);
    this.metaChain = this.metaChain
      .then(() =>
        withFileLock(path, async () => {
          await writeTextFileAtomic(path, content);
        }),
      )
      .catch((err: unknown) => {
        // 锁失败按写入失败报错（不静默降级，与 config / history 一致）
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`run.json 写入失败（${this.runId}）：${message}`);
      });
    return this.metaChain;
  }

  /** 残留自愈：把仍为 running 的旧 run 标记为 interrupted */
  private static async healInterruptedRuns(projectRoot: string, currentRunId: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(getRunsDir(projectRoot));
    } catch {
      return;
    }
    for (const name of names) {
      if (!isValidRunId(name) || name === currentRunId) continue;
      const meta = await readRunMeta(name, projectRoot).catch(() => undefined);
      if (meta?.status !== 'running') continue;
      await RunLogWriter.markInterrupted(name, projectRoot).catch(() => {});
    }
  }

  private static async markInterrupted(runId: string, projectRoot: string): Promise<void> {
    const path = getMetaPath(runId, projectRoot);
    await withFileLock(path, async () => {
      const meta = await readRunMeta(runId, projectRoot);
      if (meta?.status !== 'running') return;
      const next: RunMeta = {
        ...meta,
        status: 'interrupted',
        endedAt: new Date().toISOString(),
        error: 'Interrupted by a newer run',
      };
      await writeTextFileAtomic(path, JSON.stringify(next, null, 2));
      logger.warn(`run 残留自愈：${runId} 标记为 interrupted`);
    });
  }

  /**
   * 保留期清理：删除最早开始的 run，只保留最近 N 个。
   * 用「含本 run」的完整集合判定是否超限（保证容量语义正确），
   * 只在最后删除时排除 `currentRunId`（极小概率同毫秒时自己被排进删除区间的防御）。
   * 调用点在本 run 的 run.json 已写入之后，因此本 run 有真实毫秒级 startedAt，
   * 会被正确识别为最新。
   */
  private static async enforceRetention(projectRoot: string, currentRunId: string): Promise<void> {
    const retention = resolveRetention();
    if (retention <= 0) return;
    const runs = await listRuns(projectRoot).catch(() => []);
    // 按真实开始时间排序：startedAt 是毫秒精度 ISO，比秒级 runId 更准
    // （同秒内创建的 run，runId 的随机后缀不保证顺序 = 创建顺序）。
    // 同 startedAt 时以 id 降序兜底。最新的 retention 个保留。
    const ordered = [...runs].sort((left, right) => {
      const byStarted = (right.startedAt ?? '').localeCompare(left.startedAt ?? '');
      return byStarted !== 0 ? byStarted : right.id.localeCompare(left.id);
    });
    const stale = ordered.slice(retention).filter((run) => run.id !== currentRunId);
    for (const run of stale) {
      const dir = getRunDir(run.id, projectRoot);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    if (stale.length > 0) logger.info(`保留期清理：删除 ${stale.length} 个旧 run`);
  }
}

/**
 * 包裹一次「自带 run」的执行：调用方未传 runLog 时自动创建单次 run
 * （发 run_start / run_end，失败时 status = failed），保证日志从不缺失。
 *
 * 传入 runLog 时直接复用（目录 + 页面阶段共享同一个 run，由上层控制生命周期）。
 */
export async function withRunLog<T>(
  runLog: RunLogWriter | undefined,
  options: {
    kind: RunKind;
    detail?: BlueprintDetailLevel;
    model?: string;
    provider?: string;
    targetDir?: string;
  },
  fn: (runLog: RunLogWriter) => Promise<T>,
): Promise<T> {
  if (runLog !== undefined) return fn(runLog);

  const targetDir = options.targetDir ?? process.cwd();
  const writer = await RunLogWriter.create(targetDir, {
    kind: options.kind,
    detail: options.detail,
    model: options.model,
    provider: options.provider,
  });
  writer.appendRunStart({
    targetDir,
    detail: options.detail,
    model: options.model,
    provider: options.provider,
  });

  try {
    const result = await fn(writer);
    await writer.end('completed');
    return result;
  } catch (err: unknown) {
    await writer.end('failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// 事件载荷的便捷构造函数（编排层用；自动截断超长载荷；返回不含 seq / ts 的载荷）
export function buildAgentStartEvent(input: {
  agent?: RunEventAgentMeta;
  prompt: string;
  systemPrompt?: string;
  toolCatalog: Array<{ name: string; inputSchema: unknown }>;
  model?: string;
  provider?: string;
  tokenBudget?: number;
}): Omit<AgentStartEvent, 'seq' | 'ts'> {
  return {
    kind: 'agent_start',
    ...(input.agent ? { agent: input.agent } : {}),
    prompt: clipText(input.prompt),
    ...(input.systemPrompt ? { systemPrompt: clipText(input.systemPrompt) } : {}),
    toolCatalog: input.toolCatalog.map((tool) => ({
      name: tool.name,
      inputSchema: clipJson(tool.inputSchema as RunJsonValue, 8_192),
    })),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
  };
}

export function buildMessageEndEvent(input: {
  agent?: RunEventAgentMeta;
  blocks: Array<{ type: string; text?: string; thinking?: string; callId?: string; id?: string; name?: string; input?: unknown }>;
  usage?: RunTokenUsage;
  stopReason?: string;
  contextWindow?: number;
  model?: string;
  provider?: string;
}): Omit<MessageEndEvent, 'seq' | 'ts'> {
  return {
    kind: 'message_end',
    ...(input.agent ? { agent: input.agent } : {}),
    blocks: input.blocks.map((block) => {
      if (block.type === 'text') return { type: 'text', text: clipText(block.text ?? '') };
      if (block.type === 'thinking') return { type: 'thinking', text: clipText(block.thinking ?? block.text ?? '') };
      return {
        type: 'tool_use',
        callId: String(block.callId ?? block.id ?? ''),
        name: String(block.name ?? ''),
        input: clipJson((block.input ?? {}) as RunJsonValue),
      };
    }),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  };
}

export function buildToolStartEvent(input: {
  agent?: RunEventAgentMeta;
  callId: string;
  name: string;
  args: unknown;
}): Omit<ToolStartEvent, 'seq' | 'ts'> {
  return {
    kind: 'tool_start',
    ...(input.agent ? { agent: input.agent } : {}),
    callId: input.callId,
    name: input.name,
    input: clipJson((input.args ?? {}) as RunJsonValue),
  };
}

export function buildToolEndEvent(input: {
  agent?: RunEventAgentMeta;
  callId: string;
  name?: string;
  output: string;
  details?: RunJsonValue;
  isError?: boolean;
}): Omit<ToolEndEvent, 'seq' | 'ts'> {
  return {
    kind: 'tool_end',
    ...(input.agent ? { agent: input.agent } : {}),
    callId: input.callId,
    ...(input.name ? { name: input.name } : {}),
    output: clipText(input.output),
    ...(input.details ? { details: clipJson(input.details, 16_384) } : {}),
    ...(input.isError ? { isError: true } : {}),
  };
}

export function buildRetryEvent(input: {
  agent?: RunEventAgentMeta;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}): Omit<RetryEvent, 'seq' | 'ts'> {
  return {
    kind: 'retry',
    ...(input.agent ? { agent: input.agent } : {}),
    attempt: input.attempt,
    maxRetries: input.maxRetries,
    delayMs: input.delayMs,
    error: clipText(input.error, 2_048),
  };
}

export function buildMessageStartEvent(input: {
  agent?: RunEventAgentMeta;
  preview: string;
}): Omit<MessageStartEvent, 'seq' | 'ts'> {
  return { kind: 'message_start', ...(input.agent ? { agent: input.agent } : {}), preview: clipText(input.preview, PREVIEW_MAX_CHARS) };
}

export function buildMessageDeltaEvent(input: {
  agent?: RunEventAgentMeta;
  preview: string;
}): Omit<MessageDeltaEvent, 'seq' | 'ts'> {
  return { kind: 'message_delta', ...(input.agent ? { agent: input.agent } : {}), preview: clipText(input.preview, PREVIEW_MAX_CHARS) };
}

export function buildCompactEvent(input: { agent?: RunEventAgentMeta; summary?: string }): Omit<CompactEvent, 'seq' | 'ts'> {
  return { kind: 'compact', ...(input.agent ? { agent: input.agent } : {}), ...(input.summary ? { summary: clipText(input.summary, 8_192) } : {}) };
}

export function buildStatusEvent(input: { agent?: RunEventAgentMeta; text: string }): Omit<StatusEvent, 'seq' | 'ts'> {
  return { kind: 'status', ...(input.agent ? { agent: input.agent } : {}), text: clipText(input.text, 2_048) };
}

export function buildStageEvent(input: { agent?: RunEventAgentMeta; stage: StageEvent['stage'] }): Omit<StageEvent, 'seq' | 'ts'> {
  return { kind: 'stage', ...(input.agent ? { agent: input.agent } : {}), stage: input.stage };
}

export function buildSectionEvent(input: { agent?: RunEventAgentMeta; section: string }): Omit<SectionEvent, 'seq' | 'ts'> {
  return { kind: 'section', ...(input.agent ? { agent: input.agent } : {}), section: input.section };
}

export function buildPageStartEvent(input: { agent?: RunEventAgentMeta; slug: string; outputPath?: string }): Omit<PageStartEvent, 'seq' | 'ts'> {
  return {
    kind: 'page_start',
    ...(input.agent ? { agent: input.agent } : {}),
    slug: input.slug,
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
  };
}

export function buildPageEndEvent(input: {
  agent?: RunEventAgentMeta;
  slug: string;
  outputPath?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}): Omit<PageEndEvent, 'seq' | 'ts'> {
  return {
    kind: 'page_end',
    ...(input.agent ? { agent: input.agent } : {}),
    slug: input.slug,
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    success: input.success,
    ...(input.error ? { error: clipText(input.error, 2_048) } : {}),
    ...(input.durationMs ? { durationMs: input.durationMs } : {}),
  };
}

export function buildFailedSectionsEvent(input: {
  agent?: RunEventAgentMeta;
  sections: FailedSectionsEvent['sections'];
}): Omit<FailedSectionsEvent, 'seq' | 'ts'> {
  return {
    kind: 'failed_sections',
    ...(input.agent ? { agent: input.agent } : {}),
    sections: input.sections.map((entry) => ({
      section: clipText(entry.section, 512),
      stage: entry.stage,
      error: clipText(entry.error, 1_024),
    })),
  };
}

export function buildAgentEndEvent(input: {
  agent?: RunEventAgentMeta;
  subtype: string;
  durationMs: number;
  usage?: RunTokenUsage;
}): Omit<AgentEndEvent, 'seq' | 'ts'> {
  return {
    kind: 'agent_end',
    ...(input.agent ? { agent: input.agent } : {}),
    subtype: input.subtype,
    durationMs: input.durationMs,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
