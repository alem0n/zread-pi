/**
 * App - TUI 应用（替代迁移前的 apps/cli/src/App.tsx + react-router）
 *
 * 负责：
 * - 持有 TUI / ConfigStore / I18nStore
 * - 路由栈与页面生命周期（onEnter / onDestroy）
 * - 全局按键：ctrl+c 退出；ESC 返回上一级（子页面可用 claimEsc 抢占）
 */

import {
  matchesKey,
  ProcessTerminal,
  TuiAltScreen,
  type Terminal,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { I18nStore } from "../state/i18n-store";
import { ConfigStore } from "../state/config-store";
import { WikiStore } from "../state/wiki-store";
import { normalizeLanguageCode } from "../i18n/translations";
import { Layout } from "./layout";
import { Router, type RouteDefinition, type RouteLocation } from "./router";
import type { Screen } from "./screen";
import type { InterpolationParams } from "../i18n/types";

export interface AppOptions {
  /** 启动时的路由列表（顺序敏感：静态路径需在参数化路径之前） */
  routes: RouteDefinition[];
  /** 初始地址（如 "/wiki"） */
  initialEntries: string[];
  /** 终端实现（默认 process.stdin/stdout；测试时可注入） */
  terminal?: Terminal;
  /** 退出回调（默认 process.exit(0)；测试时可注入） */
  onExit?: () => void;
}

export class App {
  readonly tui: TuiAltScreen;
  readonly config = new ConfigStore();
  readonly i18n = new I18nStore();
  readonly wiki = new WikiStore();

  private router: Router;
  private layout: Layout;
  private screen!: Screen;
  private escClaimed = false;
  private stopped = false;
  private entering = false;

  constructor(private options: AppOptions) {
    this.router = new Router(options.routes);
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal());
    this.layout = new Layout(this);
    this.tui.addInputListener((data) => this.handleInput(data));
  }

  // ==================== 生命周期 ====================

  async start(): Promise<void> {
    await this.config.load();
    this.i18n.setLanguage(normalizeLanguageCode(this.config.config.language));

    const initial = this.router.reset(this.options.initialEntries[0] ?? "/wiki");
    if (!initial) {
      throw new Error(`初始路由无法匹配: ${this.options.initialEntries[0]}`);
    }

    this.tui.setLayoutRoot(this.layout);
    this.createScreen(initial);
    this.tui.start();
    this.enterScreen();
  }

  exit(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.screen?.onDestroy();
    this.tui.stop();
    if (this.options.onExit) {
      this.options.onExit();
      return;
    }
    process.exit(0);
  }

  // ==================== 导航 ====================

  get currentScreen(): Screen {
    return this.screen;
  }

  get location(): RouteLocation | undefined {
    return this.router.current;
  }

  navigate(to: number | string, options?: { replace?: boolean }): void {
    if (this.stopped) return;

    if (typeof to === "number") {
      const location = this.router.go(to);
      if (!location) return;
      this.createScreen(location);
      return;
    }

    const location = this.router.match(to);
    if (!location) return;
    if (options?.replace) {
      this.router.replace(location);
    } else {
      this.router.push(location);
    }
    this.createScreen(location);
  }

  // ==================== ESC 处理权 ====================

  claimEsc(): void {
    this.escClaimed = true;
  }

  releaseEsc(): void {
    this.escClaimed = false;
  }

  // ==================== 渲染 ====================

  requestRender(): void {
    if (this.stopped) return;
    this.tui.requestRender();
  }

  t(key: string, params?: InterpolationParams): string {
    return this.i18n.t(key, params);
  }

  // ==================== 内部实现 ====================

  private createScreen(location: RouteLocation): void {
    const definition = this.router.resolveDefinition(location);
    if (!definition) return;

    this.screen?.onDestroy();
    this.escClaimed = false;

    const next = definition.create({
      pathname: location.pathname,
      search: location.search,
      query: location.query,
      params: location.params,
    });
    next.bind(this);
    this.screen = next;
    this.tui.setFocus(next);
    this.requestRender();
    this.enterScreen();
  }

  private enterScreen(): void {
    if (this.entering) return;
    this.entering = true;
    try {
      const result = this.screen.onEnter();
      if (result instanceof Promise) {
        result.catch(() => {
          // 页面初始化异常不应打断整个 TUI
        });
      }
    } finally {
      this.entering = false;
    }
  }

  /** 返回 true 表示已消费该按键（仅 ESC 会影响全局行为） */
  private handleInput(data: string): TuiInputListenerResult {
    if (matchesKey(data, "ctrl+c")) {
      this.exit();
      return { consume: true };
    }

    const screen = this.screen;
    if (!screen) return undefined;

    if (matchesKey(data, "escape")) {
      const consumed = screen.handleKey(data);
      if (!consumed && !this.escClaimed) {
        this.handleGlobalEscape();
      }
      return { consume: true };
    }

    screen.handleKey(data);
    return undefined;
  }

  /** 与迁移前 Layout 的 useInput 完全一致的 ESC 逻辑 */
  private handleGlobalEscape(): void {
    const location = this.router.current;
    if (!location) return;

    // 有导航历史时，返回上一级
    if (location.key !== "default") {
      this.navigate(-1);
      return;
    }

    // 无导航历史时，根页面退出，子页面跳转到父页面
    if (location.pathname === "/wiki" || location.pathname === "/config") {
      this.exit();
    } else if (location.pathname.startsWith("/config/")) {
      this.navigate("/config");
    } else if (location.pathname.startsWith("/wiki/")) {
      this.navigate("/wiki");
    } else {
      this.exit();
    }
  }
}
