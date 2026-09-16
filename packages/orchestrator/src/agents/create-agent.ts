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
import {
  getProjectHome,
  loadConfig,
  createLogger,
  buildAgentStartEvent,
  buildAgentEndEvent,
  buildMessageStartEvent,
  buildMessageDeltaEvent,
  buildMessageEndEvent,
  buildToolStartEvent,
  buildToolEndEvent,
  buildRetryEvent,
  buildCompactEvent,
  buildStatusEvent,
  previewOfBlocks,
  DELTA_THROTTLE_MS,
} from '@zread-pi/utils';
import type { AppendRunEvent } from '@zread-pi/utils';
import type { CatalogEvent } from '../types.js';
import { isAssistantMessage, isPartialMessage, isResultMessage, isToolResultMessage, SYSTEM_PROMPTS } from './uitls.js';
import { loadProjectContextFiles, withProjectContext } from './context-files.js';
import { withStyleDiscipline } from './style-discipline.js';

/** 本模块的命名 logger（Agent 的创建与事件流转）。 */
const agentLogger = createLogger('orchestrator.agent');

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
  /**
   * 轨迹日志 sink（可选）：把本次 Agent 的可回放事件写入 `<repo>/.zread-pi/runs/`。
   * sink 在构造时已绑定 Agent 身份（key / role / section / pageSlug），
   * 这里的 append 只传事件载荷。缺省 = 不记录（兼容旧调用方）。
   */
  runLog?: RunLogSink;
  /** 进度回调（可选） */
  onEvent?: (event: CatalogEvent) => void;
}

/**
 * 轨迹日志 sink：append 时自动带上 Agent 身份（编排层注入）。
 *
 * 事件语义见 `packages/types/src/run-event.ts`；落盘由 `RunLogWriter` 承担
 * （`packages/utils/src/trajectory-store/`），折叠 / 布局在 `@zread-pi/trajectory`。
 */
export interface RunLogSink {
  append(event: AppendRunEvent): void;
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
  // 模型大小覆盖（/config/model-size）：null = 跟随模型目录自带的 contextWindow / maxTokens。
  // 显式正值会同时影响请求输出上限（pi-ai 按上下文窗口钳制）与上下文压缩阈值，
  // 并作为 UI「上下文占比」的分母（system/init 的 context_window 来自此处解析出的模型）。
  const modelContextWindow = config.llm.context_window && config.llm.context_window > 0
    ? config.llm.context_window
    : undefined;
  const modelMaxTokens = config.llm.max_tokens && config.llm.max_tokens > 0
    ? config.llm.max_tokens
    : undefined;

  // 验证必需配置：
  // - model 必须显式选择；
  // - 凭据可以来自旧版 config.yaml 的 api_key，也可以来自 pi-ai 的 auth.json
  //   （catalog 认识的 provider 由 pi Models 自行解析凭据，OAuth 也走这条路）。
  const providerKnown = providerId ? hasZreadProvider(providerId) : false;
  if (!model || (!apiKey && !providerKnown)) {
    throw new Error('LLM configuration incomplete. Please run `zread-pi config` to configure.');
  }

  agentLogger.info(
    `模型: ${model}, 思考深度: ${thinkingLevel}, token 预算: ${effectiveTokenBudget > 0 ? effectiveTokenBudget : '不限制'}` +
      `${tokenBudget === undefined && maxTurns > 0 ? ` (由 max_turns=${maxTurns} 折算)` : ''}, baseURL: ${baseURL}` +
      `${modelContextWindow ? `, 上下文窗口覆盖: ${modelContextWindow}` : ''}` +
      `${modelMaxTokens ? `, 最大输出覆盖: ${modelMaxTokens}` : ''}`,
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

  // 构建钩子配置（onEvent 回调 / runLog sink 任一存在即安装）
  const onEvent = options.onEvent;
  // 工具结果的 isError 由 PostToolUse 钩子暂存（它先于流里的 tool_result 事件），
  // details 在流里的 tool_result 上（两者合并后写入轨迹日志）
  const toolErrors = new Map<string, boolean>();
  const hooks = onEvent || options.runLog ? {
    PreToolUse: [{
      hooks: [
        async (input: Record<string, unknown>, toolUseId: string) => {
          options.runLog?.append(
            buildToolStartEvent({
              callId: toolUseId,
              name: input.toolName as string,
              args: input.toolInput,
            }),
          );
          onEvent?.({
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
        async (input: Record<string, unknown>, toolUseId: string) => {
          if (options.runLog) toolErrors.set(toolUseId, input.isError === true);
          onEvent?.({
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
      // 轨迹日志：重试事件（挂在下一条 message_end 上，见 replay 的 pendingRetry）
      options.runLog?.append(
        buildRetryEvent({
          attempt: info.attempt,
          maxRetries: info.maxRetries,
          delayMs: info.delayMs,
          error: info.error,
        }),
      );
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
      agentLogger.warn(`API 错误，${info.delayMs / 1000}秒后重试 (${info.attempt}/${info.maxRetries}): ${info.error}`);
    },
  } : undefined;

  // 创建 Agent
  agentLogger.info(`System prompt doc_language: ${docLanguage} => "${SYSTEM_PROMPTS[docLanguage]}"`);
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
      agentLogger.info(`注入项目上下文文件: ${contextFiles.map((file) => file.path).join(', ')}`);
    }
    systemPrompt = withStyleDiscipline(
      withProjectContext(SYSTEM_PROMPTS[docLanguage], contextFiles),
      docLanguage,
      styleEnabled,
    );
    agentLogger.info(`文风纪律（humanizer）注入: ${styleEnabled ? `${docLanguage} 版本` : '已关闭'}`);
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
    contextWindow: modelContextWindow,
    maxTokens: modelMaxTokens,
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

  // 轨迹日志：Agent 启动（系统提示 / 工具目录 / 预算）
  options.runLog?.append(
    buildAgentStartEvent({
      prompt: options.prompts,
      systemPrompt,
      toolCatalog: options.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      model,
      provider: providerId,
      tokenBudget: effectiveTokenBudget > 0 ? effectiveTokenBudget : undefined,
    }),
  );

  // 流式消息的累计状态（message_start / message_delta 的预览由它生成）
  let streamText = '';
  let streamStarted = false;
  let streamLastDeltaAt = 0;

  // 发送开始事件
  options.onEvent?.({ type: 'requesting', usage: totalUsage, ...contextFields() });

  for await (const event of agent.query(options.prompts)) {
    const msg = event as SDKMessage;

    // 模型上下文窗口（本次运行解析出的模型；UI 的「上下文占比」分母）
    if (msg.type === 'system' && msg.subtype === 'init' && msg.context_window !== undefined) {
      contextWindow = msg.context_window;
    }

    // in-run 压缩段：轨迹日志记一条 compact
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      options.runLog?.append(buildCompactEvent({ summary: msg.summary }));
    }

    // 长操作的状态文案（如压缩进行中）
    if (msg.type === 'system' && msg.subtype === 'status') {
      options.runLog?.append(buildStatusEvent({ text: msg.message }));
    }

    // Partial 流式输出（delta 累积成预览：首个 delta → message_start，
    // 后续按 DELTA_THROTTLE_MS 节流 → message_delta）
    if (isPartialMessage(msg)) {
      if (msg.partial.type === 'text' && typeof msg.partial.text === 'string') {
        streamText += msg.partial.text;
        const preview = previewOfBlocks([{ type: 'text', text: streamText }]);
        if (!streamStarted) {
          streamStarted = true;
          streamLastDeltaAt = Date.now();
          options.runLog?.append(buildMessageStartEvent({ preview }));
        } else if (Date.now() - streamLastDeltaAt >= DELTA_THROTTLE_MS) {
          streamLastDeltaAt = Date.now();
          options.runLog?.append(buildMessageDeltaEvent({ preview }));
        }
      }
      options.onEvent?.({ type: 'responding', usage: totalUsage, ...contextFields() });
    }

    // Log progress
    if (isAssistantMessage(msg)) {
      if (msg.usage) {
        totalUsage = addTokenUsage(totalUsage, msg.usage);
        // 每次响应都带当前上下文报表值（最近一次响应为准）
        contextTokens = contextTokensFromUsage(msg.usage) ?? contextTokens;
      }

      // 轨迹日志：消息完成（完整内容块 + 用量；流式状态在此时重置）
      options.runLog?.append(
        buildMessageEndEvent({
          blocks: msg.message.content.map((block) =>
            block.type === 'tool_use'
              ? { type: 'tool_use', callId: block.id, name: block.name, input: block.input }
              : block,
          ),
          usage: msg.usage,
          contextWindow,
          model,
          provider: providerId,
        }),
      );
      streamText = '';
      streamStarted = false;

      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const toolInput = JSON.stringify(block.input || {});
          // 消息体可能含 % 字符，用 %s 占位原样传递，避免被 printf 误解析
          agentLogger.info('%s', `[${toolName}] ${toolInput}`);
        }
        if (block.type === 'text' && block.text) {
          agentLogger.info('%s', block.text);
        }
      }
    }

    if (isToolResultMessage(msg)) {
      const result = msg.result;
      // 轨迹日志：工具完成（output + details；isError 由 PostToolUse 钩子暂存）
      options.runLog?.append(
        buildToolEndEvent({
          callId: result.tool_use_id,
          name: result.tool_name,
          output: result.output,
          details: result.details,
          isError: toolErrors.get(result.tool_use_id),
        }),
      );
      toolErrors.delete(result.tool_use_id);
      agentLogger.info('%s', `[Tool Result: ${result.tool_name}] ${result.output}`);
    }

    if (isResultMessage(msg)) {
      if (msg.usage) {
        totalUsage = msg.usage;
      }

      // 轨迹日志：Agent 终态（成功 / 失败都记；用量为 harness ledger 的权威累计）
      options.runLog?.append(
        buildAgentEndEvent({
          subtype: msg.subtype,
          durationMs: Math.round(performance.now() - startTime),
          usage: msg.usage,
        }),
      );

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
            agentLogger.error(err);
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