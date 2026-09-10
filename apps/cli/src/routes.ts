/**
 * routes - 路由表（等价迁移前 App.tsx 里的 <Routes> 声明）
 *
 * 注意：具体路径必须排在参数化路径之前，否则 'custom' 会被当作 providerId。
 */

import type { RouteDefinition } from "./tui/router";
import BrowsePage from "./views/browse";
import ConfigConcurrencyPage from "./views/config-concurrency";
import ConfigCustomModelPage from "./views/config-custom-model";
import ConfigCustomProviderPage from "./views/config-custom-provider";
import ConfigDocLanguagePage from "./views/config-doc-language";
import ConfigHomePage from "./views/config-home";
import ConfigLanguagePage from "./views/config-language";
import ConfigMaxTurnsPage from "./views/config-max-turns";
import ConfigProviderDetailPage from "./views/config-provider-detail";
import ConfigProviderPage from "./views/config-provider";
import ConfigRetryPage from "./views/config-retry";
import ConfigThinkingPage from "./views/config-thinking";
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
  { pattern: "/config/provider/:providerId", create: () => new ConfigProviderDetailPage() },
  { pattern: "/config/provider/:providerId/model-new", create: () => new ConfigCustomModelPage() },
  // 兼容旧路由：等同于「为该 Provider 添加自定义模型」
  { pattern: "/config/provider/:providerId/custom", create: () => new ConfigCustomModelPage() },
  { pattern: "/config/concurrency", create: () => new ConfigConcurrencyPage() },
  { pattern: "/config/retry", create: () => new ConfigRetryPage() },
  { pattern: "/config/thinking", create: () => new ConfigThinkingPage() },
  { pattern: "/config/max-turns", create: () => new ConfigMaxTurnsPage() },

  // ========== Wiki 模块路由 ===========
  { pattern: "/wiki", create: () => new WikiHomePage() },
  { pattern: "/wiki/generate", create: () => new WikiGeneratePage() },
  { pattern: "/wiki/sync", create: () => new WikiSyncPage() },

  // ========== Browse 模块路由 ==========
  { pattern: "/browse", create: () => new BrowsePage() },
];
