/**
 * PI 版 LLM 提供商工厂：保持旧 createProvider(providerId, { apiKey, baseURL }) 契约，
 * 内部改用 pi-ai 的模型运行时（Models.completeSimple）发一次非流式补全请求。
 *
 * 业务用途：apps/cli 的 browse-chat（Wiki 阅读问答）与任何一次性文本请求。
 */

import type {
	Context as PiContext,
	Message as PiMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import { createRuntimeModel } from "../pi/runtime-model.js";
import type { ToolInputParams } from "../types.js";
import type {
	ApiType,
	CreateMessageParams,
	CreateMessageResponse,
	LLMProvider,
	NormalizedMessageParam,
	NormalizedResponseBlock,
} from "./types.js";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 把 open_zread 的归一化消息转换为 pi 的 Message。
 * 注意：pi 的上下文估算会读取 assistant 消息的 usage，因此 assistant 分支
 * 必须产出完整的 AssistantMessage（含 usage/stopReason），无论 content 是字符串还是块数组。
 */
function toPiMessage(message: NormalizedMessageParam, index: number): PiMessage {
	const timestamp = Date.now() + index;
	const blocks = typeof message.content === "string" ? undefined : message.content;

	if (message.role === "user") {
		if (typeof message.content === "string") {
			return { role: "user", content: message.content, timestamp };
		}
		const content = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => ({ type: "text" as const, text: block.text }));
		return { role: "user", content: content.length > 0 ? content : "", timestamp };
	}

	const assistantContent: Array<TextContent | ThinkingContent | ToolCall> = [];
	if (typeof message.content === "string") {
		assistantContent.push({ type: "text", text: message.content });
	} else {
		for (const block of blocks ?? []) {
			if (block.type === "text") assistantContent.push({ type: "text", text: block.text });
			else if (block.type === "thinking") assistantContent.push({ type: "thinking", thinking: block.thinking });
			else if (block.type === "tool_use") {
				assistantContent.push({
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: (block.input ?? {}) as Record<string, unknown>,
				});
			}
		}
	}

	return {
		role: "assistant",
		content: assistantContent,
		api: "unknown",
		provider: "unknown",
		model: "unknown",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp,
	} as unknown as PiMessage;
}

function toResponseBlocks(
	content: Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown>; id?: string }>,
): NormalizedResponseBlock[] {
	const blocks: NormalizedResponseBlock[] = [];
	for (const block of content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text ?? "" });
		} else if (block.type === "thinking") {
			blocks.push({ type: "reasoning", reasoning: block.thinking ?? "" });
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id ?? "",
				name: block.name ?? "",
				input: (block.arguments ?? {}) as unknown as ToolInputParams,
			});
		}
	}
	return blocks;
}

/**
 * 创建 pi 支撑的 LLM Provider。
 *
 * providerId 语义与旧实现一致：anthropic/openai/deepseek/zhipu/qwen/moonshot/custom 等；
 * 未登记的 providerId 回退为 OpenAI 兼容协议（旧实现会直接抛错）。
 */
export function createProvider(
	providerIdOrApiType: string,
	opts: { apiKey?: string; baseURL?: string },
): LLMProvider {
	const runtime = createRuntimeModel({
		providerId: providerIdOrApiType,
		modelId: "__pending__",
		apiKey: opts.apiKey,
		baseURL: opts.baseURL,
	});
	const apiType: ApiType = runtime.apiType;

	return {
		apiType,
		async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
			const scoped = createRuntimeModel({
				providerId: providerIdOrApiType,
				modelId: params.model,
				apiKey: opts.apiKey,
				baseURL: opts.baseURL,
				apiType,
				maxTokens: params.maxTokens,
			});

			const context: PiContext = {
				systemPrompt: params.system,
				messages: params.messages.map(toPiMessage),
			};

			const message = await scoped.completeSimple(scoped.model, context, {
				maxTokens: params.maxTokens,
			});

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `LLM request failed (${message.stopReason})`);
			}

			return {
				content: toResponseBlocks(message.content),
				stopReason: message.stopReason,
				usage: {
					input_tokens: message.usage.input,
					output_tokens: message.usage.output,
					cache_creation_input_tokens: message.usage.cacheWrite,
					cache_read_input_tokens: message.usage.cacheRead,
				},
			};
		},
	};
}
