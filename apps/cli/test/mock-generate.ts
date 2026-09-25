/**
 * mock-generate.ts —— Wiki 生成页的离线端到端回归（mock LLM，无需 API Key）
 *
 * 覆盖迁移后的 WikiGenerateController：扫描 → 解析 → 缓存 → 结构层（代码）
 * → 分类命名 → 页面命名 → reload wiki.json → 检测缺失页面 → 并发生成页面（write_page）
 * → UI 显示完成。
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

function checkContains(name: string, haystack: string, needle: string): void {
  check(name, haystack.includes(needle), `未找到: ${JSON.stringify(needle)}`);
}

// ---------------------------------------------------------------------------
// 1) mock LLM（OpenAI 兼容 SSE）
// ---------------------------------------------------------------------------

const BASE_SECTION_IDS = ["overview", "core"];
const NAMED_SUFFIX = "（命名）";

/** 提取 OpenAI 兼容消息里的纯文本（user 消息是 content 数组） */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/** 从提示词里抠出第一个 json fence 的 payload（机器骨架） */
function parseJsonFence(text: string, key: string): unknown[] {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match) return [];
  try {
    const payload = JSON.parse(match[1]) as Record<string, unknown>;
    const value = payload[key];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

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
  return chunk(baseChunk({ role: "assistant", content: text }, null)) + chunk(baseChunk({}, "stop"));
}

const usageChunk = JSON.stringify({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "mock-model",
  choices: [],
  // 120 prompt = 60 非缓存输入 + 60 缓存读 → 用于验证底部合计行的缓存占比：
  // 目录（结构层无 Agent；分类命名 1 个 + 页面命名 4 个，各 2 次请求 = 10）
  // + 4 个页面 Agent × 2 = 8，首轮共 18 次请求：合计输入侧 2160（2.2k）、输出 540、缓存占比 50.0%；
  // 重新生成一页再 +2 次请求 → 输入侧 2400（2.4k）、输出 600。
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 60 },
  },
});

let requestCount = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requestCount += 1;
    const body = (await request.json()) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const messages = body.messages ?? [];
    const prompt = JSON.stringify(messages.map((message) => message.content ?? ""));
    const promptText = messages.map((message) => contentToText(message.content)).join("\n");
    const hasToolResult = messages.some((message) => message.role === "tool");
    const isPageAgent = prompt.includes("当前页面任务");
    const toolNames = new Set(
      (body.tools ?? [])
        .map((tool) => tool?.function?.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const section = /^- 分类：(.+)$/m.exec(promptText)?.[1]?.trim() ?? "";

    // 命名 Agent 稍作延迟，让测试能稳定观察到阶段文案（阶段切换很快）
    if (!hasToolResult && (toolNames.has("submit_sections") || toolNames.has("submit_pages"))) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string): void => controller.enqueue(encoder.encode(text));
        if (!hasToolResult) {
          if (toolNames.has("submit_sections")) {
            // 分类命名：从机器清单原样回填（基础分类只补 scope）
            const machineSections = parseJsonFence(promptText, "machineSections");
            write(
              toolCall("call_sections", "submit_sections", {
                sections: machineSections.map((entry) => {
                  const item = entry as { id: string; title: string };
                  const isBase = BASE_SECTION_IDS.includes(item.id);
                  return {
                    id: item.id,
                    ...(isBase
                      ? {}
                      : { title: `${item.title}${NAMED_SUFFIX}`, description: `${item.title} 的命名说明` }),
                    scope: [`包含：${item.title} 的能力域`, "不包含：相邻分类"],
                  };
                }),
              }),
            );
          } else if (toolNames.has("submit_pages")) {
            // 页面命名：从机器清单原样回填（title / summary / level）
            const machinePages = parseJsonFence(promptText, "machinePages");
            write(
              toolCall(`call_pages_${section}`, "submit_pages", {
                section,
                pages: machinePages.map((entry) => {
                  const item = entry as { id: string; label: string };
                  return {
                    id: item.id,
                    title: `${item.label}${NAMED_SUFFIX}`,
                    summary: `${item.label} 的页面摘要`,
                    level: "Intermediate",
                  };
                }),
              }),
            );
          } else if (isPageAgent || toolNames.has("write_page")) {
            const slug = /\*\*Slug\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? "page";
            const file = /\*\*文件名\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? `${slug}.md`;
            const title = /\*\*标题\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? slug;
            const pageSection = /\*\*章节\*\*: ([^\\]+)/.exec(prompt)?.[1]?.trim() ?? "";
            write(
              toolCall(`call_${slug}`, "write_page", {
                slug,
                file,
                section: pageSection,
                title,
                content: [
                  `# ${title}`,
                  "",
                  "> 由 mock LLM 生成（离线试跑）。",
                  "",
                  `**图｜架构图｜${title} 的模块关系**：核心模块与依赖`,
                  "",
                  "```mermaid",
                  "flowchart TB",
                  `  A["${title}"] --> B["测试通过"]`,
                  "```",
                  "",
                ].join("\n"),
              }),
            );
          } else {
            write(textChunk("完成"));
          }
        } else {
          write(textChunk(isPageAgent ? "页面完成" : "阶段完成"));
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
  console.error(`  ! 超时未满足条件：${label}（requests=${requestCount}）`);
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
const catalogSamples: string[] = [];
const stageSampler = setInterval(() => catalogSamples.push(screenText()), 20);
terminal.send("\r");
await sleep(100);
check("进入生成页并开始扫描", screenText().includes("── 目录 ─"));

const catalogDone = await waitFor(
  () => /文章 \d+\/\d+/.test(screenText()),
  20000,
  "目录完成并显示文章列表",
);
clearInterval(stageSampler);
check("目录完成后展示文章列表", catalogDone);

// 结构优先进度文案（结构切分 / 命名分类 / 命名页面 x/y）必须在生成页真实渲染过
// 结构阶段是纯代码（毫秒级），只断言其 Agent 行标签出现过
check(
  "生成页渲染结构优先进度文案（结构切分 / 命名分类 / 命名页面）",
  catalogSamples.some((text) => text.includes("结构切分")) &&
    catalogSamples.some((text) => text.includes("命名分类中")) &&
    catalogSamples.some((text) => /命名页面 \d+\/\d+/.test(text)),
  catalogSamples
    .filter((text) => text.includes("结构切分") || /命名页面 \d+\/\d+/.test(text))
    .slice(0, 3)
    .join(" || "),
);

// 目录按 Agent 分类显示：结构切分 / 命名分类 / 每个分类的命名页面各一行（生成中就能看到）
check(
  "目录按 Agent 分类显示（命名分类 / 命名页面 · 各一行）",
  catalogSamples.some((text) => text.includes("命名页面 · ")),
  catalogSamples
    .find((text) => text.includes("命名页面 · "))
    ?.split("\n")
    .filter((line) => line.includes(" · "))
    .slice(0, 3)
    .join(" || "),
);
check(
  "目录 Agent 行渲染四个状态指标（输入/输出/缓存占比/上下文占比）",
  catalogSamples.some(
    (text) => text.includes("缓存占比") && text.includes("上下文 ") && /↑\d/.test(text) && /↓\d/.test(text),
  ),
  catalogSamples.find((text) => text.includes("上下文 "))?.split("\n").find((line) => line.includes("上下文 ")) ?? "(无)",
);

// 机器切分：2 个源文件 → 2 个结构分类 + 2 个基础分类 = 4 页
const PAGE_COUNT = 4;
const allDone = await waitFor(() => screenText().includes(`文章 ${PAGE_COUNT}/${PAGE_COUNT}`), 60000, "全部页面生成完成");
check(`四篇文章全部完成（文章 ${PAGE_COUNT}/${PAGE_COUNT}）`, allDone);

// 已完成的目录 Agent 行也要继续显示指标（[完成] 右侧：↑ / ↓ / 缓存占比 / 上下文占比）
const catalogAgentLines = screenText()
  .split("\n")
  .filter((line) => line.includes("命名分类") || line.includes("命名页面 · ") || line.includes("结构切分"));
check(
  "完成后目录 Agent 行仍显示四个指标（[完成] 右侧）",
  catalogAgentLines.some(
    (line) =>
      line.includes("[完成]") && /↑\d/.test(line) && /↓\d/.test(line) && line.includes("缓存占比") && line.includes("上下文 "),
  ),
  catalogAgentLines.slice(0, 3).join("\n      ") || "(无)",
);

// 已完成/失败的文章行也要继续显示指标
const articleLines = screenText().split("\n").filter((line) => line.includes("[完成]"));
check(
  "完成后文章行也显示四个指标（[完成] 右侧）",
  articleLines.some((line) => line.includes("缓存占比") && line.includes("上下文 ")),
  articleLines[0] ?? "(无)",
);

// 底部合计行：目录（结构层无 Agent；分类命名 1 + 页面命名 4，各 2 次请求 = 10）
// + 4 个页面 Agent × 2 = 8，共 18 次请求；单次请求 60 非缓存输入 + 60 缓存读 + 30 输出
// → 合计输入侧 2160（2.2k）、输出 540、缓存占比 50.0%
const totalsText = screenText();
checkContains("底部显示用量合计（输入 token）", totalsText, "合计 输入 2.2k");
checkContains("底部显示用量合计（输出 token）", totalsText, "输出 540");
checkContains("底部显示缓存占比", totalsText, "缓存占比 50.0%");
check(
  "用量合计行是页面的最后一行",
  totalsText.trimEnd().split("\n").at(-1)?.trim() === "合计 输入 2.2k · 输出 540 · 缓存占比 50.0%",
  totalsText.trimEnd().split("\n").at(-1) ?? "(空)",
);

// 重新生成一页（r）：合计必须继续累加（成功 + 失败 + 重试），
// 不能把该页已消耗的 240 清零（底部合计输入侧 2160 -> 2400，输出 540 -> 600）
terminal.send("\x1b[B"); // 先移动选中项（onHighlight 才会记录 slug）
await sleep(20);
terminal.send("r");
const regenerated = await waitFor(() => screenText().includes("合计 输入 2.4k"), 60000, "重新生成后合计继续累加");
check("重新生成一页后合计继续累加（2160 + 240 = 2400）", regenerated);
const retryText = screenText();
checkContains("重新生成后输出 token 累加（540→600）", retryText, "输出 600");
checkContains("重新生成后缓存占比保持", retryText, "缓存占比 50.0%");
check(
  "重新生成后合计行同步刷新",
  retryText.trimEnd().split("\n").at(-1)?.trim() === "合计 输入 2.4k · 输出 600 · 缓存占比 50.0%",
  retryText.trimEnd().split("\n").at(-1) ?? "(空)",
);

const wikiJsonPath = join(repo, ".zread-pi", "wiki", "high", "wiki.json");
const wikiJsonExists = await stat(wikiJsonPath).then(
  () => true,
  () => false,
);
check("wiki.json 已落盘", wikiJsonExists);

if (wikiJsonExists) {
  const catalog = JSON.parse(await readFile(wikiJsonPath, "utf-8")) as {
    sections?: Array<{ title: string }>;
    pages: Array<{ slug: string; file: string; section: string }>;
  };
  check("wiki.json 含 4 个页面", catalog.pages.length === PAGE_COUNT, `实际 ${catalog.pages.length}`);
  check(
    "wiki.json 含基础分类与结构分类",
    (catalog.sections?.length ?? 0) >= 4,
    JSON.stringify(catalog.sections?.map((section) => section.title)),
  );
  check(
    "页面 slug 由代码分配（数字前缀）",
    catalog.pages.every((page) => /^\d+-/.test(page.slug)),
    JSON.stringify(catalog.pages.map((page) => page.slug)),
  );

  for (const page of catalog.pages) {
    const file = join(repo, ".zread-pi", "wiki", "high", page.section, page.file);
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
  () => screenText().includes(`文档已生成 (${PAGE_COUNT} 篇)`),
  10000,
  "wiki 首页显示已完成状态",
);
check(`返回首页后状态为「文档已生成 (${PAGE_COUNT} 篇)」`, homeUpdated);
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
const backHome = await waitFor(() => screenText().includes(`文档已生成 (${PAGE_COUNT} 篇)`), 10000, "ESC 返回首页");
check("同步页 ESC 返回首页", backHome);

app.exit();
server.stop(true);
process.chdir(join(home, ".."));
await rm(home, { recursive: true, force: true });
await rm(repo, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
