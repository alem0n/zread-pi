/**
 * provider-catalog —— 把 pi-ai 的 Provider/Model/login 能力接进 zread-pi。
 *
 * 职责：
 * - 用 pi-ai 的 40 个内置 provider（builtinProviders()）构建一个 Models 集合；
 * - 把 ~/.zread/config.yaml 里的 per-provider 配置叠加进去：
 *     · base_url 覆盖（自定义端点/代理）
 *     · 自定义模型（等价 pi models.json 的 models 数组合并语义）
 *     · 未内置的 provider（旧配置 openai-compatible / 自定义端点）动态注册
 * - 凭据走 ~/.zread/auth.json（pi CredentialStore），支持 OAuth 与 API Key，
 *   并且可以同时登录多个 Provider；
 * - 暴露 CLI 配置界面需要的查询/刷新/登录/登出 API。
 *
 * 注意：本模块不主动触发网络请求；刷新模型目录需要显式调用 refreshZreadProviderModels()。
 */

import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AuthInteraction,
  type AuthResult,
  type AuthType,
  type Context as PiContext,
  type Credential,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import type { CustomModelConfig, LlmProviderConfig, AppConfig, ThinkingLevel } from '@zread-pi/types';
import { DEFAULT_CONFIG, loadConfigSync, THINKING_LEVELS } from '@zread-pi/utils';
import { FileCredentialStore } from './auth-store.js';
import { FileModelsStore } from './models-store.js';

/** 自定义 Provider 可选协议（与 pi models.json 对齐） */
export const CUSTOM_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

function apiStreamsFor(api: string): ProviderStreams {
  switch (api) {
    case 'anthropic-messages':
      return anthropicMessagesApi();
    case 'openai-responses':
      return openAIResponsesApi();
    case 'google-generative-ai':
      return googleGenerativeAIApi();
    case 'openai-completions':
    default:
      return openAICompletionsApi();
  }
}

function zeroCost(): Model<Api>['cost'] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 把 config 里的自定义模型转换为 pi Model */
function toPiModel(
  providerId: string,
  defaultApi: Api,
  defaultBaseUrl: string,
  model: CustomModelConfig,
): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: (model.api as Api | undefined) ?? defaultApi,
    provider: providerId,
    baseUrl: model.base_url ?? defaultBaseUrl,
    reasoning: model.reasoning ?? false,
    input: model.supports_vision ? ['text', 'image'] : ['text'],
    cost: zeroCost(),
    contextWindow: model.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * 叠加 base_url 覆盖 + 旧 config.yaml 里的 api_key 回退。
 *
 * pi-ai 的 AuthResult.auth 支持 baseUrl，因此 base_url 覆盖与 GitHub Copilot
 * 这类「按凭据给端点」的 provider 走同一条路。
 */
function wrapProviderAuth(
  auth: ProviderAuth,
  options: { baseUrl?: string | null; legacyApiKey?: string | null },
): ProviderAuth {
  const { baseUrl, legacyApiKey } = options;
  if (!baseUrl && !legacyApiKey) return auth;

  const apiKey = auth.apiKey
    ? {
        ...auth.apiKey,
        resolve: async (input: Parameters<NonNullable<ProviderAuth['apiKey']>['resolve']>[0]) => {
          const original = auth.apiKey;
          if (!original) return undefined;
          // 已存凭据优先，交给 pi 原生逻辑（含 env fallback）
          if (input.credential?.key) {
            const result = await original.resolve(input);
            return applyBaseUrl(result, baseUrl);
          }
          // 旧版 config.yaml 的 api_key 次之（新流程不会再写入，但兼容老配置）
          if (legacyApiKey) {
            return { auth: { apiKey: legacyApiKey, ...(baseUrl ? { baseUrl } : {}) }, source: '~/.zread/config.yaml' };
          }
          return applyBaseUrl(await original.resolve(input), baseUrl);
        },
      }
    : undefined;

  const oauth = auth.oauth
    ? {
        ...auth.oauth,
        toAuth: async (credential: Parameters<NonNullable<ProviderAuth['oauth']>['toAuth']>[0]) => {
          const original = auth.oauth;
          if (!original) throw new Error('oauth auth missing');
          return applyBaseUrl({ auth: await original.toAuth(credential) }, baseUrl)?.auth ?? { baseUrl: baseUrl ?? undefined };
        },
      }
    : undefined;

  return { apiKey, oauth };
}

function applyBaseUrl(result: AuthResult | undefined, baseUrl: string | null | undefined): AuthResult | undefined {
  if (!result) return result;
  if (!baseUrl || result.auth.baseUrl) return result;
  return { ...result, auth: { ...result.auth, baseUrl } };
}

/** 用配置里的自定义模型包装 provider（同 id 覆盖，否则追加） */
function withCustomModels(
  provider: Provider,
  providerId: string,
  providerConfig: LlmProviderConfig | undefined,
): Provider {
  const customModels = providerConfig?.models ?? [];
  if (customModels.length === 0) return provider;

  const baseline = provider.getModels();
  const defaultApi = (baseline[0]?.api ?? 'openai-completions') as Api;
  const defaultBaseUrl = baseline[0]?.baseUrl ?? provider.baseUrl ?? '';
  const converted = customModels.map((model) => toPiModel(providerId, defaultApi, defaultBaseUrl, model));

  return {
    ...provider,
    getModels: () => {
      const merged = [...provider.getModels()];
      for (const model of converted) {
        const index = merged.findIndex((entry) => entry.id === model.id);
        if (index >= 0) merged[index] = model;
        else merged.push(model);
      }
      return merged;
    },
  };
}

/** 为「未内置」的 provider（自定义端点 / 旧 openai-compatible 配置）动态创建 provider */
function createConfiguredProvider(
  providerId: string,
  providerConfig: LlmProviderConfig,
  legacy: { apiKey?: string | null; baseUrl?: string | null },
): Provider {
  const api = (providerConfig.api ?? 'openai-completions') as Api;
  const baseUrl = providerConfig.base_url ?? legacy.baseUrl ?? '';
  const models = (providerConfig.models ?? []).map((model) =>
    toPiModel(providerId, api, baseUrl, model),
  );

  const auth: ProviderAuth = {
    apiKey: {
      name: `${providerId} API key`,
      login: async (interaction) => {
        const key = await interaction.prompt({ type: 'secret', message: `Enter API key for ${providerId}` });
        return { type: 'api_key', key };
      },
      resolve: async ({ credential, signal }) => {
        signal.throwIfAborted();
        const key = credential?.key ?? legacy.apiKey ?? undefined;
        if (!key) return undefined;
        return { auth: { apiKey: key, ...(baseUrl ? { baseUrl } : {}) }, source: 'zread-pi config' };
      },
    },
  };

  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl: baseUrl || undefined,
    auth,
    models,
    api: apiStreamsFor(api),
  });
}

export interface ZreadCatalog {
  models: MutableModels;
  credentials: FileCredentialStore;
  /** id -> 生效 provider（含覆盖与自定义模型） */
  providers: Map<string, Provider>;
  /** 内置 provider id 集合 */
  builtinIds: Set<string>;
}

let catalogCache: ZreadCatalog | undefined;
/** CLI 配置界面的内存配置（未保存的修改也要能实时预览）；不设置时读取 config.yaml */
let configOverride: AppConfig | undefined;

function getEffectiveConfig(): AppConfig {
  return configOverride ?? loadConfigSync() ?? DEFAULT_CONFIG;
}

let oauthFlowsRegistered = false;

/**
 * pi 的 OAuth 流程通过「变量 specifier 的动态 import」按需加载，打包器无法静态解析；
 * 打包后的 CLI 需要显式注册静态内置的流程（pi 为 standalone 二进制提供的同一入口）。
 */
function ensureOAuthFlowsRegistered(): void {
  if (oauthFlowsRegistered) return;
  oauthFlowsRegistered = true;
  registerBunOAuthFlows();
}

function buildCatalog(): ZreadCatalog {
  ensureOAuthFlowsRegistered();
  const config = getEffectiveConfig();
  const credentials = new FileCredentialStore();
  const models = createModels({ credentials, modelsStore: new FileModelsStore() });
  const providers = new Map<string, Provider>();
  const builtinIds = new Set<string>();

  const activeLegacyKey = config.llm.provider ? config.llm.api_key : null;
  const activeLegacyBaseUrl = config.llm.provider ? config.llm.base_url : null;

  for (const builtin of builtinProviders()) {
    builtinIds.add(builtin.id);
    const providerConfig = config.llm.providers?.[builtin.id];
    const legacyApiKey = builtin.id === config.llm.provider ? activeLegacyKey : null;
    const legacyBaseUrl = builtin.id === config.llm.provider ? activeLegacyBaseUrl : null;

    let provider = builtin;
    provider = withCustomModels(provider, builtin.id, providerConfig);
    provider = {
      ...provider,
      auth: wrapProviderAuth(provider.auth, {
        baseUrl: providerConfig?.base_url ?? legacyBaseUrl ?? null,
        legacyApiKey,
      }),
    };
    providers.set(provider.id, provider);
    models.setProvider(provider);
  }

  // 配置里出现但 pi-ai 未内置的 provider / 当前生效的旧 provider
  const configuredIds = new Set<string>(Object.keys(config.llm.providers ?? {}));
  if (config.llm.provider) configuredIds.add(config.llm.provider);

  for (const providerId of configuredIds) {
    if (builtinIds.has(providerId)) continue;
    const providerConfig = config.llm.providers?.[providerId] ?? {
      auth_type: null,
      base_url: null,
      api: null,
      model: null,
      models: [],
    };
    const isActive = providerId === config.llm.provider;
    const provider = createConfiguredProvider(providerId, providerConfig, {
      apiKey: isActive ? activeLegacyKey : null,
      baseUrl: isActive ? activeLegacyBaseUrl : providerConfig.base_url,
    });
    providers.set(providerId, provider);
    models.setProvider(provider);
  }

  return { models, credentials, providers, builtinIds };
}

/** 获取（并缓存）当前配置对应的 Models 集合 */
export function getZreadCatalog(): ZreadCatalog {
  if (!catalogCache) catalogCache = buildCatalog();
  return catalogCache;
}

/** 配置变更后重建 Models 集合（凭据是实时读取的，无需为登录/登出调用） */
export function reloadZreadCatalog(): ZreadCatalog {
  catalogCache = buildCatalog();
  return catalogCache;
}

/**
 * 把 CLI 内存里的配置设为 catalog 的数据源（未保存的修改也能立即反映）；
 * 传 undefined 回到读取 ~/.zread/config.yaml。
 */
export function setZreadCatalogConfig(config: AppConfig | undefined): ZreadCatalog {
  configOverride = config;
  catalogCache = undefined;
  return getZreadCatalog();
}

/** 判断 providerId 是否已知（内置或配置过） */
export function hasZreadProvider(providerId: string): boolean {
  return getZreadCatalog().providers.has(providerId);
}

/** 取生效的 provider */
export function getZreadProvider(providerId: string): Provider | undefined {
  return getZreadCatalog().providers.get(providerId);
}

/** 取 provider 当前模型列表（内置目录 + 自定义模型） */
export function getZreadProviderModels(providerId: string): readonly Model<Api>[] {
  return getZreadProvider(providerId)?.getModels() ?? [];
}

/** 取单个模型，包含用户在配置里自定义的模型 */
export function getZreadModel(providerId: string, modelId: string): Model<Api> | undefined {
  return getZreadProviderModels(providerId).find((model) => model.id === modelId);
}

/**
 * 取当前模型支持的思考深度等级（pi thinking level 语义）。
 *
 * - 未选择模型 / 模型不在目录中：返回全部 7 个等级（请求时由 pi 按模型能力调整）；
 * - 模型不支持思考（reasoning=false）：返回 ['off']；
 * - 其余情况：与 pi-ai getSupportedThinkingLevels 一致（例如部分模型不提供 off，
 *   部分模型的 xhigh / max 需要 thinkingLevelMap 显式声明）。
 */
export function getZreadThinkingLevels(
  providerId?: string | null,
  modelId?: string | null,
): ThinkingLevel[] {
  if (!providerId || !modelId) return [...THINKING_LEVELS];
  const model = getZreadModel(providerId, modelId);
  if (!model) return [...THINKING_LEVELS];
  return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export interface ZreadProviderSummary {
  id: string;
  name: string;
  baseUrl?: string;
  builtin: boolean;
  modelCount: number;
  hasApiKeyAuth: boolean;
  hasOAuth: boolean;
  oauthLabel?: string;
  /** 已配置凭据时为 true（API Key 或 OAuth 均可） */
  configured: boolean;
  authType?: 'api_key' | 'oauth';
  authSource?: string;
  /** 支持动态刷新模型目录（pi 的 refreshModels） */
  dynamic: boolean;
  /** 配置/内置目录里的推荐模型 id */
  defaultModelId?: string;
}

/** 汇总 provider 列表 + 凭据状态，供配置界面展示「同时配置了哪些提供商」 */
export async function listZreadProviders(): Promise<ZreadProviderSummary[]> {
  const catalog = getZreadCatalog();
  const config = getEffectiveConfig();
  const providers = [...catalog.providers.values()];

  return Promise.all(
    providers.map(async (provider) => {
      const models = provider.getModels();
      let check: Awaited<ReturnType<MutableModels['checkAuth']>>;
      try {
        check = await catalog.models.checkAuth(provider.id);
      } catch {
        check = undefined;
      }
      const providerConfig = config.llm.providers?.[provider.id];
      let defaultModelId: string | undefined = providerConfig?.model ?? undefined;
      if (!defaultModelId && config.llm.provider === provider.id && config.llm.model) {
        defaultModelId = config.llm.model;
      }
      if (!defaultModelId && models.length > 0) {
        defaultModelId = models[0].id;
      }

      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        builtin: catalog.builtinIds.has(provider.id),
        modelCount: models.length,
        hasApiKeyAuth: Boolean(provider.auth.apiKey),
        hasOAuth: Boolean(provider.auth.oauth),
        oauthLabel: provider.auth.oauth?.loginLabel,
        configured: check !== undefined,
        authType: check?.type,
        authSource: check?.source,
        dynamic: provider.refreshModels !== undefined,
        defaultModelId,
      } satisfies ZreadProviderSummary;
    }),
  );
}

/** 刷新指定 provider 的模型目录（pi Models.refresh；静态 provider 会被跳过） */
export async function refreshZreadProviderModels(
  providerId: string,
): Promise<{ ok: boolean; error?: string }> {
  const catalog = getZreadCatalog();
  try {
    const result = await catalog.models.refresh({ providers: [providerId], force: true });
    const error = result.errors.get(providerId);
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 登录（pi-ai 的 api_key / oauth 流程），凭据写入 ~/.zread/auth.json */
export async function loginZreadProvider(
  providerId: string,
  type: AuthType,
  interaction: AuthInteraction,
): Promise<Credential> {
  const catalog = getZreadCatalog();
  if (!catalog.providers.has(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return catalog.models.login(providerId, type, interaction);
}

/** 登出（删除该 provider 的凭据，其它 provider 不受影响） */
export async function logoutZreadProvider(providerId: string): Promise<void> {
  await getZreadCatalog().models.logout(providerId);
}

/** 解析请求凭据（OAuth 会自动刷新），用于展示/兼容旧调用方 */
export async function resolveZreadProviderAuth(
  providerId: string,
): Promise<AuthResult | undefined> {
  return getZreadCatalog().models.getAuth(providerId);
}

/**
 * 用 catalog 的 Models 集合发请求（OAuth 自动刷新、自定义模型元数据生效）。
 */
export function streamZreadModel(
  model: Model<Api>,
  context: PiContext,
  options?: SimpleStreamOptions,
): ReturnType<MutableModels['streamSimple']> {
  return getZreadCatalog().models.streamSimple(model, context, options);
}

/** 非流式补全（browse-chat 的一次性请求） */
export function completeZreadModel(
  model: Model<Api>,
  context: PiContext,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return getZreadCatalog().models.completeSimple(model, context, options);
}
