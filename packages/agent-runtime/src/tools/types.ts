/**
 * Tool interface and helper utilities
 */

import type { ToolDefinition, ToolInputSchema, ToolContext, ToolResult, ToolInputParams, JsonValue, ToolResultContent } from '../types.js'

/**
 * Safely extract a string from ToolInputParams.
 * Returns undefined if the value is not a string.
 */
export function getString(input: ToolInputParams, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Safely extract a required string from ToolInputParams.
 * Throws TypeError if the value is not a string or is undefined.
 */
export function getRequiredString(input: ToolInputParams, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') {
    throw new TypeError(`Expected string for key "${key}", got ${typeof value}`)
  }
  return value
}

/**
 * Safely extract a number from ToolInputParams.
 * Returns undefined if the value is not a number.
 */
export function getNumber(input: ToolInputParams, key: string): number | undefined {
  const value = input[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * Safely extract a boolean from ToolInputParams.
 * Returns undefined if the value is not a boolean.
 */
export function getBoolean(input: ToolInputParams, key: string): boolean | undefined {
  const value = input[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Safely extract an array from ToolInputParams.
 * Returns undefined if the value is not an array.
 */
export function getArray<T>(input: ToolInputParams, key: string): T[] | undefined {
  const value = input[key]
  return Array.isArray(value) ? value as T[] : undefined
}

/**
 * Safely extract an object from ToolInputParams.
 * Returns undefined if the value is not an object (or is null/array).
 */
export function getObject<T extends Record<string, unknown>>(input: ToolInputParams, key: string): T | undefined {
  const value = input[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as T : undefined
}

/**
 * Safely extract any JsonValue from ToolInputParams.
 */
export function getValue(input: ToolInputParams, key: string): JsonValue | undefined {
  return input[key]
}

/**
 * `defineTool({ call })` 允许返回的结构化结果：
 *  - `string`                          → content = 字符串，无 details
 *  - `{ data, is_error? }`             → 旧业务层风格（write_page / generate_blueprint 等）
 *  - `{ content, details?, is_error?}` → 需要回传图片块或结构化元信息时使用
 */
export type ToolCallReturn =
  | {
      data: string
      is_error?: boolean
      details?: JsonValue
      content?: never
    }
  | {
      /** 完整内容块（需要回传图片时使用） */
      content: ToolResultContent
      data?: string
      is_error?: boolean
      details?: JsonValue
    }

/**
 * Helper to create a tool definition with sensible defaults.
 */
export function defineTool(config: {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: ToolInputParams, context: ToolContext) => Promise<string | ToolCallReturn>
  isReadOnly?: boolean
  isConcurrencySafe?: boolean
  prompt?: string | ((context: ToolContext) => Promise<string>)
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    isReadOnly: () => config.isReadOnly ?? false,
    isConcurrencySafe: () => config.isConcurrencySafe ?? false,
    isEnabled: () => true,
    prompt: typeof config.prompt === 'function'
      ? config.prompt
      : async (_context: ToolContext) => (config.prompt as string) ?? config.description,
    async call(input: ToolInputParams, context: ToolContext): Promise<ToolResult> {
      try {
        const result = await config.call(input, context)
        if (typeof result === 'string') {
          return { type: 'tool_result', tool_use_id: '', content: result, is_error: false }
        }
        const hasContent = 'content' in result && result.content !== undefined
        return {
          type: 'tool_result',
          tool_use_id: '', // filled by engine
          content: hasContent ? result.content! : result.data,
          is_error: result.is_error ?? false,
          ...(result.details !== undefined ? { details: result.details } : {}),
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Error: ${message}`,
          is_error: true,
        }
      }
    },
  }
}

/**
 * Convert a ToolDefinition to API-compatible tool format.
 * Returns the normalized tool format used by providers.
 */
export function toApiTool(tool: ToolDefinition): {
  name: string
  description: string
  input_schema: ToolInputSchema
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}
