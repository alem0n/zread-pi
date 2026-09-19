/**
 * ConfigStore - 配置状态（替代原 ConfigProvider + useImmer）
 *
 * 对外语义与迁移前完全一致：
 * - setField 支持 "llm.provider" / "concurrency.max_concurrent" 形式的嵌套字段
 * - hasChanges 通过深拷贝基线比较（避免原地修改导致基线被同步改写）
 * - save() 写盘成功后把当前值记为新的基线
 *
 * 新增：per-provider 配置与自定义模型（同时配置多个 Provider）。
 */

import type { AppConfig, BlueprintDetailLevel, ContentGateMode, CustomModelConfig, LlmProviderConfig, PolishMode, QualityConfig } from "@zread-pi/types";
import { DEFAULT_CONFIG, isFirstTimeConfig, loadConfig, saveConfig } from "@zread-pi/utils";

export class ConfigStore {
  config: AppConfig = structuredClone(DEFAULT_CONFIG);
  originalConfig: AppConfig = structuredClone(DEFAULT_CONFIG);
  isLoading = true;
  error: string | null = null;

  async load(): Promise<void> {
    try {
      const loaded = await loadConfig();
      this.config = loaded;
      this.originalConfig = structuredClone(loaded);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.config = structuredClone(DEFAULT_CONFIG);
      this.originalConfig = structuredClone(DEFAULT_CONFIG);
    } finally {
      this.isLoading = false;
    }
  }

  /** 修改单项（与 useImmer 版本行为一致） */
  setField(key: string, value: string | number): void {
    // 处理嵌套字段 (如 llm.provider, concurrency.max_concurrent)
    if (key.includes(".")) {
      const [parent, child] = key.split(".");
      const parentObj = this.config[parent as keyof AppConfig] as unknown as Record<
        string,
        unknown
      > | null;
      if (parentObj) {
        parentObj[child] = value;
      }
      return;
    }

    // 处理顶级字段
    if (key === "language" || key === "doc_language") {
      this.config[key] = value as string;
    }
  }

  // ==================== Provider / 模型 ====================

  /** 读取某个 Provider 的配置（始终返回完整对象） */
  getProviderConfig(providerId: string): LlmProviderConfig {
    const existing = this.config.llm.providers?.[providerId];
    return {
      name: existing?.name ?? null,
      auth_type: existing?.auth_type ?? null,
      base_url: existing?.base_url ?? null,
      api: existing?.api ?? null,
      model: existing?.model ?? null,
      models: existing?.models ? [...existing.models] : [],
    };
  }

  /** 局部更新某个 Provider 的配置 */
  setProviderConfig(providerId: string, patch: Partial<LlmProviderConfig>): void {
    const providers = { ...(this.config.llm.providers ?? {}) };
    const current = this.getProviderConfig(providerId);
    providers[providerId] = {
      ...current,
      ...patch,
      models: patch.models ? [...patch.models] : current.models,
    };
    this.config.llm.providers = providers;
  }

  /** 为指定 Provider 添加/覆盖自定义模型（同 id 覆盖，与 pi models.json 语义一致） */
  upsertCustomModel(providerId: string, model: CustomModelConfig): void {
    const current = this.getProviderConfig(providerId);
    const models = [...(current.models ?? [])];
    const index = models.findIndex((entry) => entry.id === model.id);
    if (index >= 0) models[index] = model;
    else models.push(model);
    this.setProviderConfig(providerId, { models });
  }

  /** 删除指定 Provider 的自定义模型 */
  removeCustomModel(providerId: string, modelId: string): void {
    const current = this.getProviderConfig(providerId);
    const models = (current.models ?? []).filter((entry) => entry.id !== modelId);
    this.setProviderConfig(providerId, { models });
  }

  /** 把某个模型设为当前生效模型（同时记住该 Provider 上次的选择） */
  setActiveModel(providerId: string, modelId: string): void {
    this.config.llm.provider = providerId;
    this.config.llm.model = modelId;
    this.setProviderConfig(providerId, { model: modelId });
  }

  // ==================== 文风润色（/config/polish） ====================

  /** 风格纪律开关（缺省启用；关闭后既不注入提示也不跑 polish Agent） */
  isPolishEnabled(): boolean {
    return this.config.polish?.enabled ?? true;
  }

  /** 当前润色模式（缺省 prompt-only） */
  getPolishMode(): PolishMode {
    return this.config.polish?.mode ?? "prompt-only";
  }

  /** 由 /config/polish 维护：开关与模式整体写回 */
  setPolish(enabled: boolean, mode: PolishMode): void {
    this.config.polish = { enabled, mode };
  }

  // ==================== 蓝图细节档位（/config/detail） ====================

  /** 当前蓝图细节档位（旧配置缺省 high，与 validateConfig 一致） */
  getBlueprintDetail(): BlueprintDetailLevel {
    return this.config.blueprint?.detail ?? "high";
  }

  /** 由 /config/detail 维护：档位整体写回 */
  setBlueprintDetail(level: BlueprintDetailLevel): void {
    this.config.blueprint = { detail: level };
  }

  // ==================== 内容质量门（/config/quality） ====================

  /** 内容门是否启用（旧配置缺省启用） */
  isContentGateEnabled(): boolean {
    return this.config.quality?.contentGate?.enabled ?? true;
  }

  /** 当前内容门模式（旧配置缺省 warn） */
  getContentGateMode(): ContentGateMode {
    return this.config.quality?.contentGate?.mode ?? "warn";
  }

  /** 生成完成后是否自动跑交付闸门（旧配置缺省 false） */
  isVerifyAfterGenerate(): boolean {
    return this.config.quality?.verifyAfterGenerate ?? false;
  }

  /** 由 /config/quality 维护：内容门开关 + 模式 + 自动校验整体写回 */
  setQuality(enabled: boolean, mode: ContentGateMode, verifyAfterGenerate: boolean): void {
    const quality: QualityConfig = {
      contentGate: { enabled, mode },
      verifyAfterGenerate,
    };
    this.config.quality = quality;
  }

  // ==================== 模型大小覆盖（/config/model-size） ====================

  /** 当前生效模型的上下文窗口覆盖（null = 跟随模型目录默认） */
  getModelContextWindow(): number | null {
    return this.config.llm.context_window ?? null;
  }

  /** 当前生效模型的最大输出 tokens 覆盖（null = 跟随模型目录默认） */
  getModelMaxTokens(): number | null {
    return this.config.llm.max_tokens ?? null;
  }

  /** 由 /config/model-size 维护：整体写回两个覆盖值（null = 跟随模型目录默认） */
  setModelSize(contextWindow: number | null, maxTokens: number | null): void {
    this.config.llm.context_window = contextWindow;
    this.config.llm.max_tokens = maxTokens;
  }

  // ==================== 外部工具（rg / fd …） ====================

  /** 读取某个外部工具的启用状态（旧配置缺少 tools 段时默认启用） */
  isToolEnabled(toolId: string): boolean {
    return this.config.tools?.[toolId]?.enabled ?? true;
  }

  /** 切换/设置某个外部工具的启用状态（由 /config/tools 页面维护） */
  setToolEnabled(toolId: string, enabled: boolean): void {
    this.config.tools = {
      ...(this.config.tools ?? {}),
      [toolId]: { enabled },
    };
  }

  /**
   * 凭据已交给 ~/.zread-pi/auth.json（pi CredentialStore），
   * 清掉 config.yaml 里的旧扁平 api_key/base_url，避免旧值覆盖新登录结果。
   */
  clearLegacyCredentials(): void {
    this.config.llm.api_key = null;
    this.config.llm.base_url = null;
  }

  get hasChanges(): boolean {
    return JSON.stringify(this.config) !== JSON.stringify(this.originalConfig);
  }

  get isFirstTime(): boolean {
    return isFirstTimeConfig(this.config);
  }

  async save(): Promise<boolean> {
    try {
      await saveConfig(this.config);
      this.originalConfig = structuredClone(this.config);
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }
}
