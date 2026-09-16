/**
 * trajectory-store —— 可回放运行日志的存储（node 侧）。
 *
 * 落点：`<目标仓库>/.zread-pi/runs/<runId>/`（events.jsonl + run.json）。
 * 纯模型（折叠 / 布局 / 时序投影 / 搜索 / 虚拟化）在 `@zread-pi/trajectory` 包，
 * 服务端只存 / 分发原始事件。
 */

export {
  RUNS_DIR_NAME,
  EVENTS_FILE_NAME,
  META_FILE_NAME,
  RUN_ID_PATTERN,
  LATEST_RUN_ALIAS,
  generateRunId,
  getRunsDir,
  getRunDir,
  getEventsPath,
  getMetaPath,
  isValidRunId,
  listRuns,
  latestRun,
  resolveRunId,
} from './run-dir.js';

export {
  RUNS_RETENTION_ENV,
  DEFAULT_RUNS_RETENTION,
  PAYLOAD_MAX_CHARS,
  PREVIEW_MAX_CHARS,
  DELTA_THROTTLE_MS,
  withRunLog,
  RunLogWriter,
  clipText,
  clipJson,
  previewOfBlocks,
  buildAgentStartEvent,
  buildAgentEndEvent,
  buildMessageStartEvent,
  buildMessageDeltaEvent,
  buildMessageEndEvent,
  buildToolStartEvent,
  buildToolEndEvent,
  buildRetryEvent,
  buildCompactEvent,
  buildStatusEvent,
  buildStageEvent,
  buildSectionEvent,
  buildPageStartEvent,
  buildPageEndEvent,
  buildFailedSectionsEvent,
  type AppendRunEvent,
  type RunLogWriterOptions,
} from './run-log-writer.js';

export {
  DEFAULT_READ_LIMIT,
  readEvents,
  readRunMeta,
  type ReadEventsOptions,
  type ReadEventsResult,
} from './run-log-reader.js';
