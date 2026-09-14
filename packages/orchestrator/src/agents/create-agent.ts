/**
 * createBlueprintAgent - 通用 Blueprint Agent 创建方法
 *
 * 封装逻辑：
 * - 加载 config 配置（model, apiKey, baseURL, apiType）
 * - 创建 Agent（pi AgentHarness）并执行提示词
 * - 处理执行过程中的日志和结果解析
 * - 支持进度回调（通过钩子机制）
 * - LLM 重试与 token 预算由适配层（harness）处理
 */

import { createAgent as CreateAgentSdk, hasZreadProvider, DEFAULT_MAX_AGENT_RETRY_DELAY_MS, DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS, addTokenUsage, emptyTokenUsage, type SDKMessage, type TokenUsage, type ToolDefinition, type RetryConfig } from '@zread-pi/agent-runtime';
import { getProjectHome, loadConfig, logger } from '@zread-pi/utils';
import type { CatalogEvent } from '../types.js';
import { isAssistantMessage, isPartialMessage, isResultMessage, isToolResultMessage, SYSTEM_PROMPTS } from './uitls.js';
import { loadProjectContextFiles, withProjectContext } from './context-files.js';
import { withStyleDiscipline } from './style-discipline.js';

/**
 * 创建 Blueprint Agent 的选项
 */
export interface CreateBlueprintAgentOptions {
  /** 自定义工具（会与 baseTools 合并） */
  tools: ToolDefinition[];
  /** 执行提示词 */
  prompts: string;
  /**
   * 兼容字段：折算成 token 预算（见 `TOKENS_PER_TURN`），调用方一般不再传。
   * `0` = 不限制预算。
   */
  maxTurns?: number;
  /** 显式 token 预算（覆盖 config 与 maxTurns 折算）；0 / 缺省 = 用 config */
  tokenBudget?: number;
  /**
   * 自定义系统提示（polish Agent 用）：给定后**完全替换**默认的
   * 「内置语言提示 + <project_context> + 文风纪律」组合，由调用方自备全文。
   */
  systemPrompt?: string;
  /** 进度回调（可选） */
  onEvent?: (event: CatalogEvent) => void;
}

/**
 * 执行结果
 */
export interface AgentResult {
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** Token 使用统计（harness usage ledger 的累计值） */
  tokenUsage?: TokenUsage;
  /** 最后一次响应的上下文体量（input + output + cacheRead + cacheWrite） */
  contextTokens?: number;
  /** 模型上下文窗口（来自 agent-runtime 的 system/init 事件） */
  contextWindow?: number;
}

/** 每「轮」折算的 token 预算（与适配层 `TOKENS_PER_TURN` 保持一致） */
const TOKENS_PER_TURN = 25_000;

/**
 * 一次响应的上下文体量（口径与 pi 的 compaction 判定一致：
 * input + output + cacheRead + cacheWrite，缓存读写也算进上下文）。
 */
function contextTokensFromUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const tokens =
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return tokens > 0 ? tokens : undefined;
}

/** 两段式预算提示文案（按文档语言本地化，并点名最终的输出工具） */
const BUDGET_NOTICES: Record<'zh' | 'en', { soft: (tool: string) => string; hard: (tool: string) => string }> = {
  zh: {
    soft: (tool) => `【系统提示】token 预算已用掉约 70%：请尽快收敛探索，优先把已获得的信息整理成完整结果并调用 ${tool} 输出。`,
    hard: (tool) => `【系统提示】token 预算即将耗尽：立即停止探索，直接调用 ${tool} 输出完整最终结果（不要只做文字总结），否则本次生成将以失败结束。`,
  },
  en: {
    soft: (tool) => `[System notice] About 70% of the token budget is used: start converging now and prepare to call ${tool} with the complete result.`,
    hard: (tool) => `[System notice] Token budget nearly exhausted: stop exploring and call ${tool} now to write the complete final result (do not merely summarize in text), otherwise this run will fail.`,
  },
};

/** 输出工具名（蓝图三阶段 / 页面 / 缩编 Agent 的最终产物；预算提示要点名当前阶段的工具） */
const OUTPUT_TOOL_NAMES = new Set([
  'submit_sections',
  'submit_section_topics',
  'refine_section_titles',
  'submit_condensed_sections',
  'submit_condensed_topics',
  'generate_blueprint',
  'write_page',
]);

/** 根据工具集与文档语言构造两段式提示；没有输出工具时返回 undefined（关闭提示） */
function buildBudgetNotices(
  tools: ToolDefinition[],
  docLanguage: 'zh' | 'en',
): { soft: string; hard: string } | undefined {
  const outputTool = tools.find((tool) => OUTPUT_TOOL_NAMES.has(tool.name));
  if (!outputTool) return undefined;
  return {
    soft: BUDGET_NOTICES[docLanguage].soft(outputTool.name),
    hard: BUDGET_NOTICES[docLanguage].hard(outputTool.name),
  };
}

/** 目标输出工具名（交卷判定的锚点） */
function outputToolNames(tools: ToolDefinition[]): string[] {
  return tools.filter((tool) => OUTPUT_TOOL_NAMES.has(tool.name)).map((tool) => tool.name);
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
  // token 预算：显式传参 > config.agent.token_budget > max_turns 折算（见适配层 resolveBudgetOptions）
  // `0` = 不限制预算；内核不再数轮次，`maxTurns` 仅作为折算依据。
  const maxTurns = options.maxTurns ?? config.agent.max_turns ?? 30;
  const configuredTokenBudget = config.agent.token_budget ?? 0;
  const tokenBudget = options.tokenBudget ?? (configuredTokenBudget > 0 ? configuredTokenBudget : undefined);
  const effectiveTokenBudget = tokenBudget ?? (maxTurns > 0 ? maxTurns * TOKENS_PER_TURN : 0);
  // 两段式预算提示：有输出工具时启用（无输出工具则无从交卷，也没有收尾一说）
  const notices = buildBudgetNotices(options.tools, docLanguage);
  const outputTools = outputToolNames(options.tools);

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

  logger.info(
    `模型: ${model}, 思考深度: ${thinkingLevel}, token 预算: ${effectiveTokenBudget > 0 ? effectiveTokenBudget : '不限制'}` +
      `${tokenBudget === undefined && maxTurns > 0 ? ` (由 max_turns=${maxTurns} 折算)` : ''}, baseURL: ${baseURL}`,
  );

  // Token 累积统计：assistant 事件带的是「该次响应」的用量（见 test:agent:http 断言），
  // 这里累加成「本次 Agent 运行至今」的累计快照，供 UI 的每页展示与跨页合计使用；
  // 最终以 result 事件的 usage（harness usage ledger 的权威累计）为准覆盖。
  let totalUsage: TokenUsage = emptyTokenUsage();

  // 上下文占比：窗口来自 system/init（本次解析出的模型），已用 = 最近一次响应的上下文体量。
  // 两者都是**每次响应**的报表值，与累计用量（totalUsage）不同口径。
  let contextWindow: number | undefined;
  let contextTokens: number | undefined;
  const contextFields = (): { contextWindow?: number; contextTokens?: number } => ({
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  });

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
            ...contextFields(),
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
            ...contextFields(),
          });
        },
      ],
    }],
  } : undefined;

  // 构建 retryConfig（两层重试，见适配层 retry.ts）：
  //  · Agent 层：指数退避（2s → 4s → 8s …，60s 封顶），失败尝试不写进会话；
  //  · Provider 层：由 pi-ai 的 retryProviderRequest 承担，**会读服务端 Retry-After**
  //    并按 60s 封顶（超过上限立即失败并交回 Agent 层退避）。
  // 旧实现是固定 10 秒延迟且忽略 Retry-After，429 高峰期会重试过早。
  const retryConfig: RetryConfig | undefined = maxRetries > 0 ? {
    maxRetries,
    baseDelayMs: 2000,
    maxDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
    retryableStatusCodes: [401, 403, 429, 500, 502, 503, 529],
    provider: {
      maxRetries,
      maxRetryDelayMs: DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
    },
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
          ...contextFields(),
        });
      }
      logger.warn(`API 错误，${info.delayMs / 1000}秒后重试 (${info.attempt}/${info.maxRetries}): ${info.error}`);
    },
  } : undefined;

  // 创建 Agent
  logger.info(`System prompt doc_language: ${docLanguage} => "${SYSTEM_PROMPTS[docLanguage]}"`);
  // 目标仓库自述（AGENTS.md / CLAUDE.md …）注入系统提示：仓库若有架构说明/约定术语，
  // 让生成的 wiki 与仓库自述一致，减少纯靠读代码的猜测（见 context-files.ts）。
  // 文风纪律（humanizer）作为最后一段追加：排在 <project_context> 之后，蓝图与页面 Agent 同时生效。
  const styleEnabled = config.polish?.enabled !== false;
  let systemPrompt: string;
  if (options.systemPrompt !== undefined) {
    // polish Agent 自备系统提示（纪律 + Embedded mode），不叠加项目上下文
    systemPrompt = options.systemPrompt;
  } else {
    const contextFiles = loadProjectContextFiles({ cwd: process.cwd(), agentDir: getProjectHome() });
    if (contextFiles.length > 0) {
      logger.info(`注入项目上下文文件: ${contextFiles.map((file) => file.path).join(', ')}`);
    }
    systemPrompt = withStyleDiscipline(
      withProjectContext(SYSTEM_PROMPTS[docLanguage], contextFiles),
      docLanguage,
      styleEnabled,
    );
    logger.info(`文风纪律（humanizer）注入: ${styleEnabled ? `${docLanguage} 版本` : '已关闭'}`);
  }
  const agent = CreateAgentSdk({
    model,
    apiKey,
    baseURL,
    providerId,
    cwd: process.cwd(),
    tools: options.tools,
    systemPrompt,
    maxTurns,
    budget: {
      // 显式 token 预算（不传则由 maxTurns 折算，见 resolveBudgetOptions）
      ...(tokenBudget === undefined ? {} : { maxTokens: tokenBudget }),
      forcedTurns: 1,
      outputTools,
      ...(notices ? { notices } : {}),
    },
    thinkingLevel,
    permissionMode: 'bypassPermissions',
    hooks,
    includePartialMessages: true,
    retryConfig,
  });

  // 发送开始事件
  options.onEvent?.({ type: 'requesting', usage: totalUsage, ...contextFields() });

  for await (const event of agent.query(options.prompts)) {
    const msg = event as SDKMessage;

    // 模型上下文窗口（本次运行解析出的模型；UI 的「上下文占比」分母）
    if (msg.type === 'system' && msg.subtype === 'init' && msg.context_window !== undefined) {
      contextWindow = msg.context_window;
    }

    // Partial 流式输出
    if (isPartialMessage(msg)) {
      options.onEvent?.({ type: 'responding', usage: totalUsage, ...contextFields() });
    }

    // Log progress
    if (isAssistantMessage(msg)) {
      if (msg.usage) {
        totalUsage = addTokenUsage(totalUsage, msg.usage);
        // 每次响应都带当前上下文报表值（最近一次响应为准）
        contextTokens = contextTokensFromUsage(msg.usage) ?? contextTokens;
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
          ...contextFields(),
        });

        return {
          durationMs: Math.round(performance.now() - startTime),
          tokenUsage: totalUsage,
          ...contextFields(),
        };
      } else {
        const errors = msg.errors?.join('\n') || msg.subtype;
        options.onEvent?.({
          type: 'error',
          error: errors,
          durationMs: Math.round(performance.now() - startTime),
          // 失败也要归账：带上最后一次累计用量，供 UI 合计（否则失败页记为 0）
          usage: totalUsage,
          ...contextFields(),
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
    ...contextFields(),
  };
}