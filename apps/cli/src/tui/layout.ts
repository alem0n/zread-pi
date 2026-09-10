/**
 * Layout - 统一布局（对齐迁移前的 apps/cli/src/layout/layout.tsx）
 *
 * ┌ 项目信息框（全局显示）
 * ├ 介绍文字
 * └ 当前页面内容
 *
 * 页面内容宽度 = 终端宽度 - 4（左右各 2 个字符的 paddingX）。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { App } from "./app";
import { style } from "./ansi";
import { RoundedBox } from "./components/rounded-box";
import { clampLine } from "./text-layout";
import { getVersion } from "../utils/display";

const PROJECT_NAME = "open-zread";
const GITHUB_URL = "https://github.com/bb-boy680/open-zread";

/** 获取简短路径 */
function getShortPath(path: string): string {
  const home = process.env.HOME || "";
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/** 行数组组件：把「按宽度生成行」的纯函数包装成 Component */
export class Lines implements Component {
  constructor(private producer: (width: number) => string[]) {}

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    const maxWidth = Math.max(1, width);
    return this.producer(maxWidth).map((line) => clampLine(line, maxWidth));
  }
}

export class Layout implements Component {
  private box = new RoundedBox(1);
  private header: Lines;
  private intro: Lines;

  constructor(private app: App) {
    this.header = new Lines((width) => this.buildHeader(width));
    this.box.addChild(this.header);
    this.intro = new Lines((width) => this.buildIntro(width));
  }

  invalidate(): void {
    this.box.invalidate();
    this.intro.invalidate();
  }

  render(width: number): string[] {
    const total = Math.max(1, width);
    const inner = Math.max(1, total - 4);

    const lines: string[] = [];
    lines.push(...this.box.render(inner));
    // 介绍文字区块的 marginTop={1}
    lines.push("");
    lines.push(...this.intro.render(inner));

    // 记录头部占用的行数：页面据此计算列表可用行数（分页窗口）
    this.app.layoutOverhead = lines.length;

    lines.push(...this.app.currentScreen.render(inner));

    return lines.map((line) => clampLine("  " + line, total));
  }

  private buildHeader(_width: number): string[] {
    const { config } = this.app.config;
    const t = this.app.t.bind(this.app);

    const llmProvider = config.llm.provider || "未设置";
    const llmModel = config.llm.model || "未设置";
    // base_url 优先看当前 provider 的覆盖配置（凭据/端点已迁到 per-provider 配置）
    const providerBaseUrl = config.llm.provider
      ? config.llm.providers?.[config.llm.provider]?.base_url
      : null;
    const llmBaseUrl = providerBaseUrl || config.llm.base_url || "default";
    const currentDir = getShortPath(process.cwd());

    return [
      style(PROJECT_NAME, { bold: true, color: "cyan" }) +
        style(" " + getVersion(), { dim: true }),
      "",
      style(`${t("layout.provider")}: `, { dim: true }) + style(llmProvider, { color: "cyan" }),
      style(`${t("layout.model")}: `, { dim: true }) + llmModel,
      style(`${t("layout.baseUrl")}: `, { dim: true }) + style(llmBaseUrl, { dim: true }),
      style(`${t("layout.directory")}: `, { dim: true }) + currentDir,
    ];
  }

  private buildIntro(width: number): string[] {
    const t = this.app.t.bind(this.app);
    return [
      clampLine(t("layout.intro"), width),
      clampLine(style(t("layout.github", { url: GITHUB_URL }), { dim: true }), width),
    ];
  }
}
