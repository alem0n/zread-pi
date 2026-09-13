/**
 * output-guard.ts —— stdout 接管专项回归
 *
 * 覆盖：
 *  1. 接管后杂散写入被 redirect（默认 stderr / 自定义回调 / 日志文件）；
 *  2. `writeRawStdout`（队列）与 `runWithRawStdout`（放行窗口）直达原生 stdout；
 *  3. `passthroughTerminalSequences`：ESC 开头的控制序列放行；
 *  4. 重复接管无副作用、`restoreStdout` 后恢复原语义。
 *
 * 测试用「假 stdout」替换 process.stdout.write 作为原生写入通道，
 * 因此断言的是真实分支走向而不是模拟。
 *
 * 运行：bun run test:tui
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'zread-pi-guard-home-'));
process.env.ZREAD_PI_HOME = home;

const { getLogFile } = await import('@zread-pi/utils');
const {
  flushRawStdout,
  isStdoutTakenOver,
  restoreStdout,
  runWithRawStdout,
  takeOverStdout,
  writeRawStdout,
} = await import('../src/tui/output-guard');

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 假 stdout：拦截「原生 stdout 通道」的写入，便于断言分支
const trueStdoutWrite = process.stdout.write;
const rawWrites: string[] = [];
process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
  rawWrites.push(String(chunk));
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  if (typeof done === 'function') (done as () => void)();
  return true;
}) as typeof process.stdout.write;

const strays: string[] = [];
check('接管前 isStdoutTakenOver=false', isStdoutTakenOver() === false);

takeOverStdout({ redirect: (text) => strays.push(text) });
check('接管后 isStdoutTakenOver=true', isStdoutTakenOver() === true);
takeOverStdout(); // 重复接管不应改变已有 redirect
check('重复接管无副作用（仍是首次的 redirect）', isStdoutTakenOver() === true);

// 1) 杂散写入 → redirect
process.stdout.write('stray-console-log\n');
check('杂散写入进入 redirect 回调', strays.join('') === 'stray-console-log\n', JSON.stringify(strays.join('')));

// 2) 放行窗口 → 原生 stdout
runWithRawStdout(() => process.stdout.write('tui-frame\n'));
check('runWithRawStdout 窗口内写入直达原生 stdout', rawWrites.includes('tui-frame\n'), rawWrites.join('|'));

// 3) ESC 开头的控制序列在 passthrough 模式下放行
restoreStdout();
const escStrays: string[] = [];
takeOverStdout({ redirect: (text) => escStrays.push(text), passthroughTerminalSequences: true });
process.stdout.write('\x1b[?1049h');
process.stdout.write('plain-log\n');
check(
  'passthrough 模式下 ESC 序列放行、普通文本仍被 redirect',
  rawWrites.includes('\x1b[?1049h') && escStrays.join('') === 'plain-log\n',
  `raw=${rawWrites.includes('\x1b[?1049h')} strays=${JSON.stringify(escStrays.join(''))}`,
);

// 4) 日志 redirect：杂散写入落到 zread-pi 日志文件
restoreStdout();
takeOverStdout({ redirect: 'log' });
process.stdout.write('guard-probe-to-log-4242\n');
check('redirect: log 时杂散写入进日志文件', await waitForLog('guard-probe-to-log-4242'), getLogFile());

// 5) 队列写入（writeRawStdout）在接管状态下仍直达原生 stdout
writeRawStdout('raw-queued\n');
await flushRawStdout();
check('writeRawStdout 队列写入直达原生 stdout', rawWrites.includes('raw-queued\n'));

// 6) 还原
restoreStdout();
check('restoreStdout 后 isStdoutTakenOver=false', isStdoutTakenOver() === false);
process.stdout.write('after-restore\n');
check('还原后写入回到（假）stdout 原语义', rawWrites.includes('after-restore\n'));

// 清理：把真实的 process.stdout.write 放回去
process.stdout.write = trueStdoutWrite;
await rm(home, { recursive: true, force: true });

async function waitForLog(needle: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const content = await readFile(getLogFile(), 'utf-8').catch(() => '');
    if (content.includes(needle)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((entry) => entry.name).join(', '));
  process.exit(1);
}
