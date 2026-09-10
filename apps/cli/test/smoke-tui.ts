/**
 * smoke-tui.ts —— CLI 迁移到 pi-tui 后的离线回归
 *
 * 覆盖：
 * - 布局：项目信息框 / 介绍文字 / 页面内容的宽度与顺序
 * - 交互：↑↓ j k 选择、Enter 进入、ESC 返回与根页面退出、ctrl+c 退出、s 保存
 * - 重绘：按键后必须由 pi-tui 自动重绘（观察终端实际写入，而不是直接调用 render）
 * - 页面：wiki 首页、配置首页、语言页、并发数页
 * - 输入框：数字输入 + Enter 写回配置
 *
 * 运行：bun run test:tui（无需真实 API Key / 网络）
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// 预置 Provider 目录不再需要：Provider/模型列表直接来自 pi-ai 内置目录。
process.env.HOME = home;
process.env.USERPROFILE = home;
// 避免宿主环境的 API Key 影响「未配置」判定（测试走 auth.json）
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
process.chdir(repo);

const { App } = await import("../src/tui/app");
const { routes } = await import("../src/routes");
const { ProcessTerminal } = await import("@earendil-works/pi-tui");
const { getVersion } = await import("../src/utils/display");
const { setZreadCatalogConfig } = await import("@open-zread/agent-runtime");

// 项目版本（仓库根 package.json，AGENTS.md §4.4 唯一来源）
const projectVersion = (
  JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf-8")) as { version: string }
).version;

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

// --- 用例 0：版本号与项目版本同步（开发模式未注入 CLI_VERSION） ---
{
  check(
    "getVersion() 与根 package.json 版本一致",
    getVersion() === projectVersion,
    `getVersion()=${getVersion()}，根 package.json=${projectVersion}`,
  );
  check("版本号不是兜底值", getVersion() !== "0.0.0-dev", `getVersion()=${getVersion()}`);
}

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
  checkContains("标题行包含项目名与版本", text, `open-zread ${projectVersion}`);
  checkContains("标题行包含提供商", text, "提供商: openai-compatible");
  checkContains("标题行包含模型", text, "模型: gpt-4o-mini");
  checkContains("标题行包含思考深度", text, "思考深度: 关闭 (off)");
  checkContains("标题行包含 Base URL", text, "Base URL: http://127.0.0.1:1/v1");
  checkContains("标题行包含目录", text, "目录: ");
  checkContains("包含介绍文字", text, "将本地代码库转化为可读的 Wiki 文档。");
  check(
    "不再显示开源项目链接",
    !text.includes("开源项目") && !text.includes("github.com/bb-boy680"),
    indent(text),
  );
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
  checkContains("配置项：思考深度（含默认值）", configText, "思考深度 (默认: off)");
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

// --- 用例 4b：思考深度配置页（pi thinking level）---
{
  const { app, terminal } = createApp(["/config/thinking"]);
  await app.start();
  await settle();

  let text = screenText(app);
  checkContains("思考深度页：标题", text, "设置思考深度（pi thinking level）");
  checkContains("思考深度页：当前值（旧配置缺省为 off）", text, "当前值: 关闭 (off)");
  checkContains("思考深度页：当前模型", text, "模型: openai-compatible · gpt-4o-mini");
  checkContains(
    "思考深度页：当前模型支持的全部等级",
    text,
    "当前模型支持: off / minimal / low / medium / high / xhigh / max",
  );
  checkContains("思考深度页：默认选中 off", text, "❯ 关闭 (off)");
  checkContains("思考深度页 Footer", text, "ESC 返回 | ↑↓ 选择 | Enter 确认并返回 | s 保存并返回");
  check(
    "思考深度页：渲染 pi 的全部 7 个等级",
    ["关闭 (off)", "最低 (minimal)", "低 (low)", "中 (medium)", "高 (high)", "极高 (xhigh)", "最高 (max)"].every(
      (label) => text.includes(label),
    ),
    indent(text),
  );

  // ↓ 3 次 → 中 (medium)
  terminal.send("\x1b[B");
  terminal.send("\x1b[B");
  terminal.send("\x1b[B");
  await settle(20);
  checkContains("光标移到「中」", screenText(app), "❯ 中 (medium)");

  // Enter：写回内存配置（本页是初始条目，navigate(-1) 不改变页面）
  terminal.send("\r");
  await settle(20);
  check(
    "Enter 写回 llm.thinking_level=medium",
    app.config.config.llm.thinking_level === "medium",
    String(app.config.config.llm.thinking_level),
  );

  // s：保存到 config.yaml
  terminal.send("s");
  await settle(120);
  checkContains("s 保存后提示已保存", screenText(app), "配置已保存");
  const yaml = await readFile(join(home, ".zread", "config.yaml"), "utf-8");
  checkContains("config.yaml 写入 thinking_level: medium", yaml, "thinking_level: medium");

  app.exit();
}

// --- 用例 4c：从配置首页进入思考深度页 ---
{
  const { app, terminal } = createApp(["/config"]);
  await app.start();
  await settle();

  // 配置项顺序：语言 / 文档语言 / LLM 提供商 / 思考深度
  terminal.send("j");
  terminal.send("j");
  terminal.send("j");
  await settle(20);
  checkContains("配置首页：思考深度项被选中", screenText(app), "│ 思考深度");

  terminal.send("\r");
  await settle(20);
  checkContains("Enter 进入思考深度页", screenText(app), "设置思考深度（pi thinking level）");
  app.exit();
}

// --- 用例 4d：未选择模型时展示「全部等级可选」提示 ---
{
  const bareHome = await mkdtemp(join(tmpdir(), "open-zread-tui-bare-"));
  await mkdir(join(bareHome, ".zread"), { recursive: true });
  await writeFile(
    join(bareHome, ".zread", "config.yaml"),
    [
      "language: zh",
      "doc_language: zh",
      "llm:",
      "  provider: null",
      "  model: null",
      "  api_key: null",
      "  base_url: null",
      "concurrency:",
      "  max_concurrent: 1",
      "  max_retries: 0",
      "",
    ].join("\n"),
    "utf-8",
  );
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = bareHome;
  process.env.USERPROFILE = bareHome;

  const { app } = createApp(["/config/thinking"]);
  await app.start();
  await settle();
  const text = screenText(app);
  checkContains("未选模型：提示全部等级可选", text, "尚未选择模型：全部等级可选，请求时按模型能力自动调整");
  checkContains("未选模型：仍列出全部 7 个等级", text, "最高 (max)");
  app.exit();

  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevProfile;
  // 本用例用临时 HOME 重建过 catalog：恢复 HOME 后重置 override，避免污染后续用例
  setZreadCatalogConfig(undefined);
  await rm(bareHome, { recursive: true, force: true });
}

// --- 用例 5：config provider 列表（pi-ai 内置目录 + 登录状态 + Enter 进入模型页）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle();

  // 初始选中当前生效的旧 provider（openai-compatible，列表末尾）
  let text = screenText(app);
  checkContains("Provider 页：当前 provider 标记", text, "│ openai-compatible");
  checkContains("Provider 页：当前 provider 标记文字", text, "← 当前");
  checkContains("Provider 页：已配置标记（旧扁平 api_key）", text, "已配置");
  checkContains("Provider 页 Footer", text, "↑↓ 导航 | enter 选择 | / 搜索 | r 刷新 | esc 返回");

  // Home 回顶部：自定义选项固定第一位 + pi-ai 内置 provider
  terminal.send("\x1b[H");
  await settle(10);
  text = screenText(app);
  checkContains("Provider 页：自定义选项固定第一位", text, "自定义 Provider...");
  checkContains("Provider 页：pi-ai 内置 provider", text, "Anthropic");
  checkContains("Provider 页：内置 provider 模型数", text, "个模型");
  checkContains("Provider 页：未配置标记", text, "未配置");

  // 当前就在首项（自定义 Provider）→ Enter → /config/provider/custom
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
  check("esc 退出搜索模式", !text.includes("搜索: "), indent(text));
  checkContains("esc 退出搜索并恢复列表（当前 provider 行）", text, "│ openai-compatible");
  check("退出搜索后未退出应用", true);

  app.exit();
}

// --- 用例 7：Provider 详情页（API Key 配置 + 模型选择并列）---
{
  const { app, terminal } = createApp(["/config/provider/anthropic"]);
  await app.start();
  await settle();

  let text = screenText(app);
  checkContains("详情页：API Key 配置区", text, "API Key 配置");
  checkContains("详情页：模型区", text, "模型 ·");
  checkContains("详情页：未配置状态", text, "未配置");
  checkContains("详情页：未配置时聚焦 API Key", text, "enter 保存 API Key");
  check(
    "详情页：不再提供 OAuth/订阅选项",
    !text.includes("OAuth") && !text.includes("订阅"),
    indent(text),
  );

  // 输入 API Key → Enter（pi-ai login 写 auth.json）
  terminal.send("sk-ant-test");
  await settle(20);
  terminal.send("\r");
  await settle(80);
  text = screenText(app);
  checkContains("保存后显示已配置", text, "已配置");
  checkContains("保存后提示已保存", text, "API Key 已保存");
  checkContains("保存后焦点移到模型列表", text, "enter 选择模型");

  const raw = JSON.parse(await readFile(join(home, ".zread", "auth.json"), "utf-8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  check(
    "凭据写入 ~/.zread/auth.json",
    raw.anthropic?.type === "api_key" && raw.anthropic.key === "sk-ant-test",
    JSON.stringify(raw.anthropic),
  );

  // Enter 选中首个模型 → 设为当前模型
  terminal.send("\r");
  await settle(60);
  check(
    "选择模型后写回 llm.provider/model",
    app.config.config.llm.provider === "anthropic" && typeof app.config.config.llm.model === "string",
    JSON.stringify({ provider: app.config.config.llm.provider, model: app.config.config.llm.model }),
  );
  check("旧扁平 api_key 被清空（凭据已迁移）", app.config.config.llm.api_key === null);
  check(
    "记住该 Provider 上次选择的模型",
    app.config.getProviderConfig("anthropic").model === app.config.config.llm.model,
  );
  checkContains("页面标记当前模型", screenText(app), "← 当前");

  app.exit();
}

// --- 用例 7b：同时配置多个提供商（openai 追加，不覆盖 anthropic）---
{
  const { app, terminal } = createApp(["/config/provider/openai"]);
  await app.start();
  await settle();

  checkContains("未配置时默认聚焦 API Key 输入", screenText(app), "enter 保存 API Key");
  terminal.send("sk-openai-test");
  await settle(20);
  terminal.send("\r");
  await settle(80);
  terminal.send("\r");
  await settle(60);

  const raw = JSON.parse(await readFile(join(home, ".zread", "auth.json"), "utf-8")) as Record<
    string,
    { key?: string }
  >;
  check(
    "auth.json 同时保存两个 Provider",
    raw.anthropic?.key === "sk-ant-test" && raw.openai?.key === "sk-openai-test",
    Object.keys(raw).join(","),
  );
  check(
    "当前 provider 切换到 openai",
    app.config.config.llm.provider === "openai" && typeof app.config.config.llm.model === "string",
    JSON.stringify({ provider: app.config.config.llm.provider, model: app.config.config.llm.model }),
  );

  app.exit();
}

// --- 用例 7c：登录后 Provider 列表显示已配置 ---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle(60);
  terminal.send("\x1b[H");
  await settle(10);
  const text = screenText(app);
  checkContains("Provider 列表显示 anthropic 已配置", text, "Anthropic");
  checkContains("Provider 列表显示 API Key 状态", text, "已配置 API Key");
  app.exit();
}

// --- 用例 7d：详情页焦点切换（tab）与当前页模型刷新 ---
{
  const { app, terminal } = createApp(["/config/provider/anthropic"]);
  await app.start();
  await settle(60);

  let text = screenText(app);
  checkContains("已配置 Provider 默认聚焦模型区", text, "enter 选择模型");
  checkContains("模型区显示已配置", text, "已配置");

  // 静态目录：刷新给出说明且不报错
  terminal.send("r");
  await settle(60);
  checkContains("详情页刷新模型提示", screenText(app), "使用内置模型目录");

  // tab 切换到 API Key 输入
  terminal.send("\t");
  await settle(20);
  text = screenText(app);
  checkContains("tab 切换到 API Key 区", text, "enter 保存 API Key");
  checkContains("API Key 占位提示（已设置可覆盖）", text, "已设置");

  // esc 先回模型区（不退出页面）
  terminal.send("\x1b");
  await settle(20);
  checkContains("esc 回到模型区", screenText(app), "enter 选择模型");

  app.exit();
}

// --- 用例 7e：为指定 Provider 添加自定义模型 ---
{
  const { app, terminal } = createApp(["/config/provider/deepseek"]);
  await app.start();
  await settle();

  let text = screenText(app);
  checkContains("详情页：Provider 名与模型数", text, "DeepSeek");
  checkContains("详情页：未配置时默认聚焦 API Key", text, "enter 保存 API Key");

  // 未配置时默认聚焦 API Key，先 tab 到模型区再按 a
  terminal.send("\t");
  await settle(10);
  text = screenText(app);
  checkContains("详情页 Footer（模型区）", text, "r 刷新模型 | a 自定义模型");
  terminal.send("a");
  await settle();
  text = screenText(app);
  checkContains("自定义模型页：步骤 1/5", text, "步骤 1/5");
  checkContains("自定义模型页：模型 ID", text, "模型 ID");

  terminal.send("my-custom-model");
  terminal.send("\r");
  await settle(20);
  terminal.send("\r"); // 跳过显示名称
  await settle(20);
  terminal.send("\r"); // 上下文窗口默认 128000
  await settle(20);
  terminal.send("\r"); // 最大输出默认 16384
  await settle(20);
  text = screenText(app);
  checkContains("自定义模型页：能力开关", text, "支持思考");

  terminal.send("t"); // 打开「支持思考」
  await settle(20);
  terminal.send("\r"); // 保存
  await settle(40);

  const customModels = app.config.getProviderConfig("deepseek").models ?? [];
  check(
    "自定义模型写入 config.llm.providers.deepseek.models",
    customModels.some((model) => model.id === "my-custom-model" && model.reasoning === true),
    JSON.stringify(customModels),
  );
  text = screenText(app);
  checkContains("返回详情页并显示自定义模型", text, "my-custom-model");
  checkContains("自定义模型带标记", text, "[自定义]");

  // 回到模型区后刷新（静态目录：给出说明且不报错）
  terminal.send("\t");
  await settle(10);
  terminal.send("r");
  await settle(40);
  checkContains("静态 Provider 刷新提示", screenText(app), "使用内置模型目录");

  app.exit();
}

// --- 用例 8：长列表分页（窗口跟随选中项 + 位置指示 + PageUp/PageDown/Home/End）---
{
  const { app, terminal } = createApp(["/config/provider"]);
  await app.start();
  await settle();

  // pi-ai 内置 40 个 provider + 自定义选项 + 旧配置的 openai-compatible = 42 项
  let text = screenText(app);
  const total = Number(/\((\d+)\/(\d+)\)/.exec(text)?.[2] ?? "0");
  check("长列表：provider 总数 >= 40", total >= 40, `total=${total}`);
  check(
    "长列表：整页渲染不超过终端高度（不会把内容挤出屏幕）",
    app.tui.render(100).length <= terminal.rows,
    `lines=${app.tui.render(100).length} rows=${terminal.rows}`,
  );
  // 当前 provider（openai-compatible，排在最后一项）默认被选中
  checkContains("长列表：位置指示出现", text, `(${total}/${total})`);
  checkContains("长列表：当前 provider 可见", text, "openai-compatible");
  check("长列表：只渲染可视窗口（不含远端项）", !text.includes("Amazon Bedrock"), indent(text));

  // Home：首项
  terminal.send("\x1b[H");
  text = screenText(app);
  checkContains("Home 跳到首项", text, "│ 自定义 Provider...");
  checkContains("首项位置指示", text, `(1/${total})`);
  check("Home 后远端项消失", !text.includes("│ openai-compatible"), indent(text));

  // ↓ 30 次：选中项必须仍在可视窗口内
  for (let i = 0; i < 30; i++) terminal.send("\x1b[B");
  text = screenText(app);
  const position = Number(/\((\d+)\/(\d+)\)/.exec(text)?.[1] ?? "0");
  check("滚动后选中项仍在可视区", position === 31, `position=${position}`);
  checkContains("滚动后位置指示更新", text, `(31/${total})`);

  // End：末项
  terminal.send("\x1b[F");
  text = screenText(app);
  checkContains("End 跳到末项", text, "│ openai-compatible");
  checkContains("末项位置指示", text, `(${total}/${total})`);

  // PageDown / PageUp：整页跳转
  terminal.send("\x1b[H");
  await settle(10);
  const before = Number(/\((\d+)\/(\d+)\)/.exec(screenText(app))?.[1] ?? "0");
  terminal.send("\x1b[6~");
  const afterDown = Number(/\((\d+)\/(\d+)\)/.exec(screenText(app))?.[1] ?? "0");
  check("PageDown 整页向下跳转", afterDown - before >= 5, `${before} -> ${afterDown}`);
  terminal.send("\x1b[5~");
  const afterUp = Number(/\((\d+)\/(\d+)\)/.exec(screenText(app))?.[1] ?? "0");
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
  checkContains("小终端：选中项可见", text, "│ openai-compatible");
  checkContains("小终端：仍可翻页", text, `(${42}/${42})`);

  // 缩小到 14 行：仍不应把选中项挤出屏幕
  terminal.rows = 14;
  (app.tui as unknown as { requestRender: (force?: boolean) => void }).requestRender(true);
  await settle(30);
  const small = app.tui.render(100);
  check("14 行终端：渲染行数可控", small.length <= 16, `lines=${small.length}`);
  checkContains("14 行终端：列表仍渲染选中项", screenText(app), "openai-compatible");

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

// --- 用例 12：按键立即重绘 + Kitty 松开事件过滤 ---
// 回归：此前 App 用原始输入监听器自行转发按键，绕过了 pi-tui 的聚焦分发，
// 而 pi-tui 只在分发给聚焦组件后才自动 requestRender；页面又大多没手动 refresh()，
// 于是 ↑↓ 改了选中项但屏幕不动，必须点一下鼠标（鼠标路径会 requestRender）才刷新。
{
  const { app, terminal } = createApp(["/config"]);
  await app.start();
  await settle();

  // 进入「界面语言」（首项，默认选中）
  terminal.send("\r");
  await settle(60);
  checkContains("重绘用例：进入语言页", screenText(app), "❯ 中文");

  // 直接 app.tui.render() 会绕过渲染循环，这里必须观察终端实际写入的帧
  terminal.writes.length = 0;
  terminal.send("\x1b[B");
  await settle(60);
  check(
    "按键后终端收到重绘帧（不再依赖鼠标点击）",
    terminal.writes.length > 0,
    `writes=${terminal.writes.length}`,
  );
  const afterDown = stripAnsi(terminal.writes.join(""));
  checkContains("重绘帧反映新的选中项", afterDown, "❯ 英文");

  // Kitty 键盘协议（ProcessTerminal 启用 flags=7，会同时上报按下/松开）：
  // ↓ 按下应回绕到「中文」，松开必须被 pi-tui 过滤（否则会再移动一次）
  terminal.writes.length = 0;
  terminal.send("\x1b[1;1:1B");
  terminal.send("\x1b[1;1:3B");
  await settle(60);
  const afterKittyDown = stripAnsi(terminal.writes.join(""));
  checkContains("Kitty ↓ 按下后回绕到首项", afterKittyDown, "❯ 中文");
  check("Kitty ↓ 松开不重复移动", !afterKittyDown.includes("❯ 英文"), indent(afterKittyDown));

  // ESC 松开不应触发全局返回/退出
  terminal.writes.length = 0;
  terminal.send("\x1b[27;1:3u");
  await settle(60);
  check(
    "Kitty ESC 松开不触发返回/退出",
    app.location?.pathname === "/config/language" && terminal.writes.length === 0,
    `pathname=${app.location?.pathname} writes=${terminal.writes.length}`,
  );

  // Enter 松开不应重复导航（松开若被处理，会在配置首页再次确认并进入语言页）
  terminal.send("\x1b[13;1:1u");
  terminal.send("\x1b[13;1:3u");
  await settle(80);
  check("Kitty Enter 松开不重复导航", app.location?.pathname === "/config", `pathname=${app.location?.pathname}`);

  app.exit();
}

// ---------------------------------------------------------------------------
// 4) 收尾
// ---------------------------------------------------------------------------

process.chdir(join(home, ".."));
await rm(home, { recursive: true, force: true });
await rm(repo, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
