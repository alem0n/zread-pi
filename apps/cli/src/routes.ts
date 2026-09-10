/**
 * routes - 路由表（等价迁移前 App.tsx 里的 <Routes> 声明）
 *
 * 注意：具体路径必须排在参数化路径之前，否则 'custom' 会被当作 providerId。
 */

import type { RouteDefinition } from "./tui/router";
import BrowsePage from "./views/browse";
import ConfigApiKeyPage from "./views/config-apikey";
import ConfigConcurrencyPage from "./views/config-concurrency";
import ConfigCustomProviderPage from "./views/config-custom-provider";
import ConfigDocLanguagePage from "./views/config-doc-language";
import ConfigHomePage from "./views/config-home";
import ConfigLanguagePage from "./views/config-language";
import ConfigModelPage from "./views/config-model";
import ConfigProviderPage from "./views/config-provider";
import ConfigRetryPage from "./views/config-retry";
import WikiGeneratePage from "./views/wiki-generate";
import WikiHomePage from "./views/wiki-home";
import WikiSyncPage from "./views/wiki-sync";

export const routes: RouteDefinition[] = [
  // ========== Config 模块路由 ==========
  { pattern: "/config", create: () => new ConfigHomePage() },
  { pattern: "/config/language", create: () => new ConfigLanguagePage() },
  { pattern: "/config/doc_language", create: () => new ConfigDocLanguagePage() },
  { pattern: "/config/provider", create: () => new ConfigProviderPage() },
  // 注意：具体路径要在参数化路径之前，否则 'custom' 会被当作 providerId
  { pattern: "/config/provider/custom", create: () => new ConfigCustomProviderPage() },
  { pattern: "/config/provider/:providerId", create: () => new ConfigModelPage() },
  { pattern: "/config/provider/:providerId/model/:modelId", create: () => new ConfigApiKeyPage() },
  { pattern: "/config/provider/:providerId/custom", create: () => new ConfigCustomProviderPage() },
  { pattern: "/config/concurrency", create: () => new ConfigConcurrencyPage() },
  { pattern: "/config/retry", create: () => new ConfigRetryPage() },

  // ========== Wiki 模块路由 ==========
  { pattern: "/wiki", create: () => new WikiHomePage() },
  { pattern: "/wiki/generate", create: () => new WikiGeneratePage() },
  { pattern: "/wiki/sync", create: () => new WikiSyncPage() },

  // ========== Browse 模块路由 ==========
  { pattern: "/browse", create: () => new BrowsePage() },
];
