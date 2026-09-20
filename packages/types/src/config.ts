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
 * ThinkingLevelMap - 思考等级映射（与 pi-ai 的 `ThinkingLevelMap` 同形）
 *
 * 键为 pi 的思考等级，值为三态（与 pi 的 models.json 语义一致）：
 * - 缺省：`off`~`high` 使用 provider 默认映射；`xhigh`/`max` 视为**不支持**
 * - string：该等级受支持，且此字符串就是发送给 provider 的值
 * - null：该等级显式不支持（UI 隐藏，请求时由 pi 钳制到最近的受支持等级）
 *
 * zread-pi 的配置界面只暴露 `xhigh` / `max` 两个扩展档（值写等级名本身）；
 * 需要自定义发送值或调整标准档时，可直接编辑 config.yaml。
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

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
  /**
   * 思考等级映射（pi 的 thinkingLevelMap；仅 `reasoning: true` 时有意义）。
   *
   * 缺省时不写入，自定义模型在 pi 眼里是「普通推理模型」：
   * 最高只到 `high`，`xhigh`/`max` 会在请求时被 pi 钳制掉（pi 的 opt-in 语义）。
   * 声明例如 `{ max: "max" }` 后，`/config/thinking` 才会把 `max` 列为受支持等级。
   */
  thinking_level_map?: ThinkingLevelMap;
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
  /**
   * 自定义 Provider 的显示名称（缺省用 provider id）。
   *
   * 由配置界面「新建/编辑自定义 Provider」维护；内置 Provider 的名称来自 pi-ai 目录，
   * 写入本字段也不会生效（buildCatalog 优先使用目录名）。
   */
  name?: string | null;
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
  /**
   * 当前生效模型的「上下文窗口」覆盖（tokens）。
   *
   * `null` / 缺省 = 跟随模型目录（pi-ai 内置或用户自定义模型）自带的 contextWindow；
   * 显式正值会覆盖目录值，同时影响上下文压缩阈值与 UI「上下文占比」的分母。
   * 由配置界面 /config/model-size 维护（旧 config.yaml 缺省时归一化为 null）。
   */
  context_window?: number | null;
  /**
   * 当前生效模型的「最大输出 tokens」覆盖。
   *
   * `null` / 缺省 = 跟随模型目录自带的 maxTokens；显式正值会覆盖请求时的输出上限
   * （实际值仍会按上下文窗口钳制，见 pi-ai 的 `clampMaxTokensToContext`）。
   * 由配置界面 /config/model-size 维护（旧 config.yaml 缺省时归一化为 null）。
   */
  max_tokens?: number | null;
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
 * BlueprintDetailLevel - 蓝图细节档位（blueprint.detail）
 *
 * 决定三阶段蓝图（分类 → 分主题 → 标题）的「项目理解深度」：
 * - minimal：1 个分类（概览）· 1 篇全景导览，跳过标题精修，页面必须用 Mermaid 架构图梳理模块关系；
 * - low：3~5 个分类 · 每分类 1~3 篇，跳过标题精修；
 * - medium：4~6 个分类 · 每分类 3~5 篇；
 * - high（默认）：4~8 个分类 · 每分类 3~10 篇（与旧行为一致）；
 * - max：4~8 个分类 · 每分类 5~12 篇，强调全面详尽与更深关联文件探索。
 *
 * 数量控制由四层机制承担：提示词数量目标 + 常驻数量反馈 + AI 归并 + 代码确定性兜底。
 */
export type BlueprintDetailLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max';

/**
 * BlueprintConfig - 蓝图生成配置（配置界面 /config/detail 维护）
 *
 * 旧 config.yaml 没有该段时由 validateConfig 补齐默认 high（老用户零变化）。
 */
export interface BlueprintConfig {
  detail: BlueprintDetailLevel;
}

/**
 * ContentGateMode - 内容密度门的作用模式
 *
 * 移植自 lecture-to-notes 的 `verify_notes.py::density_gate`（把「这篇文档是否干瘪」
 * 从主观判断变成机械可判定的指标），但把强阻断改成可降级：
 * - off：完全跳过（不计算、不记录）；
 * - warn（默认）：计算并记录进 `PageResult.gate`，**不拦截** write_page；
 * - enforce：在 write_page 内拦截（与 Mermaid 引号校验同一位置），
 *   返回 is_error + 「当前 N / 下限 M」的常驻反馈让模型重写；
 *   预算用尽仍未通过时走 best-effort 落盘降级（见 AGENTS.md §3 内容密度门），不判页失败。
 */
export type ContentGateMode = 'off' | 'warn' | 'enforce';

/**
 * QualityConfig - 内容质量门（配置界面 /config/quality 维护）
 *
 * 旧 config.yaml 没有该段时由 validateConfig 补齐默认值（contentGate 启用 + warn、
 * verifyAfterGenerate 关闭），老用户升级行为零变化。
 */
export interface QualityConfig {
  /** 内容密度门（页面是否只有干瘪 TL;DR 的机械判定） */
  contentGate: {
    enabled: boolean;
    mode: ContentGateMode;
  };
  /** 生成完成后是否自动跑一次 verify-wiki（缺省 false，避免拖慢生成） */
  verifyAfterGenerate: boolean;
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
  /** 蓝图细节档位（旧 config.yaml 缺少该段时由 validateConfig 补齐默认 high） */
  blueprint: BlueprintConfig;
  /**
   * 内容质量门（内容密度门 + 生成后自动校验；旧 config.yaml 缺少该段时由
   * validateConfig 补齐默认值：contentGate 启用 + warn、verifyAfterGenerate 关闭）
   */
  quality: QualityConfig;
  /** 外部工具（rg / fd …）的启用开关，配置界面 /config/tools 维护 */
  tools: ToolsConfig;
  concurrency: {
    max_concurrent: number;
    max_retries: number;
  };
}
