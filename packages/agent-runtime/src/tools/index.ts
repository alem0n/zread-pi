/**
 * 文件工具集
 *
 * Orchestrator 的三条工作流按名称引用这些工具（read / write / edit / find / grep / ls，
 * 已对齐上游 pi 的小写命名），因此导出常量名保持不变。
 *
 * 实现说明：
 *  - 搜索类（Glob / Grep / Ls）与写入类（Write / Edit）已按上游 pi 的实现重写，
 *    共享 `truncate` / `file-walk` / `glob-match` / `file-mutation-queue` 等基础设施；
 *  - 工具名与既有参数名保持向后兼容，新增参数均为可选。
 */

export { FileReadTool } from "./read.js";
export { FileWriteTool } from "./write.js";
export { FileEditTool } from "./edit.js";
export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { LsTool } from "./ls.js";

// 共享设施（供其它工具/测试复用）
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	GREP_MAX_LINE_LENGTH,
	appendToolNotices,
	byteLimitNotice,
	formatSize,
	toTruncationDetails,
	truncateHead,
	truncateLine,
	truncateTail,
	utf8ByteLength,
} from "./truncate.js";
export type { TruncationResult, TruncationOptions } from "./truncate.js";
export { matchGlobPath, globToRegExp, expandBraces } from "./glob-match.js";
export { BUILTIN_EXCLUDED_DIRS, MAX_WALK_ENTRIES, isInsideGitRepo, walkFiles } from "./file-walk.js";
export type { WalkEntry, WalkOptions } from "./file-walk.js";
export { findSearchBinary, resetSearchBinaryCache } from "./search-binaries.js";
export { normalizeEditInput } from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export { detectSupportedImageMimeType, encodeBase64 } from "@earendil-works/pi-agent-core/harness/tools/image";
// 图片处理管线（格式归一化 + 缩放），移植自 pi coding-agent 的 utils/image-*.ts
export { processImage, resizeImage, formatDimensionNote, convertImageBytesToPng, convertToPng, loadPhoton } from "./image/index.js";
export type { ImageResizeOptions, ProcessImageOptions, ProcessImageResult, ResizedImage } from "./image/index.js";
export { resolveReadPathAsync, resolveToCwd } from "./path-utils.js";

export {
	defineTool,
	toApiTool,
	getString,
	getRequiredString,
	getNumber,
	getBoolean,
	getArray,
	getObject,
	getValue,
} from "./types.js";
export type { ToolCallReturn } from "./types.js";
