import { Command } from "commander";
import { loadConfigSync } from "@zread-pi/utils";
import { getVersion } from "./utils";
import { enterTargetDir } from "./utils/target-dir";
import { runConfig } from "./commands/config";
import { runWiki } from "./commands/wiki";
import { runBrowse } from "./commands/browse";
import { runLogview } from "./commands/logview";
import { runHistory } from "./commands/history";
import { zhCN } from "./i18n/translations/zh-CN";
import { enUS } from "./i18n/translations/en-US";

// 获取语言配置（用于 CLI 启动时的帮助信息）
const config = loadConfigSync();
const lang = config?.language === "en" ? "en" : "zh";
const t = lang === "en" ? enUS : zhCN;

const program = new Command();

program
  .name("zread-pi")
  .version(getVersion(), "-v, --version", t.cli.version)
  .helpOption("-h, --help", t.cli.help)
  // 全局选项：对 wiki / config / browse 都生效（含默认命令的 `zread-pi -d <path>` 写法）
  .option("-d, --dir <path>", t.cli.dirDesc);

/**
 * 应用 -d/--dir：把进程工作目录切到目标目录（缺省=当前目录）。
 * 目录无效时打印错误并以退出码 1 结束，不进入 TUI。
 */
function applyTargetDir(): boolean {
  const result = enterTargetDir(program.opts().dir as string | undefined);
  if (!result.ok) {
    process.stderr.write(`${t.cli.dirInvalid.replace("{path}", result.path)}\n`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

// 默认命令：Wiki 文档生成（直接运行 zread-pi 即可）
program
  .command("wiki", { isDefault: true })
  .description(t.cli.wikiDesc)
  .action(async () => {
    if (!applyTargetDir()) return;
    await runWiki();
  });

// config 命令
program
  .command("config")
  .description(t.cli.configDesc)
  .action(async () => {
    if (!applyTargetDir()) return;
    await runConfig();
  });

// browse 命令
program
  .command("browse")
  .description(t.cli.browseDesc)
  .action(async () => {
    if (!applyTargetDir()) return;
    await runBrowse();
  });

/** 解析 history 的并发参数；非法/缺省交给 pruneHistory 用默认值 8 */
function parseHistoryConcurrency(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// history 命令：查看/清理全局记忆（不依赖目标目录，-d 参数对它无效）
program
  .command("history")
  .description(t.cli.historyDesc)
  .option("-c, --concurrency <n>", t.cli.historyConcurrencyDesc)
  .action(async (options: { concurrency?: string }) => {
    await runHistory({ concurrency: parseHistoryConcurrency(options.concurrency) });
  });

// logview 命令：轨迹（Trajectory）检查视图
program
  .command("logview [runId]")
  .description(t.cli.logviewDesc)
  .action(async (runId: string | undefined) => {
    if (!applyTargetDir()) return;
    await runLogview(runId);
  });

program.parse();
