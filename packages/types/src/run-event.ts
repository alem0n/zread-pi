/**
 * RunEvent —— 一次运行（generate / sync）的可回放事件流类型
 *
 * 落盘：`<目标仓库>/.zread-pi/runs/<runId>/events.jsonl`，每行一个 JSON。
 * `seq` 全 run 内单调递增；`ts` 为写入时刻（时长 / TTFT 由它计算）。
 *
 * 事件捕获点在编排层（createAgent + generate/sync），不改 agent-runtime 契约：
 * pi 的 turn 边界由「assistant(含 tool_use) → 下一个 assistant」机械推导（见
 * packages/trajectory 的 replay）。run 级事件（run_start / stage / page_* / run_end）
 * 的 `agent` 缺省，折叠时归到 run 级上下文。
 */

import type { BlueprintDetailLevel } from './config.js';

/** 产生事件的 Agent 角色（与编排层 CatalogAgentRole 对齐，另加 page / polish / run） */
export type RunEventAgentRole =
  | 'classify'
  | 'topics'
  | 'titles'
  | 'condense'
  | 'page'
  | 'polish'
  | 'run';

/** 标识产生事件的 Agent（run 级事件可缺省） */
export interface RunEventAgentMeta {
  /** Agent 标识：`classify` / `topics:<section>` / `titles:<section>` / `condense:...` / `page:<slug>` */
  key: string;
  /** Agent 角色 */
  role: RunEventAgentRole;
  /** 所属分类（topics / titles / condense 阶段） */
  section?: string;
  /** 所属页面 slug（role = page / polish） */
  pageSlug?: string;
}

/** run 级事件的占位元信息（复用对象，避免每条事件重复构造） */
export const RUN_LEVEL_AGENT: RunEventAgentMeta = { key: 'run', role: 'run' };

/** JSON 值（工具参数 / details 的载荷类型） */
export type RunJsonValue = string | number | boolean | null | { [key: string]: RunJsonValue } | RunJsonValue[];

/** 一条助手消息的内容块（message_end 携带完整内容） */
export type RunContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: RunJsonValue };

/** Token 用量（字段名与 agent-runtime 的 TokenUsage 一致） */
export interface RunTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** 事件公共字段 */
export interface RunEventBase {
  /** 全 run 内单调递增的序号（分页 / 尾随游标） */
  seq: number;
  /** 写入时刻（epoch 毫秒） */
  ts: number;
  /** 产生事件的 Agent（run 级事件缺省） */
  agent?: RunEventAgentMeta;
}

/** 蓝图阶段（分类 / 分主题 / 标题） */
export type RunStage = 'classify' | 'topics' | 'titles';

export interface RunStartEvent extends RunEventBase {
  kind: 'run_start';
  /** 流程种类 */
  runKind: 'generate' | 'sync';
  /** 蓝图细节档位（generate） */
  detail?: BlueprintDetailLevel;
  /** 目标仓库绝对路径 */
  targetDir: string;
  /** 模型 / Provider（来自配置） */
  model?: string;
  provider?: string;
}

export interface RunEndEvent extends RunEventBase {
  kind: 'run_end';
  status: 'completed' | 'failed' | 'interrupted';
  durationMs: number;
  error?: string;
  usage?: RunTokenUsage;
}

export interface AgentStartEvent extends RunEventBase {
  kind: 'agent_start';
  /** 用户提示全文（写入时截断到 64 KiB） */
  prompt: string;
  /** 系统提示全文（写入时截断到 64 KiB） */
  systemPrompt?: string;
  /** 工具目录（name + inputSchema，检查器展示 schema 用） */
  toolCatalog: Array<{ name: string; inputSchema: RunJsonValue }>;
  model?: string;
  provider?: string;
  /** 显式 token 预算（0 / 缺省 = 不限制） */
  tokenBudget?: number;
}

export interface AgentEndEvent extends RunEventBase {
  kind: 'agent_end';
  /** result.subtype：success / error_context_full / error_budget_exhausted / error_during_execution … */
  subtype: string;
  durationMs: number;
  usage?: RunTokenUsage;
}

/** 助手消息开始（首个 partial 到达时；标记消息进入 running） */
export interface MessageStartEvent extends RunEventBase {
  kind: 'message_start';
  /** 累积内容的单行预览（≤512 字符） */
  preview: string;
}

/** 助手消息流式更新（节流：每条消息每秒最多一条；仅预览，不携带完整内容） */
export interface MessageDeltaEvent extends RunEventBase {
  kind: 'message_delta';
  /** 累积内容的单行预览（≤512 字符） */
  preview: string;
}

/** 助手消息完成（携带完整内容块 + 用量） */
export interface MessageEndEvent extends RunEventBase {
  kind: 'message_end';
  blocks: RunContentBlock[];
  usage?: RunTokenUsage;
  stopReason?: string;
  /** 本次解析出的模型上下文窗口（system/init） */
  contextWindow?: number;
  model?: string;
  provider?: string;
}

export interface ToolStartEvent extends RunEventBase {
  kind: 'tool_start';
  callId: string;
  name: string;
  /** 完整工具参数（写入时单值截断到 64 KiB） */
  input: RunJsonValue;
}

export interface ToolEndEvent extends RunEventBase {
  kind: 'tool_end';
  callId: string;
  name?: string;
  /** 工具输出文本（写入时截断到 64 KiB） */
  output: string;
  /** 结构化元信息（截断 / diff / 命中上限；不进入模型上下文） */
  details?: RunJsonValue;
  isError?: boolean;
}

export interface RetryEvent extends RunEventBase {
  kind: 'retry';
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface CompactEvent extends RunEventBase {
  kind: 'compact';
  summary?: string;
}

export interface StatusEvent extends RunEventBase {
  kind: 'status';
  text: string;
}

export interface StageEvent extends RunEventBase {
  kind: 'stage';
  stage: RunStage;
}

export interface SectionEvent extends RunEventBase {
  kind: 'section';
  section: string;
}

export interface PageStartEvent extends RunEventBase {
  kind: 'page_start';
  slug: string;
  outputPath?: string;
}

export interface PageEndEvent extends RunEventBase {
  kind: 'page_end';
  slug: string;
  outputPath?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}

export interface FailedSectionsEvent extends RunEventBase {
  kind: 'failed_sections';
  sections: Array<{ section: string; stage: 'topics' | 'titles'; error: string }>;
}

export type RunEvent =
  | RunStartEvent
  | RunEndEvent
  | AgentStartEvent
  | AgentEndEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | RetryEvent
  | CompactEvent
  | StatusEvent
  | StageEvent
  | SectionEvent
  | PageStartEvent
  | PageEndEvent
  | FailedSectionsEvent;

/** 所有事件 kind 的字面量联合（读取方做穷尽校验用） */
export type RunEventKind = RunEvent['kind'];
