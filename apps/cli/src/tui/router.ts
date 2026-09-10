/**
 * Router - 极简内存路由（等价迁移前的 MemoryRouter + <Routes> 语义）
 *
 * - 支持 /config/provider/:providerId/model/:modelId 形式的参数
 * - navigate(-1) 退回上一条目
 * - navigate(path, { replace: true }) 替换当前条目
 * - 首个条目 key 为 "default"（Layout 的 ESC 逻辑依赖该值）
 */

import type { Screen } from "./screen";

export interface RouteLocation {
  pathname: string;
  search: string;
  query: URLSearchParams;
  params: Record<string, string>;
  /** "default" 表示初始条目（与 react-router MemoryRouter 一致） */
  key: string;
}

export interface RouteContext {
  pathname: string;
  search: string;
  query: URLSearchParams;
  params: Record<string, string>;
}

export interface RouteDefinition {
  pattern: string;
  create: (context: RouteContext) => Screen;
}

/** 拆分 pathname 与 search */
function splitPath(to: string): { pathname: string; search: string } {
  const index = to.indexOf("?");
  if (index === -1) return { pathname: to, search: "" };
  return { pathname: to.slice(0, index), search: to.slice(index) };
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

export class Router {
  private routes: RouteDefinition[];
  private entries: RouteLocation[] = [];
  private index = -1;
  private keyCounter = 0;

  constructor(routes: RouteDefinition[]) {
    this.routes = routes;
  }

  get current(): RouteLocation | undefined {
    return this.entries[this.index];
  }

  /** 解析路径到路由定义（返回 undefined 表示无匹配） */
  match(to: string): RouteLocation | undefined {
    const { pathname, search } = splitPath(to);
    const parts = segments(pathname);

    for (const route of this.routes) {
      const patternParts = segments(route.pattern);
      if (patternParts.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i];
        const value = parts[i];
        if (patternPart.startsWith(":")) {
          params[patternPart.slice(1)] = decodeURIComponent(value);
        } else if (patternPart !== value) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      return { pathname, search, query: new URLSearchParams(search), params, key: this.nextKey() };
    }

    return undefined;
  }

  /** 找到匹配的路由定义 */
  resolveDefinition(location: RouteLocation): RouteDefinition | undefined {
    const parts = segments(location.pathname);
    for (const route of this.routes) {
      const patternParts = segments(route.pattern);
      if (patternParts.length !== parts.length) continue;
      let matched = true;
      for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i];
        if (!patternPart.startsWith(":") && patternPart !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return route;
    }
    return undefined;
  }

  push(location: RouteLocation): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(location);
    this.index = this.entries.length - 1;
  }

  replace(location: RouteLocation): void {
    if (this.index < 0) {
      this.push(location);
      return;
    }
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries[this.index] = location;
  }

  /** 相对当前条目移动 delta（负数表示后退） */
  go(delta: number): RouteLocation | undefined {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return undefined;
    this.index = next;
    return this.entries[this.index];
  }

  /** 把初始地址写进栈（key = "default"） */
  reset(to: string): RouteLocation | undefined {
    const location = this.match(to);
    if (!location) return undefined;
    this.entries = [{ ...location, key: "default" }];
    this.index = 0;
    return this.entries[0];
  }

  private nextKey(): string {
    this.keyCounter += 1;
    return `nav-${this.keyCounter}`;
  }
}
