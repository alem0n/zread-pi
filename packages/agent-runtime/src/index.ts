/**
 * @zread-pi/agent-runtime
 *
 * zread-pi 的 Agent 运行时层：对外暴露原先由 agent-sdk 提供的公共契约，
 * 内部实现由 pi 提供（@earendil-works/pi-ai + @earendil-works/pi-agent-core）。
 *
 * 迁移对照：
 *   agent-sdk.createAgent  -> 本包 createAgent（pi Agent 循环 + 重试编排）
 *   agent-sdk.createProvider -> 本包 createProvider（pi-ai Models）
 *   agent-sdk 的 32 个工具 -> 本包仅保留业务实际使用的 5 个文件工具 + defineTool 辅助
 *   agent-sdk 的 MCP / Skill / Task / Team / LSP / Cron -> 未迁移（当前业务链路未使用）
 */

// ---------------------------------------------------------------------------
// Agent 入口
// ---------------------------------------------------------------------------

export { createAgent, DEFAULT_FINALIZATION_NOTICE } from "./agent.js";
export type { AgentInstance, AgentOptions, CompactionOptions, FinalizationOptions, HookConfig } from "./agent.js";

// ---------------------------------------------------------------------------
// LLM 提供商
// ---------------------------------------------------------------------------

export { createProvider } from "./providers/index.js";
export type {
	ApiType,
	LLMProvider,
	CreateMessageParams,
	CreateMessageResponse,
	NormalizedMessageParam,
	NormalizedContentBlock,
	NormalizedTool,
	NormalizedResponseBlock,
} from "./providers/index.js";

// ---------------------------------------------------------------------------
// Provider 目录（pi-ai 登录 / 模型列表 / 多 Provider 配置）
// ---------------------------------------------------------------------------

export {
	CUSTOM_PROVIDER_APIS,
	getZreadCatalog,
	reloadZreadCatalog,
	setZreadCatalogConfig,
	hasZreadProvider,
	getZreadProvider,
	getZreadProviderModels,
	getZreadModel,
	getZreadThinkingLevels,
	listZreadProviders,
	refreshZreadProviderModels,
	loginZreadProvider,
	logoutZreadProvider,
	resolveZreadProviderAuth,
	streamZreadModel,
	completeZreadModel,
} from "./pi/provider-catalog.js";
export type { ZreadCatalog, ZreadProviderSummary, CustomProviderApi } from "./pi/provider-catalog.js";
export { FileCredentialStore } from "./pi/auth-store.js";
export { FileModelsStore } from "./pi/models-store.js";
export { createRuntimeModel, inferProviderId, resolveApiType } from "./pi/runtime-model.js";
export type { RuntimeModel, RuntimeModelOptions } from "./pi/runtime-model.js";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export { FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, LsTool } from "./tools/index.js";
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
} from "./tools/index.js";
export type { ToolCallReturn } from "./tools/index.js";
// 工具层共享设施（截断 / glob / 遍历 / 二进制探测）
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
	matchGlobPath,
	globToRegExp,
	expandBraces,
	BUILTIN_EXCLUDED_DIRS,
	walkFiles,
	findSearchBinary,
	resetSearchBinaryCache,
	detectSupportedImageMimeType,
	encodeBase64,
} from "./tools/index.js";
export type { TruncationResult, TruncationOptions, WalkEntry, WalkOptions } from "./tools/index.js";

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

export { DEFAULT_RETRY_CONFIG, isRetryableMessage, computeBackoff } from "./retry.js";
export type { RetryConfig } from "./retry.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type {
	SDKMessage,
	SDKAssistantMessage,
	SDKToolResultMessage,
	SDKResultMessage,
	SDKPartialMessage,
	SDKSystemMessage,
	Message,
	AssistantMessage,
	UserMessage,
	ConversationMessage,
	ContentBlock,
	ContentBlockParam,
	TokenUsage,
	ToolDefinition,
	ToolInputSchema,
	ToolInputSchemaProperty,
	ToolInputParams,
	ToolContext,
	ToolResult,
	PermissionMode,
	CanUseToolFn,
	CanUseToolResult,
	JsonValue,
} from "./types.js";
