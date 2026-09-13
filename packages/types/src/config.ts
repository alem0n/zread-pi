/**
 * Configuration Types
 *
 * Application configuration structure
 */

/**
 * 登录/认证方式：
 * - api_key: 用户输入的 API Key（保存在 ~/.zread-pi/auth.json）
 * - oauth:   pi-ai 的 OAuth 订阅登录（Claude Pro/Max、Codex、Copilot 等）
 */
export type LlmAuthType = 'api_key' | 'oauth';

/**
 * ThinkingLevel - pi 的思考深度等级（thinking level）
 *
 * 与 pi-ai 的 ModelThinkingLevel 一致：
 * - off：关闭扩展思考（不发送 reasoning 参数）
 * - minimal / low / medium / high：由浅到深
 * - xhigh / max：仅部分模型支持（需模型显式在 thinkingLevelMap 中声明）
 *
 * pi 在请求时会按模型能力自动调整（clamp）到最近的受支持等级。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * CustomModelConfig - 用户为某个 Provider 追加的自定义模型
 *
 * 与 pi 的 models.json 语义一致：id 与内置模型相同则覆盖，否则新增。
 */
export interface CustomModelConfig {
  /** 模型 id（请求时发送给 API 的标识） */
  id: string;
  /** 展示名（缺省用 id） */
  name?: string;
  /** 覆盖协议（缺省沿用 provider 的 api） */
  api?: string;
  /** 覆盖 base URL（缺省沿用 provider） */
  base_url?: string | null;
  /** 上下文窗口（tokens，缺省 128000） */
  context_window?: number;
  /** 最大输出 tokens（缺省 16384） */
  max_tokens?: number;
  /** 是否支持思考/推理 */
  reasoning?: boolean;
  /** 是否支持图片输入 */
  supports_vision?: boolean;
}

/**
 * LlmProviderConfig - 单个 Provider 的持久化配置
 *
 * 凭据（API Key / OAuth token）不在这里，而是交给 pi-ai 的 CredentialStore，
 * 落盘在 ~/.zread-pi/auth.json —— 因此可以同时登录多个 Provider。
 */
export interface LlmProviderConfig {
  /** 最近一次成功使用的认证方式（仅用于展示与预选） */
  auth_type?: LlmAuthType | null;
  /** 覆盖 pi-ai 内置 baseUrl（自定义端点/代理） */
  base_url?: string | null;
  /** 自定义 Provider 使用的协议（内置 Provider 可缺省） */
  api?: string | null;
  /** 该 Provider 下用户自定义的模型 */
  models?: CustomModelConfig[];
  /** 最近一次为该 Provider 选择的模型 */
  model?: string | null;
}

/**
 * LLMConfig - LLM Provider Configuration
 *
 * provider/model/api_key/base_url 是「当前生效」的扁平字段（保持旧契约），
 * providers 保存每个 Provider 的完整配置，支持同时配置多个 Provider。
 */
export interface LLMConfig {
  provider: string | null;
  model: string | null;
  api_key: string | null;
  base_url: string | null;
  /**
   * pi 的思考深度（thinking level）。
   *
   * 作为全局默认值传给运行时；模型不支持时会由 pi 自动调整。
   * 旧配置缺省时按 'off' 处理（validateConfig 会补齐）。
   */
  thinking_level: ThinkingLevel;
  providers: Record<string, LlmProviderConfig>;
}

/**
 * AgentConfig - Agent 运行时配置
 *
 * 与 LLM 解析无关的运行时旋钮，由 Orchestrator 在每次创建 Agent 时读取。
 */
export interface AgentConfig {
  /**
   * 每次 Agent 运行的 token 预算（首尾机制升级后的权威预算）。
   *
   * 判据是 harness usage 事件/ledger 的**累计 tokens**（input + output + cache），
   * 比轮数更精准：软提示（默认 70% 预算）与硬提示都在钩子里按累计 tokens 判定。
   * 缺省 0 = 未显式配置，按 `max_turns * 25000`（见 `TOKENS_PER_TURN`）折算；
   * 显式 `max_turns: 0` 且本字段为 0 = 不限制预算（仍受上下文窗口与取消约束）。
   */
  token_budget: number;
  /**
   * @deprecated 轮数已不再是停止判据（内核不再数轮次）。
   *
   * 该字段折算成 token 预算：`max_turns * 25000` tokens；`0` = 不限制预算。
   * 配置界面 /config/max-turns 仍维护本字段。
   */
  max_turns: number;
}

/**
 * ToolConfig - 单个外部工具的配置
 *
 * 用户只表达「是否允许使用」这一意图；
 * 「装没装、装在哪、什么版本」属于运行时探测到的事实（见 `@zread-pi/utils` 的 tools/installer），
 * 不写进 config.yaml，避免配置文件与实际文件系统状态不一致。
 */
export interface ToolConfig {
  /**
   * 是否允许使用该外部工具。
   *
   * `false` = 即使系统里装了也只是不用（搜索类工具会退回内置纯 JS 实现）。
   */
  enabled: boolean;
}

/**
 * ToolsConfig - 外部工具配置表（以工具 id 为键）
 *
 * 新增工具只需在 `@zread-pi/utils` 的工具注册表里登记，这里无需改类型：
 * 未登记的键会被忽略，未出现的键按注册表默认值（enabled=true）补齐。
 */
export type ToolsConfig = Record<string, ToolConfig>;

/**
 * PolishMode - 文风纪律（humanizer）的作用模式
 *
 * - prompt-only：只做第 1 层预防——把风格纪律拼进蓝图 / 页面 Agent 的系统提示（零额外调用）；
 * - full：预防 + 第 2 层兜底——每页落盘后多跑一次轻量 polish Agent（每页多一次 LLM 调用）。
 */
export type PolishMode = 'prompt-only' | 'full';

/**
 * PolishConfig - 文风润色配置（配置界面 /config/polish 维护）
 *
 * `enabled = false` = 完全关闭：既不注入风格纪律，也不跑 polish Agent。
 * 旧 config.yaml 没有该段时由 validateConfig 补齐默认值（启用 + prompt-only）。
 */
export interface PolishConfig {
  enabled: boolean;
  mode: PolishMode;
}

/**
 * AppConfig - Configuration
 */
export interface AppConfig {
  language: string;
  doc_language: string;
  llm: LLMConfig;
  /** Agent 运行时配置（旧 config.yaml 缺少该段时由 validateConfig 补齐默认值） */
  agent: AgentConfig;
  /** 文风纪律 / 页面润色（旧 config.yaml 缺少该段时由 validateConfig 补齐默认值） */
  polish: PolishConfig;
  /** 外部工具（rg / fd …）的启用开关，配置界面 /config/tools 维护 */
  tools: ToolsConfig;
  concurrency: {
    max_concurrent: number;
    max_retries: number;
  };
}
