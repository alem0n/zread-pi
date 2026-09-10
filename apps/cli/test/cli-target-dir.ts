/**
 * cli-target-dir.ts —— CLI 目标目录参数（-d / --dir）回归
 *
 * 覆盖真实 CLI 进程（ProcessTerminal + 管道 stdin）+ mock LLM：
 * - `--dir <绝对路径>`：头部显示目标目录；扫描与 `.open-zread` 落盘都切到目标目录，调用目录不被写入
 * - `-d <相对路径>`：按「调用时的当前目录」解析（复用上一步产物，验证确实指向同一目录）
 * - `wiki --dir <路径>`：显式子命令写法同样生效
 * - 目录不存在 / 路径不是目录：退出码 1 + 单行干净错误信息（不进入备用屏幕）
 * - 未指定 -d：保持「当前目录」语义（默认行为不回归）
 *
 * 运行：bun run test:tui（或单独 bun run apps/cli/test/cli-target-dir.ts）
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

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

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** 路径比较用归一化：Windows 大小写不敏感；macOS 上 /var 是 /private/var 的符号链接 */
async function canonical(path: string): Promise<string> {
  const real = await realpath(path).catch(() => path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

// ---------------------------------------------------------------------------
// 1) mock LLM（OpenAI 兼容 SSE，与 apps/cli/test/mock-generate.ts 同款）
// ---------------------------------------------------------------------------

const PAGES = [
  {
    slug: "1-main",
    title: "入口",
    file: "1-main.md",
    section: "入门指南",
    level: "Beginner",
    associatedFiles: ["main.ts"],
  },
  {
    slug: "2-utils",
    title: "工具函数",
    file: "2-utils.md",
    section: "模块",
    level: "Intermediate",
    associatedFiles: ["src/utils.ts"],
  },
];

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function baseChunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toolCall(id: string, name: string, args: unknown): string {
  return (
    chunk(baseChunk({ role: "assistant", content: "" }, null)) +
    chunk(
      baseChunk(
        {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        "tool_calls",
      ),
    )
  );
}

function textChunk(text: string): string {
  return (
    chunk(baseChunk({ role: "assistant", content: text }, null)) + chunk(baseChunk({}, "stop"))
  );
}

const usageChunk = JSON.stringify({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "mock-model",
  choices: [],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
});

let requestCount = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requestCount += 1;
    const body = (await request.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = body.messages ?? [];
    const prompt = JSON.stringify(messages.map((message) => message.content ?? ""));
    const hasToolResult = messages.some((message) => message.role === "tool");
    const isPageAgent = prompt.includes("当前页面任务");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string): void => controller.enqueue(encoder.encode(text));
        if (!hasToolResult) {
          if (isPageAgent) {
            const slug = /\*\*Slug\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? PAGES[0].slug;
            const page = PAGES.find((candidate) => candidate.slug === slug) ?? PAGES[0];
            write(
              toolCall(`call_${page.slug}`, "write_page", {
                slug: page.slug,
                file: page.file,
                section: page.section,
                title: page.title,
                content: [
                  `# ${page.title}`,
                  "",
                  "> 由 mock LLM 生成（目标目录参数回归）。",
                  "",
                  "```mermaid",
                  "flowchart TB",
                  `  A["${page.title}"] --> B["测试通过"]`,
                  "```",
                  "",
                ].join("\n"),
              }),
            );
          } else {
            write(
              toolCall("call_blueprint", "generate_blueprint", {
                pages: PAGES,
                techStackSummary: { 语言: "TypeScript", 说明: "mock LLM 离线试跑" },
              }),
            );
          }
        } else {
          write(textChunk(isPageAgent ? "页面完成" : "蓝图完成"));
        }
        write(chunk(JSON.parse(usageChunk)));
        write("data: [DONE]\n\n");
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

// ---------------------------------------------------------------------------
// 2) 临时 HOME + 工作目录（调用目录） + 目标仓库
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = join(repoRoot, "apps", "cli", "src", "index.ts");

const home = await mkdtemp(join(tmpdir(), "open-zread-dir-home-"));
const workspace = await mkdtemp(join(tmpdir(), "open-zread-dir-work-"));
const targetRepo = join(workspace, "target-repo");

await mkdir(join(home, ".zread"), { recursive: true });
await writeFile(
  join(home, ".zread", "config.yaml"),
  [
    "language: zh",
    "doc_language: zh",
    "llm:",
    "  provider: openai-compatible",
    "  model: mock-model",
    "  api_key: sk-mock",
    `  base_url: http://127.0.0.1:${server.port}/v1`,
    "concurrency:",
    "  max_concurrent: 2",
    "  max_retries: 0",
    "",
  ].join("\n"),
  "utf-8",
);

await mkdir(join(targetRepo, "src"), { recursive: true });
await writeFile(join(targetRepo, "main.ts"), 'export const hello = (): string => "hello";\n', "utf-8");
await writeFile(
  join(targetRepo, "src", "utils.ts"),
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "utf-8",
);

function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TERM: "xterm-256color",
    // 宽终端：避免长路径在头部被 clamp 截断（terminal.ts 的 columns 回退顺序）
    COLUMNS: "200",
    LINES: "50",
  };
  // 避免宿主环境的凭据影响「未配置」判定
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

interface CliRun {
  raw: () => string;
  text: () => string;
  stderr: () => string;
  exited: Promise<number>;
  done: Promise<void>;
  send: (data: string) => void;
}

function spawnCli(args: string[], cwd: string): CliRun {
  const child = Bun.spawn(["bun", "run", cliEntry, ...args], {
    cwd,
    env: childEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let rawStdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
  };
  const done = Promise.all([
    pump(child.stdout, (text) => (rawStdout += text)),
    pump(child.stderr, (text) => (stderr += text)),
  ]).then(() => undefined);

  return {
    raw: () => rawStdout,
    text: () => stripTerminalSequences(rawStdout),
    stderr: () => stderr,
    exited: child.exited,
    done,
    send: (data: string) => {
      try {
        child.stdin.write(data);
        child.stdin.flush();
      } catch {
        // 子进程可能已退出（用例 5/6），忽略 EPIPE
      }
    },
  };
}

async function stop(run: CliRun): Promise<number> {
  run.send("\x03");
  const exitCode = await Promise.race([run.exited, sleep(5000).then(() => "timeout" as const)]);
  await run.done;
  return typeof exitCode === "number" ? exitCode : -1;
}

// ---------------------------------------------------------------------------
// 3) 用例
// ---------------------------------------------------------------------------

console.log("▶ CLI 目标目录参数（-d / --dir）回归");

const canonicalTarget = await canonical(targetRepo);

// --- 用例 1：--dir 绝对路径 + 真实生成（产物必须落在目标目录） ---
{
  const run = spawnCli(["--dir", targetRepo], workspace);

  const homeRendered = await waitFor(
    () => run.text().includes("尚无文档目录"),
    20000,
    "目标目录首帧渲染",
  );
  check("进入备用屏幕缓冲", run.raw().includes("\x1b[?1049h"));
  check(
    "头部显示 --dir 指定的目标目录",
    run.text().toLowerCase().includes(`目录: ${canonicalTarget}`),
    run.text().slice(-800),
  );
  check("--dir 目录无 wiki 时状态为「尚无文档目录」", homeRendered);

  run.send("\r");
  const wikiJsonPath = join(targetRepo, ".open-zread", "wiki", "wiki.json");
  const generated = await waitFor(() => exists(wikiJsonPath), 40000, "目标目录生成 wiki.json");
  check("wiki.json 落盘到目标目录", generated, wikiJsonPath);

  if (generated) {
    const catalog = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as {
      pages: Array<{ file: string; section: string }>;
    };
    check("wiki.json 含 2 个页面", catalog.pages.length === 2, `实际 ${catalog.pages.length}`);
    for (const page of PAGES) {
      const file = join(targetRepo, ".open-zread", "wiki", page.section, page.file);
      check(`页面文件已生成：${page.section}/${page.file}`, await exists(file));
    }
  }

  const allDone = await waitFor(() => run.text().includes("文章 2/2"), 30000, "页面生成完成");
  check("生成完成后界面显示「文章 2/2」", allDone);
  check("调用目录未被写入 .open-zread", !(await exists(join(workspace, ".open-zread"))));
  check("发生了真实的 mock LLM 请求", requestCount >= 4, `requests=${requestCount}`);

  const exitCode = await stop(run);
  check("ctrl+c 退出码为 0", exitCode === 0, `exitCode=${exitCode}`);
  check("退出备用屏幕缓冲", run.raw().includes("\x1b[?1049l"));
}

// --- 用例 2：-d 相对路径（按调用目录解析，复用用例 1 的产物） ---
{
  const run = spawnCli(["-d", "target-repo"], workspace);
  const recognized = await waitFor(
    () => run.text().includes("文档已生成 (2 篇)"),
    20000,
    "相对路径解析到目标目录",
  );
  check("相对路径 -d 按调用目录解析（识别到目标目录已有文档）", recognized, run.text().slice(-800));

  const exitCode = await stop(run);
  check("相对路径运行正常退出", exitCode === 0, `exitCode=${exitCode}`);
}

// --- 用例 3：显式 wiki 子命令 + --dir ---
{
  const run = spawnCli(["wiki", "--dir", targetRepo], workspace);
  const recognized = await waitFor(
    () => run.text().includes("文档已生成 (2 篇)"),
    20000,
    "`wiki --dir` 生效",
  );
  check("`wiki --dir <path>` 写法同样生效", recognized, run.text().slice(-800));

  const exitCode = await stop(run);
  check("子命令写法运行正常退出", exitCode === 0, `exitCode=${exitCode}`);
}

// --- 用例 4：未指定 -d（默认=调用目录，行为不回归） ---
{
  const run = spawnCli([], targetRepo);
  const rendered = await waitFor(
    () => run.text().includes("文档已生成 (2 篇)"),
    20000,
    "缺省 -d 时使用当前目录",
  );
  check("缺省 -d 时以当前目录为目标（识别到当前目录已有文档）", rendered, run.text().slice(-800));

  const exitCode = await stop(run);
  check("缺省 -d 运行正常退出", exitCode === 0, `exitCode=${exitCode}`);
}

// --- 用例 5：目录不存在 ---
{
  const missing = join(workspace, "no-such-dir");
  const run = spawnCli(["-d", missing], workspace);
  const exitCode = await Promise.race([
    run.exited,
    sleep(10000).then(() => "timeout" as const),
  ]);
  await run.done;

  check("目录不存在时退出码为 1", exitCode === 1, `exitCode=${String(exitCode)}`);
  check(
    "错误信息包含被拒绝的绝对路径",
    run.stderr().includes(missing),
    run.stderr().trim(),
  );
  check(
    "错误信息为单行提示（不打印堆栈）",
    run.stderr().trim().split("\n").length === 1,
    run.stderr().trim(),
  );
  check("目录无效时不进入 TUI", !run.raw().includes("\x1b[?1049h"));
}

// --- 用例 6：路径不是目录（文件） ---
{
  const run = spawnCli(["--dir", join(targetRepo, "main.ts")], workspace);
  const exitCode = await Promise.race([
    run.exited,
    sleep(10000).then(() => "timeout" as const),
  ]);
  await run.done;

  check("路径不是目录时退出码为 1", exitCode === 1, `exitCode=${String(exitCode)}`);
  check(
    "路径不是目录时给出同样的提示",
    run.stderr().includes("不是目录"),
    run.stderr().trim(),
  );
}

// ---------------------------------------------------------------------------
// 4) 清理
// ---------------------------------------------------------------------------

server.stop(true);
await rm(home, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
