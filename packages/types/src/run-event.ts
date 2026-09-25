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

/** 产生事件的 Agent 角色（与编排层 CatalogAgentRole 对齐，另加 page / polish / run；旧值保留供旧日志回放） */
export type RunEventAgentRole =
  | 'structure'
  | 'sections'
  | 'pages'
  | 'page'
  | 'polish'
  | 'run'
  | 'classify'
  | 'topics'
  | 'titles'
  | 'condense';

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
  /**
   * 本次 Agent 会话的唯一标识（编排层生成，同时是 pi 会话的 sessionId）。
   *
   * 折叠（replay）按它把事件归属到对应的 turn / 活跃会话：并发 Agent 的
   * 事件在日志里交错，单凭 key 与「最近 agent_start」指针会互相吞掉，
   * session id 是每个事件自带的、全局唯一的归属键。
   *
   * 可选：该字段在 v1.13.0 引入，之前的旧日志没有它；replay 对缺省值
   * 回退 `agent.key` 归属（见 `identityOf`），旧日志仍可读取展示。
   */
  sessionId?: string;
}

/** run 级事件的占位元信息（复用对象，避免每条事件重复构造）。
 *  sessionId 为恒定占位值：run 级事件不归属任何 Agent turn，replay 里
 *  不会与真实 session（`zread-pi-<时间戳>-<随机>`）撞车。 */
export const RUN_LEVEL_AGENT: RunEventAgentMeta = { key: 'run', role: 'run', sessionId: 'run' };

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

/** 蓝图阶段（结构优先：结构 → 分类命名 → 页面命名；旧值保留供旧日志回放） */
export type RunStage = 'structure' | 'sections' | 'pages' | 'classify' | 'topics' | 'titles';

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

/**
 * Agent 配置快照（方案 C：`agent_start` 的瘦替身）。
 *
 * pi 会话的 `LaneConfiguration` 已记录 model / provider / thinkingLevel；
 * 会话条目记录消息 / 工具 / 用量 / 压缩。剩下的三个「harness 配置」事实
 * （systemPrompt 全文 / toolCatalog schema / tokenBudget）不在会话里，
 * 由本事件落到瘦业务层（进程局部配置 → events.jsonl）。
 */
export interface AgentConfigEvent extends RunEventBase {
  kind: 'agent_config';
  /** 用户提示全文（写入时截断到 64 KiB） */
  prompt: string;
  /** 系统提示全文（写入时截断到 64 KiB） */
  systemPrompt?: string;
  /** 工具目录（name + inputSchema，检查器展示 schema 用） */
  toolCatalog: Array<{ name: string; inputSchema: RunJsonValue }>;
  model?: string;
  provider?: string;
  /** pi 思考深度（LaneConfiguration 另存，这里仅作展示快照） */
  thinkingLevel?: string;
  /** 显式 token 预算（0 / 缺省 = 不限制） */
  tokenBudget?: number;
  /** 本次解析出的模型上下文窗口（system/init；UI 的「上下文占比」分母） */
  contextWindow?: number;
}

/**
 * provider 请求 id（方案 C：request id 的瘦替身）。
 *
 * 采集仍在适配层（`after_response` 钩子读响应头，只有它看得到协议细节）；
 * 落点从 `message_end.requestId` 挪到本事件：一 Agent 多响应是常态，
 * 挂终态只能留最后一个，独立事件能保留全部。纯元数据，零内容。
 */
export interface ProviderRequestEvent extends RunEventBase {
  kind: 'provider_request';
  requestId: string;
  model?: string;
  provider?: string;
}

/** 仓库扫描开始（RepoAnalyzer scanFiles / parseFiles 阶段） */
export interface ScanStartEvent extends RunEventBase {
  kind: 'scan_start';
}

/** 仓库扫描结束 */
export interface ScanEndEvent extends RunEventBase {
  kind: 'scan_end';
  /** 扫描到的文件数（解析后的源文件数） */
  fileCount?: number;
  durationMs?: number;
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
  /**
   * 本次 provider 响应分配的 request id（取自响应头，排障用）。
   *
   * 可选：provider 未返回时缺省，旧日志无该字段照常读取（replay / 布局均不依赖它）。
   */
  requestId?: string;
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
  sections: Array<{ section: string; stage: 'pages' | 'topics' | 'titles'; error: string }>;
}

export type RunEvent =
  | RunStartEvent
  | RunEndEvent
  | AgentConfigEvent
  | ProviderRequestEvent
  | ScanStartEvent
  | ScanEndEvent
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

/**
 * 仍然会落盘的事件 kind（瘦业务层；方案 C 之后的「事实」集合）。
 *
 * 内容类 kind（`message_*` / `tool_*` / `retry` / `compact` / `status` /
 * `agent_start`）不再由捕获层产生——完整内容在 pi 会话条目里，由投影层
 * 读取；它们只保留在联合里以解析历史 run。
 */
export type ActiveRunEventKind =
  | 'run_start'
  | 'run_end'
  | 'agent_config'
  | 'provider_request'
  | 'scan_start'
  | 'scan_end'
  | 'agent_end'
  | 'stage'
  | 'section'
  | 'page_start'
  | 'page_end'
  | 'failed_sections';

/** 所有事件 kind 的字面量联合（读取方做穷尽校验用） */
export type RunEventKind = RunEvent['kind'];
