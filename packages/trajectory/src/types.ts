/**
 * 轨迹视图的共享类型（对齐 dsh ui-trajectory 的 record / contract 模型，
 * 但输入是 zread-pi 自有的 RunEvent，不依赖 Cordis / dsh-client-runtime）。
 */

import type { RunEventAgentMeta, RunJsonValue, RunTokenUsage } from '@zread-pi/types';

/** 轨迹记录的封闭种类（与 dsh 一致；subtool 在 zread-pi 无嵌套调用，一般为空） */
export type TrajectoryCellKind =
  | 'system'
  | 'user'
  | 'context'
  | 'compacted'
  | 'message'
  | 'tool'
  | 'subtool';

/** 系统提示 + 工具目录的快照（system 记录的 promptDetail） */
export interface TrajectoryPromptSnapshot {
  system: string;
  tools: Array<{
    name: string;
    description?: string;
    parameters: RunJsonValue;
  }>;
}

/** 详情面板里按原始顺序保留的来源内容块 */
export interface TrajectorySourceBlock {
  type: string;
  content: string;
  imageSrc?: string;
  imageAlt?: string;
  callId?: string;
  toolName?: string;
}

/** 助手消息的时序事实（TTFT / 解码吞吐用） */
export interface AssistantMetricDetail {
  timingRecorded: boolean;
  stepStartTime: number | null;
  firstTokenTime: number | null;
  completedTime: number | null;
  usageProvided: boolean;
  outputTokens: number | null;
}

/** 一条轨迹记录的数据（对齐 dsh 的 TrajectoryCellProps，去掉 React / dsh 专属字段） */
export interface TrajectoryCellProps {
  /** 1-based 记录序号（展示为 #N） */
  index: number;
  /** 投影稳定的身份（无单一来源事件时使用） */
  recordId?: string;
  kind: TrajectoryCellKind;
  /** 非 Markdown 的摘要或前缀（溢出时 CSS 省略） */
  text: string;
  /** 单行摘要的 Markdown 源（在消费侧转成预览） */
  previewMarkdown?: string;
  /** 该 user 记录是否开启一个新的模型 turn */
  opensTurn?: boolean;
  /** 来源事件的 seq（跨记录导航用） */
  sourceSeq?: number;
  /** 仅为请求分隔点的辅助记录（无可见内容） */
  requestOnly?: boolean;
  /** 详情面板用的完整请求 / 消息内容 */
  inputDetail?: string;
  /** system 记录引入的完整系统提示 / 工具目录 */
  promptDetail?: TrajectoryPromptSnapshot;
  /** system 更新替换掉的旧快照 */
  previousPromptDetail?: TrajectoryPromptSnapshot;
  /** 详情面板用的完整助手 / 工具结果内容 */
  outputDetail?: string;
  /** 详情面板用的完整推理内容 */
  thinkingDetail?: string;
  /** 原始消息块（详情面板按源顺序展示） */
  sourceBlocks?: readonly TrajectorySourceBlock[];
  /** 原始工具结果块 */
  outputBlocks?: readonly TrajectorySourceBlock[];
  /** 调用时的模型可见工具 schema（JSON 字符串） */
  schemaDetail?: string;
  /** 助手消息的时序与 token 事实 */
  assistantMetrics?: AssistantMetricDetail;
  /** 工具结果摘要（与调用配对在同一记录） */
  result?: string;
  resultPreviewMarkdown?: string;
  /** 工具调用 id（消息来源块 ↔ 工具记录的关联） */
  callId?: string;
  isError?: boolean;
  /** 自身耗时（秒），未知为 null */
  timeSeconds: number | null;
  /** 操作实际开始的 epoch 毫秒 */
  startedAt?: number | null;
  /** 消息的输入 token */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** 消息的输出 token */
  output?: number;
  /** 消息的推理 token */
  think?: number;
}

/**
 * 解析轨迹记录的稳定身份（向前分页插入旧记录后仍不变）。
 */
export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== undefined) return cell.recordId;
  if (cell.callId !== undefined) return `${cell.kind}\u0000call\u0000${cell.callId}`;
  if (cell.sourceSeq !== undefined) return `${cell.kind}\u0000seq\u0000${cell.sourceSeq}`;
  return `${cell.kind}\u0000index\u0000${cell.index}`;
}

/** 一个 turn 内的分组（Message / Step N / Compaction N） */
export interface TrajectoryGroupModel {
  title: string;
  description?: string;
  cells: readonly TrajectoryCellProps[];
}

/** 一个粘性 turn，或 turn 之间的独立压缩段 */
export interface TrajectoryTurnModel {
  /** turn 序号；null = turn 之间的独立段（压缩 / run 收尾） */
  turn: number | null;
  /** turn 标签（如「规划主题」「拟定标题 · 核心架构」「页面 · quick-start」） */
  label: string;
  /** 会话归属键（agent.sessionId；独立段没有） */
  sessionId?: string;
  /** Agent 标识（每个 Agent 一个 turn） */
  agentKey?: string;
  /** Agent 角色（分类 / 分主题 / 标题 / 缩编 / 页面 / 润色） */
  role?: RunEventAgentMeta['role'];
  section?: string;
  pageSlug?: string;
  groups: readonly TrajectoryGroupModel[];
}

/** 请求的 token 分桶（与 dsh 的 TrajectoryUsage 同形） */
export interface TrajectoryUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}

/** 一次请求（助手响应或压缩）的编号与累计用量 */
export interface TrajectoryRequestNumber {
  /** 锚点事件 seq（流式中的普通请求缺省） */
  seq?: number;
  group: string;
  number: number;
  status?: 'complete' | 'running' | 'error';
  startedAt?: number;
  completedAt?: number | null;
  error?: string;
  retry?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  purpose?: 'assistant' | 'compaction';
  provider?: string;
  model?: string;
  contextWindow?: number;
  usage?: TrajectoryUsage;
  cumulativeUsage?: TrajectoryUsage;
  turn: number | null;
  step: number;
}

/** 进行中的助手消息（流式帧） */
export interface TrajectoryPartial {
  turn: number | null;
  step: number;
  preview: string;
  blocks: readonly { type: string; text?: string }[];
}

/** replay 产出的快照（layout 的输入） */
export interface TrajectorySnapshot {
  /** 归一化后的有序记录（replay 折叠的第一层产物） */
  records: readonly ReplayRecord[];
  /** 会话级统一编号的请求（含压缩） */
  requests: readonly TrajectoryRequestNumber[];
  /** 进行中的助手消息（无 message_end） */
  partial: TrajectoryPartial | null;
  /** callId → 工具 schema（JSON 字符串） */
  callSchemas: ReadonlyMap<string, string>;
  /** turn 序号 → Agent 身份（布局的 turn 标签来源） */
  turns: readonly TrajectoryTurnInfo[];
  /** run 级摘要（来自 run_start / run_end / stage / page_* 事件） */
  runSummary: TrajectoryRunSummary;
}

/** 一个 turn 的 Agent 身份（一个 Agent = 一个 turn） */
export interface TrajectoryTurnInfo {
  number: number;
  key: string;
  /** 会话归属键（agent.sessionId）—— 前端按需隐藏 session 用 */
  sessionId: string;
  label: string;
  role?: RunEventAgentMeta['role'];
  section?: string;
  pageSlug?: string;
  /** Agent 非成功终止时的 subtype */
  endError?: string;
}

export interface TrajectoryRunSummary {
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  kind?: 'generate' | 'sync';
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  stages: string[];
  pages: { total: number; completed: number; failed: number };
  usage?: RunTokenUsage;
}

/** 归一化记录（replay 的输出、layout 的输入） */
export type ReplayRecord =
  | ReplaySystemRecord
  | ReplayUserRecord
  | ReplayContextRecord
  | ReplayMessageRecord
  | ReplayToolRecord
  | ReplayCompactedRecord;

interface ReplayRecordBase {
  seq: number;
  ts: number;
  /** 所属 turn（agent key）；run 级记录为 null */
  turnKey: string | null;
  /** 所属 turn 的序号（1-based）；null = run 级 */
  turn: number | null;
  /** 所属分组标题（layout 直接使用） */
  group: string;
}

export interface ReplaySystemRecord extends ReplayRecordBase {
  kind: 'system';
  text: string;
  promptDetail: TrajectoryPromptSnapshot;
  previousPromptDetail?: TrajectoryPromptSnapshot;
}

export interface ReplayUserRecord extends ReplayRecordBase {
  kind: 'user';
  text: string;
  preview?: string;
  inputDetail: string;
  sourceBlocks: TrajectorySourceBlock[];
}

export interface ReplayContextRecord extends ReplayRecordBase {
  kind: 'context';
  text: string;
  isError?: boolean;
}

export interface ReplayMessageRecord extends ReplayRecordBase {
  kind: 'message';
  step: number;
  blocks: Array<{ type: string; text?: string; callId?: string; name?: string; input?: RunJsonValue }>;
  usage?: RunTokenUsage;
  preview?: string;
  stopReason?: string;
  contextWindow?: number;
  model?: string;
  provider?: string;
  retry?: { attempt: number; maxRetries: number; delayMs: number; error: string };
  /** 流式中（无 message_end） */
  running?: boolean;
  /** message_start 的时刻（TTFT 起点） */
  startedAt?: number;
  /** 首个流式帧时刻（首 token） */
  firstTokenAt?: number;
}

export interface ReplayToolRecord extends ReplayRecordBase {
  kind: 'tool' | 'subtool';
  callId: string;
  name: string;
  input?: RunJsonValue;
  output?: string;
  details?: RunJsonValue;
  isError?: boolean;
  running?: boolean;
  /** tool_end 的时刻（与 ts 算时长） */
  endedAt?: number;
  /** 调用时的工具 schema（JSON 字符串，来自 Agent 的工具目录） */
  schemaDetail?: string;
  /** 父消息的 step（工具挂到发出它的消息的分组） */
  parentStep?: number;
}

export interface ReplayCompactedRecord extends ReplayRecordBase {
  kind: 'compacted';
  summary?: string;
  usage?: RunTokenUsage;
  running?: boolean;
  error?: string;
}
