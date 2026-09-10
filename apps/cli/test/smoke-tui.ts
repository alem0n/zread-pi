/**
 * smoke-tui.ts —— CLI 迁移到 pi-tui 后的离线回归
 *
 * 覆盖：
 * - 布局：项目信息框 / 介绍文字 / 页面内容的宽度与顺序
 * - 交互：↑↓ j k 选择、Enter 进入、ESC 返回与根页面退出、ctrl+c 退出、s 保存
 * - 页面：wiki 首页、配置首页、语言页、并发数页
 * - 输入框：数字输入 + Enter 写回配置
 *
 * 运行：bun run test:tui（无需真实 API Key / 网络）
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function checkContains(name: string, haystack: string, needle: string): void {
  check(name, haystack.includes(needle), `未找到: ${JSON.stringify(needle)}\n${indent(haystack)}`);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      | ${line}`)
    .join("\n");
}

const stripAnsi = (text: string): string => stripTerminalSequences(text);

const settle = async (ms = 40): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

// ---------------------------------------------------------------------------
// 1) 临时 HOME + 目标仓库（避免读写真实 ~/.zread）
// ---------------------------------------------------------------------------

const home = await mkdtemp(join(tmpdir(), "open-zread-tui-home-"));
const repo = await mkdtemp(join(tmpdir(), "open-zread-tui-repo-"));

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

// 预置 Provider 缓存（避免测试触发网络同步）；刻意多放一些 provider 以覆盖长列表分页
const extraProviders: Record<string, unknown> = {};
for (let i = 1; i <= 60; i++) {
  const id = `p-${String(i).padStart(2, "0")}`;
  extraProviders[id] = {
    id,
    name: `Provider ${i}`,
    npm: `npm-${i}`,
    base_url: "http://127.0.0.1:1/v1",
    models: { m1: { id: "m1", name: "M1", max_tokens: 4096 } },
  };
}

await writeFile(
  join(home, ".zread", "providers.json"),
  JSON.stringify({
    version: "test",
    synced_at: new Date().toISOString(),
    providers: {
      "openai-compatible": {
        id: "openai-compatible",
        name: "OpenAI Compatible",
        npm: "openai",
        base_url: "http://127.0.0.1:1/v1",
        models: {
          "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o Mini", max_tokens: 16384, supports_tools: true },
        },
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            max_tokens: 16384,
            supports_tools: true,
            supports_vision: true,
            supports_thinking: true,
          },
        },
      },
      ...extraProviders,
    },
  }),
  "utf-8",
);

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

const { App } = await import("../src/tui/app");
const { routes } = await import("../src/routes");
const { ProcessTerminal } = await import("@earendil-works/pi-tui");

// ---------------------------------------------------------------------------
// 2) 假终端（捕获输出 / 注入按键）
// ---------------------------------------------------------------------------

type InputHandler = (data: string) => void;

class FakeTerminal {
  columns = 100;
  rows = 40;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  private inputHandler?: InputHandler;

  start(onInput: InputHandler, _onResize: () => void): void {
    this.inputHandler = onInput;
  }

  stop(): void {
    this.inputHandler = undefined;
  }

  async drainInput(): Promise<void> {
    // 无需实现
  }

  write(data: string): void {
    this.writes.push(data);
  }

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

function createApp(initialEntries: string[]): { app: InstanceType<typeof App>; terminal: FakeTerminal; exits: () => number } {
  const terminal = new FakeTerminal();
  let exitCount = 0;
  const app = new App({
    routes,
    initialEntries,
    terminal: terminal as unknown as InstanceType<typeof ProcessTerminal>,
    onExit: () => {
      exitCount += 1;
    },
  });
  return { app, terminal, exits: () => exitCount };
}

function screenText(app: InstanceType<typeof App>, width = 100): string {
  return app.tui
    .render(width)
    .map((line) => stripAnsi(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// 3) 用例
// ---------------------------------------------------------------------------

console.log("▶ TUI 冒烟测试");

// --- 用例 1：wiki 首页布局 ---
{
  const { app, terminal } = createApp(["/wiki"]);
  await app.start();
  await settle();

  const raw = app.tui.render(100);
  const text = screenText(app);

  check("渲染行数 > 0", raw.length > 0);
  check(
    "第一行是圆角边框盒顶部（宽度对齐终端）",
    stripAnsi(raw[0]).startsWith("  ╭") && stripAnsi(raw[0]).endsWith("╮"),
    indent(stripAnsi(raw[0] ?? "")),
  );
  checkContains("标题行包含项目名与版本", text, "open-zread 0.0.0-dev");
  checkContains("标题行包含提供商", text, "提供商: openai-compatible");
  checkContains("标题行包含模型", text, "模型: gpt-4o-mini");
  checkContains("标题行包含 Base URL", text, "Base URL: http://127.0.0.1:1/v1");
  checkContains("标题行包含目录", text, "目录: ");
  checkContains("包含介绍文字", text, "将本地代码库转化为可读的 Wiki 文档。");
  checkContains("包含 github 链接", text, "开源项目: https://github.com/bb-boy680/open-zread");
  checkContains("无 wiki.json 时状态为「尚无文档目录」", text, "── 尚无文档目录 ─");
  checkContains("选项：生成文档", text, "生成文档");
  checkContains("选项：配置", text, "配置");
  checkContains("选项：退出", text, "退出");
  checkContains("Footer", text, "ESC 返回 | ↑↓ 选择 | Enter 确认");

  // 选择列表：默认选中第一项（生成文档）
  checkContains("默认选中项带 │ 指示条", text, "│ 生成文档");

  // j / ↓ 导航
  terminal.send("j");
  checkContains("按 j 后选中「配置」", screenText(app), "│ 配置");
  terminal.send("k");
  checkContains("按 k 回到「生成文档」", screenText(app), "│ 生成文档");

  terminal.send("\x1b[B");
  checkContains("按下箭头选中「配置」", screenText(app), "│ 配置");

  app.exit();
}

// --- 用例 2：导航到配置首页并进入语言页 ---
{
  const { app, terminal, exits } = createApp(["/wiki"]);
  await app.start();
  await settle();

  // ↓ 到「配置」→ Enter
  terminal.send("\x1b[B");
  terminal.send("\r");
  await settle();
  const configText = screenText(app);
  checkContains("进入配置首页：标题分割线", configText, "── Zread — 编辑配置 · ~/.zread/config.yaml ─");
  checkContains("配置项：界面语言", configText, "界面语言");
  checkContains("配置项：LLM 提供商", configText, "LLM 提供商");
  checkContains("配置项：最大并发数（含默认值）", configText, "最大并发数 (默认: 1)");
  checkContains("配置项：最大重试次数", configText, "最大重试次数 (默认: 0)");
  checkContains("配置项值：provider · model", configText, "openai-compatible · gpt-4o-mini");
  checkContains("配置首页 Footer", configText, "ESC 退出 | ↑↓ 选择 | Enter 确认 | s 保存");

  // Enter 进入「界面语言」
  terminal.send("\r");
  await settle();
  const languageText = screenText(app);
  checkContains("语言页：当前值", languageText, "当前: 中文");
  checkContains("语言页：选项", languageText, "❯ 中文");
  checkContains("语言页 Footer", languageText, "ESC 返回 | ↑↓ 选择 | Enter 确认并返回 | s 保存并返回");

  // ESC 返回配置首页
  terminal.send("\x1b");
  await settle();
  checkContains("ESC 返回配置首页", screenText(app), "── Zread — 编辑配置 · ~/.zread/config.yaml ─");
  check("返回后未退出应用", exits() === 0);

  app.exit();
}

// --- 用例 3：根页面 ESC 退出 / ctrl+c 退出 ---
{
  const { app, exits } = createApp(["/config"]);
  await app.start();
  await settle();
  app.tui.render(100);
  check("初始条目 key=default 且未退出", exits() === 0);

  app.tui.render(100);
  // 通过终端注入 ESC（等价真实按键路径）
  (app as unknown as { tui: { terminal: FakeTerminal } }).tui.terminal.send("\x1b");
  check("根页面按 ESC 退出", exits() === 1);
}

{
  const { app, terminal, exits } = createApp(["/wiki"]);
  await app.start();
  await settle();
  terminal.send("\x03");
  check("按 ctrl+c 退出", exits() === 1);
}

// --- 用例 4：数字输入页（并发数）---
{
  const { app, terminal } = createApp(["/config/concurrency"]);
  await app.start();
  await settle();

  const text = screenText(app);
  checkContains("并发页：当前值", text, "当前值: 3");
  checkContains("并发页：范围", text, "范围: 1-10");
  checkContains("并发页 Footer", text, "ESC 返回 | Enter 确认 | s 保存并返回");

  // 清空后输入 5 → Enter
  terminal.send("\x7f");
  terminal.send("5");
  terminal.send("\r");
  await settle();
  check(
    "Enter 写回配置 concurrency.max_concurrent=5",
    app.config.config.concurrency.max_concurrent === 5,
    `实际: ${app.config.config.concurrency.max_concurrent}`,
  );

  app.exit();
}

// --- 用例 5：config provider 列表（j/k 导航 + Enter 进入模型页）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle();

  const text = screenText(app);
  checkContains("Provider 页：自定义选项固定第一位", text, "自定义 Provider...");
  checkContains("Provider 页：本地缓存 provider", text, "OpenAI Compatible");
  checkContains("Provider 页：当前 provider 标记", text, "← 当前");
  checkContains("Provider 页 Footer", text, "↑↓ 导航 | enter 选择 | / 搜索 | r 刷新 | esc 返回");

  // 选中第一项（自定义 Provider）→ Enter → /config/provider/custom
  terminal.send("k");
  terminal.send("\r");
  await settle();
  const customText = screenText(app);
  checkContains("进入自定义 Provider 页：步骤", customText, "步骤 1/3");
  checkContains("自定义 Provider 页：Base URL 步骤", customText, "输入 Base URL");
  checkContains("自定义 Provider 页 Footer", customText, "enter 下一步 | esc 返回上一步");

  app.exit();
}

// --- 用例 6：Provider 搜索模式（/ 进入搜索，esc 退出）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle();

  terminal.send("/");
  await settle(10);
  let text = screenText(app);
  checkContains("按 / 进入搜索模式", text, "搜索: ");
  check("搜索模式显示结果数", /找到 \d+ 个结果/.test(text), indent(text));

  terminal.send("anth");
  await settle(10);
  text = screenText(app);
  checkContains("搜索输入可见", text, "搜索: anth");
  checkContains("搜索过滤生效（仅 Anthropic）", text, "找到 1 个结果");

  terminal.send("\x1b");
  await settle(10);
  text = screenText(app);
  checkContains("esc 退出搜索并恢复列表", text, "自定义 Provider...");
  check("退出搜索后未退出应用", true);

  app.exit();
}

// --- 用例 7：API Key 两步输入（API Key → Base URL）---
{
  const { app, terminal } = createApp(["/config/provider/openai-compatible/model/gpt-4o-mini"]);
  await app.start();
  await settle();

  let text = screenText(app);
  checkContains("API Key 步骤：预填充值可见", text, "API Key: sk-test");
  checkContains("API Key 步骤：提示下一步", text, "enter 下一步 | ESC 返回");

  terminal.send("\r");
  await settle(10);
  text = screenText(app);
  checkContains("进入 Base URL 步骤", text, "Base URL: http://127.0.0.1:1/v1");
  checkContains("Base URL 步骤：提示保存", text, "enter 保存 | esc 返回编辑 API Key");

  terminal.send("\x1b");
  await settle(10);
  checkContains("Base URL 步骤按 esc 回到 API Key 步骤", screenText(app), "enter 下一步 | ESC 返回");

  // 再次进入 Base URL 步骤并保存（写回配置字段）
  terminal.send("\r");
  await settle(10);
  terminal.send("\r");
  await settle(10);
  check(
    "保存后写回 llm.provider/model/api_key",
    app.config.config.llm.provider === "openai-compatible" &&
      app.config.config.llm.model === "gpt-4o-mini" &&
      app.config.config.llm.api_key === "sk-test",
    JSON.stringify(app.config.config.llm),
  );

  app.exit();
}

// --- 用例 8：长列表分页（窗口跟随选中项 + 位置指示 + PageUp/PageDown/Home/End）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle();

  // providers.json 里 62 个 provider + “自定义 Provider” = 63 项，终端 40 行装不下
  let text = screenText(app);
  check(
    "长列表：整页渲染不超过终端高度（不会把内容挤出屏幕）",
    app.tui.render(100).length <= terminal.rows,
    `lines=${app.tui.render(100).length} rows=${terminal.rows}`,
  );
  checkContains("长列表：位置指示出现", text, "(2/63)");
  checkContains("长列表：窗口内首项可见", text, "Provider 1 ");
  check("长列表：只渲染可视窗口（不含远端项）", !text.includes("Provider 60"), indent(text));

  // ↓ 30 次：选中项必须仍在可视窗口内
  for (let i = 0; i < 30; i++) terminal.send("\x1b[B");
  text = screenText(app);
  checkContains("滚动后选中项仍在可视区", text, "│ Provider 29 ");
  checkContains("滚动后位置指示更新", text, "(32/63)");

  // End：末项
  terminal.send("\x1b[F");
  text = screenText(app);
  checkContains("End 跳到末项", text, "│ Provider 60 ");
  checkContains("末项位置指示", text, "(63/63)");

  // Home：首项
  terminal.send("\x1b[H");
  text = screenText(app);
  checkContains("Home 跳到首项", text, "│ 自定义 Provider...");
  checkContains("首项位置指示", text, "(1/63)");

  // PageDown / PageUp：整页跳转
  const before = Number(/\((\d+)\/63\)/.exec(text)?.[1] ?? "0");
  terminal.send("\x1b[6~");
  const afterDown = Number(/\((\d+)\/63\)/.exec(screenText(app))?.[1] ?? "0");
  check("PageDown 整页向下跳转", afterDown - before >= 5, `${before} -> ${afterDown}`);
  terminal.send("\x1b[5~");
  const afterUp = Number(/\((\d+)\/63\)/.exec(screenText(app))?.[1] ?? "0");
  check("PageUp 整页向上跳转", afterDown - afterUp >= 5, `${afterDown} -> ${afterUp}`);

  app.exit();
}

// --- 用例 9：小终端时列表窗口自适应（不越界、选中项仍可见）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  terminal.rows = 20;
  await app.start();
  await settle();

  const lines = app.tui.render(100);
  check("小终端：渲染行数不超过终端高度", lines.length <= 20, `lines=${lines.length}`);
  const text = screenText(app);
  checkContains("小终端：选中项可见", text, "│ OpenAI Compatible");
  checkContains("小终端：仍可翻页", text, "(2/63)");

  // 缩小到 14 行：仍不应把选中项挤出屏幕
  terminal.rows = 14;
  (app.tui as unknown as { requestRender: (force?: boolean) => void }).requestRender(true);
  await settle(30);
  const small = app.tui.render(100);
  check("14 行终端：渲染行数可控", small.length <= 16, `lines=${small.length}`);
  checkContains("14 行终端：列表仍渲染选中项", screenText(app), "OpenAI Compatible");

  app.exit();
}

// --- 用例 10：wiki 生成页的文章列表分页（长列表）---
{
  const wikiDir = join(repo, ".open-zread", "wiki");
  const pages = [];
  for (let i = 1; i <= 40; i++) {
    pages.push({
      slug: `p-${i}`,
      title: `Article ${i}`,
      file: `a-${i}.md`,
      section: "S",
      level: "Beginner",
      associatedFiles: [],
    });
  }
  await mkdir(join(wikiDir, "S"), { recursive: true });
  await writeFile(
    join(wikiDir, "wiki.json"),
    JSON.stringify({ id: "w", generated_at: new Date().toISOString(), language: "zh", pages }),
    "utf-8",
  );
  for (const page of pages) {
    await writeFile(join(wikiDir, page.section, page.file), `# ${page.title}\n`, "utf-8");
  }

  const { app, terminal } = createApp(["/wiki/generate?mode=manage"]);
  await app.start();
  await settle(80);

  let text = screenText(app);
  check(
    "文章列表分页：整页渲染不超过终端高度",
    app.tui.render(100).length <= terminal.rows,
    `lines=${app.tui.render(100).length} rows=${terminal.rows}`,
  );
  checkContains("文章列表分页：位置指示", text, "(1/40)");
  checkContains("文章列表分页：首项可见", text, "Article 1");
  check("文章列表分页：不渲染窗口外的项", !text.includes("Article 40"), indent(text));

  // End：跳到末项
  terminal.send("\x1b[F");
  await settle(20);
  text = screenText(app);
  checkContains("文章列表：End 后末项可见", text, "Article 40");
  checkContains("文章列表：末项位置指示", text, "(40/40)");

  // 末项会被重新生成（r 为选中项重新生成）——仅校验按键不被分页吞掉
  app.exit();
}

// --- 用例 11：console 接管（TUI 期间不往终端写东西）---
{
  const { captureConsoleToLog } = await import("../src/tui/console-guard");
  const { getLogFile } = await import("@open-zread/utils");
  const { readFile } = await import("node:fs/promises");

  const restore = captureConsoleToLog();
  console.error("guard-probe-error-31337");
  console.log("guard-probe-log-31338");
  restore();

  const log = await readFile(getLogFile(), "utf-8");
  checkContains("console.error 被转存到日志", log, "guard-probe-error-31337");
  checkContains("console.log 被转存到日志", log, "guard-probe-log-31338");
  check("接管后 console.error 不再直接可用（已还原）", typeof console.error === "function");
}

// ---------------------------------------------------------------------------
// 4) 收尾
// ---------------------------------------------------------------------------

process.chdir(join(home, ".."));
await rm(home, { recursive: true, force: true });
await rm(repo, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
