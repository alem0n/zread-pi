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

export {
	createAgent,
	DEFAULT_FINALIZATION_NOTICE,
	DEFAULT_MAX_TURNS_EQUIVALENT,
	resolveBudgetOptions,
	TOKENS_PER_TURN,
} from "./agent.js";
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
// 首尾机制：token 预算（usage 事件/ledger 为权威来源）
// ---------------------------------------------------------------------------

export {
	BudgetController,
	DEFAULT_CONTINUE_PROMPT,
	DEFAULT_HARD_BUDGET_NOTICE,
	DEFAULT_SOFT_BUDGET_NOTICE,
	usageTokens,
} from "./harness/budget.js";
export type { BudgetNotices, BudgetOptions, BudgetSnapshot } from "./harness/budget.js";

// ---------------------------------------------------------------------------
// 用量归并（每页累计 / 跨 Agent 合计的唯一口径，见 usage.ts）
// ---------------------------------------------------------------------------

export { emptyTokenUsage, addTokenUsage, sumTokenUsage } from "./usage.js";

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
	processImage,
	resizeImage,
	formatDimensionNote,
	convertImageBytesToPng,
	convertToPng,
	loadPhoton,
} from "./tools/index.js";
export type {
	TruncationResult,
	TruncationOptions,
	WalkEntry,
	WalkOptions,
	ImageResizeOptions,
	ProcessImageOptions,
	ProcessImageResult,
	ResizedImage,
} from "./tools/index.js";

// ---------------------------------------------------------------------------
// 重试（判定/退避/重试循环均为 pi 的实现，见 MIGRATION.md §13）
// ---------------------------------------------------------------------------

export {
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
	DEFAULT_RETRY_CONFIG,
	isRetryableAssistantError,
	retryAssistantCall,
	retryDelayMs,
	toRetryPolicy,
	toStreamOptions,
} from "./retry.js";
export type { HarnessStreamRetryOptions, ProviderRetryConfig, RetryConfig } from "./retry.js";

// 事件桥的纯函数（request id 提取，排障用；供业务层 / 测试复用）
export { extractRequestId } from "./harness/events.js";

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
