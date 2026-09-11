/**
 * createBlueprintAgent - 通用 Blueprint Agent 创建方法
 *
 * 封装逻辑：
 * - 加载 config 配置（model, apiKey, baseURL, apiType）
 * - 创建 Agent 并执行提示词
 * - 处理执行过程中的日志和结果解析
 * - 支持进度回调（通过钩子机制）
 * - LLM API 重试由 agent-sdk 的 retryConfig 处理
 */

import { createAgent as CreateAgentSdk, hasZreadProvider, type SDKMessage, type TokenUsage, type ToolDefinition, type RetryConfig } from '@zread-pi/agent-runtime';
import { loadConfig, logger } from '@zread-pi/utils';
import type { CatalogEvent } from '../types.js';
import { isAssistantMessage, isPartialMessage, isResultMessage, isToolResultMessage, SYSTEM_PROMPTS } from './uitls.js';

/**
 * 创建 Blueprint Agent 的选项
 */
export interface CreateBlueprintAgentOptions {
  /** 自定义工具（会与 baseTools 合并） */
  tools: ToolDefinition[];
  /** 执行提示词 */
  prompts: string;
  /** 最大轮次 */
  maxTurns?: number;
  /** 进度回调（可选） */
  onEvent?: (event: CatalogEvent) => void;
}

/**
 * 执行结果
 */
export interface AgentResult {
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** Token 使用统计 */
  tokenUsage?: TokenUsage;
}

/** 轮次收尾提示文案（按文档语言本地化，并点名最终的输出工具） */
const FINALIZATION_NOTICES: Record<'zh' | 'en', (tool: string) => string> = {
  zh: (tool) => `【系统提示】轮次即将用尽：请立即停止探索，直接调用 ${tool} 输出完整最终结果（不要只做文字总结），否则本次生成将以失败结束。`,
  en: (tool) => `[System notice] Turn budget nearly exhausted: stop exploring and call ${tool} now to write the complete final result (do not merely summarize in text), otherwise this run will fail.`,
};

/** 输出工具名（蓝图/页面 Agent 的最终产物） */
const OUTPUT_TOOL_NAMES = new Set(['generate_blueprint', 'write_page']);

/** 根据工具集与文档语言构造收尾提示；没有输出工具时返回 undefined（关闭） */
function buildFinalizationNotice(tools: ToolDefinition[], docLanguage: 'zh' | 'en'): string | undefined {
  const outputTool = tools.find((tool) => OUTPUT_TOOL_NAMES.has(tool.name));
  return outputTool ? FINALIZATION_NOTICES[docLanguage](outputTool.name) : undefined;
}

/**
 * 创建并执行 Blueprint Agent
 *
 * 自动加载配置、创建 Agent、执行提示词并返回结果。
 * 支持通过 onEvent 回调实时传递进度事件。
 * LLM API 重试由 agent-sdk 内置的 retryConfig 处理。
 *
 * @param options - 创建选项
 * @returns 执行结果
 */
export async function createAgent(options: CreateBlueprintAgentOptions): Promise<AgentResult> {
  const startTime = performance.now();
  // 加载配置
  const config = await loadConfig();
  const docLanguage = config.doc_language as 'zh' | 'en';
  const maxRetries = config.concurrency.max_retries;
  // 最大轮次：调用方显式传入 > config.agent.max_turns > 适配层兜底 30；0 = 不限制轮次
  const maxTurns = options.maxTurns ?? config.agent.max_turns ?? 30;
  // 轮次收尾提示：只在有轮次预算时启用（maxTurns <= 0 = 不限制，无收尾一说）
  const finalizationNotice =
    maxTurns > 0 ? buildFinalizationNotice(options.tools, docLanguage) : undefined;

  // 提取 LLM 配置（null → undefined，SDK 不接受 null）
  const model = config.llm.model ?? undefined;
  const apiKey = config.llm.api_key ?? undefined;
  const baseURL = config.llm.base_url ?? undefined;
  const providerId = config.llm.provider ?? undefined;
  // pi 的思考深度（旧配置缺省 off）；模型不支持时由 pi 在请求时自动调整
  const thinkingLevel = config.llm.thinking_level ?? 'off';

  // 验证必需配置：
  // - model 必须显式选择；
  // - 凭据可以来自旧版 config.yaml 的 api_key，也可以来自 pi-ai 的 auth.json
  //   （catalog 认识的 provider 由 pi Models 自行解析凭据，OAuth 也走这条路）。
  const providerKnown = providerId ? hasZreadProvider(providerId) : false;
  if (!model || (!apiKey && !providerKnown)) {
    throw new Error('LLM configuration incomplete. Please run `zread-pi config` to configure.');
  }

  logger.info(`模型: ${model}, 思考深度: ${thinkingLevel}, 最大轮次: ${maxTurns > 0 ? maxTurns : '不限制'}, baseURL: ${baseURL}`);

  // Token 累积统计
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

  // 构建钩子配置（如果有 onEvent 回调）
  const onEvent = options.onEvent;
  const hooks = onEvent ? {
    PreToolUse: [{
      hooks: [
        async (input: Record<string, unknown>) => {
          onEvent({
            type: 'tool_start',
            toolName: input.toolName as string,
            toolInput: JSON.stringify(input.toolInput || {}).slice(0, 100),
            usage: totalUsage,
          });
        },
      ],
    }],
    PostToolUse: [{
      hooks: [
        async (input: Record<string, unknown>) => {
          onEvent({
            type: 'tool_result',
            toolName: input.toolName as string,
            output: String(input.toolOutput || '').slice(0, 200),
            usage: totalUsage,
          });
        },
      ],
    }],
  } : undefined;

  // 构建 retryConfig（重试由 agent-sdk 处理）
  const retryConfig: RetryConfig | undefined = maxRetries > 0 ? {
    maxRetries,
    baseDelayMs: 10000,  // 固定 10 秒延迟
    maxDelayMs: 10000,   // 保持兼容性
    retryableStatusCodes: [401, 403, 429, 500, 502, 503, 529],
    onRetry: (info) => {
      // 发射 retry 事件通知 UI
      if (onEvent) {
        onEvent({
          type: 'retry',
          retryCount: info.attempt,
          maxRetries: info.maxRetries,
          delayMs: info.delayMs,
          error: info.error,
          usage: totalUsage,
        });
      }
      logger.warn(`API 错误，${info.delayMs / 1000}秒后重试 (${info.attempt}/${info.maxRetries}): ${info.error}`);
    },
  } : undefined;

  // 创建 Agent
  logger.info(`System prompt doc_language: ${docLanguage} => "${SYSTEM_PROMPTS[docLanguage]}"`);
  const agent = CreateAgentSdk({
    model,
    apiKey,
    baseURL,
    providerId,
    cwd: process.cwd(),
    tools: options.tools,
    systemPrompt: SYSTEM_PROMPTS[docLanguage],
    maxTurns,
    finalization: finalizationNotice ? { notice: finalizationNotice } : undefined,
    thinkingLevel,
    permissionMode: 'bypassPermissions',
    hooks,
    includePartialMessages: true,
    retryConfig,
  });

  // 发送开始事件
  options.onEvent?.({ type: 'requesting', usage: totalUsage });

  for await (const event of agent.query(options.prompts)) {
    const msg = event as SDKMessage;

    // Partial 流式输出
    if (isPartialMessage(msg)) {
      options.onEvent?.({ type: 'responding', usage: totalUsage });
    }

    // Log progress
    if (isAssistantMessage(msg)) {
      if (msg.usage) {
        totalUsage = msg.usage;
      }

      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const toolInput = JSON.stringify(block.input || {});
          logger.progress(`[${toolName}]`, toolInput);
        }
        if (block.type === 'text' && block.text) {
          logger.info(block.text);
        }
      }
    }

    if (isToolResultMessage(msg)) {
      const result = msg.result;
      logger.info(`[Tool Result: ${result.tool_name}] ${result.output}`);
    }

    if (isResultMessage(msg)) {
      if (msg.usage) {
        totalUsage = msg.usage;
      }

      if (msg.subtype === 'success') {
        options.onEvent?.({
          type: 'complete',
          usage: totalUsage,
          durationMs: Math.round(performance.now() - startTime),
        });

        return {
          durationMs: Math.round(performance.now() - startTime),
          tokenUsage: totalUsage,
        };
      } else {
        const errors = msg.errors?.join('\n') || msg.subtype;
        options.onEvent?.({
          type: 'error',
          error: errors,
          durationMs: Math.round(performance.now() - startTime),
        });
        if (msg.errors) {
          for (const err of msg.errors) {
            logger.error(err);
          }
        }
        throw new Error(errors);
      }
    }
  }

  // 返回结果
  return {
    durationMs: Math.round(performance.now() - startTime),
    tokenUsage: totalUsage,
  };
}