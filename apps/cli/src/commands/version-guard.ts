/**
 * 版本守卫命令（CLI 启动时执行一次）
 *
 * 对两处数据目录做版本兼容性检查（详见 packages/utils/src/version-guard.ts）：
 *  - 项目家目录 `~/.zread-pi`（config / auth / history / logs …）
 *  - 目标仓库输出目录 `<repo>/.zread-pi`（wiki 产物 / runs / cache …）
 *
 * 不兼容时把目录备份为 `<dir>_bak` 并在终端给出醒目提示，然后重建空目录。
 * 首次安装（目录不存在）直接创建并写入版本。
 *
 * 备份失败时**提示并退出进程**（不降级、不静默、不继续启动）：目录正被别的
 * 进程当作 cwd 或被杀软 / 索引锁定时，Windows 拒绝重命名。此时用户应关闭占用
 * 程序后重试，强行继续会留下混杂的目录结构。旧数据保持不动，不丢数据。
 *
 * 输出走 stderr 且在 TUI 接管终端之前执行，保证用户一定能看到提示。
 *
 * 任何失败都只提示并退出：版本守卫本身不阻塞 CLI 启动（保留旧数据不动比强行重建安全）。
 */

import { ensureVersionGuard, getOutputDir, getProjectHome, loadConfigLanguageSync } from "@zread-pi/utils";
import type { VersionGuardOutcome } from "@zread-pi/utils";
import { getVersion } from "../utils";
import { enUS } from "../i18n/translations/en-US";
import { zhCN } from "../i18n/translations/zh-CN";
import type { TranslationKeys } from "../i18n/types";

export interface VersionGuardOptions {
  /** 是否同时守卫目标仓库的数据目录（config / history 只用家目录，不碰仓库） */
  repo?: boolean;
}

/** 语言取自「守卫前」的旧配置：一旦家目录被备份，配置就读不到了 */
function resolveLanguage(): "zh" | "en" {
  return loadConfigLanguageSync();
}

function replace(text: string, pairs: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(pairs)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

function describe(outcome: VersionGuardOutcome, scope: string, t: TranslationKeys): string[] {
  if (outcome.status !== "incompatible") return [];
  return [
    replace(t.versionGuard.incompatible, {
      scope,
      stored: outcome.stored ?? "(unknown)",
      current: outcome.version,
    }),
    `  ${outcome.backupPath}`,
    t.versionGuard.backupHint,
  ];
}

/**
 * 执行版本守卫；返回需要展示给用户的消息行（已写入 stderr）。
 *
 * `ZREAD_PI_VERSION_GUARD=0` 时整体跳过（测试 / 强制绕过用）。
 */
export async function runVersionGuard(options: VersionGuardOptions = {}): Promise<string[]> {
  if (process.env.ZREAD_PI_VERSION_GUARD === "0") return [];

  const t = resolveLanguage() === "en" ? enUS : zhCN;
  const current = getVersion();

  const scopes = [
    { name: t.versionGuard.scopeHome, dir: getProjectHome() },
    ...(options.repo ? [{ name: t.versionGuard.scopeRepo, dir: getOutputDir() }] : []),
  ];

  const lines: string[] = [];
  for (const { name, dir } of scopes) {
    let outcome: VersionGuardOutcome;
    try {
      outcome = await ensureVersionGuard(dir, current);
    } catch (error) {
      // 守卫失败（目录被别的进程当作 cwd / 被杀软或索引锁定，rename 被拒绝）：
      // 不降级、不静默、不继续启动。明确提示用户原因与解法，然后退出进程——
      // 用户关闭占用程序后重跑即可获得干净结构（旧数据保持不动，不丢数据）。
      const failure = replace(t.versionGuard.failed, {
        scope: name,
        error: error instanceof Error ? error.message : String(error),
      });
      process.stderr.write(`\n${failure}\n${t.versionGuard.failedHint}\n`);
      process.exit(1);
      return lines; // 不会被走到（process.exit 不返回）；仅为满足类型
    }
    const messages = describe(outcome, name, t);
    if (messages.length > 0) {
      if (lines.length === 0) lines.push(""); // 首条提示前空一行，与正常输出隔开
      lines.push(...messages);
    }
  }

  if (lines.length > 0) {
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  return lines;
}
