/**
 * 版本守卫命令（CLI 启动时执行一次）
 *
 * 只对项目家目录 `~/.zread-pi`（config / auth / history / logs …）做版本兼容性
 * 检查（详见 packages/utils/src/version-guard.ts）。仓库输出目录
 * `<repo>/.zread-pi`（wiki 产物 / runs / cache …）都是可再生产物，不守卫。
 *
 * 不兼容（目录来源版本早于 `INCOMPATIBLE_BEFORE`，或根本没有版本标记）时把
 * 目录备份为 `<dir>_bak` 并在终端给出醒目提示，然后重建空目录。兼容时只静默
 * 更新版本标记。首次安装（目录不存在）直接创建并写入版本。
 *
 * 备份失败时**提示并退出进程**（不降级、不静默、不继续启动）：目录正被别的
 * 进程当作 cwd 或被杀软 / 索引锁定时，Windows 拒绝重命名。此时用户应关闭占用
 * 程序后重试，强行继续会留下混杂的目录结构。旧数据保持不动，不丢数据。
 *
 * 输出走 stderr 且在 TUI 接管终端之前执行，保证用户一定能看到提示。
 *
 * 任何失败都只提示并退出：版本守卫本身不阻塞 CLI 启动（保留旧数据不动比强行重建安全）。
 */

import { ensureVersionGuard, getProjectHome, loadConfigLanguageSync } from "@zread-pi/utils";
import type { VersionGuardOutcome } from "@zread-pi/utils";
import { getVersion } from "../utils";
import { enUS } from "../i18n/translations/en-US";
import { zhCN } from "../i18n/translations/zh-CN";
import type { TranslationKeys } from "../i18n/types";

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

function describe(outcome: VersionGuardOutcome, t: TranslationKeys): string[] {
  if (outcome.status !== "incompatible") return [];
  return [
    replace(t.versionGuard.incompatible, {
      stored: outcome.stored ?? "(unknown)",
      current: outcome.version,
    }),
    `  ${outcome.backupPath}`,
    t.versionGuard.backupHint,
  ];
}

/**
 * 执行版本守卫（只守卫家目录）；返回需要展示给用户的消息行（已写入 stderr）。
 *
 * `ZREAD_PI_VERSION_GUARD=0` 时整体跳过（测试 / 强制绕过用）。
 */
export async function runVersionGuard(): Promise<string[]> {
  if (process.env.ZREAD_PI_VERSION_GUARD === "0") return [];

  const t = resolveLanguage() === "en" ? enUS : zhCN;
  const current = getVersion();

  let outcome: VersionGuardOutcome;
  try {
    outcome = await ensureVersionGuard(getProjectHome(), current);
  } catch (error) {
    // 守卫失败（目录被别的进程当作 cwd / 被杀软或索引锁定，rename 被拒绝）：
    // 不降级、不静默、不继续启动。明确提示用户原因与解法，然后退出进程——
    // 用户关闭占用程序后重跑即可获得干净结构（旧数据保持不动，不丢数据）。
    const failure = replace(t.versionGuard.failed, {
      error: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(`\n${failure}\n${t.versionGuard.failedHint}\n`);
    process.exit(1);
    return []; // 不会被走到（process.exit 不返回）；仅为满足类型
  }

  const lines = describe(outcome, t);
  if (lines.length > 0) {
    process.stderr.write(`\n${lines.join("\n")}\n`);
  }
  return lines;
}
