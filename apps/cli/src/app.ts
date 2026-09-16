/**
 * App 启动入口（替代迁移前的 apps/cli/src/App.tsx）
 *
 * 迁移前使用 fullscreen-ink 的 withFullScreen(<AppContent/>).start()；
 * 现在直接创建 pi-tui 应用（备用屏幕缓冲，全屏渲染）。
 *
 * 启动前会接管 console：TUI 期间任何 console 输出都会破坏备用屏幕
 * （例如 provider-registry 同步失败时的 console.error），统一转存到日志文件。
 * 同时在真实的 ProcessTerminal 路径上接管 stdout（output-guard）：绕过 console 的
 * 直写（第三方库）也不再进渲染流，而是同样落在日志文件里；TUI 自身的渲染帧/控制序列
 * 走放行窗口直达原生 stdout（见 tui/output-guard.ts 与 tui/guarded-terminal.ts）。
 */

import { App as TuiApp } from "./tui/app";
import { captureConsoleToLog } from "./tui/console-guard";
import { restoreStdout, takeOverStdout } from "./tui/output-guard";
import { routes } from "./routes";
import { ensureProjectRecorded, getWikiJsonPath, listWikiVariants, readJsonFile } from "@zread-pi/utils";
import type { WikiOutput } from "@zread-pi/types";
import { countGeneratedPages } from "./utils/generated-docs";

export interface AppOptions {
  initialEntries: string[];
}

/**
 * 「添加老旧项目」：打开目标目录时，如果这里已经有生成好的文档
 * （任一档位变体 / 遗留目录的 wiki.json 可解析、页面非空、且全部页面已落盘 ——
 * 即首页显示的「文档已生成 (N 篇)」），且路径不在全局记忆里，
 * 就把当前项目补录进去，方便后续直接用 `zread-pi history` 找到它。
 *
 * 多档共存（`wiki/<detail>/`）下逐一检查每个变体，任一完整即补录。
 *
 * 已存在的记录不做任何写入（不刷位置、不重复）。任何失败都只忽略：
 * 记忆是辅助数据，不能阻断 TUI 启动（与生成时写入的容错策略一致）。
 */
async function adoptExistingProject(): Promise<void> {
  try {
    for (const variant of listWikiVariants()) {
      const catalog = await readJsonFile<WikiOutput>(getWikiJsonPath(variant.detail)).catch(
        () => null,
      );
      const pages = catalog?.pages;
      if (!Array.isArray(pages) || pages.length === 0) continue;

      const { generated, total } = await countGeneratedPages(pages, variant.detail);
      if (generated < total) continue;

      await ensureProjectRecorded(process.cwd());
      return;
    }
  } catch {
    // 忽略：文档判据读取失败 / 记忆不可写时保持原状
  }
}

export async function runApp({ initialEntries }: AppOptions): Promise<void> {
  // 老旧项目自动登记必须在 TUI 接管终端前完成（失败不阻塞）
  await adoptExistingProject();

  const restoreConsole = captureConsoleToLog();
  // 接管 stdout：杂散直写转日志（TUI 放行窗口外的写入），退出时还原。
  // 只在真实终端路径启用；测试注入的终端走原样写入，不受影响。
  takeOverStdout({ redirect: "log", passthroughTerminalSequences: true });
  const restoreAll = (): void => {
    restoreStdout();
    restoreConsole();
  };

  const app = new TuiApp({
    routes,
    initialEntries,
    onExit: () => {
      restoreAll();
      process.exit(0);
    },
  });

  app.start().catch((err: unknown) => {
    restoreAll();
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
