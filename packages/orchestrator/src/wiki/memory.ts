/**
 * 全局记忆（Global Memory）写入入口。
 *
 * 「开始生成文档」的两个入口（蓝图 `generateWikiCatalog` / 页面 `generateWikiContent`）
 * 都先调用本模块，把当前项目路径写进 `<项目家目录>/history`（默认 `~/.zread-pi/history`）。
 *
 * 设计约束：记忆是辅助数据，写入失败（家目录只读、磁盘满、文件损坏等）只告警，
 * 绝不阻断文档生成。真正的路径与二进制结构由 `@zread-pi/utils` 的 history 模块提供。
 */

import { logger, rememberProject } from '@zread-pi/utils';

/** 记录当前工作目录为「最近生成过文档的项目」；失败只告警 */
export async function rememberCurrentProject(): Promise<void> {
  try {
    await rememberProject();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`全局记忆写入失败（不影响文档生成）：${message}`);
  }
}
