/**
 * pi 运行时桥接：把 zread-pi 的 LLM 配置（providerId / model / apiKey / baseURL）
 * 解析为 pi-ai 的 Provider + Model，并暴露 streamSimple / completeSimple 供业务使用。
 *
 * 两条路径：
 * 1. catalog 路径（优先）：providerId 命中 pi-ai 内置 provider 或 ~/.zread/config.yaml
 *    里配置过的 provider 时，直接使用 provider-catalog 里的 Models 集合：
 *      · 真实模型元数据（contextWindow / maxTokens / cost / reasoning）
 *      · OAuth 凭据自动刷新，凭据来自 ~/.zread/auth.json
 *      · 用户自定义模型（llm.providers.<id>.models）自动合并
 * 2. 回退路径：providerId 未知（旧配置 / 第三方网关），沿用单模型 Provider：
 *      未登记 providerId 回退 OpenAI 兼容协议（旧实现会抛 "Unsupported provider"）。
 */

import {
	createModels,
	createProvider as createPiProvider,
	type Api,
	type AssistantMessage,
	type Context as PiContext,
	type Model,
	type MutableModels,
	type ProviderStreams,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ApiType } from "../providers/types.js";
import {
	getZreadCatalog,
	getZreadModel,
	getZreadProvider,
} from "./provider-catalog.js";

/** providerId / apiType -> pi API 实现名 */
const ANTHROPIC_PROVIDER_IDS = new Set([
	"anthropic",
	"anthropic-messages",
	"claude",
	"claude-code",
	"bedrock-anthropic",
]);

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** 默认模型窗口/输出上限（旧 SDK 由 MODEL_PRICING 表提供，这里给保守默认值） */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export interface RuntimeModelOptions {
	/** 显式 providerId（来自 ~/.zread/config.yaml 的 llm.provider） */
	providerId?: string;
	/** 模型 id（来自 llm.model） */
	modelId: string;
	/** API Key（旧版扁平配置；新版凭据在 ~/.zread/auth.json） */
	apiKey?: string;
	/** 自定义 baseURL（来自 llm.base_url） */
	baseURL?: string;
	/** 兼容旧字段：显式 API 协议 */
	apiType?: ApiType;
	contextWindow?: number;
	maxTokens?: number;
}

export interface RuntimeModel {
	models: MutableModels;
	model: Model<Api>;
	apiType: ApiType;
	providerId: string;
	/** 绑定好凭据的流式请求入口 */
	streamSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): ReturnType<MutableModels["streamSimple"]>;
	/** 绑定好凭据的非流式请求入口 */
	completeSimple(model: Model<Api>, context: PiContext, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

/**
 * 依 baseURL / providerId / 模型名推断 providerId（等价旧 Agent#extractProviderId）。
 */
export function inferProviderId(options: {
	providerId?: string;
	modelId: string;
	baseURL?: string;
	apiType?: ApiType;
}): string {
	const baseUrl = options.baseURL?.toLowerCase() ?? "";
	if (baseUrl.includes("/anthropic")) return "anthropic";

	if (options.providerId) return options.providerId;

	// "anthropic/claude-sonnet-4-6" 形式
	const slashIndex = options.modelId.indexOf("/");
	if (slashIndex > 0) return options.modelId.slice(0, slashIndex);

	const modelLower = options.modelId.toLowerCase();
	if (modelLower.includes("claude")) return "anthropic";
	if (modelLower.includes("gpt") || modelLower.includes("o1") || modelLower.includes("o3")) {
		return "openai";
	}

	if (options.apiType === "openai-completions") return "openai-compatible";
	return "anthropic";
}

/** providerId -> zread-pi 的双协议语义（anthropic-messages | openai-completions） */
export function resolveApiType(providerId: string, apiType?: ApiType): ApiType {
	if (apiType) return apiType;
	return ANTHROPIC_PROVIDER_IDS.has(providerId.toLowerCase()) ? "anthropic-messages" : "openai-completions";
}

function apiStreamsFor(apiType: ApiType): ProviderStreams {
	return apiType === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi();
}

/** pi 的 api 名 -> 旧的双协议语义（仅用于工具上下文的提示字段） */
function toLegacyApiType(api: Api): ApiType {
	return api === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
}

function withApiKeyOverride(
	options: SimpleStreamOptions | undefined,
	apiKey: string | undefined,
): SimpleStreamOptions | undefined {
	if (!apiKey || options?.apiKey) return options;
	return { ...options, apiKey };
}

/**
 * 在 catalog 里解析模型：
 * - 命中内置/自定义模型 → 直接用其元数据（可被显式 baseURL / contextWindow / maxTokens 覆盖）
 * - 未命中（例如用户在旧配置里写了内置 provider 的未登记模型）→ 依 provider 首个模型的协议合成
 */
function resolveCatalogModel(options: RuntimeModelOptions, providerId: string): Model<Api> {
	const existing = getZreadModel(providerId, options.modelId);
	if (existing) {
		const patched: Model<Api> = { ...existing };
		if (options.baseURL) patched.baseUrl = options.baseURL;
		if (options.contextWindow) patched.contextWindow = options.contextWindow;
		if (options.maxTokens) patched.maxTokens = options.maxTokens;
		return patched;
	}

	const provider = getZreadProvider(providerId);
	const baseline = provider?.getModels()[0];
	const api: Api = options.apiType === "anthropic-messages"
		? "anthropic-messages"
		: (baseline?.api ?? "openai-completions");
	const baseUrl =
		options.baseURL ??
		baseline?.baseUrl ??
		provider?.baseUrl ??
		(api === "anthropic-messages" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);

	return {
		id: options.modelId,
		name: options.modelId,
		api,
		provider: providerId,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	};
}

/**
 * 构建 pi 运行时模型。
 *
 * catalog 命中时使用 pi-ai 的 Models 集合（OAuth/多 provider 生效）；
 * 否则回退为「单模型 Provider + 闭包 apiKey/baseURL」的旧路径。
 */
export function createRuntimeModel(options: RuntimeModelOptions): RuntimeModel {
	const providerId = inferProviderId({
		providerId: options.providerId,
		modelId: options.modelId,
		baseURL: options.baseURL,
		apiType: options.apiType,
	});

	if (getZreadProvider(providerId)) {
		const model = resolveCatalogModel(options, providerId);
		const models = getZreadCatalog().models;
		return {
			models,
			model,
			apiType: options.apiType ?? toLegacyApiType(model.api),
			providerId,
			streamSimple: (streamModel, context, streamOptions) =>
				models.streamSimple(streamModel, context, withApiKeyOverride(streamOptions, options.apiKey)),
			completeSimple: (completeModel, context, completeOptions) =>
				models.completeSimple(completeModel, context, withApiKeyOverride(completeOptions, options.apiKey)),
		};
	}

	const apiType = resolveApiType(providerId, options.apiType);
	const baseUrl =
		options.baseURL ??
		(apiType === "anthropic-messages" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);

	const model: Model<Api> = {
		id: options.modelId,
		name: options.modelId,
		api: apiType,
		provider: providerId,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	};

	const provider = createPiProvider({
		id: providerId,
		name: providerId,
		baseUrl,
		auth: {
			apiKey: {
				name: `${providerId} API key`,
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					if (!options.apiKey) return undefined;
					return { auth: { apiKey: options.apiKey, baseUrl }, source: "zread-pi config" };
				},
			},
		},
		models: [model],
		api: apiStreamsFor(apiType),
	});

	const models = createModels();
	models.setProvider(provider);

	return {
		models,
		model,
		apiType,
		providerId,
		streamSimple: (streamModel, context, streamOptions) =>
			models.streamSimple(streamModel, context, streamOptions),
		completeSimple: (completeModel, context, completeOptions) =>
			models.completeSimple(completeModel, context, completeOptions),
	};
}
