/**
 * Configuration Types
 *
 * Application configuration structure
 */

/**
 * 登录/认证方式：
 * - api_key: 用户输入的 API Key（保存在 ~/.zread/auth.json）
 * - oauth:   pi-ai 的 OAuth 订阅登录（Claude Pro/Max、Codex、Copilot 等）
 */
export type LlmAuthType = 'api_key' | 'oauth';

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
 * 落盘在 ~/.zread/auth.json —— 因此可以同时登录多个 Provider。
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
  providers: Record<string, LlmProviderConfig>;
}

/**
 * AppConfig - Configuration
 */
export interface AppConfig {
  language: string;
  doc_language: string;
  llm: LLMConfig;
  concurrency: {
    max_concurrent: number;
    max_retries: number;
  };
}
