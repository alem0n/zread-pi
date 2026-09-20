/**
 * 事件桥：harness 的 `HarnessEvent` → zread-pi 的 `SDKMessage`。
 *
 * 映射保持与裸 agent loop 时期逐字一致（CLI / orchestrator 的 mapper 依赖这些载荷）：
 *   message_update   → partial_message（text_delta / toolcall_delta）
 *   message_end      → assistant（含 usage）
 *   tool_end         → tool_result（output + details）
 *   compaction_end   → system/compact_boundary（in-run 压缩段）
 *   retry_scheduled  → 业务侧 retry 回调（CatalogEvent.type = 'retry'）
 *
 * 权威用量（usage ledger）通过 `usage` 事件读取，不在这里派生。
 */

import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { ContentBlock, JsonValue, SDKMessage, ToolInputParams, TokenUsage } from "../types.js";

/** pi 的 Usage → SDK 的 TokenUsage（字段名冻结） */
export function mapUsage(usage: Usage | undefined): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		input_tokens: usage.input,
		output_tokens: usage.output,
		cache_creation_input_tokens: usage.cacheWrite,
		cache_read_input_tokens: usage.cacheRead,
	};
}

/** assistant 消息内容块 → SDK 的 ContentBlock（含 thinking / tool_use） */
export function mapAssistantContent(message: AssistantMessage): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			blocks.push({ type: "thinking", thinking: block.thinking });
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: (block.arguments ?? {}) as ToolInputParams,
			});
		}
	}
	return blocks;
}

/** 流式增量事件 → partial_message（其余事件返回 undefined） */
export function mapPartialEvent(event: AssistantMessageEvent): SDKMessage | undefined {
	switch (event.type) {
		case "text_delta":
			return { type: "partial_message", partial: { type: "text", text: event.delta } };
		case "toolcall_delta":
			return { type: "partial_message", partial: { type: "tool_use", input: event.delta } };
		default:
			return undefined;
	}
}

/** 工具结果内容块 → 纯文本视图（图片给可读占位；图片本体在模型上下文里） */
export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
					return String((block as { text?: string }).text ?? "");
				}
				if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
					const mediaType = (block as { mimeType?: string }).mimeType ?? "image";
					return `[image ${mediaType}]`;
				}
				return "";
			})
			.join("")
			.trim();
	}
	return "";
}

/** 组装 SDK 的 tool_result 事件 */
export function mapToolResult(toolUseId: string, toolName: string, content: unknown, details?: JsonValue): SDKMessage {
	return {
		type: "tool_result",
		result: {
			tool_use_id: toolUseId,
			tool_name: toolName,
			output: toolResultText(content),
			...(details !== undefined ? { details } : {}),
		},
	};
}

/**
 * 已知的 request-id 响应头名（小写；匹配时大小写不敏感）。
 *
 * 各 provider 用不同的头名回传请求标识：
 *   · OpenAI / Mistral / OpenRouter：`x-request-id`
 *   · Anthropic：`request-id`
 *   · AWS Bedrock：`x-amzn-requestid`
 * pi-ai 的 `headersToRecord` 透传原始键名，这里统一做归一化提取。
 */
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-amzn-requestid"];

/**
 * 从 provider 响应头提取 request id（大小写不敏感；取第一个非空值）。
 *
 * 用于排障：把 provider 侧的请求标识与本地轨迹关联起来。
 * 返回 undefined 表示该 provider / 该次响应没有回传 request id（不做硬性要求）。
 */
export function extractRequestId(headers: Record<string, string> | undefined): string | undefined {
	if (!headers) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = value;
	}
	for (const name of REQUEST_ID_HEADERS) {
		const value = normalized[name];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}
