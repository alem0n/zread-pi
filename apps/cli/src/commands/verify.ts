/**
 * Verify Command —— 交付闸门（`zread-pi verify`）
 *
 * 对齐 lecture-to-notes 的 `scripts/verify_notes.py`：一条命令判定本次生成是否达标。
 * 逐条检查输出 `<STATUS> <group> <message>`（STATUS ∈ PASS/FAIL/SKIP），
 * 末尾 `OVERALL PASS` / `OVERALL FAIL`，退出码随之（0 / 1）。
 *
 * 检查组：structure / content / mermaid / traceability / frontmatter
 * （content 组需要 `--enforce` 才把密度门失败计为整体失败，否则只列出）。
 *
 * stdout 保护：本命令的输出是「可被脚本消费」的（CI 判定退出码 + 解析行），
 * 启动时接管 stdout，杂散写入转去 stderr，检查行本身走 `writeRawStdout`。
 *
 * `-d/--dir` 是根 program 的全局选项，由 `applyTargetDir()` 切进程目录，
 * 因此本命令只需读 `process.cwd()`。
 */

import { verifyWiki } from '@zread-pi/orchestrator';
import type { VerifyReport, VerifyStatus } from '@zread-pi/orchestrator';
import type { BlueprintDetailLevel } from '@zread-pi/types';
import { loadConfigSync } from '@zread-pi/utils';
import { enUS } from '../i18n/translations/en-US';
import { zhCN } from '../i18n/translations/zh-CN';
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from '../tui/output-guard';

const DETAIL_LEVELS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]);

export interface RunVerifyOptions {
  /** 显式档位（非法 / 缺省交给 verifyWiki 自动解析） */
  detail?: string;
  /** 内容密度门失败计为整体失败 */
  enforce?: boolean;
}

function formatCheck(
  t: typeof enUS,
  status: VerifyStatus,
  group: string,
  message: string,
  details?: string[],
): string[] {
  const lines = [`${status} ${group} ${message}`];
  if (details && details.length > 0) {
    for (const detail of details) lines.push(`${t.verify.detailsPrefix}${detail}`);
  }
  return lines;
}

export async function runVerify(options: RunVerifyOptions = {}): Promise<void> {
  const config = loadConfigSync();
  const t = config?.language === 'en' ? enUS : zhCN;

  // 只守卫家目录：verify 不写目标仓库的数据目录（只读校验）
  const detail: BlueprintDetailLevel | null = options.detail
    ? DETAIL_LEVELS.has(options.detail)
      ? (options.detail as BlueprintDetailLevel)
      : null
    : null;

  takeOverStdout();
  try {
    const report: VerifyReport = await verifyWiki({
      detail,
      enforce: options.enforce === true,
    });

    // 变体信息（遗留目录单独标注；无产物时不打印头部）
    if (report.variant) {
      writeRawStdout(`${t.verify.variant.replace('{variant}', report.variant)}\n`);
    } else if (report.legacy) {
      writeRawStdout(`${t.verify.legacy}\n`);
    }

    let pass = 0;
    let fail = 0;
    let skip = 0;
    for (const check of report.checks) {
      if (check.status === 'PASS') pass++;
      else if (check.status === 'FAIL') fail++;
      else skip++;
      for (const line of formatCheck(t, check.status, check.group, check.message, check.details)) {
        writeRawStdout(`${line}\n`);
      }
    }

    writeRawStdout(
      `${t.verify.summary
        .replace('{checks}', String(report.checks.length))
        .replace('{pass}', String(pass))
        .replace('{fail}', String(fail))
        .replace('{skip}', String(skip))}\n`,
    );
    writeRawStdout(`${report.ok ? t.verify.overallPass : t.verify.overallFail}\n`);

    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify 失败: ${message}\n`);
    process.exitCode = 1;
  } finally {
    // 排队中的检查输出先落盘再还原 stdout，避免被 process.exit 截断
    await flushRawStdout();
    restoreStdout();
  }
}
