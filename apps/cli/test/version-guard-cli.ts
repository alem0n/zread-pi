/**
 * 版本守卫 CLI 包装层测试：runVersionGuard
 *
 * 覆盖包装层独有的逻辑（核心逻辑见 packages/utils/test/version-guard.ts）：
 *  - 家目录不兼容 → 备份 + stderr 输出含备份路径
 *  - 兼容 → 无输出（幂等，不刷屏）
 *  - 首次安装 → 静默生成（无提示）
 *  - ZREAD_PI_VERSION_GUARD=0 → 整体跳过
 *  - repo: false → 不碰目标仓库目录
 *
 * 运行：bun run apps/cli/test/version-guard-cli.ts
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVersionFilePath, readVersionFile, writeVersionFile } from "@zread-pi/utils";
import { runVersionGuard } from "../src/commands/version-guard";

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
  runVersionGuard({ repo: false }),
);
check("返回提示行", incompatibleLines.length > 0, JSON.stringify(incompatibleLines));
check("stderr 含备份路径", incompatibleErr.includes("_bak"), JSON.stringify(incompatibleErr.split("\n")[0]));
check("stderr 含备份提示（尽快处理）", incompatibleErr.includes("尽快") || incompatibleErr.includes("ASAP"));
check("旧 config.yaml 保留在备份目录", !!(await readFile(join(incompatibleHome, ".zread-pi_bak", "config.yaml"), "utf-8").catch(() => null)));
check("新目录已写入当前版本", await readVersionFile(join(incompatibleHome, ".zread-pi")) === currentVersion);
// 语言取自守卫前的旧配置 → 中文提示
check("提示语言随旧配置（zh）", incompatibleErr.includes("不兼容"));

// ---------------------------------------------------------------------------
// 2) 兼容 → 无输出（幂等）
// ---------------------------------------------------------------------------

console.log("▶ 兼容时无输出");

const { lines: compatLines, stderr: compatErr } = await captureStderr(() =>
  runVersionGuard({ repo: false }),
);
check("无提示行", compatLines.length === 0, JSON.stringify(compatLines));
check("stderr 为空", compatErr === "");

// ---------------------------------------------------------------------------
// 3) 首次安装 → 静默生成
// ---------------------------------------------------------------------------

console.log("▶ 首次安装静默生成");

const freshHome = await mkdtemp(join(tmpdir(), "zread-vg-cli-fresh-"));
roots.push(freshHome);
process.env.HOME = freshHome;
process.env.USERPROFILE = freshHome;

const { lines: freshLines, stderr: freshErr } = await captureStderr(() =>
  runVersionGuard({ repo: false }),
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

const { lines: skipLines } = await captureStderr(() => runVersionGuard({ repo: false }));
check("跳过：无提示行", skipLines.length === 0, JSON.stringify(skipLines));
check("跳过：旧数据保持原样（未备份）", !!(await readFile(join(skipHome, ".zread-pi", "config.yaml"), "utf-8").catch(() => null)));
check("跳过：未写入 version 文件", (await readVersionFile(join(skipHome, ".zread-pi"))) === null);
delete process.env.ZREAD_PI_VERSION_GUARD;

// ---------------------------------------------------------------------------
// 5) repo: true → 同时守卫目标仓库目录
// ---------------------------------------------------------------------------

console.log("▶ 同时守卫目标仓库目录");

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

await runVersionGuard({ repo: true });
check("仓库目录已写入版本标记", await readVersionFile(join(repoDir, ".zread-pi")) === currentVersion);
check("仓库旧产物保留在备份里", !!(await readFile(join(repoDir, ".zread-pi_bak", "wiki", "high", "wiki.json"), "utf-8").catch(() => null)));

// repo: false 时不碰仓库目录（换一个仓库验证）
const repo2 = join(repoWorkspace, "my-repo-2");
await mkdir(join(repo2, ".zread-pi"), { recursive: true });
process.chdir(repo2);
await runVersionGuard({ repo: false });
check("repo:false 不写仓库目录的版本标记", (await readVersionFile(join(repo2, ".zread-pi"))) === null);

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
