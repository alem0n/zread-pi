/**
 * Layout - 统一布局
 *
 * ┌ 项目信息框（全局显示，3 行）
 * ├ 介绍文字
 * └ 当前页面内容
 *
 * 项目信息框：
 * - 第 1 行：项目名 + 版本 + 当前目录（~ 缩写）
 * - 第 2 行：模型（provider/model）+ 思考深度 + 蓝图档位（写盘目标，恒显）
 * - 第 3 行：文档状态（未生成 / 已生成 + 各档位变体列表）
 *
 * 页面内容宽度 = 终端宽度 - 4（左右各 2 个字符的 paddingX）。
 */

import { homedir } from "os";
import type { Component } from "@earendil-works/pi-tui";
import type { WikiVariantInfo } from "@zread-pi/utils";
import type { App } from "./app";
import { style } from "./ansi";
import { RoundedBox } from "./components/rounded-box";
import { clampLine } from "./text-layout";
import { getVersion } from "../utils/display";
import { thinkingLevelLabel } from "../utils/thinking";

const PROJECT_NAME = "zread-pi";

/** 获取简短路径（家目录缩写为 ~） */
function getShortPath(path: string): string {
  const home = homedir();
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
    const wiki = this.app.wiki;
    const t = this.app.t.bind(this.app);

    // 第 1 行：项目名 + 版本 + 目录
    const title =
      style(PROJECT_NAME, { bold: true, color: "cyan" }) +
      style(" " + getVersion() + " ─ " + getShortPath(process.cwd()), { dim: true });

    // 第 2 行：模型（provider/model，provider 为 dim 文字）+ 思考深度 + 蓝图档位
    const llmModel = config.llm.model || t("config.notConfigured");
    const modelText = config.llm.provider
      ? style(config.llm.provider, { dim: true }) + "/" + llmModel
      : llmModel;
    const detail = config.blueprint?.detail ?? "high";
    const modelLine =
      style(`${t("layout.model")}: `, { dim: true }) +
      modelText +
      style(`  ${t("config.thinkingLevel")}: `, { dim: true }) +
        thinkingLevelLabel(config.llm.thinking_level, (key) => t(key)) +
      style(`  ${t("config.blueprintDetail")}: `, { dim: true }) +
        detail;

    // 第 3 行：文档状态（已生成的变体列表，活动档位在前）
    const docsLine =
      wiki.detail === null
        ? style(`${t("layout.docs")}: `, { dim: true }) + t("layout.docsNone")
        : this.buildDocsLine(t, wiki.variants, wiki.detail, wiki.targetDetail);

    return [title, modelLine, docsLine];
  }

  /** 第 3 行：文档状态——未生成 / 已生成 · [档位 - N 篇]，目标档位未生成时附加提示 */
  private buildDocsLine(
    t: App["t"],
    variants: WikiVariantInfo[],
    activeDetail: WikiVariantInfo["detail"],
    targetDetail: NonNullable<WikiVariantInfo["detail"]>,
  ): string {
    // 只有已生成内容的变体才进入列表（骨架 pages 为空不算）
    const generated = variants.filter((variant) => variant.pagesCount > 0);
    const label = (variant: WikiVariantInfo): string => String(variant.detail);
    const badge = (variant: WikiVariantInfo): string =>
      `[${label(variant)} - ${variant.pagesCount} ${t("layout.docsUnit")}]`;

    if (generated.length === 0) {
      return style(`${t("layout.docs")}: `, { dim: true }) + t("layout.docsNone");
    }

    // 活动档位排到最前，其余保持 listWikiVariants 的既有顺序（档位序）
    const ordered = [...generated].sort((a, b) => {
      const aActive = a.detail === activeDetail;
      const bActive = b.detail === activeDetail;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return 0;
    });

    let line =
      style(`${t("layout.docs")}: `, { dim: true }) +
      t("layout.docsGenerated") +
      " · " +
      ordered.map(badge).join(" ");

    // 写盘目标档位尚无已生成变体时才提示
    if (!generated.some((variant) => variant.detail === targetDetail)) {
      line += style(`  ${t("layout.docsTarget")}: ${targetDetail}`, { dim: true });
    }
    return line;
  }

  private buildIntro(width: number): string[] {
    const t = this.app.t.bind(this.app);
    return [clampLine(t("layout.intro"), width)];
  }
}
