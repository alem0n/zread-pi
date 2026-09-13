import { readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { parse, stringify } from 'yaml';
import type { AppConfig, CustomModelConfig, LlmAuthType, LlmProviderConfig, PolishConfig, PolishMode, ThinkingLevel, ToolsConfig } from '@zread-pi/types';
import { ensureDir, writeTextFileAtomic } from '../file-io';
import { withFileLock } from '../lockfile.js';
import { getProjectHome, projectHomePath } from '../project-home.js';
import { toolIds } from '../tools/registry';

/**
 * Agent 每次运行的 token 预算（首尾机制升级后的权威预算）
 *
 * 0 = 未显式配置，运行时按 `agent.max_turns * 25000` 折算（见 `@zread-pi/agent-runtime`
 * 的 `TOKENS_PER_TURN`）；显式配置则直接使用该值。
 */
export const DEFAULT_TOKEN_BUDGET = 0;

/** 归一化 token 预算：0 = 折算自 max_turns；非法值回退 0 */
export function normalizeTokenBudget(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TOKEN_BUDGET;
}

/**
 * Agent 每次运行的最大轮次（turn）配置
 *
 * 旧实现硬编码 30；现在由 `agent.max_turns` 控制，配置界面 /config/max-turns 维护。
 * 内核已不再数轮次：该值在适配层折算成 token 预算（`max_turns * TOKENS_PER_TURN`）。
 * `0` = 不限制预算（不倒数收尾、不因预算停止，仍受上下文窗口与取消约束）。
 */
export const DEFAULT_MAX_TURNS = 30;
export const MIN_MAX_TURNS = 0;
export const MAX_MAX_TURNS = 100;

/** 归一化最大轮次：0 = 不限制；非法/缺省值回退默认 30 */
export function normalizeMaxTurns(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_MAX_TURNS) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= MIN_MAX_TURNS) return parsed;
  }
  return DEFAULT_MAX_TURNS;
}

/**
 * 文风纪律 / 页面润色（humanizer）配置
 *
 * - enabled=false = 完全关闭（既不注入风格纪律，也不跑 polish Agent）；
 * - mode='prompt-only'（默认）= 只做第 1 层预防（系统提示注入，零额外调用）；
 * - mode='full' = 预防 + 第 2 层兜底（每页落盘后多跑一次轻量 polish Agent）。
 */
export const DEFAULT_POLISH_ENABLED = true;
export const DEFAULT_POLISH_MODE: PolishMode = 'prompt-only';

/** 配置界面可选的全部润色模式（顺序即展示顺序） */
export const POLISH_MODES: PolishMode[] = ['prompt-only', 'full'];

/** 判断任意值是否是合法的润色模式 */
export function isPolishMode(value: unknown): value is PolishMode {
  return value === 'prompt-only' || value === 'full';
}

/** 归一化润色配置：非法/缺省值回退默认（启用 + prompt-only），旧 config.yaml 无需迁移 */
export function normalizePolishConfig(value: unknown): PolishConfig {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_POLISH_ENABLED,
    mode: isPolishMode(raw.mode) ? raw.mode : DEFAULT_POLISH_MODE,
  };
}

/**
 * pi 支持的思考深度等级（与 pi-ai 的 ModelThinkingLevel 对齐，按由浅到深排序）
 *
 * off = 关闭扩展思考；xhigh / max 仅部分模型支持。
 */
export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** 判断任意值是否是合法的思考深度等级 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as string[]).includes(value);
}

/** 归一化思考深度：非法/缺省值回退 'off' */
export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return isThinkingLevel(value) ? value : 'off';
}

/**
 * 归一化外部工具配置。
 *
 * 规则：以 `@zread-pi/utils` 的工具注册表为准——
 *  - 已登记的工具有效值缺失时补 `enabled: true`（旧 config.yaml 无需迁移）；
 *  - 未登记/格式错误的键直接忽略（不会污染配置）；
 *  - 新增工具时只需在注册表（tools/registry.ts）里登记，这里自动跟上。
 */
export function normalizeToolsConfig(value: unknown): ToolsConfig {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const result: ToolsConfig = {};
  for (const id of toolIds()) {
    const entry = raw[id];
    const enabled =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).enabled
        : undefined;
    result[id] = { enabled: typeof enabled === 'boolean' ? enabled : true };
  }
  return result;
}

/**
 * @deprecated 使用 `getProjectHome()`（`project-home.ts` 是项目家目录的唯一定义点）。
 * 保留同名导出仅为兼容既有调用方。
 */
export function getZreadDir(): string {
  return getProjectHome();
}

/** 应用配置文件路径 */
export function getConfigPath(): string {
  return projectHomePath('config.yaml');
}

/**
 * pi-ai 凭据文件路径。
 *
 * 与 pi coding-agent 的 auth.json 同格式：{ [providerId]: Credential }，
 * 因此可以同时保存多个 Provider 的 API Key / OAuth token。
 */
export function getZreadAuthPath(): string {
  return projectHomePath('auth.json');
}

/** 动态模型目录缓存路径（pi ModelsStore 落盘位置） */
export function getZreadModelsStorePath(): string {
  return projectHomePath('models-store.json');
}

/**
 * 默认配置 - 首次使用时的初始配置
 */
export const DEFAULT_CONFIG: AppConfig = {
  language: 'en',
  doc_language: 'en',
  llm: {
    provider: null,
    model: null,
    api_key: null,
    base_url: null,
    thinking_level: 'off',
    providers: {},
  },
  agent: {
    max_turns: DEFAULT_MAX_TURNS,
    token_budget: DEFAULT_TOKEN_BUDGET,
  },
  polish: normalizePolishConfig(undefined),
  tools: normalizeToolsConfig(undefined),
  concurrency: {
    max_concurrent: 1,
    max_retries: 0,  // 默认不重试，用户可配置
  },
};

/** 判断一个值是否是合法的自定义模型配置 */
function normalizeCustomModel(value: unknown): CustomModelConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;

  const model: CustomModelConfig = { id: raw.id.trim() };
  if (typeof raw.name === 'string' && raw.name.trim()) model.name = raw.name.trim();
  if (typeof raw.api === 'string' && raw.api.trim()) model.api = raw.api.trim();
  if (typeof raw.base_url === 'string' && raw.base_url.trim()) model.base_url = raw.base_url.trim();
  if (typeof raw.context_window === 'number' && Number.isFinite(raw.context_window)) {
    model.context_window = raw.context_window;
  }
  if (typeof raw.max_tokens === 'number' && Number.isFinite(raw.max_tokens)) {
    model.max_tokens = raw.max_tokens;
  }
  if (typeof raw.reasoning === 'boolean') model.reasoning = raw.reasoning;
  if (typeof raw.supports_vision === 'boolean') model.supports_vision = raw.supports_vision;
  return model;
}

/** 归一化单个 Provider 配置 */
function normalizeProviderConfig(value: unknown): LlmProviderConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const authType: LlmAuthType | null =
    raw.auth_type === 'api_key' || raw.auth_type === 'oauth' ? raw.auth_type : null;

  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeCustomModel).filter((model): model is CustomModelConfig => model !== null)
    : [];

  return {
    auth_type: authType,
    base_url: typeof raw.base_url === 'string' && raw.base_url.trim() ? raw.base_url.trim() : null,
    api: typeof raw.api === 'string' && raw.api.trim() ? raw.api.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    models,
  };
}

/** 归一化 providers 映射（容错：坏数据直接忽略，不影响其它配置） */
export function normalizeProviderConfigs(value: unknown): Record<string, LlmProviderConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, LlmProviderConfig> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!id.trim()) continue;
    const normalized = normalizeProviderConfig(entry);
    if (normalized) result[id] = normalized;
  }
  return result;
}

/**
 * 读取某个 Provider 的配置（不存在时返回空配置）。
 * 调用方拿到的始终是一个完整对象，可直接修改后由 ConfigStore 落盘。
 */
export function getProviderConfig(config: AppConfig, providerId: string): LlmProviderConfig {
  const existing = config.llm.providers?.[providerId];
  return {
    auth_type: existing?.auth_type ?? null,
    base_url: existing?.base_url ?? null,
    api: existing?.api ?? null,
    model: existing?.model ?? null,
    models: existing?.models ? [...existing.models] : [],
  };
}

/** 已配置过的 Provider id 列表（含未内置的自定义 Provider） */
export function getConfiguredProviderIds(config: AppConfig): string[] {
  return Object.keys(config.llm.providers ?? {});
}

/**
 * 检查配置是否为首次配置（LLM 未配置）
 *
 * 新版配置把凭据保存在 ~/.zread-pi/auth.json，因此只要 provider/model 已选定
 * 就视为已配置；旧版 config.yaml 里的 api_key 仍然兼容。
 */
export function isFirstTimeConfig(config: AppConfig): boolean {
  if (config.llm.provider && config.llm.model) return false;
  return config.llm.api_key === null;
}

export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  // 配置文件不存在，返回默认配置
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const rawConfig = parse(content);
    return validateConfig(rawConfig);
  } catch (error) {
    throw new Error(`Config file read failed: ${configPath}\nPlease ensure config file exists and format is correct`, { cause: error });
  }
}

/**
 * 同步加载配置（用于 CLI 启动时获取语言设置）
 */
export function loadConfigSync(): AppConfig | null {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf-8');
    const rawConfig = parse(content);
    return validateConfig(rawConfig);
  } catch {
    return null;
  }
}

export function validateConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_CONFIG;
  }

  const config = raw as Record<string, unknown>;

  // 必需的顶级字段
  if (!config.language || !config.doc_language || !config.concurrency) {
    return DEFAULT_CONFIG;
  }

  // concurrency 字段验证
  const concurrency = config.concurrency as Record<string, unknown>;
  if (typeof concurrency.max_concurrent !== 'number' || typeof concurrency.max_retries !== 'number') {
    return DEFAULT_CONFIG;
  }

  // llm 字段验证（允许 null，表示待配置）
  const llm = (config.llm as Record<string, unknown>) || {
    provider: null,
    model: null,
    api_key: null,
    base_url: null,
  };

  // agent 字段验证（旧配置没有该段：归一化为默认 30 轮）
  const agent = (config.agent as Record<string, unknown>) || {};

  return {
    language: config.language as string,
    doc_language: config.doc_language as string,
    llm: {
      provider: llm.provider as string | null,
      model: llm.model as string | null,
      api_key: llm.api_key as string | null,
      base_url: llm.base_url as string | null,
      // 旧配置没有 thinking_level：归一化为 'off'，保证旧 config.yaml 可直接启动
      thinking_level: normalizeThinkingLevel(llm.thinking_level),
      providers: normalizeProviderConfigs(llm.providers),
    },
    agent: {
      max_turns: normalizeMaxTurns(agent.max_turns),
      token_budget: normalizeTokenBudget(agent.token_budget),
    },
    // 旧配置没有 polish 段：归一化为「启用 + prompt-only」
    polish: normalizePolishConfig(config.polish),
    tools: normalizeToolsConfig(config.tools),
    concurrency: {
      max_concurrent: concurrency.max_concurrent as number,
      max_retries: concurrency.max_retries as number,
    },
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  validateConfig(config);
  const yamlContent = stringify(config);
  const configPath = getConfigPath();
  // 跨进程锁 + 原子替换：并行的 CLI 实例 / TUI 配置界面不会写出半截 YAML；
  // 锁获取失败会抛错，由 ConfigStore.save() 捕获并提示「保存失败」。
  await withFileLock(configPath, async () => {
    await ensureDir(dirname(configPath));
    await writeTextFileAtomic(configPath, yamlContent);
  });
}

export function getDefaultLanguage(config: AppConfig): string {
  return config.language || config.doc_language || 'zh';
}
