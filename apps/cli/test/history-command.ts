/**
 * history-command.ts —— `zread-pi history` 启动参数回归
 *
 * 覆盖：
 *  - 空记忆：输出「暂无历史记录」、退出码 0
 *  - 有记录：清理失效项目（目录不存在 / `.zread-pi` 不存在），展示剩余记录（保序）
 *  - 幂等：再次执行不再删除、结果不变
 *  - `-c/--concurrency` 参数可用
 *  - 损坏的 history 文件：备份重建、命令不崩溃
 *  - 帮助信息登记了 history 子命令
 *
 * 全程离线；用 ZREAD_PI_HOME 指向临时目录，不碰真实 ~/.zread-pi。
 *
 * 运行：bun run test:history
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHistoryPath, readHistory, rememberProject } from '@zread-pi/utils';

// ---------------------------------------------------------------------------
// 0) 断言工具
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}


// ---------------------------------------------------------------------------
// 1) 临时 HOME / 项目 / 记忆数据
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliEntry = join(repoRoot, 'apps', 'cli', 'src', 'index.ts');

const work = await mkdtemp(join(tmpdir(), 'zread-pi-history-work-'));
const emptyHome = await mkdtemp(join(tmpdir(), 'zread-pi-history-empty-'));
const mainHome = await mkdtemp(join(tmpdir(), 'zread-pi-history-main-'));
const brokenHome = await mkdtemp(join(tmpdir(), 'zread-pi-history-broken-'));

const aliveProject = join(work, 'alive-project');
const secondProject = join(work, 'second-project');
const staleProject = join(work, 'deleted-project');

await mkdir(join(aliveProject, '.zread-pi', 'wiki'), { recursive: true });
await mkdir(join(secondProject, '.zread-pi'), { recursive: true });

process.env.ZREAD_PI_HOME = mainHome;
await rememberProject(aliveProject);
await rememberProject(staleProject);
await rememberProject(secondProject);

// 损坏的记忆文件（magic 不合法）
process.env.ZREAD_PI_HOME = brokenHome;
await writeFile(getHistoryPath(), 'this is definitely not a ZRH1 history file');
process.env.ZREAD_PI_HOME = mainHome;

// ---------------------------------------------------------------------------
// 2) CLI 运行器
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(homeDir: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn(['bun', 'run', cliEntry, ...args], {
    cwd: work,
    env: {
      ...process.env,
      ZREAD_PI_HOME: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const decode = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };

  const [stdout, stderr, code] = await Promise.all([
    decode(child.stdout),
    decode(child.stderr),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// 3) 用例
// ---------------------------------------------------------------------------

console.log('▶ zread-pi history 启动参数回归');

// --- 用例 1：空记忆 ---
{
  const result = await runCli(emptyHome, ['history']);
  check('空记忆：退出码 0', result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check(
    '空记忆：输出「暂无历史记录」',
    result.stdout.includes('暂无历史记录'),
    result.stdout,
  );
  check('空记忆：无失效清理提示', !result.stdout.includes('已清理'), result.stdout);
}

// --- 用例 2：清理失效记录 + 展示剩余 ---
{
  const result = await runCli(mainHome, ['history']);
  check('有记录：退出码 0', result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check('有记录：报告清理条数', result.stdout.includes('已清理 1 条失效记录'), result.stdout);
  check('有记录：报告剩余条数', result.stdout.includes('剩余 2 条记录：'), result.stdout);
  check('有记录：展示有效项目路径', result.stdout.includes(aliveProject), result.stdout);
  check('有记录：展示第二个有效项目路径', result.stdout.includes(secondProject), result.stdout);
  check('有记录：不展示已失效项目', !result.stdout.includes(staleProject), result.stdout);
  check(
    '有记录：保留原始记录顺序（alive 在前）',
    result.stdout.indexOf(aliveProject) < result.stdout.indexOf(secondProject),
    result.stdout,
  );

  const raw = await readFile(getHistoryPath());
  check('有记录：history 文件为 ZRH1 二进制', raw.subarray(0, 4).toString('ascii') === 'ZRH1');

  const persisted = await readHistory();
  check(
    '有记录：失效记录已从记忆中移除',
    !persisted.some((record) => record.path === staleProject),
    JSON.stringify(persisted),
  );
  check(
    '有记录：二进制中保留的两条记录正确',
    persisted.length === 2 &&
      persisted[0].path === aliveProject &&
      persisted[1].path === secondProject,
    JSON.stringify(persisted),
  );
}

// --- 用例 3：幂等（再执行一次不重复清理） ---
{
  const result = await runCli(mainHome, ['history']);
  check('幂等：退出码 0', result.code === 0, `code=${result.code}`);
  check('幂等：不再报告清理', !result.stdout.includes('已清理'), result.stdout);
  check('幂等：剩余条数不变', result.stdout.includes('剩余 2 条记录：'), result.stdout);
}

// --- 用例 4：-c/--concurrency 参数 ---
{
  const result = await runCli(mainHome, ['history', '-c', '1']);
  check('-c 1：退出码 0', result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check('-c 1：正常展示剩余记录', result.stdout.includes('剩余 2 条记录：'), result.stdout);
}

// --- 用例 5：损坏文件自愈 ---
{
  const result = await runCli(brokenHome, ['history']);
  check('损坏文件：命令不崩溃（退出码 0）', result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  check('损坏文件：按空记忆展示', result.stdout.includes('暂无历史记录'), result.stdout);
  const files = await readdir(brokenHome);
  check(
    '损坏文件：已备份为 history.corrupt-*',
    files.some((name) => name.startsWith('history.corrupt-')),
    files.join(', '),
  );
}

// --- 用例 6：帮助信息登记 history 子命令 ---
{
  const result = await runCli(emptyHome, ['--help']);
  check('帮助信息包含 history 子命令', result.stdout.includes('history'), result.stdout);
  check('帮助信息包含子命令描述', result.stdout.includes('全局记忆'), result.stdout);

  const subHelp = await runCli(emptyHome, ['history', '--help']);
  check(
    'history --help 包含并发参数',
    subHelp.stdout.includes('-c, --concurrency'),
    subHelp.stdout,
  );
}

// ---------------------------------------------------------------------------
// 4) 清理 + 汇总
// ---------------------------------------------------------------------------

for (const path of [work, emptyHome, mainHome, brokenHome]) {
  await rm(path, { recursive: true, force: true });
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
