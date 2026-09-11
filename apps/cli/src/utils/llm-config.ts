/**
 * llm-config - CLI 侧的 LLM 配置迁移/兼容辅助
 *
 * 旧版配置把凭据放在 config.llm.api_key / base_url（只支持单个 Provider）。
 * 新版把凭据交给 pi-ai 的 ~/.zread-pi/auth.json，把端点/模型放在
 * config.llm.providers[providerId]。
 *
 * 在切换到新 Provider/模型之前，把旧字段安全迁移过去再清空，避免：
 * - 旧凭据丢失；
 * - 旧凭据在之后再被当成「显式 apiKey」覆盖新 Provider 的登录结果。
 */

import { getZreadCatalog } from "@zread-pi/agent-runtime";
import type { ConfigStore } from "../state/config-store";

/**
 * 迁移旧扁平字段：
 * 1. llm.base_url → 当前 Provider 的 per-provider base_url
 * 2. llm.api_key → ~/.zread-pi/auth.json 里当前 Provider 的 api_key 凭据
 * 3. 清空 llm.api_key / llm.base_url
 */
export async function migrateLegacyCredentials(configStore: ConfigStore): Promise<void> {
  const llm = configStore.config.llm;
  if (!llm.provider) return;

  // 1) base_url 迁移到 per-provider 配置
  if (llm.base_url) {
    const existing = configStore.getProviderConfig(llm.provider);
    if (existing.base_url !== llm.base_url) {
      configStore.setProviderConfig(llm.provider, {
        base_url: llm.base_url,
        api: existing.api ?? null,
      });
    }
  }

  // 2) api_key 迁移到 auth.json（已有凭据时不覆盖）
  if (llm.api_key) {
    const store = getZreadCatalog().credentials;
    const stored = await store.read(llm.provider);
    if (!stored) {
      const key = llm.api_key;
      await store.modify(llm.provider, async () => ({ type: "api_key", key }));
    }
  }

  // 3) 清空扁平字段（凭据/端点已各有归属）
  configStore.clearLegacyCredentials();
}
