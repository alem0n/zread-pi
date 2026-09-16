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
import { isBlueprintDetailLevel, listWikiVariants, loadConfigSync, resolveWikiVariant, listRuns, resolveRunId, readEvents, readRunMeta, isValidRunId, getDefaultLanguage, DEFAULT_CONFIG } from "@zread-pi/utils";
import type { BlueprintDetailLevel } from "@zread-pi/types";
import { normalizeLanguageCode } from "../i18n/translations";
import type { LanguageCode } from "../i18n/types";
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
  /** 是否自动打开浏览器（默认 true；无头/测试环境可用 ZREAD_PI_BROWSE_NO_OPEN=1 关闭） */
  openBrowser?: boolean;
  /** 浏览器打开的初始路径（相对 URL，如 `/trajectory/2026-...`；缺省 = 根路径） */
  initialPath?: string;
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
const WEB_DIST_ENV = "ZREAD_PI_BROWSE_DIST";

/** 置为 1 时不自动打开浏览器 */
const NO_OPEN_ENV = "ZREAD_PI_BROWSE_NO_OPEN";

/**
 * 定位 SPA 静态资源目录（必须含 index.html）：
 * 1. ZREAD_PI_BROWSE_DIST 显式覆盖（目录无效则直接报错，不静默回退）
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

  // standalone 二进制：browse 静态资源与可执行文件同目录（browse/ 子目录，CI 产物 zip 布局）
  const exeDist = path.resolve(path.dirname(process.execPath), "browse");
  if (existsSync(path.join(exeDist, "index.html"))) return exeDist;

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
        "  1) 在仓库根运行 bun install（安装 apps/browse 依赖）后重试",
        "  2) 运行 bun run browse:build 生成静态产物（免 Vite 启动）",
        `  3) 设置 ${WEB_DIST_ENV} 指向已构建的静态资源目录`,
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

/** 遗留（无档位）变体的 API 标识（与前端「默认」条目对应） */
const LEGACY_VARIANT_PARAM = "default";

/** events 接口的默认每页条数（与 reader 的 DEFAULT_READ_LIMIT 对齐） */
const DEFAULT_EVENTS_LIMIT = 2000;

/** 浏览站界面语言回退值（与前端 DEFAULT_LANGUAGE 一致） */
const FALLBACK_LOCALE: LanguageCode = "en-US";

/**
 * 解析浏览站界面语言：CLI 配置的 language 字段 → 标准语言代码（zh-CN / en-US）。
 * 未初始化配置时用默认配置；任一环节异常都回退 FALLBACK_LOCALE，绝不阻塞页面渲染。
 */
function resolveBrowseLocale(): LanguageCode {
  try {
    const config = loadConfigSync() ?? DEFAULT_CONFIG;
    return normalizeLanguageCode(getDefaultLanguage(config));
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** 解析后的请求变体（档位子目录或遗留目录） */
interface ResolvedWikiVariant {
  /** 档位名；null = 遗留目录 */
  detail: BlueprintDetailLevel | null;
  legacy: boolean;
  wikiDir: string;
  wikiJsonPath: string;
}

type VariantResolution =
  | { ok: true; variant: ResolvedWikiVariant }
  | { ok: false; status: number; message: string };

/** 构造某个变体的路径（相对目标项目，不依赖进程 cwd） */
function makeVariant(projectPath: string, detail: BlueprintDetailLevel | null): ResolvedWikiVariant {
  const wikiRoot = path.join(projectPath, ".zread-pi", "wiki");
  const dir = detail ? path.join(wikiRoot, detail) : wikiRoot;
  return {
    detail,
    legacy: detail === null,
    wikiDir: dir,
    wikiJsonPath: path.join(dir, "wiki.json"),
  };
}

/**
 * 解析请求的档位变体（`?detail=`）：
 * - 显式：档位名 → 对应子目录；`default` → 遗留目录；非法值 / 目录不存在 → 404；
 * - 缺省：配置档位 → 遗留目录 → 第一个存在的档位；一个都没有 → 404。
 */
function resolveRequestVariant(projectPath: string, detailParam: unknown): VariantResolution {
  const wikiRoot = path.join(projectPath, ".zread-pi", "wiki");
  const notFound = (message: string): VariantResolution => ({ ok: false, status: 404, message });

  if (typeof detailParam === "string" && detailParam.trim().length > 0) {
    const requested = detailParam.trim();
    if (requested === LEGACY_VARIANT_PARAM) {
      const variant = makeVariant(projectPath, null);
      if (!existsSync(variant.wikiJsonPath)) return notFound("Wiki variant not found: default");
      return { ok: true, variant };
    }
    if (!isBlueprintDetailLevel(requested)) return notFound(`Unknown wiki variant: ${requested}`);
    const variant = makeVariant(projectPath, requested);
    if (!existsSync(variant.wikiJsonPath)) {
      return notFound(`Wiki variant not found: ${requested}`);
    }
    return { ok: true, variant };
  }

  const preferred = loadConfigSync()?.blueprint.detail;
  const resolved = resolveWikiVariant(preferred, wikiRoot);
  if (resolved === undefined) return notFound("Wiki catalog not found");
  return { ok: true, variant: makeVariant(projectPath, resolved) };
}

/** 读取并解析某个变体的 wiki.json（结构无效时抛错） */
function readVariantCatalog(variant: ResolvedWikiVariant): WikiCatalog {
  const catalog = JSON.parse(readFileSync(variant.wikiJsonPath, "utf-8")) as WikiCatalog;
  if (!catalog || !Array.isArray(catalog.pages)) {
    throw new Error(`Invalid wiki.json: ${variant.wikiJsonPath}`);
  }
  return catalog;
}

/** 创建 Express app（API 路由） */
function createWikiApp(projectPath: string) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // 界面语言（供浏览站前端 i18n）：CLI 配置的 language 字段归一化后下发
  app.get("/api/i18n", (_req: Request, res: Response) => {
    res.json({ locale: resolveBrowseLocale() });
  });

  // 0. List available wiki variants (+ active variant for the switcher)
  app.get("/api/wiki/variants", (_req: Request, res: Response) => {
    try {
      const wikiRoot = path.join(projectPath, ".zread-pi", "wiki");
      const variants = listWikiVariants(wikiRoot).map((variant) => ({
        detail: variant.detail,
        name: variant.legacy ? "默认" : variant.detail,
        legacy: variant.legacy,
        generatedAt: variant.generatedAt ?? null,
        pagesCount: variant.pagesCount,
        sectionsCount: variant.sectionsCount ?? null,
      }));
      const preferred = loadConfigSync()?.blueprint.detail;
      const resolved = resolveWikiVariant(preferred, wikiRoot);
      res.json({ variants, active: resolved === undefined ? null : resolved });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list wiki variants",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 1. Get wiki catalog (selected variant via ?detail=; default = config detail → legacy → first)
  app.get("/api/wiki/catalog", (req: Request, res: Response) => {
    const resolution = resolveRequestVariant(projectPath, req.query.detail);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.message });
    }

    try {
      res.json(readVariantCatalog(resolution.variant));
    } catch (error) {
      res.status(500).json({
        error: "Failed to load wiki catalog",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 2. Get wiki content by slug (page files resolved under the selected variant)
  app.get("/api/wiki/content/:slug", (req: Request, res: Response) => {
    const resolution = resolveRequestVariant(projectPath, req.query.detail);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.message });
    }

    try {
      const { slug } = req.params;
      const variant = resolution.variant;
      const catalog = readVariantCatalog(variant);
      const page = catalog.pages.find((p) => p.slug === slug);

      if (!page) {
        return res.status(404).json({ error: `Wiki page not found: ${slug}` });
      }

      // Find markdown file（变体目录内 `<section>/<file>`，兼容直接 `<file>`）
      const sectionPath = path.join(variant.wikiDir, page.section, page.file);
      const directPath = path.join(variant.wikiDir, page.file);

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

  // 3. Get source code snippet by file path（源码属项目级，与档位无关；
  //    显式传 ?detail= 时仍校验档位合法性，与 catalog / content 语义一致）
  app.get("/api/wiki/source", (req: Request, res: Response) => {
    const detailParam = req.query.detail;
    if (typeof detailParam === "string" && detailParam.trim().length > 0) {
      const resolution = resolveRequestVariant(projectPath, detailParam);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.message });
      }
    }

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

  // ==================== 轨迹（runs）API ====================

  // 列出所有运行（最新在前）+ latest 指针
  app.get("/api/runs", async (_req: Request, res: Response) => {
    try {
      const runs = await listRuns(projectPath);
      const latest = runs[0]?.id ?? null;
      res.json({ runs, latest });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list runs",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 单次运行的元数据（未知 / 非法 runId → 404）
  app.get("/api/runs/:runId", async (req: Request, res: Response) => {
    try {
      const runId = req.params.runId;
      if (!isValidRunId(runId)) {
        return res.status(404).json({ error: `Unknown run id: ${runId}` });
      }
      const meta = await readRunMeta(runId, projectPath).catch(() => undefined);
      if (meta === undefined) {
        return res.status(404).json({ error: `Run not found: ${runId}` });
      }
      res.json(meta);
    } catch (error) {
      res.status(500).json({
        error: "Failed to load run meta",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * 单次运行的事件流（分页 / 尾随）：
   * - `?afterSeq=N`：返回 seq > N 的事件（实时尾随；limit 上限）
   * - `?beforeSeq=N`：返回 seq < N 的最近 limit 条（向前分页，按 seq 升序返回）
   * - 都不传：从头返回
   * 响应带 `hasMore`（更旧的页可继续向前翻）与 `runEnded`（运行已结束，前端停止轮询）
   */
  app.get("/api/runs/:runId/events", async (req: Request, res: Response) => {
    try {
      const runId = req.params.runId;
      if (!isValidRunId(runId)) {
        return res.status(404).json({ error: `Unknown run id: ${runId}` });
      }
      const meta = await readRunMeta(runId, projectPath).catch(() => undefined);
      if (meta === undefined) {
        return res.status(404).json({ error: `Run not found: ${runId}` });
      }

      const parseSeq = (value: unknown): number | undefined => {
        if (typeof value !== "string") return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
      };
      const limit = parseSeq(req.query.limit) ?? DEFAULT_EVENTS_LIMIT;
      const afterSeq = parseSeq(req.query.afterSeq);
      const beforeSeq = parseSeq(req.query.beforeSeq);

      const result = await readEvents(runId, {
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        limit,
      }, projectPath);

      res.json({
        runId,
        events: result.events,
        hasMore: result.hasMore,
        hasNewer: result.hasNewer,
        /** 运行已结束：前端据此停止尾随轮询 */
        runEnded: meta.status !== "running",
        status: meta.status,
        lastSeq: meta.lastSeq,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to load run events",
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
        "请在仓库根运行 bun install 与 bun run browse:build 后重新打包 CLI",
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
    const target = options.initialPath ? new URL(options.initialPath, url).href : url;
    void open(target).catch(() => {});
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

/** 检查是否存在任一 wiki 变体（档位子目录或遗留目录） */
export function hasWikiCatalog(projectPath: string): boolean {
  const wikiRoot = path.join(projectPath, ".zread-pi", "wiki");
  return listWikiVariants(wikiRoot).length > 0;
}
