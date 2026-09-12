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
import { ensureProjectRecorded, fileExists, getWikiJsonPath, readJsonFile } from "@zread-pi/utils";
import type { WikiOutput } from "@zread-pi/types";
import { countGeneratedPages } from "./utils/generated-docs";

export interface AppOptions {
  initialEntries: string[];
}

/**
 * 「添加老旧项目」：打开目标目录时，如果这里已经有生成好的文档
 * （wiki.json 可解析、页面非空、且全部页面已落盘 —— 即首页显示的「文档已生成 (N 篇)」），
 * 且路径不在全局记忆里，就把当前项目补录进去，方便后续直接用 `zread-pi history` 找到它。
 *
 * 已存在的记录不做任何写入（不刷位置、不重复）。任何失败都只忽略：
 * 记忆是辅助数据，不能阻断 TUI 启动（与生成时写入的容错策略一致）。
 */
async function adoptExistingProject(): Promise<void> {
  try {
    const wikiPath = getWikiJsonPath();
    if (!(await fileExists(wikiPath))) return;

    const catalog = await readJsonFile<WikiOutput>(wikiPath);
    const pages = catalog?.pages;
    if (!Array.isArray(pages) || pages.length === 0) return;

    const { generated, total } = await countGeneratedPages(pages);
    if (generated < total) return;

    await ensureProjectRecorded(process.cwd());
  } catch {
    // 忽略：文档判据读取失败 / 记忆不可写时保持原状
  }
}

export async function runApp({ initialEntries }: AppOptions): Promise<void> {
  // 老旧项目自动登记必须在 TUI 接管终端前完成（失败不阻塞）
  await adoptExistingProject();

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
