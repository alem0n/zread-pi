/**
 * App 启动入口（替代迁移前的 apps/cli/src/App.tsx）
 *
 * 迁移前使用 fullscreen-ink 的 withFullScreen(<AppContent/>).start()；
 * 现在直接创建 pi-tui 应用（备用屏幕缓冲，全屏渲染）。
 *
 * 启动前会接管 console：TUI 期间任何 stdout/stderr 输出都会破坏备用屏幕
 * （例如 provider-registry 同步失败时的 console.error），统一转存到日志文件。
 */

import { App as TuiApp } from "./tui/app";
import { captureConsoleToLog } from "./tui/console-guard";
import { routes } from "./routes";

export interface AppOptions {
  initialEntries: string[];
}

export function runApp({ initialEntries }: AppOptions): void {
  const restoreConsole = captureConsoleToLog();

  const app = new TuiApp({
    routes,
    initialEntries,
    onExit: () => {
      restoreConsole();
      process.exit(0);
    },
  });

  app.start().catch((err: unknown) => {
    restoreConsole();
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
