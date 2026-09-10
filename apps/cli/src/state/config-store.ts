/**
 * ConfigStore - 配置状态（替代原 ConfigProvider + useImmer）
 *
 * 对外语义与迁移前完全一致：
 * - setField 支持 "llm.provider" / "concurrency.max_concurrent" 形式的嵌套字段
 * - hasChanges 通过深拷贝基线比较（避免原地修改导致基线被同步改写）
 * - save() 写盘成功后把当前值记为新的基线
 */

import type { AppConfig } from "@open-zread/types";
import { DEFAULT_CONFIG, isFirstTimeConfig, loadConfig, saveConfig } from "@open-zread/utils";

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
