/**
 * 版本守卫 CLI 包装层测试：runVersionGuard
 *
 * 覆盖包装层独有的逻辑（核心逻辑见 packages/utils/test/version-guard.ts）：
 *  - 家目录不兼容 → 备份 + stderr 输出含备份路径
 *  - 兼容 → 无输出（幂等，不刷屏），只更新 version 标记
 *  - 首次安装 → 静默生成（无提示）
 *  - ZREAD_PI_VERSION_GUARD=0 → 整体跳过
 *  - 只守卫家目录（不再碰目标仓库目录）
 *
 * 运行：bun run apps/cli/test/version-guard-cli.ts
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVersionFilePath, readVersionFile, writeVersionFile } from "@zread-pi/utils";
import { runVersionGuard } from "../src/commands/version-guard";
import { spawn } from "node:child_process";

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const roots: string[] = [];
async function tempHome(versionFile: boolean, ...extraFiles: Array<[string, string]>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zread-vg-cli-home-"));
  roots.push(home);
  const dir = join(home, ".zread-pi");
  await mkdir(dir, { recursive: true });
  for (const [relative, content] of extraFiles) {
    await mkdir(join(dir, relative, ".."), { recursive: true });
    await writeFile(join(dir, relative), content, "utf-8");
  }
  if (versionFile) await writeVersionFile(dir, "1.12.2");
  return home;
}

/** 抓取 stderr 输出 */
async function captureStderr(fn: () => Promise<string[]>): Promise<{ lines: string[]; stderr: string }> {
  const chunks: Buffer[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // 测试期替换 write 以抓取输出（类型兼容，无需 @ts-expect-error）
  process.stderr.write = (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  try {
    const lines = await fn();
    return { lines, stderr: Buffer.concat(chunks).toString("utf-8") };
  } finally {
    process.stderr.write = original;
  }
}

// 当前 CLI 版本（读根 package.json；与 runVersionGuard 用同一个 getVersion）
const currentVersion = (await readFile(join(process.cwd(), "package.json"), "utf-8").then((text) => JSON.parse(text).version)) as string;
console.log(`当前版本：${currentVersion}`);

// ---------------------------------------------------------------------------
// 1) 家目录不兼容 → 备份 + stderr 提示
// ---------------------------------------------------------------------------

console.log("▶ 家目录不兼容 → 备份并提示");

const incompatibleHome = await tempHome(false, ["config.yaml", "language: zh\ndoc_language: zh\n"]);
process.env.HOME = incompatibleHome;
process.env.USERPROFILE = incompatibleHome;
delete process.env.ZREAD_PI_HOME;
delete process.env.ZREAD_PI_VERSION_GUARD;

const { lines: incompatibleLines, stderr: incompatibleErr } = await captureStderr(() =>
  runVersionGuard(),
);
check("返回提示行", incompatibleLines.length > 0, JSON.stringify(incompatibleLines));
check("stderr 含备份路径", incompatibleErr.includes("_bak"), JSON.stringify(incompatibleErr.split("\n")[0]));
check("stderr 含备份提示（尽快处理）", incompatibleErr.includes("尽快") || incompatibleErr.includes("ASAP"));
check("旧 config.yaml 保留在备份目录", !!(await readFile(join(incompatibleHome, ".zread-pi_bak", "config.yaml"), "utf-8").catch(() => null)));
check("新目录已写入当前版本", await readVersionFile(join(incompatibleHome, ".zread-pi")) === currentVersion);
// 语言取自守卫前的旧配置 → 中文提示
check("提示语言随旧配置（zh）", incompatibleErr.includes("不兼容"));

// ---------------------------------------------------------------------------
// 2) 兼容 → 无输出（幂等），但版本标记会更新为当前版本
// ---------------------------------------------------------------------------

console.log("▶ 兼容时无输出");

// 造一个「分界之后」的标记：当前版本一定 >= 不兼容分界，故兼容
await writeVersionFile(join(incompatibleHome, ".zread-pi"), "1.13.0");

const { lines: compatLines, stderr: compatErr } = await captureStderr(() =>
  runVersionGuard(),
);
check("无提示行", compatLines.length === 0, JSON.stringify(compatLines));
check("stderr 为空", compatErr === "");
check("版本标记更新为当前版本", await readVersionFile(join(incompatibleHome, ".zread-pi")) === currentVersion);

// ---------------------------------------------------------------------------
// 3) 首次安装 → 静默生成
// ---------------------------------------------------------------------------

console.log("▶ 首次安装静默生成");

const freshHome = await mkdtemp(join(tmpdir(), "zread-vg-cli-fresh-"));
roots.push(freshHome);
process.env.HOME = freshHome;
process.env.USERPROFILE = freshHome;

const { lines: freshLines, stderr: freshErr } = await captureStderr(() =>
  runVersionGuard(),
);
check("无提示行（直接生成，不打扰）", freshLines.length === 0, JSON.stringify(freshLines));
check("stderr 为空", freshErr === "");
check("version 文件已生成", await readVersionFile(join(freshHome, ".zread-pi")) === currentVersion);

// ---------------------------------------------------------------------------
// 4) ZREAD_PI_VERSION_GUARD=0 → 整体跳过
// ---------------------------------------------------------------------------

console.log("▶ 环境变量绕过");

process.env.ZREAD_PI_VERSION_GUARD = "0";
const skipHome = await tempHome(false, ["config.yaml", "language: zh\ndoc_language: zh\n"]);
roots.push(skipHome);
process.env.HOME = skipHome;
process.env.USERPROFILE = skipHome;

const { lines: skipLines } = await captureStderr(() => runVersionGuard());
check("跳过：无提示行", skipLines.length === 0, JSON.stringify(skipLines));
check("跳过：旧数据保持原样（未备份）", !!(await readFile(join(skipHome, ".zread-pi", "config.yaml"), "utf-8").catch(() => null)));
check("跳过：未写入 version 文件", (await readVersionFile(join(skipHome, ".zread-pi"))) === null);
delete process.env.ZREAD_PI_VERSION_GUARD;

// ---------------------------------------------------------------------------
// 5) 只守卫家目录：不再碰目标仓库目录（不为其写版本标记、不备份）
// ---------------------------------------------------------------------------

console.log("▶ 只守卫家目录");

const repoHome = await tempHome(true);
roots.push(repoHome);
process.env.HOME = repoHome;
process.env.USERPROFILE = repoHome;
const repoWorkspace = await mkdtemp(join(tmpdir(), "zread-vg-cli-repo-"));
roots.push(repoWorkspace);
const repoDir = join(repoWorkspace, "my-repo");
await mkdir(join(repoDir, ".zread-pi", "wiki", "high"), { recursive: true });
await writeFile(join(repoDir, ".zread-pi", "wiki", "high", "wiki.json"), "{}", "utf-8");
process.chdir(repoDir);

await runVersionGuard();
check("仓库目录不写版本标记", (await readVersionFile(join(repoDir, ".zread-pi"))) === null);
check("仓库旧产物不被备份", !(await readFile(join(repoDir, ".zread-pi_bak", "wiki", "high", "wiki.json"), "utf-8").catch(() => null)));

// ---------------------------------------------------------------------------
// 6) 家目录被别的进程当作 cwd → 提示并退出进程（不降级、不继续启动）
// ---------------------------------------------------------------------------

console.log("▶ 家目录被占用时提示并退出");

const busyHome = await tempHome(false, ["config.yaml", "language: zh\ndoc_language: zh\n"]);
process.env.HOME = busyHome;
process.env.USERPROFILE = busyHome;
delete process.env.ZREAD_PI_HOME;
delete process.env.ZREAD_PI_VERSION_GUARD;

const busyDir = join(busyHome, ".zread-pi");
// 子进程把 cwd 设为家目录 → Windows 拒绝整体重命名 → 触发「提示并退出」
const holderCode = `process.chdir(${JSON.stringify(busyDir)}); setTimeout(() => process.exit(0), 20000);`;
const holder = spawn(process.execPath, ["-e", holderCode], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 800));

// 拦截 process.exit：记录退出码但不真的退出（测试进程还要继续）；同时抓 stderr
let exitCode: number | undefined;
const stderrChunks: Buffer[] = [];
const originalExit = process.exit;
const originalWrite = process.stderr.write.bind(process.stderr);
process.exit = ((code?: number) => {
  exitCode = code ?? 0;
}) as typeof process.exit;
process.stderr.write = (chunk: Buffer | string) => {
  stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return true;
};

let guardError: unknown;
try {
  await runVersionGuard();
} catch (error) {
  guardError = error; // process.exit 被拦截后函数应已 return，这里不应被走到
}
process.exit = originalExit;
process.stderr.write = originalWrite;

const busyErr = Buffer.concat(stderrChunks).toString("utf-8");
check("请求退出码 = 1（提示后退出）", exitCode === 1, `exitCode=${exitCode}`);
check("未抛错给调用方（由 runVersionGuard 内部处理退出）", guardError === undefined);
check("stderr 含失败原因（占用 / 无法重命名）", busyErr.includes("占用") || busyErr.includes("in use"));
check("stderr 含重试指引（关闭程序后重跑）", busyErr.includes("重新运行") || busyErr.includes("re-run"));
check("旧数据保持原位（未备份、未降级）", !!(await readFile(join(busyHome, ".zread-pi", "config.yaml"), "utf-8").catch(() => null)));
check("未写入 version 文件", (await readVersionFile(join(busyHome, ".zread-pi"))) === null);

try { holder.kill(); } catch { /* 已退出 */ }
await new Promise((resolve) => setTimeout(resolve, 200));

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

process.chdir(join(repoWorkspace, ".."));
await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.error("失败项：", failed.map((entry) => entry.name).join(", "));
  process.exit(1);
}
