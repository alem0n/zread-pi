/** 临时脚本：渲染所有路由，确认无异常/无超宽行 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const home = await mkdtemp(join(tmpdir(), "zread-routes-home-"));
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
    "  providers: {}",
    "concurrency:",
    "  max_concurrent: 3",
    "  max_retries: 1",
    "",
  ].join("\n"),
  "utf-8",
);
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
process.chdir(await mkdtemp(join(tmpdir(), "zread-routes-repo-")));

const { App } = await import("../src/tui/app");
const { routes } = await import("../src/routes");

const terminal = {
  columns: 100,
  rows: 40,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  async drainInput() {},
  write() {},
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
};

const paths = [
  "/config",
  "/config/language",
  "/config/doc_language",
  "/config/provider",
  "/config/provider/custom",
  "/config/provider/anthropic",
  "/config/provider/anthropic/model-new",
  "/config/provider/anthropic/custom",
  "/config/provider/openai-compatible",
  "/config/concurrency",
  "/config/retry",
  "/config/thinking",
  "/config/max-turns",
  "/wiki",
  "/wiki/generate?mode=manage",
  "/wiki/sync",
];

let bad = 0;
for (const path of paths) {
  const app = new App({ routes, initialEntries: [path], terminal: terminal as never, onExit: () => {} });
  try {
    await app.start();
    await new Promise((r) => setTimeout(r, 80));
    const lines = app.tui.render(100);
    const over = lines.filter((l) => visibleWidth(l) > 100);
    console.log(
      `${over.length === 0 ? "✓" : "✗"} ${path}  lines=${lines.length} overWidth=${over.length}`,
    );
    if (over.length > 0) {
      bad += 1;
      console.log(over.map((l) => `    [${visibleWidth(l)}] ${l.replace(/\x1b\[[0-9;]*m/g, "")}`).join("\n"));
    }
  } catch (err) {
    bad += 1;
    console.log(`✗ ${path} 抛出异常: ${err instanceof Error ? err.message : String(err)}`);
  }
  app.exit();
}

console.log(bad === 0 ? "\n所有路由渲染正常" : `\n${bad} 个路由有问题`);
process.exit(bad === 0 ? 0 : 1);
