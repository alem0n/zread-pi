/**
 * session —— pi 会话 format-4 JSONL 的纯解析（投影层的输入规格）。
 *
 * 方案 C：pi 会话是唯一完整事实源。本模块把会话文件解析成结构化事实，
 * 供 replay 与 digest 投影。**无 node 依赖**（可被 Vite 打包）：只接受
 * 「文本行数组」，磁盘读取（fs）在 @zread-pi/utils 的 readSessionFacts。
 *
 * 磁盘行形态（阶段 0 探针 + driver 端到端核实）：
 *   - 首行 header：`{"v":4,"kind":"header","id":<sessionId>,...}`
 *   - value / list 写入是**单对象行**：`{"kind":"value","op":"set",...}`
 *   - entry / usage 是**事务数组行**（一批多条）：
 *     `[{"kind":"entry",...}, {"kind":"usage",...}]`
 * 解析时展开数组行并按 kind 取 entry / usage；其余 kind（value / list /
 * header）不参与投影。
 *
 * 消息条目的存储格式（与 pi-ai 的线路格式同形）：
 *   - user：`role:"user"`，content 为 text 块
 *   - assistant：`role:"assistant"`，content 为 text / thinking / toolCall 块；
 *     自带 `usage` / `model` / `provider`（每响应的计费与模型事实）
 *   - toolResult：`role:"toolResult"` 的**独立消息**，带 `toolCallId` /
 *     `toolName`（不是 user 消息里的 toolResult 块）
 * 压缩条目：`type:"compaction"`，含 `summary` / `retainedTail` / `usage`。
 */

/** 会话内容块（镜像 pi 存储格式；不依赖 pi 运行时） */
export type SessionBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'toolCall'; id: string; name: string; arguments?: unknown; input?: unknown };

/** provider 用量（与 pi-ai 的 Usage 同形） */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** 一条会话消息（user / assistant / toolResult） */
export interface SessionMessage {
  role: string;
  content: SessionBlock[] | string;
  /** assistant 消息自带的每响应用量 */
  usage?: SessionUsage;
  model?: string;
  provider?: string;
  /** toolResult 消息的工具关联（存储格式把工具结果放在独立消息里） */
  toolCallId?: string;
  toolName?: string;
}

/** 会话条目（消息 / 压缩），按 seq 排序 */
export interface SessionEntry {
  type: 'message' | 'compaction' | string;
  seq: number;
  /** epoch 毫秒（投影层的时间轴锚点） */
  timestamp: number;
  message?: SessionMessage;
  /** 压缩条目的摘要 */
  summary?: string;
  /** 压缩条目自带的用量 */
  usage?: SessionUsage;
}

/** usage 行（provider 计费事实；entryId 关联到对应消息） */
export interface SessionUsageRow {
  id: string;
  seq: number;
  usage: SessionUsage;
  /** 修正行（对既有用量的调整，合计时按增量处理） */
  adjustment: boolean;
  entryId?: string;
}

/** 一个 Agent 会话的完整事实（投影层的输入） */
export interface SessionFacts {
  /** pi 会话 id（= 文件名里的 <sessionId>，与 agent_config 的 agent.sessionId 对齐） */
  sessionId: string;
  /** 会话条目（消息 / 压缩），按 seq 升序 */
  entries: SessionEntry[];
  /** usage 行（provider 计费事实） */
  usageRows: SessionUsageRow[];
}

/** 从 header 行取会话 id */
export function sessionIdFromHeader(line: string | undefined): string | undefined {
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as { kind?: string; id?: unknown };
    if (parsed.kind === 'header' && typeof parsed.id === 'string') return parsed.id;
  } catch {
    // 损坏行：交由调用方跳过
  }
  return undefined;
}

/** 从文件名解析会话 id：<ts>_<encodeURIComponent(id)>.jsonl */
export function sessionIdFromFileName(name: string): string | undefined {
  if (!name.endsWith('.jsonl')) return undefined;
  const stem = name.slice(0, -'.jsonl'.length);
  const separator = stem.indexOf('_');
  if (separator < 0) return undefined;
  try {
    return decodeURIComponent(stem.slice(separator + 1));
  } catch {
    return stem.slice(separator + 1);
  }
}

interface RawLineItem {
  kind?: string;
  type?: string;
  seq?: number;
  timestamp?: number;
  message?: SessionMessage;
  summary?: string;
  usage?: SessionUsage;
  id?: string;
  adjustment?: boolean;
  entryId?: string;
}

/** 把一行（单对象或事务数组）展开成统一的项目列表 */
function expandLine(line: string): RawLineItem[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as RawLineItem[]) : [parsed as RawLineItem];
}

/**
 * 解析一个会话文件的全部文本行 → 事实。
 *
 * `sessionId` 优先取首行 header，缺省时由调用方按文件名补。
 * 损坏行跳过（与 events.jsonl 的读取一致：不因一行丢弃整个会话）。
 */
export function parseSessionLines(lines: readonly string[], sessionId?: string): SessionFacts {
  const entries: SessionEntry[] = [];
  const usageRows: SessionUsageRow[] = [];
  let headerId: string | undefined;

  for (const [index, line] of lines.entries()) {
    if (index === 0) {
      headerId = sessionIdFromHeader(line);
      // header 行不参与条目解析
      continue;
    }
    for (const item of expandLine(line)) {
      if (item.kind === 'entry') {
        const entry: SessionEntry = {
          type: typeof item.type === 'string' ? item.type : 'custom',
          seq: typeof item.seq === 'number' ? item.seq : 0,
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : 0,
        };
        if (item.message !== undefined) entry.message = item.message;
        if (typeof item.summary === 'string') entry.summary = item.summary;
        if (item.usage !== undefined) entry.usage = item.usage;
        entries.push(entry);
      } else if (item.kind === 'usage') {
        if (item.usage !== undefined) {
          usageRows.push({
            id: typeof item.id === 'string' ? item.id : '',
            seq: typeof item.seq === 'number' ? item.seq : 0,
            usage: item.usage,
            adjustment: item.adjustment === true,
            ...(item.entryId !== undefined ? { entryId: item.entryId } : {}),
          });
        }
      }
    }
  }

  entries.sort((left, right) => left.seq - right.seq);
  usageRows.sort((left, right) => left.seq - right.seq);

  return { sessionId: sessionId ?? headerId ?? '', entries, usageRows };
}

/** 累计用量行 → 合计（adjustment 行按增量；与 pi 的 stats 口径一致） */
export function sumSessionUsage(rows: readonly SessionUsageRow[]): SessionUsage {
  const total: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const row of rows) {
    total.input += row.usage.input;
    total.output += row.usage.output;
    total.cacheRead += row.usage.cacheRead;
    total.cacheWrite += row.usage.cacheWrite;
    total.totalTokens += row.usage.totalTokens;
  }
  return total;
}

/** 取消息条目的单行预览（与 trajectory 的 previewOfBlocks 同语义） */
export function previewOfSessionMessage(message: SessionMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  const blocks: SessionBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const text = blocks
    .filter((block) => (block.type === 'text' || block.type === 'thinking') && typeof (block as { text?: string; thinking?: string }).text === 'string')
    .map((block) => (block as { text?: string }).text ?? (block as { thinking?: string }).thinking ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** 工具调用块的参数（pi 存储用 `arguments`；兼容 `input`） */
export function toolCallArguments(block: SessionBlock | undefined): unknown {
  if (!block || block.type !== 'toolCall') return undefined;
  return block.arguments ?? block.input;
}
