/**
 * 目标目录（-d / --dir）
 *
 * 业务层的全部路径都以 `process.cwd()` 为根：RepoAnalyzer 的扫描（scanFiles/parseFiles）、
 * `.zread-pi` 的落盘（packages/utils 的 getProjectRoot()/getWikiDir()）、Agent 的 cwd
 * （orchestrator 的 create-agent.ts）、TUI 头部显示的目录（tui/layout.ts）都是如此。
 *
 * 因此「指定目录」只需在 CLI 进入 TUI 之前切一次工作目录（进程级 chdir），
 * 业务层零改动；这也是 tools/mock-wiki-run.ts 一直在用的做法。
 *
 * 约定：
 * - 相对路径按「调用时的当前目录」解析（`resolve`），返回归一化后的绝对路径；
 * - 目标不存在 / 不是目录时返回错误结果而不是抛异常，由入口打印干净的错误信息并以退出码 1 结束；
 * - 不在这里做任何校验之外的副作用（不创建目录）——目录不存在就是错误，避免误建空项目。
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

export type EnterTargetDirResult =
  | { ok: true; dir: string }
  | { ok: false; path: string };

/**
 * 切换到 -d/--dir 指定的目录；未指定（或为空白）时保持当前目录不变。
 *
 * @param rawDir 命令行传入的原始值（可为 undefined）
 * @returns 成功时返回实际生效的绝对路径；失败时返回被拒绝的绝对路径
 */
export function enterTargetDir(rawDir?: string): EnterTargetDirResult {
  const trimmed = rawDir?.trim();
  const dir = resolve(trimmed && trimmed.length > 0 ? trimmed : process.cwd());

  let isDirectory = false;
  try {
    isDirectory = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    // 权限不足等异常一律按「不可用目录」处理
    isDirectory = false;
  }

  if (!isDirectory) {
    return { ok: false, path: dir };
  }

  process.chdir(dir);
  return { ok: true, dir };
}
