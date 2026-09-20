/**
 * @zread-pi/trajectory
 *
 * 轨迹（Trajectory）视图的纯模型层：replay 折叠 / 布局 / 时序投影 /
 * 搜索索引 / 虚拟化窗口 / 格式化。无 node 依赖，可被 Vite 打包。
 *
 * 输入是 zread-pi 自有的 RunEvent（`@zread-pi/types`），不依赖 Cordis /
 * dsh-client-runtime；服务端只存 / 分发原始事件，折叠在 Web 客户端完成。
 */

export type {
  TrajectoryCellKind,
  TrajectoryCellProps,
  TrajectoryGroupModel,
  TrajectoryTurnModel,
  TrajectoryPromptSnapshot,
  TrajectorySourceBlock,
  AssistantMetricDetail,
  TrajectorySnapshot,
  TrajectoryPartial,
  TrajectoryRequestNumber,
  TrajectoryRunSummary,
  TrajectoryTurnInfo,
  TrajectoryUsage,
  ReplayRecord,
  ReplaySystemRecord,
  ReplayUserRecord,
  ReplayContextRecord,
  ReplayMessageRecord,
  ReplayToolRecord,
  ReplayCompactedRecord,
} from './types.js';
export { trajectoryRecordId } from './types.js';

export { replayRunEvents, replayRun, summarizeRunEvents, type RunDigest } from './replay.js';
export {
  type SessionBlock,
  type SessionMessage,
  type SessionEntry,
  type SessionUsage,
  type SessionUsageRow,
  type SessionFacts,
  sessionIdFromHeader,
  sessionIdFromFileName,
  parseSessionLines,
  sumSessionUsage,
  previewOfSessionMessage,
  toolCallArguments,
} from './session.js';
export { deriveTrajectoryLayout, appendTrajectoryPartialLayout } from './layout.js';
export {
  deriveTrajectoryTimeline,
  trajectoryTimelineFocusIndexes,
  formatTimelineOffset,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
  type TrajectoryTimelineSpan,
  type TrajectoryTimelineTurnBoundary,
  type TrajectoryTimelineModel,
} from './timeline.js';
export { TrajectorySearchIndex } from './search-index.js';
export {
  groupTrajectoryVirtualRows,
  trajectoryVirtualRecordKey,
  trajectoryViewportWindow,
  trajectoryTotalHeight,
  type VirtualizableTrajectoryRecord,
  type TrajectoryVirtualRow,
  type TrajectoryVirtualRowEntry,
} from './virtual-rows.js';
export {
  formatDurationMillis,
  formatElapsedSeconds,
  formatDurationMs,
  formatTokens,
  formatBytes,
  formatPercent,
  cacheHitRatio,
  formatStartedAt,
  previewOfBlocks,
  trajectoryPreviewText,
} from './format.js';
export * from './invariant.js';
