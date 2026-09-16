/**
 * 轨迹视图的不变量（节流间隔 / overscan / 行高 / 载荷上限）。
 */

/** 搜索索引的提交节流（毫秒）——与 dsh 一致 */
export const SEARCH_INDEX_THROTTLE_MS = 3_000;

/** 流式预览的节流（毫秒；写入侧） */
export const DELTA_THROTTLE_MS = 1_000;

/** 虚拟化的行数阈值（低于此值全量渲染） */
export const VIRTUALIZATION_THRESHOLD = 100;

/** 虚拟化的 overscan 行数 */
export const VIRTUAL_OVERSCAN_ROWS = 12;

/** 视口的初始高度（虚拟化器在测量前的兜底） */
export const VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600;

/** 底部跟随阈值（像素） */
export const BOTTOM_FOLLOW_THRESHOLD_PX = 2;

/** 加载更旧页面的滚动阈值（像素） */
export const OLDER_LOAD_THRESHOLD_PX = 48;

/** 加载更旧历史的行高（像素） */
export const HISTORY_LOAD_ROW_HEIGHT_PX = 30;

/** 时间线拖拽的最小像素（小于此值视为点击） */
export const MINIMUM_DRAG_PX = 3;

/** 时间线滚轮缩放的最小操作数（sequence 模式） */
export const MINIMUM_ZOOM_OPERATIONS = 4;

/** 时间线悬停提示延迟（毫秒） */
export const TIMELINE_TOOLTIP_DELAY_MS = 500;

/** 详情面板宽度约束（像素） */
export const DETAILS_MIN_WIDTH = 320;
export const DETAILS_MAX_WIDTH = 720;
export const TABLE_MIN_WIDTH = 280;
export const DETAILS_RESIZE_STEP = 16;
