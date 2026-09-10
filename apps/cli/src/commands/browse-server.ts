/**
 * Browse Server - Wiki 文档浏览服务器
 */

import express, { Request, Response } from "express";
import getPort from "get-port";
import open from "open";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import type { Server } from "http";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveBrowseChat, serializeBrowseChatError } from "./browse-chat";
import {
  deleteBrowseChatSession,
  loadBrowseChatHistory,
  saveBrowseChatHistory,
  type BrowseChatHistoryPayload,
} from "./browse-chat-history";

// 打包时通过 tsup define 注入的全局常量
declare global {
  var IS_PACKAGED: boolean | undefined;
}

interface WikiPage {
  slug: string;
  title: string;
  file: string;
  section: string;
  group?: string;
  level: string;
  associatedFiles?: string[];
}

interface WikiCatalog {
  id: string;
  generated_at: string;
  language: string;
  pages: WikiPage[];
}

/** Browse 服务器信息 */
export interface BrowseServerInfo {
  /** 浏览器访问端口（与 url 的端口一致） */
  port: number;
  url: string;
  /** Express 实例（API + 可选静态资源） */
  server: Server;
  close: () => Promise<void>;
}

/** Browse 服务器启动选项 */
export interface BrowseServerOptions {
  /** 是否自动打开浏览器（默认 true；无头/测试环境可用 OPEN_ZREAD_BROWSE_NO_OPEN=1 关闭） */
  openBrowser?: boolean;
}

// 打包时通过 tsup define 把 globalThis.IS_PACKAGED 替换为 true
function isPackagedBuild(): boolean {
  return typeof globalThis.IS_PACKAGED !== "undefined" && globalThis.IS_PACKAGED === true;
}

/** 当前模块所在目录：源码运行 = apps/cli/src/commands，打包运行 = CLI dist 目录 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 源码运行时 browse 前端所在目录（apps/cli/src/commands -> <repo>/apps/browse） */
const SOURCE_BROWSE_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..", "apps", "browse");

/** 显式指定前端构建产物目录 */
const WEB_DIST_ENV = "OPEN_ZREAD_BROWSE_DIST";

/** 置为 1 时不自动打开浏览器 */
const NO_OPEN_ENV = "OPEN_ZREAD_BROWSE_NO_OPEN";

/**
 * 定位 SPA 静态资源目录（必须含 index.html）：
 * 1. OPEN_ZREAD_BROWSE_DIST 显式覆盖（目录无效则直接报错，不静默回退）
 * 2. 打包产物 dist/browse（tsup onSuccess 从 apps/browse/dist 复制）
 * 3. 源码仓库 apps/browse/dist（bun run browse:build 的产物）
 */
function resolveBrowseWebDist(): string | null {
  const override = process.env[WEB_DIST_ENV]?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!existsSync(path.join(resolved, "index.html"))) {
      throw new Error(`${WEB_DIST_ENV} 指向的目录缺少 index.html: ${resolved}`);
    }
    return resolved;
  }

  const packagedDist = path.resolve(MODULE_DIR, "browse");
  if (existsSync(path.join(packagedDist, "index.html"))) return packagedDist;

  if (isPackagedBuild()) return null;

  const sourceDist = path.join(SOURCE_BROWSE_ROOT, "dist");
  if (existsSync(path.join(sourceDist, "index.html"))) return sourceDist;

  return null;
}

interface ViteDevServerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * 源码运行且没有构建产物时的兜底：进程内启动 Vite dev server。
 * - 复用 apps/browse/vite.config.ts（React/Tailwind 插件），只覆盖代理目标与端口
 * - logLevel=silent：全屏 TUI 下 Vite 日志会写坏界面
 */
async function startViteDevServer(apiOrigin: string): Promise<ViteDevServerHandle> {
  const require = createRequire(import.meta.url);

  let viteEntry: string;
  try {
    viteEntry = require.resolve("vite", { paths: [SOURCE_BROWSE_ROOT] });
  } catch {
    throw new Error(
      [
        "未找到前端资源，也无法启动 Vite（apps/browse 依赖缺失）。",
        "请任选一种方式：",
        "  1) bun run browse:install && bun run browse:build",
        `  2) 设置 ${WEB_DIST_ENV} 指向已构建的静态资源目录`,
      ].join("\n"),
    );
  }

  const { createServer } = (await import(pathToFileURL(viteEntry).href)) as {
    createServer: (inlineConfig: Record<string, unknown>) => Promise<{
      listen: () => Promise<void>;
      close: () => Promise<void>;
      resolvedUrls: { local: string[] } | null;
      config: { server: { port?: number } };
    }>;
  };

  const viteServer = await createServer({
    root: SOURCE_BROWSE_ROOT,
    logLevel: "silent",
    server: {
      strictPort: false,
      proxy: { "/api": { target: apiOrigin, changeOrigin: true } },
    },
  });

  try {
    await viteServer.listen();
  } catch (error) {
    await viteServer.close().catch(() => {});
    throw error;
  }

  const resolved = viteServer.resolvedUrls?.local?.[0];
  const fallbackPort = viteServer.config.server.port ?? 5173;
  const url = (resolved ?? `http://localhost:${fallbackPort}`).replace(/\/+$/, "");

  return {
    url,
    close: () => viteServer.close(),
  };
}

/** 等待 http.Server 真正进入 listening（端口占用等错误在这里抛出，而不是未捕获的 error 事件） */
function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

/** 关闭 http.Server，并断开 keep-alive 连接（否则 ESC 后端口可能仍短暂可连） */
function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Vite 首次冷启动做依赖预构建时 close() 可能长时间不返回（端口已释放）；做有界等待，不阻塞 ESC/测试 */
const VITE_CLOSE_TIMEOUT_MS = 1500;

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/** 从 URL 取端口（取不到时回退到 API 端口） */
function portOf(url: string, fallback: number): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return fallback;
  }
}

// Read code snippet from file
function readCodeSnippet(
  projectPath: string,
  filePath: string,
  lineStart?: number,
  lineEnd?: number,
): string {
  const fullPath = path.join(projectPath, filePath);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(fullPath, "utf-8");

  if (!lineStart || !lineEnd) {
    return content;
  }

  const lines = content.split("\n");
  const start = Math.max(0, lineStart - 1);
  const end = Math.min(lines.length, lineEnd);

  return lines.slice(start, end).join("\n");
}

/** 创建 Express app（API 路由） */
function createWikiApp(projectPath: string) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Wiki data path
  const wikiPath = path.join(projectPath, ".open-zread", "wiki");
  const wikiJsonPath = path.join(wikiPath, "wiki.json");

  // 1. Get wiki catalog
  app.get("/api/wiki/catalog", (_req: Request, res: Response) => {
    try {
      if (!existsSync(wikiJsonPath)) {
        return res.status(404).json({ error: "Wiki catalog not found" });
      }

      const catalog: WikiCatalog = JSON.parse(
        readFileSync(wikiJsonPath, "utf-8"),
      );
      res.json(catalog);
    } catch (error) {
      res.status(500).json({
        error: "Failed to load wiki catalog",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 2. Get wiki content by slug
  app.get("/api/wiki/content/:slug", (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      if (!existsSync(wikiJsonPath)) {
        return res.status(404).json({ error: "Wiki catalog not found" });
      }

      const catalog: WikiCatalog = JSON.parse(
        readFileSync(wikiJsonPath, "utf-8"),
      );
      const page = catalog.pages.find((p) => p.slug === slug);

      if (!page) {
        return res.status(404).json({ error: `Wiki page not found: ${slug}` });
      }

      // Find markdown file
      const sectionPath = path.join(wikiPath, page.section, page.file);
      const directPath = path.join(wikiPath, page.file);

      let mdPath: string | null = null;
      if (existsSync(sectionPath)) {
        mdPath = sectionPath;
      } else if (existsSync(directPath)) {
        mdPath = directPath;
      }

      if (!mdPath) {
        return res
          .status(404)
          .json({ error: `Markdown file not found for: ${slug}` });
      }

      const content = readFileSync(mdPath, "utf-8");

      res.json({
        slug,
        title: page.title,
        section: page.section,
        group: page.group,
        level: page.level,
        content,
        associatedFiles: page.associatedFiles || [],
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to load wiki content",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 3. Get source code snippet by file path
  app.get("/api/wiki/source", (req: Request, res: Response) => {
    try {
      const { file, startLine, endLine } = req.query;

      if (!file || typeof file !== "string") {
        return res.status(400).json({ error: "Missing file parameter" });
      }

      const start = startLine ? parseInt(startLine as string, 10) : undefined;
      const end = endLine ? parseInt(endLine as string, 10) : undefined;

      try {
        const code = readCodeSnippet(projectPath, file, start, end);
        res.json({
          file,
          lineStart: start,
          lineEnd: end,
          code,
        });
      } catch (error) {
        res.status(404).json({
          error: "Source file not found",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      res.status(500).json({
        error: "Failed to load source snippet",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const result = await resolveBrowseChat(req.body);
      res.json(result);
    } catch (error) {
      const serialized = serializeBrowseChatError(error);
      res.status(serialized.status).json(serialized.body);
    }
  });

  app.get("/api/chat/history", async (_req: Request, res: Response) => {
    try {
      const history = await loadBrowseChatHistory(projectPath);
      res.json(history);
    } catch (error) {
      res.status(500).json({
        error: "Failed to load chat history",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/api/chat/history", async (req: Request, res: Response) => {
    try {
      const history = await saveBrowseChatHistory(
        projectPath,
        req.body as BrowseChatHistoryPayload,
      );
      res.json(history);
    } catch (error) {
      res.status(500).json({
        error: "Failed to save chat history",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete("/api/chat/history/:sessionId", async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") {
        return res.status(400).json({
          error: "Invalid chat session id",
          message: "sessionId must be a string",
        });
      }
      const history = await deleteBrowseChatSession(
        projectPath,
        sessionId,
      );
      res.json(history);
    } catch (error) {
      res.status(400).json({
        error: "Failed to delete chat session",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { app };
}

/**
 * 启动 Wiki 浏览服务器。
 *
 * 返回的 url 一定是真正在监听、可被浏览器访问的地址：
 * - 有构建产物（打包 dist/browse 或源码 apps/browse/dist）：API + 静态资源同端口，SPA fallback
 * - 源码运行且没有产物：同端口 API + 进程内 Vite dev server（/api 代理到 API 端口）
 * 不再像旧实现那样返回一个没人监听的 http://localhost:5173。
 */
export async function startWikiBrowseServer(
  projectPath: string,
  options: BrowseServerOptions = {},
): Promise<BrowseServerInfo> {
  const { app } = createWikiApp(projectPath);
  const webDist = resolveBrowseWebDist();

  if (!webDist && isPackagedBuild()) {
    throw new Error(
      `前端打包文件未找到: ${path.resolve(MODULE_DIR, "browse")}；` +
        "请在仓库根运行 bun run browse:install && bun run browse:build 后重新打包 CLI",
    );
  }

  if (webDist) {
    // 单端口：静态资源 + SPA fallback（API 路由已在 createWikiApp 注册，优先匹配）
    app.use(express.static(webDist));
    app.use((req: Request, res: Response) => {
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "API endpoint not found" });
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  const apiPort = await getPort({ port: 3000 });
  const server = app.listen(apiPort);

  try {
    await waitForListening(server);
  } catch (error) {
    await closeHttpServer(server);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`端口监听失败（${apiPort}）: ${message}`);
  }

  let viteHandle: ViteDevServerHandle | null = null;
  let url = `http://localhost:${apiPort}`;

  if (!webDist) {
    // 源码运行且未构建：退回进程内 Vite dev server
    try {
      viteHandle = await startViteDevServer(`http://127.0.0.1:${apiPort}`);
    } catch (error) {
      await closeHttpServer(server);
      throw error;
    }
    url = viteHandle.url;
  }

  const shouldOpenBrowser = options.openBrowser ?? process.env[NO_OPEN_ENV] !== "1";
  if (shouldOpenBrowser) {
    // 无头环境打不开浏览器不应影响服务器本身
    void open(url).catch(() => {});
  }

  let closed = false;
  return {
    port: portOf(url, apiPort),
    url,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all([
        closeHttpServer(server),
        viteHandle ? settleWithin(viteHandle.close(), VITE_CLOSE_TIMEOUT_MS) : Promise.resolve(),
      ]);
    },
  };
}

/** 检查是否存在 wiki.json */
export function hasWikiCatalog(projectPath: string): boolean {
  const wikiJsonPath = path.join(projectPath, ".open-zread", "wiki", "wiki.json");
  return existsSync(wikiJsonPath);
}
