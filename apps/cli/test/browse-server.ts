/**
 * browse-server.ts —— 「浏览文档」离线回归（无需 API Key，也不会打开浏览器）
 *
 * 修复目标：浏览页返回/展示的地址必须真的能访问。
 * 旧实现源码运行时会返回 http://localhost:5173（由外部 Vite dev server 提供），
 * 用户没另起 Vite 时浏览器直接 ERR_CONNECTION_REFUSED。
 *
 * 覆盖：
 * 1. 静态资源模式（ZREAD_PI_BROWSE_DIST）：同一端口提供 SPA + API，URL 真实可访问
 * 2. 静态资源 / SPA fallback / 未知 API 404
 * 3. close() 之后端口不再可连（对应 ESC 退出服务器）
 * 4. BrowsePage（pi-tui）集成：显示「服务器已启动」+ 真实访问地址，ESC 停止
 * 5. 资源目录无效时直接报错（不再静默回退到没人监听的地址）
 *
 * 运行：bun run test:browse（或 bun run test:tui）
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

function checkEqual<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `期望 ${String(expected)}，实际 ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// 夹具：目标仓库（含 wiki.json）+ 假的前端构建产物
// ---------------------------------------------------------------------------

const repo = await mkdtemp(join(tmpdir(), "zread-browse-repo-"));
const dist = await mkdtemp(join(tmpdir(), "zread-browse-dist-"));
const home = await mkdtemp(join(tmpdir(), "zread-browse-home-"));

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
    "  base_url: http://127.0.0.1:1/v1",
    "concurrency:",
    "  max_concurrent: 1",
    "  max_retries: 0",
    "",
  ].join("\n"),
  "utf-8",
);

// 服务端缺省档位解析会读配置（loadConfigSync）；先指到临时 HOME，保证断言确定
process.env.HOME = home;
process.env.USERPROFILE = home;

const PAGE = {
  slug: "1-overview",
  title: "概览",
  file: "1-overview.md",
  section: "入门指南",
  level: "Beginner",
  associatedFiles: ["hello.py"],
};

await mkdir(join(repo, ".zread-pi", "wiki", PAGE.section), { recursive: true });
await writeFile(
  join(repo, ".zread-pi", "wiki", "wiki.json"),
  JSON.stringify(
    {
      id: "browse-test",
      generated_at: new Date().toISOString(),
      language: "zh",
      pages: [PAGE],
    },
    null,
    2,
  ),
  "utf-8",
);
await writeFile(
  join(repo, ".zread-pi", "wiki", PAGE.section, PAGE.file),
  "# 概览\n\n浏览文档用夹具页面。\n",
  "utf-8",
);

await mkdir(join(dist, "assets"), { recursive: true });
await writeFile(
  join(dist, "index.html"),
  '<!doctype html><html lang="zh"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  "utf-8",
);
await writeFile(join(dist, "assets", "app.js"), 'console.log("browse-asset");\n', "utf-8");

process.env.ZREAD_PI_BROWSE_DIST = dist;
process.env.ZREAD_PI_BROWSE_NO_OPEN = "1";

const { startWikiBrowseServer, hasWikiCatalog } = await import("../src/commands/browse-server");

// ---------------------------------------------------------------------------
// 1) 服务器：同一端口提供 SPA + API
// ---------------------------------------------------------------------------

console.log("▶ Browse 服务器（静态资源模式）");

check("hasWikiCatalog 识别 wiki.json", hasWikiCatalog(repo) === true);

const info = await startWikiBrowseServer(repo, { openBrowser: false });
check("返回真实监听地址（非 5173 占位）", /^http:\/\/localhost:\d+$/.test(info.url), info.url);
checkEqual("port 与 URL 端口一致", info.port, Number(new URL(info.url).port));
check("Express 已进入 listening", info.server.listening === true);

const indexRes = await fetch(`${info.url}/`);
checkEqual("GET / 状态码", indexRes.status, 200);
check("GET / 返回 SPA 壳", (await indexRes.text()).includes('id="root"'));

const assetRes = await fetch(`${info.url}/assets/app.js`);
checkEqual("GET /assets/app.js 状态码", assetRes.status, 200);
check("GET /assets/app.js 内容正确", (await assetRes.text()).includes("browse-asset"));

const fallbackRes = await fetch(`${info.url}/wiki/1-overview`);
checkEqual("GET /wiki/1-overview（SPA fallback）状态码", fallbackRes.status, 200);
check("SPA fallback 返回 index.html", (await fallbackRes.text()).includes('id="root"'));

const catalog = (await (await fetch(`${info.url}/api/wiki/catalog`)).json()) as {
  pages: Array<{ slug: string }>;
};
checkEqual("GET /api/wiki/catalog 页数", catalog.pages.length, 1);
checkEqual("catalog slug", catalog.pages[0]?.slug, PAGE.slug);

const content = (await (await fetch(`${info.url}/api/wiki/content/${PAGE.slug}`)).json()) as {
  content: string;
};
check("GET /api/wiki/content 返回 markdown", content.content.includes("# 概览"));

// ---------------------------------------------------------------------------
// 1b) 多档共存：variants API + ?detail= 解析 + 遗留回退
// ---------------------------------------------------------------------------

const HIGH_PAGE = {
  slug: "1-high-overview",
  title: "高级档概览",
  file: "1-high-overview.md",
  section: "入门指南",
  level: "Intermediate",
  associatedFiles: ["hello.py"],
};
const LOW_PAGE = {
  slug: "1-low-overview",
  title: "精简档概览",
  file: "1-low-overview.md",
  section: "入门指南",
  level: "Beginner",
  associatedFiles: ["hello.py"],
};

async function writeVariant(detail: string, page: typeof HIGH_PAGE, generatedAt: string): Promise<void> {
  const dir = join(repo, ".zread-pi", "wiki", detail);
  await mkdir(join(dir, page.section), { recursive: true });
  await writeFile(
    join(dir, "wiki.json"),
    JSON.stringify(
      { id: detail, generated_at: generatedAt, language: "zh", detail, pages: [page] },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(join(dir, page.section, page.file), `# ${page.title}\n\n${detail} variant page.\n`, "utf-8");
}

await writeVariant("high", HIGH_PAGE, "2026-01-02T00:00:00.000Z");
await writeVariant("low", LOW_PAGE, "2026-02-03T00:00:00.000Z");
await writeFile(join(repo, "hello.py"), "print('hello')\n", "utf-8");

interface VariantsPayload {
  variants: Array<{ detail: string | null; name: string; legacy: boolean; pagesCount: number }>;
  active: string | null;
}
const variantsRes = await fetch(`${info.url}/api/wiki/variants`);
const variantsPayload = (await variantsRes.json()) as VariantsPayload;
checkEqual("GET /api/wiki/variants 状态码", variantsRes.status, 200);
checkEqual("variants 含 high / low / 默认 三个条目", variantsPayload.variants.length, 3);
checkEqual(
  "variants 按档位顺序排列（遗留最后）",
  JSON.stringify(variantsPayload.variants.map((variant) => variant.detail)),
  JSON.stringify(["low", "high", null]),
);
checkEqual("variants active = 配置档位 high", variantsPayload.active, "high");
check(
  "variants 中遗留条目名为「默认」",
  variantsPayload.variants.some((variant) => variant.detail === null && variant.name === "默认"),
);
check(
  "variants 页数来自各自的 wiki.json",
  variantsPayload.variants.every((variant) => variant.pagesCount === 1),
  JSON.stringify(variantsPayload.variants.map((variant) => variant.pagesCount)),
);

const defaultCatalog = (await (await fetch(`${info.url}/api/wiki/catalog`)).json()) as {
  pages: Array<{ slug: string }>;
};
checkEqual("缺省 catalog 解析到配置档位 high", defaultCatalog.pages[0]?.slug, HIGH_PAGE.slug);

const lowCatalog = (await (await fetch(`${info.url}/api/wiki/catalog?detail=low`)).json()) as {
  pages: Array<{ slug: string }>;
};
checkEqual("?detail=low 返回 low 变体", lowCatalog.pages[0]?.slug, LOW_PAGE.slug);

const legacyCatalog = (await (await fetch(`${info.url}/api/wiki/catalog?detail=default`)).json()) as {
  pages: Array<{ slug: string }>;
};
checkEqual("?detail=default 返回遗留目录（默认）", legacyCatalog.pages[0]?.slug, PAGE.slug);

const highContent = (await (
  await fetch(`${info.url}/api/wiki/content/${HIGH_PAGE.slug}?detail=high`)
).json()) as { content: string };
check(
  "?detail=high 的正文从 high 变体目录解析",
  highContent.content.includes("high variant page") && !highContent.content.includes("浏览文档用夹具页面"),
);

const legacyContent = (await (
  await fetch(`${info.url}/api/wiki/content/${PAGE.slug}?detail=default`)
).json()) as { content: string };
check("?detail=default 的正文从遗留目录解析", legacyContent.content.includes("浏览文档用夹具页面"));

const unknownVariant = await fetch(`${info.url}/api/wiki/catalog?detail=bogus`);
checkEqual("无效档位返回 404", unknownVariant.status, 404);
check(
  "无效档位返回可读 JSON 错误",
  ((await unknownVariant.json()) as { error?: string }).error === "Unknown wiki variant: bogus",
);

const missingVariant = await fetch(`${info.url}/api/wiki/catalog?detail=max`);
checkEqual("合法但不存在的档位返回 404", missingVariant.status, 404);
check(
  "缺失档位的错误信息带档位名",
  ((await missingVariant.json()) as { error?: string }).error === "Wiki variant not found: max",
);

const contentBadDetail = await fetch(`${info.url}/api/wiki/content/${HIGH_PAGE.slug}?detail=nope`);
checkEqual("content 无效档位返回 404", contentBadDetail.status, 404);

const sourceOk = await fetch(`${info.url}/api/wiki/source?file=hello.py`);
checkEqual("source 不带 detail 仍可用（项目级文件）", sourceOk.status, 200);
check("source 返回文件内容", ((await sourceOk.json()) as { code: string }).code.includes("print('hello')"));

const sourceBadDetail = await fetch(`${info.url}/api/wiki/source?file=hello.py&detail=bogus`);
checkEqual("source 无效档位返回 404", sourceBadDetail.status, 404);

check("hasWikiCatalog 识别档位变体", hasWikiCatalog(repo) === true);

// 仅存在档位变体（无遗留目录）的目录也算「有文档」
const variantOnlyRepo = await mkdtemp(join(tmpdir(), "zread-browse-variant-only-"));
await mkdir(join(variantOnlyRepo, ".zread-pi", "wiki", "high"), { recursive: true });
await writeFile(
  join(variantOnlyRepo, ".zread-pi", "wiki", "high", "wiki.json"),
  JSON.stringify({ id: "variant-only", generated_at: new Date().toISOString(), language: "zh", pages: [HIGH_PAGE] }),
  "utf-8",
);
check("hasWikiCatalog 识别仅有档位变体的目录", hasWikiCatalog(variantOnlyRepo) === true);
check(
  "hasWikiCatalog 对空目录返回 false",
  hasWikiCatalog(await mkdtemp(join(tmpdir(), "zread-browse-empty-"))) === false,
);

const missingRes = await fetch(`${info.url}/api/not-found`);
checkEqual("未知 /api 路径返回 404", missingRes.status, 404);
check(
  "未知 /api 路径返回 JSON 错误",
  ((await missingRes.json()) as { error?: string }).error === "API endpoint not found",
);

await info.close();
const refusedAfterClose = await fetch(`${info.url}/`).then(
  () => false,
  () => true,
);
check("close() 后端口拒绝连接", refusedAfterClose);
await info.close();
check("close() 可重复调用", true);

// ---------------------------------------------------------------------------
// 2) BrowsePage（pi-tui）：显示真实地址、ESC 停止
// ---------------------------------------------------------------------------

console.log("▶ Browse 页面（pi-tui）");

process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(repo);

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

const { App } = await import("../src/tui/app");
const { routes } = await import("../src/routes");

const terminal = new FakeTerminal();
const app = new App({
  routes,
  initialEntries: ["/browse"],
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
    await sleep(50);
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

await app.start();
const running = await waitFor(() => screenText().includes("服务器已启动"), 15000, "浏览页启动服务器");
check("浏览页显示「服务器已启动」", running);

const pageUrl = /https?:\/\/localhost:\d+/.exec(screenText())?.[0] ?? "";
check("浏览页显示真实访问地址", pageUrl !== "", screenText());

const uiCatalogStatus = await fetch(`${pageUrl}/api/wiki/catalog`).then(
  (res) => res.status,
  () => 0,
);
checkEqual("界面展示的地址可访问（catalog 200）", uiCatalogStatus, 200);

const uiIndex = await fetch(`${pageUrl}/`).then(
  (res) => res.status,
  () => 0,
);
checkEqual("界面展示的地址可打开页面（/ 200）", uiIndex, 200);

terminal.send("\x1b");
const stopped = await waitFor(() => screenText().includes("服务器已停止"), 5000, "ESC 停止服务器");
check("ESC 后显示「服务器已停止」", stopped);

const refusedAfterEsc = await fetch(`${pageUrl}/`).then(
  () => false,
  () => true,
);
check("ESC 后端口不再可访问", refusedAfterEsc);

app.exit();

// ---------------------------------------------------------------------------
// 3) 兜底路径：源码运行且没有构建产物时，进程内启动 Vite dev server
//    依赖 apps/browse/node_modules（随根 bun install 安装）；缺失/已有 dist 时跳过
// ---------------------------------------------------------------------------

console.log("▶ 兜底路径（in-process Vite dev server）");

delete process.env.ZREAD_PI_BROWSE_DIST;

const testDir = dirname(fileURLToPath(import.meta.url));
const browseRoot = resolve(testDir, "..", "..", "browse");
const viteAvailable = existsSync(join(browseRoot, "node_modules", "vite"));
const sourceDistExists = existsSync(join(browseRoot, "dist", "index.html"));

if (sourceDistExists) {
  console.log("  - 跳过：apps/browse/dist 已存在，静态模式优先");
} else if (!viteAvailable) {
  console.log("  - 跳过：未安装 apps/browse 依赖（在仓库根运行 bun install）");
} else {
  const viteInfo = await startWikiBrowseServer(repo, { openBrowser: false });
  check("兜底 URL 为 Vite 实际监听地址", /^http:\/\/localhost:\d+$/.test(viteInfo.url), viteInfo.url);

  const viteHtml = await (await fetch(`${viteInfo.url}/`)).text();
  check("兜底 HTML 由 Vite 提供（含 /@vite/client）", viteHtml.includes("/@vite/client"));

  const viteCatalog = await fetch(`${viteInfo.url}/api/wiki/catalog`).then(
    (res) => res.status,
    () => 0,
  );
  checkEqual("兜底模式 /api 代理可用", viteCatalog, 200);

  await viteInfo.close();
  const refusedAfterViteClose = await fetch(`${viteInfo.url}/`).then(
    () => false,
    () => true,
  );
  check("兜底 close() 后端口不再可访问", refusedAfterViteClose);
}

// ---------------------------------------------------------------------------
// 4) 错误路径：显式指定的资源目录无效时直接报错
// ---------------------------------------------------------------------------

console.log("▶ 错误路径");

process.env.ZREAD_PI_BROWSE_DIST = join(repo, "not-a-dist");
let errorMessage = "";
try {
  await startWikiBrowseServer(repo, { openBrowser: false });
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}
check(
  "ZREAD_PI_BROWSE_DIST 无效时抛出可读错误",
  errorMessage.includes("ZREAD_PI_BROWSE_DIST") && errorMessage.includes("index.html"),
  errorMessage,
);

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

delete process.env.ZREAD_PI_BROWSE_DIST;
delete process.env.ZREAD_PI_BROWSE_NO_OPEN;
process.chdir(join(home, ".."));
await rm(repo, { recursive: true, force: true });
await rm(dist, { recursive: true, force: true });
await rm(variantOnlyRepo, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

console.log(`\n结果：${passed} passed, ${failed} failed`);
// Vite 冷启动的依赖预构建会留下后台句柄（close() 做了有界等待），测试主动退出
process.exit(failed > 0 ? 1 : 0);
