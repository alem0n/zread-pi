/**
 * history-adopt.ts —— 「添加老旧项目」回归
 *
 * 逻辑：用 zread-pi 打开目标目录时，如果发现当前目录已经生成了文档
 * （wiki.json 可解析、页面非空、且全部页面已落盘），且路径不在全局记忆里，
 * 就自动补录一条，方便后续通过 `zread-pi history` 找到它。
 *
 * 覆盖：
 *  - 完整文档目录：启动后自动登记（无需生成、无需按键）
 *  - 已在记忆中：不重复、不改变顺序（不刷到末尾）
 *  - 文档不完整（缺页面）/ 无 wiki.json：不登记
 *  - `-d/--dir` 打开其它目录：登记的是目标目录而不是调用目录
 *
 * 全程离线；HOME / ZREAD_PI_HOME 指向临时目录，不碰真实 ~/.zread-pi。
 *
 * 运行：bun run test:history
 */

import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, rememberProject, type ProjectRecord } from "@zread-pi/utils";

// ---------------------------------------------------------------------------
// 0) 断言 / 等待工具
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(100);
  }
  console.error(`  ! 超时未满足条件：${label}`);
  return false;
}

/** 路径比较用归一化：Windows 大小写不敏感；macOS 上 /var 是 /private/var 的符号链接 */
async function canonical(path: string): Promise<string> {
  const real = await realpath(path).catch(() => path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------
// 1) 临时目录 / CLI 定位
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = join(repoRoot, "apps", "cli", "src", "index.ts");

const workspace = await mkdtemp(join(tmpdir(), "zread-pi-adopt-work-"));

interface ProjectPage {
  slug: string;
  title: string;
  file: string;
  section: string;
  level: string;
}

const PAGES: ProjectPage[] = [
  { slug: "1-overview", title: "概览", file: "1-overview.md", section: "入门", level: "Beginner" },
  { slug: "2-api", title: "API", file: "2-api.md", section: "参考", level: "Intermediate" },
];

/** 生成一个「已经生成好文档」的老旧项目目录 */
async function makeProject(root: string, options: { complete: boolean }): Promise<void> {
  const wikiDir = join(root, ".zread-pi", "wiki");
  for (const page of PAGES) {
    await mkdir(join(wikiDir, page.section), { recursive: true });
  }
  await writeFile(
    join(wikiDir, "wiki.json"),
    JSON.stringify({ pages: PAGES }, null, 2),
    "utf-8",
  );
  const written = options.complete ? PAGES : PAGES.slice(0, 1);
  for (const page of written) {
    await writeFile(join(wikiDir, page.section, page.file), `# ${page.title}\n`, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 2) CLI 运行器（管道 stdin/stdout）
// ---------------------------------------------------------------------------

interface CliRun {
  stdout: () => string;
  exited: Promise<number>;
  send: (data: string) => void;
  kill: () => void;
  done: Promise<void>;
}

function spawnCli(args: string[], cwd: string, homeDir: string): CliRun {
  const child = Bun.spawn(["bun", "run", cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ZREAD_PI_HOME: homeDir,
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "40",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
  };
  const done = pump(child.stdout, (text) => (stdout += text)).catch(() => undefined);

  return {
    stdout: () => stdout,
    exited: child.exited,
    send: (data: string) => {
      try {
        child.stdin.write(data);
        child.stdin.flush();
      } catch {
        // 进程已退出，忽略 EPIPE
      }
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
    },
    done,
  };
}

/** 等 TUI 进入备用屏幕（自动登记在 TUI 启动前完成，因此此时读记忆是确定的） */
async function waitForTui(run: CliRun): Promise<boolean> {
  return waitFor(() => run.stdout().includes("\x1b[?1049h"), 20000, "TUI 启动（备用屏幕）");
}

async function stop(run: CliRun): Promise<void> {
  run.send("\x03");
  const result = await Promise.race([
    run.exited,
    sleep(4000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") run.kill();
  await run.done;
}

/** 从指定家目录读全局记忆（不动测试进程的其它状态） */
async function readRecords(homeDir: string): Promise<ProjectRecord[]> {
  process.env.ZREAD_PI_HOME = homeDir;
  return readHistory();
}

// ---------------------------------------------------------------------------
// 3) 用例
// ---------------------------------------------------------------------------

console.log("▶ 「添加老旧项目」：打开已有文档的目录自动登记全局记忆");

// --- 用例 1：完整文档目录 → 自动登记 ---
{
  const home = await mkdtemp(join(tmpdir(), "zread-pi-adopt-home-"));
  const repo = join(workspace, "complete-project");
  await makeProject(repo, { complete: true });

  const run = spawnCli([], repo, home);
  const started = await waitForTui(run);

  const records = await readRecords(home);
  const target = await canonical(repo);
  const matched = (await Promise.all(records.map((record) => canonical(record.path)))).filter(
    (path) => path === target,
  );
  check("完整文档：自动登记当前项目", started && matched.length === 1, JSON.stringify(records));
  check("完整文档：只登记一条（无重复）", records.length === 1, JSON.stringify(records));

  await stop(run);
  await rm(home, { recursive: true, force: true });
}

// --- 用例 2：已在记忆中 → 不重复、不刷位置 ---
{
  const home = await mkdtemp(join(tmpdir(), "zread-pi-adopt-home-"));
  const repo = join(workspace, "recorded-project");
  const other = join(workspace, "other-project");
  await makeProject(repo, { complete: true });

  process.env.ZREAD_PI_HOME = home;
  await rememberProject(repo);
  await rememberProject(other);
  const before = (await readRecords(home)).map((record) => record.path);
  const beforeCanonical = await Promise.all(before.map((path) => canonical(path)));
  const target = await canonical(repo);
  check(
    "已在记忆：预置顺序为 [本项目, 其它项目]",
    before.length === 2 && beforeCanonical[0] === target,
    JSON.stringify(before),
  );

  const run = spawnCli([], repo, home);
  const started = await waitForTui(run);
  await sleep(200);

  const after = (await readRecords(home)).map((record) => record.path);
  check("已在记忆：不新增、不重复", started && after.length === 2, JSON.stringify(after));
  check(
    "已在记忆：不把它刷到末尾（顺序不变）",
    after[0] === before[0] && after[1] === before[1],
    JSON.stringify({ before, after }),
  );

  await stop(run);
  await rm(home, { recursive: true, force: true });
}

// --- 用例 3：文档不完整（缺页面）→ 不登记 ---
{
  const home = await mkdtemp(join(tmpdir(), "zread-pi-adopt-home-"));
  const repo = join(workspace, "incomplete-project");
  await makeProject(repo, { complete: false });

  const run = spawnCli([], repo, home);
  const started = await waitForTui(run);
  await sleep(200);

  const records = await readRecords(home);
  check(
    "文档不完整：不登记（首页显示的是「继续生成」）",
    started && records.length === 0,
    JSON.stringify(records),
  );
  check("文档不完整：不创建空的 history 文件", !(await exists(join(home, "history"))));

  await stop(run);
  await rm(home, { recursive: true, force: true });
}

// --- 用例 4：没有 wiki.json → 不登记 ---
{
  const home = await mkdtemp(join(tmpdir(), "zread-pi-adopt-home-"));
  const repo = join(workspace, "no-docs-project");
  await mkdir(repo, { recursive: true });

  const run = spawnCli([], repo, home);
  const started = await waitForTui(run);
  await sleep(200);

  const records = await readRecords(home);
  check("无文档：不登记", started && records.length === 0, JSON.stringify(records));

  await stop(run);
  await rm(home, { recursive: true, force: true });
}

// --- 用例 5：-d/--dir 打开其它目录 → 登记目标目录 ---
{
  const home = await mkdtemp(join(tmpdir(), "zread-pi-adopt-home-"));
  const repo = join(workspace, "dir-flag-project");
  await makeProject(repo, { complete: true });

  const run = spawnCli(["--dir", repo], workspace, home);
  const started = await waitForTui(run);

  const records = await readRecords(home);
  const target = await canonical(repo);
  const workspaceReal = await canonical(workspace);
  const paths = await Promise.all(records.map((record) => canonical(record.path)));
  check("--dir：登记的是目标目录", started && paths.includes(target), JSON.stringify(records));
  check("--dir：不登记调用目录", !paths.includes(workspaceReal), JSON.stringify(records));

  await stop(run);
  await rm(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4) 清理 + 汇总
// ---------------------------------------------------------------------------

await rm(workspace, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
