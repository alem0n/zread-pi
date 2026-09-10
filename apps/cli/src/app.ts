/**
 * App 启动入口（替代迁移前的 apps/cli/src/App.tsx）
 *
 * 迁移前使用 fullscreen-ink 的 withFullScreen(<AppContent/>).start()；
 * 现在直接创建 pi-tui 应用（备用屏幕缓冲，全屏渲染）。
 */

import { App as TuiApp } from "./tui/app";
import { routes } from "./routes";

export interface AppOptions {
  initialEntries: string[];
}

export function runApp({ initialEntries }: AppOptions): void {
  const app = new TuiApp({ routes, initialEntries });
  app.start().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
