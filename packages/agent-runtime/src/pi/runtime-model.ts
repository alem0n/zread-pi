/**
 * pi 运行时桥接：把 open_zread 的 LLM 配置（providerId / model / apiKey / baseURL）
 * 解析为 pi-ai 的 Provider + Model，并暴露 streamSimple 供 Agent 循环使用。
 *
 * 解析规则与旧 agent-sdk 的 Agent#extractProviderId() 保持一致（见文件末尾注释），
 * 唯一增强：旧实现遇到未登记的 providerId 会抛 "Unsupported provider"，
 * 这里对未知 providerId 回退到 OpenAI 兼容协议（绝大多数第三方网关均为该协议）。
 */

import {
	createModels,
	createProvider as createPiProvider,
	type Api,
	type Model,
	type MutableModels,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ApiType } from "../providers/types.js";

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
	/** API Key */
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

/** providerId -> open_zread 的双协议语义（anthropic-messages | openai-completions） */
export function resolveApiType(providerId: string, apiType?: ApiType): ApiType {
	if (apiType) return apiType;
	return ANTHROPIC_PROVIDER_IDS.has(providerId.toLowerCase()) ? "anthropic-messages" : "openai-completions";
}

function apiStreamsFor(apiType: ApiType): ProviderStreams {
	return apiType === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi();
}

/**
 * 构建 pi 运行时模型：一个只含单模型的 Provider + Models 集合。
 *
 * - baseUrl 走 Provider.auth.resolve() 注入，等价于 pi 官方 provider 工厂的做法；
 * - apiKey 同样由闭包提供，因此不需要 pi 的 credential store / 环境变量。
 */
export function createRuntimeModel(options: RuntimeModelOptions): RuntimeModel {
	const providerId = inferProviderId({
		providerId: options.providerId,
		modelId: options.modelId,
		baseURL: options.baseURL,
		apiType: options.apiType,
	});
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
					return { auth: { apiKey: options.apiKey, baseUrl }, source: "open-zread config" };
				},
			},
		},
		models: [model],
		api: apiStreamsFor(apiType),
	});

	const models = createModels();
	models.setProvider(provider);

	return { models, model, apiType, providerId };
}
