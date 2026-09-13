/**
 * 工具桥：zread-pi 的 `ToolDefinition` → harness 的 `AgentHarnessTool`。
 *
 * 迁移要点（行为零偏移）：
 *   · 工具名 / schema / 描述原样透传（提示词与测试依赖工具名）；
 *   · 旧契约里 `is_error: true` 表示失败；harness 用「抛异常」表达失败，
 *     因此这里把 is_error 结果转成 throw，由 harness 落成 isError 的 toolResult 消息；
 *   · `ToolResult.content` 允许内容块数组（图片回传），与 harness 的 TextContent/ImageContent 对齐；
 *   · `ToolResult.details` 与 content 分离（不进模型上下文），
 *     外层再包一层 `{ toolUseId, details }` 保持 SDK 事件载荷与迁移前完全一致；
 *   · `isConcurrencySafe` → `executionMode`（并行/串行批次），与 pi Agent 语义一致。
 *
 * 工具上下文（cwd / 模型信息 / 图片能力）由 harness 的 `toolContext` 选项按 turn 快照解析，
 * 工具实现只从入参取用，不依赖闭包外部状态。
 */

import type { AgentHarnessTool, AgentToolResult as HarnessToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import type { ApiType } from "../providers/types.js";
import type { JsonValue, ToolContext, ToolDefinition, ToolInputParams, ToolResult } from "../types.js";

/** 工具执行上下文（cwd / 模型信息 / 图片能力），由 driver 在每次请求时构造 */
export interface ToolBridgeContext {
	cwd: string;
	model?: string;
	providerId?: string;
	apiType?: ApiType;
	/** 当前模型是否接受图片输入（决定 Read 是否回传 image 内容块） */
	supportsImages?: boolean;
}

/** harness 侧的 details 形态（外层包装，保证 `tool_result` 事件载荷不变） */
export interface BridgedToolDetails {
	toolUseId: string;
	details?: JsonValue;
}

type BridgeContent = TextContent | ImageContent;

/** 把 ToolResult.content 映射成 harness 的内容块数组（图片走 image 块）。 */
function toContentBlocks(result: ToolResult): BridgeContent[] {
	if (typeof result.content === "string") {
		return [{ type: "text", text: result.content }];
	}
	const blocks: BridgeContent[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && block.source.type === "base64") {
			blocks.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
		}
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "" });
	return blocks;
}

/** 纯文本视图（错误结果必须以文本进入模型上下文）。 */
export function toolResultToText(result: ToolResult): string {
	return toContentBlocks(result)
		.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
		.join("\n");
}

/** 单个工具定义 → harness 工具 */
export function toHarnessTool(
	definition: ToolDefinition,
): AgentHarnessTool<ToolBridgeContext, TSchema, BridgedToolDetails> {
	return {
		name: definition.name,
		label: definition.name,
		description: definition.description,
		parameters: definition.inputSchema as unknown as TSchema,
		executionMode: definition.isConcurrencySafe?.() === true ? "parallel" : "sequential",
		async execute(toolCallId, params, _onUpdate, bridge, _invocation, context) {
			const toolContext: ToolContext = {
				cwd: bridge.cwd,
				abortSignal: context.abortSignal,
				model: bridge.model,
				apiType: bridge.apiType,
				supportsImages: bridge.supportsImages,
			};
			const result = await definition.call(params as ToolInputParams, toolContext);
			if (result.is_error) {
				// harness 统一把 throw 归类为 isError 的工具结果（错误文本仍进入模型上下文）
				throw new Error(toolResultToText(result));
			}
			const bridged: HarnessToolResult<BridgedToolDetails> = {
				content: toContentBlocks(result),
				details: {
					toolUseId: toolCallId,
					...(result.details !== undefined ? { details: result.details } : {}),
				},
			};
			return bridged;
		},
	};
}

/** 批量桥接 */
export function toHarnessTools(
	definitions: ToolDefinition[],
): AgentHarnessTool<ToolBridgeContext, TSchema, BridgedToolDetails>[] {
	return definitions.map((definition) => toHarnessTool(definition));
}

/** 从桥接结果里取回业务层 details（`tool_result` 事件与钩子使用） */
export function unwrapBridgedDetails(details: unknown): JsonValue | undefined {
	if (details === null || typeof details !== "object") return undefined;
	return (details as BridgedToolDetails).details;
}
