/**
 * History Command —— 查看/清理全局记忆（`<项目家目录>/history`）。
 *
 * 行为：
 *  1. 顺序读出全部记录（项目绝对路径）；
 *  2. 并发检查每条记录对应项目目录下的 `.zread-pi` 目录是否还存在（不存在 = 失效）；
 *  3. 从二进制清单中删除失效记录；
 *  4. 打印剩余记录。
 *
 * `-c/--concurrency` 可调整检查并发数（默认 8）：探测是 I/O 等待型任务，
 * 并发只影响速度，不影响结果顺序。
 *
 * stdout 保护：本命令的输出是「可被脚本消费」的（项目路径清单），启动时接管 stdout，
 * 杂散写入（第三方库直写）转去 stderr，清单本身走 `writeRawStdout`，保证输出不被污染。
 */

import { loadConfigSync, pruneHistory } from '@zread-pi/utils';
import { enUS } from '../i18n/translations/en-US';
import { zhCN } from '../i18n/translations/zh-CN';
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from '../tui/output-guard';

export interface RunHistoryOptions {
  /** 并发检查数（缺省 8） */
  concurrency?: number;
}

export async function runHistory(options: RunHistoryOptions = {}): Promise<void> {
  const config = loadConfigSync();
  const t = config?.language === 'en' ? enUS : zhCN;

  takeOverStdout();
  try {
    const { removed, remaining } = await pruneHistory({ concurrency: options.concurrency });

    if (removed.length > 0) {
      writeRawStdout(`${t.history.pruned.replace('{count}', String(removed.length))}\n`);
    }

    if (remaining.length === 0) {
      writeRawStdout(`${t.history.empty}\n`);
      return;
    }

    writeRawStdout(`${t.history.remaining.replace('{count}', String(remaining.length))}\n`);
    for (const [index, record] of remaining.entries()) {
      writeRawStdout(`  ${index + 1}. ${record.path}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${t.history.failed.replace('{error}', message)}\n`);
    process.exitCode = 1;
  } finally {
    // 排队中的清单输出先落盘再还原 stdout，避免被 process.exit 截断
    await flushRawStdout();
    restoreStdout();
  }
}
