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
 */

import { loadConfigSync, pruneHistory } from '@zread-pi/utils';
import { enUS } from '../i18n/translations/en-US';
import { zhCN } from '../i18n/translations/zh-CN';

export interface RunHistoryOptions {
  /** 并发检查数（缺省 8） */
  concurrency?: number;
}

export async function runHistory(options: RunHistoryOptions = {}): Promise<void> {
  const config = loadConfigSync();
  const t = config?.language === 'en' ? enUS : zhCN;

  try {
    const { removed, remaining } = await pruneHistory({ concurrency: options.concurrency });

    if (removed.length > 0) {
      process.stdout.write(`${t.history.pruned.replace('{count}', String(removed.length))}\n`);
    }

    if (remaining.length === 0) {
      process.stdout.write(`${t.history.empty}\n`);
      return;
    }

    process.stdout.write(
      `${t.history.remaining.replace('{count}', String(remaining.length))}\n`,
    );
    for (const [index, record] of remaining.entries()) {
      process.stdout.write(`  ${index + 1}. ${record.path}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${t.history.failed.replace('{error}', message)}\n`);
    process.exitCode = 1;
  }
}
