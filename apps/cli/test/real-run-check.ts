/**
 * real-run-check.ts —— 用真实 ProcessTerminal 跑一遍 CLI（stdin 为管道）
 *
 * 覆盖：非 mock 终端路径（ProcessTerminal + TuiAltScreen）能正常启动、渲染完整一帧，
 * 并在收到 ctrl+c 时退出（退出码 0 + 退出备用屏幕缓冲）。
 *
 * 运行：bun run test:tui
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const home = await mkdtemp(join(tmpdir(), "zread-real-run-home-"));
await mkdir(join(home, ".zread"), { recursive: true });
await writeFile(
  join(home, ".zread", "config.yaml"),
  [
    "language: zh",
    "doc_language: zh",
    "llm:",
    "  provider: openai-compatible",
    "  model: gpt-4o-mini",
    "  api_key: sk-test",
    "  base_url: http://127.0.0.1:1/v1",
    "concurrency:",
    "  max_concurrent: 3",
    "  max_retries: 1",
    "",
  ].join("\n"),
  "utf-8",
);

const child = Bun.spawn(["bun", "run", "apps/cli/src/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, USERPROFILE: home, TERM: "xterm-256color" },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

let stdout = "";
const readStdout = (async () => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    stdout += decoder.decode(value, { stream: true });
  }
})();
const readStderr = (async () => {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
})();

await new Promise((resolve) => setTimeout(resolve, 2000));

const frameText = stripTerminalSequences(stdout);
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
  }
};

console.log("▶ 真实终端（ProcessTerminal）启动 / 退出检查");
check("进入备用屏幕缓冲", stdout.includes("\x1b[?1049h"));
check("渲染了项目信息框", frameText.includes("╭") && frameText.includes("╰"));
check("渲染了项目名", frameText.includes("zread-pi"));
check("渲染了页面文案", frameText.includes("尚无文档目录"));
check("渲染了选项", frameText.includes("生成文档") && frameText.includes("配置") && frameText.includes("退出"));

// ctrl+c 退出
child.stdin.write("\x03");
child.stdin.flush();

const exitCode = await Promise.race([
  child.exited,
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
]);

await readStdout.catch(() => undefined);
const stderr = await readStderr.catch(() => "");
await rm(home, { recursive: true, force: true });

check("ctrl+c 后进程退出", exitCode !== "timeout", `exitCode=${String(exitCode)}`);
check("退出码为 0", exitCode === 0, `exitCode=${String(exitCode)}`);
check("退出备用屏幕缓冲", stdout.includes("\x1b[?1049l"));
check("进程未输出错误", stderr.trim().length === 0, stderr.trim().slice(0, 400));

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
