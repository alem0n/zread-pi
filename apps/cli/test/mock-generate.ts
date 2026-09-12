/**
 * mock-generate.ts —— Wiki 生成页的离线端到端回归（mock LLM，无需 API Key）
 *
 * 覆盖迁移后新写的 WikiGenerateController：
 * 扫描 → 解析 → 缓存 → 生成目录（generate_blueprint） → reload wiki.json
 * → 检测缺失页面 → 并发生成页面（write_page） → UI 显示完成
 *
 * 运行：bun run test:tui（或单独 bun run apps/cli/test/mock-generate.ts）
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 断言工具
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

// ---------------------------------------------------------------------------
// 1) mock LLM（OpenAI 兼容 SSE）
// ---------------------------------------------------------------------------

const PAGES = [
  {
    slug: "1-overview",
    title: "概览",
    file: "1-overview.md",
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
    associatedFiles: ["utils.ts"],
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
    chunk(baseChunk({ role: "assistant", content: text }, null)) +
    chunk(baseChunk({}, "stop"))
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
                  "> 由 mock LLM 生成（离线试跑）。",
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
// 2) 临时 HOME + 目标仓库
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "zread-pi-tui-gen-home-"));
const repo = await mkdtemp(join(tmpdir(), "zread-pi-tui-gen-repo-"));

await mkdir(join(home, ".zread-pi"), { recursive: true });
await writeFile(
  join(home, ".zread-pi", "config.yaml"),
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

await writeFile(join(repo, "main.ts"), 'export const hello = (): string => "hello";\n', "utf-8");
await writeFile(
  join(repo, "utils.ts"),
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { App } = await import("../src/tui/app");
const { routes } = await import("../src/routes");

// ---------------------------------------------------------------------------
// 3) 假终端 + 应用
// ---------------------------------------------------------------------------

type InputHandler = (data: string) => void;

class FakeTerminal {
  columns = 100;
  rows = 40;
  kittyProtocolActive = false;
  private inputHandler?: InputHandler;

  start(onInput: InputHandler): void {
    this.inputHandler = onInput;
  }
  stop(): void {
    this.inputHandler = undefined;
  }
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  send(data: string): void {
    this.inputHandler?.(data);
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

const terminal = new FakeTerminal();
const app = new App({
  routes,
  initialEntries: ["/wiki"],
  terminal: terminal as never,
  onExit: () => {},
});

const screenText = (): string =>
  app.tui
    .render(100)
    .map((line) => stripTerminalSequences(line))
    .join("\n");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(100);
  }
  console.error(`  ! 超时未满足条件：${label}`);
  console.error(
    screenText()
      .split("\n")
      .map((line) => `      | ${line}`)
      .join("\n"),
  );
  return false;
}

// ---------------------------------------------------------------------------
// 4) 用例
// ---------------------------------------------------------------------------

console.log("▶ Wiki 生成页端到端（mock LLM）");

await app.start();
await sleep(50);
check("wiki 首页渲染", screenText().includes("尚无文档目录"));

// 选中「生成文档」（第一项）→ Enter
terminal.send("\r");
await sleep(100);
check("进入生成页并开始扫描", screenText().includes("── 目录 ─"));

const catalogDone = await waitFor(
  () => /文章 \d+\/\d+/.test(screenText()),
  20000,
  "目录完成并显示文章列表",
);
check("目录完成后展示文章列表", catalogDone);

const allDone = await waitFor(() => screenText().includes("文章 2/2"), 30000, "全部页面生成完成");
check("两篇文章全部完成（文章 2/2）", allDone);

const wikiJsonPath = join(repo, ".zread-pi", "wiki", "wiki.json");
const wikiJsonExists = await stat(wikiJsonPath).then(
  () => true,
  () => false,
);
check("wiki.json 已落盘", wikiJsonExists);

if (wikiJsonExists) {
  const catalog = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as {
    pages: Array<{ file: string; section: string }>;
  };
  check("wiki.json 含 2 个页面", catalog.pages.length === 2, `实际 ${catalog.pages.length}`);

  for (const page of PAGES) {
    const file = join(repo, ".zread-pi", "wiki", page.section, page.file);
    const exists = await stat(file).then(
      () => true,
      () => false,
    );
    check(`页面文件已生成：${page.section}/${page.file}`, exists);
  }
}

check("发生了真实的 mock LLM 请求", requestCount >= 4, `requests=${requestCount}`);

// 全局记忆：开始生成文档时把项目路径写入 <项目家目录>/history（重复生成去重）
{
  const { readHistory } = await import("@zread-pi/utils");
  const history = await readHistory();
  const canonical = async (path: string): Promise<string> =>
    realpath(path)
      .then((resolved) => (process.platform === "win32" ? resolved.toLowerCase() : resolved))
      .catch(() => (process.platform === "win32" ? path.toLowerCase() : path));
  const repoReal = await canonical(repo);
  const matches: string[] = [];
  for (const record of history) {
    if ((await canonical(record.path)) === repoReal) matches.push(record.path);
  }
  check("开始生成文档时写入全局记忆", matches.length === 1, JSON.stringify(history));
  check("重复生成（蓝图 + 页面）只保留一条记忆", history.length === 1, JSON.stringify(history));
}

// 返回 wiki 首页：应识别出已生成完成（进度检查 + 选项重建）
terminal.send("\x1b");
const homeUpdated = await waitFor(
  () => screenText().includes("文档已生成 (2 篇)"),
  10000,
  "wiki 首页显示已完成状态",
);
check("返回首页后状态为「文档已生成 (2 篇)」", homeUpdated);
const homeText = screenText();
check("已完成时提供「浏览文档」", homeText.includes("浏览文档"));
check("已完成时提供「管理文档」", homeText.includes("管理文档"));
check("已完成时提供「同步文档」", homeText.includes("同步文档"));
check("已完成时仍提供「强制重新生成」", homeText.includes("强制重新生成"));
check("已完成时不再提供「生成文档」", !homeText.includes("│ 生成文档"));

// 进入同步页：文件未变更时应直接显示「无变更」
terminal.send("\x1b[B");
terminal.send("\r");
await sleep(100);
check("进入同步页", screenText().includes("── 目录 ─"));
const syncDone = await waitFor(
  () => screenText().includes("无变更"),
  15000,
  "同步检测完成且无变更",
);
check("未变更时同步页显示「无变更」", syncDone);
check("同步页目录状态为完成", screenText().includes("[完成]"));

// ESC 返回首页
terminal.send("\x1b");
const backHome = await waitFor(() => screenText().includes("文档已生成 (2 篇)"), 10000, "ESC 返回首页");
check("同步页 ESC 返回首页", backHome);

app.exit();
server.stop(true);
process.chdir(join(home, ".."));
await rm(home, { recursive: true, force: true });
await rm(repo, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
