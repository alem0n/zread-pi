/**
 * 格式化工具（时长 / token / 缓存占比 / 预览），对齐 dsh 的格式语义。
 */

const PREVIEW_SOURCE_CHARACTERS = 2_048;
const PREVIEW_OUTPUT_CHARACTERS = 512;

/** 毫秒时长（千分位）；未知返回 `—` */
export function formatDurationMillis(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—';
  const integer = String(Math.round(milliseconds));
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ms`;
}

/** 秒 → 毫秒标签 */
export function formatElapsedSeconds(seconds: number | null): string {
  return formatDurationMillis(seconds === null ? null : seconds * 1000);
}

/** <1s 显示 ms，否则显示秒（两位小数 / 一位小数） */
export function formatDurationMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

/** token 数（千分位） */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return '—';
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 字节数（KB / MB 口径，与 CLI 的 formatBytes 同义） */
export function formatBytes(tokens: number | undefined): string {
  if (tokens === undefined || tokens <= 0 || !Number.isFinite(tokens)) return '0';
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 缓存读占输入侧总量的比例（0-1） */
export function cacheHitRatio(usage: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number {
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (total <= 0) return 0;
  return (usage.cacheRead ?? 0) / total;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

/**
 * 从内容块生成单行预览（不解析完整 Markdown；折叠空白并截断）。
 */
export function previewOfBlocks(
  blocks: ReadonlyArray<{ type: string; text?: string }>,
  max: number = PREVIEW_OUTPUT_CHARACTERS,
): string {
  const text = blocks
    .filter((block) => (block.type === 'text' || block.type === 'thinking') && typeof block.text === 'string')
    .map((block) => block.text!)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, max);
}

/**
 * 有界的 Markdown → 纯文本预览（轻量实现：去标记而非完整解析）。
 * 与 dsh 的 trajectoryPreviewText 同语义（独立截断源与输出）。
 */
export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = stripMarkdown(source).replace(/\s+/g, ' ').trim();
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
  return source.length < text.length || preview.length < compact.length ? `${preview}…` : preview;
}

/** 轻量 Markdown 去标记（代码块 / 围栏 / 链接 / 强调 / 标题 / 列表符） */
function stripMarkdown(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ') // 围栏代码块整体保留为空白（预览不展示代码）
    .replace(/`[^`]*`/g, ' ') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文本
    .replace(/^#{1,6}\s+/gm, '') // 标题
    .replace(/[*_~]{1,3}/g, '') // 强调
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表
    .replace(/^\s*\d+\.\s+/gm, '') // 有序列表
    .replace(/^\s*>\s+/gm, '') // 引用
    .replace(/^\s*[-:| ]+$/gm, ' '); // 表格分隔行
}

/** epoch 毫秒 → 本地时间标签（HH:MM:SS.mmm） */
export function formatStartedAt(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'Not available';
  const date = new Date(timestamp);
  const two = (value: number): string => String(value).padStart(2, '0');
  const three = (value: number): string => String(value).padStart(3, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(
    date.getMilliseconds(),
  )}`;
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day} ${time}`;
}
