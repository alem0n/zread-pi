/**
 * 浏览站 i18n 类型定义
 *
 * 浏览站与 CLI（pi-tui）是两套独立的字典：CLI 的界面文案在 apps/cli/src/i18n，
 * 这里只覆盖网页（Wiki 预览站 / 轨迹检查页）用得到的文案。
 * 语言由 CLI 配置的 language 字段决定（browse-server 的 /api/i18n 解析后下发）。
 */

/** 支持的语言代码（与 CLI 的 LanguageCode 保持一致） */
export type LanguageCode = 'zh-CN' | 'en-US';

/** 轨迹检查页（logview 打开的网页）文案 */
export interface TrajectoryTranslation {
  loading: string;
  notFound: string;
  loadFailed: string;
  retry: string;
  /** 返回 Wiki 的链接文案 */
  backToWiki: string;
  /** 顶栏返回链接 */
  wiki: string;
  /** 顶栏页面标题 */
  title: string;
  /** 表格空态 */
  noRecords: string;
  /** 时间线空态 */
  noTiming: string;
  /** 检查器未选中记录时的占位 */
  selectRecord: string;
  /** 记录正文为空时的占位 */
  emptyRecord: string;
  /** 搜索框占位 */
  searchPlaceholder: string;
  /** 「加载更早的事件」按钮 */
  loadOlder: string;
  /** turn 之间独立段的标题（数据层 label 之外的前端文案） */
  betweenTurns: string;
  /** turn 头标题（占位参数：turn / label） */
  turnLabel: string;
  /** 「N 条记录」计数（占位参数：count） */
  recordsCount: string;
  /** 折叠态摘要：纯耗时（占位参数：ms） */
  collapsedDuration: string;
  /** 折叠态摘要：耗时 + 工具调用数（占位参数：ms / count） */
  collapsedTools: string;
  /** 页面进度（占位参数：completed / total） */
  pages: string;
  /** 页面失败计数（占位参数：count） */
  pagesFailed: string;
  /** 工具栏：折叠 turn 开关 */
  turns: string;
  collapseTurns: string;
  /** 工具栏：折叠连续助手消息开关 */
  steps: string;
  collapseSteps: string;
  /** 时序模式按钮的 title（占位参数：label） */
  modeTitle: string;
  /** 时间线「重置缩放」 */
  resetZoom: string;
  /** 表头「隐藏此会话」按钮 title（从台账与时间线移除该 Agent 会话） */
  hideSession: string;
  /** sticky turn 表头「折叠 / 展开此 turn」按钮 title */
  toggleTurn: string;
  /** 工具栏「已隐藏 N 个会话」徽标（占位参数：count） */
  hiddenSessions: string;
  /** 工具栏「恢复全部被隐藏的会话」按钮 title */
  showAllSessions: string;
  /** 检查器错误标记 */
  error: string;
  /** 检查器「上一个 / 下一个请求」按钮 title */
  prevRequest: string;
  nextRequest: string;

  /** 时序模式标签（与 TrajectoryTimelineMode 一一对应） */
  modes: {
    sequence: string;
    duration: string;
    time: string;
    actual: string;
  };
  /** 运行状态徽标（与 TrajectoryRunSummary['status'] 一一对应） */
  statuses: {
    running: string;
    completed: string;
    failed: string;
    interrupted: string;
    unknown: string;
  };
  /** 检查器分区标题 */
  sections: {
    summary: string;
    prompt: string;
    input: string;
    output: string;
    result: string;
    thinking: string;
    toolSchema: string;
    sourceBlocks: string;
    usage: string;
    request: string;
  };
  /** 检查器指标行标签 */
  metrics: {
    started: string;
    duration: string;
    ttft: string;
    decode: string;
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
    cacheHit: string;
    requestNumber: string;
    turn: string;
    step: string;
    status: string;
    provider: string;
    model: string;
    contextWindow: string;
    retry: string;
    error: string;
    cumulative: string;
  };
}

/** 翻译字典结构 */
export interface TranslationKeys {
  trajectory: TrajectoryTranslation;
}

/** 插值参数类型 */
export interface InterpolationParams {
  [key: string]: string | number;
}

/** 翻译函数类型（点号分层的 key，如 trajectory.modes.sequence） */
export type TranslateFn = (key: string, params?: InterpolationParams) => string;
